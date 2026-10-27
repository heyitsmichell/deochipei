import { router } from "expo-router";
import { memo, useMemo } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { Button, Card, useTheme } from "../components/ui";
import { baseAmount } from "../lib/ledger";
import type { Trip } from "../lib/types";
import { useOnline, useQueuedCount, useReady, useTripList } from "../state/TripsContext";
import { useHomeCurrency } from "../state/useHomeCurrency";

export default function TripsScreen() {
  const { colors, styles } = useTheme();
  const ready = useReady();
  const trips = useTripList();
  const online = useOnline();

  if (!ready) {
    return (
      <View style={[styles.screen, { justifyContent: "center" }]}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      data={trips}
      keyExtractor={(t) => t.id}
      ListHeaderComponent={
        <View style={{ marginBottom: 16 }}>
          <Text style={styles.muted}>
            Snap receipts in any language, split costs, settle up in your own currency.
          </Text>
          {!online && (
            <Text style={{ color: colors.warning, marginTop: 8 }}>
              Offline — changes will sync when you reconnect. Receipts you snap are read once you&apos;re on Wi-Fi.
            </Text>
          )}
          <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
            <Button title="+ New trip" onPress={() => router.push("/new-trip")} style={{ flex: 1 }} />
            <Button
              title="Join with code"
              variant="secondary"
              onPress={() => router.push("/join")}
              style={{ flex: 1 }}
            />
          </View>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
            <Button
              title="💱 Converter"
              variant="ghost"
              onPress={() => router.push("/converter")}
              style={{ flex: 1 }}
            />
            <Button
              title="⚙️ Settings"
              variant="ghost"
              onPress={() => router.push("/settings")}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      }
      ListEmptyComponent={
        <Card>
          <Text style={styles.h2}>No trips yet</Text>
          <Text style={styles.muted}>
            Create a trip and share its code with your travel buddies, or join theirs.
          </Text>
        </Card>
      }
      renderItem={({ item }) => <TripCard trip={item} />}
    />
  );
}

// Memoized: a trip syncing re-renders its own card, not every card on the list.
const TripCard = memo(function TripCard({ trip }: { trip: Trip }) {
  const { colors, styles } = useTheme();
  const queued = useQueuedCount(trip.id);
  const { view } = useHomeCurrency(trip);
  const spent = useMemo(() => trip.expenses.reduce((sum, e) => sum + baseAmount(e), 0), [trip.expenses]);
  const total = view.format(spent);
  return (
    <Pressable onPress={() => router.push(`/trip/${trip.id}`)}>
      <Card>
        <Text style={styles.h2}>{trip.name}</Text>
        <Text style={styles.muted}>{trip.members.map((m) => m.name).join(", ")}</Text>
        <Text style={{ marginTop: 8, fontWeight: "600", color: colors.text }}>
          {total.main} · {trip.expenses.length} expenses
        </Text>
        {total.original && <Text style={[styles.muted, { fontSize: 13 }]}>{total.original}</Text>}
        {queued > 0 && (
          <Text style={{ color: colors.warning, marginTop: 4 }}>
            🧾 {queued} receipt{queued === 1 ? "" : "s"} waiting to be read
          </Text>
        )}
      </Card>
    </Pressable>
  );
});
