import type { Expense, Member, Settlement, Trip, TripPatch } from "../lib/types";

export type { TripPatch } from "../lib/types";

/** A change made on this device that the server hasn't confirmed yet. */
export type OpMeta = { attempts?: number; retryAt?: number; recovered?: boolean };
export type Op =
  | ({ kind: "createTrip"; tripId: string } & OpMeta)
  | ({ kind: "patchTrip"; tripId: string; patch: TripPatch } & OpMeta)
  | ({ kind: "upsertMember"; tripId: string; member: Member } & OpMeta)
  | ({ kind: "upsertExpense"; tripId: string; expense: Expense } & OpMeta)
  | ({ kind: "deleteExpense"; tripId: string; expenseId: string } & OpMeta)
  | ({ kind: "upsertSettlement"; tripId: string; settlement: Settlement } & OpMeta)
  | ({ kind: "deleteSettlement"; tripId: string; settlementId: string } & OpMeta);

/**
 * Applies a queued change to a trip. Kept pure so an optimistic local view can
 * be rebuilt by replaying pending ops over a server copy.
 */
export function applyOp(trip: Trip, op: Op): Trip {
  switch (op.kind) {
    case "createTrip":
      return trip;
    case "patchTrip":
      return applyTripPatch(trip, op.patch);
    case "upsertMember":
      return { ...trip, members: upsertById(trip.members, op.member) };
    case "upsertExpense":
      return { ...trip, expenses: upsertById(trip.expenses, op.expense) };
    case "deleteExpense":
      return {
        ...trip,
        expenses: trip.expenses.filter((e) => e?.id !== op.expenseId),
        deletedExpenseIds: trip.deletedExpenseIds.includes(op.expenseId)
          ? trip.deletedExpenseIds
          : [...trip.deletedExpenseIds, op.expenseId],
      };
    case "upsertSettlement":
      return { ...trip, settlements: upsertById(trip.settlements ?? [], op.settlement) };
    case "deleteSettlement":
      return {
        ...trip,
        settlements: (trip.settlements ?? []).filter((settlement) => settlement?.id !== op.settlementId),
        deletedSettlementIds: (trip.deletedSettlementIds ?? []).includes(op.settlementId)
          ? trip.deletedSettlementIds
          : [...(trip.deletedSettlementIds ?? []), op.settlementId],
      };
  }
}

function applyTripPatch(trip: Trip, patch: TripPatch): Trip {
  const { budget, ...rest } = patch;
  const next = { ...trip, ...rest };
  if (budget === null) delete next.budget;
  else if (budget !== undefined) next.budget = budget;
  return next;
}

export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {  const i = list.findIndex((x) => x?.id === item.id);
  return i === -1 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}
