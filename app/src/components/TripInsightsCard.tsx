import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Alert } from "../lib/alert";
import { tripInsights } from "../lib/insights";
import { formatMoney, parseAmount } from "../lib/money";
import type { Trip } from "../lib/types";
import { Button, Card, Input, useTheme } from "./ui";

/**
 * Spending by category plus an optional trip budget. Everything is in the
 * trip's base currency, using each expense's locked exchange rate.
 */
export function TripInsightsCard({
  trip,
  editable,
  onSaveBudget,
}: {
  trip: Trip;
  /** Only the owner can change a synced trip's budget; guest trips are local. */
  editable: boolean;
  onSaveBudget: (budget: number | null) => void;
}) {
  const { colors, styles } = useTheme();
  const insights = tripInsights(trip);
  const [editing, setEditing] = useState(false);
  const [budgetText, setBudgetText] = useState(trip.budget != null ? String(trip.budget) : "");
  const maxCategory = insights.categories[0]?.amount ?? 0;
  const budget = trip.budget;
  const spent = insights.total;
  const ratio = budget && budget > 0 ? spent / budget : 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  const barColor = ratio > 1 ? colors.negative : ratio >= 0.8 ? colors.warning : colors.positive;
  const percent = budget && budget > 0 ? Math.round(ratio * 100) : 0;

  const startEditing = () => {
    setBudgetText(budget != null ? String(budget) : "");
    setEditing(true);
  };

  const save = () => {
    const amount = parseAmount(budgetText, trip.baseCurrency);
    if (amount == null || amount <= 0) {
      Alert.alert("Enter a budget", `Enter how much the trip should spend in ${trip.baseCurrency}.`);
      return;
    }
    onSaveBudget(amount);
    setEditing(false);
  };

  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
        <Text style={styles.h2} accessibilityRole="header">Spending</Text>
        <Text style={[styles.muted, { fontSize: 12 }]}>
          {insights.spendingDays} {insights.spendingDays === 1 ? "day" : "days"} with expenses
        </Text>
      </View>

      <Text style={{ fontSize: 24, fontWeight: "700", color: colors.text }} accessibilityRole="header">
        {formatMoney(spent, trip.baseCurrency)}
      </Text>
      <Text style={[styles.muted, { fontSize: 12, marginBottom: 10 }]}>
        {insights.spendingDays > 0
          ? `${formatMoney(insights.averagePerSpendingDay, trip.baseCurrency)} a day on average`
          : "No expenses yet"}
      </Text>

      {budget != null ? (
        <View
          style={{ marginBottom: 12 }}
          accessibilityLabel={
            `Budget ${formatMoney(budget, trip.baseCurrency)}, ` +
            (ratio > 1
              ? `${formatMoney(spent - budget, trip.baseCurrency)} over`
              : `${formatMoney(budget - spent, trip.baseCurrency)} left, ${percent}% used`)
          }
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
            <Text style={{ color: colors.text, fontSize: 13 }}>
              Budget {formatMoney(budget, trip.baseCurrency)}
            </Text>
            <Text style={{ color: barColor, fontSize: 13, fontWeight: "600" }}>
              {ratio > 1
                ? `${formatMoney(spent - budget, trip.baseCurrency)} over`
                : `${formatMoney(budget - spent, trip.baseCurrency)} left`}
            </Text>
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: Math.min(100, percent) }}
            style={{ height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: "hidden" }}
          >
            <View style={{ width: `${clamped * 100}%`, height: "100%", backgroundColor: barColor }} />
          </View>
          {editable && (
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit the trip budget"
                onPress={startEditing}
              >
                <Text style={styles.link}>Edit budget</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove the trip budget"
                onPress={() => onSaveBudget(null)}
              >
                <Text style={{ color: colors.muted, fontWeight: "600" }}>Remove</Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : editable ? (
        <Button
          title="Set a trip budget"
          variant="secondary"
          onPress={startEditing}
          style={{ marginBottom: 12 }}
          accessibilityHint="Lets you enter a spending cap for this trip"
        />
      ) : null}

      {editing && (
        <View style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Input
              autoFocus
              accessibilityLabel={`Trip budget in ${trip.baseCurrency}`}
              placeholder={`Budget in ${trip.baseCurrency}`}
              keyboardType="decimal-pad"
              value={budgetText}
              onChangeText={setBudgetText}
              style={{ flex: 1 }}
            />
            <Button title="Save" onPress={save} />
            <Button title="Cancel" variant="ghost" onPress={() => setEditing(false)} />
          </View>
        </View>
      )}

      {insights.categories.length === 0 ? (
        <Text style={[styles.muted, { fontSize: 13 }]}>
          Add an expense to see where the money goes.
        </Text>
      ) : (
        <View style={{ gap: 8 }}>
          {insights.categories.map((category) => (
            <View
              key={category.category}
              accessibilityLabel={`${category.label}: ${formatMoney(category.amount, trip.baseCurrency)}, ${Math.round(category.share * 100)}% of spending`}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
                <Text style={{ color: colors.text, fontSize: 13 }}>
                  {category.icon} {category.label}
                </Text>
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: "600" }}>
                  {formatMoney(category.amount, trip.baseCurrency)}
                </Text>
              </View>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: "hidden" }}>
                <View
                  style={{
                    width: `${maxCategory > 0 ? (category.amount / maxCategory) * 100 : 0}%`,
                    height: "100%",
                    backgroundColor: colors.tint,
                  }}
                />
              </View>
            </View>
          ))}
          {insights.largest && (
            <Text style={[styles.muted, { fontSize: 12, marginTop: 2 }]}>
              Biggest expense: {insights.largest.description} · {formatMoney(insights.largest.amount, trip.baseCurrency)}
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}
