import base64 from "base64-js";
import E2eeNative, { type E2eeMember } from "@halochat/e2ee-native";
import { apiRequest } from "../api/client.js";
import { encodeSafetyCode, getSafetyCodeStatus } from "./safety-code.js";
import {
  hasPublishedChatKeyPackage,
  getE2eeContext,
  getTrustedChatSafetyCode,
  initializeE2eeDevice,
  loadE2eeState,
  loadE2eeStateRecord,
  markChatKeyPackagePublished,
  saveE2eeState,
  trustChatSafetyCode,
  type E2eeLocalData,
  type E2eePendingMessage,
} from "./state-store.js";

type ServerMessage = {
  id: string;
  chatId: string;
  senderId: string;
  ciphertext: string;
  encryptionMetadata: Record<string, unknown> | null;
  seq: number;
  createdAt: string;
};

type PublishedKeyPackage = {
  keyPackageId: string;
  userId: string;
  deviceId: string;
  identity: string;
  signatureKey: string;
  keyPackage: string;
};

type ChatMessageResponse = { message: ServerMessage };

const locks = new Map<string, Promise<void>>();

function asciiBytes(value: string) {
  if (!/^[\x20-\x7e]+$/.test(value)) throw new Error("Invalid E2EE identity");
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function utf8Bytes(value: string) {
  const encoded = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return Uint8Array.from(encoded, (character) => character.charCodeAt(0));
}

function utf8String(value: Uint8Array) {
  return decodeURIComponent(Array.from(value, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""));
}

async function withChatLock<T>(userId: string, chatId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${userId}:${chatId}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

function isMlsMetadata(value: unknown): value is { protocol: "MLS"; version: 1; kind: string; [key: string]: unknown } {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return metadata.protocol === "MLS" && metadata.version === 1 && typeof metadata.kind === "string";
}

async function postPendingMessage(chatId: string, pending: E2eePendingMessage) {
  return apiRequest<ChatMessageResponse>(`/api/v1/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      clientMsgId: pending.clientMsgId,
      ciphertext: pending.ciphertext,
      encryptionMetadata: pending.encryptionMetadata,
    }),
  });
}

async function flushOutbox(userId: string, chatId: string) {
  let record = await loadE2eeStateRecord(userId, chatId);
  if (!record) return 0;

  while (record.localData.pendingMessages.length > 0) {
    const pending = record.localData.pendingMessages[0];
    const response = await postPendingMessage(chatId, pending);
    const plaintextByMessageId = { ...record.localData.plaintextByMessageId };
    if (pending.plaintext !== undefined) {
      plaintextByMessageId[response.message.id] = pending.plaintext;
    }
    const localData: E2eeLocalData = {
      ...record.localData,
      pendingMessages: record.localData.pendingMessages.slice(1),
      plaintextByMessageId,
    };
    await saveE2eeState(userId, chatId, record.state, localData);
    record = { ...record, localData };
  }

  return record.localData.pendingMessages.length;
}

async function publishChatKeyPackage(userId: string, chatId: string) {
  const device = await initializeE2eeDevice(userId);
  const deviceState = await loadE2eeState(userId, "device");
  if (!deviceState) throw new Error("E2EE device state is unavailable");

  if (!(await hasPublishedChatKeyPackage(userId, chatId))) {
    const member = await E2eeNative.deviceIdentity(deviceState);
    const created = await E2eeNative.createKeyPackage(deviceState);
    const signatureProof = await E2eeNative.signDeviceBinding(created.state, asciiBytes(userId), asciiBytes(device.deviceId));
    await saveE2eeState(userId, "device", created.state);
    await apiRequest(`/api/v1/chats/${chatId}/crypto/key-packages`, {
      method: "POST",
      body: JSON.stringify({
        deviceId: device.deviceId,
        identity: base64.fromByteArray(member.identity),
        signatureKey: base64.fromByteArray(member.signatureKey),
        signatureProof: base64.fromByteArray(signatureProof),
        keyPackage: base64.fromByteArray(created.keyPackage),
      }),
    });
    await markChatKeyPackagePublished(userId, chatId);
  }

  return loadE2eeState(userId, "device");
}

export async function ensureChatE2ee(
  userId: string,
  chatId: string,
  partnerUserId: string,
  requesterUserId: string,
): Promise<"ready" | "waiting"> {
  return withChatLock(userId, chatId, async () => {
    const existing = await loadE2eeStateRecord(userId, chatId);
    if (existing) {
      await flushOutbox(userId, chatId);
      const latest = await loadE2eeStateRecord(userId, chatId);
      return latest?.localData.pendingMessages.length ? "waiting" : "ready";
    }

    const deviceState = await publishChatKeyPackage(userId, chatId);
    if (!deviceState) throw new Error("E2EE device state is unavailable");
    const context = await getE2eeContext(userId, chatId);

    if (userId !== requesterUserId) {
      const { messages } = await apiRequest<{ messages: ServerMessage[] }>(
        `/api/v1/chats/${chatId}/messages?limit=100`
      );
      const invitation = messages.find((message) =>
        message.senderId === requesterUserId && isMlsMetadata(message.encryptionMetadata) &&
        message.encryptionMetadata.kind === "welcome"
      );
      if (!invitation) return "waiting";
      const joined = await E2eeNative.joinGroup(deviceState, base64.toByteArray(invitation.ciphertext), context);
      await saveE2eeState(userId, chatId, joined, { ...EMPTY_DATA, lastSeq: invitation.seq });
      return "ready";
    }

    let keyPackageResponse: { keyPackage: PublishedKeyPackage };
    const device = await initializeE2eeDevice(userId);
    try {
      keyPackageResponse = await apiRequest(
        `/api/v1/chats/${chatId}/crypto/key-packages/${partnerUserId}?deviceId=${encodeURIComponent(device.deviceId)}`
      );
    } catch (error) {
      if ((error as { code?: string }).code === "KEY_PACKAGE_UNAVAILABLE") return "waiting";
      throw error;
    }

    const peer = keyPackageResponse.keyPackage;
    const expectedIdentity = `halochat:user:${partnerUserId}:device:${peer.deviceId}`;
    const identity = asciiBytes(expectedIdentity);
    if (base64.fromByteArray(identity) !== peer.identity || peer.userId !== partnerUserId) {
      throw new Error("The peer device identity does not match this chat participant");
    }
    const expectedMember: E2eeMember = {
      identity,
      signatureKey: base64.toByteArray(peer.signatureKey),
    };
    const group = await E2eeNative.createGroup(deviceState, asciiBytes(`halochat:chat:${chatId}`), context);
    const added = await E2eeNative.addMember(group, base64.toByteArray(peer.keyPackage), expectedMember);
    const welcome: E2eePendingMessage = {
      clientMsgId: base64.fromByteArray((await E2eeNative.generateDeviceKey()).subarray(0, 16)),
      ciphertext: base64.fromByteArray(added.welcome),
      encryptionMetadata: {
        protocol: "MLS",
        version: 1,
        kind: "welcome",
        keyPackageId: peer.keyPackageId,
        claimantDeviceId: device.deviceId,
        commit: base64.fromByteArray(added.commit),
      },
    };
    await saveE2eeState(userId, chatId, added.state, {
      ...EMPTY_DATA,
      pendingMessages: [welcome],
    });
    await flushOutbox(userId, chatId);
    const latest = await loadE2eeStateRecord(userId, chatId);
    return latest?.localData.pendingMessages.length ? "waiting" : "ready";
  });
}

const EMPTY_DATA: E2eeLocalData = {
  lastSeq: 0,
  pendingMessages: [],
  plaintextByMessageId: {},
};

export async function encryptAndSendChatMessage(userId: string, chatId: string, plaintext: string) {
  return withChatLock(userId, chatId, async () => {
    if (!plaintext.trim() || plaintext.length > 2000) throw new Error("Message length is invalid");
    await flushOutbox(userId, chatId);
    const record = await loadE2eeStateRecord(userId, chatId);
    if (!record) throw new Error("Chat encryption has not been established yet");
    const encrypted = await E2eeNative.encryptApplication(record.state, utf8Bytes(plaintext));
    const pending: E2eePendingMessage = {
      clientMsgId: base64.fromByteArray((await E2eeNative.generateDeviceKey()).subarray(0, 16)),
      ciphertext: base64.fromByteArray(encrypted.message),
      encryptionMetadata: { protocol: "MLS", version: 1, kind: "application" },
      plaintext,
    };
    await saveE2eeState(userId, chatId, encrypted.state, {
      ...record.localData,
      pendingMessages: [...record.localData.pendingMessages, pending],
    });
    await flushOutbox(userId, chatId);
    return { clientMsgId: pending.clientMsgId };
  });
}

export async function decryptChatMessages(
  userId: string,
  chatId: string,
  messages: ServerMessage[],
): Promise<Array<ServerMessage & { plaintext: string }>> {
  return withChatLock(userId, chatId, async () => {
    let record = await loadE2eeStateRecord(userId, chatId);
    if (!record) return [];
    let localData = record.localData;
    const decrypted: Array<ServerMessage & { plaintext: string }> = [];

    for (const message of [...messages].sort((left, right) => left.seq - right.seq)) {
      if (message.seq <= localData.lastSeq) {
        const cached = localData.plaintextByMessageId[message.id];
        if (cached !== undefined) decrypted.push({ ...message, plaintext: cached });
        continue;
      }
      if (!isMlsMetadata(message.encryptionMetadata)) {
        localData = { ...localData, lastSeq: message.seq };
        await saveE2eeState(userId, chatId, record.state, localData);
        record = { ...record, localData };
        decrypted.push({ ...message, plaintext: "This older message cannot be decrypted on this device." });
        continue;
      }

      if (message.encryptionMetadata.kind === "welcome") {
        localData = { ...localData, lastSeq: message.seq };
        await saveE2eeState(userId, chatId, record.state, localData);
        record = { ...record, localData };
        continue;
      }
      if (message.encryptionMetadata.kind !== "application") {
        throw new Error("This message uses an unsupported MLS content type");
      }

      if (message.senderId === userId) {
        const cached = localData.plaintextByMessageId[message.id];
        if (cached === undefined) throw new Error("A sent message is missing from encrypted local history");
        decrypted.push({ ...message, plaintext: cached });
        localData = { ...localData, lastSeq: message.seq };
      } else {
        const result = await E2eeNative.decryptApplication(record.state, base64.toByteArray(message.ciphertext));
        const plaintext = utf8String(result.message);
        localData = {
          ...localData,
          lastSeq: message.seq,
          plaintextByMessageId: { ...localData.plaintextByMessageId, [message.id]: plaintext },
        };
        record = { ...record, state: result.state };
        decrypted.push({ ...message, plaintext });
      }
      await saveE2eeState(userId, chatId, record.state, localData);
      record = { ...record, localData };
    }

    return decrypted;
  });
}

export async function fetchAndDecryptChatMessages(userId: string, chatId: string, loadHistory = false) {
  const record = await loadE2eeStateRecord(userId, chatId);
  if (!record) return [];
  if (!loadHistory) {
    const { messages } = await apiRequest<{ messages: ServerMessage[] }>(
      `/api/v1/chats/${chatId}/messages?after=${record.localData.lastSeq}&limit=100`
    );
    return decryptChatMessages(userId, chatId, messages);
  }

  const messages: ServerMessage[] = [];
  let after = 0;
  let page: ServerMessage[];
  do {
    const response = await apiRequest<{ messages: ServerMessage[] }>(
      `/api/v1/chats/${chatId}/messages?after=${after}&limit=100`
    );
    page = response.messages;
    messages.push(...page);
    if (page.length === 100) after = page[page.length - 1].seq;
  } while (page.length === 100);
  return decryptChatMessages(userId, chatId, messages);
}

export async function getChatSafetyCode(userId: string, chatId: string) {
  const record = await loadE2eeStateRecord(userId, chatId);
  if (!record) throw new Error("Chat encryption has not been established yet");
  const fingerprint = await E2eeNative.safetyFingerprint(record.state);
  return encodeSafetyCode(fingerprint);
}

export async function getChatSafetyVerification(userId: string, chatId: string) {
  const safetyCode = await getChatSafetyCode(userId, chatId);
  const trustedCode = await getTrustedChatSafetyCode(userId, chatId);
  return { safetyCode, ...getSafetyCodeStatus(safetyCode, trustedCode) };
}

export async function markChatSafetyCodeVerified(userId: string, chatId: string) {
  await trustChatSafetyCode(userId, chatId, await getChatSafetyCode(userId, chatId));
}
