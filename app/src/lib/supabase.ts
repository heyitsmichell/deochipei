import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const isReactNativeRuntime =
  typeof navigator !== "undefined" &&
  typeof navigator.product === "string" &&
  navigator.product === "ReactNative";

const inMemoryStorage = new Map<string, string>();
const safeStorage = {
  getItem: async (key: string) => inMemoryStorage.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    inMemoryStorage.set(key, value);
  },
  removeItem: async (key: string) => {
    inMemoryStorage.delete(key);
  },
};

const webStorage = typeof window !== "undefined" && window.localStorage
  ? {
      getItem: async (key: string) => window.localStorage.getItem(key),
      setItem: async (key: string, value: string) => window.localStorage.setItem(key, value),
      removeItem: async (key: string) => window.localStorage.removeItem(key),
    }
  : safeStorage;

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (process.env.NODE_ENV === "production" && (!supabaseUrl || !supabaseAnonKey)) {
  throw new Error("Missing Supabase environment variables: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY are required in production.");
}

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(supabaseUrl || "https://placeholder-project.supabase.co", supabaseAnonKey || "placeholder-anon-key", {
  auth: {
    storage: isReactNativeRuntime ? AsyncStorage : webStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: "pkce",
  },
});
