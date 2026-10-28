import { DarkTheme, DefaultTheme } from "expo-router";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Appearance, Platform, StyleSheet, useColorScheme } from "react-native";
import type { ThemePreference } from "../lib/types";

export type ColorScheme = "light" | "dark";

const light = {
  bg: "#F6F7FB",
  card: "#FFFFFF",
  text: "#14161F",
  muted: "#6B7080",
  border: "#E3E5EE",
  /** Fills: primary buttons, selected chips. Text on it is `onPrimary`. */
  primary: "#2F6BFF",
  onPrimary: "#FFFFFF",
  /** Primary-coloured text and icons on `bg` or `card`: links, ghost buttons. */
  tint: "#2F6BFF",
  primarySoft: "#E8EFFF",
  positive: "#0E9F6E",
  negative: "#E0475B",
  warning: "#B7791F",
  warningSoft: "#FFF6E5",
};

export type Palette = Record<keyof typeof light, string>;

// Text colours keep at least 4.5:1 contrast against `card` and `bg`.
const dark: Palette = {
  bg: "#0E1015",
  card: "#191C24",
  text: "#ECEEF4",
  muted: "#9BA1B1",
  border: "#2B303C",
  primary: "#2F6BFF",
  onPrimary: "#FFFFFF",
  tint: "#7EA6FF",
  primarySoft: "#1C2846",
  positive: "#3DD39C",
  negative: "#FF7084",
  warning: "#F2B451",
  warningSoft: "#33280F",
};

function createStyles(colors: Palette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 16, paddingBottom: 48 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 16,
      marginBottom: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    h1: { fontSize: 26, fontWeight: "700", color: colors.text },
    h2: { fontSize: 18, fontWeight: "700", color: colors.text, marginBottom: 8 },
    text: { color: colors.text },
    muted: { color: colors.muted },
    label: { fontSize: 13, fontWeight: "600", color: colors.muted, marginBottom: 6 },
    link: { color: colors.tint, fontWeight: "600" },
    input: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 11,
      fontSize: 16,
      color: colors.text,
      justifyContent: "center",
    },
    compactPicker: { minWidth: 84, alignItems: "center" },
    button: {
      paddingVertical: 13,
      paddingHorizontal: 18,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
    },
    buttonText: { fontSize: 16, fontWeight: "600" },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      marginRight: 8,
      marginBottom: 8,
    },
    chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
    chips: { flexDirection: "row", flexWrap: "wrap" },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 14,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 8,
    },
    banner: { padding: 12, borderRadius: 10, marginBottom: 12 },
  });
}

function createTheme(scheme: ColorScheme, colors: Palette) {
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  return {
    scheme,
    colors,
    styles: createStyles(colors),
    buttons: {
      primary: { bg: colors.primary, fg: colors.onPrimary, border: colors.primary },
      secondary: { bg: colors.primarySoft, fg: colors.tint, border: colors.primarySoft },
      danger: { bg: colors.card, fg: colors.negative, border: colors.negative },
      ghost: { bg: "transparent", fg: colors.tint, border: "transparent" },
    },
    /** For the navigator: headers, and what shows behind screens as they move. */
    navigation: {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.tint,
        background: colors.bg,
        card: colors.card,
        text: colors.text,
        border: colors.border,
      },
    },
  };
}

// Each theme and its StyleSheet is built once, so switching is just picking one.
const themes = { light: createTheme("light", light), dark: createTheme("dark", dark) };

export type Theme = (typeof themes)[ColorScheme];

const ThemeContext = createContext<Theme>(themes.light);

/** Light or dark screens: the phone's setting, unless `preference` picks one. */
export function ThemeProvider({ preference, children }: { preference: ThemePreference; children: ReactNode }) {
  const system = useColorScheme();
  const scheme: ColorScheme = preference === "system" ? (system === "dark" ? "dark" : "light") : preference;

  useEffect(() => {
    // Native alerts, the keyboard and the camera/photo pickers follow the
    // choice too. There's no app-level override on web; it follows the browser.
    if (Platform.OS !== "web") Appearance.setColorScheme(preference === "system" ? "auto" : preference);
  }, [preference]);

  return <ThemeContext.Provider value={themes[scheme]}>{children}</ThemeContext.Provider>;
}

/** Colours, shared styles and button colours for the current light/dark scheme. */
export function useTheme() {
  return useContext(ThemeContext);
}
