import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { ExpenseSchema } from "./expense.js";
import { requireAuth } from "./auth.js";
import { allowedOrigin } from "./cors.js";
import { DuplicateCheckSchema, judgeDuplicate } from "./duplicates.js";
import { androidAssetLinks, appleAppSiteAssociation, invitePage, isValidInviteCode } from "./invite.js";
import { NimNotConfiguredError } from "./nim.js";
import { parseTrustProxy, RateLimiter } from "./ratelimit.js";
import { NotAReceiptError, ScanRefusedError, scanReceipt } from "./receipt.js";
import { canEditExpense, ExpenseConflictError, TripStore, type Trip } from "./store.js";

// DATA_DIR must be on a persistent volume in production. An old trips.json in it is imported once.
const dbFile = path.resolve(process.env.DATA_DIR ?? "data", "trips.db");
const store = new TripStore(dbFile);
const app = express();

// Behind a load balancer set TRUST_PROXY (e.g. 1) so per-IP limits see real client
// addresses instead of lumping everyone under the balancer's.
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

// Harden headers to reduce browser-side leaks and clickjacking risk.
app.disable("x-powered-by");

// Security headers and CORS for the mobile app.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  const origin = allowedOrigin(req.headers.origin);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    if (origin !== "*") res.vary("Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, If-None-Match");
  }
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Keep ordinary request bodies small. The receipt route opts into its larger
// parser only after authentication has succeeded.
const smallJson = express.json({ limit: "256kb" });

// Rate limits live in the same SQLite file as the trips, so they survive restarts
// and are shared by every server process on that volume.
const rateLimiter = new RateLimiter(dbFile);

export function createRateLimiter(options: {
  bucket: string;
  windowMs: number;
  max: number;
  message: string;
  /** Count per signed-in user when there is one, otherwise per client IP. */
  perUser?: boolean;
}) {
  const { bucket, windowMs, max, message, perUser } = options;
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
    const key = perUser && req.user?.id ? `user:${req.user.id}` : ip;
    let decision;
    try {
      decision = rateLimiter.hit(bucket, key, windowMs, max);
    } catch (error) {
      // A broken limiter shouldn't take the API down with it; the failure is logged loudly.
      console.error(`Rate limiter unavailable, allowing ${bucket} request`, error);
      return next();
    }
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfterSec));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

export const aiRateLimiter = createRateLimiter({
  bucket: "ai",
  perUser: true,
  windowMs: 60_000,
  max: 20,
  message: "Too many scans right now, try again in a minute.",
});

const joinRateLimiter = createRateLimiter({
  bucket: "join",
  windowMs: 60_000,
  max: 30,
  message: "Too many invite lookups. Try again shortly.",
});

export function resetRateLimits(): void {
  rateLimiter.reset();
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

function notFound(res: Response) {
  res.status(404).json({ error: "Trip not found" });
}

function publicJoinTrip(trip: Trip) {
  return {
    preview: true,
    id: trip.id,
    code: trip.code,
    name: trip.name,
    baseCurrency: trip.baseCurrency,
    members: trip.members.map(({ id, name }) => ({ id, name })),
    expenses: [],
    deletedExpenseIds: [],
    updatedAt: trip.updatedAt,
    inviteExpiresAt: trip.inviteExpiresAt,
  };
}

export function extractParam(param: string | string[] | undefined): string {
  return (Array.isArray(param) ? param[0] : param) ?? "";
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Authenticate before parsing any trip body.
app.use("/api/trips", requireAuth, smallJson);

app.get("/api/trips", requireAuth, (req: Request, res: Response) => {
  const userId = req.user!.id;
  res.json(store.listForUser(userId));
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
  const existing = store.get(body.data.id);
  if (existing) {
    if (existing.ownerId === req.user!.id) return res.json(existing);
    return res.status(409).json({ error: "Trip already exists" });
  }
  const tripData = { ...body.data, ownerId: req.user!.id };
  try {
    return res.json(await store.create(tripData));
  } catch (err) {
    if (err instanceof Error && err.message === "Trip already exists") {
      return res.status(409).json({ error: "Trip already exists" });
    }
    console.error("Trip creation failed", err);
    return res.status(500).json({ error: "Trip could not be created." });
  }
});

app.get("/api/trips/:id", requireAuth, (req: Request, res: Response) => {
  const id = extractParam(req.params.id);
  const trip = store.get(id);
  if (!trip) return notFound(res);
  const isMember = trip.ownerId === req.user!.id || trip.members.some(m => m.userId === req.user!.id);
  if (!isMember) {
    return res.status(403).json({ error: "Not a member of this trip" });
  }
  res.set("ETag", `"${trip.revision ?? trip.updatedAt}"`);
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

app.get("/api/join/:code", joinRateLimiter, requireAuth, (req: Request, res: Response) => {
  const code = extractParam(req.params.code);
  const trip = store.findByCode(code);
  if (!trip) return res.status(404).json({ error: "No trip with that code or invite has expired" });

  return res.json({
    id: trip.id,
    name: trip.name,
    baseCurrency: trip.baseCurrency,
    memberCount: trip.members.length,
    inviteExpiresAt: trip.inviteExpiresAt,
  });
});

app.post("/api/join/:code", joinRateLimiter, requireAuth, smallJson, async (req: Request, res: Response) => {
  const code = extractParam(req.params.code);
  const trip = store.findByCode(code);
  if (!trip) {
    return res.status(404).json({ error: "No trip with that code or invite has expired" });
  }

  const claimMemberId = typeof req.body?.claimMemberId === "string" ? req.body.claimMemberId : undefined;
  if (claimMemberId) {
    let member = trip.members.find((m) => m.id === claimMemberId);
    if (!member && req.body?.member && typeof req.body.member === "object") {
      const proposed = MemberSchema.safeParse({ ...req.body.member, id: claimMemberId });
      if (!proposed.success || proposed.data.userId !== req.user!.id) {
        return res.status(403).json({ error: "Only the authenticated user can add their own member record" });
      }
      const updated = await store.upsertMember(trip.id, proposed.data);
      if (!updated) return notFound(res);
      member = updated.members.find((m) => m.id === claimMemberId);
    }
    if (!member) return res.status(404).json({ error: "Trip member not found" });
    if (member.userId && member.userId !== req.user!.id) return res.status(409).json({ error: "Member is already claimed" });
    try {
      const updated = await store.claimMember(trip.id, claimMemberId, {
        id: claimMemberId, userId: req.user!.id, name: req.user!.user_metadata?.full_name ?? "Traveller",
        email: req.user!.email,
      });
      return updated ? res.json(updated) : notFound(res);
    } catch (err) {
      return res.status(409).json({ error: err instanceof Error ? err.message : "Member is already claimed" });
    }
  }
  return res.json(trip.ownerId === req.user!.id || trip.members.some((member) => member.userId === req.user!.id)
    ? trip : publicJoinTrip(trip));
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

  const member = trip.members.find(m => m.id === memberId);
  const isMember = trip.ownerId === req.user!.id || trip.members.some(m => m.userId === req.user!.id);
  if (!isMember) {
    return res.status(403).json({ error: "Not a member of this trip" });
  }
  const mayEdit = trip.ownerId === req.user!.id || member?.userId === req.user!.id;
  if (!mayEdit) {
    return res.status(403).json({ error: "Only the trip owner can manage members" });
  }

  const memberData = trip.ownerId === req.user!.id
    ? body.data
    : { ...body.data, userId: req.user!.id };
  const updated = await store.upsertMember(id, memberData);
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

  const updated = await store.deleteMember(id, memberId);
  return updated ? res.json(updated) : notFound(res);
});

app.put("/api/trips/:id/expenses/:expenseId", requireAuth, async (req: Request, res: Response) => {
  const expenseId = extractParam(req.params.expenseId);
  const body = ExpenseSchema.safeParse({ ...req.body, id: expenseId });
  if (!body.success) return res.status(400).json({ error: body.error.message });
  // The revision the editor started from. Optional so older apps keep working.
  const base = z.number().int().min(0).optional().safeParse(req.body?.baseRevision);
  if (!base.success) return res.status(400).json({ error: "baseRevision must be a non-negative integer" });
  const baseRevision = base.data;

  const id = extractParam(req.params.id);
  const trip = store.get(id);
  if (!trip) return notFound(res);

  // Check if user is a member of this trip or owner
  const isMember = trip.ownerId === req.user!.id || trip.members.some(m => m.userId === req.user!.id);
  if (!isMember) {
    return res.status(403).json({ error: "Not a member of this trip" });
  }

  const existing = trip.expenses.find((e) => e.id === expenseId);
  if (!canEditExpense(trip, req.user!.id, existing)) {
    return res.status(403).json({ error: "Only the expense creator or trip owner can edit this expense" });
  }
  body.data.createdBy = existing?.createdBy ?? req.user!.id;
  // revision is assigned by the server, never taken from the client.
  delete (body.data as Record<string, unknown>).revision;

  try {
    const updated = await store.upsertExpense(id, body.data, baseRevision);
    return updated ? res.json(updated) : notFound(res);
  } catch (err) {
    if (err instanceof ExpenseConflictError) {
      return res.status(409).json({
        error: err.message,
        code: err.reason === "deleted" ? "expense_deleted" : "expense_conflict",
        current: err.current ?? null,
      });
    }
    throw err;
  }
});

app.delete("/api/trips/:id/expenses/:expenseId", requireAuth, async (req: Request, res: Response) => {
  const id = extractParam(req.params.id);
  const expenseId = extractParam(req.params.expenseId);
  const trip = store.get(id);
  if (!trip) return notFound(res);

  // Check if user is a member of this trip or owner
  const isMember = trip.ownerId === req.user!.id || trip.members.some(m => m.userId === req.user!.id);
  if (!isMember) {
    return res.status(403).json({ error: "Not a member of this trip" });
  }

  const existing = trip.expenses.find((e) => e.id === expenseId);
  if (!canEditExpense(trip, req.user!.id, existing)) {
    return res.status(403).json({ error: "Only the expense creator or trip owner can delete this expense" });
  }

  const updated = await store.deleteExpense(id, expenseId);
  return updated ? res.json(updated) : notFound(res);
});

// Invite links: the page a phone camera opens from a trip's QR code, plus the
// files iOS and Android check before opening such links in the app directly.
app.get("/join/:code", joinRateLimiter, (req, res) => {
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
  if (!body.success) {
    console.warn("Invalid receipt scan request", body.error.issues);
    return res.status(400).json({ error: "Invalid receipt scan request." });
  }

  try {
    res.json(await scanReceipt(body.data));
  } catch (err) {
    sendNIMError(res, err);
  }
}

async function handleCheckDuplicate(req: Request, res: Response) {
  const body = DuplicateCheckSchema.safeParse(req.body);
  if (!body.success) {
    console.warn("Invalid duplicate-check request", body.error.issues);
    return res.status(400).json({ error: "Invalid duplicate-check request." });
  }

  try {
    res.json(await judgeDuplicate(body.data));
  } catch (err) {
    sendNIMError(res, err);
  }
}

// Protected AI Endpoints (require Supabase JWT and rate limiting)
app.post("/api/scan-receipt", requireAuth, express.json({ limit: "12mb" }), aiRateLimiter, handleScanReceipt);
app.post("/api/check-duplicate", requireAuth, smallJson, aiRateLimiter, handleCheckDuplicate);
app.post("/api/check-duplicates", requireAuth, smallJson, aiRateLimiter, handleCheckDuplicate);

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
    return res.status(500).json({ error: "Receipt scanning is not configured on the server.", retryable: false });
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
  res.status(500).json({ error: "Scan failed. Please try again.", retryable: false });
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
      return res.status(413).json({ error: "Payload too large" });
    }
    if (typeof errorObj.status === "number" && errorObj.status >= 400 && errorObj.status < 500) {
      return res.status(errorObj.status).json({
        error: typeof errorObj.message === "string" ? errorObj.message : "Bad request",
      });
    }
  }
  res.status(500).json({ error: "Internal server error" });
});

export { app, store, rateLimiter };

const port = Number(process.env.PORT ?? 4000);
await store.load();
if (process.env.NODE_ENV !== "test") {
  validateEnv();
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Deochipei API listening on http://0.0.0.0:${port}`);
  });

  // Let in-flight requests finish and flush the database before the process
  // goes away (deploys and container stops send SIGTERM).
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    const force = setTimeout(() => {
      store.close();
      rateLimiter.close();
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(() => {
      store.close();
      rateLimiter.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
