import { z } from "zod";

const currency = z.string().regex(/^[A-Z]{3}$/);
const ids = z.array(z.string().min(1));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");

/** Validate the complete accounting record before it can enter a shared trip. */
export const ExpenseSchema = z.looseObject({
  id: z.string().min(1),
  description: z.string(),
  category: z.enum(["food", "transport", "lodging", "activities", "shopping", "groceries", "other"]),
  amount: z.number().finite().positive(),
  currency,
  rateToBase: z.number().finite().positive(),
  paidBy: z.string().min(1),
  date,
  split: z.discriminatedUnion("type", [
    z.object({ type: z.literal("equal"), memberIds: ids }),
    z.object({ type: z.literal("items"), memberIds: ids, assignments: z.record(z.string().regex(/^(0|[1-9]\d*)$/), z.array(z.string().min(1))) }),
    z.object({ type: z.literal("shares"), memberIds: ids, weights: z.record(z.string().min(1), z.number().finite().positive()) }),
  ]),
  receipt: z.object({
    merchant: z.string().nullable(), merchantTranslated: z.string().nullable(),
    language: z.string(), notes: z.string().nullable(),
    receiptNumber: z.string().nullable().optional(), time: z.string().nullable().optional(),
    items: z.array(z.object({ name: z.string(), translatedName: z.string().nullable(), quantity: z.number().finite().positive(), price: z.number().finite() })),
    tax: z.number().finite().nullable().optional(), tip: z.number().finite().nullable().optional(), serviceCharge: z.number().finite().nullable().optional(),
  }).optional(),
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
  revision: z.number().int().nonnegative().optional(),
}).superRefine((expense, ctx) => {
  if (expense.split.type !== "items") return;
  const items = expense.receipt?.items;
  if (!items?.length) {
    ctx.addIssue({ code: "custom", path: ["receipt", "items"], message: "Item splits require receipt items" });
    return;
  }
  for (const index of Object.keys(expense.split.assignments)) {
    if (!Number.isSafeInteger(Number(index)) || Number(index) >= items.length) {
      ctx.addIssue({ code: "custom", path: ["split", "assignments", index], message: "Assignment must reference a receipt item" });
    }
  }
});

/** A payment between two members. Amounts are always in the trip's base currency. */
export const SettlementSchema = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  amount: z.number().finite().positive(),
  currency,
  date,
  method: z.string().max(40).optional(),
  note: z.string().max(500).optional(),
  createdBy: z.string().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  revision: z.number().int().nonnegative().optional(),
}).superRefine((settlement, ctx) => {
  if (settlement.from === settlement.to) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "A payment needs two different people" });
  }
});
