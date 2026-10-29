import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Kept loose on purpose: the app owns the expense shape, the server only
// needs ids and timestamps to merge concurrent edits.
export interface Member {
  id: string;
  name: string;
  /** ISO code the member reads amounts in; each phone converts the trip's figures into it. */
  homeCurrency?: string;
  userId?: string;
  email?: string;
  avatarUrl?: string;
}

export interface Expense {
  id: string;
  updatedAt: number;
  /** Server-owned version of this expense; bumps on every accepted write. Clients echo it back as baseRevision. */
  revision?: number;
  [key: string]: unknown;
}

/** Why an edit was refused because the expense moved on since the editor last saw it. */
export class ExpenseConflictError extends Error {
  constructor(
    public readonly reason: "changed" | "deleted",
    /** The server's current copy, or undefined when it was deleted. */
    public readonly current: Expense | undefined,
  ) {
    super(reason === "deleted" ? "This expense was deleted by someone else." : "This expense was changed by someone else.");
    this.name = "ExpenseConflictError";
  }
}

/** Equality of the user-editable content, ignoring server/clock bookkeeping. */
function sameContent(a: Expense, b: Expense): boolean {
  const canon = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key, v]) => v !== undefined && !["updatedAt", "revision", "baseRevision"].includes(key))
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([key, v]) => [key, canon(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export interface Trip {
  id: string;
  code: string;
  inviteCode?: string;
  name: string;
  baseCurrency: string;
  members: Member[];
  expenses: Expense[];
  deletedExpenseIds: string[];
  createdAt: number;
  updatedAt: number;
  /** Server-owned version; unlike updatedAt it is immune to device clock skew. */
  revision?: number;
  ownerId?: string;
  inviteExpiresAt?: number | null;
}

export type NewTrip = Pick<Trip, "id" | "name" | "baseCurrency" | "members" | "expenses"> & {
  ownerId?: string;
};

/** Authorization rule shared by the HTTP layer and tests. */
export function canEditExpense(trip: Trip, userId: string, expense: Expense | undefined): boolean {
  if (trip.ownerId === userId) return true;
  if (!trip.members.some((m) => m.userId === userId)) return false;
  // A legacy expense has no trustworthy persisted creator. Only the owner may
  // repair it; an arbitrary member must not be able to overwrite it.
  if (!expense) return true;
  return typeof expense.createdBy === "string" && expense.createdBy === userId;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Trips persisted in SQLite (one row per trip, the app-owned JSON kept whole).
 *
 * - Durable: WAL journal with synchronous=FULL, so a trip write that returned
 *   has reached disk, and a crash can never leave a half-written store.
 * - Atomic: every change is a read-modify-write inside BEGIN IMMEDIATE. Two
 *   writers (concurrent requests, or two server processes on one file) are
 *   serialised by SQLite, so neither can overwrite the other's change.
 * - All-or-nothing: if a change throws or the write fails, nothing is applied
 *   and the caller sees the error. Memory is never ahead of disk.
 * - Cheap: a change rewrites one trip, not the whole dataset.
 *
 * There is deliberately no in-memory copy of trips: that is what makes it safe
 * to run more than one process against the same database file.
 */
export class TripStore {
  private db?: DatabaseSync;

  /**
   * @param file SQLite database path (":memory:" for tests).
   * @param legacyJson Old trips.json to import once, if present.
   */
  constructor(
    private readonly file: string,
    private readonly legacyJson: string | null = file === ":memory:" ? null : path.join(path.dirname(file), "trips.json"),
  ) {}

  /** Opens the database, creates the schema and imports a legacy trips.json once. Safe to call repeatedly. */
  async load() {
    this.handle();
  }

  close() {
    if (!this.db) return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Closing still flushes; the checkpoint only keeps the -wal file small.
    }
    this.db.close();
    this.db = undefined;
  }

  get(id: string): Trip | undefined {
    return this.read(id);
  }

  list(): Trip[] {
    return this.rows(this.handle().prepare("SELECT data FROM trips ORDER BY rowid").all());
  }

  /** Trips the user owns or is a bound member of, filtered inside SQLite. */
  listForUser(userId: string): Trip[] {
    const rows = this.handle()
      .prepare(
        `SELECT data FROM trips
         WHERE owner_id = ?1
            OR EXISTS (SELECT 1 FROM json_each(trips.data, '$.members') WHERE json_extract(value, '$.userId') = ?1)
         ORDER BY rowid`,
      )
      .all(userId);
    return this.rows(rows);
  }

  findByCode(code: string): Trip | undefined {
    const row = this.handle().prepare("SELECT data FROM trips WHERE code = ?").get(code.trim().toUpperCase());
    if (!row) return undefined;
    const trip = JSON.parse(String(row.data)) as Trip;
    if (trip.inviteExpiresAt != null && Date.now() > trip.inviteExpiresAt) return undefined;
    return trip;
  }

  async create(input: NewTrip) {
    return this.tx(() => {
      if (this.read(input.id)) throw new Error("Trip already exists");
      const now = Date.now();
      const trip: Trip = {
        ...input,
        code: this.newJoinCode(),
        inviteExpiresAt: now + INVITE_TTL_MS,
        deletedExpenseIds: [],
        createdAt: now,
        updatedAt: now,
        revision: this.nextRevision(),
      };
      this.write(trip);
      return trip;
    });
  }

  async regenerateInvite(tripId: string, expiresInMs: number = INVITE_TTL_MS): Promise<Trip> {
    const updated = await this.mutate(tripId, (trip) => {
      const newCode = this.newJoinCode();
      trip.code = newCode;
      trip.inviteCode = newCode;
      trip.inviteExpiresAt = Date.now() + expiresInMs;
    });
    if (!updated) throw new Error("Trip not found");
    return updated;
  }

  deleteMember(tripId: string, memberId: string) {
    return this.mutate(tripId, (trip) => {
      const before = trip.members.length;
      trip.members = trip.members.filter((m) => m.id !== memberId && m.userId !== memberId);
      if (trip.members.length === before) return false;
    });
  }

  bindMember(
    tripId: string,
    memberData: { userId: string; name?: string; email?: string; avatarUrl?: string; homeCurrency?: string }
  ) {
    return this.mutate(tripId, (trip) => {
      const existing = trip.members.find(
        (m) =>
          m.userId === memberData.userId ||
          (memberData.email && m.email === memberData.email)
      );
      if (existing) {
        existing.userId = memberData.userId;
        if (memberData.email) existing.email = memberData.email;
        if (memberData.name && (!existing.name || existing.name === "Someone")) existing.name = memberData.name;
        if (memberData.avatarUrl) existing.avatarUrl = memberData.avatarUrl;
        if (memberData.homeCurrency) existing.homeCurrency = memberData.homeCurrency;
      } else {
        trip.members.push({
          id: memberData.userId,
          name: memberData.name || "Traveller",
          userId: memberData.userId,
          email: memberData.email,
          avatarUrl: memberData.avatarUrl,
          homeCurrency: memberData.homeCurrency,
        });
      }
    });
  }

  claimMember(tripId: string, memberId: string, user: Member) {
    return this.mutate(tripId, (trip) => {
      const member = trip.members.find((m) => m.id === memberId);
      if (!member) return false;
      if (member.userId && member.userId !== user.userId) throw new Error("Member is already claimed");
      member.userId = user.userId;
      if (user.email) member.email = user.email;
      if (user.avatarUrl) member.avatarUrl = user.avatarUrl;
    });
  }

  update(id: string, patch: Partial<Pick<Trip, "name" | "baseCurrency">>) {
    return this.mutate(id, (trip) => {
      if (patch.name) trip.name = patch.name;
      if (patch.baseCurrency) trip.baseCurrency = patch.baseCurrency;
    });
  }

  upsertMember(id: string, member: Member) {
    return this.mutate(id, (trip) => {
      const existing = trip.members.find((m) => m.id === member.id);
      if (!existing) {
        trip.members.push(member);
        return;
      }
      // Older app versions don't send a home currency; don't let a rename from one wipe it.
      if (existing.name === member.name && (!member.homeCurrency || existing.homeCurrency === member.homeCurrency)) {
        return false;
      }
      existing.name = member.name;
      if (member.homeCurrency) existing.homeCurrency = member.homeCurrency;
    });
  }

  /**
   * Saves an expense. When `baseRevision` is given it is the revision the editor
   * started from; if the stored expense has moved on, nothing is written and
   * ExpenseConflictError is thrown so the editor can review instead of silently
   * overwriting. Omitting it keeps the old last-write-wins behaviour for older apps.
   */
  upsertExpense(id: string, expense: Expense, baseRevision?: number) {
    return this.mutate(id, (trip, revision) => {
      if (typeof expense.amount === "number" && (!Number.isFinite(expense.amount) || expense.amount <= 0)) return false;
      const idx = trip.expenses.findIndex((e) => e.id === expense.id);
      const existing = idx === -1 ? undefined : trip.expenses[idx];
      if (trip.deletedExpenseIds.includes(expense.id)) {
        if (baseRevision !== undefined) throw new ExpenseConflictError("deleted", undefined);
        return false;
      }
      if (existing && baseRevision !== undefined && (existing.revision ?? 0) !== baseRevision) {
        // A retry of a write that already landed (the response was lost) is not a conflict.
        if (sameContent(existing, expense)) return false;
        throw new ExpenseConflictError("changed", existing);
      }
      // The server owns ordering and versions. Client timestamps are only
      // metadata and can never pin an expense forever with a far-future value.
      const { baseRevision: _base, ...clean } = expense as Expense & { baseRevision?: unknown };
      // Same number as the trip's new revision: one counter step per write.
      const next: Expense = { ...clean, updatedAt: Date.now(), revision: revision() };
      if (idx === -1) trip.expenses.push(next);
      else trip.expenses[idx] = next;
    });
  }

  deleteExpense(id: string, expenseId: string) {
    return this.mutate(id, (trip) => {
      trip.expenses = trip.expenses.filter((e) => e.id !== expenseId);
      if (!trip.deletedExpenseIds.includes(expenseId)) trip.deletedExpenseIds.push(expenseId);
    });
  }

  /**
   * Applies `change` to the latest stored copy of a trip, bumps its version and
   * persists it, as one atomic step. `change` returns false when it turned out
   * to be a no-op, which skips the bump and the write. Resolves to undefined if
   * the trip doesn't exist. If `change` throws, nothing is written.
   */
  private async mutate(id: string, change: (trip: Trip, revision: () => number) => void | false) {
    return this.tx(() => {
      const trip = this.read(id);
      if (!trip) return undefined;
      // Taken at most once per change, and only if the change is applied, so a
      // rolled-back or no-op change never consumes a number.
      let assigned: number | undefined;
      const revision = () => (assigned ??= this.nextRevision());
      if (change(trip, revision) === false) return trip;
      // updatedAt is the trip's version (ETag), so it must move on every change,
      // even two in the same millisecond.
      trip.updatedAt = Math.max(Date.now(), trip.updatedAt + 1);
      trip.revision = revision();
      this.write(trip);
      return trip;
    });
  }

  // ── SQLite plumbing ────────────────────────────────────────────────────

  private handle(): DatabaseSync {
    if (this.db) return this.db;
    if (this.file !== ":memory:") mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      // Wait for another writer instead of failing with SQLITE_BUSY.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS trips (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          owner_id TEXT,
          revision INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS trips_owner ON trips(owner_id);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', 0);
      `);
      this.db = db;
      this.importLegacyJson();
    } catch (error) {
      this.db = undefined;
      db.close();
      throw error;
    }
    return db;
  }

  /** BEGIN IMMEDIATE takes the write lock up front, so read-modify-write cannot interleave. */
  private tx<T>(fn: () => T): T {
    const db = this.handle();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is the useful one.
      }
      throw error;
    }
  }

  private read(id: string): Trip | undefined {
    const row = this.handle().prepare("SELECT data FROM trips WHERE id = ?").get(id);
    return row ? (JSON.parse(String(row.data)) as Trip) : undefined;
  }

  private rows(rows: Record<string, unknown>[]): Trip[] {
    return rows.map((row) => JSON.parse(String(row.data)) as Trip);
  }

  private write(trip: Trip) {
    this.handle()
      .prepare(
        `INSERT INTO trips (id, code, owner_id, revision, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           code = excluded.code, owner_id = excluded.owner_id,
           revision = excluded.revision, data = excluded.data`,
      )
      .run(trip.id, trip.code, trip.ownerId ?? null, trip.revision ?? 0, JSON.stringify(trip));
  }

  private nextRevision(): number {
    const row = this.handle()
      .prepare("UPDATE meta SET value = value + 1 WHERE key = 'revision' RETURNING value")
      .get();
    return Number(row!.value);
  }

  private codeTaken(code: string): boolean {
    return this.handle().prepare("SELECT 1 FROM trips WHERE code = ?").get(code) !== undefined;
  }

  private newJoinCode() {
    for (;;) {
      let code = "";
      for (let i = 0; i < 10; i++) {
        code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      }
      if (!this.codeTaken(code)) return code;
    }
  }

  /**
   * One-time import of the pre-SQLite trips.json. A file that exists but can't
   * be parsed aborts startup rather than silently starting empty. The original
   * is kept as trips.json.migrated.
   */
  private importLegacyJson() {
    const file = this.legacyJson;
    if (!file || !existsSync(file)) return;
    const db = this.handle();
    const done = db.prepare("SELECT value FROM meta WHERE key = 'json_imported'").get();
    if (!done) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Trip[];
      if (!Array.isArray(saved)) throw new Error(`${file} is not a list of trips`);
      this.tx(() => {
        // Keep revisions the file already has; hand out fresh ones above them to legacy trips without one.
        let highest = 0;
        for (const trip of saved) {
          if (Number.isInteger(trip.revision) && trip.revision! > 0) highest = Math.max(highest, trip.revision!);
        }
        const current = Number(db.prepare("SELECT value FROM meta WHERE key = 'revision'").get()!.value);
        db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(Math.max(current, highest));
        for (const trip of saved) {
          if (!Number.isInteger(trip.revision) || trip.revision! <= 0) trip.revision = this.nextRevision();
          // A duplicate join code would violate the unique index; the old in-memory index silently shadowed one.
          if (this.codeTaken(trip.code)) trip.code = this.newJoinCode();
          this.write(trip);
        }
        db.prepare("INSERT INTO meta (key, value) VALUES ('json_imported', 1)").run();
      });
    }
    try {
      renameSync(file, `${file}.migrated`);
    } catch {
      // The import flag already prevents a second import.
    }
  }
}
