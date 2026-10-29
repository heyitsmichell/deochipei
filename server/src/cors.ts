/**
 * Which Access-Control-Allow-Origin value, if any, to send for a request.
 *
 * The native app doesn't use CORS, so browsers are the only concern:
 * - CORS_ORIGINS="https://a.example,https://b.example" allows exactly those origins.
 * - CORS_ORIGINS="*" allows any origin (explicit opt-in).
 * - Unset: any origin outside production (Expo web / local dev), none in production.
 */
export function allowedOrigin(
  requestOrigin: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const configured = env.CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
  if (!configured.length) return env.NODE_ENV === "production" ? undefined : "*";
  if (configured.includes("*")) return "*";
  return requestOrigin && configured.includes(requestOrigin) ? requestOrigin : undefined;
}
