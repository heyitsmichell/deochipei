import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CURRENCIES } from "../lib/money";
import { useTheme } from "./theme";

export { useTheme } from "./theme";

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { styles } = useTheme();
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  loading,
  disabled,
  style,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const { styles, buttons } = useTheme();
  const v = buttons[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: v.bg, borderColor: v.border },
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={v.fg} /> : <Text style={[styles.buttonText, { color: v.fg }]}>{title}</Text>}
    </Pressable>
  );
}

/** A TextInput styled for the current theme, keyboard included. */
export function Input(props: TextInputProps) {
  const { colors, styles, scheme } = useTheme();
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      keyboardAppearance={scheme}
      {...props}
      style={[styles.input, props.style]}
    />
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Label>{label}</Label>
      <Input accessibilityLabel={props.accessibilityLabel ?? label} {...props} />
    </View>
  );
}

export function Label({ children }: { children: ReactNode }) {
  const { styles } = useTheme();
  return <Text style={styles.label}>{children}</Text>;
}

export function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const { colors, styles } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={{ color: selected ? colors.onPrimary : colors.text, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export function CurrencyPicker({
  value,
  onChange,
  compact,
  placeholder = "Choose",
}: {
  value: string | undefined;
  onChange: (code: string) => void;
  compact?: boolean;
  placeholder?: string;
}) {
  const { colors, styles } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={[styles.input, compact && styles.compactPicker]}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: value ? colors.text : colors.muted }}>
          {value ?? placeholder} ▾
        </Text>
      </Pressable>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <CurrencyList
          value={value}
          onPick={(code) => {
            onChange(code);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      </Modal>
    </>
  );
}

/** The picker's search and list. Only rendered while the modal is open, so the search starts empty each time. */
function CurrencyList({
  value,
  onPick,
  onClose,
}: {
  value: string | undefined;
  onPick: (code: string) => void;
  onClose: () => void;
}) {
  const { colors, styles } = useTheme();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = useMemo(() => {
    const matches = CURRENCIES.filter(
      (c) => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    );
    // Allow any ISO code, not just the common ones listed.
    const custom = /^[a-z]{3}$/.test(q) && !CURRENCIES.some((c) => c.code.toLowerCase() === q);
    return custom ? [{ code: q.toUpperCase(), name: "Use this code" }, ...matches] : matches;
  }, [q]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 16, flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Input
          autoFocus
          placeholder="Search currency or type a code"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="characters"
          style={{ flex: 1 }}
        />
        <Button title="Close" variant="ghost" onPress={onClose} />
      </View>
      <FlatList
        keyboardShouldPersistTaps="handled"
        data={list}
        keyExtractor={(c) => c.code}
        renderItem={({ item }) => (
          <Pressable onPress={() => onPick(item.code)} style={styles.row}>
            <Text style={{ fontWeight: "700", width: 56, color: colors.text }}>{item.code}</Text>
            <Text style={{ color: colors.muted, flex: 1 }}>{item.name}</Text>
            {item.code === value && <Text style={{ color: colors.tint }}>✓</Text>}
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

export function Banner({ children, tone = "warning" }: { children: ReactNode; tone?: "warning" | "info" }) {
  const { colors, styles } = useTheme();
  return (
    <View style={[styles.banner, { backgroundColor: tone === "warning" ? colors.warningSoft : colors.primarySoft }]}>
      <Text style={{ color: tone === "warning" ? colors.warning : colors.tint }}>{children}</Text>
    </View>
  );
}
