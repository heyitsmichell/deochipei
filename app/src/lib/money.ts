/** Pure currency helpers: formatting, parsing and integer minor-unit maths. */

export const CURRENCIES: { code: string; name: string }[] = [
  { code: "USD", name: "US Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "KRW", name: "South Korean Won" },
  { code: "TWD", name: "Taiwan Dollar" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "THB", name: "Thai Baht" },
  { code: "VND", name: "Vietnamese Dong" },
  { code: "MYR", name: "Malaysian Ringgit" },
  { code: "IDR", name: "Indonesian Rupiah" },
  { code: "PHP", name: "Philippine Peso" },
  { code: "INR", name: "Indian Rupee" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "NZD", name: "New Zealand Dollar" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "MXN", name: "Mexican Peso" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "ARS", name: "Argentine Peso" },
  { code: "CLP", name: "Chilean Peso" },
  { code: "COP", name: "Colombian Peso" },
  { code: "PEN", name: "Peruvian Sol" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "SEK", name: "Swedish Krona" },
  { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" },
  { code: "ISK", name: "Icelandic Króna" },
  { code: "PLN", name: "Polish Złoty" },
  { code: "CZK", name: "Czech Koruna" },
  { code: "HUF", name: "Hungarian Forint" },
  { code: "TRY", name: "Turkish Lira" },
  { code: "AED", name: "UAE Dirham" },
  { code: "SAR", name: "Saudi Riyal" },
  { code: "ILS", name: "Israeli Shekel" },
  { code: "EGP", name: "Egyptian Pound" },
  { code: "MAD", name: "Moroccan Dirham" },
  { code: "ZAR", name: "South African Rand" },
  { code: "KES", name: "Kenyan Shilling" },
];

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);

export function fractionDigits(code?: string) {
  return code && ZERO_DECIMAL.has(code.toUpperCase()) ? 0 : 2;
}

/** 12.34 USD → 1234; 500 JPY → 500. Settlement maths runs on these integers. */
export function toMinor(amount: number, code?: string) {
  return Math.round(amount * 10 ** fractionDigits(code));
}

export function fromMinor(minor: number, code?: string) {
  return (minor / 10 ** fractionDigits(code)) || 0;
}

/**
 * Splits an integer total in proportion to `weights` so the parts add up to
 * exactly `total` (largest-remainder method). Ties go to the earliest key, so
 * every device computes the same split.
 */
export function allocate<K>(total: number, weights: ReadonlyMap<K, number>): Map<K, number> {
  if (total < 0) {
    const negated = allocate(-total, weights);
    for (const [k, v] of negated) negated.set(k, -v);
    return negated;
  }
  const result = new Map<K, number>();
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  if (sum <= 0 || weights.size === 0) return result;

  let assigned = 0;
  const remainders: { key: K; frac: number; order: number }[] = [];
  let order = 0;
  for (const [key, w] of weights) {
    const exact = (total * w) / sum;
    const floor = Math.floor(exact);
    result.set(key, floor);
    assigned += floor;
    remainders.push({ key, frac: exact - floor, order: order++ });
  }
  remainders.sort((a, b) => b.frac - a.frac || a.order - b.order);
  for (let i = 0; i < total - assigned; i++) {
    const { key } = remainders[i % remainders.length];
    result.set(key, result.get(key)! + 1);
  }
  return result;
}

export function formatMoney(amount: number, code: string) {
  const digits = fractionDigits(code);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${code}`;
  }
}

/** Accepts "1234.5", "1,234.50" and European "1.234,50". */
export function parseAmount(text: string): number | null {
  let s = text.replace(/[^\d.,-]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // Comma is the decimal separator if it has 1-2 digits after it.
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = /^-?\d+\.\d{3}$/.test(s) ? s.replace(".", "") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
