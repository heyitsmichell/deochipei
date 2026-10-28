import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger, inspectLedger } from "../ledger";
import { computeItemizedBreakdown, computeShares } from "../split";
import { CoalescedWriter, MemoryStorage } from "../storage";
import { expense, trip } from "./fixtures";


test("failed writes reject current and later acknowledgements and can recover", async () => {
  let fail = true;
  let errors = 0;
  let value = 1;
  const storage = new MemoryStorage();
  const writer = new CoalescedWriter({ ...storage, getItem: storage.getItem.bind(storage), setItem: async (key, data) => {
    if (fail) throw new Error("disk full");
    await storage.setItem(key, data);
  } }, "test", () => value, () => errors++);
  writer.save();
  await assert.rejects(writer.saved(), /disk full/);
  await assert.rejects(writer.saved(), /disk full/);
  assert.equal(errors, 1);
  fail = false;
  value = 2;
  writer.save();
  await writer.saved();
  assert.equal(await storage.getItem("test"), "2");
});

test("changes arriving during a write are included before saved resolves", async () => {
  let value = 1;
  let release!: () => void;
  const writes: string[] = [];
  const writer = new CoalescedWriter({ getItem: async () => null, setItem: async (_key, data) => {
    writes.push(data);
    if (writes.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  } }, "test", () => value);
  writer.save();
  await new Promise((resolve) => setImmediate(resolve));
  value = 2;
  writer.save();
  release();
  await writer.saved();
  assert.deepEqual(writes, ["1", "2"]);
});

test("a one-cent equal split retains zero balances and conserves the rounded total", () => {
  const e = expense({ amount: 0.01 });
  assert.deepEqual(computeShares(e), { a: 0.01, b: 0 });
  const ledger = new Ledger(trip({ expenses: [e] }));
  assert.equal(ledger.totalSpent, 0.01);
  assert.equal(ledger.balanceOf("b").owed, 0);
  assert.equal(ledger.balances().reduce((sum, balance) => sum + balance.net, 0), 0);
});

test("unassigned members retain zero shares in itemized and converted totals", () => {
  const e = expense({ receipt: { merchant: null, merchantTranslated: null, language: "English", notes: null,
    items: [{ name: "Meal", translatedName: null, quantity: 1, price: 10 }] },
    split: { type: "items", memberIds: ["a", "b"], assignments: { 0: ["a"] } }, rateToBase: 1.25 });
  const result = computeItemizedBreakdown({ ...e, baseCurrency: "USD" });
  assert.deepEqual(result.map((row) => row.totalShareBase), [12.5, 0]);
  assert.equal(new Ledger(trip({ expenses: [e] })).balanceOf("b").owed, 0);
});

test("shared discount lines allocate without losing a cent", () => {
  const e = expense({ amount: 9, receipt: { merchant: null, merchantTranslated: null, language: "English", notes: null,
    items: [{ name: "Meal", translatedName: null, quantity: 1, price: 10 }, { name: "Discount", translatedName: null, quantity: 1, price: -1 }] },
    split: { type: "items", memberIds: ["a", "b"], assignments: {} } });
  assert.deepEqual(computeShares(e), { a: 4.5, b: 4.5 });
  assert.equal(new Ledger(trip({ expenses: [e] })).totalSpent, 9);
});

test("damaged expenses stay identified and totals remain unavailable", () => {
  const bad = expense({ rateToBase: undefined as unknown as number });
  const result = inspectLedger(trip({ expenses: [expense({ id: "good" }), bad] }));
  assert.equal(result.ledger, undefined);
  assert.deepEqual(result.invalid.map((e) => e.id), ["expense"]);
  assert.throws(() => new Ledger(trip({ expenses: [bad] })), /Invalid expense/);
});
