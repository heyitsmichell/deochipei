import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("null, blank, and missing model quantities default to one; invalid quantities are rejected", () => {
  for (const quantity of [undefined, null, "", "2", 3]) {
    const scan = ReceiptSchema.parse({ is_receipt: true, currency: "USD", total: 10, items: [{ name: "Item", total_price: 10, quantity }] });
    assert.equal(scan.items[0].quantity, quantity === "2" ? 2 : quantity === 3 ? 3 : 1);
  }
  for (const quantity of [0, -1, "bad"]) {
    assert.equal(ReceiptSchema.safeParse({ is_receipt: true, currency: "USD", total: 10, items: [{ name: "Item", total_price: 10, quantity }] }).success, false);
  }
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
  const { app } = await import("../index.js");
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
    assert.deepEqual(JSON.parse(await readFile(join(scratch, "data/trips.json"), "utf8"))[0].expenses, []);
    const valid = await request("/api/trips/trip/expenses/expense", expense, "PUT", "member");
    assert.equal(valid.status, 200);
    assert.equal(valid.body.expenses[0].createdBy, "member");
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
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.chdir(cwd);
    await rm(scratch, { recursive: true, force: true });
  }
});
