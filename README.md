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

## Notes

This project is designed for mobile use and is optimised for trip sharing, scanning receipts, and quick settlement. The app has a direct Supabase path behind an explicit flag, while the legacy server API remains available as backup.
