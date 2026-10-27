import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { DuplicateCheckSchema, judgeDuplicate } from "./duplicates.js";
import { androidAssetLinks, appleAppSiteAssociation, invitePage, isValidInviteCode } from "./invite.js";
import { NimNotConfiguredError } from "./nim.js";
import { NotAReceiptError, ScanRefusedError, scanReceipt } from "./receipt.js";
import { TripStore, type Trip } from "./store.js";

// Add helper methods to the trip store when the app uses a newer shape.
if (typeof (TripStore.prototype as unknown as { list?: unknown }).list !== "function") {
  (TripStore.prototype as unknown as { list: () => Trip[] }).list = function (): Trip[] {
    return Array.from((this as unknown as { trips: Map<string, Trip> }).trips.values());
  };
}
if (typeof (TripStore.prototype as unknown as { deleteMember?: unknown }).deleteMember !== "function") {
  (TripStore.prototype as unknown as { deleteMember: (tripId: string, memberId: string) => Promise<Trip | undefined> }).deleteMember = function (tripId: string, memberId: string) {
    return (this as any).mutate(tripId, (trip: Trip) => {
      const initialLen = trip.members.length;
      trip.members = trip.members.filter((m) => m.id !== memberId && m.userId !== memberId);
      if (trip.members.length === initialLen) return false;
    });
  };
}

const store = new TripStore(path.resolve("data", "trips.json"));
const app = express();

// Harden headers to reduce browser-side leaks and clickjacking risk.
app.disable("x-powered-by");

// Security headers and CORS for the mobile app.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Mobile apps send receipt photos in base64, so keep the payload large enough.
app.use(express.json({ limit: "12mb" }));

// Simple in-memory limiter for AI requests.
interface RateLimitEntry {
  timestamps: number[];
}
const aiRateLimitMap = new Map<string, RateLimitEntry>();

export function createAiRateLimiter(options: { windowMs: number; max: number; message: string }) {
  const { windowMs, max, message } = options;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.user?.id
      ? `user:${req.user.id}`
      : `ip:${req.ip || req.socket.remoteAddress || "127.0.0.1"}`;
    const now = Date.now();
    let entry = aiRateLimitMap.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      aiRateLimitMap.set(key, entry);
    }
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
    if (entry.timestamps.length >= max) {
      const oldest = entry.timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ error: message });
      return;
    }
    entry.timestamps.push(now);
    next();
  };
}

export const aiRateLimiter = createAiRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: "Too many scans right now, try again in a minute.",
});

export function resetRateLimits(): void {
  aiRateLimitMap.clear();
}

// Check that the required environment variables are present on startup.
export function validateEnv(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.SUPABASE_URL?.trim()) {
    missing.push("SUPABASE_URL");
  }
  if (!process.env.SUPABASE_ANON_KEY?.trim() && !process.env.SUPABASE_PUBLISHABLE_KEY?.trim()) {
    missing.push("SUPABASE_ANON_KEY");
  }
  if (!process.env.NVIDIA_API_KEY?.trim()) {
    missing.push("NVIDIA_API_KEY");
  }

  if (missing.length > 0) {
    console.warn(`[WARN] Missing environment variables: ${missing.join(", ")}`);
  }
  return { valid: missing.length === 0, missing };
}

const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const MemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  homeCurrency: CurrencySchema.optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
  avatarUrl: z.string().optional(),
});
const ExpenseSchema = z.looseObject({ id: z.string().min(1), updatedAt: z.number() });

function notFound(res: Response) {
  res.status(404).json({ error: "Trip not found" });
}

export function extractParam(param: string | string[] | undefined): string {
  return (Array.isArray(param) ? param[0] : param) ?? "";
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Require Supabase auth for all trip routes.
app.use("/api/trips", requireAuth);

app.get("/api/trips", requireAuth, (req: Request, res: Response) => {
  const userId = req.user!.id;
  const allTrips: Trip[] = (store as any).list();
  const userTrips = allTrips.filter(
    (t) => t.ownerId === userId || t.members.some((m) => m.userId === userId || m.id === userId)
  );
  res.json(userTrips);
});

app.post("/api/trips", requireAuth, async (req: Request, res: Response) => {
  const body = z
    .object({
      id: z.string().min(1),
      name: z.string().min(1).max(80),
      baseCurrency: CurrencySchema,
      members: z.array(MemberSchema).min(1),
      expenses: z.array(ExpenseSchema).default([]),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });
  const tripData = { ...body.data, ownerId: req.user!.id };
  res.json(await store.create(tripData));
});

app.get("/api/trips/:id", requireAuth, (req: Request, res: Response) => {
  const id = extractParam(req.params.id);
  const trip = store.get(id);
  if (!trip) return notFound(res);
  const isMember = trip.ownerId === req.user!.id || trip.members.some(m => m.userId === req.user!.id || m.id === req.user!.id);
  if (!isMember) {
    return res.status(403).json({ error: "Not a member of this trip" });
  }
  res.set("ETag", `"${trip.updatedAt}"`);
  return req.fresh ? res.status(304).end() : res.json(trip);
});

app.post("/api/trips/:id/regenerate-invite", requireAuth, async (req: Request, res: Response) => {
  const id = extractParam(req.params.id);
  const trip = store.get(id);
  if (!trip) return notFound(res);

  // Always require authentication and ownership check
  if (trip.ownerId !== req.user!.id) {
    return res.status(403).json({ error: "Only the trip owner can regenerate the invite code." });
  }

  try {
    const updated = await store.regenerateInvite(id);
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Failed to regenerate invite" });
  }
});

app.get("/api/join/:code", requireAuth, (req: Request, res: Response) => {
  const code = extractParam(req.params.code);
  const trip = store.findByCode(code);
  if (!trip) return res.status(404).json({ error: "No trip with that code or invite has expired" });

  // Check if user is already a member
  const isMember = trip.members.some(m => m.userId === req.user!.id || m.id === req.user!.id);
  if (!isMember) {
    return res.status(403).json({ error: "Not a member of this trip" });
  }

  return res.json(trip);
});

app.post("/api/join/:code", requireAuth, async (req: Request, res: Response) => {
  const code = extractParam(req.params.code);
  const trip = store.findByCode(code);
  if (!trip) {
    return res.status(404).json({ error: "No trip with that code or invite has expired" });
  }

  // Use authenticated user's info, not request body
  const user = req.user!;
  const userId = user.id;
  const userEmail = user.email;
  const userName =
    (user.user_metadata?.full_name as string) ||
    (user.user_metadata?.name as string) ||
    (userEmail ? userEmail.split("@")[0] : undefined);
  const avatarUrl =
    (user.user_metadata?.avatar_url as string) ||
    (user.user_metadata?.picture as string);

  const updated = await store.bindMember(trip.id, {
    userId,
    email: userEmail,
    name: userName,
    avatarUrl,
  });
  return res.json(updated ?? trip);
});

app.patch("/api/trips/:id", requireAuth, async (req: Request, res: Response) => {
  const body = z
    .object({ name: z.string().min(1).max(80).optional(), baseCurrency: CurrencySchema.optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  const id = extractParam(req.params.id);
  const trip = store.get(id);
  if (!trip) return notFound(res);

  // Check if user is the owner
  if (trip.ownerId !== req.user!.id) {
    return res.status(403).json({ error: "Only the trip owner can update the trip" });
  }

  const updated = await store.update(id, body.data);
  return updated ? res.json(updated) : notFound(res);
});

app.put("/api/trips/:id/members/:memberId", requireAuth, async (req: Request, res: Response) => {
  const memberId = extractParam(req.params.memberId);
  const body = MemberSchema.safeParse({ ...req.body, id: memberId });
  if (!body.success) return res.status(400).json({ error: body.error.message });

  const id = extractParam(req.params.id);
  const trip = store.get(id);
  if (!trip) return notFound(res);

  // Check if user is the owner
  if (trip.ownerId !== req.user!.id) {
    return res.status(403).json({ error: "Only the trip owner can manage members" });
  }

  const updated = await store.upsertMember(id, body.data);
  return updated ? res.json(updated) : notFound(res);
});

app.delete("/api/trips/:id/members/:memberId", requireAuth, async (req: Request, res: Response) => {
  const id = extractParam(req.params.id);
  const memberId = extractParam(req.params.memberId);
  const trip = store.get(id);
  if (!trip) return notFound(res);

  // Check if user is the owner
  if (trip.ownerId !== req.user!.id) {
    return res.status(403).json({ error: "Only the trip owner can manage members" });
  }

  const updated = await (store as any).deleteMember(id, memberId);
  return updated ? res.json(updated) : notFound(res);
});

app.put("/api/trips/:id/expenses/:expenseId", requireAuth, async (req: Request, res: Response) => {
  const expenseId = extractParam(req.params.expenseId);
  const body = ExpenseSchema.safeParse({ ...req.body, id: expenseId });
  if (!body.success) return res.status(400).json({ error: body.error.message });

  const id = extractParam(req.params.id);
  const trip = store.get(id);
  if (!trip) return notFound(res);

  // Check if user is a member of this trip or owner
  const isMember = trip.ownerId === req.user!.id || trip.members.some(m => m.userId === req.user!.id || m.id === req.user!.id);
  if (!isMember) {
    return res.status(403).json({ error: "Not a member of this trip" });
  }

  const updated = await store.upsertExpense(id, body.data);
  return updated ? res.json(updated) : notFound(res);
});

app.delete("/api/trips/:id/expenses/:expenseId", requireAuth, async (req: Request, res: Response) => {
  const id = extractParam(req.params.id);
  const expenseId = extractParam(req.params.expenseId);
  const trip = store.get(id);
  if (!trip) return notFound(res);

  // Check if user is a member of this trip or owner
  const isMember = trip.ownerId === req.user!.id || trip.members.some(m => m.userId === req.user!.id || m.id === req.user!.id);
  if (!isMember) {
    return res.status(403).json({ error: "Not a member of this trip" });
  }

  const updated = await store.deleteExpense(id, expenseId);
  return updated ? res.json(updated) : notFound(res);
});

// Invite links: the page a phone camera opens from a trip's QR code, plus the
// files iOS and Android check before opening such links in the app directly.
app.get("/join/:code", (req, res) => {
  const code = extractParam(req.params.code);
  if (!isValidInviteCode(code)) {
    return res.status(404).type("html").send(invitePage(undefined));
  }
  const trip = store.findByCode(code);
  res.status(trip ? 200 : 404).type("html").send(invitePage(trip));
});

app.get("/.well-known/apple-app-site-association", (_req, res) => {
  const body = appleAppSiteAssociation();
  return body ? res.json(body) : res.sendStatus(404);
});

app.get("/.well-known/assetlinks.json", (_req, res) => {
  const body = androidAssetLinks();
  return body ? res.json(body) : res.sendStatus(404);
});

async function handleScanReceipt(req: Request, res: Response) {
  const body = z
    .object({
      imageBase64: z.string().min(100).max(7_000_000),
      mediaType: z
        .enum(["image/jpeg", "image/png", "image/webp", "image/heic"])
        .default("image/jpeg"),
      targetLanguage: z.string().min(2).max(40).default("English"),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  try {
    res.json(await scanReceipt(body.data));
  } catch (err) {
    sendNIMError(res, err);
  }
}

const DuplicateCheckExtendedSchema = DuplicateCheckSchema.extend({
  tripId: z.string().optional(),
});

async function handleCheckDuplicate(req: Request, res: Response) {
  const body = DuplicateCheckExtendedSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  const tripId = body.data.tripId;
  let matchingTrip: Trip | undefined = undefined;

  if (tripId) {
    matchingTrip = store.get(tripId);
    if (!matchingTrip) {
      return notFound(res);
    }
  } else {
    const candidateIds = new Set(body.data.candidates.map((c) => c.id));
    const allTrips: Trip[] = (store as any).list();
    matchingTrip = allTrips.find((t) => t.expenses.some((e) => candidateIds.has(e.id)));
  }

  if (matchingTrip) {
    const userId = req.user!.id;
    const isMember =
      matchingTrip.ownerId === userId ||
      matchingTrip.members.some((m) => m.userId === userId || m.id === userId);
    if (!isMember) {
      return res.status(403).json({ error: "You are not a member of this trip." });
    }
  }

  try {
    res.json(await judgeDuplicate(body.data));
  } catch (err) {
    sendNIMError(res, err);
  }
}

// Protected AI Endpoints (require Supabase JWT and rate limiting)
app.post("/api/scan-receipt", requireAuth, aiRateLimiter, handleScanReceipt);
app.post("/api/check-duplicate", requireAuth, aiRateLimiter, handleCheckDuplicate);
app.post("/api/check-duplicates", requireAuth, aiRateLimiter, handleCheckDuplicate);

function sanitizeErrorMessage(msg: string): string {
  const sensitivePatterns = [
    /select\s+.*?\s+from/i,
    /insert\s+into/i,
    /update\s+.*?\s+set/i,
    /delete\s+from/i,
    /password/i,
    /secret/i,
    /api[_-]?key/i,
    /token/i,
    /bearer\s+/i,
    /raw text snippet/i,
    /\bat\s+.+:\d+:\d+/i,
    /stack\s+trace/i,
    /system_prompt/i,
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(msg)) {
      return "Scan failed";
    }
  }

  if (msg.length > 200) {
    return "Scan failed";
  }

  return msg;
}

export function sendNIMError(res: Response, err: unknown) {
  if (err instanceof NotAReceiptError || err instanceof ScanRefusedError) {
    return res.status(422).json({ error: err.message });
  }
  if (
    err instanceof NimNotConfiguredError ||
    err instanceof OpenAI.AuthenticationError ||
    (err instanceof Error && err.name === "NimNotConfiguredError") ||
    (err instanceof Error && err.message.includes("Receipt scanning is not configured"))
  ) {
    console.error("NVIDIA NIM API key is missing or invalid");
    return res.status(500).json({ error: "Receipt scanning is not configured on the server." });
  }
  if (
    err instanceof OpenAI.RateLimitError ||
    (typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 429)
  ) {
    return res.status(429).json({ error: "Too many scans right now, try again in a minute." });
  }
  if (
    err instanceof OpenAI.BadRequestError ||
    (typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 400) ||
    (err instanceof Error && (err.message.toLowerCase().includes("invalid image") || err.message.toLowerCase().includes("bad request")))
  ) {
    console.error("NVIDIA API bad request:", err instanceof Error ? err.message : err);
    return res.status(400).json({ error: "Invalid image or receipt scan request." });
  }
  if (
    (typeof err === "object" && err !== null && (
      ("status" in err && ((err as { status: unknown }).status === 502 || (err as { status: unknown }).status === 503)) ||
      ("code" in err && (err as { code: unknown }).code === "ECONNREFUSED") ||
      err instanceof OpenAI.APIConnectionError
    )) ||
    (err instanceof OpenAI.APIError && (err.status === 502 || err.status === 503))
  ) {
    console.error("NVIDIA API error:", err instanceof Error ? err.message : err);
    return res.status(502).json({ error: "The receipt reader is unavailable, try again." });
  }
  console.error("Server error:", err);
  const rawMessage = err instanceof Error ? err.message : "Scan failed";
  res.status(500).json({ error: sanitizeErrorMessage(rawMessage) });
}

// Global Express error handler (Express 5)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    return;
  }
  console.error("Unhandled error:", err);
  if (typeof err === "object" && err !== null) {
    const errorObj = err as Record<string, unknown>;
    if (errorObj.status === 400 || errorObj.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Malformed request payload" });
    }
    if (errorObj.status === 413 || errorObj.type === "entity.too.large") {
      return res.status(400).json({ error: "Payload too large" });
    }
    if (typeof errorObj.status === "number" && errorObj.status >= 400 && errorObj.status < 500) {
      return res.status(errorObj.status).json({
        error: typeof errorObj.message === "string" ? errorObj.message : "Bad request",
      });
    }
  }
  res.status(500).json({ error: "Internal server error" });
});

export { app };

const port = Number(process.env.PORT ?? 4000);
await store.load();
if (process.env.NODE_ENV !== "test") {
  validateEnv();
  app.listen(port, "0.0.0.0", () => {
    console.log(`Deochipei API listening on http://0.0.0.0:${port}`);
  });
}
