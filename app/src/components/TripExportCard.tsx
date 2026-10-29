import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useState } from "react";
import { Share, Text, View } from "react-native";
import { Alert } from "../lib/alert";
import type { Ledger } from "../lib/ledger";
import { tripCsv, tripExportFilename, tripRecap } from "../lib/tripExport";
import type { Trip } from "../lib/types";
import { Button, Card, useTheme } from "./ui";

/** Share a plain-language summary or a CSV of every expense with the group. */
export function TripExportCard({ trip, ledger }: { trip: Trip; ledger: Ledger }) {
  const { styles } = useTheme();
  const [sharingRecap, setSharingRecap] = useState(false);
  const [exporting, setExporting] = useState(false);

  const shareRecap = async () => {
    if (sharingRecap) return;
    setSharingRecap(true);
    try {
      await Share.share({ title: `${trip.name} recap`, message: tripRecap(trip, ledger) });
    } catch (error) {
      Alert.alert("Couldn't share the recap", error instanceof Error ? error.message : "Try again.");
    } finally {
      setSharingRecap(false);
    }
  };

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const csv = tripCsv(trip);
      if (!(await Sharing.isAvailableAsync())) {
        // Web and other limited platforms can still share the text itself.
        await Share.share({ title: tripExportFilename(trip), message: csv });
        return;
      }
      const file = new File(Paths.cache, tripExportFilename(trip));
      if (file.exists) file.delete();
      await file.write(csv);
      await Sharing.shareAsync(file.uri, {
        dialogTitle: "Share trip expenses",
        mimeType: "text/csv",
        UTI: "public.comma-separated-values-text",
      });
    } catch (error) {
      Alert.alert("Couldn't export the CSV", error instanceof Error ? error.message : "Try again.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <Text style={styles.h2} accessibilityRole="header">Share the trip</Text>
      <Text style={[styles.muted, { fontSize: 12, marginBottom: 10 }]}>
        A recap for the group chat, or a CSV of every expense with its locked exchange rate.
      </Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button
          title="Share recap"
          variant="secondary"
          style={{ flex: 1 }}
          loading={sharingRecap}
          onPress={() => void shareRecap()}
          accessibilityHint="Opens the system share sheet with balances and suggested payments"
        />
        <Button
          title="Export CSV"
          variant="secondary"
          style={{ flex: 1 }}
          loading={exporting}
          onPress={() => void exportCsv()}
          accessibilityHint="Opens the system share sheet with a spreadsheet of every expense"
        />
      </View>
    </Card>
  );
}
