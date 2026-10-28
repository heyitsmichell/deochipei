import type { ReceiptData, ReceiptScan } from "./types";

export const isCurrencyCode = (code: string) => /^[A-Z]{3}$/.test(code);

export const isISODate = (date: string | null): date is string => {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

/** The parts of a scan the app keeps on the expense. */
export function receiptFromScan(r: ReceiptScan): ReceiptData {
  const textOrNull = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };
  return {
    merchant: textOrNull(r.merchant),
    merchantTranslated: textOrNull(r.merchant_translated),
    // Scans saved before these fields existed don't have them.
    receiptNumber: r.receipt_number ?? null,
    time: r.time ?? null,
    language: r.detected_language,
    items: r.items.map((i) => ({
      name: i.name,
      translatedName: textOrNull(i.translated_name),
      quantity: i.quantity,
      price: i.total_price,
    })),
    notes: textOrNull(r.notes),
    tax: r.tax,
    tip: r.tip,
    serviceCharge: r.service_charge,
  };
}
