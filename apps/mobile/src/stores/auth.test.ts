import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiRequest, clearE2eeMemory, deleteItemAsync } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  clearE2eeMemory: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock("../api/client.js", () => ({ apiRequest, setAuthToken: vi.fn(), getAuthToken: vi.fn() }));
vi.mock("../crypto/state-store.js", () => ({ clearE2eeMemory }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync,
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { useAuthStore } from "./auth.js";

describe("logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiRequest.mockResolvedValue({});
    clearE2eeMemory.mockResolvedValue(undefined);
    deleteItemAsync.mockResolvedValue(undefined);
    useAuthStore.setState({
      user: { id: "user-id" } as any,
      session: { id: "session-id", token: "session-token", expiresAt: "2099-01-01" },
      isLoading: false,
    });
  });

  it("clears auth state and device key memory while server sign-out is still pending", async () => {
    let finishSignOut!: () => void;
    apiRequest.mockImplementation(() => new Promise<void>((resolve) => { finishSignOut = resolve; }));

    const logout = useAuthStore.getState().logout();

    expect(apiRequest).toHaveBeenCalledWith("/api/auth/sign-out", { method: "POST" });
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();
    expect(clearE2eeMemory).toHaveBeenCalledWith("user-id");
    await Promise.resolve();
    expect(deleteItemAsync).toHaveBeenCalledWith("halochat.session");

    finishSignOut();
    await logout;
  });
});
