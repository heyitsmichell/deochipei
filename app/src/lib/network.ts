import * as Network from "expo-network";

export interface NetworkStatus {
  /** Some connection is up. It may still not reach the internet (hotel Wi-Fi login pages). */
  connected: boolean;
  /** On mobile data, where uploading photos can be slow or cost money while roaming. */
  cellular: boolean;
}

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
    const next = {
      connected: state.isConnected !== false && state.isInternetReachable !== false,
      cellular: state.type === Network.NetworkStateType.CELLULAR,
    };
    if (next.connected === this.status.connected && next.cellular === this.status.cellular) return;
    this.status = next;
    for (const listener of this.listeners) listener();
  }
}
