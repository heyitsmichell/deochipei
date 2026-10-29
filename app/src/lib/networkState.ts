export interface NetworkStatus {
  /**
   * A network interface is up. This deliberately does not require the internet
   * to be validated: a guest trip works entirely on-device, and a hotel or
   * ship Wi-Fi may be connected without reaching the outside world.
   */
  connected: boolean;
  /** On mobile data, where uploading photos can be slow or cost money while roaming. */
  cellular: boolean;
}

type StateLike = {
  isConnected?: boolean;
  isInternetReachable?: boolean;
  type?: string;
};

/**
 * Turns expo-network's state into the app's simpler status.
 *
 * `isInternetReachable` is false on Android when a Wi-Fi network has not
 * passed internet validation (captive portals, travel routers, LAN-only
 * setups). Using it to decide `connected` made the app claim it was offline
 * while the phone was plainly on Wi-Fi. We treat a connected interface as
 * connected and let actual requests surface server or internet failures.
 */
export function networkStatus(state: StateLike | undefined | null): NetworkStatus {
  const connected =
    state?.isConnected !== false || state?.isInternetReachable === true;
  return {
    connected,
    cellular: state?.type === "CELLULAR",
  };
}
