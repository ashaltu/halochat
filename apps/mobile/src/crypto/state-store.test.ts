import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  secureValues: new Map<string, string>(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  generateDeviceKey: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  documentDirectory: "file:///documents/",
  EncodingType: { UTF8: "utf8" },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "when-unlocked-this-device-only",
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));
vi.mock("@halochat/e2ee-native", () => ({
  default: { generateDeviceKey: mocks.generateDeviceKey },
}));

import { clearE2eeMemory, getE2eeContext } from "./state-store.js";

describe("E2EE memory lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.secureValues.clear();
    mocks.getItemAsync.mockImplementation(async (key: string) => mocks.secureValues.get(key) ?? null);
    mocks.setItemAsync.mockImplementation(async (key: string, value: string) => {
      mocks.secureValues.set(key, value);
    });
  });

  it("zeroes the cached device key and reloads it from protected storage", async () => {
    let generation = 0;
    mocks.generateDeviceKey.mockImplementation(async () => {
      return new Uint8Array(32).fill(++generation);
    });
    const fill = vi.spyOn(Uint8Array.prototype, "fill");

    await getE2eeContext("user-id", "chat-id");

    await clearE2eeMemory("user-id");

    expect(fill).toHaveBeenLastCalledWith(0);
    const zeroizedKey = fill.mock.contexts.at(-1) as Uint8Array;
    expect(zeroizedKey).toBeInstanceOf(Uint8Array);
    expect(zeroizedKey).toEqual(new Uint8Array(32));
    await getE2eeContext("user-id", "chat-id");
    expect(mocks.getItemAsync).toHaveBeenCalledTimes(4);
    expect(mocks.generateDeviceKey).toHaveBeenCalledTimes(2);
    fill.mockRestore();
  });
});
