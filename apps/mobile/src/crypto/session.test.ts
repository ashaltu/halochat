import base64 from "base64-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiRequest, native, stateStore } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  native: {
    verifyDeviceBinding: vi.fn(),
    createGroup: vi.fn(),
    addMember: vi.fn(),
    joinGroup: vi.fn(),
    deviceIdentity: vi.fn(),
    groupMembers: vi.fn(),
    encryptApplication: vi.fn(),
    generateDeviceKey: vi.fn(),
    createKeyPackage: vi.fn(),
    signDeviceBinding: vi.fn(),
  },
  stateStore: {
    hasPublishedChatKeyPackage: vi.fn(),
    loadPendingChatKeyPackage: vi.fn(),
    savePendingChatKeyPackage: vi.fn(),
    clearPendingChatKeyPackage: vi.fn(),
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

import { ensureChatE2ee, ensureWhisperGroup, forwardChatMessagesToAngel } from "./session.js";

describe("Whisper device credentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.clearAllMocks();
    stateStore.hasPublishedChatKeyPackage.mockResolvedValue(true);
    stateStore.loadPendingChatKeyPackage.mockResolvedValue(null);
    stateStore.initializeE2eeDevice.mockResolvedValue({ deviceId: "angel-device" });
    stateStore.loadE2eeState.mockResolvedValue(new Uint8Array([1]));
    stateStore.getE2eeContext.mockResolvedValue(new Uint8Array([5]));
    stateStore.loadE2eeStateRecord.mockResolvedValue(null);
    native.verifyDeviceBinding.mockResolvedValue(false);
  });

  it("coordinates browser MLS access with an origin-wide group lock", async () => {
    const request = vi.fn(async (_name: string, _options: unknown, operation: () => Promise<unknown>) => operation());
    vi.stubGlobal("indexedDB", {});
    vi.stubGlobal("navigator", { locks: { request } });
    stateStore.loadE2eeStateRecord.mockResolvedValue({
      state: { envelope: new Uint8Array([1]), deviceKey: new Uint8Array(32), context: new Uint8Array([2]) },
      localData: { lastSeq: 0, pendingMessages: [], plaintextByMessageId: {} },
    });

    await expect(ensureChatE2ee("user", "chat", "partner", "user")).resolves.toBe("ready");

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe("halochat.e2ee:user:chat");
  });

  it("retries an exact persisted KeyPackage after an ambiguous publication failure", async () => {
    let pending: any = null;
    stateStore.hasPublishedChatKeyPackage.mockResolvedValue(false);
    stateStore.loadPendingChatKeyPackage.mockImplementation(async () => pending);
    stateStore.savePendingChatKeyPackage.mockImplementation(async (_userId: string, _key: string, value: any) => {
      pending = value;
    });
    stateStore.clearPendingChatKeyPackage.mockImplementation(async () => { pending = null; });
    native.deviceIdentity.mockResolvedValue({ identity: new Uint8Array([1]), signatureKey: new Uint8Array([2]) });
    native.createKeyPackage.mockResolvedValue({ state: new Uint8Array([3]), keyPackage: new Uint8Array([4]) });
    native.signDeviceBinding.mockResolvedValue(new Uint8Array([5]));
    const publishedPayloads: unknown[] = [];
    let firstPublish = true;
    apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/crypto/key-packages")) {
        publishedPayloads.push(JSON.parse(String(options?.body)));
        if (firstPublish) {
          firstPublish = false;
          throw new Error("Network request failed after server accepted publication");
        }
        return {};
      }
      throw Object.assign(new Error("No peer KeyPackage"), { code: "KEY_PACKAGE_UNAVAILABLE" });
    });

    await expect(ensureChatE2ee("requester", "chat-id", "recipient", "requester"))
      .rejects.toThrow("Network request failed after server accepted publication");
    await expect(ensureChatE2ee("requester", "chat-id", "recipient", "requester"))
      .resolves.toBe("waiting");

    expect(native.createKeyPackage).toHaveBeenCalledOnce();
    expect(stateStore.savePendingChatKeyPackage).toHaveBeenCalledOnce();
    expect(stateStore.clearPendingChatKeyPackage).toHaveBeenCalledOnce();
    expect(publishedPayloads).toHaveLength(2);
    expect(publishedPayloads[1]).toEqual(publishedPayloads[0]);
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

  it("rejects a participant Welcome that contains an extra MLS member", async () => {
    const peerIdentity = "halochat:user:requester:device:requester-device";
    const localIdentity = "halochat:user:recipient:device:angel-device";
    const rogueIdentity = "halochat:user:attacker:device:attacker-device";
    const bytes = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));
    const peerIdentityBytes = bytes(peerIdentity);
    const localIdentityBytes = bytes(localIdentity);
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
      { identity: bytes(rogueIdentity), signatureKey: new Uint8Array([4]) },
    ]);

    await expect(ensureChatE2ee("recipient", "chat-id", "requester", "requester"))
      .rejects.toThrow("MLS Welcome has an unexpected device roster");

    expect(stateStore.saveE2eeState).not.toHaveBeenCalled();
  });

  it("queues encrypted Angel copies once per source message and retries them idempotently", async () => {
    let record: any = {
      state: { revision: 0 },
      localData: { lastSeq: 0, pendingMessages: [], plaintextByMessageId: {} },
    };
    stateStore.loadE2eeStateRecord.mockImplementation(async () => record);
    stateStore.saveE2eeState.mockImplementation(async (_userId: string, _key: string, state: any, localData: any) => {
      record = { state, localData };
    });
    native.encryptApplication.mockImplementation(async (state: any) => ({
      state: { revision: state.revision + 1 },
      message: new Uint8Array([state.revision + 10]),
    }));
    let keyId = 0;
    native.generateDeviceKey.mockImplementation(async () => new Uint8Array(32).fill(++keyId));
    apiRequest.mockResolvedValue({});

    const messages = [1, 2].map((seq) => ({
      id: `source-${seq}`,
      chatId: "chat-id",
      senderId: "peer-user",
      ciphertext: base64.fromByteArray(new Uint8Array([seq])),
      encryptionMetadata: { protocol: "MLS", version: 1, kind: "application" },
      seq,
      createdAt: `2026-01-01T00:00:0${seq}.000Z`,
      plaintext: `message ${seq}`,
    }));

    const waiting = await forwardChatMessagesToAngel("protected-user", "chat-id", "protected-user", "angel-user", "access-id", messages);
    const retry = await forwardChatMessagesToAngel("protected-user", "chat-id", "protected-user", "angel-user", "access-id", messages);

    expect(waiting).toBe(0);
    expect(retry).toBe(0);
    expect(native.encryptApplication).toHaveBeenCalledTimes(2);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(record.localData.forwardedMessageIds).toEqual({
      "access-id:source-1": expect.any(String),
      "access-id:source-2": expect.any(String),
    });
    expect(record.localData.pendingMessages).toEqual([]);
  });
});
