import { useEffect, useMemo, useState } from "react";
import { HomeCurrencyView, resolveHomeCurrency } from "../lib/homeCurrency";
import { describeAge, rateService } from "../lib/rates";
import type { Trip } from "../lib/types";
import { useMe, useSettings } from "./TripsContext";

interface RateState {
  key: string;
  rate: number | null;
  /** "Live rate · ExchangeRate-API · updated 5 min ago", or why there's no rate. */
  info: string | null;
}

/**
 * How `trip` reads for the person using this phone: the Ledger's trip-currency
 * figures translated into their home currency at today's rate. Rates come
 * from the cached RateService, so this works offline once fetched.
 */
export function useHomeCurrency(trip: Trip) {
  const me = useMe(trip.id);
  const { homeCurrency } = useSettings();
  const home = resolveHomeCurrency(trip, me, homeCurrency);
  const from = trip.baseCurrency;
  const key = `${from}>${home}`;
  const [state, setState] = useState<RateState | null>(null);

  useEffect(() => {
    if (from === home) return;
    let cancelled = false;
    rateService
      .getRate(from, home)
      .then(({ rate, table }) => {
        const info = table ? `${table.source} · updated ${describeAge(table.fetchedAt)}` : null;
        if (!cancelled) setState({ key, rate, info });
      })
      .catch(() => {
        if (!cancelled) setState({ key, rate: null, info: `Couldn't load the ${from} → ${home} rate` });
      });
    return () => {
      cancelled = true;
    };
  }, [from, home, key]);

  // Ignore a rate left over from before the currencies changed.
  const current = from === home ? { key, rate: 1, info: null } : state?.key === key ? state : null;
  const view = useMemo(() => new HomeCurrencyView(from, home, current?.rate ?? null), [from, home, current?.rate]);
  return { view, home, rateInfo: current?.info ?? null };
}
