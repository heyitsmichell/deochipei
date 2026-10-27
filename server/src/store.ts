import { randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
  [key: string]: unknown;
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
  ownerId?: string;
  inviteExpiresAt?: number | null;
}

export type NewTrip = Pick<Trip, "id" | "name" | "baseCurrency" | "members" | "expenses"> & {
  ownerId?: string;
};

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Trips held in memory and persisted to a single JSON file.
 *
 * Writes are coalesced: while one save is in progress, further changes only
 * mark the store dirty, and one more save picks them all up. Every caller
 * still waits until a save that includes its change has finished.
 */
export class TripStore {
  private readonly trips = new Map<string, Trip>();
  private readonly byCode = new Map<string, Trip>();
  private saving?: Promise<void>;
  private dirty = false;

  constructor(private readonly file: string) {}

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as Trip[];
      for (const trip of saved) this.index(trip);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  get(id: string) {
    return this.trips.get(id);
  }

  findByCode(code: string): Trip | undefined {
    const trip = this.byCode.get(code.trim().toUpperCase());
    if (!trip) return undefined;
    if (trip.inviteExpiresAt != null && Date.now() > trip.inviteExpiresAt) {
      return undefined;
    }
    return trip;
  }

  async create(input: NewTrip) {
    const existing = this.trips.get(input.id);
    if (existing) return existing;
    const now = Date.now();
    const trip: Trip = {
      ...input,
      code: this.newJoinCode(),
      inviteExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      deletedExpenseIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.index(trip);
    await this.save();
    return trip;
  }

  async regenerateInvite(tripId: string, expiresInMs: number = 7 * 24 * 60 * 60 * 1000): Promise<Trip> {
    const trip = this.trips.get(tripId);
    if (!trip) throw new Error("Trip not found");

    if (trip.code) {
      this.byCode.delete(trip.code);
    }
    const newCode = this.newJoinCode();
    const expiresAt = Date.now() + expiresInMs;

    trip.code = newCode;
    trip.inviteCode = newCode;
    trip.inviteExpiresAt = expiresAt;
    trip.updatedAt = Math.max(Date.now(), trip.updatedAt + 1);

    this.byCode.set(newCode, trip);
    await this.save();
    return trip;
  }

  bindMember(
    tripId: string,
    memberData: { userId: string; name?: string; email?: string; avatarUrl?: string; homeCurrency?: string }
  ) {
    return this.mutate(tripId, (trip) => {
      const existing = trip.members.find(
        (m) =>
          m.userId === memberData.userId ||
          m.id === memberData.userId ||
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

  upsertExpense(id: string, expense: Expense) {
    return this.mutate(id, (trip) => {
      if (trip.deletedExpenseIds.includes(expense.id)) return false;
      const idx = trip.expenses.findIndex((e) => e.id === expense.id);
      if (idx === -1) trip.expenses.push(expense);
      // Last write wins, judged by the editing device's timestamp.
      else if (expense.updatedAt >= trip.expenses[idx].updatedAt) trip.expenses[idx] = expense;
      else return false;
    });
  }

  deleteExpense(id: string, expenseId: string) {
    return this.mutate(id, (trip) => {
      trip.expenses = trip.expenses.filter((e) => e.id !== expenseId);
      if (!trip.deletedExpenseIds.includes(expenseId)) trip.deletedExpenseIds.push(expenseId);
    });
  }

  /**
   * Applies `change` to a trip, bumps its version and persists it. `change`
   * returns false when it turned out to be a no-op, which skips the bump and
   * the write. Resolves to undefined if the trip doesn't exist.
   */
  private async mutate(id: string, change: (trip: Trip) => void | false) {
    const trip = this.trips.get(id);
    if (!trip) return undefined;
    if (change(trip) === false) return trip;
    // updatedAt is the trip's version (ETag), so it must move on every change,
    // even two in the same millisecond.
    trip.updatedAt = Math.max(Date.now(), trip.updatedAt + 1);
    await this.save();
    return trip;
  }

  private index(trip: Trip) {
    this.trips.set(trip.id, trip);
    this.byCode.set(trip.code, trip);
  }

  private newJoinCode() {
    for (;;) {
      let code = "";
      for (let i = 0; i < 6; i++) {
        code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      }
      if (!this.byCode.has(code)) return code;
    }
  }

  save(): Promise<void> {
    this.dirty = true;
    this.saving ??= this.writeUntilClean().finally(() => {
      this.saving = undefined;
    });
    return this.saving;
  }

  private async writeUntilClean() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    while (this.dirty) {
      this.dirty = false;
      // Write-then-rename so a crash never leaves a half-written file.
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify([...this.trips.values()]));
      await fs.rename(tmp, this.file);
    }
  }
}
