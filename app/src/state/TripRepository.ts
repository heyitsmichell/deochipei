import type { api as defaultApi } from "../lib/api";
import { ApiError } from "../lib/errors";
import { isInviteExpired } from "../lib/invite";
import { CoalescedWriter, type KeyValueStorage } from "../lib/storage";
import { newId, type Expense, type Member, type ThemePreference, type Trip } from "../lib/types";

export type TripApi = typeof defaultApi;
export type TripPatch = Partial<Pick<Trip, "name" | "baseCurrency">>;

/** A change made on this device that the server hasn't confirmed yet. */
type OpMeta = { attempts?: number; retryAt?: number };
export type Op =
  | ({ kind: "createTrip"; tripId: string } & OpMeta)
  | ({ kind: "patchTrip"; tripId: string; patch: TripPatch } & OpMeta)
  | ({ kind: "upsertMember"; tripId: string; member: Member } & OpMeta)
  | ({ kind: "upsertExpense"; tripId: string; expense: Expense } & OpMeta)
  | ({ kind: "deleteExpense"; tripId: string; expenseId: string } & OpMeta);

export interface Settings {
  receiptLanguage: string;
  /** The currency this person reads totals and balances in. */
  homeCurrency?: string;
  /** Read receipts snapped offline over mobile data too, not just Wi-Fi. */
  scanQueuedOnCellular: boolean;
  appearance: ThemePreference;
}

export interface PersistedData {
  trips: Record<string, Trip>;
  ops: Op[];
  /** Operations rejected permanently; retained for diagnostics without blocking later work. */
  failedOps: Op[];
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

export function applyOp(trip: Trip, op: Op): Trip {
  switch (op.kind) {
    case "createTrip":
      return trip;
    case "patchTrip":
      return { ...trip, ...op.patch };
    case "upsertMember":
      return { ...trip, members: upsertById(trip.members, op.member) };
    case "upsertExpense":
      return { ...trip, expenses: upsertById(trip.expenses, op.expense) };
    case "deleteExpense":
      return {
        ...trip,
        expenses: trip.expenses.filter((e) => e.id !== op.expenseId),
        deletedExpenseIds: trip.deletedExpenseIds.includes(op.expenseId)
          ? trip.deletedExpenseIds
          : [...trip.deletedExpenseIds, op.expenseId],
      };
  }
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i === -1 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

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
  private flushAgain = false;
  private readonly refreshing = new Map<string, Promise<void>>();
  private persistenceUnavailable = false;
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
      this.persistenceUnavailable = false;
      this.snapshot = { ...this.snapshot, storageError: true };
      this.emit();
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
    if (this.persistenceUnavailable || this.snapshot.storageError) {
      throw new Error("Local storage is unavailable.");
    }
    await this.writer.saved();
    if (this.snapshot.storageError) throw new Error("Local storage is unavailable.");
  };

  /** Idempotent: safe under React StrictMode's double effects. */
  start() {
    this.starting ??= this.ready().then(() => this.flush());
    this.retryTimer ??= setInterval(() => {
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

  pendingCount = (tripId: string) => this.data.ops.filter((o) => o.tripId === tripId).length;
  failedCount = (tripId: string) => this.data.failedOps.filter((o) => o.tripId === tripId).length;

  retryFailed = (tripId: string) => {
    const failed = this.data.failedOps.filter((op) => op.tripId === tripId);
    if (!failed.length) return;
    this.update((d) => ({
      ...d,
      failedOps: d.failedOps.filter((op) => op.tripId !== tripId),
      ops: [...d.ops, ...failed.map(({ attempts: _attempts, retryAt: _retryAt, ...op }) => op as Op)],
    }));
    this.flush();
  };

  discardFailed = async (tripId: string) => {
    if (!this.data.failedOps.some((op) => op.tripId === tripId)) return;
    this.update((d) => ({ ...d, failedOps: d.failedOps.filter((op) => op.tripId !== tripId) }));
    await this.refresh(tripId);
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
      deletedExpenseIds: [],
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
    const trip = this.data.trips[tripId];
    if (!trip?.members.some((m) => m.id === memberId)) throw new ApiError("Trip member not found", 404);
    if (trip.syncEnabled && user?.id) {
      const member = trip.members.find((m) => m.id === memberId)!;
      const updated = await this.api.claimMember(trip.code ?? trip.inviteCode ?? "", memberId, member);
      this.adopt(updated);
    }
    this.setMe(tripId, memberId, user);
  };

  joinTrip = async (
    code: string,
    user?: { id?: string; email?: string; displayName?: string; name?: string; avatarUrl?: string },
  ): Promise<Trip> => {
    // A deep link can open the app straight into joining; don't let the
    // initial load overwrite the trip we're about to add.
    await this.ready();
    const trip = await this.api.joinTrip(code, user);
    if (isInviteExpired(trip.inviteExpiresAt)) {
      throw new ApiError("This invite code has expired.", 410);
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
    this.adopt(resolvedTrip, { allowNew: true });
    return resolvedTrip;
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
    if (user?.id) {
      const current = this.member(tripId, memberId);
      if (current?.userId && current.userId !== user.id) return;
      if (current && (current.userId !== user.id || current.email !== user.email || current.avatarUrl !== user.avatarUrl)) {
        if (this.data.trips[tripId]?.syncEnabled) this.enqueue({ kind: "upsertMember", tripId, member: {
          ...current, userId: user.id, email: user.email, avatarUrl: user.avatarUrl,
        } });
      }
    }
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
    const normalized = {
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 80) } : {}),
      ...(patch.baseCurrency !== undefined ? { baseCurrency: patch.baseCurrency } : {}),
    };
    const trip = this.data.trips[tripId];
    if (!trip) return;
    this.update((d) => ({ ...d, trips: { ...d.trips, [tripId]: applyOp(trip, { kind: "patchTrip", tripId, patch: normalized }) } }));
    if (trip.syncEnabled) this.enqueue({ kind: "patchTrip", tripId, patch: normalized });
  };

  saveExpense = (tripId: string, expense: Expense) => {
    const trip = this.data.trips[tripId];
    if (!trip) return;
    const updated = { ...expense, updatedAt: Date.now() };
    this.update((d) => ({ ...d, trips: { ...d.trips, [tripId]: applyOp(trip, { kind: "upsertExpense", tripId, expense: updated }) } }));
    if (trip.syncEnabled) this.enqueue({ kind: "upsertExpense", tripId, expense: updated });
  };

  deleteExpense = (tripId: string, expenseId: string) => {
    const trip = this.data.trips[tripId];
    if (!trip) return;
    this.update((d) => ({ ...d, trips: { ...d.trips, [tripId]: applyOp(trip, { kind: "deleteExpense", tripId, expenseId }) } }));
    if (trip.syncEnabled) this.enqueue({ kind: "deleteExpense", tripId, expenseId });
  };

  removeTripLocally = (tripId: string) =>
    this.update((d) => {
      const { [tripId]: _removed, ...trips } = d.trips;
      return {
        ...d,
        trips,
        ops: d.ops.filter((o) => o.tripId !== tripId),
        failedOps: d.failedOps.filter((o) => o.tripId !== tripId),
      };
    });

  updateSettings = (patch: Partial<Settings>) =>
    this.update((d) => ({ ...d, settings: { ...d.settings, ...patch } }));

  /** Push queued changes, then pull the latest copy of the trip if it has changed. */
  refresh = (tripId: string): Promise<void> => {
    if (!this.data.trips[tripId]?.syncEnabled) return Promise.resolve();
    const ongoing = this.refreshing.get(tripId);
    if (ongoing) return ongoing;
    const run = (async () => {
      await this.flush();
      try {
        const local = this.data.trips[tripId];
        const server = await this.api.getTrip(tripId, local?.revision);
        if (server) this.adopt(server);
        this.setOnline(true);
        this.setSyncError(tripId, undefined);
      } catch (err) {
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
            { ...trip, syncEnabled: trip.syncEnabled ?? Boolean(trip.ownerId) },
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
    while (this.data.ops.length) {
      const op = this.data.ops[0];
      if ((op.retryAt ?? 0) > Date.now()) return;
      try {
        const server = await this.send(op);
        this.dropOp(op);
        this.adopt(server);
        this.setOnline(true);
      } catch (err) {
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
    }
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
      const local = d.trips[server.id];
      // Ignore late responses for trips removed from this device.
      if (!local && !allowNew) return d;
      const pending = [
        ...d.ops.filter((o) => o.tripId === server.id),
        ...d.failedOps.filter((o) => o.tripId === server.id),
      ];
      // Compare server-owned revisions when available; device timestamps are
      // not comparable across clocks. Keep the timestamp fallback for older
      // server copies that predate revisions.
      if (local && !pending.length) {
        if (server.revision != null && local.revision != null && server.revision < local.revision) return d;
        if (server.revision == null && local.revision == null && server.updatedAt < local.updatedAt) return d;
      }
      // Polling usually returns what we already have: skip the re-render and disk write.
      if (
        local &&
        !pending.length &&
        ((server.revision != null && local.revision != null && server.revision === local.revision) ||
          (server.revision == null && local.revision == null && local.updatedAt === server.updatedAt)) &&
        local.code === server.code
      ) {
        return d;
      }
      const merged = pending.reduce(applyOp, {
        ...server,
        syncEnabled: true,
        deletedExpenseIds: server.deletedExpenseIds ?? [],
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
      },
      ready: true,
    };
    this.persistenceUnavailable = false;
    this.snapshot = { ...this.snapshot, storageError: false };
    this.writer.save();
    await this.writer.saved();
    await this.storage.removeItem?.(`${this.storageKey}:backup`).catch(() => {});
    this.emit();
  };
}
