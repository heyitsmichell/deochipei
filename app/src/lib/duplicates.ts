import { baseAmount } from "./ledger";
import { isISODate } from "./receiptScan";
import { todayISO, type Expense, type ReceiptScan, type Trip } from "./types";

/**
 * Catching a receipt that's already on the trip, so the group isn't charged
 * twice (two people photograph the same bill, or one types it in and another
 * scans it later). A cheap local filter finds look-alike expenses; only when
 * there are any does Claude compare them (POST /api/check-duplicate).
 */

/** Body of POST /api/check-duplicate (server/src/duplicates.ts). */
export interface DuplicateCheckRequest {
  receipt: {
    merchant: string | null;
    merchant_translated: string | null;
    date: string | null;
    time: string | null;
    receipt_number: string | null;
    currency: string;
    total: number;
    items: { name: string; translated_name: string | null; price: number }[];
  };
  candidates: {
    id: string;
    description: string;
    paid_by: string;
    date: string;
    currency: string;
    amount: number;
    source: "scanned" | "typed";
    merchant: string | null;
    time: string | null;
    receipt_number: string | null;
    items: { name: string; translated_name: string | null; price: number }[];
  }[];
  targetLanguage: string;
}

export interface DuplicateVerdict {
  duplicate_of: string | null;
  confidence: "high" | "medium" | null;
  reason: string;
}

/** An expense that a new receipt most likely repeats. */
export interface DuplicateMatch {
  expenseId: string;
  /** "high": the same purchase. "medium": probably; worth a look. */
  confidence: "high" | "medium";
  /** Claude's one-line explanation, in the traveller's language. */
  reason: string;
}

// Loose on purpose: anything these let through is judged by Claude.
const WINDOW_DAYS = 3;
const AMOUNT_TOLERANCE = 0.2; // A card slip can add a tip the itemised bill doesn't show.
const MAX_CANDIDATES = 5;

/**
 * Expenses that could be the same purchase as `scan`: dated within a few days
 * of it, with a similar amount, the same merchant or the same receipt number.
 * Closest first.
 */
export function duplicateCandidates(
  trip: Trip,
  scan: ReceiptScan,
  opts: { rateToBase: number | null; excludeId?: string; today?: string },
): Expense[] {
  const date = isISODate(scan.date) ? scan.date : (opts.today ?? todayISO());
  const merchants = [scan.merchant, scan.merchant_translated].map(normalize).filter((m) => m.length >= 3);
  const number = normalize(scan.receipt_number);

  const scored: { expense: Expense; score: number }[] = [];
  for (const e of trip.expenses) {
    if (e.id === opts.excludeId) continue;
    const days = daysBetween(e.date, date);
    if (days == null || days > WINDOW_DAYS) continue;

    const sameNumber = number.length > 0 && normalize(e.receipt?.receiptNumber) === number;
    const sameMerchant = merchantMatches(e, merchants);
    const gap = amountGap(e, scan, opts.rateToBase);
    if (!sameNumber && !sameMerchant && !(gap != null && gap <= AMOUNT_TOLERANCE)) continue;

    // Lower is closer.
    const score = (sameNumber ? 0 : 2) + (sameMerchant ? 0 : 1) + (gap ?? 1) + days / 10;
    scored.push({ expense: e, score });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_CANDIDATES)
    .map((s) => s.expense);
}

export function duplicateCheckRequest(
  trip: Trip,
  scan: ReceiptScan,
  candidates: Expense[],
  targetLanguage: string,
): DuplicateCheckRequest {
  const name = (id: string) => trip.members.find((m) => m.id === id)?.name ?? "Someone";
  return {
    receipt: {
      merchant: scan.merchant,
      merchant_translated: scan.merchant_translated,
      date: scan.date,
      time: scan.time ?? null,
      receipt_number: scan.receipt_number ?? null,
      currency: scan.currency,
      total: scan.total,
      items: scan.items.map((i) => ({ name: i.name, translated_name: i.translated_name, price: i.total_price })),
    },
    candidates: candidates.map((e) => ({
      id: e.id,
      description: e.description || "Expense",
      paid_by: name(e.paidBy),
      date: e.date,
      currency: e.currency,
      amount: e.amount,
      source: e.receipt ? "scanned" : "typed",
      merchant: e.receipt?.merchantTranslated ?? e.receipt?.merchant ?? null,
      time: e.receipt?.time ?? null,
      receipt_number: e.receipt?.receiptNumber ?? null,
      items: (e.receipt?.items ?? []).map((i) => ({ name: i.name, translated_name: i.translatedName, price: i.price })),
    })),
    targetLanguage,
  };
}

/**
 * The expense `scan` most likely repeats, or null. `check` (Claude, via the
 * server) only runs when the local filter finds something close.
 */
export async function findDuplicate(
  check: (request: DuplicateCheckRequest) => Promise<DuplicateVerdict>,
  trip: Trip,
  scan: ReceiptScan,
  opts: { rateToBase: number | null; language: string; excludeId?: string; today?: string },
): Promise<DuplicateMatch | null> {
  const candidates = duplicateCandidates(trip, scan, opts);
  if (!candidates.length) return null;
  const verdict = await check(duplicateCheckRequest(trip, scan, candidates, opts.language));
  // Only trust an answer that points at one of the expenses we asked about.
  if (!verdict.duplicate_of || !verdict.confidence || !candidates.some((c) => c.id === verdict.duplicate_of)) {
    return null;
  }
  return { expenseId: verdict.duplicate_of, confidence: verdict.confidence, reason: verdict.reason };
}

/** Lowercase, without spaces or punctuation, so "ICHIRAN Shibuya" matches "Ichiran shibuya". */
function normalize(text: string | null | undefined) {
  return (text ?? "").toLowerCase().replace(/[\s.,:;'"’&()[\]\-_/\\·・。、!?#*+]/g, "");
}

function merchantMatches(e: Expense, merchants: string[]) {
  if (!merchants.length) return false;
  const names = [e.description, e.receipt?.merchant, e.receipt?.merchantTranslated]
    .map(normalize)
    .filter((n) => n.length >= 3);
  return names.some((n) => merchants.some((m) => n.includes(m) || m.includes(n)));
}

/** Relative difference between the amounts, or null if they can't be compared. */
function amountGap(e: Expense, scan: ReceiptScan, rateToBase: number | null) {
  if (e.currency === scan.currency) return relativeGap(e.amount, scan.total);
  if (rateToBase == null) return null;
  return relativeGap(baseAmount(e), scan.total * rateToBase);
}

function relativeGap(a: number, b: number) {
  const larger = Math.max(Math.abs(a), Math.abs(b));
  return larger === 0 ? 0 : Math.abs(a - b) / larger;
}

function daysBetween(a: string, b: string) {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.abs(ms) / 86_400_000;
}
