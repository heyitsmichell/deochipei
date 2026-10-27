import type { Expense, Member, Trip } from "./types";
import { ApiError } from "./errors";
import { supabase, isSupabaseConfigured } from "./supabase";

const directModeEnabled =
  isSupabaseConfigured && process.env.EXPO_PUBLIC_SUPABASE_DATA_MODE !== "legacy";

async function withDirectSupabase<T>(operation: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  if (!directModeEnabled) return fallback();

  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    return fallback();
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
    expenses: Array.isArray(row.expenses) ? row.expenses.map(toExpense) : [],
    deletedExpenseIds: Array.isArray(row.deleted_expense_ids) ? row.deleted_expense_ids : [],
    updatedAt: Number(row.updated_at ?? row.updatedAt ?? Date.now()),
    ownerId: row.owner_id ?? row.ownerId,
    inviteExpiresAt: row.invite_expires_at ?? row.inviteExpiresAt ?? null,
  };
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
  return {
    id: row.id,
    description: row.description ?? row.title ?? "",
    category: (row.category ?? "other") as Expense["category"],
    amount: Number(row.amount ?? 0),
    currency: row.currency ?? "USD",
    rateToBase: Number(row.rate_to_base ?? row.rateToBase ?? 1),
    paidBy: row.paid_by ?? row.paidBy ?? row.created_by ?? "",
    date: row.date ?? new Date().toISOString().slice(0, 10),
    split:
      typeof row.split_definition === "object" && row.split_definition
        ? row.split_definition
        : { type: "equal", memberIds: [] },
    receipt: row.receipt_data ?? row.receiptData,
    needsReview: Boolean(row.needs_review ?? false),
    createdAt: Number(row.created_at ?? row.createdAt ?? Date.now()),
    updatedAt: Number(row.updated_at ?? row.updatedAt ?? Date.now()),
  };
}

export const supabaseData = {
  enabled: directModeEnabled,
  async getTrip(id: string, knownVersion?: number): Promise<Trip | null> {
    return withDirectSupabase(async () => {
      const { data, error } = await supabase
        .from("trips")
        .select("*, trip_members(*), expenses(*)")
        .eq("id", id)
        .maybeSingle();

      if (error) throw new ApiError(error.message, 500);
      if (!data) return null;

      const trip = toTrip(data);
      if (knownVersion != null && trip.updatedAt <= knownVersion) return null;
      return trip;
    }, async () => null);
  },

  async createTrip(trip: Trip): Promise<Trip> {
    return withDirectSupabase(async () => {
      const { data, error } = await supabase
        .from("trips")
        .insert({
          id: trip.id,
          name: trip.name,
          currency: trip.baseCurrency,
          created_by: (await supabase.auth.getUser()).data.user?.id,
          updated_at: new Date(trip.updatedAt).toISOString(),
        })
        .select("*, trip_members(*), expenses(*)")
        .single();

      if (error) throw new ApiError(error.message, 500);
      return toTrip(data);
    }, async () => trip);
  },

  async joinTrip(
    code: string,
    user?: { id?: string; email?: string; displayName?: string; name?: string; avatarUrl?: string },
  ): Promise<Trip> {
    return withDirectSupabase(async () => {
      const { data, error } = await supabase.rpc("join_trip_by_code", {
        _code: code,
        _claim_member_id: null,
        _home_currency: user?.email?.includes("@") ? "USD" : undefined,
      });

      if (error) throw new ApiError(error.message, error.code ? Number(error.code) || 500 : 500);
      if (!data) throw new ApiError("Trip not found", 404);
      return data as Trip;
    }, async () => {
      throw new ApiError("Supabase trip join is unavailable", 503);
    });
  },

  async regenerateTripInvite(tripId: string): Promise<Trip> {
    return withDirectSupabase(async () => {
      const { data, error } = await supabase
        .from("trips")
        .update({
          invite_code: Math.random().toString(36).slice(2, 8).toUpperCase(),
          invite_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", tripId)
        .select("*, trip_members(*), expenses(*)")
        .single();

      if (error) throw new ApiError(error.message, 500);
      return toTrip(data);
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

      if (error) throw new ApiError(error.message, 500);
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
          user_id: member.userId ?? null,
          display_name: member.name,
          home_currency: member.homeCurrency ?? "USD",
          email: member.email,
          avatar_url: member.avatarUrl,
          updated_at: new Date().toISOString(),
        })
        .select("*")
        .single();

      if (error) throw new ApiError(error.message, 500);
      const trip = await this.getTrip(id);
      if (!trip) throw new ApiError("Trip not found", 404);
      return trip;
    }, async () => {
      throw new ApiError("Member sync is unavailable", 503);
    });
  },

  async upsertExpense(id: string, expense: Expense): Promise<Trip> {
    return withDirectSupabase(async () => {
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
          created_by: (await supabase.auth.getUser()).data.user?.id,
          category: expense.category,
          date: expense.date,
          receipt_data: expense.receipt ?? {},
          split_definition: expense.split,
          needs_review: expense.needsReview ?? false,
          updated_at: new Date(expense.updatedAt).toISOString(),
        },
        p_base_rev: null,
      });

      if (error) throw new ApiError(error.message, 500);
      const trip = await this.getTrip(id);
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

      if (error) throw new ApiError(error.message, 500);
      const trip = await this.getTrip(id);
      if (!trip) throw new ApiError("Trip not found", 404);
      return trip;
    }, async () => {
      throw new ApiError("Expense deletion is unavailable", 503);
    });
  },
};

export default supabaseData;
