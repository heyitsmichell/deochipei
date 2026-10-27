import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

// Big enough to keep small print on long receipts legible, small enough to
// upload quickly over roaming data.
const MAX_EDGE = 2000;

export type ImageSource = "camera" | "library";

/** Returns a base64 JPEG ready to send, or null if the user cancelled. */
export async function pickReceiptImage(source: ImageSource): Promise<{ uri: string; base64: string } | null> {
  const permission =
    source === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      source === "camera"
        ? "Camera access is needed to scan receipts. You can enable it in Settings."
        : "Photo access is needed to pick a receipt. You can enable it in Settings.",
    );
  }

  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1 };
  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets[0]) return null;

  const asset = result.assets[0];
  const context = ImageManipulator.manipulate(asset.uri);
  if (asset.width > MAX_EDGE || asset.height > MAX_EDGE) {
    context.resize(asset.width >= asset.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ base64: true, compress: 0.8, format: SaveFormat.JPEG });
  if (!saved.base64) throw new Error("Couldn't read the photo.");
  return { uri: saved.uri, base64: saved.base64 };
}
