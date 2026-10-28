import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/errors";
import { parseInviteCode } from "../lib/invite";
import type { Trip } from "../lib/types";
import { useTripActions } from "../state/TripsContext";
import { QrScanner } from "./QrScanner";
import { Button, Card, Chip, Field, useTheme } from "./ui";

/**
 * Join a trip by code, by scanning its QR code, or straight from an invite
 * link (`initialCode`), then pick which member you are.
 */
export function JoinTrip({ initialCode }: { initialCode?: string }) {
  const { colors, styles } = useTheme();
  const { user, loading: authLoading, displayName: authDisplayName, email: authEmail, avatarUrl: authAvatarUrl } = useAuth();
  const { joinTrip, claimTripMember, addMember, meFor } = useTripActions();
  const [code, setCode] = useState(initialCode ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [newName, setNewName] = useState("");
  const [scanning, setScanning] = useState(false);
  const linked = useRef(false);

  const lookup = async (text: string) => {
    const parsed = parseInviteCode(text);
    if (!parsed) {
      setError("Trip codes are 6 to 36 letters and numbers.");
      return;
    }
    setCode(parsed);
    setError(null);
    setLoading(true);
    try {
      const userInfo = user
        ? {
            id: user.id,
            email: authEmail ?? user.email,
            displayName: authDisplayName,
            avatarUrl: authAvatarUrl,
          }
        : undefined;
      const found = await joinTrip(parsed, userInfo);
      // Already part of it on this phone (say, you scanned your own code or bound): just open it.
      if (meFor(found.id)) {
        router.replace(`/trip/${found.id}`);
        return;
      }
      setTrip(found);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't reach the server. Check your connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  // Opened from an invite link or QR code: look the trip up right away.
  useEffect(() => {
    if (initialCode && !authLoading && !linked.current) {
      linked.current = true;
      lookup(initialCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode, authLoading]);

  const pick = async (memberId: string) => {
    if (!trip) return;
    const identity = user?.id ? { id: user.id, email: authEmail ?? user.email, avatarUrl: authAvatarUrl } : undefined;
    setError(null);
    setLoading(true);
    try {
      await claimTripMember(trip.id, memberId, identity);
      router.replace(`/trip/${trip.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't join this trip. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {!trip ? (
        <>
          <Field
            label="Trip code"
            placeholder="e.g. 7KQ2MX"
            autoCapitalize="characters"
            autoCorrect={false}
            value={code}
            onChangeText={setCode}
            style={{ fontSize: 22, letterSpacing: 4, fontWeight: "700" }}
          />
          <Button title="Find trip" onPress={() => lookup(code)} loading={loading} disabled={code.trim().length < 6} />
          {error && <Text style={{ color: colors.negative, marginTop: 10 }}>{error}</Text>}
          <Text style={[styles.muted, { textAlign: "center", marginVertical: 16 }]}>or</Text>
          <Button title="📷 Scan invite QR code" variant="secondary" onPress={() => setScanning(true)} />
          <Text style={[styles.muted, { fontSize: 12, marginTop: 8, textAlign: "center" }]}>
            Your phone&apos;s camera app can usually open an invite QR code too.
          </Text>
          <QrScanner
            visible={scanning}
            onClose={() => setScanning(false)}
            onCode={(scanned) => {
              setScanning(false);
              lookup(scanned);
            }}
          />
        </>
      ) : (
        <Card>
          <Text style={styles.h2}>{trip.name}</Text>
          <Text style={[styles.muted, { marginBottom: 12 }]}>Which one is you?</Text>
          <View style={styles.chips}>
            {trip.members.map((m) => (
              <Chip key={m.id} label={m.name} selected={false} onPress={() => void pick(m.id)} />
            ))}
          </View>
          <Text style={[styles.muted, { marginVertical: 12 }]}>Not listed? Add yourself:</Text>
          <Field label="Your name" value={newName} onChangeText={setNewName} />
          <Button
            title="Add me and join"
            disabled={!newName.trim()}
            onPress={() => {
              const added = addMember(trip.id, newName, user?.id ? {
                id: user.id, email: authEmail ?? user.email, avatarUrl: authAvatarUrl,
              } : undefined, false);
              void pick(added.id);
            }}
          />
        </Card>
      )}
    </ScrollView>
  );
}
