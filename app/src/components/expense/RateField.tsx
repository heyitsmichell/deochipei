import { Text, View } from "react-native";
import { formatMoney } from "../../lib/money";
import { Button, Card, Input, useTheme } from "../ui";

/** The exchange-rate row shown when an expense is not in the trip's base currency. */
export function RateField({
  currency,
  baseCurrency,
  rateText,
  rateLoading,
  rateInfo,
  rateWarning,
  amount,
  rate,
  onRateChange,
  onRefresh,
}: {
  currency: string;
  baseCurrency: string;
  rateText: string;
  rateLoading: boolean;
  rateInfo: string | null;
  rateWarning: boolean;
  amount: number | null;
  rate: number | null;
  onRateChange: (text: string) => void;
  onRefresh: () => void;
}) {
  const { colors, styles } = useTheme();

  return (
    <Card style={{ marginTop: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: colors.text }}>1 {currency} =</Text>
        <Input
          accessibilityLabel={`Exchange rate from ${currency} to ${baseCurrency}`}
          accessibilityHint="Enter the rate used for this expense"
          style={{ flex: 1, paddingVertical: 6 }}
          keyboardType="decimal-pad"
          value={rateText}
          onChangeText={onRateChange}
        />
        <Text style={{ color: colors.text }}>{baseCurrency}</Text>
        <Button
          title="↻"
          variant="ghost"
          loading={rateLoading}
          onPress={onRefresh}
          accessibilityLabel="Refresh the live exchange rate"
        />
      </View>
      {(rateInfo || rateWarning) && (
        <Text
          style={[styles.muted, { fontSize: 12, marginTop: 6 }]}
          accessibilityLiveRegion="polite"
        >
          {rateWarning ? "Custom rate differs greatly from the live rate. Check it carefully." : rateInfo}
        </Text>
      )}
      {amount != null && rate != null && (
        <Text
          style={{ marginTop: 8, fontSize: 18, fontWeight: "700", color: colors.tint }}
          accessibilityLiveRegion="polite"
          accessibilityLabel={`About ${formatMoney(amount * rate, baseCurrency)}`}
        >
          ≈ {formatMoney(amount * rate, baseCurrency)}
        </Text>
      )}
    </Card>
  );
}
