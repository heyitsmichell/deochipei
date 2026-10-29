import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { Request, Response, NextFunction } from "express";

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

// Polyfill WebSocket for Node < 22 so @supabase/supabase-js realtime client doesn't throw
if (typeof (globalThis as unknown as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = class WebSocket {};
}

type AuthUserLike = Pick<User, "id"> & Partial<Pick<User, "email" | "user_metadata">>;
type AuthClientLike = {
  auth: {
    getUser(token: string): Promise<{ data: { user: AuthUserLike | null }; error: unknown }>;
  };
};

let supabaseInstance: SupabaseClient | null = null;
let lastUrl: string | undefined = undefined;
let lastKey: string | undefined = undefined;
let testSupabaseClient: AuthClientLike | null = null;

export function setSupabaseClientForTesting(client: AuthClientLike | null): void {
  testSupabaseClient = client;
}

export function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();

  if (!url || !key) {
    return null;
  }

  if (testSupabaseClient) {
    return testSupabaseClient as SupabaseClient;
  }

  if (!supabaseInstance || lastUrl !== url || lastKey !== key) {
    try {
      supabaseInstance = createClient(url, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
      lastUrl = url;
      lastKey = key;
    } catch (err) {
      console.error("Failed to initialize Supabase client:", err);
      return null;
    }
  }

  return supabaseInstance;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (process.env.NODE_ENV === "test" && req.user) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const match = authHeader.match(/^Bearer\s+(\S.*)$/i);
  if (!match || !match[1]?.trim()) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = match[1].trim();

  const supabase = getSupabaseClient();
  if (!supabase) {
    res.status(500).json({ error: "Authentication service not configured on server" });
    return;
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: "Invalid or expired authorization token" });
      return;
    }

    req.user = data.user;
    next();
  } catch (err) {
    console.error("Error validating Supabase auth token:", err instanceof Error ? err.message : String(err));
    res.status(401).json({ error: "Invalid or expired authorization token" });
  }
}
