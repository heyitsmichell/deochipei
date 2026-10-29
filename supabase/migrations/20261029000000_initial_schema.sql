-- Deochipei initial schema, row-level security and write RPCs.
--
-- Apply with the Supabase CLI (`supabase db push`) or paste into the SQL
-- editor. The app can use this schema directly (EXPO_PUBLIC_SUPABASE_DATA_MODE
-- = "direct") or through the Express fallback; both paths use the same
-- authorization rules documented below.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── Tables ────────────────────────────────────────────────────────────────

create table if not exists public.trips (
  id text primary key,
  name text not null check (char_length(name) between 1 and 80),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  budget numeric check (budget is null or budget > 0),
  created_by uuid not null references auth.users (id) on delete cascade,
  invite_code text not null unique default upper(encode(extensions.gen_random_bytes(8), 'hex')),
  invite_expires_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  deleted_expense_ids jsonb not null default '[]'::jsonb,
  deleted_settlement_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trip_members (
  id text primary key,
  trip_id text not null references public.trips (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  user_id uuid references auth.users (id) on delete set null,
  home_currency text check (home_currency ~ '^[A-Z]{3}$'),
  email text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, id)
);

create table if not exists public.expenses (
  id text primary key,
  trip_id text not null references public.trips (id) on delete cascade,
  title text,
  description text not null default '',
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  rate_to_base numeric not null check (rate_to_base > 0),
  rate_source text,
  rate_fetched_at timestamptz,
  paid_by text not null,
  created_by uuid references auth.users (id) on delete set null,
  category text not null default 'other',
  date date not null,
  receipt_data jsonb,
  split_definition jsonb not null default '{"type":"equal","memberIds":[]}'::jsonb,
  needs_review boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trip_settlements (
  id text primary key,
  trip_id text not null references public.trips (id) on delete cascade,
  from_member text not null,
  to_member text not null,
  amount numeric not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  date date not null,
  method text,
  note text,
  created_by uuid references auth.users (id) on delete set null,
  revision bigint not null default 1 check (revision > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_member <> to_member)
);

create index if not exists trips_created_by_idx on public.trips (created_by);
create index if not exists trip_members_trip_idx on public.trip_members (trip_id);
create index if not exists trip_members_user_idx on public.trip_members (user_id);
create unique index if not exists trip_members_one_user_per_trip_idx
  on public.trip_members (trip_id, user_id)
  where user_id is not null;
create index if not exists expenses_trip_idx on public.expenses (trip_id);
create index if not exists expenses_created_by_idx on public.expenses (created_by);
create index if not exists trip_settlements_trip_idx on public.trip_settlements (trip_id);
create index if not exists trip_settlements_created_by_idx on public.trip_settlements (created_by);

-- ── Timestamp / revision helpers ─────────────────────────────────────────

create or replace function public.touch_trip_revision()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- The write RPCs increment the revision themselves; a direct table update
  -- (rename, invite rotation) still has to move the version clients poll.
  if new.revision is not distinct from old.revision then
    new.revision := old.revision + 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trips_touch_revision on public.trips;
create trigger trips_touch_revision
before update on public.trips
for each row execute function public.touch_trip_revision();

create or replace function public.guard_trip_currency_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.currency is distinct from old.currency
     and exists (
       select 1 from public.trip_settlements s
       where s.trip_id = old.id and s.deleted_at is null
     ) then
    raise exception 'A trip''s base currency cannot change while it has recorded settlements'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trips_guard_currency on public.trips;
create trigger trips_guard_currency
before update on public.trips
for each row execute function public.guard_trip_currency_change();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trip_members_touch on public.trip_members;
create trigger trip_members_touch before update on public.trip_members
for each row execute function public.touch_updated_at();

drop trigger if exists expenses_touch on public.expenses;
create trigger expenses_touch before update on public.expenses
for each row execute function public.touch_updated_at();

drop trigger if exists trip_settlements_touch on public.trip_settlements;
create trigger trip_settlements_touch before update on public.trip_settlements
for each row execute function public.touch_updated_at();

-- ── Identity guards ───────────────────────────────────────────────────────
-- RLS decides who may write; these triggers stop an authorised write from
-- moving a row to another trip or reassigning who created it.

create or replace function public.guard_trip_member_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.id <> old.id or new.trip_id <> old.trip_id then
    raise exception 'A member cannot be moved to another trip' using errcode = '23514';
  end if;
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'A claimed member cannot be reassigned' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trip_members_guard on public.trip_members;
create trigger trip_members_guard before update on public.trip_members
for each row execute function public.guard_trip_member_update();

create or replace function public.guard_record_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.id <> old.id or new.trip_id <> old.trip_id
     or new.created_by is distinct from old.created_by then
    raise exception 'A record cannot be moved to another trip or reassigned' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists expenses_guard on public.expenses;
create trigger expenses_guard before update on public.expenses
for each row execute function public.guard_record_update();

drop trigger if exists trip_settlements_guard on public.trip_settlements;
create trigger trip_settlements_guard before update on public.trip_settlements
for each row execute function public.guard_record_update();

-- ── Version bumps for direct child writes ─────────────────────────────────
-- The RPCs bump the trip revision themselves. Clients may also write an
-- allowed child row directly (for example a member's home currency); that
-- must still move the version other clients poll.

create or replace function public.bump_trip_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trip_id text;
begin
  v_trip_id := case when tg_op = 'DELETE' then old.trip_id else new.trip_id end;
  update public.trips set revision = revision + 1 where id = v_trip_id;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trip_members_bump_revision on public.trip_members;
create trigger trip_members_bump_revision after insert or update or delete on public.trip_members
for each row execute function public.bump_trip_revision();

drop trigger if exists expenses_bump_revision on public.expenses;
create trigger expenses_bump_revision after insert or update or delete on public.expenses
for each row execute function public.bump_trip_revision();

drop trigger if exists trip_settlements_bump_revision on public.trip_settlements;
create trigger trip_settlements_bump_revision after insert or update or delete on public.trip_settlements
for each row execute function public.bump_trip_revision();

-- ── Authorization helpers ─────────────────────────────────────────────────
-- SECURITY DEFINER so checking membership cannot recurse through RLS.

create or replace function public.is_trip_owner(p_trip_id text, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id and t.created_by = p_user_id
  );
$$;

create or replace function public.is_trip_member(p_trip_id text, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id and t.created_by = p_user_id
  ) or exists (
    select 1 from public.trip_members m
    where m.trip_id = p_trip_id and m.user_id = p_user_id
  );
$$;

-- The expense creator and the trip owner may edit; every other member is read-only.
create or replace function public.can_edit_expense(p_expense_id text, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.expenses e
    join public.trips t on t.id = e.trip_id
    where e.id = p_expense_id
      and (t.created_by = p_user_id or e.created_by = p_user_id)
  );
$$;

create or replace function public.can_edit_settlement(p_settlement_id text, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.trip_settlements s
    join public.trips t on t.id = s.trip_id
    where s.id = p_settlement_id
      and (t.created_by = p_user_id or s.created_by = p_user_id)
  );
$$;

revoke all on function public.is_trip_owner(text, uuid) from public;
revoke all on function public.is_trip_member(text, uuid) from public;
revoke all on function public.can_edit_expense(text, uuid) from public;
revoke all on function public.can_edit_settlement(text, uuid) from public;
grant execute on function public.is_trip_owner(text, uuid) to authenticated;
grant execute on function public.is_trip_member(text, uuid) to authenticated;
grant execute on function public.can_edit_expense(text, uuid) to authenticated;
grant execute on function public.can_edit_settlement(text, uuid) to authenticated;

-- ── Row-level security ────────────────────────────────────────────────────

alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.expenses enable row level security;
alter table public.trip_settlements enable row level security;

drop policy if exists trips_select_member on public.trips;
create policy trips_select_member on public.trips
for select to authenticated
using (created_by = auth.uid() or public.is_trip_member(id, auth.uid()));

drop policy if exists trips_insert_creator on public.trips;
create policy trips_insert_creator on public.trips
for insert to authenticated
with check (created_by = auth.uid());

drop policy if exists trips_update_owner on public.trips;
create policy trips_update_owner on public.trips
for update to authenticated
using (created_by = auth.uid())
with check (created_by = auth.uid());

drop policy if exists trips_delete_owner on public.trips;
create policy trips_delete_owner on public.trips
for delete to authenticated
using (created_by = auth.uid());

drop policy if exists trip_members_select_member on public.trip_members;
create policy trip_members_select_member on public.trip_members
for select to authenticated
using (public.is_trip_member(trip_id, auth.uid()));

drop policy if exists trip_members_insert_owner on public.trip_members;
create policy trip_members_insert_owner on public.trip_members
for insert to authenticated
with check (public.is_trip_owner(trip_id, auth.uid()));

drop policy if exists trip_members_update_owner_or_self on public.trip_members;
create policy trip_members_update_owner_or_self on public.trip_members
for update to authenticated
using (public.is_trip_owner(trip_id, auth.uid()) or user_id = auth.uid())
with check (public.is_trip_owner(trip_id, auth.uid()) or user_id = auth.uid());

drop policy if exists trip_members_delete_owner on public.trip_members;
create policy trip_members_delete_owner on public.trip_members
for delete to authenticated
using (public.is_trip_owner(trip_id, auth.uid()));

drop policy if exists expenses_select_member on public.expenses;
create policy expenses_select_member on public.expenses
for select to authenticated
using (public.is_trip_member(trip_id, auth.uid()));

drop policy if exists expenses_insert_member on public.expenses;
create policy expenses_insert_member on public.expenses
for insert to authenticated
with check (public.is_trip_member(trip_id, auth.uid()) and created_by = auth.uid());

drop policy if exists expenses_update_creator_or_owner on public.expenses;
create policy expenses_update_creator_or_owner on public.expenses
for update to authenticated
using (public.can_edit_expense(id, auth.uid()))
with check (public.is_trip_member(trip_id, auth.uid()));

drop policy if exists expenses_delete_creator_or_owner on public.expenses;

drop policy if exists settlements_select_member on public.trip_settlements;
create policy settlements_select_member on public.trip_settlements
for select to authenticated
using (public.is_trip_member(trip_id, auth.uid()));

drop policy if exists settlements_insert_member on public.trip_settlements;
create policy settlements_insert_member on public.trip_settlements
for insert to authenticated
with check (public.is_trip_member(trip_id, auth.uid()) and created_by = auth.uid());

drop policy if exists settlements_update_creator_or_owner on public.trip_settlements;
create policy settlements_update_creator_or_owner on public.trip_settlements
for update to authenticated
using (public.can_edit_settlement(id, auth.uid()))
with check (public.is_trip_member(trip_id, auth.uid()));

drop policy if exists settlements_delete_creator_or_owner on public.trip_settlements;

-- Expenses and payments are soft-deleted by the RPCs so their ids stay
-- tombstoned; no direct DELETE grant is needed.
grant select, insert, update, delete on public.trips to authenticated;
grant select, insert, update, delete on public.trip_members to authenticated;
grant select on public.expenses to authenticated;
grant select on public.trip_settlements to authenticated;

-- ── Join / claim RPC ──────────────────────────────────────────────────────

create or replace function public.join_trip_by_code(
  _code text,
  _claim_member_id text default null,
  _home_currency text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_trip public.trips%rowtype;
  v_member public.trip_members%rowtype;
  v_member_access boolean;
begin
  select * into v_trip
  from public.trips
  where invite_code = upper(trim(_code))
    and (invite_expires_at is null or invite_expires_at > now());

  if not found then
    return null;
  end if;

  if _claim_member_id is not null then
    if v_uid is null then
      raise exception 'Sign in to claim a trip member' using errcode = '42501';
    end if;
    select * into v_member
    from public.trip_members
    where trip_id = v_trip.id and id = _claim_member_id
    for update;
    if not found then
      raise exception 'Trip member not found' using errcode = 'P0002';
    end if;
    if v_member.user_id is not null and v_member.user_id <> v_uid then
      raise exception 'Member is already claimed' using errcode = '23505';
    end if;
    if exists (
      select 1
      from public.trip_members m
      where m.trip_id = v_trip.id and m.user_id = v_uid and m.id <> v_member.id
    ) then
      raise exception 'User already owns another member in this trip' using errcode = '23505';
    end if;
    update public.trip_members
    set user_id = v_uid,
        email = coalesce(email, auth.jwt() ->> 'email'),
        home_currency = coalesce(_home_currency, home_currency)
    where id = v_member.id;
  end if;

  v_member_access := v_trip.created_by = v_uid or exists (
    select 1 from public.trip_members m
    where m.trip_id = v_trip.id and m.user_id = v_uid
  );

  return jsonb_build_object(
    'id', v_trip.id,
    'name', v_trip.name,
    'currency', v_trip.currency,
    'baseCurrency', v_trip.currency,
    'budget', v_trip.budget,
    'created_by', case when v_member_access then v_trip.created_by else null end,
    'owner_id', case when v_member_access then v_trip.created_by else null end,
    'invite_code', v_trip.invite_code,
    'code', v_trip.invite_code,
    'invite_expires_at', v_trip.invite_expires_at,
    'revision', v_trip.revision,
    'updated_at', v_trip.updated_at,
    'deleted_expense_ids', v_trip.deleted_expense_ids,
    'deleted_settlement_ids', v_trip.deleted_settlement_ids,
    'trip_members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'display_name', m.display_name,
        'user_id', case when v_member_access then m.user_id else null end,
        'home_currency', m.home_currency,
        'email', case when v_member_access then m.email else null end,
        'avatar_url', m.avatar_url
      ) order by m.created_at, m.id)
      from public.trip_members m
      where m.trip_id = v_trip.id
    ), '[]'::jsonb),
    'expenses', case when v_member_access then coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at, e.id)
      from public.expenses e
      where e.trip_id = v_trip.id and e.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'trip_settlements', case when v_member_access then coalesce((
      select jsonb_agg(to_jsonb(s) order by s.created_at, s.id)
      from public.trip_settlements s
      where s.trip_id = v_trip.id and s.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

revoke all on function public.join_trip_by_code(text, text, text) from public;
grant execute on function public.join_trip_by_code(text, text, text) to authenticated, anon;

-- ── Realtime polling helper ───────────────────────────────────────────────
-- Every write path above advances the trip revision, including direct table
-- updates. Clients can request `revision` cheaply and fetch the whole row only
-- when it changed.

create or replace function public.trip_revision(p_trip_id text)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.revision from public.trips t
  where t.id = p_trip_id and public.is_trip_member(t.id, auth.uid());
$$;

revoke all on function public.trip_revision(text) from public;
grant execute on function public.trip_revision(text) to authenticated;

-- ── Date helper ───────────────────────────────────────────────────────────
-- Casting an empty string to date raises, so give a clear error instead.

create or replace function public.coerce_date(p_value text)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Invalid date' using errcode = '22007';
  end if;
  return p_value::date;
end;
$$;

revoke all on function public.coerce_date(text) from public;

-- ── Expense write RPC ─────────────────────────────────────────────────────

create or replace function public.upsert_expense(
  p_expense jsonb,
  p_base_rev bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_trip_id text := p_expense ->> 'trip_id';
  v_existing public.expenses%rowtype;
  v_row public.expenses%rowtype;
  v_rev bigint;
  v_amount numeric;
  v_rate numeric;
  v_deleted timestamptz := nullif(p_expense ->> 'deleted_at', '')::timestamptz;
  v_owner boolean;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if v_trip_id is null or not public.is_trip_member(v_trip_id, v_uid) then
    raise exception 'Not a member of this trip' using errcode = '42501';
  end if;
  v_owner := public.is_trip_owner(v_trip_id, v_uid);

  select * into v_existing from public.expenses where id = p_expense ->> 'id' for update;

  if found and v_existing.trip_id <> v_trip_id then
    raise exception 'Expense does not belong to this trip' using errcode = '23514';
  end if;

  if found then
    if not v_owner and v_existing.created_by is distinct from v_uid then
      raise exception 'Only the expense creator or trip owner can edit this expense' using errcode = '42501';
    end if;
    if p_base_rev is not null and v_existing.revision <> p_base_rev then
      if v_existing.deleted_at is not null then
        raise exception 'expense_deleted' using errcode = '40001';
      end if;
      raise exception 'expense_conflict' using errcode = '40001';
    end if;

    update public.trips
    set revision = revision + 1
    where id = v_trip_id
    returning revision into v_rev;

    if v_deleted is not null then
      update public.expenses
      set deleted_at = v_deleted, revision = v_rev
      where id = v_existing.id
      returning * into v_row;
      update public.trips
      set deleted_expense_ids = case
        when deleted_expense_ids ? v_row.id then deleted_expense_ids
        else deleted_expense_ids || to_jsonb(v_row.id) end
      where id = v_trip_id;
      return to_jsonb(v_row);
    end if;

    v_amount := coalesce((p_expense ->> 'amount')::numeric, v_existing.amount);
    v_rate := coalesce((p_expense ->> 'rate_to_base')::numeric, v_existing.rate_to_base);
    if v_amount <= 0 or v_rate <= 0 then
      raise exception 'Expense amount and rate must be greater than zero' using errcode = '23514';
    end if;

    update public.expenses set
      title = case when p_expense ? 'title' then p_expense ->> 'title' else v_existing.title end,
      description = coalesce(p_expense ->> 'description', v_existing.description),
      amount = v_amount,
      currency = coalesce(p_expense ->> 'currency', v_existing.currency),
      rate_to_base = v_rate,
      rate_source = case when p_expense ? 'rate_source' then p_expense ->> 'rate_source' else v_existing.rate_source end,
      rate_fetched_at = case when p_expense ? 'rate_fetched_at' then nullif(p_expense ->> 'rate_fetched_at', '')::timestamptz else v_existing.rate_fetched_at end,
      paid_by = coalesce(p_expense ->> 'paid_by', v_existing.paid_by),
      category = coalesce(p_expense ->> 'category', v_existing.category),
      date = case when p_expense ? 'date' and nullif(p_expense ->> 'date', '') is not null
        then public.coerce_date(p_expense ->> 'date') else v_existing.date end,
      receipt_data = case when p_expense ? 'receipt_data' then p_expense -> 'receipt_data' else v_existing.receipt_data end,
      split_definition = case when p_expense ? 'split_definition' then p_expense -> 'split_definition' else v_existing.split_definition end,
      needs_review = case when p_expense ? 'needs_review' then (p_expense ->> 'needs_review')::boolean else v_existing.needs_review end,
      revision = v_rev
    where id = v_existing.id
    returning * into v_row;
  else
    if v_deleted is not null then
      -- Deleting an already-deleted expense is a harmless retry.
      return null;
    end if;
    v_amount := (p_expense ->> 'amount')::numeric;
    v_rate := (p_expense ->> 'rate_to_base')::numeric;
    if v_amount is null or v_amount <= 0 or v_rate is null or v_rate <= 0 then
      raise exception 'Expense amount and rate must be greater than zero' using errcode = '23514';
    end if;
    if (p_expense ->> 'currency') !~ '^[A-Z]{3}$' then
      raise exception 'Invalid currency' using errcode = '23514';
    end if;

    update public.trips
    set revision = revision + 1
    where id = v_trip_id
    returning revision into v_rev;

    insert into public.expenses (
      id, trip_id, title, description, amount, currency, rate_to_base,
      rate_source, rate_fetched_at, paid_by, created_by, category, date,
      receipt_data, split_definition, needs_review, revision, created_at, updated_at
    ) values (
      p_expense ->> 'id', v_trip_id,
      p_expense ->> 'title', coalesce(p_expense ->> 'description', ''),
      v_amount, p_expense ->> 'currency', v_rate,
      p_expense ->> 'rate_source', nullif(p_expense ->> 'rate_fetched_at', '')::timestamptz,
      p_expense ->> 'paid_by', v_uid,
      coalesce(p_expense ->> 'category', 'other'),
      coerce_date(p_expense ->> 'date'),
      p_expense -> 'receipt_data', coalesce(p_expense -> 'split_definition', '{"type":"equal","memberIds":[]}'::jsonb),
      coalesce((p_expense ->> 'needs_review')::boolean, false),
      v_rev, now(), now()
    ) returning * into v_row;
  end if;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.upsert_expense(jsonb, bigint) from public;
grant execute on function public.upsert_expense(jsonb, bigint) to authenticated;

-- ── Settlement write RPC ──────────────────────────────────────────────────

create or replace function public.upsert_settlement(
  p_settlement jsonb,
  p_base_rev bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_trip_id text := p_settlement ->> 'trip_id';
  v_existing public.trip_settlements%rowtype;
  v_row public.trip_settlements%rowtype;
  v_rev bigint;
  v_trip public.trips%rowtype;
  v_amount numeric;
  v_from text;
  v_to text;
  v_currency text;
  v_deleted timestamptz := nullif(p_settlement ->> 'deleted_at', '')::timestamptz;
  v_owner boolean;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if v_trip_id is null or not public.is_trip_member(v_trip_id, v_uid) then
    raise exception 'Not a member of this trip' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = v_trip_id for update;
  v_owner := v_trip.created_by = v_uid;

  select * into v_existing from public.trip_settlements where id = p_settlement ->> 'id' for update;

  if found then
    if v_existing.trip_id <> v_trip_id then
      raise exception 'Payment does not belong to this trip' using errcode = '23514';
    end if;
    if not v_owner and v_existing.created_by is distinct from v_uid then
      raise exception 'Only the person who recorded this payment or the trip owner can change it' using errcode = '42501';
    end if;
    if p_base_rev is not null and v_existing.revision <> p_base_rev then
      if v_existing.deleted_at is not null then
        raise exception 'settlement_deleted' using errcode = '40001';
      end if;
      raise exception 'settlement_conflict' using errcode = '40001';
    end if;

    update public.trips set revision = revision + 1 where id = v_trip_id returning revision into v_rev;

    if v_deleted is not null then
      update public.trip_settlements set deleted_at = v_deleted, revision = v_rev
      where id = v_existing.id returning * into v_row;
      update public.trips
      set deleted_settlement_ids = case
        when deleted_settlement_ids ? v_row.id then deleted_settlement_ids
        else deleted_settlement_ids || to_jsonb(v_row.id) end
      where id = v_trip_id;
      return to_jsonb(v_row);
    end if;

    v_amount := coalesce((p_settlement ->> 'amount')::numeric, v_existing.amount);
    if v_amount <= 0 then
      raise exception 'Payment amount must be greater than zero' using errcode = '23514';
    end if;
    v_from := coalesce(p_settlement ->> 'from_member', v_existing.from_member);
    v_to := coalesce(p_settlement ->> 'to_member', v_existing.to_member);
    v_currency := coalesce(p_settlement ->> 'currency', v_existing.currency);
    if v_from = v_to then
      raise exception 'A payment needs two different people' using errcode = '23514';
    end if;
    if not exists (select 1 from public.trip_members m where m.trip_id = v_trip_id and m.id = v_from)
       or not exists (select 1 from public.trip_members m where m.trip_id = v_trip_id and m.id = v_to) then
      raise exception 'Both people must be members of this trip' using errcode = '23514';
    end if;
    if v_currency <> v_trip.currency then
      raise exception 'Payments are recorded in the trip currency' using errcode = '23514';
    end if;

    update public.trip_settlements set
      from_member = v_from,
      to_member = v_to,
      amount = v_amount,
      currency = v_currency,
      date = case when p_settlement ? 'date' and nullif(p_settlement ->> 'date', '') is not null
        then public.coerce_date(p_settlement ->> 'date') else v_existing.date end,
      method = case when p_settlement ? 'method' then p_settlement ->> 'method' else v_existing.method end,
      note = case when p_settlement ? 'note' then p_settlement ->> 'note' else v_existing.note end,
      revision = v_rev
    where id = v_existing.id returning * into v_row;
  else
    if v_deleted is not null then
      -- Deleting an already-deleted payment is a harmless retry.
      return null;
    end if;
    v_amount := (p_settlement ->> 'amount')::numeric;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Payment amount must be greater than zero' using errcode = '23514';
    end if;
    if (p_settlement ->> 'from_member') = (p_settlement ->> 'to_member') then
      raise exception 'A payment needs two different people' using errcode = '23514';
    end if;
    if not exists (select 1 from public.trip_members m where m.trip_id = v_trip_id and m.id = p_settlement ->> 'from_member')
       or not exists (select 1 from public.trip_members m where m.trip_id = v_trip_id and m.id = p_settlement ->> 'to_member') then
      raise exception 'Both people must be members of this trip' using errcode = '23514';
    end if;
    if coalesce(p_settlement ->> 'currency', v_trip.currency) <> v_trip.currency then
      raise exception 'Payments are recorded in the trip currency' using errcode = '23514';
    end if;

    update public.trips set revision = revision + 1 where id = v_trip_id returning revision into v_rev;

    insert into public.trip_settlements (
      id, trip_id, from_member, to_member, amount, currency, date, method, note,
      created_by, revision, created_at, updated_at
    ) values (
      p_settlement ->> 'id', v_trip_id,
      p_settlement ->> 'from_member', p_settlement ->> 'to_member',
      v_amount, v_trip.currency, coerce_date(p_settlement ->> 'date'),
      p_settlement ->> 'method', p_settlement ->> 'note',
      v_uid, v_rev, now(), now()
    ) returning * into v_row;
  end if;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.upsert_settlement(jsonb, bigint) from public;
grant execute on function public.upsert_settlement(jsonb, bigint) to authenticated;
