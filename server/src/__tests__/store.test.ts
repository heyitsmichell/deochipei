import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { allowedOrigin } from "../cors.js";
import { ExpenseConflictError, TripStore, type Expense, type NewTrip } from "../store.js";

const newTrip = (id = "trip", extra: Partial<NewTrip> = {}): NewTrip => ({
  id, name: "Synthetic", baseCurrency: "USD", expenses: [], ownerId: "owner",
  members: [{ id: "a", name: "Alice", userId: "owner" }, { id: "b", name: "Bob" }], ...extra,
});
const expense = (id: string): Expense => ({ id, updatedAt: 1, amount: 5, description: id });

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "deochipei-store-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("trips survive a restart", () => withDir(async (dir) => {
  const file = join(dir, "trips.db");
  const first = new TripStore(file);
  await first.load();
  const created = await first.create(newTrip());
  await first.upsertExpense("trip", expense("e1"));
  first.close();

  const second = new TripStore(file);
  await second.load();
  const trip = second.get("trip")!;
  assert.equal(trip.expenses.length, 1);
  assert.equal(second.findByCode(created.code)?.id, "trip");
  second.close();
}));

test("a change that throws is rolled back completely", () => withDir(async (dir) => {
  const store = new TripStore(join(dir, "trips.db"));
  await store.load();
  await store.create(newTrip("trip", { members: [{ id: "a", name: "Alice", userId: "owner" }, { id: "b", name: "Bob", userId: "someone" }] }));
  const before = store.get("trip")!;
  await assert.rejects(store.claimMember("trip", "b", { id: "b", name: "Mallory", userId: "mallory" }), /already claimed/);
  assert.deepEqual(store.get("trip"), before);
  // The failed attempt must not have consumed or corrupted the version counter.
  const next = await store.upsertExpense("trip", expense("e1"));
  assert.equal(next!.revision, before.revision! + 1);
  store.close();
}));

test("two writers on one database never lose each other's changes", () => withDir(async (dir) => {
  // Two connections stand in for two server processes sharing a volume.
  const file = join(dir, "trips.db");
  const one = new TripStore(file);
  const two = new TripStore(file);
  await one.load();
  await two.load();
  await one.create(newTrip());
  await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? one : two).upsertExpense("trip", expense(`e${i}`))));
  const trip = one.get("trip")!;
  assert.equal(trip.expenses.length, 40);
  assert.deepEqual(two.get("trip"), trip);
  one.close();
  two.close();
}));

test("separate server processes writing at once never lose a change", () => withDir(async (dir) => {
  const file = join(dir, "trips.db");
  const store = new TripStore(file);
  await store.load();
  const created = await store.create(newTrip());
  const worker = fileURLToPath(new URL("./concurrent-writer.ts", import.meta.url));
  // Listen for each exit at spawn time: awaiting them one by one can miss an exit that already happened.
  const exits = ["p", "q", "r"].map((prefix) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, file, prefix, "30"], { stdio: ["ignore", "ignore", "inherit"] });
    return once(child, "exit");
  });
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
  const trip = store.get("trip")!;
  assert.equal(trip.expenses.length, 90);
  assert.equal(new Set(trip.expenses.map((e) => e.id)).size, 90);
  assert.equal(trip.revision, created.revision! + 90);
  store.close();
}));

test("revisions strictly increase and join codes stay unique", () => withDir(async (dir) => {
  const store = new TripStore(join(dir, "trips.db"));
  await store.load();
  const trips = [];
  for (let i = 0; i < 25; i++) trips.push(await store.create(newTrip(`t${i}`)));
  assert.equal(new Set(trips.map((t) => t.code)).size, 25);
  const revisions = trips.map((t) => t.revision!);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));
  assert.equal(new Set(revisions).size, 25);
  await assert.rejects(store.create(newTrip("t3")), /already exists/);
  const rotated = await store.regenerateInvite("t3");
  assert.notEqual(rotated.code, trips[3].code);
  assert.equal(store.findByCode(trips[3].code), undefined);
  assert.equal(store.findByCode(rotated.code)?.id, "t3");
  store.close();
}));

test("listForUser returns owned and joined trips only, and expired invites don't resolve", () => withDir(async (dir) => {
  const store = new TripStore(join(dir, "trips.db"));
  await store.load();
  await store.create(newTrip("mine"));
  await store.create(newTrip("joined", { ownerId: "other", members: [{ id: "x", name: "Xi", userId: "owner" }] }));
  await store.create(newTrip("theirs", { ownerId: "other", members: [{ id: "y", name: "Yu", userId: "other" }] }));
  assert.deepEqual(store.listForUser("owner").map((t) => t.id), ["mine", "joined"]);
  assert.deepEqual(store.listForUser("nobody"), []);
  const expired = await store.regenerateInvite("mine", -1);
  assert.equal(store.findByCode(expired.code), undefined);
  store.close();
}));

test("an existing trips.json is imported once and kept as a backup", () => withDir(async (dir) => {
  const legacy = join(dir, "trips.json");
  const old = { id: "old", code: "ABCDEFGHJK", name: "Old", baseCurrency: "EUR", members: [], expenses: [expense("e1")],
    deletedExpenseIds: [], createdAt: 1, updatedAt: 1, ownerId: "owner" }; // no revision, like early data
  await writeFile(legacy, JSON.stringify([old, { ...old, id: "dupe", name: "Same code" }]));
  const file = join(dir, "trips.db");
  const store = new TripStore(file);
  await store.load();
  assert.equal(store.get("old")!.expenses.length, 1);
  assert.ok(store.get("old")!.revision! > 0);
  assert.notEqual(store.get("dupe")!.code, store.get("old")!.code);
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(`${legacy}.migrated`), true);
  await store.upsertExpense("old", expense("e2"));
  store.close();

  // A stray trips.json appearing later must not overwrite newer data.
  await writeFile(legacy, JSON.stringify([old]));
  const again = new TripStore(file);
  await again.load();
  assert.equal(again.get("old")!.expenses.length, 2);
  again.close();
}));

test("an unreadable trips.json stops startup instead of starting empty", () => withDir(async (dir) => {
  await writeFile(join(dir, "trips.json"), "{ not json");
  const store = new TripStore(join(dir, "trips.db"));
  await assert.rejects(store.load());
  assert.equal(await readFile(join(dir, "trips.json"), "utf8"), "{ not json");
}));

test("CORS is open in development, closed in production, and an allowlist when configured", () => {
  assert.equal(allowedOrigin("http://localhost:8081", {}), "*");
  assert.equal(allowedOrigin("https://evil.example", { NODE_ENV: "production" }), undefined);
  const env = { NODE_ENV: "production", CORS_ORIGINS: "https://app.example, https://admin.example" };
  assert.equal(allowedOrigin("https://admin.example", env), "https://admin.example");
  assert.equal(allowedOrigin("https://evil.example", env), undefined);
  assert.equal(allowedOrigin(undefined, env), undefined);
  assert.equal(allowedOrigin("https://anything.example", { CORS_ORIGINS: "*" }), "*");
});

test("expense edits carry a base revision and stale edits are refused", async () => {
  const store = new TripStore(":memory:");
  await store.load();
  await store.create(newTrip());

  // First save: the server assigns revision.
  const first = (await store.upsertExpense("trip", expense("e1"), undefined))!.expenses[0];
  assert.ok(first.revision && first.revision > 0);

  // Alice and Bob both start editing from `first`.
  const alice = { ...first, description: "Alice's edit" };
  const bob = { ...first, description: "Bob's edit" };
  const afterAlice = (await store.upsertExpense("trip", alice, first.revision))!.expenses[0];
  assert.ok(afterAlice.revision! > first.revision!);

  // Bob's stale edit is refused and nothing is written.
  await assert.rejects(() => store.upsertExpense("trip", bob, first.revision), (error: unknown) => {
    assert.ok(error instanceof ExpenseConflictError);
    assert.equal(error.reason, "changed");
    assert.equal(error.current?.description, "Alice's edit");
    return true;
  });
  assert.equal(store.get("trip")!.expenses[0].description, "Alice's edit");

  // After reviewing, Bob retries against the current revision.
  await store.upsertExpense("trip", bob, afterAlice.revision);
  assert.equal(store.get("trip")!.expenses[0].description, "Bob's edit");
  store.close();
});

test("a retried write whose response was lost is not a conflict", async () => {
  const store = new TripStore(":memory:");
  await store.load();
  await store.create(newTrip());
  const saved = (await store.upsertExpense("trip", expense("e1")))!.expenses[0];
  const edit = { ...saved, description: "edited", updatedAt: 99 };
  const once = (await store.upsertExpense("trip", edit, saved.revision))!;
  const revisionAfter = once.expenses[0].revision;
  const replay = (await store.upsertExpense("trip", { ...edit, updatedAt: 100 }, saved.revision))!;
  assert.equal(replay.expenses[0].revision, revisionAfter, "replay must not bump the revision");
  store.close();
});

test("editing an expense someone deleted is a conflict only for revision-aware clients", async () => {
  const store = new TripStore(":memory:");
  await store.load();
  await store.create(newTrip());
  const saved = (await store.upsertExpense("trip", expense("e1")))!.expenses[0];
  await store.deleteExpense("trip", "e1");
  await assert.rejects(() => store.upsertExpense("trip", saved, saved.revision), (e: unknown) =>
    e instanceof ExpenseConflictError && e.reason === "deleted");
  // Older apps (no base revision) keep the previous silent no-op.
  await store.upsertExpense("trip", saved);
  assert.equal(store.get("trip")!.expenses.length, 0);
  store.close();
});

test("without a base revision the old last-write-wins behaviour is kept", async () => {
  const store = new TripStore(":memory:");
  await store.load();
  await store.create(newTrip());
  await store.upsertExpense("trip", expense("e1"));
  await store.upsertExpense("trip", { ...expense("e1"), description: "legacy overwrite" });
  assert.equal(store.get("trip")!.expenses[0].description, "legacy overwrite");
  store.close();
});
