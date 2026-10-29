import assert from "node:assert/strict";
import { test } from "node:test";
import { createExpenseRecord } from "../expenseDraft";
import { expense } from "./fixtures";

const base = {
  description: "  Dinner  ",
  category: "food" as const,
  amount: 20,
  currency: "EUR",
  rateToBase: 1.1,
  paidBy: "a",
  date: "2026-10-29",
  split: { type: "equal" as const, memberIds: ["a", "b"] },
  rateSource: "ECB",
  rateFetchedAt: 123,
};

test("a queued offline receipt keeps the day its photo was taken", () => {
  const draft = createExpenseRecord({ ...base, id: "new", queued: { id: "q", capturedAt: 1_000 }, now: 2_000 });
  assert.equal(draft.description, "Dinner");
  assert.equal(draft.createdAt, 1_000);
  assert.equal(draft.updatedAt, 2_000);
  assert.equal(draft.revision, undefined);
  assert.equal(draft.rateSource, "ECB");
});

test("an edit keeps its creator, creation time and base revision", () => {
  const existing = expense({ id: "e", createdBy: "owner", createdAt: 50, revision: 4 });
  const draft = createExpenseRecord({ ...base, id: "e", existing, now: 2_000 });
  assert.equal(draft.createdBy, "owner");
  assert.equal(draft.createdAt, 50);
  assert.equal(draft.revision, 4);
  assert.equal(draft.updatedAt, 2_000);
});
