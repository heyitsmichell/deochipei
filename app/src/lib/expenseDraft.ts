import type { Category, Expense, ReceiptData, Split } from "./types";

/**
 * Builds the expense that will be saved. An edit keeps the original creator,
 * creation time and version, so the server can detect a conflicting edit; a
 * queued offline receipt keeps the day its photo was taken.
 */
export function createExpenseRecord(params: {
  id: string;
  existing?: Expense;
  queued?: { id: string; capturedAt: number };
  description: string;
  category: Category;
  amount: number;
  currency: string;
  rateToBase: number;
  paidBy: string;
  date: string;
  split: Split;
  receipt?: ReceiptData;
  rateSource?: string;
  rateFetchedAt?: number;
  now?: number;
}): Expense {
  const now = params.now ?? Date.now();
  return {
    id: params.id,
    description: params.description.trim(),
    category: params.category,
    amount: params.amount,
    currency: params.currency,
    rateToBase: params.rateToBase,
    paidBy: params.paidBy,
    date: params.date,
    split: params.split,
    receipt: params.receipt,
    rateSource: params.rateSource,
    rateFetchedAt: params.rateFetchedAt,
    ...(params.existing?.createdBy ? { createdBy: params.existing.createdBy } : {}),
    // The version this edit started from; the server refuses the save if someone changed it since.
    ...(params.existing?.revision != null ? { revision: params.existing.revision } : {}),
    createdAt: params.existing?.createdAt ?? params.queued?.capturedAt ?? now,
    updatedAt: now,
  };
}
