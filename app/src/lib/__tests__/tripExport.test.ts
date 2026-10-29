import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger } from "../ledger";
import { tripCsv, tripExportFilename, tripRecap } from "../tripExport";
import { expense, trip } from "./fixtures";

test("CSV escapes descriptions and keeps original and locked base amounts", () => {
  const t = trip({
    expenses: [
      expense({
        description: 'Dinner, "set menu"',
        amount: 10,
        currency: "EUR",
        rateToBase: 1.5,
        rateSource: "ECB",
        split: { type: "shares", memberIds: ["a", "b"], weights: { a: 2, b: 1 } },
      }),
      expense({ id: "older", description: "Coffee", date: "2026-10-27", amount: 3 }),
    ],
  });
  const csv = tripCsv(t);
  assert.ok(csv.startsWith("\uFEFFDate,Description,Category,Amount,Currency,Rate to base,Amount in USD"));
  assert.match(csv, /"Dinner, ""set menu"""/);
  assert.match(csv, /2026-10-28,"Dinner, ""set menu""",food,10\.00,EUR,1\.5,15\.00,Alice,"Shares: Alice 2, Bob 1"/);
  assert.match(csv, /ECB/);
  // Rows are chronological, so the sheet reads like a statement.
  assert.ok(csv.indexOf("2026-10-27") < csv.indexOf("2026-10-28"));
  assert.ok(csv.endsWith("\r\n"));
});

test("recap states balances and the fewest payments", () => {
  const t = trip({ expenses: [expense({ amount: 10 })] });
  const recap = tripRecap(t, new Ledger(t));
  assert.match(recap, /Synthetic trip · 2 people · 1 expense/);
  assert.match(recap, /Total spent: \$10\.00/);
  assert.match(recap, /• Alice: is owed \$5\.00/);
  assert.match(recap, /• Bob: owes \$5\.00/);
  assert.match(recap, /Suggested payments:\n• Bob pays Alice \$5\.00/);
});

test("recap says when everyone is square", () => {
  const t = trip({ expenses: [] });
  assert.match(tripRecap(t, new Ledger(t)), /Everyone is square\./);
});

test("export filenames are safe and dated", () => {
  assert.match(tripExportFilename(trip({ name: "Tōkyō / 2026" })), /^tokyo-2026-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(tripExportFilename(trip({ name: "  " })), /^trip-\d{4}-\d{2}-\d{2}\.csv$/);
});
