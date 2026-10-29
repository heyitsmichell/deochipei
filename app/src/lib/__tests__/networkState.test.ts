import assert from "node:assert/strict";
import { test } from "node:test";
import { networkStatus } from "../networkState";

test("Wi-Fi without validated internet is still connected", () => {
  // Android reports isInternetReachable=false for a captive portal, a travel
  // router, or a LAN with no outside route. Guest trips still work there.
  assert.deepEqual(
    networkStatus({ type: "WIFI", isConnected: true, isInternetReachable: false }),
    { connected: true, cellular: false },
  );
});

test("the app is offline only when the radio reports no connection", () => {
  assert.deepEqual(
    networkStatus({ type: "NONE", isConnected: false, isInternetReachable: false }),
    { connected: false, cellular: false },
  );
});

test("missing or unknown state is treated optimistically", () => {
  assert.equal(networkStatus(undefined).connected, true);
  assert.equal(networkStatus({}).connected, true);
  assert.equal(networkStatus({ isConnected: undefined, isInternetReachable: false }).connected, true);
});

test("internet reachable over an unrecognised interface counts as connected", () => {
  // expo-network reports isConnected=false for some VPN/unknown transports.
  assert.equal(networkStatus({ isConnected: false, isInternetReachable: true }).connected, true);
});

test("mobile data is flagged so receipts can wait for Wi-Fi", () => {
  assert.deepEqual(
    networkStatus({ type: "CELLULAR", isConnected: true, isInternetReachable: true }),
    { connected: true, cellular: true },
  );
});
