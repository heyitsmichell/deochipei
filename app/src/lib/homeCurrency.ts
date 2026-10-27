import { formatMoney, fromMinor, toMinor } from "./money";
import type { Trip } from "./types";

/**
 * The currency someone wants to read a trip in: this device's home currency,
 * else the one their member record carries (set from another phone), else the
 * trip's own currency.
 */
export function resolveHomeCurrency(trip: Trip, memberId: string | undefined, deviceHome: string | undefined) {
  const member = memberId ? trip.members.find((m) => m.id === memberId) : undefined;
  return deviceHome ?? member?.homeCurrency ?? trip.baseCurrency;
}

/**
 * One person's view of a trip's figures. The Ledger always works in the trip
 * currency, so everyone settles the same debts; this only translates what is
 * shown. A single rate is used for every amount, which keeps the translated
 * balances consistent with each other and with the settle-up plan.
 */
export class HomeCurrencyView {
  constructor(
    readonly tripCurrency: string,
    readonly home: string,
    /** Units of `home` per 1 `tripCurrency`; null while unknown (offline, never fetched). */
    readonly rate: number | null,
  ) {}

  /** True when amounts are shown in a currency other than the trip's. */
  get translated() {
    return this.home !== this.tripCurrency && this.rate != null;
  }

  /** The currency `convert` returns: home when there's a rate, otherwise the trip's. */
  get currency() {
    return this.translated ? this.home : this.tripCurrency;
  }

  /** An amount in the trip currency, in `currency`, rounded to its smallest unit. */
  convert(tripAmount: number) {
    if (!this.translated) return tripAmount;
    return fromMinor(toMinor(tripAmount * this.rate!, this.home), this.home);
  }

  /** The converted amount, plus the trip-currency original when they differ. */
  format(tripAmount: number): { main: string; original?: string } {
    return {
      main: formatMoney(this.convert(tripAmount), this.currency),
      original: this.translated ? formatMoney(tripAmount, this.tripCurrency) : undefined,
    };
  }
}
