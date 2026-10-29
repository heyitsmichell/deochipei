import { Text, View } from "react-native";
import type { Member } from "../../lib/types";
import { Button, Card, useTheme } from "../ui";

export function ShareWeights({
  members,
  memberIds,
  weights,
  onChange,
}: {
  members: Member[];
  memberIds: string[];
  weights: Record<string, number>;
  onChange: (memberId: string, weight: number) => void;
}) {
  const { colors, styles } = useTheme();

  return (
    <Card style={{ marginBottom: 10 }}>
      <Text style={styles.h2} accessibilityRole="header">Share weights</Text>
      <Text style={[styles.muted, { fontSize: 12, marginBottom: 8 }]}>
        Give each person a number of shares. Amounts are split in proportion, so a 2-share adult pays twice a 1-share child.
      </Text>
      {memberIds.length === 0 ? (
        <Text style={styles.muted}>Select people to split with first.</Text>
      ) : (
        memberIds.map((memberId) => {
          const member = members.find((candidate) => candidate.id === memberId);
          const memberName = member?.name ?? "Someone";
          const weight = weights[memberId] ?? 1;
          return (
            <View
              key={memberId}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
            >
              <Text style={{ flex: 1, color: colors.text }}>{memberName}</Text>
              <Button
                title="−"
                variant="secondary"
                style={{ width: 42, paddingVertical: 4 }}
                onPress={() => onChange(memberId, Math.max(1, weight - 1))}
                accessibilityLabel={`Fewer shares for ${memberName}`}
                accessibilityHint={`Currently ${weight} ${weight === 1 ? "share" : "shares"}`}
              />
              <Text
                style={{ minWidth: 28, textAlign: "center", fontWeight: "700", color: colors.text }}
                accessibilityLabel={`${weight} ${weight === 1 ? "share" : "shares"} for ${memberName}`}
              >
                {weight}
              </Text>
              <Button
                title="+"
                variant="secondary"
                style={{ width: 42, paddingVertical: 4 }}
                onPress={() => onChange(memberId, Math.min(99, weight + 1))}
                accessibilityLabel={`More shares for ${memberName}`}
                accessibilityHint={`Currently ${weight} ${weight === 1 ? "share" : "shares"}`}
              />
            </View>
          );
        })
      )}
    </Card>
  );
}
