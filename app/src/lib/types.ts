export type Category =
  | "food"
  | "transport"
  | "lodging"
  | "activities"
  | "shopping"
  | "groceries"
  | "other";

/** Light or dark screens: follow the phone's setting, or always one or the other. */
export type ThemePreference = "system" | "light" | "dark";

export interface Member {
  id: string;
  name: string;
  /** The currency this person reads totals and balances in (set from their own phone). */
  homeCurrency?: string;
  userId?: string;
  email?: string;
  avatarUrl?: string;
}

export interface ReceiptItem {
  name: string;
  translatedName: string | null;
  quantity: number;
  price: number;
}

export interface ReceiptData {
  merchant: string | null;
  merchantTranslated: string | null;
  /** Receipt/transaction number and time as printed; the surest way to spot the same receipt twice. */
  receiptNumber?: string | null;
  time?: string | null;
  language: string;
  items: ReceiptItem[];
  notes: string | null;
  tax?: number | null;
  tip?: number | null;
  serviceCharge?: number | null;
}

export type Split =
  | { type: "equal"; memberIds: string[] }
  // Each receipt item is shared by the members listed for it; items nobody
  // claimed are shared by everyone in `memberIds`. Tax, tip and anything not
  // itemised is spread in proportion to what each person ordered.
  | { type: "items"; memberIds: string[]; assignments: Record<number, string[]> };

export interface Expense {
  id: string;
  description: string;
  category: Category;
  amount: number;
  currency: string;
  // Units of the trip's base currency per 1 unit of `currency`, locked in when
  // the expense was recorded (editable, since card rates differ).
  rateToBase: number;
  paidBy: string;
  /** Server-side creator identity, retained across edits. */
  createdBy?: string;
  date: string;
  split: Split;
  receipt?: ReceiptData;
  /** Added automatically from a receipt snapped offline; cleared once someone saves it. */
  needsReview?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Trip {
  id: string;
  code?: string;
  inviteCode?: string;
  name: string;
  baseCurrency: string;
  members: Member[];
  expenses: Expense[];
  deletedExpenseIds: string[];
  updatedAt: number;
  ownerId?: string;
  /** True for trips created/joined through a server; guest trips stay local. */
  syncEnabled?: boolean;
  /** Monotonic server revision, when the backend provides one. */
  revision?: number;
  inviteExpiresAt?: number | string | null;
}

/** An invite lookup exposes names only and must never replace an account's full trip. */
export interface TripPreview {
  preview: true;
  id: string;
  code?: string;
  name: string;
  baseCurrency: string;
  members: Member[];
  inviteExpiresAt?: number | string | null;
}
export type TripLookup = Trip | TripPreview;
export function isTripPreview(trip: TripLookup): trip is TripPreview {
  return "preview" in trip && trip.preview === true;
}

export interface ReceiptScan {
  merchant: string | null;
  merchant_translated: string | null;
  detected_language: string;
  country: string | null;
  currency: string;
  date: string | null;
  time: string | null;
  receipt_number: string | null;
  items: { name: string; translated_name: string | null; quantity: number; total_price: number }[];
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  service_charge: number | null;
  total: number;
  category: Category;
  notes: string | null;
}

export const CATEGORIES: { key: Category; label: string; icon: string }[] = [
  { key: "food", label: "Food", icon: "🍜" },
  { key: "transport", label: "Transport", icon: "🚆" },
  { key: "lodging", label: "Lodging", icon: "🏨" },
  { key: "activities", label: "Activities", icon: "🎟️" },
  { key: "shopping", label: "Shopping", icon: "🛍️" },
  { key: "groceries", label: "Groceries", icon: "🛒" },
  { key: "other", label: "Other", icon: "💸" },
];

export function categoryIcon(c: Category) {
  return CATEGORIES.find((x) => x.key === c)?.icon ?? "💸";
}

export function newId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  try {
    // Expo Crypto provides a native UUID implementation on device.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomUUID } = require("expo-crypto") as typeof import("expo-crypto");
    if (typeof randomUUID === "function") return randomUUID();
  } catch {
    // Fall through for dependency-free tests and older runtimes.
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function todayISO() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
