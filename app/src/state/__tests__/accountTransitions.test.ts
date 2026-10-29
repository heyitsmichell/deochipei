import assert from "node:assert/strict";
import { test } from "node:test";
import { trip } from "../../lib/__tests__/fixtures";
import type { Settlement } from "../../lib/types";
import { planAccountTransition, type AccountScopedData } from "../accountTransitions";
import { applyOp, type Op } from "../tripOps";

const settlement = (patch: Partial<Settlement> = {}): Settlement => ({
  id: "pay", from: "b", to: "a", amount: 5, currency: "USD",
  date: "2026-10-29", createdAt: 2, updatedAt: 2, ...patch,
});

test("settlement ops update in place, delete, and leave one tombstone per id", () => {
  const first = applyOp(trip({ settlements: [] }), { kind: "upsertSettlement", tripId: "trip", settlement: settlement() });
  assert.deepEqual(first.settlements?.map((row) => row.id), ["pay"]);

  const updated = applyOp(first, {
    kind: "upsertSettlement", tripId: "trip", settlement: settlement({ amount: 7 }),
  });
  assert.equal(updated.settlements?.length, 1);
  assert.equal(updated.settlements?.[0].amount, 7);

  const deleted = applyOp(updated, { kind: "deleteSettlement", tripId: "trip", settlementId: "pay" });
  assert.deepEqual(deleted.settlements, []);
  assert.deepEqual(deleted.deletedSettlementIds, ["pay"]);

  const again = applyOp(deleted, { kind: "deleteSettlement", tripId: "trip", settlementId: "pay" });
  assert.deepEqual(again.deletedSettlementIds, ["pay"]);
});

test("expense deletion is idempotent and does not depend on the row still existing", () => {
  const deleted = applyOp(trip(), { kind: "deleteExpense", tripId: "trip", expenseId: "expense" });
  assert.deepEqual(deleted.expenses, []);
  const again = applyOp(deleted, { kind: "deleteExpense", tripId: "trip", expenseId: "expense" });
  assert.deepEqual(again.deletedExpenseIds, ["expense"]);
});

test("a budget patch sets and clears the cap without changing other trip fields", () => {
  const budgeted = applyOp(trip({ name: "Japan" }), {
    kind: "patchTrip", tripId: "trip", patch: { budget: 2500 },
  });
  assert.equal(budgeted.budget, 2500);
  assert.equal(budgeted.name, "Japan");

  const cleared = applyOp(budgeted, {
    kind: "patchTrip", tripId: "trip", patch: { budget: null },
  });
  assert.equal(cleared.budget, undefined);
  assert.equal(cleared.name, "Japan");
});

function data(patch: Partial<AccountScopedData> = {}): AccountScopedData {
  return { trips: {}, ops: [], failedOps: [], me: {}, ...patch };
}

const op = (tripId: string): Op => ({ kind: "patchTrip", tripId, patch: { name: "Queued" } });

test("planning an account transition keeps data that already belongs to the account", () => {
  assert.deepEqual(planAccountTransition(data({ accountId: "owner" }), "owner"), { kind: "none" });
  assert.deepEqual(planAccountTransition(data({ accountId: "owner", trips: { trip: trip() } }), "owner"), { kind: "none" });
});

test("switching to a different known account asks for a reset", () => {
  assert.deepEqual(planAccountTransition(data({ accountId: "owner", trips: { trip: trip() } }), "member"), { kind: "reset" });
  assert.deepEqual(planAccountTransition(data({ accountId: "owner" }), null), { kind: "reset" });
});

test("legacy data stays when the incoming account owns every trip", () => {
  const legacy = data({ trips: { trip: trip() }, me: { trip: "a" }, ops: [op("trip")] });
  assert.deepEqual(planAccountTransition(legacy, "owner"), { kind: "none" });
});

test("legacy data of unknown ownership is parked instead of sent as the new user", () => {
  const stranger = trip({ id: "other", ownerId: "somebody", members: [{ id: "x", name: "X", userId: "somebody" }] });
  const localOnly = trip({ id: "local", syncEnabled: false, ownerId: undefined });
  const legacy = data({
    trips: { trip: trip(), other: stranger, local: localOnly },
    me: { trip: "a", other: "x", local: "a" },
    ops: [op("trip"), op("other")],
    failedOps: [op("other")],
    unverified: { trips: {}, ops: [op("old")], failedOps: [], me: { old: "a" } },
  });

  const plan = planAccountTransition(legacy, "owner");
  assert.equal(plan.kind, "migrate");
  if (plan.kind !== "migrate") return;
  assert.deepEqual(Object.keys(plan.data.trips).sort(), ["local", "trip"]);
  assert.deepEqual(Object.keys(plan.data.unverified!.trips), ["other"]);
  assert.deepEqual(plan.data.unverified!.me, { old: "a", other: "x" });
  assert.deepEqual(plan.data.unverified!.ops.map((entry) => entry.tripId), ["old", "other"]);
  assert.deepEqual(plan.data.ops.map((entry) => entry.tripId), ["trip"]);
  assert.deepEqual(plan.data.unverified!.failedOps.map((entry) => entry.tripId), ["other"]);
  assert.deepEqual(plan.data.failedOps, []);
  assert.deepEqual(Object.keys(plan.data.me).sort(), ["local", "trip"]);
});

test("signed-out legacy data parks every synced trip but keeps local-only trips", () => {
  const legacy = data({
    trips: { trip: trip(), local: trip({ id: "local", syncEnabled: false }) },
    me: { trip: "a", local: "a" },
  });
  const plan = planAccountTransition(legacy, null);
  assert.equal(plan.kind, "migrate");
  if (plan.kind !== "migrate") return;
  assert.deepEqual(Object.keys(plan.data.trips), ["local"]);
  assert.deepEqual(Object.keys(plan.data.unverified!.trips), ["trip"]);
});
