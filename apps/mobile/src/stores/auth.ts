import { create } from "zustand";
import { apiRequest, setAuthToken } from "../api/client.js";

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

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  session: null,
  isLoading: true,
  setUser: (user) => set({ user }),
  setSession: (session) => {
    setAuthToken(session ? session.token : null);
    set({ session });
  },
  checkSession: async () => {
    set({ isLoading: true });
    try {
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
    try {
      await apiRequest("/api/auth/sign-out", { method: "POST" });
    } catch (err) {
      // Ignore network errors on logout
    }
    setAuthToken(null);
    set({ user: null, session: null });
  },
}));
