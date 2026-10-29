# Deochipei

A shared-expense app for trips, built with Expo and Supabase.

Deochipei helps groups track who paid what, split costs fairly, and settle up without spreadsheet chaos.

## What it does

- Track trip expenses and balances in real time
- Scan receipts and extract line items with AI
- Split costs equally or by item
- Convert amounts into each traveller's home currency
- Share trips with QR invite links
- Keep the app usable offline and sync when the connection returns

## Stack

- App: Expo + React Native + TypeScript
- Backend: Supabase + Node/Express fallback support
- AI: NVIDIA NIM for receipt parsing and duplicate checks

## Project structure

```text
deochipei/
├── app/          Expo app
├── server/       API and AI services
├── supabase/     database schema and auth config
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

Guest trips are local-only: creating or editing one does not enqueue server sync, and joining a server trip requires a signed-in user. Direct Supabase joining assumes a deployed `join_trip_by_code(_code, _claim_member_id, _home_currency)` RPC that returns the complete trip row (or `{ trip: row }`/a one-element row array), with `null` claim ID performing a read-only lookup and a member ID claiming only that pre-created member. This checkout contains no Supabase schema or migrations, so that RPC signature and its RLS behavior remain unverified until checked against the deployed project.

## Concurrent edits

Every expense carries a server-owned `revision` that changes on each accepted write. An edit sends back the revision it started from (`baseRevision` on `PUT /api/trips/:id/expenses/:expenseId`, `p_base_rev` on the Supabase RPC). If the expense has moved on, the server writes nothing and answers `409` with `code: "expense_conflict"` (or `"expense_deleted"`) and the current copy. The app then shows the server's version, keeps the user's edit aside, and asks whether to keep theirs or mine. Device clocks (`updatedAt`) are no longer used to decide who wins. A repeat of a write that already landed is accepted as a no-op, and clients that don't send `baseRevision` keep the old last-write-wins behaviour.

The Supabase path passes `p_base_rev`, but the `upsert_expense` function isn't in this repo; it must reject a stale base (SQLSTATE `40001` or a message containing "stale"/"conflict") and return a `revision` column for the app to see conflicts there. See `isRevisionConflict` in `app/src/lib/supabaseData.ts`.

## Notes

This project is designed for mobile use and is optimised for trip sharing, scanning receipts, and quick settlement. The app has a direct Supabase path behind an explicit flag, while the legacy server API remains available as backup.
