import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { useState } from "react";
import { Alert, Modal, ScrollView, Share, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../context/AuthContext";
import { INVITE_URL } from "../lib/api";
import { formatInviteExpiry, inviteUrl, isInviteExpired } from "../lib/invite";
import type { Trip } from "../lib/types";
import { useMe, useTrip, useTripActions } from "../state/TripsContext";
import { QrCode } from "./QrCode";
import { Button, Card, useTheme } from "./ui";

/** The trip's join QR code, for friends to scan with their phone camera. */
export function InviteSheet({ trip, visible, onClose }: { trip: Trip; visible: boolean; onClose: () => void }) {
  const { colors, styles } = useTheme();
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const { user } = useAuth();
  const { regenerateTripInvite } = useTripActions();
  const me = useMe(trip.id);
  const liveTrip = useTrip(trip.id) ?? trip;

  const code = liveTrip.code || liveTrip.inviteCode;
  const url = code ? inviteUrl(code, INVITE_URL, (path) => Linking.createURL(path)) : null;
  const expiresAt = liveTrip.inviteExpiresAt;
  const expired = isInviteExpired(expiresAt);

  const isOwner = Boolean(
    (liveTrip.ownerId && user?.id && liveTrip.ownerId === user.id) ||
    (liveTrip.ownerId && me && liveTrip.members.find((m) => m.id === me)?.userId === liveTrip.ownerId) ||
    (!liveTrip.ownerId && me && liveTrip.members[0]?.id === me) ||
    (user?.id && liveTrip.members.find((m) => m.id === me)?.userId === user.id && liveTrip.members[0]?.id === me) ||
    (me && liveTrip.members[0]?.id === me),
  );

  const share = () => {
    if (!code || !url) return;
    Share.share({
      message: `Join "${liveTrip.name}" on Deochipei: ${url}\n\nOr open Deochipei, tap "Join with code" and enter ${code}.`,
    });
  };

  const copy = async () => {
    if (!code) return;
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const onRegenerate = async () => {
    setRegenerating(true);
    try {
      await regenerateTripInvite(liveTrip.id);
    } catch (err) {
      Alert.alert("Couldn't regenerate invite", err instanceof Error ? err.message : String(err));
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView contentContainerStyle={[styles.content, { alignItems: "center" }]}>
          <Text style={[styles.h1, { textAlign: "center" }]}>Invite to {liveTrip.name}</Text>
          {code && url ? (
            <>
              <Text style={[styles.muted, { textAlign: "center", marginTop: 6, marginBottom: 8 }]}>
                Friends scan this with their phone camera to join. Or they can tap &quot;Join with code&quot; in
                Deochipei and scan it there.
              </Text>
              <View style={{ marginBottom: 16, alignItems: "center" }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "600",
                    color: expired ? colors.negative : colors.muted,
                  }}
                >
                  {expired ? "⚠️ Invite expired" : `⏳ ${formatInviteExpiry(expiresAt)}`}
                </Text>
              </View>
              <Card style={{ padding: 12, alignItems: "center" }}>
                <QrCode value={url} size={240} />
              </Card>
              <Text style={[styles.muted, { marginTop: 8 }]}>Trip code</Text>
              <Text style={{ fontSize: 30, fontWeight: "700", letterSpacing: 6, color: colors.text }}>{code}</Text>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 20, alignSelf: "stretch" }}>
                <Button title="Share link" onPress={share} style={{ flex: 1 }} />
                <Button title={copied ? "Copied ✓" : "Copy code"} variant="secondary" onPress={copy} style={{ flex: 1 }} />
              </View>
              {isOwner && (
                <Button
                  title={regenerating ? "Regenerating…" : "🔄 Regenerate Invite Link"}
                  variant="secondary"
                  loading={regenerating}
                  onPress={onRegenerate}
                  style={{ marginTop: 10, alignSelf: "stretch" }}
                />
              )}
              {expired && !isOwner && (
                <Text style={{ color: colors.negative, marginTop: 10, textAlign: "center", fontSize: 13 }}>
                  This invite has expired. Ask the trip owner to regenerate the link.
                </Text>
              )}
            </>
          ) : (
            <Card style={{ marginTop: 20, alignSelf: "stretch" }}>
              <Text style={styles.h2}>Not synced yet</Text>
              <Text style={styles.muted}>
                The trip gets its invite code the first time it reaches the server. Connect to the internet and
                it will appear here.
              </Text>
            </Card>
          )}
          <Button title="Done" variant="ghost" onPress={onClose} style={{ marginTop: 12, alignSelf: "stretch" }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
