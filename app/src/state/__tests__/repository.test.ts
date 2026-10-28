import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStorage } from "../../lib/storage";
import { ApiError } from "../../lib/errors";
import { expense, trip } from "../../lib/__tests__/fixtures";
import type { Trip, TripPreview } from "../../lib/types";
import { TripRepository, type TripApi } from "../TripRepository";
import { ReceiptQueue } from "../ReceiptQueue";

async function repository(overrides: Partial<TripApi> = {}, initial = trip()) {
  const storage = new MemoryStorage();
  await storage.setItem("repo", JSON.stringify({ accountId: "owner", trips: { trip: initial }, ops: [], failedOps: [], me: { trip: "a" } }));
  const api = { listTrips: async () => [], ...overrides } as TripApi;
  const repo = new TripRepository(api, storage, "repo");
  await repo.setAccount("owner");
  return { repo, storage };
}

test("discard reloads unconditionally and removes rejected optimistic values at the same revision", async () => {
  const versions: (number | undefined)[] = [];
  const { repo } = await repository({
    upsertExpense: async () => { throw new ApiError("Forbidden", 403); },
    getTrip: async (_id, known) => { versions.push(known); return known === 1 ? null : trip(); },
  });
  repo.saveExpense("trip", expense({ amount: 20 }));
  await repo.flush();
  assert.equal(repo.failedCount("trip"), 1);
  await repo.discardFailed("trip");
  assert.deepEqual(versions, [undefined]);
  assert.equal(repo.failedCount("trip"), 0);
  assert.equal(repo.getTrip("trip")!.expenses[0].amount, 10);
  await repo.saved();
});

test("failed discard keeps rejected changes available for retry", async () => {
  const { repo } = await repository({ upsertExpense: async () => { throw new ApiError("Forbidden", 403); },
    getTrip: async () => { throw new Error("offline"); } });
  repo.saveExpense("trip", expense({ amount: 20 }));
  await repo.flush();
  await assert.rejects(repo.discardFailed("trip"), /offline/);
  assert.equal(repo.failedCount("trip"), 1);
});

test("an older poll cannot roll back a newer revision while an edit is pending", async () => {
  let resolvePoll!: (value: Trip) => void;
  const { repo } = await repository({ getTrip: () => new Promise((resolve) => { resolvePoll = resolve; }),
    joinTrip: async () => trip({ revision: 3, name: "Latest" }),
    upsertExpense: async () => { throw new ApiError("Unavailable", 503); } });
  const poll = repo.refresh("trip");
  await new Promise((resolve) => setImmediate(resolve));
  await repo.joinTrip("ABCDEF1234", { id: "owner" });
  repo.saveExpense("trip", expense({ amount: 20 }));
  await repo.flush();
  resolvePoll(trip());
  await poll;
  assert.equal(repo.getTrip("trip")!.revision, 3);
  assert.equal(repo.getTrip("trip")!.name, "Latest");
  assert.equal(repo.getTrip("trip")!.expenses[0].amount, 20);
});

test("invite previews never replace full cached trips and are adopted only after claiming", async () => {
  const preview: TripPreview = { preview: true, id: "trip", code: "ABCDEF1234", name: "Preview", baseCurrency: "USD", members: [{ id: "b", name: "Bob" }] };
  const { repo } = await repository({ joinTrip: async () => preview,
    claimMember: async () => trip({ members: [{ id: "b", name: "Bob", userId: "owner" }], revision: 2 }) });
  await repo.joinTrip("ABCDEF1234");
  assert.equal(repo.getTrip("trip")!.expenses.length, 1);
  assert.equal(repo.getTrip("trip")!.name, "Synthetic trip");
  await repo.claimTripMember("trip", "b", { id: "owner" });
  assert.equal(repo.meFor("trip"), "b");
  assert.equal(repo.getTrip("trip")!.revision, 2);
});

test("a failed claim does not change local identity or queue a member upsert", async () => {
  const { repo } = await repository({ claimMember: async () => { throw new ApiError("Claimed", 409); } });
  await assert.rejects(repo.claimTripMember("trip", "b", { id: "owner" }), /Claimed/);
  repo.setMe("trip", "b", { id: "owner" });
  assert.equal(repo.meFor("trip"), "a");
  assert.equal(repo.pendingCount("trip"), 0);
  assert.equal(repo.getTrip("trip")!.members[1].userId, "member");
});

test("a new member is saved only after the join endpoint accepts the claim", async () => {
  const { repo } = await repository({ claimMember: async () => { throw new ApiError("Unavailable", 503); } });
  await assert.rejects(repo.addSelfToTrip("trip", "New person", { id: "owner" }));
  assert.equal(repo.getTrip("trip")!.members.length, 2);
});

test("sign-out retains guest trips and sign-in restores account trips and identity", async () => {
  const { repo } = await repository({ listTrips: async () => [trip()] });
  const guest = repo.createTrip({ name: "Offline", baseCurrency: "USD", memberNames: ["Guest"] });
  await repo.setAccount(null);
  assert.equal(repo.getTrip("trip"), undefined);
  assert.ok(repo.getTrip(guest.id));
  await repo.setAccount("owner");
  assert.equal(repo.getTrip("trip")!.expenses.length, 1);
  assert.equal(repo.meFor("trip"), "a");
  assert.ok(repo.getTrip(guest.id));
});

test("late account restoration cannot cross account boundaries", async () => {
  let resolveList!: (value: Trip[]) => void;
  const repo = new TripRepository({ listTrips: () => new Promise((resolve) => { resolveList = resolve; }) } as TripApi, new MemoryStorage(), "repo");
  const first = repo.setAccount("owner");
  await new Promise((resolve) => setImmediate(resolve));
  await repo.setAccount(null);
  resolveList([trip()]);
  await first;
  assert.equal(repo.getTrip("trip"), undefined);
  assert.equal(repo.canSync(), false);
});

test("persisted operations wait for authentication and survive offline restoration", async () => {
  const storage = new MemoryStorage();
  await storage.setItem("repo", JSON.stringify({ accountId: "owner", trips: { trip: trip() }, ops: [{ kind: "upsertExpense", tripId: "trip", expense: expense() }], failedOps: [], me: {} }));
  let sent = 0;
  const repo = new TripRepository({ listTrips: async () => { throw new Error("offline"); }, upsertExpense: async () => { sent++; return trip({ revision: 2 }); } } as unknown as TripApi, storage, "repo");
  await repo.ready();
  await repo.flush();
  assert.equal(sent, 0);
  await repo.setAccount("owner");
  assert.equal(sent, 1);
  assert.equal(repo.pendingCount("trip"), 0);
});

test("receipt photos survive failed expense writes and are removed after a successful retry", async () => {
  const storage = new MemoryStorage();
  let fail = false;
  const repo = new TripRepository({} as TripApi, { getItem: storage.getItem.bind(storage), setItem: async (key, data) => {
    if (fail) throw new Error("disk full");
    await storage.setItem(key, data);
  } }, "repo");
  await repo.ready();
  const guest = repo.createTrip({ name: "Guest", baseCurrency: "USD", memberNames: ["Guest"] });
  await repo.saved();
  let connected = false;
  const removed: string[] = [];
  const queue = new ReceiptQueue({ repo, storage,
    network: { current: () => ({ connected, cellular: false }), subscribe: () => () => {} },
    files: { keep: async () => "photo.jpg", readBase64: async () => "synthetic", remove: (uri) => { removed.push(uri); } },
    rate: async () => 1, findDuplicate: async () => null,
    scan: async () => ({ merchant: "Shop", merchant_translated: null, detected_language: "English", country: null,
      currency: "USD", date: "2026-10-28", time: null, receipt_number: null, items: [], subtotal: null, tax: null, tip: null,
      service_charge: null, total: 10, category: "food", notes: null }),
  }, "queue");
  await queue.add(guest.id, "source.jpg");
  fail = true;
  connected = true;
  await queue.process();
  assert.equal(queue.getSnapshot().length, 1);
  assert.equal(repo.getSnapshot().storageError, true);
  assert.deepEqual(removed, []);
  fail = false;
  await queue.process();
  assert.equal(repo.getSnapshot().storageError, false);
  assert.equal(queue.getSnapshot().length, 0);
  assert.equal(repo.getTrip(guest.id)!.expenses.length, 1);
  assert.deepEqual(removed, ["photo.jpg"]);
});


test("a delayed poll from the old account is ignored even with a higher revision", async () => {
  let resolvePoll!: (value: Trip) => void;
  let restored: Trip[] = [];
  const { repo } = await repository({
    getTrip: () => new Promise((resolve) => { resolvePoll = resolve; }),
    listTrips: async () => restored,
  });
  const poll = repo.refresh("trip");
  await new Promise((resolve) => setImmediate(resolve));
  restored = [trip({ revision: 2, name: "Current account copy" })];
  await repo.setAccount("member");
  resolvePoll(trip({ revision: 99, name: "Old account response" }));
  await poll;
  assert.equal(repo.getTrip("trip")!.name, "Current account copy");
  assert.equal(repo.getTrip("trip")!.revision, 2);
});

test("claiming an unsynced trip explains that its invite is not ready", async () => {
  const { repo } = await repository({}, trip({ code: undefined }));
  await assert.rejects(repo.claimTripMember("trip", "b", { id: "owner" }), /once it has synced/);
  assert.equal(repo.meFor("trip"), "a");
});

test("retrying a failed receipt queue write reuses the moved photo", async () => {
  const storage = new MemoryStorage();
  const repo = new TripRepository({} as TripApi, storage, "repo");
  await repo.ready();
  const guest = repo.createTrip({ name: "Guest", baseCurrency: "USD", memberNames: ["Guest"] });
  await repo.saved();
  let fail = true;
  let kept = 0;
  const queue = new ReceiptQueue({ repo,
    storage: { getItem: storage.getItem.bind(storage), setItem: async (key, value) => {
      if (fail) throw new Error("disk full");
      await storage.setItem(key, value);
    } },
    network: { current: () => ({ connected: false, cellular: false }), subscribe: () => () => {} },
    files: { keep: async () => { kept++; return "moved-photo.jpg"; }, remove: () => assert.fail("Must retain the only photo"), readBase64: async () => "synthetic" },
    scan: async () => { throw new Error("offline"); }, rate: async () => 1, findDuplicate: async () => null,
  }, "queue");
  await assert.rejects(queue.add(guest.id, "source.jpg"), /disk full/);
  assert.equal(queue.getSnapshot().length, 1);
  fail = false;
  const saved = await queue.add(guest.id, "source.jpg");
  assert.equal(saved.imageUri, "moved-photo.jpg");
  assert.equal(kept, 1);
  assert.equal(queue.getSnapshot().length, 1);
  assert.equal(JSON.parse((await storage.getItem("queue"))!).length, 1);
});

test("account restoration retries on the repository timer after a transient outage", { timeout: 2000 }, async () => {
  let calls = 0;
  let restored!: () => void;
  const completion = new Promise<void>((resolve) => { restored = resolve; });
  const repo = new TripRepository({ listTrips: async () => {
    if (++calls === 1) throw new Error("temporary outage");
    restored();
    return [trip()];
  } } as TripApi, new MemoryStorage(), "repo", 5);
  await repo.setAccount("owner");
  assert.equal(repo.getTrip("trip"), undefined);
  try {
    await repo.start();
    await completion;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(repo.getTrip("trip")!.id, "trip");
  } finally { repo.stop(); }
});


test("a previously bound member can be selected offline before the first sync", async () => {
  let claims = 0;
  const { repo } = await repository({ claimMember: async () => { claims++; throw new Error("offline"); } }, trip({ code: undefined }));
  repo.setMe("trip", "b");
  await repo.claimTripMember("trip", "a", { id: "owner" });
  assert.equal(repo.meFor("trip"), "a");
  assert.equal(claims, 0);
});

test("upgrading a legacy active session retains unbound trips, unsent edits and rejected work", async () => {
  const storage = new MemoryStorage();
  const legacy = trip({ ownerId: undefined, members: [{ id: "a", name: "Unbound" }], expenses: [expense({ amount: 20 })] });
  await storage.setItem("repo", JSON.stringify({ trips: { trip: legacy },
    ops: [{ kind: "upsertExpense", tripId: "trip", expense: expense({ amount: 20 }) }],
    failedOps: [{ kind: "patchTrip", tripId: "trip", patch: { name: "Rejected" } }], me: { trip: "a" } }));
  const repo = new TripRepository({ listTrips: async () => [], upsertExpense: async () => { throw new Error("offline"); } } as unknown as TripApi, storage, "repo");
  const modes: (string | undefined)[] = [];
  await repo.setAccount("owner", async (mode) => { modes.push(mode); });
  assert.deepEqual(modes, ["migrate"]);
  assert.equal(repo.getTrip("trip"), undefined);
  const archive = repo.getSnapshot().data.unverified!;
  assert.equal(archive.trips.trip.expenses[0].amount, 20);
  assert.equal(archive.ops.length, 1);
  assert.equal(archive.failedOps.length, 1);
  assert.equal(repo.pendingCount("trip"), 0);
  assert.equal(repo.getSnapshot().data.accountId, "owner");
});

test("sign-out hides account trips even if receipt cleanup cannot be persisted", async () => {
  const { repo } = await repository();
  await assert.rejects(repo.setAccount(null, async () => { throw new Error("queue storage unavailable"); }), /queue storage unavailable/);
  assert.equal(repo.getTrip("trip"), undefined);
  assert.equal(repo.canSync(), false);
});

test("permanent restore errors stay online and wait for an explicit retry", { timeout: 2000 }, async () => {
  let calls = 0;
  let permanent = true;
  const repo = new TripRepository({ listTrips: async () => {
    calls++;
    if (permanent) throw new ApiError("Not found", 404);
    return [trip()];
  } } as TripApi, new MemoryStorage(), "repo", 5);
  await repo.setAccount("owner");
  assert.equal(repo.getSnapshot().online, true);
  assert.match(repo.getSnapshot().syncErrors.__account__, /Couldn't load/);
  try {
    await repo.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 1);
    permanent = false;
    await repo.retryAccountRestore();
    assert.equal(repo.getTrip("trip")!.id, "trip");
    assert.equal(repo.getSnapshot().syncErrors.__account__, undefined);
  } finally { repo.stop(); }
});


test("unverified offline edits are recovered for review only after server-confirmed access", async () => {
  const storage = new MemoryStorage();
  await storage.setItem("repo", JSON.stringify({ trips: { trip: trip({ ownerId: undefined, members: [{ id: "a", name: "Unbound" }] }) },
    ops: [{ kind: "upsertExpense", tripId: "trip", expense: expense({ amount: 20 }) }], failedOps: [], me: { trip: "a" } }));
  let sent = 0;
  const repo = new TripRepository({ listTrips: async () => [], joinTrip: async () => trip(),
    upsertExpense: async () => { sent++; return trip(); } } as unknown as TripApi, storage, "repo");
  await repo.setAccount(null);
  assert.equal(repo.hasUnverifiedTrip("trip"), true);
  await repo.setAccount("owner");
  assert.equal(repo.getTrip("trip"), undefined);
  assert.equal(sent, 0);
  await repo.joinTrip("ABCDEF1234", { id: "owner" });
  assert.equal(repo.hasUnverifiedTrip("trip"), false);
  assert.equal(repo.getTrip("trip")!.expenses[0].amount, 20);
  assert.equal(repo.failedCount("trip"), 1);
  assert.equal(repo.getSnapshot().data.failedOps[0].recovered, true);
  assert.equal(sent, 0);
});

test("migration holds receipt photos until the user reviews them, including an in-flight scan", async () => {
  const storage = new MemoryStorage();
  await storage.setItem("repo", JSON.stringify({ trips: { trip: trip({ ownerId: undefined, members: [{ id: "a", name: "Unbound" }] }) }, ops: [], failedOps: [], me: {} }));
  let releaseScan!: () => void;
  let scanStarted!: () => void;
  const started = new Promise<void>((resolve) => { scanStarted = resolve; });
  const repo = new TripRepository({ listTrips: async () => [], joinTrip: async () => trip() } as unknown as TripApi, storage, "repo");
  await repo.ready();
  let connected = false;
  const removed: string[] = [];
  const queue = new ReceiptQueue({ repo, storage,
    network: { current: () => ({ connected, cellular: false }), subscribe: () => () => {} },
    files: { keep: async () => "photo.jpg", readBase64: async () => "synthetic", remove: (uri) => { removed.push(uri); } },
    rate: async () => 1, findDuplicate: async () => null,
    scan: async () => { scanStarted(); await new Promise<void>((resolve) => { releaseScan = resolve; });
      return { merchant: "Shop", merchant_translated: null, detected_language: "English", country: null,
        currency: "USD", date: "2026-10-28", time: null, receipt_number: null, items: [], subtotal: null, tax: null, tip: null,
        service_charge: null, total: 10, category: "food", notes: null }; },
  }, "queue");
  await queue.add("trip", "source.jpg");
  // Simulate a scan already in flight when the authenticated account changes.
  repo.canSync = () => true;
  connected = true;
  const processing = queue.process();
  await started;
  await repo.setAccount("owner", queue.clearForAccount);
  releaseScan();
  await processing;
  assert.equal(queue.getSnapshot().length, 1);
  assert.equal(queue.getSnapshot()[0].status, "failed");
  assert.deepEqual(removed, []);
  await repo.joinTrip("ABCDEF1234", { id: "owner" });
  await queue.process();
  assert.equal(queue.getSnapshot()[0].status, "failed");
  assert.deepEqual(removed, []);
});
