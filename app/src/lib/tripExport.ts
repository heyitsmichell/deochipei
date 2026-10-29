import type { Ledger } from "./ledger";
import { formatMoney, fractionDigits, fromMinor, toMinor } from "./money";
import type { Expense, Split, Trip } from "./types";

/** Quotes a CSV field when it contains a delimiter, quote or line break. */
export function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function splitLabel(split: Split, names: Map<string, string>): string {
  const people = split.memberIds.map((id) => names.get(id) ?? id);
  if (split.type === "shares") {
    return `Shares: ${split.memberIds
      .map((id) => `${names.get(id) ?? id} ${split.weights[id] ?? 1}`)
      .join(", ")}`;
  }
  if (split.type === "items") return `By item: ${people.join(", ")}`;
  return `Equal: ${people.join(", ")}`;
}

function baseAmount(expense: Expense, trip: Trip): string {
  const converted = fromMinor(
    toMinor(expense.amount * expense.rateToBase, trip.baseCurrency),
    trip.baseCurrency,
  );
  return converted.toFixed(fractionDigits(trip.baseCurrency));
}

/**
 * One row per expense, including the original amount, the locked rate and the
 * amount in the trip's base currency. A BOM keeps non-ASCII names readable in
 * Excel; CRLF matches what spreadsheet apps expect.
 */
export function tripCsv(trip: Trip): string {
  const names = new Map(trip.members.map((member) => [member.id, member.name]));
  const header = [
    "Date",
    "Description",
    "Category",
    "Amount",
    "Currency",
    "Rate to base",
    `Amount in ${trip.baseCurrency}`,
    "Paid by",
    "Split",
    "Receipt language",
    "Rate source",
    "Created at",
  ];
  const rows = [...trip.expenses]
    .sort((a, b) => (a.date === b.date ? a.createdAt - b.createdAt : a.date.localeCompare(b.date)))
    .map((expense) => [
      expense.date,
      expense.description || "Expense",
      expense.category,
      expense.amount.toFixed(fractionDigits(expense.currency)),
      expense.currency,
      String(expense.rateToBase),
      baseAmount(expense, trip),
      names.get(expense.paidBy) ?? expense.paidBy,
      splitLabel(expense.split, names),
      expense.receipt?.language ?? "",
      expense.rateSource ?? "",
      new Date(expense.createdAt).toISOString(),
    ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** A short summary suitable for pasting into a group chat. */
export function tripRecap(trip: Trip, ledger: Ledger): string {
  const names = new Map(trip.members.map((member) => [member.id, member.name]));
  const name = (id: string) => names.get(id) ?? "Someone";
  const money = (amount: number) => formatMoney(amount, trip.baseCurrency);
  const lines = [
    `${trip.name} · ${trip.members.length} ${trip.members.length === 1 ? "person" : "people"} · ` +
      `${trip.expenses.length} ${trip.expenses.length === 1 ? "expense" : "expenses"}`,
    `Total spent: ${money(ledger.totalSpent)}`,
  ];
  if (ledger.totalSettled > 0) lines.push(`Payments recorded: ${money(ledger.totalSettled)}`);

  lines.push("", "Balances:");
  for (const balance of ledger.balances()) {
    const label = Math.abs(balance.net) < 0.005
      ? "settled up"
      : balance.net > 0
        ? `is owed ${money(balance.net)}`
        : `owes ${money(-balance.net)}`;
    lines.push(`• ${name(balance.memberId)}: ${label}`);
  }

  const transfers = ledger.settlementPlan().transfers;
  lines.push("", transfers.length ? "Suggested payments:" : "Everyone is square.");
  for (const transfer of transfers) {
    lines.push(`• ${name(transfer.from)} pays ${name(transfer.to)} ${money(transfer.amount)}`);
  }
  lines.push("", "Sent from Deochipei");
  return lines.join("\n");
}

/** A filesystem-safe name such as `trip-2026-10-29.csv`. */
export function tripExportFilename(trip: Trip): string {
  const slug = trip.name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48)
    .toLowerCase();
  const date = new Date().toISOString().slice(0, 10);
  return `${slug || "trip"}-${date}.csv`;
}
