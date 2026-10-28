import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * app.json plus universal links / app links for invites. With
 * EXPO_PUBLIC_INVITE_URL set at build time (e.g. https://trips.example.com),
 * a scanned invite QR code opens the app directly instead of the web page.
 * The server must serve the matching association files; see README "Invites".
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const inviteUrl = process.env.EXPO_PUBLIC_INVITE_URL;
  const host = inviteUrl?.startsWith("https://") ? new URL(inviteUrl).host : undefined;
  if (!host) return config as ExpoConfig;

  return {
    ...(config as ExpoConfig),
    ios: { ...config.ios, associatedDomains: [`applinks:${host}`] },
    android: {
      ...config.android,
      intentFilters: [
        {
          action: "VIEW",
          autoVerify: true,
          data: [{ scheme: "https", host, pathPrefix: "/join" }],
          category: ["BROWSABLE", "DEFAULT"],
        },
      ],
    },
  };
};
