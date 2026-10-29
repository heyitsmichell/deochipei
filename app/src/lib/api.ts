import Constants from "expo-constants";
import type { DuplicateCheckRequest, DuplicateVerdict } from "./duplicates";
import { ApiError } from "./errors";
import { supabaseData } from "./supabaseData";
import { supabase } from "./supabase";
import type { Expense, Member, ReceiptScan, Settlement, Trip, TripLookup, TripPatch } from "./types";

const API_PORT = 4000;

/**
 * EXPO_PUBLIC_API_URL wins. Otherwise, in development, assume the API runs on
 * the same machine as the Expo dev server so phones on the LAN just work.
 */
function resolveApiUrl() {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  return `http://${host || "localhost"}:${API_PORT}`;
}

export const API_URL = resolveApiUrl();

/**
 * A public https site serving /join/<code> invite pages (the API server does,
 * see server/src/invite.ts). When set, invite QR codes use it, so any phone
 * camera can open them; otherwise they're deep links straight into the app.
 */
export const INVITE_URL = process.env.EXPO_PUBLIC_INVITE_URL?.replace(/\/$/, "") || null;

export { ApiError };

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number; requiresAuth?: boolean }): Promise<T> {
  const { timeoutMs = 10000, requiresAuth = false, ...requestInit } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    };

    let authenticated = false;
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.access_token) {
        headers["Authorization"] = "Bearer " + session.access_token;
        authenticated = true;
      }
    } catch {
      // In offline or testing mode where session retrieval fails, proceed without header
    }

    if (requiresAuth && !authenticated) {
      throw new ApiError("Sign in to scan receipts.", 401, false, { code: "auth_required" });
    }

    const res = await fetch(API_URL + path, {
      ...requestInit,
      signal: controller.signal,
      headers,
    });
    // Only a conditional GET (getTrip with a known version) gets this, and it has no body.
    if (res.status === 304) return null as T;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = requiresAuth && res.status === 401
        ? "Your sign-in expired. Sign in again to scan receipts."
        : body.error ?? `Request failed (${res.status})`;
      throw new ApiError(message, res.status, body.retryable, body);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

const legacyApi = {
  listTrips: () => request<Trip[]>("/api/trips"),
  createTrip: (trip: Trip) => request<Trip>("/api/trips", { method: "POST", body: JSON.stringify(trip) }),
  /**
   * The server's copy of a trip, or null if it's still at `knownVersion` (the
   * server revision of the copy on this phone). Polling mostly finds nothing new,
   * so this saves downloading the whole trip every few seconds.
   */
  getTrip: (id: string, knownVersion?: number) =>
    request<Trip | null>(
      `/api/trips/${id}`,
      knownVersion != null ? { headers: { "if-none-match": `"${knownVersion}"` } } : undefined,
    ),
  joinTrip: (code: string, user?: { id?: string; email?: string; displayName?: string; name?: string; avatarUrl?: string }) =>
    request<TripLookup>(`/api/join/${encodeURIComponent(code.trim())}`, {
      method: "POST",
      body: user ? JSON.stringify(user) : undefined,
    }),
  claimMember: (code: string, memberId: string, member?: Member) => request<Trip>(`/api/join/${encodeURIComponent(code.trim())}`, {
    method: "POST", body: JSON.stringify({ claimMemberId: memberId, ...(member ? { member } : {}) }),
  }),
  regenerateTripInvite: (tripId: string) =>
    request<Trip>(`/api/trips/${tripId}/regenerate-invite`, { method: "POST" }),
  patchTrip: (id: string, patch: TripPatch) =>
    request<Trip>(`/api/trips/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  upsertMember: (id: string, m: Member) => request<Trip>(`/api/trips/${id}/members/${m.id}`, put(m)),
  // `revision` is what this edit started from; the server refuses the write (409) if it has moved on.
  upsertExpense: (id: string, e: Expense) => {
    const { revision, ...rest } = e;
    return request<Trip>(`/api/trips/${id}/expenses/${e.id}`, put(revision != null ? { ...rest, baseRevision: revision } : rest));
  },
  deleteExpense: (id: string, expenseId: string) =>
    request<Trip>(`/api/trips/${id}/expenses/${expenseId}`, { method: "DELETE" }),
  upsertSettlement: (id: string, settlement: Settlement) => {
    const { revision, ...rest } = settlement;
    return request<Trip>(
      `/api/trips/${id}/settlements/${settlement.id}`,
      put(revision != null ? { ...rest, baseRevision: revision } : rest),
    );
  },
  deleteSettlement: (id: string, settlementId: string) =>
    request<Trip>(`/api/trips/${id}/settlements/${settlementId}`, { method: "DELETE" }),
  scanReceipt: (imageBase64: string, targetLanguage: string) =>
    request<ReceiptScan>("/api/scan-receipt", {
      method: "POST",
      body: JSON.stringify({ imageBase64, mediaType: "image/jpeg", targetLanguage }),
      // Reading a long foreign-language receipt can take a while.
      timeoutMs: 120000,
      requiresAuth: true,
    }),
  checkDuplicate: (check: DuplicateCheckRequest) =>
    request<DuplicateVerdict>("/api/check-duplicate", {
      method: "POST",
      body: JSON.stringify(check),
      timeoutMs: 60000,
      requiresAuth: true,
    }),
};

const useDirectSupabase =
  Boolean(process.env.EXPO_PUBLIC_SUPABASE_DATA_MODE === "direct") && Boolean(supabaseData.enabled);

export const canAddSelfOnJoin = !useDirectSupabase;

export const api = useDirectSupabase
  ? {
      listTrips: supabaseData.listTrips,
      createTrip: supabaseData.createTrip,
      getTrip: supabaseData.getTrip,
      joinTrip: supabaseData.joinTrip,
      claimMember: supabaseData.claimMember,
      regenerateTripInvite: supabaseData.regenerateTripInvite,
      patchTrip: supabaseData.patchTrip,
      upsertMember: supabaseData.upsertMember,
      upsertExpense: supabaseData.upsertExpense,
      deleteExpense: supabaseData.deleteExpense,
      upsertSettlement: supabaseData.upsertSettlement,
      deleteSettlement: supabaseData.deleteSettlement,
      scanReceipt: legacyApi.scanReceipt,
      checkDuplicate: legacyApi.checkDuplicate,
    }
  : legacyApi;
