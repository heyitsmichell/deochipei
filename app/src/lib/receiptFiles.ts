import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

/** Where queued receipt photos wait. Lets tests swap the file system for a map. */
export interface ReceiptFileStore {
  /** Moves a fresh photo out of the cache (which the OS may clear) and returns its new URI. */
  keep(uri: string, id: string): Promise<string>;
  readBase64(uri: string): Promise<string>;
  remove(uri: string): void;
}

export const receiptFiles: ReceiptFileStore = {
  async keep(uri, id) {
    if (Platform.OS === "web") throw new Error("Saving receipts to read later needs the iOS or Android app.");
    const dir = new Directory(Paths.document, "queued-receipts");
    dir.create({ idempotent: true, intermediates: true });
    const file = new File(uri);
    await file.move(new File(dir, `${id}.jpg`));
    return file.uri;
  },

  readBase64: (uri) => new File(uri).base64(),

  remove(uri) {
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // Already gone; nothing to clean up.
    }
  },
};
