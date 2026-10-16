import { Platform } from "react-native";

export const API_BASE_URL =
  Platform.OS === "web" && typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3000`
    : "http://localhost:3000";

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

export async function apiRequest<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");

  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error: any = new Error(data.message || `Request failed with status ${res.status}`);
    error.code = data.code;
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}
