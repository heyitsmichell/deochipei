import type { Trip } from "./store.js";

/**
 * Web side of trip invites. The app's QR code can point at
 * `https://<this server>/join/<code>` (set EXPO_PUBLIC_INVITE_URL in the app).
 * With universal links / app links set up, the phone opens the app straight
 * away; otherwise the camera opens this page, which hands off to the app.
 */

const APP_SCHEME = process.env.APP_SCHEME ?? "deochipei";

export const INVITE_CODE_REGEX = /^[A-Za-z0-9_-]{6,36}$/;

export function isValidInviteCode(code: string): boolean {
  return INVITE_CODE_REGEX.test(code.trim());
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function invitePage(trip: Trip | undefined) {
  const code = trip?.code;
  const title = trip ? `Join “${escapeHtml(trip.name)}” on Deochipei` : "Invite not found";
  const body = trip
    ? `<h1>${title}</h1>
  <p>${trip.members.length} ${trip.members.length === 1 ? "person is" : "people are"} already in.</p>
  <a class="button" href="${APP_SCHEME}://join/${code}">Open in Deochipei</a>
  <p class="muted">Don't have the app yet? Install Deochipei, tap <b>Join with code</b> and enter</p>
  <p class="code">${code}</p>`
    : `<h1>${title}</h1>
  <p class="muted">This invite link isn't valid any more. Ask whoever sent it for the trip code.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #F6F7FB; color: #14161F;
           margin: 0; padding: 48px 16px; text-align: center; }
    main { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 14px; padding: 28px 20px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .muted { color: #6B7080; }
    .button { display: block; margin: 24px 0; padding: 14px; border-radius: 12px; background: #2F6BFF;
              color: #fff; font-weight: 600; text-decoration: none; }
    .code { font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 4px 0 0; }
  </style>
</head>
<body><main>
  ${body}
</main></body>
</html>`;
}

/** iOS universal links. Needs IOS_APP_ID, e.g. "ABCDE12345.com.deochipei". */
export function appleAppSiteAssociation() {
  const appId = process.env.IOS_APP_ID;
  if (!appId) return undefined;
  return {
    applinks: {
      details: [{ appIDs: [appId], components: [{ "/": "/join/*" }] }],
    },
  };
}

/** Android app links. Needs ANDROID_PACKAGE and ANDROID_CERT_SHA256 (comma separated). */
export function androidAssetLinks() {
  const pkg = process.env.ANDROID_PACKAGE;
  const fingerprints = process.env.ANDROID_CERT_SHA256?.split(",").map((f) => f.trim()).filter(Boolean);
  if (!pkg || !fingerprints?.length) return undefined;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fingerprints },
    },
  ];
}
