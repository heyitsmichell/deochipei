import AsyncStorage from "@react-native-async-storage/async-storage";
import type { KeyValueStorage } from "./storage";

export interface RateTable {
  base: string;
  /** Units of each currency per 1 `base`. */
  rates: Record<string, number>;
  fetchedAt: number;
  source: string;
}

export interface RateProvider {
  readonly name: string;
  fetchRates(base: string): Promise<Record<string, number>>;
}

async function fetchJson(url: string, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 160+ currencies, no key required. */
export class ExchangeRateApiProvider implements RateProvider {
  readonly name = "ExchangeRate-API";

  async fetchRates(base: string) {
    const data = await fetchJson(`https://open.er-api.com/v6/latest/${base}`);
    if (data.result !== "success") throw new Error("rate provider error");
    return data.rates as Record<string, number>;
  }
}

/** European Central Bank reference rates (~30 currencies). */
export class FrankfurterProvider implements RateProvider {
  readonly name = "ECB via Frankfurter";

  async fetchRates(base: string) {
    const data = await fetchJson(`https://api.frankfurter.dev/v1/latest?base=${base}`);
    return { ...(data.rates as Record<string, number>), [base]: 1 };
  }
}

/**
 * Exchange rates with a memory + persistent cache. Tries providers in order,
 * serves stale data when offline, and shares one network request between
 * callers asking for the same base at the same time.
 */
export class RateService {
  private readonly memory = new Map<string, RateTable>();
  private readonly inFlight = new Map<string, Promise<RateTable>>();

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly providers: readonly RateProvider[],
    // Providers publish new rates every few minutes to once a day; refreshing
    // more often than this only burns the free quota.
    private readonly maxAgeMs = 10 * 60 * 1000,
    private readonly cachePrefix = "deochipei:rates:",
  ) {}

  async getTable(base: string, force = false): Promise<RateTable> {
    const cached = this.memory.get(base) ?? (await this.readCache(base));
    if (cached && !force && Date.now() - cached.fetchedAt < this.maxAgeMs) return cached;
    try {
      return await this.fetchShared(base);
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  }

  /** How many `to` you get for 1 `from`. */
  async getRate(from: string, to: string, force = false) {
    if (from === to) return { rate: 1, table: null };
    const table = await this.getTable(from, force);
    const rate = table.rates[to];
    if (!rate) throw new Error(`No rate for ${from} → ${to}`);
    return { rate, table };
  }

  private fetchShared(base: string) {
    let pending = this.inFlight.get(base);
    if (!pending) {
      pending = this.fetchFresh(base).finally(() => this.inFlight.delete(base));
      this.inFlight.set(base, pending);
    }
    return pending;
  }

  private async fetchFresh(base: string): Promise<RateTable> {
    let lastError: unknown = new Error("No rate providers configured");
    for (const provider of this.providers) {
      try {
        const table = {
          base,
          rates: await provider.fetchRates(base),
          fetchedAt: Date.now(),
          source: provider.name,
        };
        this.memory.set(base, table);
        this.storage.setItem(this.cachePrefix + base, JSON.stringify(table)).catch(() => {});
        return table;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async readCache(base: string): Promise<RateTable | undefined> {
    try {
      let raw = await this.storage.getItem(this.cachePrefix + base);
      if (!raw && this.cachePrefix === "deochipei:rates:") {
        const legacy = await this.storage.getItem("travelsplit:rates:" + base);
        if (legacy) {
          raw = legacy;
          await this.storage.setItem(this.cachePrefix + base, legacy);
          if (this.storage.removeItem) {
            await this.storage.removeItem("travelsplit:rates:" + base).catch(() => {});
          }
        }
      }
      if (!raw) return undefined;
      const table = JSON.parse(raw) as RateTable;
      this.memory.set(base, table);
      return table;
    } catch {
      return undefined;
    }
  }
}

export const rateService = new RateService(AsyncStorage, [
  new ExchangeRateApiProvider(),
  new FrankfurterProvider(),
]);

export function describeAge(ts: number) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
