import { create } from "zustand";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { apiRequest, setAuthToken } from "../api/client.js";
import { clearE2eeMemory } from "../crypto/state-store.js";

const SESSION_KEY = "halochat.session";

async function saveSession(session: Session | null) {
  const value = session ? JSON.stringify(session) : null;
  if (Platform.OS === "web") {
    if (value) localStorage.setItem(SESSION_KEY, value);
    else localStorage.removeItem(SESSION_KEY);
  } else if (value) {
    await SecureStore.setItemAsync(SESSION_KEY, value);
  } else {
    await SecureStore.deleteItemAsync(SESSION_KEY);
  }
}

async function loadSession() {
  const value =
    Platform.OS === "web"
      ? localStorage.getItem(SESSION_KEY)
      : await SecureStore.getItemAsync(SESSION_KEY);
  return value ? (JSON.parse(value) as Session) : null;
}

export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  dateOfBirth: string;
  sex: "MALE" | "FEMALE";
  role: string;
  onboardingCompletedAt?: string | null;
}

export interface Session {
  id: string;
  token: string;
  expiresAt: string;
}

interface AuthState {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  setUser: (user: User | null) => void;
  setSession: (session: Session | null) => void;
  checkSession: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  session: null,
  isLoading: true,
  setUser: (user) => set({ user }),
  setSession: (session) => {
    setAuthToken(session ? session.token : null);
    void saveSession(session);
    set({ session });
  },
  checkSession: async () => {
    set({ isLoading: true });
    try {
      const savedSession = await loadSession();
      setAuthToken(savedSession?.token || null);
      const res = await apiRequest<{ session: Session | null; user: User | null }>(
        "/api/auth/get-session"
      );
      if (res.session && res.user) {
        setAuthToken(res.session.token);
        set({ session: res.session, user: res.user, isLoading: false });
      } else {
        setAuthToken(null);
        set({ session: null, user: null, isLoading: false });
      }
    } catch (err) {
      setAuthToken(null);
      set({ session: null, user: null, isLoading: false });
    }
  },
  logout: async () => {
    const userId = get().user?.id;
    try {
      await apiRequest("/api/auth/sign-out", { method: "POST" });
    } catch (err) {
      // Ignore network errors on logout
    }
    setAuthToken(null);
    await saveSession(null);
    set({ user: null, session: null });
    if (userId) await clearE2eeMemory(userId);
  },
}));
