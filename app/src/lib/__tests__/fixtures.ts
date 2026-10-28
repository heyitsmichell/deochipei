import type { Expense, Trip } from "../types";
export const expense = (patch: Partial<Expense> = {}): Expense => ({
  id: "expense", description: "Dinner", category: "food", amount: 10, currency: "USD",
  rateToBase: 1, paidBy: "a", createdBy: "owner", date: "2026-10-28",
  split: { type: "equal", memberIds: ["a", "b"] }, createdAt: 1, updatedAt: 1, ...patch,
});
export const trip = (patch: Partial<Trip> = {}): Trip => ({
  id: "trip", code: "ABCDEF1234", name: "Synthetic trip", baseCurrency: "USD",
  members: [{ id: "a", name: "Alice", userId: "owner" }, { id: "b", name: "Bob", userId: "member" }],
  expenses: [expense()], deletedExpenseIds: [], updatedAt: 1, ownerId: "owner", syncEnabled: true, revision: 1, ...patch,
});
