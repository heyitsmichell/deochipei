-- Row-level security and write-RPC tests for the initial schema.
--
-- Run with the Supabase CLI, which starts the local stack and a throwaway
-- database:
--
--   supabase start
--   supabase test db
--
-- The tests deliberately run as the `authenticated` and `anon` roles so RLS is
-- applied. Fixtures are inserted as the migration owner (postgres), which
-- bypasses RLS, then every assertion goes through the same policies the app
-- meets in production.

begin;

create extension if not exists pgtap with schema extensions;

set search_path = public, extensions;
select plan(45);

-- ── Fixtures ──────────────────────────────────────────────────────────────
-- Minimal auth users: the auth schema fills in the rest of its columns.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'member@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'member2@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'joiner@example.test');

insert into public.trips (id, name, currency, created_by, invite_code, invite_expires_at) values
  ('trip-rls', 'RLS trip', 'USD', '11111111-1111-1111-1111-111111111111', 'RLSTEST01', now() + interval '7 days'),
  ('trip-second', 'Second trip', 'USD', '11111111-1111-1111-1111-111111111111', 'RLSTEST02', now() + interval '7 days'),
  ('trip-expired', 'Expired trip', 'USD', '11111111-1111-1111-1111-111111111111', 'EXPIRED01', now() - interval '1 day');

insert into public.trip_members (id, trip_id, display_name, user_id) values
  ('m-owner', 'trip-rls', 'Owner', '11111111-1111-1111-1111-111111111111'),
  ('m-member', 'trip-rls', 'Member', '22222222-2222-2222-2222-222222222222'),
  ('m-member2', 'trip-rls', 'Member Two', '33333333-3333-3333-3333-333333333333'),
  ('m-open', 'trip-rls', 'Open spot', null);

insert into public.trip_members (id, trip_id, display_name) values
  ('m-second', 'trip-second', 'Only member');

-- Members see the trip and its people; outsiders see nothing.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select count(*) from public.trips where id = 'trip-rls'), 1::bigint, 'the owner can read the trip');
select is((select count(*) from public.trip_members where trip_id = 'trip-rls'), 4::bigint, 'the owner can read every member');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*) from public.trips where id = 'trip-rls'), 1::bigint, 'a member can read the trip');
select is((select count(*) from public.expenses where trip_id = 'trip-rls'), 0::bigint, 'a member starts with no expenses');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select is((select count(*) from public.trips where id = 'trip-rls'), 0::bigint, 'an outsider cannot read the trip');
select is((select count(*) from public.trip_members where trip_id = 'trip-rls'), 0::bigint, 'an outsider cannot read members');

-- An outsider cannot write an expense even with a forged creator.
select throws_ok($$
  insert into public.expenses (id, trip_id, description, amount, currency, rate_to_base, paid_by, created_by, date)
  values ('e-outsider', 'trip-rls', 'Sneaky', 10, 'USD', 1, 'm-outsider', '44444444-4444-4444-4444-444444444444', '2026-10-29')
$$, '42501', null, 'an outsider cannot insert an expense');

-- A member may insert their own expense, but not one attributed to someone else.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok($$
  insert into public.expenses (id, trip_id, description, amount, currency, rate_to_base, paid_by, created_by, date)
  values ('e-forged', 'trip-rls', 'Forged', 10, 'USD', 1, 'm-member', '11111111-1111-1111-1111-111111111111', '2026-10-29')
$$, '42501', null, 'a member cannot forge the expense creator');
select throws_ok($$
  insert into public.expenses (id, trip_id, description, amount, currency, rate_to_base, paid_by, created_by, date)
  values ('e-member', 'trip-rls', 'Direct dinner', 10, 'USD', 1, 'm-member', '22222222-2222-2222-2222-222222222222', '2026-10-29')
$$, '42501', null, 'direct expense writes are restricted to the RPC');
select lives_ok($$
  select public.upsert_expense(jsonb_build_object(
    'id', 'e-member', 'trip_id', 'trip-rls', 'description', 'RPC dinner', 'amount', 10,
    'currency', 'USD', 'rate_to_base', 1, 'paid_by', 'm-member', 'date', '2026-10-29')), null)
$$, 'a member can insert their own expense through the RPC');

-- Another member cannot edit it; the owner can.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((
  with updated as (update public.expenses set amount = 11 where id = 'e-member' returning 1)
  select count(*) from updated
), 0::bigint, 'a different member cannot edit an expense');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$
  with updated as (update public.expenses set amount = 11 where id = 'e-member' returning 1)
  select count(*) from updated
$$, '42501', null, 'direct expense updates are restricted to the RPC');

-- Expense and payment ids are tombstoned by the RPCs, so direct deletes are
-- not granted at all.
select throws_ok($$delete from public.expenses where id = 'e-member'$$, '42501', null,
  'expenses cannot be hard-deleted around the RPC');

-- ── Member profile updates ────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
create temp table revision_before as
  select revision from public.trips where id = 'trip-rls';
select lives_ok($$update public.trip_members set home_currency = 'EUR' where id = 'm-member2'$$,
  'a member can set their own home currency');
select cmp_ok((select revision from public.trips where id = 'trip-rls'), '>',
  (select revision from revision_before), 'a direct member write moves the trip revision');

-- A member cannot hand their row to another account.
select throws_ok($$update public.trip_members set user_id = '44444444-4444-4444-4444-444444444444' where id = 'm-member2'$$,
  '23514', 'A claimed member cannot be reassigned', 'a member cannot reassign their row');

-- Even the owner cannot move a member to another trip.
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$update public.trip_members set trip_id = 'trip-second' where id = 'm-open'$$,
  '23514', 'A member cannot be moved to another trip', 'a member row cannot be moved between trips');

-- Only the owner may add members.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok($$insert into public.trip_members (id, trip_id, display_name) values ('m-sneak', 'trip-rls', 'Sneak')$$,
  '42501', null, 'a non-owner cannot add a member');

-- ── Payments ──────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select lives_ok($$
  select public.upsert_settlement(jsonb_build_object(
    'id', 's-member', 'trip_id', 'trip-rls', 'from_member', 'm-member', 'to_member', 'm-owner',
    'amount', 5, 'currency', 'USD', 'date', '2026-10-29', 'method', 'Cash'), null)
$$, 'a member can record a payment');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select count(*) from public.trip_settlements where id = 's-member'), 1::bigint,
  'other members can read the payment');
select throws_ok($$
  select public.upsert_settlement(jsonb_build_object(
    'id', 's-member', 'trip_id', 'trip-rls', 'from_member', 'm-member', 'to_member', 'm-owner',
    'amount', 9, 'currency', 'USD', 'date', '2026-10-29'), null)
$$, '42501', 'Only the person who recorded this payment or the trip owner can change it',
  'another member cannot edit the payment');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok($$
  select public.upsert_settlement(jsonb_build_object(
    'id', 's-member', 'trip_id', 'trip-rls', 'from_member', 'm-member', 'to_member', 'm-owner',
    'amount', 6, 'currency', 'USD', 'date', '2026-10-29'), null)
$$, 'the owner can correct a payment');

-- Invalid payments are refused before they reach the ledger.
select throws_ok($$
  select public.upsert_settlement(jsonb_build_object(
    'id', 's-bad-currency', 'trip_id', 'trip-rls', 'from_member', 'm-member', 'to_member', 'm-owner',
    'amount', 1, 'currency', 'EUR', 'date', '2026-10-29'), null)
$$, '23514', 'Payments are recorded in the trip currency', 'payments must use the trip currency');
select throws_ok($$
  select public.upsert_settlement(jsonb_build_object(
    'id', 's-self', 'trip_id', 'trip-rls', 'from_member', 'm-member', 'to_member', 'm-member',
    'amount', 1, 'currency', 'USD', 'date', '2026-10-29'), null)
$$, '23514', 'A payment needs two different people', 'a payment needs two different people');
select throws_ok($$
  select public.upsert_settlement(jsonb_build_object(
    'id', 's-stranger', 'trip_id', 'trip-rls', 'from_member', 'm-member', 'to_member', 'nobody',
    'amount', 1, 'currency', 'USD', 'date', '2026-10-29'), null)
$$, '23514', 'Both people must be members of this trip', 'both people must be trip members');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select throws_ok($$
  select public.upsert_settlement(jsonb_build_object(
    'id', 's-outsider', 'trip_id', 'trip-rls', 'from_member', 'm-member', 'to_member', 'm-owner',
    'amount', 1, 'currency', 'USD', 'date', '2026-10-29'), null)
$$, '42501', 'Not a member of this trip', 'an outsider cannot record a payment');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select lives_ok($$select public.upsert_settlement(jsonb_build_object('id', 's-member', 'trip_id', 'trip-rls', 'deleted_at', now()::text), null)$$,
  'the creator can remove their payment');
select is((select deleted_settlement_ids ? 's-member' from public.trips where id = 'trip-rls'), true,
  'a removed payment leaves a tombstone');
select lives_ok($$select public.upsert_settlement(jsonb_build_object('id', 's-member', 'trip_id', 'trip-rls', 'deleted_at', now()::text), null)$$,
  'deleting an already-removed payment is idempotent');

-- ── Expenses through the RPC ──────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select lives_ok($$
  select public.upsert_expense(jsonb_build_object(
    'id', 'e-rpc', 'trip_id', 'trip-rls', 'description', 'RPC dinner', 'amount', 20,
    'currency', 'USD', 'rate_to_base', 1, 'paid_by', 'm-member', 'category', 'food',
    'date', '2026-10-29',
    'split_definition', jsonb_build_object('type', 'equal', 'memberIds', jsonb_build_array('m-member', 'm-owner'))), null)
$$, 'a member can create an expense through the RPC');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$
  select public.upsert_expense(jsonb_build_object(
    'id', 'e-rpc', 'trip_id', 'trip-rls', 'description', 'Not mine', 'amount', 21,
    'currency', 'USD', 'rate_to_base', 1, 'paid_by', 'm-member', 'category', 'food',
    'date', '2026-10-29',
    'split_definition', jsonb_build_object('type', 'equal', 'memberIds', jsonb_build_array('m-member'))), null)
$$, '42501', 'Only the expense creator or trip owner can edit this expense',
  'another member cannot edit the expense through the RPC');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok(
  format($$select public.upsert_expense(%L::jsonb, %s)$$,
    jsonb_build_object(
      'id', 'e-rpc', 'trip_id', 'trip-rls', 'description', 'Stale edit', 'amount', 22,
      'currency', 'USD', 'rate_to_base', 1, 'paid_by', 'm-member', 'category', 'food',
      'date', '2026-10-29',
      'split_definition', jsonb_build_object('type', 'equal', 'memberIds', jsonb_build_array('m-member'))),
    (select revision from public.expenses where id = 'e-rpc') - 1),
  '40001', 'expense_conflict', 'a stale expense revision is refused');
select lives_ok(
  format($$select public.upsert_expense(%L::jsonb, %s)$$,
    jsonb_build_object(
      'id', 'e-rpc', 'trip_id', 'trip-rls', 'description', 'Owner fix', 'amount', 22,
      'currency', 'USD', 'rate_to_base', 1, 'paid_by', 'm-member', 'category', 'food',
      'date', '2026-10-29',
      'split_definition', jsonb_build_object('type', 'equal', 'memberIds', jsonb_build_array('m-member'))),
    (select revision from public.expenses where id = 'e-rpc')),
  'the owner can save with the current revision');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select lives_ok($$select public.upsert_expense(jsonb_build_object('id', 'e-rpc', 'trip_id', 'trip-rls', 'deleted_at', now()::text), null)$$,
  'the creator can remove the expense');
select is((select deleted_expense_ids ? 'e-rpc' from public.trips where id = 'trip-rls'), true,
  'a removed expense leaves a tombstone');

-- ── Invite previews and claims ────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select is((
  select bool_and(coalesce(member ->> 'user_id', '') = '')
  from jsonb_array_elements(public.join_trip_by_code('RLSTEST01') -> 'trip_members') member
), true, 'a preview hides account ids');
select is(jsonb_array_length(public.join_trip_by_code('RLSTEST01') -> 'expenses'), 0,
  'a preview hides expenses');

select lives_ok($$select public.join_trip_by_code('RLSTEST01', 'm-open')$$, 'an invite can claim an open member');
select is((select count(*) from public.trips where id = 'trip-rls'), 1::bigint,
  'claiming a member grants access to the trip');
select throws_ok($$select public.join_trip_by_code('RLSTEST01', 'm-member')$$,
  '23505', 'Member is already claimed', 'a claimed member cannot be taken');
select ok(public.join_trip_by_code('EXPIRED01') is null, 'an expired invite does not resolve');

-- ── Anonymous callers ─────────────────────────────────────────────────────
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$select * from public.trips$$, '42501', null, 'anonymous callers cannot read trips');
select lives_ok($$select public.join_trip_by_code('RLSTEST01')$$, 'anonymous callers can preview an invite');
select throws_ok($$select public.join_trip_by_code('RLSTEST01', 'm-open')$$,
  '42501', 'Sign in to claim a trip member', 'anonymous callers cannot claim a member');

-- ── Trip creation policy ──────────────────────────────────────────────────
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select lives_ok($$
  insert into public.trips (id, name, currency, created_by)
  values ('trip-new', 'New trip', 'USD', '44444444-4444-4444-4444-444444444444')
$$, 'an authenticated user can create their own trip');
select throws_ok($$
  insert into public.trips (id, name, currency, created_by)
  values ('trip-forged', 'Forged trip', 'USD', '11111111-1111-1111-1111-111111111111')
$$, '42501', null, 'a user cannot create a trip for someone else');

select * from finish();
rollback;
