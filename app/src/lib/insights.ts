import { fromMinor, toMinor } from "./money";
import { CATEGORIES, type Category, type Trip } from "./types";

export interface CategorySpend {
  category: Category;
  label: string;
  icon: string;
  /** Amount in the trip's base currency. */
  amount: number;
  /** Fraction of all spending, between 0 and 1. */
  share: number;
}

export interface TripInsights {
  /** Total spending in the trip's base currency, excluding payments. */
  total: number;
  categories: CategorySpend[];
  /** Number of calendar days on which at least one expense was recorded. */
  spendingDays: number;
  averagePerSpendingDay: number;
  largest?: { description: string; amount: number };
}

/** Converts an expense to whole minor units of the trip's base currency. */
function baseMinor(amount: number, rateToBase: number, baseCurrency: string): number {
  return toMinor(amount * rateToBase, baseCurrency);
}

/**
 * Spending totals by category, for a chart and a budget bar. Expenses are
 * converted with the rate locked in when they were recorded, so the totals do
 * not drift as today's exchange rate moves. Payments (settlements) are not
 * spending and are deliberately excluded.
 */
export function tripInsights(trip: Trip): TripInsights {
  const byCategory = new Map<Category, number>();
  const days = new Set<string>();
  let totalMinor = 0;
  let largestMinor = 0;
  let largestDescription = "";

  for (const expense of trip.expenses) {
    const minor = baseMinor(expense.amount, expense.rateToBase, trip.baseCurrency);
    totalMinor += minor;
    byCategory.set(expense.category, (byCategory.get(expense.category) ?? 0) + minor);
    if (expense.date) days.add(expense.date);
    if (minor > largestMinor) {
      largestMinor = minor;
      largestDescription = expense.description || "Expense";
    }
  }

  const categories = CATEGORIES
    .map(({ key, label, icon }) => {
      const minor = byCategory.get(key) ?? 0;
      return {
        category: key,
        label,
        icon,
        amount: fromMinor(minor, trip.baseCurrency),
        share: totalMinor > 0 ? minor / totalMinor : 0,
      };
    })
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const spendingDays = days.size;
  return {
    total: fromMinor(totalMinor, trip.baseCurrency),
    categories,
    spendingDays,
    averagePerSpendingDay:
      spendingDays > 0 ? fromMinor(Math.round(totalMinor / spendingDays), trip.baseCurrency) : 0,
    ...(largestMinor > 0
      ? { largest: { description: largestDescription, amount: fromMinor(largestMinor, trip.baseCurrency) } }
      : {}),
  };
}
