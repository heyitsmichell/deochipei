import { router } from "expo-router";
import { ActivityIndicator, Alert, Image, Pressable, Text, View } from "react-native";
import { formatMoney } from "../lib/money";
import type { NetworkStatus } from "../lib/network";
import {
  useNetwork,
  useSettings,
  useTrip,
  useTripActions,
  useTripReceipts,
  type QueuedReceipt,
} from "../state/TripsContext";
import { Button, Card, useTheme } from "./ui";

/** Receipts snapped offline for this trip that haven't turned into expenses yet. */
export function PendingReceipts({ tripId }: { tripId: string }) {
  const { colors, styles } = useTheme();
  const { retryReceipt, readReceiptsNow, discardReceipt } = useTripActions();
  const queued = useTripReceipts(tripId);
  const network = useNetwork();
  const settings = useSettings();
  if (!queued.length) return null;

  const onData = (r: QueuedReceipt) => r.allowCellular || settings.scanQueuedOnCellular;
  const heldForWifi = network.connected && network.cellular && queued.some((r) => r.status === "waiting" && !onData(r));

  const discard = (r: QueuedReceipt) =>
    Alert.alert("Discard this receipt?", "The photo will be deleted from this phone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => discardReceipt(r.id) },
    ]);

  return (
    <Card>
      <Text style={styles.h2}>
        🧾 {queued.length} receipt{queued.length === 1 ? "" : "s"} to read
      </Text>
      <Text style={[styles.muted, { marginBottom: 4 }]}>
        {queued.every((r) => r.status === "failed" || r.status === "duplicate")
          ? "These couldn't be added automatically. Check each one below."
          : !network.connected
            ? "Saved on this phone. They'll be read and added for everyone once you're on Wi-Fi."
            : heldForWifi
              ? "Waiting for Wi-Fi so they don't use your mobile data."
              : "They're added to the trip as soon as they're read. Check the split on each one."}
      </Text>

      {queued.map((r) => (
        <View key={r.id} style={{ flexDirection: "row", gap: 12, paddingVertical: 10, alignItems: "center" }}>
          <Image source={{ uri: r.imageUri }} style={{ width: 44, height: 58, borderRadius: 6, backgroundColor: colors.border }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: "600", color: colors.text }}>
              Snapped {new Date(r.capturedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}
            </Text>
            <ReceiptStatus receipt={r} network={network} onData={onData(r)} />
            {r.status === "duplicate" && <DuplicateNote receipt={r} tripId={tripId} />}
            {r.status === "failed" && (
              <View style={{ flexDirection: "row", gap: 16, marginTop: 6 }}>
                <Link title="Try again" onPress={() => retryReceipt(r.id)} />
                <Link
                  title="Enter by hand"
                  onPress={() =>
                    router.push({ pathname: "/trip/[id]/expense", params: { id: tripId, queuedId: r.id } })
                  }
                />
              </View>
            )}
          </View>
          {r.status !== "reading" && (
            <Pressable onPress={() => discard(r)} hitSlop={10}>
              <Text style={{ color: colors.muted, fontSize: 18 }}>✕</Text>
            </Pressable>
          )}
        </View>
      ))}

      {heldForWifi && (
        <Button
          title="Read them now on mobile data"
          variant="secondary"
          onPress={() => readReceiptsNow(tripId)}
          style={{ marginTop: 6 }}
        />
      )}
    </Card>
  );
}

/** What a receipt held as a duplicate seems to repeat, and the user's options. */
function DuplicateNote({ receipt: r, tripId }: { receipt: QueuedReceipt; tripId: string }) {
  const { colors, styles } = useTheme();
  const { addReceiptAnyway, discardReceipt } = useTripActions();
  const trip = useTrip(tripId);
  const match = trip?.expenses.find((e) => e.id === r.duplicate?.expenseId);
  const payer = trip?.members.find((m) => m.id === match?.paidBy)?.name ?? "Someone";

  const addAnyway = () =>
    Alert.alert("Add it as a separate expense?", "Only if it's a different purchase, or the trip pays for it twice.", [
      { text: "Cancel", style: "cancel" },
      { text: "Add it", onPress: () => addReceiptAnyway(r.id) },
    ]);

  return (
    <>
      {match ? (
        <Pressable
          onPress={() =>
            router.push({ pathname: "/trip/[id]/expense", params: { id: tripId, expenseId: match.id } })
          }
        >
          <Text style={{ color: colors.text, fontSize: 13, marginTop: 2 }}>
            {payer} paid &quot;{match.description || "Expense"}&quot; · {formatMoney(match.amount, match.currency)} ·{" "}
            {match.date} ›
          </Text>
        </Pressable>
      ) : (
        <Text style={[styles.muted, { fontSize: 13 }]}>The matching expense has since been deleted.</Text>
      )}
      {!!r.duplicate?.reason && <Text style={[styles.muted, { fontSize: 13, marginTop: 2 }]}>{r.duplicate.reason}</Text>}
      <View style={{ flexDirection: "row", gap: 16, marginTop: 6 }}>
        <Link title="Discard copy" onPress={() => discardReceipt(r.id)} />
        <Link title="Add anyway" onPress={addAnyway} />
      </View>
    </>
  );
}

function ReceiptStatus({ receipt: r, network, onData }: { receipt: QueuedReceipt; network: NetworkStatus; onData: boolean }) {
  const { colors, styles } = useTheme();
  if (r.status === "reading") {
    return (
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <ActivityIndicator size="small" color={colors.muted} />
        <Text style={styles.muted}>Reading and translating…</Text>
      </View>
    );
  }
  if (r.status === "failed") {
    return <Text style={{ color: colors.negative }}>Couldn&apos;t add it: {r.error}</Text>;
  }
  if (r.status === "duplicate") {
    return (
      <Text style={{ color: colors.warning, fontWeight: "600" }}>
        {r.duplicate?.confidence === "high" ? "Already on the trip" : "Might already be on the trip"}
      </Text>
    );
  }
  const text = !network.connected
    ? "Waiting for a connection"
    : network.cellular && !onData
      ? "Waiting for Wi-Fi"
      : r.error
        ? `Will try again shortly · ${r.error}`
        : "Up next";
  return <Text style={styles.muted}>{text}</Text>;
}

function Link({ title, onPress }: { title: string; onPress: () => void }) {
  const { styles } = useTheme();
  return (
    <Pressable onPress={onPress} hitSlop={6}>
      <Text style={styles.link}>{title}</Text>
    </Pressable>
  );
}
