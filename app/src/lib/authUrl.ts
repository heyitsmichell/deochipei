import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

const exchangedCodes = new Set<string>();
const inFlightCodes = new Map<string, Promise<Session | null>>();

export function extractParamsFromUrl(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!url) return params;

  const rawParts = url.split(/[?#]/);
  for (const part of rawParts.slice(1)) {
    if (!part) continue;

    const pairs = part.split("&");
    for (const pair of pairs) {
      if (!pair) continue;

      const separator = pair.indexOf("=");
      const rawKey = separator < 0 ? pair : pair.slice(0, separator);
      const rawValue = separator < 0 ? "" : pair.slice(separator + 1);
      if (!rawKey) continue;

      let key: string;
      let value: string;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " "));
        value = decodeURIComponent(rawValue.replace(/\+/g, " "));
      } catch { continue; }
      params[key] = value;
    }
  }

  return params;
}

export async function handleAuthUrl(url: string): Promise<Session | null> {
  const params = extractParamsFromUrl(url);

  // This app uses PKCE; bearer tokens in arbitrary deep links are unsafe.
  if (params.code) {
    if (exchangedCodes.has(params.code)) {
      return (await supabase.auth.getSession()).data.session;
    }
    const inFlight = inFlightCodes.get(params.code);
    if (inFlight) return inFlight;
    const exchange = (async () => {
      const { data, error } = await supabase.auth.exchangeCodeForSession(params.code);
      if (error) throw error;
      exchangedCodes.add(params.code!);
      if (exchangedCodes.size > 100) exchangedCodes.delete(exchangedCodes.values().next().value as string);
      return data.session;
    })();
    inFlightCodes.set(params.code, exchange);
    try {
      return await exchange;
    } finally {
      inFlightCodes.delete(params.code);
    }
  }

  return null;
}

export function isAuthCallbackUrl(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0].replace(/^[^:]+:\/\//, "/").replace(/\/+$/, "");
  return path === "/auth/callback" || path.endsWith("/auth/callback");
}
