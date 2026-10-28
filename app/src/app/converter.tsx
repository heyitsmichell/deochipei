import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Card, CurrencyPicker, Input, useTheme } from "../components/ui";
import { formatMoney, parseAmount } from "../lib/money";
import { describeAge, rateService, type RateTable } from "../lib/rates";
import { useSettings, useTripList } from "../state/TripsContext";

const QUICK = ["USD", "EUR", "GBP", "JPY", "THB", "KRW", "AUD", "CAD"];

export default function ConverterScreen() {
  const { colors, styles } = useTheme();
  const trips = useTripList();
  const settings = useSettings();
  const [amountText, setAmountText] = useState("100");
  const [from, setFrom] = useState(trips[0]?.expenses.at(-1)?.currency ?? "EUR");
  const [to, setTo] = useState(settings.homeCurrency ?? trips[0]?.baseCurrency ?? "USD");
  const [table, setTable] = useState<RateTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextTable = await rateService.getTable(from, true);
      setTable(nextTable);
      setError(null);
    } catch {
      setError("Couldn't load rates. Check your connection.");
    } finally {
      setLoading(false);
    }
  }, [from]);

  useEffect(() => {
    let active = true;

    async function fetchRates(force = false) {
      try {
        const nextTable = await rateService.getTable(from, force);
        if (active) {
          setTable(nextTable);
          setError(null);
        }
      } catch {
        if (active) {
          setError("Couldn't load rates. Check your connection.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void fetchRates();
    // Keep the numbers live while the screen is open.
    const t = setInterval(() => {
      void fetchRates();
    }, 60000);

    return () => {
      active = false;
      clearInterval(t);
    };
  }, [from]);

  const amount = parseAmount(amountText) ?? 0;
  const rate = from === to ? 1 : table?.base === from ? table.rates[to] : undefined;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={handleRefresh}
          tintColor={colors.muted}
          colors={[colors.primary]}
          progressBackgroundColor={colors.card}
        />
      }
    >
      <Card>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Input
            style={{ flex: 1, fontSize: 24, fontWeight: "700" }}
            keyboardType="decimal-pad"
            value={amountText}
            onChangeText={setAmountText}
          />
          <CurrencyPicker compact value={from} onChange={setFrom} />
        </View>
        <Pressable
          onPress={() => {
            setFrom(to);
            setTo(from);
          }}
          style={{ alignSelf: "center", padding: 10 }}
        >
          <Text style={{ fontSize: 22, color: colors.tint }}>⇅</Text>
        </Pressable>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={{ flex: 1, fontSize: 28, fontWeight: "700", color: colors.tint }}>
            {rate ? formatMoney(amount * rate, to) : "—"}
          </Text>
          <CurrencyPicker compact value={to} onChange={setTo} />
        </View>
        {rate && (
          <Text style={[styles.muted, { marginTop: 10 }]}>
            1 {from} = {Number(rate.toPrecision(6))} {to} · 1 {to} = {Number((1 / rate).toPrecision(6))} {from}
          </Text>
        )}
        {table && (
          <Text style={[styles.muted, { fontSize: 12, marginTop: 4 }]}>
            {table.source} · updated {describeAge(table.fetchedAt)} · pull to refresh
          </Text>
        )}
        {error && <Text style={{ color: colors.negative, marginTop: 8 }}>{error}</Text>}
      </Card>

      {table && (
        <Card>
          <Text style={styles.h2}>
            {formatMoney(amount, from)} in other currencies
          </Text>
          {QUICK.filter((c) => c !== from && table.rates[c]).map((c) => (
            <Pressable key={c} onPress={() => setTo(c)} style={{ flexDirection: "row", paddingVertical: 6 }}>
              <Text style={{ flex: 1, color: colors.text }}>{c}</Text>
              <Text style={{ fontWeight: "600", color: colors.text }}>
                {formatMoney(amount * table.rates[c], c)}
              </Text>
            </Pressable>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}
