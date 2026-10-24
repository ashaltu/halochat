import base64 from "base64-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiRequest, native, stateStore } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  native: {
    verifyDeviceBinding: vi.fn(),
    createGroup: vi.fn(),
    addMember: vi.fn(),
    joinGroup: vi.fn(),
    deviceIdentity: vi.fn(),
    groupMembers: vi.fn(),
  },
  stateStore: {
    hasPublishedChatKeyPackage: vi.fn(),
    getE2eeContext: vi.fn(),
    initializeE2eeDevice: vi.fn(),
    loadE2eeState: vi.fn(),
    loadE2eeStateRecord: vi.fn(),
    saveE2eeState: vi.fn(),
    markChatKeyPackagePublished: vi.fn(),
  },
}));

vi.mock("@halochat/e2ee-native", () => ({ default: native }));
vi.mock("../api/client.js", () => ({ apiRequest }));
vi.mock("./state-store.js", () => stateStore);

import { ensureChatE2ee, ensureWhisperGroup } from "./session.js";

describe("Whisper device credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateStore.initializeE2eeDevice.mockResolvedValue({ deviceId: "angel-device" });
    stateStore.loadE2eeState.mockResolvedValue(new Uint8Array([1]));
    stateStore.hasPublishedChatKeyPackage.mockResolvedValue(true);
    stateStore.getE2eeContext.mockResolvedValue(new Uint8Array([5]));
    stateStore.loadE2eeStateRecord.mockResolvedValue(null);
    native.verifyDeviceBinding.mockResolvedValue(false);
  });

  it("rejects an unbound protected-user device before adding it to a Whisper group", async () => {
    const identity = "halochat:user:protected-user:device:protected-device";
    apiRequest.mockResolvedValue({
      keyPackage: {
        keyPackageId: "key-package",
        userId: "protected-user",
        deviceId: "protected-device",
        identity: base64.fromByteArray(Uint8Array.from(identity, (char) => char.charCodeAt(0))),
        signatureKey: base64.fromByteArray(new Uint8Array([2])),
        signatureProof: base64.fromByteArray(new Uint8Array([3])),
        keyPackage: base64.fromByteArray(new Uint8Array([4])),
      },
    });

    await expect(ensureWhisperGroup(
      "angel-user",
      "chat-id",
      "protected-user",
      "angel-user",
      "access-period",
    )).rejects.toThrow("The protected person's device signing key is not bound to this account");

    expect(native.verifyDeviceBinding).toHaveBeenCalledOnce();
    expect(native.createGroup).not.toHaveBeenCalled();
    expect(native.addMember).not.toHaveBeenCalled();
  });

  it("rejects a participant Welcome whose sender device is not account-bound", async () => {
    const peerIdentity = "halochat:user:requester:device:requester-device";
    const localIdentity = "halochat:user:recipient:device:recipient-device";
    apiRequest
      .mockResolvedValueOnce({
        messages: [{
          id: "welcome",
          chatId: "chat-id",
          senderId: "requester",
          ciphertext: base64.fromByteArray(new Uint8Array([6])),
          encryptionMetadata: { protocol: "MLS", version: 1, kind: "welcome" },
          seq: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        }],
      })
      .mockResolvedValueOnce({
        devices: [{
          deviceId: "requester-device",
          identity: base64.fromByteArray(Uint8Array.from(peerIdentity, (char) => char.charCodeAt(0))),
          signatureKey: base64.fromByteArray(new Uint8Array([2])),
          signatureProof: base64.fromByteArray(new Uint8Array([3])),
        }],
      });
    native.joinGroup.mockResolvedValue(new Uint8Array([7]));
    native.deviceIdentity.mockResolvedValue({
      identity: Uint8Array.from(localIdentity, (char) => char.charCodeAt(0)),
      signatureKey: new Uint8Array([1]),
    });

    await expect(ensureChatE2ee("recipient", "chat-id", "requester", "requester"))
      .rejects.toThrow("A device signing key is not bound to its account");

    expect(native.verifyDeviceBinding).toHaveBeenCalledOnce();
    expect(native.groupMembers).not.toHaveBeenCalled();
    expect(stateStore.saveE2eeState).not.toHaveBeenCalled();
  });

  it("accepts a participant Welcome only with the local device and a verified peer", async () => {
    const peerIdentity = "halochat:user:requester:device:requester-device";
    const localIdentity = "halochat:user:recipient:device:angel-device";
    const peerIdentityBytes = Uint8Array.from(peerIdentity, (char) => char.charCodeAt(0));
    const localIdentityBytes = Uint8Array.from(localIdentity, (char) => char.charCodeAt(0));
    const peerSignatureKey = new Uint8Array([2]);
    const localSignatureKey = new Uint8Array([1]);
    apiRequest
      .mockResolvedValueOnce({
        messages: [{
          id: "welcome",
          chatId: "chat-id",
          senderId: "requester",
          ciphertext: base64.fromByteArray(new Uint8Array([6])),
          encryptionMetadata: { protocol: "MLS", version: 1, kind: "welcome" },
          seq: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        }],
      })
      .mockResolvedValueOnce({
        devices: [{
          deviceId: "requester-device",
          identity: base64.fromByteArray(peerIdentityBytes),
          signatureKey: base64.fromByteArray(peerSignatureKey),
          signatureProof: base64.fromByteArray(new Uint8Array([3])),
        }],
      });
    native.verifyDeviceBinding.mockResolvedValue(true);
    native.joinGroup.mockResolvedValue(new Uint8Array([7]));
    native.deviceIdentity.mockResolvedValue({ identity: localIdentityBytes, signatureKey: localSignatureKey });
    native.groupMembers.mockResolvedValue([
      { identity: localIdentityBytes, signatureKey: localSignatureKey },
      { identity: peerIdentityBytes, signatureKey: peerSignatureKey },
    ]);

    await expect(ensureChatE2ee("recipient", "chat-id", "requester", "requester"))
      .resolves.toBe("ready");

    expect(native.verifyDeviceBinding).toHaveBeenCalledOnce();
    expect(stateStore.saveE2eeState).toHaveBeenCalledOnce();
  });
});
