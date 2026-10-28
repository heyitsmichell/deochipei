import { Stack, ThemeProvider as NavigationThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ReactNode } from "react";
import { ThemeProvider, useTheme } from "../components/theme";
import { AlertHost } from "../components/AlertHost";
import { AuthProvider } from "../context/AuthContext";
import { TripsProvider, useSettings } from "../state/TripsContext";

// Opening an invite link from outside the app still leaves the trips list
// underneath, so Back works after joining.
export const unstable_settings = { anchor: "index" };

export default function RootLayout() {
  return (
    <AuthProvider>
      <TripsProvider>
        <AppThemeProvider>
          <RootStack />
          <AlertHost />
        </AppThemeProvider>
      </TripsProvider>
    </AuthProvider>
  );
}

/** Light or dark as picked in Settings; other settings changing doesn't re-render the app. */
function AppThemeProvider({ children }: { children: ReactNode }) {
  const { appearance } = useSettings();
  return <ThemeProvider preference={appearance}>{children}</ThemeProvider>;
}

function RootStack() {
  const { colors, scheme, navigation } = useTheme();
  return (
    <NavigationThemeProvider value={navigation}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.tint,
          headerTitleStyle: { color: colors.text },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Deochipei" }} />
        <Stack.Screen name="new-trip" options={{ title: "New trip", presentation: "modal" }} />
        <Stack.Screen name="join/index" options={{ title: "Join a trip", presentation: "modal" }} />
        <Stack.Screen name="join/[code]" options={{ title: "Join a trip", presentation: "modal" }} />
        <Stack.Screen name="converter" options={{ title: "Currency converter" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
        <Stack.Screen name="trip/[id]/index" options={{ title: "" }} />
        <Stack.Screen name="trip/[id]/expense" options={{ title: "Expense", presentation: "modal" }} />
      </Stack>
    </NavigationThemeProvider>
  );
}
