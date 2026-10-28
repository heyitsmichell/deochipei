import { useState } from "react";
import { Alert, Image, ScrollView, Switch, Text, View } from "react-native";
import { Button, Card, Chip, CurrencyPicker, Field, useTheme } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { API_URL } from "../lib/api";
import type { ThemePreference } from "../lib/types";
import { useOnline, useQueuedReceipts, useSettings, useTripActions } from "../state/TripsContext";

const LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Chinese (Simplified)",
  "Japanese",
  "Korean",
  "Vietnamese",
  "Thai",
  "Hindi",
  "Arabic",
];

const APPEARANCES: { key: ThemePreference; label: string }[] = [
  { key: "system", label: "Automatic" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

export default function SettingsScreen() {
  const { colors, styles } = useTheme();
  const { updateSettings, setHomeCurrency } = useTripActions();
  const { user, loading: authLoading, signInWithGoogle, signInWithApple, signOut, displayName, avatarUrl, providerLabel } = useAuth();
  const [signingIn, setSigningIn] = useState<"google" | "apple" | null>(null);
  const settings = useSettings();
  const online = useOnline();
  const receipts = useQueuedReceipts();
  const [custom, setCustom] = useState(
    LANGUAGES.includes(settings.receiptLanguage) ? "" : settings.receiptLanguage,
  );

  const handleSignIn = async (provider: "google" | "apple") => {
    setSigningIn(provider);
    try {
      if (provider === "google") {
        await signInWithGoogle();
      } else {
        await signInWithApple();
      }
    } catch (err) {
      Alert.alert("Sign In Failed", err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(null);
    }
  };

  const handleSignOut = async () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          try {
            await signOut();
          } catch (err) {
            Alert.alert("Sign Out Failed", err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <Text style={styles.h2}>Account</Text>
        {user ? (
          <View style={{ gap: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
              {avatarUrl ? (
                <Image
                  source={{ uri: avatarUrl }}
                  style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.border }}
                />
              ) : (
                <View
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: colors.tint,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ fontSize: 24, color: "#fff", fontWeight: "700" }}>
                    {(displayName?.[0] || user.email?.[0] || "U").toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>{displayName}</Text>
                <Text style={[styles.muted, { fontSize: 14, marginTop: 2 }]}>{user.email}</Text>
                <Text style={{ fontSize: 12, color: colors.positive, marginTop: 4 }}>
                  ✓ Signed in with {providerLabel}
                </Text>
              </View>
            </View>
            <Button title="Sign Out" variant="secondary" onPress={handleSignOut} />
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <Text style={styles.muted}>
              Sign in with your Google or Apple account to sync trips across devices and verify access to receipt scanning.
            </Text>
            <View style={{ gap: 8 }}>
              <Button
                title="Sign in with Google"
                onPress={() => handleSignIn("google")}
                loading={signingIn === "google" || authLoading}
              />
              <Button
                title="Sign in with Apple"
                onPress={() => handleSignIn("apple")}
                loading={signingIn === "apple" || authLoading}
                variant="secondary"
              />
            </View>
          </View>
        )}
      </Card>
      <Card>
        <Text style={styles.h2}>Appearance</Text>
        <View style={styles.chips}>
          {APPEARANCES.map((a) => (
            <Chip
              key={a.key}
              label={a.label}
              selected={settings.appearance === a.key}
              onPress={() => updateSettings({ appearance: a.key })}
            />
          ))}
        </View>
        <Text style={styles.muted}>
          {settings.appearance === "system"
            ? "Light or dark, following your phone's setting."
            : `Always ${settings.appearance}, whatever your phone is set to.`}
        </Text>
      </Card>
      <Card>
        <Text style={styles.h2}>Your home currency</Text>
        <Text style={[styles.muted, { marginBottom: 10 }]}>
          Trip totals, balances and who owes whom are shown in this, whatever currency the receipts were in.
          Your travel buddies see it next to your name.
        </Text>
        <CurrencyPicker value={settings.homeCurrency} onChange={setHomeCurrency} />
      </Card>
      <Card>
        <Text style={styles.h2}>Translate receipts into</Text>
        <View style={styles.chips}>
          {LANGUAGES.map((l) => (
            <Chip
              key={l}
              label={l}
              selected={settings.receiptLanguage === l}
              onPress={() => {
                setCustom("");
                updateSettings({ receiptLanguage: l });
              }}
            />
          ))}
        </View>
        <Field
          label="Or type any language"
          placeholder="e.g. Tagalog"
          value={custom}
          onChangeText={setCustom}
          onEndEditing={() => custom.trim() && updateSettings({ receiptLanguage: custom.trim() })}
        />
      </Card>
      <Card>
        <Text style={styles.h2}>Receipts snapped offline</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text style={{ flex: 1, color: colors.text }}>Read them over mobile data too</Text>
          <Switch
            value={settings.scanQueuedOnCellular}
            onValueChange={(on) => updateSettings({ scanQueuedOnCellular: on })}
          />
        </View>
        <Text style={[styles.muted, { marginTop: 6 }]}>
          {settings.scanQueuedOnCellular
            ? "Photos upload as soon as there's any connection."
            : "Photos wait for Wi-Fi so they don't use roaming data."}
          {receipts.length ? ` ${receipts.length} waiting now.` : ""}
        </Text>
      </Card>
      <Card>
        <Text style={styles.h2}>Sync server</Text>
        <Text style={styles.muted}>{API_URL}</Text>
        <Text style={[styles.muted, { marginTop: 4 }]}>{online ? "Connected" : "Not reachable right now"}</Text>
      </Card>
    </ScrollView>
  );
}
