import { Redirect } from "expo-router";

/** AuthContext consumes the PKCE code; this route prevents an unmatched-route screen. */
export default function AuthCallback() {
  return <Redirect href="/" />;
}
