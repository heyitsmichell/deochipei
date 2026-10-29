import assert from "node:assert/strict";
import { test } from "node:test";
import { tripInsights } from "../insights";
import { expense, trip } from "./fixtures";

test("spending is grouped by category with locked rates and shares", () => {
  const insights = tripInsights(trip({
    expenses: [
      expense({ id: "1", category: "food", amount: 30 }),
      expense({ id: "2", category: "food", amount: 10, currency: "EUR", rateToBase: 1.5 }),
      expense({ id: "3", category: "transport", amount: 60 }),
    ],
  }));

  assert.equal(insights.total, 105);
  assert.deepEqual(
    insights.categories.map((entry) => [entry.category, entry.amount]),
    [["transport", 60], ["food", 45]],
  );
  assert.equal(insights.categories[0].share, 60 / 105);
  assert.equal(insights.spendingDays, 1);
  assert.equal(insights.averagePerSpendingDay, 105);
  assert.deepEqual(insights.largest, { description: "Dinner", amount: 60 });
});

test("average uses distinct days, not the calendar span", () => {
  const insights = tripInsights(trip({
    expenses: [
      expense({ id: "1", date: "2026-10-01", amount: 10 }),
      expense({ id: "2", date: "2026-10-01", amount: 20 }),
      expense({ id: "3", date: "2026-10-20", amount: 30 }),
    ],
  }));
  assert.equal(insights.spendingDays, 2);
  assert.equal(insights.averagePerSpendingDay, 30);
});

test("payments never count as spending", () => {
  const insights = tripInsights(trip({
    expenses: [expense({ amount: 10 })],
    settlements: [{
      id: "pay", from: "b", to: "a", amount: 10, currency: "USD",
      date: "2026-10-28", createdAt: 1, updatedAt: 1,
    }],
  }));
  assert.equal(insights.total, 10);
});

test("an empty trip has no categories and no average", () => {
  const insights = tripInsights(trip({ expenses: [] }));
  assert.deepEqual(insights.categories, []);
  assert.equal(insights.total, 0);
  assert.equal(insights.averagePerSpendingDay, 0);
  assert.equal(insights.largest, undefined);
});
