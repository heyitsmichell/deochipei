import { useId, useSyncExternalStore } from "react";
import { Modal, ScrollView, Text, View } from "react-native";
import { alertStore } from "../lib/alert";
import { Button, Card, useTheme } from "./ui";

export function AlertHost() {
  const dialog = useSyncExternalStore(alertStore.subscribe, alertStore.current, () => null);
  const { styles } = useTheme();
  const titleId = useId();
  const messageId = useId();
  if (!dialog) return null;
  const accessibility = { "aria-labelledby": titleId, "aria-describedby": dialog.message ? messageId : undefined };
  return <Modal {...accessibility} transparent animationType="fade" onRequestClose={alertStore.dismiss}>
    <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.45)" }}>
      <Card style={{ width: "100%", maxWidth: 460, maxHeight: "100%", flexShrink: 1, alignSelf: "center" }}>
        <ScrollView style={{ flexShrink: 1 }}>
          <Text nativeID={titleId} accessibilityRole="header" style={styles.h2}>{dialog.title}</Text>
          {dialog.message && <Text nativeID={messageId} style={[styles.muted, { marginBottom: 16 }]}>{dialog.message}</Text>}
          <View style={{ gap: 8 }}>
            {dialog.buttons.map((button, index) => <Button key={index} title={button.text ?? "OK"}
              variant={button.style === "destructive" ? "danger" : button.style === "cancel" ? "secondary" : "primary"}
              onPress={() => alertStore.choose(button)} />)}
          </View>
        </ScrollView>
      </Card>
    </View>
  </Modal>;
}
