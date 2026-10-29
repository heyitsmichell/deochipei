import { Text, View } from "react-native";
import { formatMoney } from "../lib/money";
import type { Expense, Trip } from "../lib/types";
import type { ExpenseConflict } from "../state/TripRepository";
import { Button, Card, useTheme } from "./ui";

/** One line of what an expense says, enough to tell two versions apart. */
export function describeExpense(expense: Expense, trip: Trip): string {
  const payer = trip.members.find((m) => m.id === expense.paidBy)?.name ?? "someone";
  const who = (id: string) => trip.members.find((m) => m.id === id)?.name ?? "?";
  const split = expense.split?.memberIds?.map(who).join(", ") || "nobody";
  return `${expense.description || "Expense"} · ${formatMoney(expense.amount, expense.currency)} · ${expense.date} · paid by ${payer} · split ${expense.split?.type === "items" ? "by item" : "equally"} (${split})`;
}

/**
 * Shown when an edit made here was refused because someone else changed the same
 * expense first. Nothing is lost: both versions are listed and the person picks.
 */
export function ExpenseConflicts({
  trip,
  conflicts,
  onResolve,
}: {
  trip: Trip;
  conflicts: ExpenseConflict[];
  onResolve: (conflict: ExpenseConflict, choice: "mine" | "theirs") => void;
}) {
  const { colors, styles } = useTheme();
  if (!conflicts.length) return null;
  return (
    <>
      {conflicts.map((conflict) => {
        const deleted = conflict.theirs === null;
        return (
          <Card key={`${conflict.tripId}:${conflict.expenseId}`} style={{ borderColor: colors.warning, marginBottom: 10 }}>
            <Text accessibilityRole="header" style={{ fontWeight: "700", color: colors.warning }}>
              {deleted ? "This expense was deleted" : "This expense changed"}
            </Text>
            <Text style={[styles.muted, { marginTop: 4 }]}>
              {deleted
                ? "Someone deleted it while you were editing. Restore your version as a new expense, or accept the deletion."
                : "Someone else saved it before your edit reached the server. Choose which version to keep."}
            </Text>
            <View style={{ marginTop: 10 }}>
              <Text style={{ fontWeight: "600", color: colors.text }}>Your version</Text>
              <Text style={styles.muted}>{describeExpense(conflict.mine, trip)}</Text>
            </View>
            {conflict.theirs && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontWeight: "600", color: colors.text }}>Their version (now shown)</Text>
                <Text style={styles.muted}>{describeExpense(conflict.theirs, trip)}</Text>
              </View>
            )}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <Button
                title={deleted ? "Restore mine" : "Keep mine"}
                variant="secondary"
                onPress={() => onResolve(conflict, "mine")}
                style={{ flex: 1 }}
              />
              <Button
                title={deleted ? "Accept deletion" : "Use theirs"}
                variant="ghost"
                onPress={() => onResolve(conflict, "theirs")}
                style={{ flex: 1 }}
              />
            </View>
          </Card>
        );
      })}
    </>
  );
}
