import type { Trip } from "../lib/types";
import type { Op } from "./tripOps";

/** The account-scoped portion of the persisted repository state. */
export interface AccountScopedData {
  accountId?: string | null;
  /** Trips hidden on this device, scoped to the account that removed them. */
  removedTripIds?: Record<string, string[]>;
  /** Legacy offline work whose account could not be established. */
  unverified?: { trips: Record<string, Trip>; ops: Op[]; failedOps: Op[]; me: Record<string, string> };
  trips: Record<string, Trip>;
  ops: Op[];
  failedOps: Op[];
  me: Record<string, string>;
}

export type AccountTransition =
  /** No cleanup needed: the data already belongs to this account. */
  | { kind: "none" }
  /** Legacy data predates account tracking; move what cannot be verified aside. */
  | { kind: "migrate"; data: Pick<AccountScopedData, "trips" | "ops" | "failedOps" | "me" | "unverified"> }
  /** A different account was signed in before; ask before wiping the device copy. */
  | { kind: "reset" };

/**
 * Decides what must happen to locally saved work when `id` signs in.
 *
 * Data saved before account tracking (`accountId === undefined`) is kept when
 * the trips prove the same person owns them. Trips whose ownership cannot be
 * verified are parked under `unverified` instead of being wiped or sent as the
 * new user; a person can review and recover them later. Switching between two
 * known accounts still requires an explicit reset.
 */
export function planAccountTransition(data: AccountScopedData, id: string | null): AccountTransition {
  if (data.accountId === id) return { kind: "none" };
  if (data.accountId !== undefined) return { kind: "reset" };

  const uncertain = new Set(
    Object.values(data.trips)
      .filter(
        (trip) =>
          trip.syncEnabled &&
          (!id || (trip.ownerId !== id && !trip.members.some((member) => member.userId === id))),
      )
      .map((trip) => trip.id),
  );
  if (!uncertain.size) return { kind: "none" };

  const keep = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([tripId]) => !uncertain.has(tripId)));
  const park = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([tripId]) => uncertain.has(tripId)));

  return {
    kind: "migrate",
    data: {
      unverified: {
        trips: { ...data.unverified?.trips, ...park(data.trips) },
        ops: [...(data.unverified?.ops ?? []), ...data.ops.filter((op) => uncertain.has(op.tripId))],
        failedOps: [
          ...(data.unverified?.failedOps ?? []),
          ...data.failedOps.filter((op) => uncertain.has(op.tripId)),
        ],
        me: { ...data.unverified?.me, ...park(data.me) },
      },
      trips: keep(data.trips),
      ops: data.ops.filter((op) => !uncertain.has(op.tripId)),
      failedOps: data.failedOps.filter((op) => !uncertain.has(op.tripId)),
      me: keep(data.me),
    },
  };
}
