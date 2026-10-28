import { useSyncExternalStore } from "react";
import { Modal, Text, View } from "react-native";
import { alertStore } from "../lib/alert";
import { Button, Card, useTheme } from "./ui";

export function AlertHost() {
  const dialog = useSyncExternalStore(alertStore.subscribe, alertStore.current, () => null);
  const { styles } = useTheme();
  if (!dialog) return null;
  return <Modal transparent animationType="fade" onRequestClose={alertStore.dismiss}>
    <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.45)" }}>
      <Card style={{ width: "100%", maxWidth: 460, alignSelf: "center" }}>
        <Text accessibilityRole="header" style={styles.h2}>{dialog.title}</Text>
        {dialog.message && <Text style={[styles.muted, { marginBottom: 16 }]}>{dialog.message}</Text>}
        <View style={{ gap: 8 }}>
          {dialog.buttons.map((button, index) => <Button key={index} title={button.text ?? "OK"}
            variant={button.style === "destructive" ? "danger" : button.style === "cancel" ? "secondary" : "primary"}
            onPress={() => alertStore.choose(button)} />)}
        </View>
      </Card>
    </View>
  </Modal>;
}
