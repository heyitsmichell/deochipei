import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { AppState } from "react-native";
import { api } from "../lib/api";
import { findDuplicate } from "../lib/duplicates";
import { ExpoNetworkMonitor } from "../lib/network";
import { rateService } from "../lib/rates";
import { receiptFiles } from "../lib/receiptFiles";
import type { Trip } from "../lib/types";
import { ReceiptQueue } from "./ReceiptQueue";
import { TripRepository, type RepositorySnapshot } from "./TripRepository";

export type { Settings } from "./TripRepository";
export type { QueuedReceipt } from "./ReceiptQueue";

const network = new ExpoNetworkMonitor();
const repository = new TripRepository(api, AsyncStorage);
const receiptQueue = new ReceiptQueue({
  repo: repository,
  network,
  storage: AsyncStorage,
  files: receiptFiles,
  scan: api.scanReceipt,
  rate: async (from, to) => (await rateService.getRate(from, to)).rate,
  findDuplicate: (trip, scan, rateToBase) =>
    findDuplicate(api.checkDuplicate, trip, scan, {
      rateToBase,
      language: repository.getSnapshot().data.settings.receiptLanguage,
    }),
});

export const resetLocalAccountState = async () => {
  await repository.resetForAccount();
  await receiptQueue.clearForAccount();
};

/**
 * Everything the app can do to trips and queued receipts. The functions never
 * change, so holding on to them doesn't re-render anything.
 */
const actions = {
  createTrip: repository.createTrip,
  joinTrip: repository.joinTrip,
  regenerateTripInvite: repository.regenerateTripInvite,
  setMe: repository.setMe,
  addMember: repository.addMember,
  patchTrip: repository.patchTrip,
  saveExpense: repository.saveExpense,
  deleteExpense: repository.deleteExpense,
  removeTripLocally: repository.removeTripLocally,
  refresh: repository.refresh,
  updateSettings: repository.updateSettings,
  setHomeCurrency: repository.setHomeCurrency,
  /** The latest copy right now, for event handlers. While rendering, use `useTrip`. */
  getTrip: repository.getTrip,
  /** Who I am on a trip right now, for event handlers. While rendering, use `useMe`. */
  meFor: repository.meFor,
  queueReceipt: receiptQueue.add,
  retryReceipt: receiptQueue.retry,
  addReceiptAnyway: receiptQueue.addAnyway,
  readReceiptsNow: receiptQueue.readNow,
  discardReceipt: receiptQueue.discard,
};

/** Starts syncing, network monitoring and the receipt queue for the app's lifetime. */
export function TripsProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    network.start();
    repository.start();
    receiptQueue.start();
    // Don't wait for the retry timer: push queued changes as soon as a connection is back.
    const offNetwork = network.subscribe(() => {
      if (network.current().connected) repository.flush();
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      repository.flush();
      receiptQueue.process();
    });
    return () => {
      offNetwork();
      appState.remove();
      receiptQueue.stop();
      repository.stop();
      network.stop();
    };
  }, []);

  return children;
}

export function useTripActions() {
  return actions;
}

// Each hook below subscribes to one slice of the stores, so a component only
// re-renders when its own slice changes, not whenever anything does. A trip
// syncing in the background doesn't re-render Settings, and one trip changing
// doesn't re-render every card on the trips list.

/** `select` must return something stored as-is (or a primitive), not a new object. */
function useRepository<T>(select: (snapshot: RepositorySnapshot) => T): T {
  return useSyncExternalStore(repository.subscribe, () => select(repository.getSnapshot()));
}

/** False until saved trips have been read from the device. */
export const useReady = () => useRepository((s) => s.ready);

/** False when the last request to the sync server didn't get through. */
export const useOnline = () => useRepository((s) => s.online);

export const useSettings = () => useRepository((s) => s.data.settings);

export const useTrip = (id: string): Trip | undefined => useRepository((s) => s.data.trips[id]);

/** The member id this phone is on a trip. */
export const useMe = (tripId: string): string | undefined => useRepository((s) => s.data.me[tripId]);

/** Changes made on this phone to a trip that the server hasn't confirmed yet. */
export const usePendingCount = (tripId: string) =>
  useRepository((s) => s.data.ops.reduce((n, op) => (op.tripId === tripId ? n + 1 : n), 0));

/** All trips on this phone, most recently changed first. */
export function useTripList() {
  const trips = useRepository((s) => s.data.trips);
  return useMemo(() => Object.values(trips).sort((a, b) => b.updatedAt - a.updatedAt), [trips]);
}

export const useNetwork = () => useSyncExternalStore(network.subscribe, network.current);

/** Receipt photos taken offline that haven't become expenses yet. */
export const useQueuedReceipts = () => useSyncExternalStore(receiptQueue.subscribe, receiptQueue.getSnapshot);

export function useTripReceipts(tripId: string) {
  const receipts = useQueuedReceipts();
  return useMemo(() => receipts.filter((r) => r.tripId === tripId), [receipts, tripId]);
}

export const useQueuedCount = (tripId: string) =>
  useSyncExternalStore(receiptQueue.subscribe, () =>
    receiptQueue.getSnapshot().reduce((n, r) => (r.tripId === tripId ? n + 1 : n), 0),
  );

const subscribeAppState = (listener: () => void) => {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
};

/** False while the app is in the background (or, on web, in a hidden tab). */
export const useAppInForeground = () =>
  useSyncExternalStore(subscribeAppState, () => AppState.currentState !== "background");
