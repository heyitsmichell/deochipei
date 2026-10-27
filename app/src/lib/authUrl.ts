import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export function extractParamsFromUrl(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!url) return params;

  const rawParts = url.split(/[?#]/);
  for (const part of rawParts.slice(1)) {
    if (!part) continue;

    const pairs = part.split("&");
    for (const pair of pairs) {
      if (!pair) continue;

      const [rawKey, rawValue = ""] = pair.split("=");
      if (!rawKey) continue;

      const key = decodeURIComponent(rawKey);
      const value = decodeURIComponent(rawValue);
      params[key] = value;
    }
  }

  return params;
}

export async function handleAuthUrl(url: string): Promise<Session | null> {
  const params = extractParamsFromUrl(url);

  if (params.access_token || params.refresh_token) {
    if (!params.access_token || !params.refresh_token) return null;

    const { data, error } = await supabase.auth.setSession({
      access_token: params.access_token,
      refresh_token: params.refresh_token,
    });
    if (error) throw error;
    return data.session;
  }

  if (params.code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) throw error;
    return data.session;
  }

  return null;
}
