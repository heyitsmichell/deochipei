import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the oldest counted hit leaves the window; 0 when allowed. */
  retryAfterSec: number;
}

/**
 * Sliding-window rate limiter kept in SQLite, so limits survive restarts and
 * are shared by every server process using the same database file.
 *
 * Each allowed request is one row. A check is a single BEGIN IMMEDIATE
 * transaction (drop expired rows, count, maybe insert), so concurrent
 * processes can never both squeeze through on the last free slot. Rejected
 * requests are not recorded, so hammering a limit doesn't extend it.
 */
export class RateLimiter {
  private db?: DatabaseSync;
  private maxWindowMs = 0;
  private lastPurge = 0;

  /** @param file SQLite path, usually the same file as the trip store (":memory:" for tests). */
  constructor(private readonly file: string) {}

  hit(bucket: string, key: string, windowMs: number, max: number, now = Date.now()): RateDecision {
    const db = this.handle();
    this.maxWindowMs = Math.max(this.maxWindowMs, windowMs);
    db.exec("BEGIN IMMEDIATE");
    try {
      const cutoff = now - windowMs;
      db.prepare("DELETE FROM rate_hits WHERE bucket = ? AND key = ? AND ts <= ?").run(bucket, key, cutoff);
      const row = db
        .prepare("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM rate_hits WHERE bucket = ? AND key = ?")
        .get(bucket, key)!;
      let decision: RateDecision;
      if (Number(row.n) >= max) {
        decision = { allowed: false, retryAfterSec: Math.max(1, Math.ceil((Number(row.oldest) + windowMs - now) / 1000)) };
      } else {
        db.prepare("INSERT INTO rate_hits (bucket, key, ts) VALUES (?, ?, ?)").run(bucket, key, now);
        decision = { allowed: true, retryAfterSec: 0 };
      }
      this.purgeStale(db, now);
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

  /** Forgets every recorded hit (tests, or an operator clearing a limit). */
  reset() {
    this.handle().exec("DELETE FROM rate_hits");
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }

  /** Keys that go quiet would otherwise leave rows behind forever. */
  private purgeStale(db: DatabaseSync, now: number) {
    if (now - this.lastPurge < 60_000) return;
    this.lastPurge = now;
    db.prepare("DELETE FROM rate_hits WHERE ts <= ?").run(now - this.maxWindowMs);
  }

  private handle(): DatabaseSync {
    if (this.db) return this.db;
    if (this.file !== ":memory:") mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      // Losing the last instants of hits in a power cut is harmless; skip the per-request fsync.
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS rate_hits (bucket TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS rate_hits_lookup ON rate_hits (bucket, key, ts);
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }
}

/**
 * Reads TRUST_PROXY for Express. Behind a load balancer every request appears
 * to come from the balancer unless Express is told how many proxy hops to trust.
 * "2" trusts two hops, "true"/"false" are literal, anything else is passed through
 * (e.g. "loopback" or a CIDR list). Unset: trust nothing.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = value?.trim();
  if (!v || v.toLowerCase() === "false") return false;
  if (v.toLowerCase() === "true") return true;
  return /^\d+$/.test(v) ? Number(v) : v;
}
