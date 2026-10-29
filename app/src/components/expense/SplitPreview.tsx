import { StyleSheet, Text, View } from "react-native";
import { formatMoney } from "../../lib/money";
import type { MemberBreakdown } from "../../lib/split";
import type { Member } from "../../lib/types";
import { Card, useTheme } from "../ui";

export function ItemizedShareBreakdown({
  breakdowns,
  members,
  currency,
  baseCurrency,
}: {
  breakdowns: MemberBreakdown[];
  members: Member[];
  currency: string;
  baseCurrency: string;
}) {
  const { colors, styles } = useTheme();
  const name = (memberId: string) => members.find((member) => member.id === memberId)?.name ?? "?";

  return (
    <Card>
      <Text style={styles.h2} accessibilityRole="header">Each person&apos;s share</Text>
      <Text style={[styles.muted, { fontSize: 12, marginBottom: 10 }]}>
        Detailed breakdown: claimed items, proportional tax &amp; tip, and final totals.
      </Text>
      {breakdowns.map((b) => (
        <View
          key={b.memberId}
          style={{
            marginBottom: 12,
            paddingBottom: 10,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border,
          }}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
            <Text style={{ fontWeight: "700", fontSize: 15, color: colors.text }}>{name(b.memberId)}</Text>
            <View style={{ alignItems: "flex-end" }}>
              <Text
                style={{ fontWeight: "700", fontSize: 15, color: colors.tint }}
                accessibilityLabel={`${name(b.memberId)} owes ${formatMoney(b.totalShare, currency)}`}
              >
                {formatMoney(b.totalShare, currency)}
              </Text>
              {currency !== baseCurrency && (
                <Text style={[styles.muted, { fontSize: 12 }]}>
                  ≈ {formatMoney(b.totalShareBase, baseCurrency)}
                </Text>
              )}
            </View>
          </View>

          {b.items.length > 0 ? (
            <View style={{ marginVertical: 4, gap: 2 }}>
              {b.items.map((it, idx) => (
                <View key={idx} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ flex: 1, color: colors.text, fontSize: 13 }}>
                    {it.quantity > 1 ? `${it.quantity}× ` : ""}
                    {it.translatedName}
                    {it.isUnassigned ? " (shared by all)" : it.sharedCount > 1 ? ` (shared 1/${it.sharedCount})` : ""}
                  </Text>
                  <Text style={{ color: colors.text, fontSize: 13, marginLeft: 8 }}>
                    {formatMoney(it.sharePrice, currency)}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={[styles.muted, { fontSize: 12, fontStyle: "italic", marginVertical: 4 }]}>
              No items claimed
            </Text>
          )}

          <View style={{ marginTop: 4, gap: 2 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={[styles.muted, { fontSize: 12 }]}>Items subtotal</Text>
              <Text style={[styles.muted, { fontSize: 12 }]}>{formatMoney(b.itemSubtotal, currency)}</Text>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={[styles.muted, { fontSize: 12 }]}>Tax &amp; tip share</Text>
              <Text style={[styles.muted, { fontSize: 12 }]}>
                {b.taxAndTipShare > 0 ? "+" : ""}{formatMoney(b.taxAndTipShare, currency)}
              </Text>
            </View>
          </View>
        </View>
      ))}
    </Card>
  );
}

export function ShareSummary({
  shares,
  members,
  currency,
  baseCurrency,
  rate,
}: {
  shares: Record<string, number>;
  members: Member[];
  currency: string;
  baseCurrency: string;
  rate: number | null;
}) {
  const { colors, styles } = useTheme();
  const name = (memberId: string) => members.find((member) => member.id === memberId)?.name ?? "?";

  return (
    <Card>
      <Text style={styles.h2} accessibilityRole="header">Each person&apos;s share</Text>
      {Object.entries(shares).map(([mid, share]) => (
        <View
          key={mid}
          style={{ flexDirection: "row", paddingVertical: 3 }}
          accessibilityLabel={
            currency !== baseCurrency && rate != null
              ? `${name(mid)} owes ${formatMoney(share, currency)}, about ${formatMoney(share * rate, baseCurrency)}`
              : `${name(mid)} owes ${formatMoney(share, currency)}`
          }
        >
          <Text style={{ flex: 1, color: colors.text }}>{name(mid)}</Text>
          <Text style={{ color: colors.text }}>{formatMoney(share, currency)}</Text>
          {currency !== baseCurrency && rate != null && (
            <Text style={[styles.muted, { width: 100, textAlign: "right" }]}>
              {formatMoney(share * rate, baseCurrency)}
            </Text>
          )}
        </View>
      ))}
    </Card>
  );
}
