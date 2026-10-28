import type { DuplicateMatch } from "../lib/duplicates";
import { ApiError } from "../lib/errors";
import type { NetworkMonitor } from "../lib/network";
import type { ReceiptFileStore } from "../lib/receiptFiles";
import { isCurrencyCode, isISODate, receiptFromScan } from "../lib/receiptScan";
import { CoalescedWriter, type KeyValueStorage } from "../lib/storage";
import { newId, todayISO, type Expense, type ReceiptScan, type Trip } from "../lib/types";
import type { TripRepository } from "./TripRepository";

/** A receipt photo taken offline, waiting to be read and added to its trip. */
export interface QueuedReceipt {
  /** Also the id of the expense it becomes, so a retry after a crash can't add it twice. */
  id: string;
  tripId: string;
  imageUri: string;
  capturedAt: number;
  /** Local date the photo was taken, used if the receipt's own date can't be read. */
  capturedOn: string;
  paidBy: string;
  /** Who was on the trip when the photo was taken; the expense is split equally between them. */
  memberIds: string[];
  /** May be read over mobile data even when settings say Wi-Fi only (the user asked for it). */
  allowCellular: boolean;
  /** "duplicate": looks like a receipt someone already added; held until the user decides. */
  status: "waiting" | "reading" | "failed" | "duplicate";
  /** Why the last attempt didn't work. A "failed" receipt needs the user to retry or enter it. */
  error?: string;
  /** Attempts the server or rate lookup turned down; a lost connection doesn't count. */
  attempts: number;
  /** Don't try again before this (backoff after a server error). */
  retryAt?: number;
  /** The scan, kept as soon as it's back so a later step failing doesn't pay for another one. */
  scan?: ReceiptScan;
  /** The expense this receipt seems to repeat, while it's held as a "duplicate". */
  duplicate?: DuplicateMatch;
  /** The user said it isn't a duplicate: add it without checking again. */
  addAnyway?: boolean;
}

export interface ReceiptQueueDeps {
  repo: Pick<TripRepository, "ready" | "getTrip" | "meFor" | "saveExpense" | "getSnapshot" | "refresh">;
  network: NetworkMonitor;
  storage: KeyValueStorage;
  files: ReceiptFileStore;
  scan: (imageBase64: string, targetLanguage: string) => Promise<ReceiptScan>;
  /** Units of `to` per 1 `from`. */
  rate: (from: string, to: string) => Promise<number>;
  /** The expense on `trip` that this receipt repeats, if any (see lib/duplicates.ts). */
  findDuplicate: (trip: Trip, scan: ReceiptScan, rateToBase: number) => Promise<DuplicateMatch | null>;
}

type Outcome = "next" | "skip" | "stop";

const MAX_ATTEMPTS = 5;

/**
 * Receipts snapped without a connection. Photos are kept on the device and,
 * once there's Wi-Fi (or mobile data, if allowed), each one is read by the
 * receipt scanner, converted at the current rate and saved as an expense
 * through TripRepository, whose own queue syncs it to the group.
 *
 * Expenses added this way are marked `needsReview`: the split defaults to
 * everyone on the trip, equally, paid by whoever took the photo. Before
 * adding one, the queue checks the latest copy of the trip for the same
 * receipt (often someone with data scanned it while this phone was offline)
 * and holds look-alikes for the user instead of charging the trip twice.
 */
export class ReceiptQueue {
  private items: QueuedReceipt[] = [];
  private readonly listeners = new Set<() => void>();
  private loading?: Promise<void>;
  private running?: Promise<void>;
  private again = false;
  private retryTimer?: ReturnType<typeof setInterval>;
  private unsubscribeNetwork?: () => void;
  private readonly writer: CoalescedWriter;

  constructor(
    private readonly deps: ReceiptQueueDeps,
    private readonly storageKey = "deochipei:receipts:v1",
    private readonly retryMs = 30000,
  ) {
    this.writer = new CoalescedWriter(deps.storage, storageKey, () => this.items);
  }

  // ── Subscription ────────────────────────────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.items;

  ready = () => (this.loading ??= this.load());

  /** Resolves once every change so far has been written to storage. */
  saved = () => this.writer.saved();

  /** Idempotent: safe under React StrictMode's double effects. */
  start() {
    // Connecting to Wi-Fi is the main trigger; the timer covers backoff and flaky networks.
    this.unsubscribeNetwork ??= this.deps.network.subscribe(() => this.process());
    this.retryTimer ??= setInterval(() => {
      if (this.items.some((i) => i.status === "waiting")) this.process();
    }, this.retryMs);
    return this.ready().then(() => this.process());
  }

  stop() {
    clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = undefined;
  }

  // ── Commands ────────────────────────────────────────────────────────────

  /** Keeps a photo to be read and added to `tripId` when the network allows. */
  add = async (
    tripId: string,
    photoUri: string,
    opts: { paidBy?: string; memberIds?: string[]; allowCellular?: boolean } = {},
  ): Promise<QueuedReceipt> => {
    await this.ready();
    const trip = this.deps.repo.getTrip(tripId);
    if (!trip) throw new Error("Trip not found on this device.");
    const id = newId();
    const item: QueuedReceipt = {
      id,
      tripId,
      imageUri: await this.deps.files.keep(photoUri, id),
      capturedAt: Date.now(),
      capturedOn: todayISO(),
      paidBy: opts.paidBy ?? this.deps.repo.meFor(tripId) ?? trip.members[0]?.id ?? "",
      memberIds: opts.memberIds ?? trip.members.map((m) => m.id),
      allowCellular: opts.allowCellular ?? false,
      status: "waiting",
      attempts: 0,
    };
    this.update((items) => [...items, item]);
    this.process();
    return item;
  };

  /** Tries one receipt again right away, over mobile data if that's what's available. */
  retry = (id: string) => {
    this.patch(id, { status: "waiting", error: undefined, attempts: 0, retryAt: undefined, allowCellular: true });
    return this.process();
  };

  /** The user says a receipt held as a duplicate is a separate purchase: add it. */
  addAnyway = (id: string) => {
    this.patch(id, { status: "waiting", addAnyway: true, duplicate: undefined, retryAt: undefined, allowCellular: true });
    return this.process();
  };

  /** Reads everything waiting for a trip now, over mobile data if need be. */
  readNow = (tripId: string) => {
    this.update((items) =>
      items.map((i) =>
        i.tripId === tripId && i.status === "waiting" ? { ...i, allowCellular: true, retryAt: undefined } : i,
      ),
    );
    return this.process();
  };

  /** Drops a receipt and its photo, e.g. once it has been entered by hand. */
  discard = (id: string) => {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    this.deps.files.remove(item.imageUri);
    this.update((items) => items.filter((i) => i.id !== id));
  };

  /**
   * Reads waiting receipts one at a time while the network allows. Calls made
   * during a run share it, and it goes round once more to pick up whatever
   * they changed.
   */
  process = (): Promise<void> => {
    this.again = true;
    this.running ??= this.drainWhileAsked().finally(() => {
      this.running = undefined;
    });
    return this.running;
  };

  // ── Internals ───────────────────────────────────────────────────────────

  private get settings() {
    return this.deps.repo.getSnapshot().data.settings;
  }

  private async load() {
    await this.deps.repo.ready();
    let saved: QueuedReceipt[] = [];
    try {
      let raw = await this.deps.storage.getItem(this.storageKey);
      if (!raw && this.storageKey === "deochipei:receipts:v1") {
        const legacy = await this.deps.storage.getItem("travelsplit:receipts:v1");
        if (legacy) {
          raw = legacy;
          await this.deps.storage.setItem(this.storageKey, legacy);
          if (this.deps.storage.removeItem) {
            await this.deps.storage.removeItem("travelsplit:receipts:v1").catch(() => {});
          }
        }
      }
      if (raw) saved = JSON.parse(raw);
    } catch {
      // Unreadable storage: start with an empty queue rather than crash.
    }
    // Receipts for trips removed from this device in the meantime have nowhere to go.
    const kept = saved.filter((i) => this.deps.repo.getTrip(i.tripId));
    for (const item of saved) if (!kept.includes(item)) this.deps.files.remove(item.imageUri);
    // A receipt still "reading" means the app was closed mid-scan: start it over.
    this.update(() => kept.map((i) => (i.status === "reading" ? { ...i, status: "waiting" } : i)));
  }

  private async drainWhileAsked() {
    await this.ready();
    while (this.again) {
      this.again = false;
      await this.drain();
    }
  }

  private async drain() {
    const skipped = new Set<string>();
    for (;;) {
      const item = this.items.find((i) => i.status === "waiting" && !skipped.has(i.id) && this.mayRead(i));
      if (!item) return;
      const outcome = await this.read(item);
      if (outcome === "stop") return;
      if (outcome === "skip") skipped.add(item.id);
    }
  }

  private mayRead(item: QueuedReceipt) {
    const { connected, cellular } = this.deps.network.current();
    if (!connected || (item.retryAt ?? 0) > Date.now()) return false;
    return !cellular || item.allowCellular || this.settings.scanQueuedOnCellular;
  }

  /** Scan → exchange rate → expense, for one receipt. */
  private async read(item: QueuedReceipt): Promise<Outcome> {
    const trip = this.deps.repo.getTrip(item.tripId);
    if (!trip) {
      this.discard(item.id);
      return "next";
    }
    this.patch(item.id, { status: "reading" });

    let scan = item.scan;
    if (!scan) {
      let image: string;
      try {
        image = await this.deps.files.readBase64(item.imageUri);
      } catch {
        return this.fail(item, "The photo is no longer on this device.");
      }
      try {
        scan = await this.deps.scan(image, this.settings.receiptLanguage);
      } catch (err) {
        // Not a receipt, or the reader declined it: trying again won't change that.
        if (err instanceof ApiError && err.isPermanent) return this.fail(item, err.message);
        // Server busy or down: back off, and leave the rest of the queue for later too.
        if (err instanceof ApiError) return this.retryLater(item, err.message, "stop");
        // Lost the connection or timed out. Not the receipt's fault, so it isn't counted.
        this.patch(item.id, { status: "waiting" });
        return "stop";
      }
      if (!this.has(item.id)) return "next"; // Discarded while it was being read.
      this.patch(item.id, { scan });
    }

    if (!isCurrencyCode(scan.currency)) return this.fail(item, "Couldn't tell which currency the receipt is in.");
    if (!(scan.total > 0)) return this.fail(item, "Couldn't find the total on the receipt.");

    let rateToBase = 1;
    if (scan.currency !== trip.baseCurrency) {
      try {
        rateToBase = Number((await this.deps.rate(scan.currency, trip.baseCurrency)).toPrecision(6));
      } catch {
        // Other receipts may be in a currency we do have a rate for.
        return this.retryLater(item, `Couldn't get a ${scan.currency} → ${trip.baseCurrency} rate.`, "skip");
      }
    }
    if (!this.has(item.id)) return "next";

    if (!item.addAnyway) {
      // Someone may have added this receipt while the photo waited: check the latest copy of the trip.
      await this.deps.repo.refresh(trip.id);
      let match: DuplicateMatch | null;
      try {
        match = await this.deps.findDuplicate(this.deps.repo.getTrip(trip.id) ?? trip, scan, rateToBase);
      } catch (err) {
        if (err instanceof ApiError && err.isPermanent) {
          // The check itself was turned down. Add it anyway; it's flagged for review.
          match = null;
        } else if (err instanceof ApiError) {
          return this.retryLater(item, `Couldn't check whether it's already on the trip: ${err.message}`, "skip");
        } else {
          this.patch(item.id, { status: "waiting" });
          return "stop";
        }
      }
      if (!this.has(item.id)) return "next";
      if (match) {
        this.patch(item.id, { status: "duplicate", duplicate: match, error: undefined });
        return "next";
      }
    }

    this.deps.repo.saveExpense(trip.id, expenseFromScan(item, scan, trip, rateToBase));
    this.discard(item.id);
    return "next";
  }

  private fail(item: QueuedReceipt, error: string): Outcome {
    this.patch(item.id, { status: "failed", error });
    return "next";
  }

  private retryLater(item: QueuedReceipt, error: string, outcome: Outcome): Outcome {
    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.patch(item.id, { status: "failed", error, attempts });
      return "next";
    }
    const retryAt = Date.now() + this.retryMs * 2 ** (attempts - 1);
    this.patch(item.id, { status: "waiting", error, attempts, retryAt });
    return outcome;
  }

  private has(id: string) {
    return this.items.some((i) => i.id === id);
  }

  private patch(id: string, change: Partial<QueuedReceipt>) {
    if (!this.has(id)) return;
    this.update((items) => items.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }

  private update(fn: (items: QueuedReceipt[]) => QueuedReceipt[]) {
    const next = fn(this.items);
    if (next === this.items) return;
    this.items = next;
    this.writer.save();
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  clearForAccount = async () => {
    const pending = [...this.items];
    this.items = [];
    this.writer.save();
    await this.deps.storage.removeItem?.(this.storageKey).catch(() => {});
    await this.deps.storage.removeItem?.(`${this.storageKey}:backup`).catch(() => {});
    for (const item of pending) this.deps.files.remove(item.imageUri);
    this.emit();
  };
}

/** The expense a queued receipt becomes, flagged for someone to check the split. */
export function expenseFromScan(item: QueuedReceipt, scan: ReceiptScan, trip: Trip, rateToBase: number): Expense {
  return {
    id: item.id,
    description: scan.merchant_translated || scan.merchant || "Receipt",
    category: scan.category,
    amount: scan.total,
    currency: scan.currency,
    rateToBase,
    paidBy: item.paidBy,
    date: isISODate(scan.date) ? scan.date : item.capturedOn,
    split: {
      type: "equal",
      memberIds: item.memberIds.length ? item.memberIds : trip.members.map((m) => m.id),
    },
    receipt: receiptFromScan(scan),
    needsReview: true,
    createdAt: item.capturedAt,
    updatedAt: Date.now(),
  };
}
