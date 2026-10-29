import type { Expense, Member, Trip } from "./types";
import { ApiError } from "./errors";
import { supabase, isSupabaseConfigured } from "./supabase";
import { generateRandomInviteCode } from "./invite";

const directModeEnabled =
  isSupabaseConfigured && process.env.EXPO_PUBLIC_SUPABASE_DATA_MODE !== "legacy";

function secureInviteCode() {
  return generateRandomInviteCode(10);
}

function supabaseErrorStatus(code?: string) {
  if (code === "42501") return 403;
  if (code === "23505") return 409;
  if (code === "PGRST116") return 404;
  if (code === "23503" || code === "23514" || code === "22P02" || code === "P0001" || code?.startsWith("22")) return 400;
  if (code?.startsWith("23")) return 409;
  return 500;
}

/**
 * Whether upsert_expense rejected the edit because p_base_rev no longer matches.
 * The RPC isn't in this repo (see README), so this recognises the usual signals:
 * a serialization failure (40001) or a message naming a stale revision/conflict.
 * Align it with the deployed function.
 */
export function isRevisionConflict(error: { code?: string; message?: string }) {
  return error.code === "40001" || /stale|conflict|revision mismatch|base_rev/i.test(error.message ?? "");
}

async function withDirectSupabase<T>(operation: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  if (!directModeEnabled) return fallback();

  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw error;
  }
}

function toTrip(row: Record<string, any>): Trip {
  return {
    id: row.id,
    code: row.invite_code ?? row.code,
    inviteCode: row.invite_code ?? row.inviteCode,
    name: row.name ?? "",
    baseCurrency: row.currency ?? row.baseCurrency ?? "USD",
    members: Array.isArray(row.trip_members) ? row.trip_members.map(toMember) : [],
    expenses: Array.isArray(row.expenses) ? row.expenses.filter((e) => !e.deleted_at).map(toExpense) : [],
    deletedExpenseIds: Array.isArray(row.deleted_expense_ids) ? row.deleted_expense_ids : [],
    updatedAt: toTimestamp(row.updated_at ?? row.updatedAt),
    ownerId: row.owner_id ?? row.ownerId ?? row.created_by ?? row.createdBy,
    syncEnabled: true,
    revision: Number.isInteger(row.revision) ? row.revision : undefined,
    inviteExpiresAt: row.invite_expires_at ?? row.inviteExpiresAt ?? null,
  };
}

/** RPCs may return the row directly, a one-element array, or { trip: row }. */
export function normalizeTripResponse(value: unknown): Trip {
  const row = Array.isArray(value) ? value[0] : (value as any)?.trip ?? value;
  if (!row || typeof row !== "object") throw new ApiError("Invalid trip response", 502, false);
  return toTrip(row as Record<string, any>);
}

function toTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ApiError("Invalid server timestamp", 502, false);
}

export function joinTripRpcArgs(code: string, claimMemberId: string | null) {
  return { _code: code, _claim_member_id: claimMemberId, _home_currency: null };
}

function toMember(row: Record<string, any>): Member {
  return {
    id: row.id,
    name: row.display_name ?? row.name ?? "Traveller",
    homeCurrency: row.home_currency ?? row.homeCurrency,
    userId: row.user_id ?? row.userId,
    email: row.email,
    avatarUrl: row.avatar_url ?? row.avatarUrl,
  };
}

function toExpense(row: Record<string, any>): Expense {
  const amount = Number(row.amount);
  const rateToBase = Number(row.rate_to_base ?? row.rateToBase);
  // Preserve damaged historical accounting values for explicit repair.
  // inspectLedger withholds all totals until nonpositive/nonfinite values are repaired.
  return {
    id: row.id,
    description: row.description ?? row.title ?? "",
    category: (row.category ?? "other") as Expense["category"],
    amount,
    currency: row.currency ?? "USD",
    rateToBase,
    paidBy: row.paid_by ?? row.paidBy ?? row.created_by ?? "",
    createdBy: row.created_by ?? row.createdBy,
    date: row.date ?? new Date().toISOString().slice(0, 10),
    split:
      typeof row.split_definition === "object" && row.split_definition
        ? row.split_definition
        : { type: "equal", memberIds: [] },
    receipt: (() => {
      const value = row.receipt_data ?? row.receiptData;
      return value && typeof value === "object" && Object.keys(value).length ? value : undefined;
    })(),
    needsReview: Boolean(row.needs_review ?? false),
    createdAt: toTimestamp(row.created_at ?? row.createdAt),
    updatedAt: toTimestamp(row.updated_at ?? row.updatedAt),
    revision: Number.isInteger(row.revision) ? row.revision : undefined,
  };
}

export const supabaseData = {
  enabled: directModeEnabled,
  async listTrips(): Promise<Trip[]> {
    return withDirectSupabase(async () => {
      // RLS restricts this list to trips the authenticated account can read.
      const { data, error } = await supabase.from("trips").select("*, trip_members(*), expenses(*)");
      if (error) throw new ApiError(error.message, supabaseErrorStatus(error.code));
      const trips: Trip[] = [];
      for (const row of data ?? []) {
        try { trips.push(toTrip(row)); }
        catch (error) { console.warn("Skipping unreadable trip", row?.id, error); }
      }
      return trips;
    }, async () => { throw new ApiError("Trip sync is unavailable", 503); });
  },
  async getTrip(id: string, knownVersion?: number): Promise<Trip | null> {
    return withDirectSupabase(async () => {
      const { data, error } = await supabase
        .from("trips")
        .select("*, trip_members(*), expenses(*)")
        .eq("id", id)
        .maybeSingle();

      if (error) throw new ApiError(error.message, supabaseErrorStatus(error.code));
      if (!data) return null;

      const trip = toTrip(data);
      const serverVersion = trip.revision ?? trip.updatedAt;
      if (knownVersion != null && serverVersion <= knownVersion) return null;
      return trip;
    }, async () => { throw new ApiError("Trip sync is unavailable", 503); });
  },

  async createTrip(trip: Trip): Promise<Trip> {
    return withDirectSupabase(async () => {
      const { error } = await supabase
        .from("trips")
        .upsert({
          id: trip.id,
          name: trip.name,
          currency: trip.baseCurrency,
          created_by: (await supabase.auth.getUser()).data.user?.id,
          updated_at: new Date(trip.updatedAt).toISOString(),
        }, { onConflict: "id" })
        .select("*, trip_members(*), expenses(*)")
        .single();

      if (error) throw new ApiError(error.message, supabaseErrorStatus(error.code));
      const createdBy = (await supabase.auth.getUser()).data.user?.id;

      const members = trip.members.map((member) => ({
        id: member.id, trip_id: trip.id, display_name: member.name,
        ...(member.userId !== undefined ? { user_id: member.userId } : {}),
        ...(member.homeCurrency !== undefined ? { home_currency: member.homeCurrency } : {}),
        ...(member.email !== undefined ? { email: member.email } : {}),
        ...(member.avatarUrl !== undefined ? { avatar_url: member.avatarUrl } : {}),
      }));
      if (members.length) {
        const result = await supabase.from("trip_members").upsert(members);
        if (result.error) throw new ApiError(result.error.message, supabaseErrorStatus(result.error.code));
      }
      if (trip.expenses.length) {
        const expenses = trip.expenses.map((expense) => ({
          id: expense.id, trip_id: trip.id, title: expense.description, description: expense.description,
          amount: expense.amount, currency: expense.currency, rate_to_base: expense.rateToBase,
          paid_by: expense.paidBy, created_by: createdBy,
          category: expense.category, date: expense.date, receipt_data: expense.receipt ?? null,
          split_definition: expense.split, needs_review: expense.needsReview ?? false,
          created_at: new Date(expense.createdAt).toISOString(), updated_at: new Date(expense.updatedAt).toISOString(),
        }));
        const result = await supabase.from("expenses").upsert(expenses);
        if (result.error) throw new ApiError(result.error.message, supabaseErrorStatus(result.error.code));
      }
      const created = await supabaseData.getTrip(trip.id);
      if (!created) throw new ApiError("Trip creation returned no trip", 502);
      return created;
    }, async () => { throw new ApiError("Trip creation is unavailable", 503); });
  },

  async joinTrip(
    code: string,
    user?: { id?: string; email?: string; displayName?: string; name?: string; avatarUrl?: string },
  ): Promise<Trip> {
    return withDirectSupabase(async () => {
      const { data, error } = await supabase.rpc("join_trip_by_code", {
        ...joinTripRpcArgs(code, null),
      });

      if (error) {
        throw new ApiError(error.message, supabaseErrorStatus(error.code));
      }
      if (!data) throw new ApiError("Trip not found", 404);
      return normalizeTripResponse(data);
    }, async () => {
      throw new ApiError("Supabase trip join is unavailable", 503);
    });
  },

  async claimMember(code: string, memberId: string, _member?: Member): Promise<Trip> {
    return withDirectSupabase(async () => {
      const { data, error } = await supabase.rpc("join_trip_by_code", {
        ...joinTripRpcArgs(code, memberId),
      });
      if (error) throw new ApiError(error.message, supabaseErrorStatus(error.code));
      return normalizeTripResponse(data);
    }, async () => {
      throw new ApiError("Supabase member claiming is unavailable", 503);
    });
  },

  async regenerateTripInvite(tripId: string): Promise<Trip> {
    return withDirectSupabase(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data, error } = await supabase
          .from("trips")
          .update({
            invite_code: secureInviteCode(),
            invite_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", tripId)
          .select("*, trip_members(*), expenses(*)")
          .single();
        if (!error) return toTrip(data);
        if (error.code !== "23505") throw new ApiError(error.message, supabaseErrorStatus(error.code));
      }
      throw new ApiError("Could not generate a unique invite code", 503);
    }, async () => {
      throw new ApiError("Invite regeneration is unavailable", 503);
    });
  },

  async patchTrip(id: string, patch: Partial<Pick<Trip, "name" | "baseCurrency">>): Promise<Trip> {
    return withDirectSupabase(async () => {
      const { data, error } = await supabase
        .from("trips")
        .update({
          name: patch.name,
          currency: patch.baseCurrency,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*, trip_members(*), expenses(*)")
        .single();

      if (error) throw new ApiError(error.message, supabaseErrorStatus(error.code));
      return toTrip(data);
    }, async () => {
      throw new ApiError("Trip update is unavailable", 503);
    });
  },

  async upsertMember(id: string, member: Member): Promise<Trip> {
    return withDirectSupabase(async () => {
      const { error } = await supabase
        .from("trip_members")
        .upsert({
          id: member.id,
          trip_id: id,
          display_name: member.name,
          ...(member.userId !== undefined ? { user_id: member.userId } : {}),
          ...(member.homeCurrency !== undefined ? { home_currency: member.homeCurrency } : {}),
          ...(member.email !== undefined ? { email: member.email } : {}),
          ...(member.avatarUrl !== undefined ? { avatar_url: member.avatarUrl } : {}),
          updated_at: new Date().toISOString(),
        })
        .select("*")
        .single();

      if (error) throw new ApiError(error.message, supabaseErrorStatus(error.code));
      const trip = await supabaseData.getTrip(id);
      if (!trip) throw new ApiError("Trip not found", 404);
      return trip;
    }, async () => {
      throw new ApiError("Member sync is unavailable", 503);
    });
  },

  async upsertExpense(id: string, expense: Expense): Promise<Trip> {
    return withDirectSupabase(async () => {
      if (!(expense.amount > 0) || !Number.isFinite(expense.amount)) {
        throw new ApiError("Expense amount must be greater than zero", 400);
      }
      const current = await supabaseData.getTrip(id);
      const existing = current?.expenses.find((candidate) => candidate.id === expense.id);
      const { error } = await supabase.rpc("upsert_expense", {
        p_expense: {
          id: expense.id,
          trip_id: id,
          title: expense.description,
          description: expense.description,
          amount: expense.amount,
          currency: expense.currency,
          rate_to_base: expense.rateToBase,
          paid_by: expense.paidBy,
          created_by: existing?.createdBy ?? (await supabase.auth.getUser()).data.user?.id,
          category: expense.category,
          date: expense.date,
          receipt_data: expense.receipt ?? null,
          split_definition: expense.split,
          needs_review: expense.needsReview ?? false,
          updated_at: new Date(expense.updatedAt).toISOString(),
        },
        p_base_rev: expense.revision ?? null,
      });

      if (error) {
        if (isRevisionConflict(error)) {
          // The RPC refused a stale edit; hand back the current copy so the user can review.
          const latest = await supabaseData.getTrip(id).catch(() => null);
          const current = latest?.expenses.find((candidate) => candidate.id === expense.id) ?? null;
          throw new ApiError(error.message, 409, false, {
            code: current ? "expense_conflict" : "expense_deleted", current,
          });
        }
        throw new ApiError(error.message, supabaseErrorStatus(error.code));
      }
      const trip = await supabaseData.getTrip(id);
      if (!trip) throw new ApiError("Trip not found", 404);
      return trip;
    }, async () => {
      throw new ApiError("Expense sync is unavailable", 503);
    });
  },

  async deleteExpense(id: string, expenseId: string): Promise<Trip> {
    return withDirectSupabase(async () => {
      const { error } = await supabase.rpc("upsert_expense", {
        p_expense: {
          id: expenseId,
          trip_id: id,
          deleted_at: new Date().toISOString(),
        },
        p_base_rev: null,
      });

      if (error) throw new ApiError(error.message, supabaseErrorStatus(error.code));
      const trip = await supabaseData.getTrip(id);
      if (!trip) throw new ApiError("Trip not found", 404);
      return trip;
    }, async () => {
      throw new ApiError("Expense deletion is unavailable", 503);
    });
  },
};

export default supabaseData;
