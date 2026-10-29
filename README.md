# Deochipei

A shared-expense app for trips, built with Expo and Supabase.

Deochipei helps groups track who paid what, split costs fairly, and settle up without spreadsheet chaos.

## What it does

- Track trip expenses and balances in real time
- Scan receipts and extract line items with AI
- Split costs equally, by item, or by shares (for example, two shares for an adult and one for a child)
- Record payments between travellers so balances can reach zero
- Request a payment with a QR code or deep link that opens the trip with the payment ready to record
- Convert amounts into each traveller's home currency, with the locked rate and its source shown on each expense
- Share a plain-language recap or export every expense to CSV
- See spending by category and set an optional trip budget
- Share trips with QR invite links
- Keep the app usable offline and sync when the connection returns
- Use screen readers and larger touch targets throughout the main flows

## Stack

- App: Expo + React Native + TypeScript
- Database and auth: Supabase (Postgres, row-level security, RPCs)
- Optional fallback API: Node/Express with SQLite (`server/`)
- AI: NVIDIA NIM for receipt parsing and duplicate checks

## Project structure

```text
deochipei/
├── app/          Expo app
├── server/       Fallback API, AI endpoints, lint and tests
├── supabase/     migrations, RLS policies and pgTAP tests
├── .github/      CI (typecheck, lint, tests)
├── .gitignore
├── README.md
└── package.json
```

## Local setup

```bash
cp app/.env.example app/.env
cp server/.env.example server/.env
```

Fill in your local Supabase and AI values, then run:

```bash
cd app
npm install
npx expo start
```

```bash
cd server
npm install
npm run dev
```

Keep real environment values local and do not commit `.env` files.

## Supabase

The schema, row-level security policies and write RPCs live in
`supabase/migrations/20261029000000_initial_schema.sql`. Apply them with the
Supabase CLI:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

For a local stack:

```bash
supabase start
supabase db reset          # applies every migration
supabase test db           # runs the pgTAP tests in supabase/tests
```

The migration creates:

| Object | Purpose |
| --- | --- |
| `trips`, `trip_members`, `expenses`, `trip_settlements` | Trip data; every table has RLS enabled |
| `join_trip_by_code(_code, _claim_member_id, _home_currency)` | Public invite lookup and member claim; returns the trip row as JSON |
| `upsert_expense(p_expense, p_base_rev)` | Create, edit or soft-delete an expense |
| `upsert_settlement(p_settlement, p_base_rev)` | Record, edit or soft-delete a payment |
| `trip_revision(p_trip_id)` | Cheap version poll for sync |
| `is_trip_owner`, `is_trip_member`, `can_edit_expense`, `can_edit_settlement` | Authorization helpers used by RLS |

Authorization rules match the Express server:

- Anyone with a valid, unexpired invite code can preview the trip; only a signed-in user can claim an unclaimed member and then read expenses.
- A trip owner can edit any expense or payment. Otherwise only the person who created the record may edit or remove it.
- Only the owner can rename the trip, change its base currency, manage members or rotate invites.
- Expenses and payments are soft-deleted. Their ids are kept in `deleted_expense_ids` / `deleted_settlement_ids` so a stale client cannot resurrect them.
- Direct `DELETE` on expenses and payments is not granted; use the RPCs.
- Triggers prevent a member row from being moved to another trip or handed to another account, and keep the trip revision moving for direct child writes.

Set `EXPO_PUBLIC_SUPABASE_DATA_MODE=direct` to use Supabase for trip data from the app. The default falls back to the Express API, which is useful when running without a Supabase project.

## Payments and balances

`Trip.settlements` stores payments that have already happened. A settlement has
`from`, `to`, `amount`, `currency`, `date`, an optional `method`/`note`, and the
usual timestamps and revision. Amounts are always in the trip's base currency.

The ledger treats a payment as a transfer, not spending:

- `totalSpent` still counts only expenses.
- `A paid B` reduces A's debt to B; an overpayment flips the remaining debt in
  the other direction.
- The settle-up plan is computed from net balances after payments, so a trip
  can reach zero and show "Everyone is square".

The Settle Up card records payments, lists their history and lets the creator or
trip owner undo one. The same operations are available in both backends:
`PUT/DELETE /api/trips/:id/settlements/:settlementId` and the
`upsert_settlement` RPC.

Each suggested payment has a **Request** button. It shows a QR code and a
`deochipei://trip/<id>?settleFrom=…&settleTo=…&settleAmount=…` link; opening it
lands on the trip's balances tab with the payment form filled in. The link only
carries member ids and an amount, so it grants no access to the trip. Malformed
or stale links are ignored or rejected when the payment is saved.

## Sharing and exports

The balances tab has a **Share the trip** card:

- **Share recap** sends a plain-language summary of the total, each person's
  balance and the suggested payments through the system share sheet.
- **Export CSV** writes one row per expense with the original amount, currency,
  locked exchange rate, amount in the trip's base currency, payer, split and
  rate source. It is shared as a file through `expo-sharing`, with a text
  fallback on platforms without file sharing.

The main flows (trip list, expense rows, receipt items, split controls and
payment history) have accessibility labels, selected states and live-region
announcements so screen readers can follow totals and sync status.

## Budgets and spending insights

The balances tab shows spending in the trip's base currency, grouped by
category using each expense's locked exchange rate. It also shows the number of
days with expenses, the average per spending day and the largest expense.

The trip owner can set an optional budget. A progress bar turns amber near the
limit and red when spending goes over it, and the remaining (or excess) amount
is announced for screen readers. Budgets are shared with the trip through
`PATCH /api/trips/:id` or the `trips.budget` column in Supabase; `null` clears
the budget.

## Concurrent edits

Every expense and payment carries a server-owned `revision` that changes on
each accepted write. An edit sends back the revision it started from
(`baseRevision` on the Express routes, `p_base_rev` on the Supabase RPCs). If
the record has moved on, nothing is written and the server answers `409` with
`code: "expense_conflict"` / `"expense_deleted"` (or the settlement
equivalents) and the current copy. The app shows the server's version, keeps the
user's edit aside, and asks whether to keep theirs or mine. Device clocks
(`updatedAt`) are never used to decide who wins. A repeat of a write that
already landed is accepted as a no-op, and clients that do not send a base
revision keep the old last-write-wins behaviour.

## AI cost controls

Receipt scanning uses two controls in `server/src/scanCache.ts`:

- A SQLite-backed cache keyed by SHA-256 of the image plus target language.
  Scanning the same photo again (a retry, or the same receipt on another phone)
  returns the stored result and costs nothing.
- A per-account daily quota, `AI_DAILY_SCAN_LIMIT` (default 60 scans per UTC
  day). Only cache misses are counted. Exceeding it returns `429` with
  `Retry-After`, `code: "scan_quota_exceeded"` and the used/limit figures.
  Set it to `0` to disable the quota.

The client downscales photos to a 2000px long edge and compresses them before
upload. The existing per-minute limiter remains as a burst guard, and both the
cache and the quota survive restarts and are shared by server processes using
the same database file.

## Server storage

The fallback API stores trips, rate-limit hits and scan cache entries in SQLite
at `DATA_DIR/trips.db`. Point `DATA_DIR` at a persistent volume, and run a
single writer process per database file (or put all instances on the same
volume). An existing `trips.json` is imported once on first start and kept as a
backup. CORS is closed in production unless `CORS_ORIGINS` lists the allowed
origins; the native app is unaffected.

## Checks

From the repository root:

```bash
npm run typecheck
npm run lint
npm test
```

CI runs the same three commands on every push to `main` and every pull request.
The Supabase SQL tests run separately with `supabase test db`.
