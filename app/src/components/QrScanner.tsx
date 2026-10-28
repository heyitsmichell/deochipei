import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { parseInviteCode } from "../lib/invite";
import { Button, useTheme } from "./ui";

/**
 * Full-screen scanner for trip invite QR codes. Phone cameras usually open
 * invite links by themselves; this covers camera apps that don't (and Expo
 * Go on Android, where exp:// links aren't recognised).
 */
export function QrScanner({
  visible,
  onClose,
  onCode,
}: {
  visible: boolean;
  onClose: () => void;
  onCode: (code: string) => void;
}) {
  const { styles } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState<string | null>(null);
  // The camera reports the same code many times a second; act on it once.
  const handled = useRef(false);

  useEffect(() => {
    if (!visible) return;
    handled.current = false;
    if (permission && !permission.granted && permission.canAskAgain) requestPermission();
  }, [visible, permission, requestPermission]);

  const handleClose = () => {
    setMessage(null);
    onClose();
  };

  const onScanned = ({ data }: BarcodeScanningResult) => {
    if (handled.current) return;
    const code = parseInviteCode(data);
    if (!code) {
      setMessage("That QR code isn't a Deochipei invite.");
      return;
    }
    handled.current = true;
    setMessage(null);
    onCode(code);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }}>
        {permission?.granted ? (
          <View style={{ flex: 1 }}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={onScanned}
            />
            <View pointerEvents="none" style={scanner.frameWrap}>
              <View style={scanner.frame} />
              <Text style={scanner.hint}>{message ?? "Point at the trip's QR code"}</Text>
            </View>
          </View>
        ) : (
          <View style={[styles.content, { flex: 1, justifyContent: "center", gap: 12 }]}>
            <Text style={{ color: "#fff", fontSize: 16, textAlign: "center" }}>
              {permission && !permission.canAskAgain
                ? "Camera access is off for Deochipei. Turn it on in Settings, or type the code instead."
                : "Deochipei needs the camera to scan the invite."}
            </Text>
            {permission?.canAskAgain !== false && <Button title="Allow camera" onPress={requestPermission} />}
          </View>
        )}
        <View style={{ padding: 16 }}>
          <Button title="Cancel" variant="secondary" onPress={handleClose} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const scanner = StyleSheet.create({
  frameWrap: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", gap: 16 },
  frame: { width: 240, height: 240, borderRadius: 20, borderWidth: 3, borderColor: "#fff" },
  hint: {
    color: "#fff",
    fontWeight: "600",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: "hidden",
  },
});
