/**
 * Turn net balances into the fewest possible payments.
 *
 * Example: if A owes B 20 and B owes C 20, the result is simply
 * "A pays C 20" because B nets to zero.
 *
 * The remaining task is to split the remaining balances into the smallest
 * number of zero-sum groups. We track everything in minor units, so the math
 * stays exact.
 */

export interface NetBalance {
  memberId: string;
  /** Positive means the member is owed money. Negative means they owe money. */
  minor: number;
}

export interface MinorTransfer {
  from: string;
  to: string;
  minor: number;
}

export interface SettlementOptimizer {
  readonly name: string;
  settle(balances: readonly NetBalance[]): MinorTransfer[];
}

/**
 * Fast and simple: pay the largest debts against the largest credits.
 * This is quick, but it may miss a few zero-sum subgroups.
 */
export class GreedySettlementOptimizer implements SettlementOptimizer {
  readonly name = "greedy";

  settle(balances: readonly NetBalance[]): MinorTransfer[] {
    // Keep member order stable so the same trip produces the same plan on every device.
    const debtors = balances
      .filter((b) => b.minor < 0)
      .map((b) => ({ id: b.memberId, left: -b.minor }))
      .sort((a, b) => b.left - a.left);
    const creditors = balances
      .filter((b) => b.minor > 0)
      .map((b) => ({ id: b.memberId, left: b.minor }))
      .sort((a, b) => b.left - a.left);

    const transfers: MinorTransfer[] = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(debtors[i].left, creditors[j].left);
      transfers.push({ from: debtors[i].id, to: creditors[j].id, minor: pay });
      debtors[i].left -= pay;
      creditors[j].left -= pay;
      if (debtors[i].left === 0) i++;
      if (creditors[j].left === 0) j++;
    }
    return transfers;
  }
}

/**
 * Finds the smallest possible number of payments.
 *
 * This groups balances into the most zero-sum subgroups, then settles each
 * subgroup with the fewest payments it can use. For larger groups, it falls
 * back to the greedy approach.
 */
export class OptimalSettlementOptimizer implements SettlementOptimizer {
  readonly name = "optimal";

  constructor(
    private readonly maxPeople = 16,
    private readonly fallback: SettlementOptimizer = new GreedySettlementOptimizer(),
    private readonly withinGroup: SettlementOptimizer = new GreedySettlementOptimizer(),
  ) {}

  settle(balances: readonly NetBalance[]): MinorTransfer[] {
    const open = balances.filter((b) => b.minor !== 0);
    if (open.length > this.maxPeople) return this.fallback.settle(open);
    // A subgroup that cannot be split further is already optimal.
    return this.zeroSumGroups(open).flatMap((group) => this.withinGroup.settle(group));
  }

  /** Split the opening balances into the biggest possible zero-sum groups. */
  private zeroSumGroups(open: readonly NetBalance[]): NetBalance[][] {
    const n = open.length;
    if (n === 0) return [];
    const size = 1 << n;
    const full = size - 1;

    // sum[mask]: total balance in the members inside this mask.
    // best[mask]: the most zero-sum groups we can form from this mask.
    const sum = new Float64Array(size);
    const best = new Uint8Array(size);
    for (let mask = 1; mask < size; mask++) {
      const low = mask & -mask;
      sum[mask] = sum[mask ^ low] + open[31 - Math.clz32(low)].minor;
      let most = 0;
      for (let rest = mask; rest; rest &= rest - 1) {
        const v = best[mask ^ (rest & -rest)];
        if (v > most) most = v;
      }
      best[mask] = most + (sum[mask] === 0 ? 1 : 0);
    }

    // Walk backward from the full set and collect each zero-sum group.
    const groups: NetBalance[][] = [];
    let current: NetBalance[] = [];
    let mask = full;
    while (mask) {
      const target = best[mask] - (sum[mask] === 0 ? 1 : 0);
      let bit = 0;
      for (let rest = mask; rest; rest &= rest - 1) {
        if (best[mask ^ (rest & -rest)] === target) {
          bit = rest & -rest;
          break;
        }
      }
      current.push(open[31 - Math.clz32(bit)]);
      mask ^= bit;
      if (sum[mask] === 0) {
        groups.push(current);
        current = [];
      }
    }
    // Restore the original member order so output is stable.
    const order = new Map(open.map((b, i) => [b, i]));
    for (const g of groups) g.sort((a, b) => order.get(a)! - order.get(b)!);
    return groups.sort((a, b) => order.get(a[0])! - order.get(b[0])!);
  }
}
