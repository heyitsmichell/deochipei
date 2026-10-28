import { allocate, fromMinor, toMinor } from "./money";
import {
  OptimalSettlementOptimizer,
  type MinorTransfer,
  type NetBalance,
  type SettlementOptimizer,
} from "./settlement";
import { computeShares } from "./split";
import type { Expense, Trip } from "./types";

export interface Balance {
  memberId: string;
  paid: number;
  owed: number;
  /** Positive: is owed money. Negative: owes money. */
  net: number;
}

export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

export interface SettlementPlan {
  /** The fewest payments that settle everyone. */
  transfers: Transfer[];
  /** Who owes whom straight from the expenses (opposite debts netted per pair). */
  direct: Transfer[];
  /** How many payments the optimized plan saves over `direct`. */
  saved: number;
}

/** An expense's value in the trip's base currency, for display. */
export function baseAmount(e: Expense) {
  return e.amount * e.rateToBase;
}

const defaultOptimizer = new OptimalSettlementOptimizer();

/**
 * Read-only accounting view of a trip. Everything is computed once in the
 * constructor (or lazily, for the settlement plan) in integer minor units of
 * the base currency, so balances always sum to exactly zero. Build a new
 * Ledger when the trip changes; in React, `useMemo(() => new Ledger(trip), [trip])`.
 */
export class Ledger {
  readonly currency: string;
  private readonly memberIds: string[];
  private readonly known: Set<string>;
  private readonly paid = new Map<string, number>();
  private readonly owed = new Map<string, number>();
  /** debtor → creditor → amount, in minor units. */
  private readonly debts = new Map<string, Map<string, number>>();
  private plan?: SettlementPlan;

  constructor(
    trip: Trip,
    private readonly optimizer: SettlementOptimizer = defaultOptimizer,
  ) {
    this.currency = trip.baseCurrency;
    this.memberIds = trip.members.map((m) => m.id);
    this.known = new Set(this.memberIds);
    for (const e of trip.expenses) this.record(e);
  }

  get totalSpent(): number {
    let total = 0;
    for (const v of this.paid.values()) total += v;
    return this.major(total);
  }

  balances(): Balance[] {
    return this.memberIds.map((id) => this.balanceOf(id));
  }

  balanceOf(memberId: string): Balance {
    const paid = this.paid.get(memberId) ?? 0;
    const owed = this.owed.get(memberId) ?? 0;
    return {
      memberId,
      paid: this.major(paid),
      owed: this.major(owed),
      net: this.major(paid - owed),
    };
  }

  settlementPlan(): SettlementPlan {
    if (!this.plan) {
      const transfers = this.optimizer.settle(this.netBalances()).map(this.toTransfer);
      const direct = this.directDebts();
      this.plan = { transfers, direct, saved: Math.max(0, direct.length - transfers.length) };
    }
    return this.plan;
  }

  private record(e: Expense) {
    const total = toMinor(baseAmount(e), this.currency);
    const weights = new Map(Object.entries(computeShares(e)));
    // Split the rounded total itself, so the shares always add up to what was paid.
    const shares = weights.size ? allocate(total, weights) : new Map([[e.paidBy, total]]);

    this.track(e.paidBy);
    this.paid.set(e.paidBy, (this.paid.get(e.paidBy) ?? 0) + total);
    for (const [id, share] of shares) {
      this.track(id);
      this.owed.set(id, (this.owed.get(id) ?? 0) + share);
      if (id !== e.paidBy) this.addDebt(id, e.paidBy, share);
    }
  }

  /** Expenses can reference someone whose member record hasn't synced yet. */
  private track(memberId: string) {
    if (this.known.has(memberId)) return;
    this.known.add(memberId);
    this.memberIds.push(memberId);
  }

  private addDebt(from: string, to: string, minor: number) {
    // Net against what `to` already owes `from`, keeping one direction per pair.
    const reverse = this.debt(to, from);
    const offset = Math.min(reverse, minor);
    this.setDebt(to, from, reverse - offset);
    this.setDebt(from, to, this.debt(from, to) + minor - offset);
  }

  private debt(from: string, to: string) {
    return this.debts.get(from)?.get(to) ?? 0;
  }

  private setDebt(from: string, to: string, minor: number) {
    let row = this.debts.get(from);
    if (!row) this.debts.set(from, (row = new Map()));
    if (minor === 0) row.delete(to);
    else row.set(to, minor);
  }

  private netBalances(): NetBalance[] {
    return this.memberIds.map((memberId) => ({
      memberId,
      minor: (this.paid.get(memberId) ?? 0) - (this.owed.get(memberId) ?? 0),
    }));
  }

  private directDebts(): Transfer[] {
    const out: Transfer[] = [];
    for (const from of this.memberIds) {
      for (const to of this.memberIds) {
        const minor = this.debt(from, to);
        if (minor > 0) out.push(this.toTransfer({ from, to, minor }));
      }
    }
    return out;
  }

  private major(minor: number) {
    return fromMinor(minor, this.currency);
  }

  private toTransfer = (t: MinorTransfer): Transfer => ({
    from: t.from,
    to: t.to,
    amount: this.major(t.minor),
  });
}
