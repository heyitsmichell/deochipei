import * as Network from "expo-network";
import { networkStatus, type NetworkStatus } from "./networkState";

export type { NetworkStatus } from "./networkState";

export interface NetworkMonitor {
  current(): NetworkStatus;
  subscribe(listener: () => void): () => void;
}

/** expo-network as a plain snapshot + listeners, for useSyncExternalStore and the receipt queue. */
export class ExpoNetworkMonitor implements NetworkMonitor {
  // Assume online until told otherwise; a failed request still falls back to offline handling.
  private status: NetworkStatus = { connected: true, cellular: false };
  private readonly listeners = new Set<() => void>();
  private subscription?: { remove(): void };

  start() {
    if (this.subscription) return;
    this.subscription = Network.addNetworkStateListener((state) => this.set(state));
    Network.getNetworkStateAsync()
      .then((state) => this.set(state))
      // A failure to read the radio state must not leave the app stuck offline.
      .catch(() => {});
  }

  stop() {
    this.subscription?.remove();
    this.subscription = undefined;
  }

  current = () => this.status;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(state: Network.NetworkState) {
    const next = networkStatus(state);
    if (next.connected === this.status.connected && next.cellular === this.status.cellular) return;
    this.status = next;
    for (const listener of this.listeners) listener();
  }
}
