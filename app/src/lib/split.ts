import { allocate, fromMinor, toMinor } from "./money";
import type { Expense, ReceiptData, ReceiptItem } from "./types";

export type Splittable = Pick<Expense, "amount" | "paidBy" | "split"> & {
  currency?: string;
  receipt?: ReceiptData;
};

interface AllocatedItemEntry {
  itemIndex: number;
  item: ReceiptItem;
  shareMinor: number;
  sharedCount: number;
  isUnassigned: boolean;
}

function allocateItemShares(
  items: ReceiptItem[],
  assignments: Record<number, string[]> = {},
  people: string[],
  currency?: string,
): {
  memberItemShares: Map<string, AllocatedItemEntry[]>;
  memberMinorSubtotals: Map<string, number>;
  itemsMinorTotal: number;
} {
  const memberItemShares = new Map<string, AllocatedItemEntry[]>();
  const memberMinorSubtotals = new Map<string, number>();
  for (const id of people) {
    memberItemShares.set(id, []);
    memberMinorSubtotals.set(id, 0);
  }

  let itemsMinorTotal = 0;
  items.forEach((item, i) => {
    const rawList = Array.isArray(assignments?.[i]) ? assignments[i] : [];
    const rawClaimed = rawList.filter((id) => typeof id === "string" && people.includes(id));
    const claimed = [...new Set(rawClaimed)];
    const isUnassigned = claimed.length === 0;
    const owners = isUnassigned ? people : claimed;
    const itemMinor = toMinor(item.price, currency);
    itemsMinorTotal += itemMinor;

    if (owners.length === 0) return;

    let alloc: Map<string, number>;
    if (owners.length === 1) {
      alloc = new Map([[owners[0], itemMinor]]);
    } else {
      const shift = i % owners.length;
      const rotated = [...owners.slice(shift), ...owners.slice(0, shift)];
      alloc = new Map([...allocate(Math.abs(itemMinor), new Map(rotated.map((id) => [id, 1])))].map(
        ([id, share]) => [id, itemMinor < 0 ? -share : share],
      ));
    }

    for (const [id, minor] of alloc) {
      memberMinorSubtotals.set(id, (memberMinorSubtotals.get(id) ?? 0) + minor);
      const list = memberItemShares.get(id) ?? [];
      list.push({
        itemIndex: i,
        item,
        shareMinor: minor,
        sharedCount: owners.length,
        isUnassigned,
      });
      memberItemShares.set(id, list);
    }
  });

  return { memberItemShares, memberMinorSubtotals, itemsMinorTotal };
}

/** Each member's share of an expense, in the expense's own currency. */
export function computeShares(expense: Splittable): Record<string, number> {
  const { split, amount, currency } = expense;
  const people = [...new Set(split.memberIds.length ? split.memberIds : [expense.paidBy])];
  const items = expense.receipt?.items ?? [];

  if (people.length === 0) return {};
  if (split.type === "equal") return evenly(amount, people, currency);

  if (split.type === "shares") {
    const weights = new Map<string, number>();
    for (const id of people) {
      const weight = split.weights[id];
      if (Number.isFinite(weight) && weight > 0) weights.set(id, weight);
    }
    if (weights.size === 0) return evenly(amount, people, currency);
    const allocated = allocate(toMinor(amount, currency), weights);
    const result: Record<string, number> = {};
    for (const id of people) result[id] = fromMinor(allocated.get(id) ?? 0, currency);
    return result;
  }

  // An itemized expense without readable items has nothing to allocate by.
  if (items.length === 0) return evenly(amount, people, currency);

  const assignments = split.assignments ? split.assignments : {};
  const { memberMinorSubtotals, itemsMinorTotal } = allocateItemShares(
    items,
    assignments,
    people,
    currency,
  );

  if (itemsMinorTotal <= 0) return evenly(amount, people, currency);

  const activeEntries = [...memberMinorSubtotals.entries()].filter(([, val]) => val > 0);
  if (activeEntries.length === 0) return evenly(amount, people, currency);

  // Distribute the exact bill amount in minor units proportionally to each member's personal item subtotal
  const weights = new Map(activeEntries);
  const totalMinor = toMinor(amount, currency);
  const allocated = allocate(totalMinor, weights);

  const result: Record<string, number> = {};
  for (const id of people) {
    const minor = allocated.get(id);
    result[id] = minor != null ? fromMinor(minor, currency) : 0;
  }
  return result;
}

function evenly(amount: number, people: string[], currency?: string): Record<string, number> {
  if (people.length === 0) return {};
  const weights = new Map(people.map((id) => [id, 1]));
  const totalMinor = toMinor(amount, currency);
  const allocated = allocate(totalMinor, weights);
  const result: Record<string, number> = {};
  for (const id of people) {
    result[id] = fromMinor(allocated.get(id) ?? 0, currency);
  }
  return result;
}

export interface MemberItemShare {
  itemIndex: number;
  name: string;
  translatedName: string;
  quantity: number;
  itemPrice: number;
  sharePrice: number;
  sharedCount: number;
  isShared: boolean;
  isUnassigned: boolean;
}

export interface MemberBreakdown {
  memberId: string;
  items: MemberItemShare[];
  itemSubtotal: number;
  taxAndTipShare: number;
  totalShare: number;
  totalShareBase: number;
}

export function computeItemizedBreakdown(
  expense: Splittable & { rateToBase?: number; baseCurrency?: string },
): MemberBreakdown[] {
  const { split, currency } = expense;
  const people = [...new Set(split.memberIds.length ? split.memberIds : [expense.paidBy])];
  const items = expense.receipt?.items ?? [];
  const shares = computeShares(expense);
  const rate = expense.rateToBase ?? 1;

  const assignments = split.type === "items" && split.assignments ? split.assignments : {};
  const { memberItemShares, memberMinorSubtotals } = allocateItemShares(
    items,
    assignments,
    people,
    currency,
  );

  const totalBaseMinor = toMinor(expense.amount * rate, expense.baseCurrency);
  const activeWeights = shareWeights(shares);
  const baseAllocated = allocate(totalBaseMinor, activeWeights);

  return people.map((id) => {
    const rawItems = memberItemShares.get(id) ?? [];
    const memberItems: MemberItemShare[] = rawItems.map((entry) => ({
      itemIndex: entry.itemIndex,
      name: entry.item.name,
      translatedName: entry.item.translatedName || entry.item.name,
      quantity: entry.item.quantity,
      itemPrice: entry.item.price,
      sharePrice: fromMinor(entry.shareMinor, currency),
      sharedCount: entry.sharedCount,
      isShared: entry.sharedCount > 1,
      isUnassigned: entry.isUnassigned,
    }));

    const memberSubtotalMinor = memberMinorSubtotals.get(id) ?? 0;
    const itemSubtotal = fromMinor(memberSubtotalMinor, currency);
    const totalShare = shares[id] ?? 0;
    const taxAndTipShare =
      fromMinor(toMinor(totalShare, currency) - memberSubtotalMinor, currency) || 0;

    const totalShareBase = fromMinor(baseAllocated.get(id) ?? 0, expense.baseCurrency);

    return {
      memberId: id,
      items: memberItems,
      itemSubtotal,
      taxAndTipShare,
      totalShare,
      totalShareBase,
    };
  });
}

/** Zero shares remain visible in the UI, but are not allocator weights. */
export function shareWeights(shares: Record<string, number>): Map<string, number> {
  const entries = Object.entries(shares);
  const positive = entries.filter(([, value]) => value > 0);
  // A tiny source amount may round to zero before conversion to the base currency.
  return new Map(positive.length ? positive : entries.map(([id]) => [id, 1]));
}
