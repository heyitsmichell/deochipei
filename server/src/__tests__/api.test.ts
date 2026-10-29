import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ExpenseSchema } from "../expense.js";
import { ReceiptSchema } from "../receipt.js";

const expense = { id: "expense", description: "Dinner", category: "food", amount: 10, currency: "USD", rateToBase: 1,
  paidBy: "a", date: "2026-10-28", split: { type: "equal", memberIds: ["a", "b"] }, createdAt: 1, updatedAt: 1 };

test("expense validation requires a complete, finite accounting record", () => {
  assert.equal(ExpenseSchema.safeParse(expense).success, true);
  for (const field of ["currency", "rateToBase", "paidBy", "date", "split", "createdAt"]) {
    const candidate: Record<string, unknown> = { ...expense };
    delete candidate[field];
    assert.equal(ExpenseSchema.safeParse(candidate).success, false, field);
  }
  for (const patch of [{ rateToBase: 0 }, { amount: Infinity }, { date: "2026-02-30" },
    { split: { type: "equal" } }, { split: { type: "items", memberIds: ["a"], assignments: { 0: "a" } } }]) {
    assert.equal(ExpenseSchema.safeParse({ ...expense, ...patch }).success, false);
  }
});

test("unusable model quantities default to one without changing line totals", () => {
  for (const quantity of [undefined, null, "", " ", 0, -1, "bad", Infinity, "Infinity", true, {}, [], "2", 3]) {
    const scan = ReceiptSchema.parse({ is_receipt: true, currency: "USD", total: 10, items: [{ name: "Item", total_price: 10, quantity }] });
    assert.equal(scan.items[0].quantity, quantity === "2" ? 2 : quantity === 3 ? 3 : 1);
    assert.equal(scan.items[0].total_price, 10);
  }
});

test("item splits require receipt items and canonical indexes within that receipt", () => {
  const receipt = { merchant: null, merchantTranslated: null, language: "English", notes: null,
    items: [{ name: "Meal", translatedName: null, quantity: 1, price: 10 }] };
  const itemExpense = { ...expense, receipt, split: { type: "items", memberIds: ["a", "b"], assignments: { 0: ["a"] } } };
  assert.equal(ExpenseSchema.safeParse(itemExpense).success, true);
  assert.equal(ExpenseSchema.safeParse({ ...itemExpense, receipt: undefined }).success, false);
  assert.equal(ExpenseSchema.safeParse({ ...itemExpense, receipt: { ...receipt, items: [] } }).success, false);
  for (const index of ["1", "-1", "0.5", "00", "9007199254740992"]) {
    assert.equal(ExpenseSchema.safeParse({ ...itemExpense, split: { ...itemExpense.split, assignments: { [index]: ["a"] } } }).success, false, index);
  }
  assert.equal(ExpenseSchema.safeParse({ ...itemExpense, split: { ...itemExpense.split, assignments: {} } }).success, true);
  assert.equal(ExpenseSchema.safeParse({ ...expense, receipt: { ...receipt, items: [] } }).success, true);
  assert.equal(ExpenseSchema.safeParse({ ...itemExpense, receipt: { ...receipt, items: [{ ...receipt.items[0], quantity: 0 }] } }).success, false);
});

test("API rejects malformed writes, permits polling preflight, and protects invite previews", async () => {
  const cwd = process.cwd();
  const scratch = await mkdtemp(join(tmpdir(), "deochipei-api-test-"));
  process.chdir(scratch);
  process.env.NODE_ENV = "test";
  process.env.SUPABASE_URL = "https://synthetic.invalid";
  process.env.SUPABASE_ANON_KEY = "synthetic-test-key";
  const { setSupabaseClientForTesting } = await import("../auth.js");
  setSupabaseClientForTesting({ auth: { getUser: async (token: string) => ({ data: { user: { id: token!, email: `${token}@example.invalid` } }, error: null }) } });
  const { app, store, rateLimiter, resetRateLimits } = await import("../index.js");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, body?: unknown, method = "POST", user = "owner") => {
    const response = await fetch(url + path, { method,
      headers: { "content-type": "application/json", authorization: `Bearer ${user}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const create = await request("/api/trips", { id: "trip", name: "Synthetic", baseCurrency: "USD",
      members: [{ id: "a", name: "Alice", userId: "owner" }, { id: "b", name: "Bob", userId: "member" }, { id: "c", name: "Unclaimed" }], expenses: [], deletedExpenseIds: [], updatedAt: 1 });
    assert.equal(create.status, 200);
    const bad = await request("/api/trips/trip/expenses/bad", { amount: 1, updatedAt: 1 }, "PUT", "member");
    assert.equal(bad.status, 400);
    assert.deepEqual((await request("/api/trips/trip", undefined, "GET", "owner")).body.expenses, []);
    const valid = await request("/api/trips/trip/expenses/expense", expense, "PUT", "member");
    assert.equal(valid.status, 200);
    assert.equal(valid.body.expenses[0].createdBy, "member");
    // Edits echo the revision they started from; a stale one gets a 409 with the current copy.
    const saved = valid.body.expenses[0];
    assert.ok(saved.revision > 0);
    const mine = await request("/api/trips/trip/expenses/expense", { ...expense, description: "Mine", baseRevision: saved.revision }, "PUT", "member");
    assert.equal(mine.status, 200);
    const theirs = await request("/api/trips/trip/expenses/expense", { ...expense, description: "Theirs", baseRevision: saved.revision }, "PUT", "owner");
    assert.equal(theirs.status, 409);
    assert.equal(theirs.body.code, "expense_conflict");
    assert.equal(theirs.body.current.description, "Mine");
    // A client cannot forge the server's revision.
    const forged = await request("/api/trips/trip/expenses/expense", { ...expense, revision: 9999 }, "PUT", "member");
    assert.equal(forged.status, 200);
    assert.notEqual(forged.body.expenses[0].revision, 9999);
    const badBase = await request("/api/trips/trip/expenses/expense", { ...expense, baseRevision: "x" }, "PUT", "member");
    assert.equal(badBase.status, 400);
    const preflight = await fetch(url + "/api/trips/trip", { method: "OPTIONS", headers: {
      origin: "http://localhost:8081", "access-control-request-method": "GET", "access-control-request-headers": "authorization,content-type,if-none-match",
    } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers")!.toLowerCase(), /if-none-match/);
    const full = await request(`/api/join/${create.body.code}`, {});
    assert.equal(full.body.expenses.length, 1);
    assert.equal(full.body.members[0].userId, "owner");
    const preview = await request(`/api/join/${create.body.code}`, {}, "POST", "outsider");
    assert.equal(preview.body.preview, true);
    assert.equal(preview.body.ownerId, undefined);
    assert.equal(preview.body.members[0].userId, undefined);
    assert.deepEqual(preview.body.expenses, []);
    const denied = await request("/api/trips/trip/members/c", { name: "Unclaimed", userId: "member" }, "PUT", "member");
    assert.equal(denied.status, 403);
    const claim = await request(`/api/join/${create.body.code}`, { claimMemberId: "c" }, "POST", "outsider");
    assert.equal(claim.status, 200);
    assert.equal(claim.body.members.find((member: { id: string }) => member.id === "c").userId, "outsider");
    const reclaimed = await request(`/api/join/${create.body.code}`, { claimMemberId: "c" }, "POST", "another");
    assert.equal(reclaimed.status, 409);
    // Invite lookups are limited per client and answer 429 with Retry-After.
    resetRateLimits();
    for (let i = 0; i < 30; i++) assert.equal((await request("/api/join/NOSUCHCODE", undefined, "GET")).status, 404);
    const limited = await fetch(url + "/api/join/NOSUCHCODE", { headers: { authorization: "Bearer owner" } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rateLimiter.close();
    process.chdir(cwd);
    await rm(scratch, { recursive: true, force: true });
  }
});
