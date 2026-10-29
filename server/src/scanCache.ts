import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Bump when the cached scan shape changes, so old rows cannot be served. */
const CACHE_VERSION = "scan-v1";
export const DEFAULT_SCAN_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_DAILY_SCAN_LIMIT = 60;

export interface ScanQuotaDecision {
  allowed: boolean;
  /** Scans counted for this account today, including this one when allowed. */
  used: number;
  /** Configured daily maximum; 0 means unlimited. */
  limit: number;
  /** Seconds until the UTC day rolls over; 0 when allowed. */
  retryAfterSec: number;
}

/**
 * Reads AI_DAILY_SCAN_LIMIT. A number of scans per account per UTC day;
 * 0 disables the quota, anything invalid falls back to the default.
 */
export function parseDailyScanLimit(value = process.env.AI_DAILY_SCAN_LIMIT): number {
  if (value == null || value.trim() === "") return DEFAULT_DAILY_SCAN_LIMIT;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_SCAN_LIMIT;
}

/**
 * Two AI-cost controls that survive restarts and are shared by every server
 * process on the same volume:
 *
 * - A scan cache keyed by a SHA-256 of the uploaded image and target language.
 *   A retry, or the same receipt scanned on a second phone, is free.
 * - A per-account daily quota. It is only charged on a cache miss, so retries
 *   of a photo that already scanned never eat into the allowance.
 *
 * The image itself is never stored, only its hash and the parsed result.
 */
export class ScanStore {
  private db?: DatabaseSync;
  private lastPurge = 0;

  constructor(
    private readonly file: string,
    private readonly ttlMs = DEFAULT_SCAN_CACHE_TTL_MS,
  ) {}

  /** Cache identity: same pixels and same output language produce the same scan. */
  cacheKey(imageBase64: string, targetLanguage: string): string {
    return createHash("sha256")
      .update(CACHE_VERSION)
      .update("\0")
      .update(targetLanguage.trim().toLowerCase())
      .update("\0")
      .update(imageBase64)
      .digest("hex");
  }

  cached(key: string, now = Date.now()): unknown | undefined {
    const db = this.handle();
    const row = db.prepare("SELECT value, created_at FROM scan_cache WHERE key = ?").get(key);
    if (!row) return undefined;
    if (Number(row.created_at) + this.ttlMs <= now) {
      db.prepare("DELETE FROM scan_cache WHERE key = ?").run(key);
      return undefined;
    }
    try {
      return JSON.parse(String(row.value));
    } catch {
      // A corrupt row must not break scanning forever.
      db.prepare("DELETE FROM scan_cache WHERE key = ?").run(key);
      return undefined;
    }
  }

  remember(key: string, scan: unknown, now = Date.now()): void {
    const db = this.handle();
    db.prepare(
      `INSERT INTO scan_cache (key, value, created_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
    ).run(key, JSON.stringify(scan), now);
    this.purge(now);
  }

  /**
   * Claims one scan from the account's daily allowance. A rejected claim is
   * not counted, so repeatedly hitting the limit does not extend it.
   */
  consumeDaily(userId: string, limit: number, now = Date.now()): ScanQuotaDecision {
    if (!Number.isInteger(limit) || limit <= 0) {
      return { allowed: true, used: 0, limit: 0, retryAfterSec: 0 };
    }
    const db = this.handle();
    const day = new Date(now).toISOString().slice(0, 10);
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT count FROM scan_quota WHERE key = ? AND day = ?").get(userId, day);
      const used = Number(row?.count ?? 0);
      let decision: ScanQuotaDecision;
      if (used >= limit) {
        decision = { allowed: false, used, limit, retryAfterSec: this.secondsUntilTomorrow(now) };
      } else {
        db.prepare(
          `INSERT INTO scan_quota (key, day, count) VALUES (?, ?, 1)
           ON CONFLICT(key, day) DO UPDATE SET count = count + 1`,
        ).run(userId, day);
        decision = { allowed: true, used: used + 1, limit, retryAfterSec: 0 };
      }
      db.exec("COMMIT");
      return decision;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is the useful one.
      }
      throw error;
    }
  }

  /** Forgets cached scans and quota counters (tests, or an operator reset). */
  reset(): void {
    const db = this.handle();
    db.exec("DELETE FROM scan_cache; DELETE FROM scan_quota;");
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private secondsUntilTomorrow(now: number): number {
    const date = new Date(now);
    const tomorrow = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    return Math.max(1, Math.ceil((tomorrow - now) / 1000));
  }

  /** Expired scans and old quota rows would otherwise accumulate forever. */
  private purge(now: number): void {
    if (now - this.lastPurge < 60_000) return;
    this.lastPurge = now;
    const db = this.handle();
    db.prepare("DELETE FROM scan_cache WHERE created_at <= ?").run(now - this.ttlMs);
    const day = new Date(now).toISOString().slice(0, 10);
    db.prepare("DELETE FROM scan_quota WHERE day < ?").run(day);
  }

  private handle(): DatabaseSync {
    if (this.db) return this.db;
    if (this.file !== ":memory:") mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS scan_cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS scan_cache_created ON scan_cache (created_at);
        CREATE TABLE IF NOT EXISTS scan_quota (
          key TEXT NOT NULL,
          day TEXT NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY (key, day)
        );
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }
}
