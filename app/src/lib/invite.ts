/** Trip invite links and QR codes. Pure, so the parsing is easy to test. */

const CODE = /^[A-Za-z0-9_-]{6,36}$/;

/**
 * What a trip's QR code encodes. With a web base (an https site serving
 * /join/<code>, see server/src/invite.ts) any phone camera can open it, and
 * universal links take it straight into the app. Without one, it's a deep
 * link into the app itself, such as deochipei://join/<code>.
 */
export function inviteUrl(code: string, webBase: string | null, appUrl: (path: string) => string) {
  const path = `join/${encodeURIComponent(code)}`;
  return webBase ? `${webBase.replace(/\/$/, "")}/${path}` : appUrl(path);
}

/**
 * Pulls the trip code out of whatever a scanned QR code or pasted link holds:
 * a bare code, https://…/join/CODE, deochipei://join/CODE,
 * exp://…/--/join/CODE (Expo Go), or a ?code=CODE query.
 * Valid codes are 6-36 alphanumeric, underscore, or hyphen characters.
 */
export function parseInviteCode(text: string): string | null {
  const t = text.trim();
  if (CODE.test(t)) return t.toUpperCase();
  const match =
    t.match(/\/join\/([A-Za-z0-9_-]{6,36})(?=[/?#]|$)/) ??
    t.match(/[?&]code=([A-Za-z0-9_-]{6,36})(?=[&#]|$)/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Checks whether an invite token has expired.
 * Supports Unix timestamps (seconds or milliseconds), ISO date strings, or null/undefined.
 */
export function isInviteExpired(expiresAt?: number | string | null): boolean {
  if (expiresAt == null) return false;
  const ms =
    typeof expiresAt === "number"
      ? expiresAt < 1e11
        ? expiresAt * 1000
        : expiresAt
      : new Date(expiresAt).getTime();
  if (Number.isNaN(ms)) return false;
  return Date.now() >= ms;
}

/**
 * Formats invite expiration as human-readable text.
 * e.g. "Expires in 7 days", "Expires in 2 hours", "Expired", or "Never expires".
 */
export function formatInviteExpiry(expiresAt?: number | string | null): string {
  if (expiresAt == null) return "Never expires";
  const ms =
    typeof expiresAt === "number"
      ? expiresAt < 1e11
        ? expiresAt * 1000
        : expiresAt
      : new Date(expiresAt).getTime();
  if (Number.isNaN(ms)) return "Invalid expiration";
  const diffMs = ms - Date.now();
  if (diffMs <= 0) return "Expired";

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays >= 2) {
    return `Expires in ${diffDays} days`;
  }
  if (diffDays === 1 || diffHours >= 24) {
    return "Expires in 1 day";
  }
  if (diffHours >= 1) {
    return `Expires in ${diffHours} hour${diffHours === 1 ? "" : "s"}`;
  }
  const diffMins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
  return `Expires in ${diffMins} minute${diffMins === 1 ? "" : "s"}`;
}

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Generates a fresh random invite code using unambiguous characters.
 */
export function generateRandomInviteCode(length = 6): string {
  let code = "";
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      code += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
    }
    return code;
  }
  for (let i = 0; i < length; i++) {
    code += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  }
  return code;
}
