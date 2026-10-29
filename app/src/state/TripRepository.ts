import type { api as defaultApi } from "../lib/api";
import { ApiError } from "../lib/errors";
import { isInviteExpired } from "../lib/invite";
import { inspectLedger } from "../lib/ledger";
import { receiptItemsNeedRepair } from "../lib/receiptScan";
import { CoalescedWriter, type KeyValueStorage } from "../lib/storage";
import { isTripPreview, newId, type TripLookup, type Expense, type Member, type Settlement, type ThemePreference, type Trip } from "../lib/types";
import { planAccountTransition } from "./accountTransitions";
import { applyOp, type Op, type TripPatch } from "./tripOps";

export type TripApi = typeof defaultApi;
export type { Op, TripPatch } from "./tripOps";
export { applyOp } from "./tripOps";

/**
 * An edit made here that the server refused because someone else changed (or
 * deleted) the same expense after this device last saw it. It waits for the
 * person to choose between the two versions; nothing is overwritten silently.
 */
export interface ExpenseConflict {
  tripId: string;
  expenseId: string;
  /** This device's version (its latest edit, when several were queued). */
  mine: Expense;
  /** The server's version, or null if the expense was deleted meanwhile. */
  theirs: Expense | null;
  detectedAt: number;
}

export interface Settings {
  receiptLanguage: string;
  /** The currency this person reads totals and balances in. */
  homeCurrency?: string;
  /** Read receipts snapped offline over mobile data too, not just Wi-Fi. */
  scanQueuedOnCellular: boolean;
  appearance: ThemePreference;
}

export interface PersistedData {
  accountId?: string | null;
  /** Trips hidden on this device, scoped to the account that removed them. */
  removedTripIds?: Record<string, string[]>;
  /** Legacy offline work whose account could not be established; never synced automatically. */
  unverified?: { trips: Record<string, Trip>; ops: Op[]; failedOps: Op[]; me: Record<string, string> };
  trips: Record<string, Trip>;
  ops: Op[];
  /** Operations rejected permanently; retained for diagnostics without blocking later work. */
  failedOps: Op[];
  /** Expense edits waiting for a person to pick a side; see ExpenseConflict. */
  conflicts?: ExpenseConflict[];
  /** Which member is "me" on this device, per trip. */
  me: Record<string, string>;
  settings: Settings;
}

export interface RepositorySnapshot {
  ready: boolean;
  online: boolean;
  syncErrors: Record<string, string>;
  storageError?: boolean;
  data: PersistedData;
}

const EMPTY: PersistedData = {
  trips: {},
  ops: [], failedOps: [],
  me: {},
  settings: { receiptLanguage: "English", scanQueuedOnCellular: false, appearance: "system" },
};

/**
 * Offline-first store for trips, independent of React.
 *
 * Every change is applied locally right away and queued as an op; the queue
 * is flushed to the server in order whenever it's reachable. Server copies
 * replace the local one, with still-pending ops replayed on top so nothing
 * the user did disappears. React subscribes through `subscribe` /
 * `getSnapshot` (useSyncExternalStore).
 */
export class TripRepository {
  private snapshot: RepositorySnapshot = { ready: false, online: true, syncErrors: {}, data: EMPTY };
  private readonly listeners = new Set<() => void>();
  private loading?: Promise<void>;
  private starting?: Promise<void>;
  private flushing?: Promise<void>;
  private readonly receiptRestorations = new Set<string>();
  private flushAgain = false;
  private readonly refreshing = new Map<string, Promise<void>>();
  private persistenceUnavailable = false;
  private accountId: string | null = null;
  private epoch = 0;
  private accountRequest = 0;
  private accountTransition: Promise<void> = Promise.resolve();
  private accountRestoreNeeded = false;
  private restoring?: Promise<void>;
  private readonly previews = new Map<string, TripLookup>();

  canSync = () => this.accountId !== null;

  /** Resolve authentication before sending persisted operations, and isolate account changes. */
  setAccount = (id: string | null, beforeReset: (mode?: "reset" | "migrate") => Promise<void> = async () => {}) => {
    const request = ++this.accountRequest;
    this.accountId = null;
    ++this.epoch;
    this.previews.clear();
    this.restoring = undefined;
    const transition = this.accountTransition.catch(() => {}).then(async () => {
      await this.ready();
      if (request !== this.accountRequest) return;
      let cleanupError: unknown;
      let cleanupFailed = false;
      const plan = planAccountTransition(this.data, id);
      if (plan.kind === "migrate") {
        // Keep verifiable trips active. Retain uncertain legacy work separately
        // until the server confirms access, without sending it as another user.
        this.update((data) => ({ ...data, ...plan.data }));
        try { await beforeReset("migrate"); }
        catch (error) { cleanupError = error; cleanupFailed = true; }
      } else if (plan.kind === "reset") {
        try { await beforeReset("reset"); }
        catch (error) { cleanupError = error; cleanupFailed = true; }
        if (request !== this.accountRequest) return;
        try { await this.resetForAccount(); }
        catch (error) { if (!cleanupFailed) cleanupError = error; cleanupFailed = true; }
      }
      if (request !== this.accountRequest) return;
      this.update((data) => ({ ...data, accountId: id }));
      this.accountId = id;
      // Guest mode has no server sync to fail; a previous account's failure
      // must not make local-only trips look offline.
      if (id === null) {
        this.setOnline(true);
        this.setSyncError("__account__", undefined);
      }
      this.accountRestoreNeeded = !!id;
      if (cleanupFailed) throw cleanupError;
    });
    this.accountTransition = transition;
    return transition.then(async () => {
      if (request !== this.accountRequest) return;
      await this.restoreAccount();
      await this.flush();
    });
  };

  restoreAccount = (): Promise<void> => {
    if (!this.accountId || !this.accountRestoreNeeded) return Promise.resolve();
    if (this.restoring) return this.restoring;
    const epoch = this.epoch;
    const id = this.accountId;
    const run = (async () => {
      try {
        const trips = await this.api.listTrips();
        if (epoch !== this.epoch) return;
        for (const trip of trips) {
          if (this.data.removedTripIds?.[id]?.includes(trip.id)) continue;
          this.adopt(trip, { allowNew: true });
          const member = trip.members.find((candidate) => candidate.userId === id);
          if (member) this.setMe(trip.id, member.id);
        }
        this.accountRestoreNeeded = false;
        this.setSyncError("__account__", undefined);
        this.setOnline(true);
      } catch (error) {
        if (epoch !== this.epoch) return;
        if (error instanceof ApiError && !error.isRetryable) {
          this.accountRestoreNeeded = false;
          this.setOnline(true);
          this.setSyncError("__account__", "Couldn't load your account trips. Try again.");
        } else {
          this.setSyncError("__account__", "Couldn't load your account trips. Try again.");
          this.setOnline(false);
          // Keep same-account offline data and retry on reconnect.
        }
      }
    })();
    this.restoring = run;
    return run.finally(() => { if (this.restoring === run) this.restoring = undefined; });
  };
  retryAccountRestore = () => {
    this.accountRestoreNeeded = !!this.accountId;
    return this.restoreAccount();
  };

  private retryTimer?: ReturnType<typeof setInterval>;
  private readonly writer: CoalescedWriter;

  constructor(
    private readonly api: TripApi,
    private readonly storage: KeyValueStorage,
    private readonly storageKey = "deochipei:v1",
    private readonly retryMs = 15000,
  ) {
    this.writer = new CoalescedWriter(storage, storageKey, () => this.data, () => {
      // A write failure can be retried on the next change; a read failure is
      // kept disabled so a later save cannot overwrite unknown stored data.
      this.snapshot = { ...this.snapshot, storageError: true };
      this.emit();
    }, () => {
      if (this.snapshot.storageError && !this.persistenceUnavailable) {
        this.snapshot = { ...this.snapshot, storageError: false };
        this.emit();
      }
    });
  }

  // ── Subscription ────────────────────────────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /** Resolves once saved data has been read from storage. */
  ready = () => (this.loading ??= this.load());

  /** Resolves once every change so far has been written to storage. */
  saved = async () => {
    if (this.persistenceUnavailable) {
      throw new Error("Local storage is unavailable.");
    }
    await this.writer.saved();
    if (this.snapshot.storageError) throw new Error("Local storage is unavailable.");
  };

  /** Idempotent: safe under React StrictMode's double effects. */
  start() {
    this.starting ??= this.ready().then(() => this.flush());
    this.retryTimer ??= setInterval(() => {
      if (this.accountRestoreNeeded) void this.restoreAccount();
      if (this.data.ops.length) this.flush();
    }, this.retryMs);
    return this.starting;
  }

  stop() {
    clearInterval(this.retryTimer);
    this.retryTimer = undefined;
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  private get data() {
    return this.snapshot.data;
  }

  getTrip = (id: string): Trip | undefined => this.data.trips[id];

  meFor = (tripId: string): string | undefined => this.data.me[tripId];

  hasUnverifiedTrip = (tripId: string) => !!this.data.unverified?.trips[tripId];

  conflictsFor = (tripId: string) => (this.data.conflicts ?? []).filter((c) => c.tripId === tripId);

  /**
   * The server's newer copy of an expense when the edit about to be saved started
   * from an older one (it was synced into this phone while the form was open).
   * Lets the form warn before queueing a write that would be refused anyway.
   */
  staleExpense = (tripId: string, edited: Expense): Expense | undefined => {
    const current = this.data.trips[tripId]?.expenses.find((e) => e?.id === edited.id);
    if (!current || current.revision == null || edited.revision == null) return undefined;
    return current.revision === edited.revision ? undefined : current;
  };

  pendingCount = (tripId: string) => this.data.ops.filter((o) => o.tripId === tripId).length;
  failedCount = (tripId: string) => this.data.failedOps.filter((o) => o.tripId === tripId).length;

  retryFailed = (tripId: string) => {
    const failed = this.data.failedOps.filter((op) => op.tripId === tripId);
    if (!failed.length) return;
    this.update((d) => ({
      ...d,
      failedOps: d.failedOps.filter((op) => op.tripId !== tripId),
      ops: [...d.ops, ...failed.map(({ attempts: _attempts, retryAt: _retryAt, recovered: _recovered, ...op }) => op as Op)],
    }));
    this.flush();
  };

  discardFailed = async (tripId: string) => {
    if (!this.data.failedOps.some((op) => op.tripId === tripId)) return;
    const rejected = this.data.failedOps.filter((op) => op.tripId === tripId);
    const epoch = this.epoch;
    await this.flush();
    const server = await this.api.getTrip(tripId); // An optimistic copy's revision cannot validate its contents.
    if (epoch !== this.epoch) return;
    if (!server) throw new ApiError("Could not reload the trip. Your rejected changes are still available.", 503);
    const local = this.data.trips[tripId];
    if (local?.revision != null && server.revision != null && server.revision < local.revision) {
      throw new ApiError("The server returned an older trip. Try again shortly.", 503);
    }
    this.update((d) => ({ ...d, failedOps: d.failedOps.filter((op) => !rejected.includes(op)) }));
    this.adopt(server);
  };

  // ── Commands ────────────────────────────────────────────────────────────

  createTrip = (input: {
    name: string;
    baseCurrency: string;
    memberNames: string[];
    ownerId?: string;
    ownerEmail?: string;
    ownerAvatarUrl?: string;
  }): Trip => {
    const name = input.name.trim();
    const memberNames = input.memberNames.map((memberName) => memberName.trim()).filter(Boolean);
    if (!name || !memberNames.length) throw new ApiError("A trip needs a name and at least one member.", 400);
    const members: Member[] = memberNames.map((memberName, index) => {
      const member: Member = { id: newId(), name: memberName.slice(0, 60) };
      if (index === 0 && input.ownerId) {
        member.userId = input.ownerId;
        if (input.ownerEmail) member.email = input.ownerEmail;
        if (input.ownerAvatarUrl) member.avatarUrl = input.ownerAvatarUrl;
      }
      return member;
    });
    const { homeCurrency } = this.data.settings;
    if (homeCurrency) members[0] = { ...members[0], homeCurrency };
    const trip: Trip = {
      id: newId(),
      name: name.slice(0, 80),
      baseCurrency: input.baseCurrency,
      members,
      expenses: [],
      settlements: [],
      deletedExpenseIds: [],
      deletedSettlementIds: [],
      updatedAt: Date.now(),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.ownerId ? { syncEnabled: true } : {}),
    };
    this.update((d) => ({
      ...d,
      trips: { ...d.trips, [trip.id]: trip },
      me: { ...d.me, [trip.id]: members[0].id },
    }));
    if (trip.syncEnabled) this.enqueue({ kind: "createTrip", tripId: trip.id });
    return trip;
  };

  claimTripMember = async (tripId: string, memberId: string, user?: { id?: string; email?: string; avatarUrl?: string }) => {
    await this.ready();
    const trip = this.previews.get(tripId) ?? this.data.trips[tripId];
    const epoch = this.epoch;
    const member = trip?.members.find((candidate) => candidate.id === memberId);
    if (!trip || !member) throw new ApiError("Trip member not found", 404);
    if ((isTripPreview(trip) || trip.syncEnabled) && user?.id && (isTripPreview(trip) || member.userId !== user.id)) {
      const code = trip.code ?? (!isTripPreview(trip) ? trip.inviteCode : undefined);
      if (!code) throw new ApiError("This trip has no invite code yet. Try again once it has synced.", 409);
      const updated = await this.api.claimMember(code, memberId, member);
      if (epoch !== this.epoch) return;
      this.adopt(updated, { allowNew: true });
      this.previews.delete(tripId);
    }
    this.clearRemovedTrip(tripId);
    this.setMe(tripId, memberId, user);
  };

  joinTrip = async (
    code: string,
    user?: { id?: string; email?: string; displayName?: string; name?: string; avatarUrl?: string },
  ): Promise<TripLookup> => {
    // A deep link can open the app straight into joining; don't let the
    // initial load overwrite the trip we're about to add.
    await this.ready();
    const epoch = this.epoch;
    const trip = await this.api.joinTrip(code, user);
    if (epoch !== this.epoch) throw new ApiError("Account changed. Look up the trip again.", 409);
    if (isInviteExpired(trip.inviteExpiresAt)) {
      throw new ApiError("This invite code has expired.", 410);
    }
    if (isTripPreview(trip)) {
      this.previews.set(trip.id, trip);
      return trip;
    }
    let resolvedTrip = trip;
    if (user?.id) {
      const existing = trip.members.find(
        (m) => m.userId === user.id,
      );
      if (existing) {
        const updatedMember = {
          ...existing,
          userId: user.id,
          ...(user.email ? { email: user.email } : {}),
          ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
        };
        resolvedTrip = {
          ...trip,
          members: trip.members.map((member) => (member.id === existing.id ? updatedMember : member)),
        };
        this.update((d) => ({
          ...d,
          me: { ...d.me, [resolvedTrip.id]: existing.id },
        }));
      }
    }
    this.clearRemovedTrip(resolvedTrip.id);
    this.adopt(resolvedTrip, { allowNew: true });
    return resolvedTrip;
  };

  addSelfToTrip = async (tripId: string, name: string, user: { id: string; email?: string; avatarUrl?: string }) => {
    const trip = this.previews.get(tripId) ?? this.data.trips[tripId];
    if (!trip || !name.trim()) throw new ApiError("Enter your name and look up the trip again.", 400);
    const epoch = this.epoch;
    const member: Member = { id: newId(), name: name.trim().slice(0, 60), userId: user.id, email: user.email, avatarUrl: user.avatarUrl };
    const code = trip.code ?? (!isTripPreview(trip) ? trip.inviteCode : undefined);
    if (!code) throw new ApiError("This trip has no invite code yet. Try again once it has synced.", 409);
    const updated = await this.api.claimMember(code, member.id, member);
    if (epoch !== this.epoch) return;
    this.clearRemovedTrip(tripId);
    this.adopt(updated, { allowNew: true });
    this.previews.delete(tripId);
    this.setMe(tripId, member.id, user);
  };

  regenerateTripInvite = async (tripId: string): Promise<Trip> => {
    await this.ready();
    const existing = this.data.trips[tripId];
    if (!existing) {
      throw new ApiError("Trip not found", 404);
    }

    try {
      const updated = await this.api.regenerateTripInvite(tripId);
      this.adopt(updated);
      this.setOnline(true);
      return updated;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
        throw err;
      }
      throw new ApiError("Invite regeneration needs an internet connection.", 503);
    }
  };

  setMe = (tripId: string, memberId: string, user?: { id?: string; email?: string; avatarUrl?: string }) => {
    const trip = this.data.trips[tripId];
    const current = this.member(tripId, memberId);
    if (!current) return;
    // A synced identity is bound only by the authenticated claim endpoint.
    if (trip?.syncEnabled && user?.id && current.userId !== user.id) return;
    this.update((d) => ({ ...d, me: { ...d.me, [tripId]: memberId } }));
    // Picking yourself on a new phone brings along the currency you chose elsewhere.
    const chosen = this.member(tripId, memberId)?.homeCurrency;
    if (!this.data.settings.homeCurrency && chosen) this.updateSettings({ homeCurrency: chosen });
    this.publishHomeCurrency(tripId);
  };

  /** Sets this person's home currency and shares it on their member record in every trip. */
  setHomeCurrency = (code: string) => {
    this.updateSettings({ homeCurrency: code });
    for (const tripId of Object.keys(this.data.trips)) this.publishHomeCurrency(tripId);
  };

  addMember = (
    tripId: string,
    name: string,
    user?: { id?: string; email?: string; avatarUrl?: string },
    queue = true,
  ): Member => {
    if (!name.trim()) throw new ApiError("Member name cannot be empty.", 400);
    const member: Member = {
      id: newId(), name: name.trim().slice(0, 60), userId: user?.id, email: user?.email, avatarUrl: user?.avatarUrl,
    };
    this.update((d) => {
      const trip = d.trips[tripId];
      return trip ? { ...d, trips: { ...d.trips, [tripId]: applyOp(trip, { kind: "upsertMember", tripId, member }) } } : d;
    });
    if (queue && this.data.trips[tripId]?.syncEnabled) this.enqueue({ kind: "upsertMember", tripId, member });
    return member;
  };

  patchTrip = (tripId: string, patch: TripPatch) => {
    if (patch.name !== undefined && !patch.name.trim()) throw new ApiError("Trip name cannot be empty.", 400);
    if (
      patch.budget !== undefined &&
      patch.budget !== null &&
      (!Number.isFinite(patch.budget) || patch.budget <= 0)
    ) {
      throw new ApiError("Trip budget must be greater than zero.", 400);
    }
    const trip = this.data.trips[tripId];
    if (
      trip &&
      patch.baseCurrency !== undefined &&
      patch.baseCurrency !== trip.baseCurrency &&
      (trip.settlements ?? []).some((settlement) =>
        !(settlement?.id && (trip.deletedSettlementIds ?? []).includes(settlement.id)))
    ) {
      throw new ApiError("A trip's base currency cannot change while it has recorded settlements.", 409);
    }
    const normalized = {
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 80) } : {}),
      ...(patch.baseCurrency !== undefined ? { baseCurrency: patch.baseCurrency } : {}),
      ...(patch.budget !== undefined ? { budget: patch.budget } : {}),
    };
    if (!trip) return;
    this.update((d) => ({ ...d, trips: { ...d.trips, [tripId]: applyOp(trip, { kind: "patchTrip", tripId, patch: normalized }) } }));
    if (trip.syncEnabled) this.enqueue({ kind: "patchTrip", tripId, patch: normalized });
  };

  saveExpense = (tripId: string, expense: Expense) => {
    const trip = this.data.trips[tripId];
    if (!trip) return;
    // `expense.revision` is the server version this edit started from; it rides along to the server.
    const updated = { ...expense, updatedAt: Date.now() };
    this.update((d) => ({ ...d, trips: { ...d.trips, [tripId]: applyOp(trip, { kind: "upsertExpense", tripId, expense: updated }) } }));
    if (trip.syncEnabled) this.enqueue({ kind: "upsertExpense", tripId, expense: updated });
  };

  /**
   * Settles a conflict. "theirs" accepts the server's version (this device
   * already shows it). "mine" saves this device's version on top of the current
   * server copy; if the expense was deleted it comes back as a new expense,
   * because a deleted id can't be reused.
   */
  resolveConflict = (tripId: string, expenseId: string, choice: "mine" | "theirs") => {
    const conflict = this.data.conflicts?.find((c) => c.tripId === tripId && c.expenseId === expenseId);
    if (!conflict) return;
    this.update((d) => ({ ...d, conflicts: (d.conflicts ?? []).filter((c) => c !== conflict) }));
    if (choice === "theirs") return;
    const { revision: _stale, ...mine } = conflict.mine;
    const current = this.data.trips[tripId]?.expenses.find((e) => e?.id === expenseId);
    if (conflict.theirs === null || !current) {
      this.saveExpense(tripId, { ...mine, id: newId(), createdAt: Date.now() });
    } else {
      this.saveExpense(tripId, { ...mine, ...(current.revision != null ? { revision: current.revision } : {}) });
    }
  };

  deleteExpense = (tripId: string, expenseId: string) => {
    const trip = this.data.trips[tripId];
    if (!trip) return;
    this.update((d) => ({ ...d, trips: { ...d.trips, [tripId]: applyOp(trip, { kind: "deleteExpense", tripId, expenseId }) } }));
    if (trip.syncEnabled) this.enqueue({ kind: "deleteExpense", tripId, expenseId });
  };

  saveSettlement = (tripId: string, settlement: Settlement) => {
    const trip = this.data.trips[tripId];
    if (!trip) return;
    const updated = { ...settlement, updatedAt: Date.now() };
    this.update((d) => ({
      ...d,
      trips: { ...d.trips, [tripId]: applyOp(trip, { kind: "upsertSettlement", tripId, settlement: updated }) },
    }));
    if (trip.syncEnabled) this.enqueue({ kind: "upsertSettlement", tripId, settlement: updated });
  };

  deleteSettlement = (tripId: string, settlementId: string) => {
    const trip = this.data.trips[tripId];
    if (!trip) return;
    this.update((d) => ({
      ...d,
      trips: { ...d.trips, [tripId]: applyOp(trip, { kind: "deleteSettlement", tripId, settlementId }) },
    }));
    if (trip.syncEnabled) this.enqueue({ kind: "deleteSettlement", tripId, settlementId });
  };

  removeDamagedSettlement = (tripId: string, index: number, expected: unknown) => {
    const trip = this.data.trips[tripId];
    if (!trip || !Array.isArray(trip.settlements) || index < 0 || index >= trip.settlements.length ||
        trip.settlements[index] !== expected) {
      throw new Error("The payment list changed. Review the damaged entry again.");
    }
    if (trip.settlements[index]?.id) {
      return this.deleteSettlement(tripId, trip.settlements[index].id);
    }
    this.update((data) => ({
      ...data,
      trips: {
        ...data.trips,
        [tripId]: {
          ...trip,
          settlements: trip.settlements?.filter((_, position) => position !== index),
        },
      },
    }));
  };

  /** Confirmed repair restores intact server data before considering shared deletion. */
  removeDamagedExpense = async (tripId: string, index: number, expected: unknown, restoreOnly = false) => {
    const trip = this.data.trips[tripId];
    if (!trip || index < 0 || index >= trip.expenses.length || trip.expenses[index] !== expected) {
      throw new Error("The expense list changed. Review the damaged entry again.");
    }
    const entry = trip.expenses[index];
    if (typeof entry?.id === "string" && entry.id) {
      if (!trip.syncEnabled) {
        if (restoreOnly) throw new Error("This expense has no shared server copy. The saved details have been kept.");
        return this.deleteExpense(tripId, entry.id);
      }
      if (!this.canSync()) throw new Error("Sign in and reconnect to repair this shared expense.");
      const epoch = this.epoch;
      const restorationKey = JSON.stringify([epoch, tripId, entry.id]);
      if (restoreOnly) {
        if (this.receiptRestorations.has(restorationKey)) throw new Error("This receipt is already being restored.");
        this.receiptRestorations.add(restorationKey);
      }
      try {
        const keep = (op: Op) => !(op.tripId === tripId && op.kind === "upsertExpense" && op.expense.id === entry.id);
        // drainQueue holds this record's pending edits until the server copy is validated.
        if (restoreOnly) await this.flushing;
        else await this.flush();
        if (epoch !== this.epoch) return;
        const server = await this.api.getTrip(tripId);
        if (epoch !== this.epoch) return;
        if (!server) throw new Error("Couldn't reload this shared expense. Try again while online.");
        const current = this.data.trips[tripId];
        if (!current || current.expenses[index] !== expected) throw new Error("The expense list changed. Review the damaged entry again.");
        if (server.revision != null && current.revision != null && server.revision < current.revision) {
          throw new Error("The server returned an older trip. Try again shortly.");
        }
        const remote = server.expenses.find((expense) => expense?.id === entry.id);
        if (restoreOnly && (!remote?.receipt || !inspectLedger({ ...server, expenses: [remote] }).ledger ||
            receiptItemsNeedRepair(remote.receipt))) {
          throw new Error("No intact server receipt was found. The saved details have been kept.");
        }
        // The repair confirmation also discards unsent versions of this damaged record.
        this.update((data) => ({ ...data, ops: data.ops.filter(keep), failedOps: data.failedOps.filter(keep) }));
        if (!remote || inspectLedger({ ...server, expenses: [remote] }).ledger) {
          this.adopt(server);
          return;
        }
        return this.deleteExpense(tripId, entry.id);
      } finally {
        if (restoreOnly) this.receiptRestorations.delete(restorationKey);
      }
    }
    if (restoreOnly) throw new Error("This expense has no shared server copy. The saved details have been kept.");
    this.update((data) => ({ ...data, trips: { ...data.trips,
      [tripId]: { ...trip, expenses: trip.expenses.filter((_, position) => position !== index) },
    } }));
  };

  removeTripLocally = (tripId: string) =>
    this.update((d) => {
      const { [tripId]: _removed, ...trips } = d.trips;
      const { [tripId]: _me, ...me } = d.me;
      const account = d.accountId;
      return {
        ...d,
        trips,
        me,
        ...(account && _removed?.syncEnabled ? { removedTripIds: { ...d.removedTripIds,
          [account]: [...new Set([...(d.removedTripIds?.[account] ?? []), tripId])],
        } } : {}),
        ops: d.ops.filter((o) => o.tripId !== tripId),
        failedOps: d.failedOps.filter((o) => o.tripId !== tripId),
        conflicts: (d.conflicts ?? []).filter((c) => c.tripId !== tripId),
      };
    });

  updateSettings = (patch: Partial<Settings>) =>
    this.update((d) => ({ ...d, settings: { ...d.settings, ...patch } }));

  /** Push queued changes, then pull the latest copy of the trip if it has changed. */
  refresh = (tripId: string): Promise<void> => {
    if (!this.canSync() || !this.data.trips[tripId]?.syncEnabled) return Promise.resolve();
    const ongoing = this.refreshing.get(tripId);
    if (ongoing) return ongoing;
    const epoch = this.epoch;
    const run = (async () => {
      await this.flush();
      if (epoch !== this.epoch) return;
      try {
        const local = this.data.trips[tripId];
        const server = await this.api.getTrip(tripId, local?.revision);
        if (epoch !== this.epoch) return;
        if (server) this.adopt(server);
        this.setOnline(true);
        this.setSyncError(tripId, undefined);
      } catch (err) {
        if (epoch !== this.epoch) return;
        if (err instanceof ApiError && !err.isRetryable) {
          this.setOnline(true);
          const message = err.status === 403 || err.status === 404
            ? "This trip is no longer available to this account."
            : "The trip could not be refreshed.";
          console.warn("Trip refresh rejected", tripId, err.status, err.message);
          this.setSyncError(tripId, message);
        } else {
          this.setOnline(false);
          this.setSyncError(tripId, "Trip sync is unavailable. Changes will retry when you reconnect.");
        }
      }
    })();
    this.refreshing.set(tripId, run);
    return run.finally(() => {
      if (this.refreshing.get(tripId) === run) this.refreshing.delete(tripId);
    });
  };

  /** Sends queued ops in order. Concurrent callers share the same run. */
  flush = (): Promise<void> => {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    const run = this.drainQueue();
    let wrapped: Promise<void>;
    wrapped = run.finally(() => {
      this.flushing = undefined;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.flush();
      }
    });
    this.flushing = wrapped;
    return this.flushing;
  };

  // ── Internals ───────────────────────────────────────────────────────────

  private clearRemovedTrip(tripId: string) {
    const account = this.data.accountId;
    if (!account || !this.data.removedTripIds?.[account]?.includes(tripId)) return;
    this.update((data) => ({ ...data, removedTripIds: { ...data.removedTripIds,
      [account]: data.removedTripIds![account].filter((id) => id !== tripId),
    } }));
  }

  private member(tripId: string, memberId: string | undefined) {
    return this.data.trips[tripId]?.members.find((m) => m.id === memberId);
  }

  private publishHomeCurrency(tripId: string) {
    const code = this.data.settings.homeCurrency;
    const me = this.member(tripId, this.data.me[tripId]);
    const trip = this.data.trips[tripId];
    if (trip?.syncEnabled && code && me && me.homeCurrency !== code) {
      this.enqueue({ kind: "upsertMember", tripId, member: { ...me, homeCurrency: code } });
    }
  }

  private async load() {
    const backupKeyBase = `${this.storageKey}:backup`;
    let raw: string | null;
    try {
      raw = await this.storage.getItem(this.storageKey);
      if (!raw && this.storageKey === "deochipei:v1") {
        const legacy = await this.storage.getItem("travelsplit:v1");
        if (legacy) {
          raw = legacy;
          await this.storage.setItem(this.storageKey, legacy);
          if (this.storage.removeItem) {
            await this.storage.removeItem("travelsplit:v1").catch(() => {});
          }
        }
      }
      if (!raw) raw = await this.storage.getItem(backupKeyBase);
    } catch {
      this.persistenceUnavailable = true;
      this.snapshot = { ...this.snapshot, ready: true, storageError: true };
      this.emit();
      return;
    }
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Partial<PersistedData>;
        const trips = Object.fromEntries(
          Object.entries(saved.trips ?? {}).map(([id, trip]) => [
            id,
            {
              ...trip,
              syncEnabled: trip.syncEnabled ?? Boolean(trip.ownerId),
              settlements: Array.isArray(trip.settlements) ? trip.settlements : [],
              deletedSettlementIds: Array.isArray(trip.deletedSettlementIds) ? trip.deletedSettlementIds : [],
            },
          ]),
        );
        this.snapshot = {
          ...this.snapshot,
          data: { ...EMPTY, ...saved, trips, ops: saved.ops ?? [], failedOps: saved.failedOps ?? [], settings: { ...EMPTY.settings, ...saved.settings } },
        };
      } catch {
        await this.storage.setItem(backupKeyBase, raw).catch(() => {});
        await this.storage.removeItem?.(this.storageKey).catch(() => {});
        this.snapshot = { ...this.snapshot, data: EMPTY };
      }
    }
    this.snapshot = { ...this.snapshot, ready: true };
    this.emit();
  }

  private async drainQueue() {
    const epoch = this.epoch;
    while (this.canSync() && epoch === this.epoch && this.data.ops.length) {
      const op = this.data.ops[0];
      if (op.kind === "upsertExpense" && this.receiptRestorations.has(JSON.stringify([epoch, op.tripId, op.expense.id]))) return;
      if ((op.retryAt ?? 0) > Date.now()) return;
      try {
        const server = await this.send(op);
        if (epoch !== this.epoch) return;
        this.dropOp(op);
        if (op.kind === "upsertExpense") this.rebaseQueuedEdits(op, server);
        this.adopt(server);
        this.setOnline(true);
      } catch (err) {
        if (epoch !== this.epoch) return;
        if (err instanceof ApiError && err.isExpenseConflict && op.kind === "upsertExpense") {
          this.recordConflict(op, err);
          this.setOnline(true);
          continue;
        }
        if (err instanceof ApiError && err.isPermanent) {
          console.warn("Parking rejected op", op.kind, err.message);
          this.parkOp(op);
          continue;
        }
        if (err instanceof ApiError && err.isRetryable) {
          const attempts = (op.attempts ?? 0) + 1;
          const retryAt = Date.now() + Math.min(15 * 60_000, 1000 * 2 ** Math.min(attempts, 9));
          this.update((d) => ({
            ...d,
            ops: d.ops.map((candidate) => (candidate === op ? { ...candidate, attempts, retryAt } : candidate)),
          }));
          this.setOnline(false);
          return;
        }
        this.setOnline(false);
        return;
      }
    }
  }

  private send(op: Op): Promise<Trip> {
    switch (op.kind) {
      case "createTrip": {
        const trip = this.data.trips[op.tripId];
        if (!trip) return Promise.reject(new ApiError("Trip was removed", 404));
        return this.api.createTrip(trip).catch(async (err) => {
          if (!(err instanceof ApiError) || err.status !== 409) throw err;
          const existing = await this.api.getTrip(op.tripId);
          if (!existing) throw err;
          return existing;
        });
      }
      case "patchTrip":
        return this.api.patchTrip(op.tripId, op.patch);
      case "upsertMember":
        return this.api.upsertMember(op.tripId, op.member);
      case "upsertExpense":
        return this.api.upsertExpense(op.tripId, op.expense);
      case "deleteExpense":
        return this.api.deleteExpense(op.tripId, op.expenseId);
      case "upsertSettlement":
        return this.api.upsertSettlement(op.tripId, op.settlement);
      case "deleteSettlement":
        return this.api.deleteSettlement(op.tripId, op.settlementId);
    }
  }

  /**
   * After an edit lands, later queued edits of the same expense were made on top
   * of it, so they start from the revision the server just assigned. Without this
   * the second of two offline edits would be refused as stale by the first.
   */
  private rebaseQueuedEdits(sent: Extract<Op, { kind: "upsertExpense" }>, server: Trip) {
    const revision = server.expenses.find((e) => e?.id === sent.expense.id)?.revision;
    if (revision == null) return;
    this.update((d) => ({
      ...d,
      ops: d.ops.map((o) =>
        o.kind === "upsertExpense" && o.tripId === sent.tripId && o.expense.id === sent.expense.id
          ? { ...o, expense: { ...o.expense, revision } }
          : o,
      ),
    }));
  }

  /** The server refused an edit as stale: set it aside for review and show the server's copy. */
  private recordConflict(op: Extract<Op, { kind: "upsertExpense" }>, err: ApiError) {
    const isSame = (o: Op) => o.tripId === op.tripId && (o.kind === "upsertExpense" ? o.expense.id : o.kind === "deleteExpense" ? o.expenseId : undefined) === op.expense.id;
    const rest = this.data.ops.filter((o) => o !== op && isSame(o));
    const deletedLater = rest.some((o) => o.kind === "deleteExpense");
    const edits = [op, ...rest.filter((o): o is Extract<Op, { kind: "upsertExpense" }> => o.kind === "upsertExpense")];
    const raw = err.currentExpense as Expense | null;
    const theirs = raw && typeof raw === "object" && typeof raw.id === "string" ? raw : null;
    // The latest edit holds everything done on this device (each edit is a full copy).
    const mine = edits[edits.length - 1].expense;
    this.update((d) => {
      const trip = d.trips[op.tripId];
      const ops = d.ops.filter((o) => !edits.some((edit) => edit === o));
      // The user went on to delete it after editing: the delete wins, no review needed.
      if (deletedLater || !trip) return { ...d, ops };
      const shown = theirs
        ? applyOp(trip, { kind: "upsertExpense", tripId: op.tripId, expense: theirs })
        : applyOp(trip, { kind: "deleteExpense", tripId: op.tripId, expenseId: op.expense.id });
      const others = (d.conflicts ?? []).filter((c) => !(c.tripId === op.tripId && c.expenseId === op.expense.id));
      return {
        ...d,
        ops,
        trips: { ...d.trips, [op.tripId]: shown },
        conflicts: [...others, { tripId: op.tripId, expenseId: op.expense.id, mine, theirs, detectedAt: Date.now() }],
      };
    });
  }

  private enqueue(op: Op) {
    this.update((d) => {
      const trip = d.trips[op.tripId];
      return {
        ...d,
        ops: [...d.ops, op],
        trips: trip ? { ...d.trips, [op.tripId]: applyOp(trip, op) } : d.trips,
      };
    });
    this.flush();
  }

  // Remove by identity: the queue may have changed while the op was in flight.
  private dropOp(op: Op) {
    this.update((d) => ({ ...d, ops: d.ops.filter((o) => o !== op) }));
  }

  private parkOp(op: Op) {
    this.update((d) => ({ ...d, ops: d.ops.filter((o) => o !== op), failedOps: [...d.failedOps, op] }));
  }

  /** Take the server's copy, then replay this device's unsent ops on top. */
  private adopt(server: Trip, { allowNew = false } = {}) {
    this.update((d) => {
      const archive = d.unverified;
      if (archive?.trips[server.id] && this.accountId && (server.ownerId === this.accountId ||
          server.members.some((member) => member.userId === this.accountId))) {
        const { [server.id]: _trip, ...remainingTrips } = archive.trips;
        const { [server.id]: _me, ...remainingMe } = archive.me;
        d = { ...d,
          failedOps: [...d.failedOps, ...[...archive.failedOps, ...archive.ops]
            .filter((op) => op.tripId === server.id).map((op) => ({ ...op, recovered: true }))],
          unverified: { trips: remainingTrips, me: remainingMe,
            ops: archive.ops.filter((op) => op.tripId !== server.id),
            failedOps: archive.failedOps.filter((op) => op.tripId !== server.id) },
        };
      }
      const local = d.trips[server.id];
      // Ignore late responses for trips removed from this device.
      if (!local && !allowNew) return d;
      const pending = [
        ...d.failedOps.filter((o) => o.tripId === server.id),
        ...d.ops.filter((o) => o.tripId === server.id),
      ];
      // Compare server-owned revisions when available; device timestamps are
      // not comparable across clocks. Keep the timestamp fallback for older
      // server copies that predate revisions.
      if (local) {
        if (server.revision != null && local.revision != null && server.revision < local.revision) return d;
        if (server.revision == null && local.revision == null && server.updatedAt < local.updatedAt) return d;
      }
      const merged = pending.reduce(applyOp, {
        ...server,
        syncEnabled: true,
        settlements: server.settlements ?? [],
        deletedExpenseIds: server.deletedExpenseIds ?? [],
        deletedSettlementIds: server.deletedSettlementIds ?? [],
      });
      return { ...d, trips: { ...d.trips, [server.id]: merged } };
    });
  }

  private update(fn: (d: PersistedData) => PersistedData) {
    const next = fn(this.data);
    if (next === this.data) return;
    this.snapshot = { ...this.snapshot, data: next };
    if (!this.persistenceUnavailable) this.writer.save();
    this.emit();
  }

  private setOnline(online: boolean) {
    if (online === this.snapshot.online) return;
    this.snapshot = { ...this.snapshot, online };
    this.emit();
  }

  private setSyncError(tripId: string, message: string | undefined) {
    const syncErrors = { ...this.snapshot.syncErrors };
    if (message) syncErrors[tripId] = message;
    else delete syncErrors[tripId];
    if (syncErrors[tripId] === this.snapshot.syncErrors[tripId] && Object.keys(syncErrors).length === Object.keys(this.snapshot.syncErrors).length) return;
    this.snapshot = { ...this.snapshot, syncErrors };
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  resetForAccount = async () => {
    await this.ready();
    const keepTrip = (trip: Trip) => !trip.syncEnabled;
    const trips = Object.fromEntries(Object.entries(this.data.trips).filter(([, trip]) => keepTrip(trip)));
    const guestIds = new Set(Object.keys(trips));
    this.snapshot = {
      ...this.snapshot,
      data: {
        ...EMPTY,
        trips,
        ops: this.data.ops.filter((op) => guestIds.has(op.tripId)),
        failedOps: this.data.failedOps.filter((op) => guestIds.has(op.tripId)),
        me: Object.fromEntries(Object.entries(this.data.me).filter(([tripId]) => guestIds.has(tripId))),
        settings: this.data.settings,
        unverified: this.data.unverified,
        removedTripIds: this.data.removedTripIds,
      },
      ready: true,
    };
    this.snapshot = { ...this.snapshot, syncErrors: {} };
    this.emit();
    if (this.persistenceUnavailable) throw new Error("Local storage is unavailable.");
    this.writer.save();
    await this.writer.saved();
    await this.storage.removeItem?.(`${this.storageKey}:backup`).catch(() => {});
    this.emit();
  };
}
