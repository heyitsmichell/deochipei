import { Alert as NativeAlert, Platform, type AlertButton, type AlertOptions } from "react-native";

type Dialog = { title: string; message?: string; buttons: AlertButton[]; options?: AlertOptions };
let dialogs: Dialog[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** React Native Web's Alert is a no-op; retain the same API with a visible host. */
export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) {
    if (Platform.OS !== "web") return NativeAlert.alert(title, message, buttons, options);
    dialogs = [...dialogs, { title, message, buttons: buttons?.length ? buttons : [{ text: "OK" }], options }];
    emit();
  },
};
export const alertStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  current: () => dialogs[0] ?? null,
  choose(button: AlertButton) {
    dialogs = dialogs.slice(1);
    emit();
    button.onPress?.();
  },
  dismiss() {
    const dialog = dialogs[0];
    if (!dialog || dialog.options?.cancelable === false) return;
    const cancel = dialog.buttons.find((button) => button.style === "cancel");
    dialogs = dialogs.slice(1);
    emit();
    cancel?.onPress?.();
    dialog.options?.onDismiss?.();
  },
};
