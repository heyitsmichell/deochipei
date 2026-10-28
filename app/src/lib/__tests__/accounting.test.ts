import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger, inspectLedger } from "../ledger";
import { computeItemizedBreakdown, computeShares } from "../split";
import { CoalescedWriter, MemoryStorage } from "../storage";
import { expense, trip } from "./fixtures";
import { normalizeReceiptQuantities, receiptItemsNeedRepair } from "../receiptScan";
import type { Expense, ReceiptData } from "../types";


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

test("null, primitive and id-less persisted expenses have safe repair descriptors", () => {
  const malformed = [null, "bad", 7, {}, expense({ id: undefined as unknown as string })];
  const result = inspectLedger(trip({ expenses: [expense(), ...malformed as Expense[]] }));
  assert.equal(result.ledger, undefined);
  assert.deepEqual(result.invalid.map((entry) => entry.index), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.invalid.map((entry) => entry.id), [undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(result.invalid.map((entry) => entry.value), malformed);
  assert.ok(result.invalid.every((entry) => typeof entry.description === "string"));
});

test("legacy receipt quantities normalize for editing without changing positive quantities or line totals", () => {
  const receipt = { merchant: null, merchantTranslated: null, language: "English", notes: null,
    items: [0, -2, NaN, Infinity, 0.5, 3].map((quantity, i) => ({ name: `Item ${i}`, translatedName: null, quantity, price: i === 1 ? -1 : 10 })) };
  const normalized = normalizeReceiptQuantities(receipt);
  assert.deepEqual(normalized.items.map((item) => item.quantity), [1, 1, 1, 1, 0.5, 3]);
  assert.deepEqual(normalized.items.map((item) => item.price), receipt.items.map((item) => item.price));
  assert.equal(receipt.items[0].quantity, 0);
});

test("metadata-only legacy receipts open with an empty item list and retain their metadata", () => {
  const receipt = { merchant: "Legacy shop", language: "English", notes: "Retained notes" } as ReceiptData;
  assert.equal(receiptItemsNeedRepair(receipt), false);
  assert.deepEqual(normalizeReceiptQuantities(receipt), { ...receipt, items: [] });
});

test("malformed receipt item lists require repair without discarding their original details", () => {
  for (const items of [{ meal: { name: "Dinner", quantity: 1, price: 12 } }, null, "Dinner", 12, false,
    [null], ["Dinner"], [12], [false], [[]], [{}], [{ name: "Dinner", price: "12" }],
    [{ name: "Dinner", price: 12, translatedName: { text: "Dinner" } }]]) {
    const receipt = { merchant: "Legacy shop", language: "English", notes: "Retained notes", items } as unknown as ReceiptData;
    const original = structuredClone(receipt);
    assert.equal(receiptItemsNeedRepair(receipt), true);
    assert.throws(() => normalizeReceiptQuantities(receipt), /need repair before editing/);
    assert.deepEqual(receipt, original);
  }
  const receipt = { merchant: null, merchantTranslated: null, language: "English", notes: null, items: [] };
  assert.equal(receiptItemsNeedRepair(receipt), false);
  assert.deepEqual(normalizeReceiptQuantities(receipt), receipt);
});
