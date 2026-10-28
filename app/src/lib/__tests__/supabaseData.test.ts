import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectLedger } from "../ledger";
import { MemoryStorage } from "../storage";
import { TripRepository, type TripApi } from "../../state/TripRepository";

async function directData() {
  process.env.EXPO_PUBLIC_SUPABASE_URL = "https://synthetic.invalid";
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "synthetic-test-key";
  process.env.EXPO_PUBLIC_SUPABASE_DATA_MODE = "direct";
  const { supabase } = await import("../supabase");
  const { supabaseData } = await import("../supabaseData");
  return { supabase, supabaseData };
}

test("account trip restoration skips damaged rows and keeps every valid trip", async (t) => {
  const { supabase, supabaseData } = await directData();
  const valid = { id: "first", updated_at: 1, trip_members: [], expenses: [] };
  const rows = [{ ...valid, id: "bad-time", updated_at: undefined }, valid,
    { ...valid, id: "bad-expense", expenses: [{ amount: 0 }] }, { ...valid, id: "last" }];
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  t.mock.method(supabase, "from", () => ({ select: async () => ({ data: rows, error: null }) }) as unknown as ReturnType<typeof supabase.from>);
  const trips = await supabaseData.listTrips();
  assert.deepEqual(trips.map((trip) => trip.id), ["first", "last"]);
  assert.deepEqual(warnings.map((warning) => warning[1]), ["bad-time", "bad-expense"]);
});

test("direct Supabase restoration retains damaged accounting values for confirmed repair", async (t) => {
  const { supabase, supabaseData } = await directData();
  const row = { id: "damaged-trip", name: "Synthetic", currency: "USD", updated_at: 1, revision: 1,
    trip_members: [{ id: "a", display_name: "Synthetic", user_id: "owner" }],
    expenses: [{ id: "damaged-expense", description: "Damaged", amount: 0, rate_to_base: -1, paid_by: "a", date: "2026-10-28",
      created_at: 1, updated_at: 1, split_definition: { type: "equal", memberIds: ["a"] } }],
  };
  t.mock.method(supabase, "from", () => ({ select: () => Object.assign(Promise.resolve({ data: [row], error: null }), {
    eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
  }) }) as unknown as ReturnType<typeof supabase.from>);
  let deleted = 0;
  t.mock.method(supabase, "rpc", (_name: string, args: { p_expense: { id: string; deleted_at: string } }) => {
    assert.equal(_name, "upsert_expense");
    assert.equal(args.p_expense.id, "damaged-expense");
    assert.ok(args.p_expense.deleted_at);
    row.expenses = [];
    row.revision++;
    deleted++;
    return Promise.resolve({ data: null, error: null }) as unknown as ReturnType<typeof supabase.rpc>;
  });
  const repo = new TripRepository(supabaseData as unknown as TripApi, new MemoryStorage(), "direct-repair");
  await repo.setAccount("owner");
  const restored = repo.getTrip(row.id)!;
  assert.equal(restored.expenses[0].amount, 0);
  assert.equal(restored.expenses[0].rateToBase, -1);
  assert.equal(inspectLedger(restored).ledger, undefined);
  assert.equal(inspectLedger(restored).invalid.length, 1);
  assert.equal(deleted, 0);
  await repo.removeDamagedExpense(row.id, 0, restored.expenses[0]);
  await repo.flush();
  await repo.saved();
  assert.equal(deleted, 1);
  assert.equal(inspectLedger(repo.getTrip(row.id)!).ledger!.totalSpent, 0);
});
