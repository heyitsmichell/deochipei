import type { Session, User } from "@supabase/supabase-js";
import { makeRedirectUri } from "expo-auth-session";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { AppState } from "react-native";
import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { extractParamsFromUrl, handleAuthUrl, isAuthCallbackUrl } from "../lib/authUrl";
import { supabase } from "../lib/supabase";
import { resetLocalAccountState } from "../state/TripsContext";

export { extractParamsFromUrl, handleAuthUrl };

WebBrowser.maybeCompleteAuthSession();

export interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
  displayName: string;
  email: string | undefined;
  avatarUrl: string | undefined;
  providerLabel: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    supabase.auth.startAutoRefresh();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") supabase.auth.startAutoRefresh();
      else supabase.auth.stopAutoRefresh();
    });

    // Load initial session from storage
    supabase.auth
      .getSession()
      .then(({ data: { session: initialSession }, error }) => {
        if (error) {
          console.warn("Error getting initial Supabase session:", error.message);
        }
        if (isMounted) {
          setSession(initialSession);
          setUser(initialSession?.user ?? null);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.warn("Failed to get Supabase session:", err);
        if (isMounted) setLoading(false);
      });

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      if (isMounted) {
        setSession(currentSession);
        setUser(currentSession?.user ?? null);
        setLoading(false);
      }
      if (_event === "SIGNED_OUT") void resetLocalAccountState();
    });

    // Deep link listener for OAuth redirect callback
    const sub = Linking.addEventListener("url", async (event) => {
      if (event.url && isAuthCallbackUrl(event.url)) {
        try {
          await handleAuthUrl(event.url);
        } catch (err) {
          console.warn("Failed to handle auth callback URL:", err);
        }
      }
    });

    // Handle cold-start deep link where app opened directly to callback URL
    Linking.getInitialURL().then((initialUrl) => {
      if (initialUrl && isAuthCallbackUrl(initialUrl) && isMounted) {
        handleAuthUrl(initialUrl).catch((err) => {
          console.warn("Failed to handle initial auth callback URL:", err);
        });
      }
    });

    return () => {
      isMounted = false;
      appState.remove();
      supabase.auth.stopAutoRefresh();
      subscription.unsubscribe();
      sub.remove();
    };
  }, []);

  const signInWithGoogle = async () => {
    try {
      const redirectTo = makeRedirectUri({
        scheme: "deochipei",
        path: "auth/callback",
      });

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;

      if (data?.url) {
        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
        if (result.type === "success" && result.url) {
          await handleAuthUrl(result.url);
        }
      }
    } catch (err) {
      console.error("Sign in with Google error:", err);
      throw err;
    }
  };

  const signInWithApple = async () => {
    try {
      const redirectTo = makeRedirectUri({
        scheme: "deochipei",
        path: "auth/callback",
      });

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "apple",
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;

      if (data?.url) {
        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
        if (result.type === "success" && result.url) {
          await handleAuthUrl(result.url);
        }
      }
    } catch (err) {
      console.error("Sign in with Apple error:", err);
      throw err;
    }
  };

  const signOut = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setSession(null);
      setUser(null);
      await resetLocalAccountState();
    } finally {
      setLoading(false);
    }
  };

  const displayName = useMemo(() => {
    if (!user) return "";
    return (
      (user.user_metadata?.full_name as string | undefined) ||
      (user.user_metadata?.name as string | undefined) ||
      user.email?.split("@")[0] ||
      getProviderLabel(user.app_metadata?.provider)
    );
  }, [user]);

  const providerLabel = useMemo(
    () => getProviderLabel(user?.app_metadata?.provider as string | undefined),
    [user],
  );

  const email = user?.email;
  const avatarUrl =
    (user?.user_metadata?.avatar_url as string | undefined) ||
    (user?.user_metadata?.picture as string | undefined);

  const value = useMemo(
    () => ({
      user,
      session,
      loading,
      signInWithGoogle,
      signInWithApple,
      signOut,
      displayName,
      email,
      avatarUrl,
      providerLabel,
    }),
    [user, session, loading, displayName, email, avatarUrl, providerLabel],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

function getProviderLabel(provider?: string | null): string {
  if (!provider) return "Account";
  if (provider === "google") return "Google";
  if (provider === "apple") return "Apple";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
