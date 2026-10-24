import base64 from "base64-js";
import E2eeWeb, { type E2eeState } from "@halochat/e2ee-native";

const initialization = new Map<string, Promise<DeviceContext>>();
const clearing = new Map<string, Promise<void>>();
const databaseName = "halochat-e2ee-v1";

type DeviceContext = {
  deviceId: string;
  deviceKey: Uint8Array;
  context: Uint8Array;
};

export type E2eePendingMessage = {
  clientMsgId: string;
  ciphertext: string;
  encryptionMetadata: Record<string, unknown>;
  plaintext?: string;
  plaintextCharLength?: number;
};

export type E2eeLocalData = {
  lastSeq: number;
  pendingMessages: E2eePendingMessage[];
  plaintextByMessageId: Record<string, string>;
};

export type E2eeStateRecord = {
  state: E2eeState;
  localData: E2eeLocalData;
};

type StoredValue = { id: string; value: unknown };
type WrappedDeviceKey = { deviceId: string; iv: string; encryptedKey: string };
type StoredState = { version: 1; envelope: string; localDataEnvelope: string };

const EMPTY_LOCAL_DATA: E2eeLocalData = {
  lastSeq: 0,
  pendingMessages: [],
  plaintextByMessageId: {},
};

export async function clearE2eeMemory(userId: string) {
  const existingWipe = clearing.get(userId);
  if (existingWipe) return existingWipe;
  const pending = initialization.get(userId);
  if (!pending) return;
  initialization.delete(userId);
  const wipe = pending.then((device) => { device.deviceKey.fill(0); }, () => {});
  clearing.set(userId, wipe);
  try {
    await wipe;
  } finally {
    if (clearing.get(userId) === wipe) clearing.delete(userId);
  }
}

function bytes(value: string) {
  return new TextEncoder().encode(value);
}

function buffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}

function asciiBytes(value: string) {
  if (!/^[\x20-\x7e]+$/.test(value)) throw new Error("Invalid E2EE context");
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function safePart(value: string) {
  return base64.fromByteArray(asciiBytes(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function contextFor(userId: string, deviceId: string, scope: string) {
  return asciiBytes(`halochat:mls-state:v1:${userId}:${deviceId}:${scope}`);
}

function localDataContext(userId: string, deviceId: string, chatId: string) {
  return contextFor(userId, deviceId, `local-cache:${chatId}`);
}

function idb() {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) {
    throw new Error("Encrypted web messaging requires secure browser storage and WebCrypto");
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open encrypted browser storage"));
  });
}

async function readEntry<T>(id: string): Promise<T | null> {
  const database = await idb();
  return new Promise((resolve, reject) => {
    const request = database.transaction("entries", "readonly").objectStore("entries").get(id);
    request.onsuccess = () => resolve((request.result as StoredValue | undefined)?.value as T ?? null);
    request.onerror = () => reject(request.error ?? new Error("Unable to read encrypted browser storage"));
  });
}

async function writeEntry(id: string, value: unknown, insertOnly = false) {
  const database = await idb();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("entries", "readwrite");
    const store = transaction.objectStore("entries");
    if (insertOnly) store.add({ id, value } satisfies StoredValue);
    else store.put({ id, value } satisfies StoredValue);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Unable to write encrypted browser storage"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Encrypted browser storage transaction aborted"));
  });
}

async function getMasterKey(userId: string) {
  const id = `master:${safePart(userId)}`;
  const existing = await readEntry<CryptoKey>(id);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  try {
    await writeEntry(id, key, true);
    return key;
  } catch {
    const winner = await readEntry<CryptoKey>(id);
    if (winner) return winner;
    throw new Error("Unable to initialize encrypted browser key storage");
  }
}

async function getDeviceContext(userId: string): Promise<DeviceContext> {
  const wipe = clearing.get(userId);
  if (wipe) {
    await wipe;
    return getDeviceContext(userId);
  }
  const current = initialization.get(userId);
  if (current) return current;

  const pending = (async () => {
    const entryId = `device:${safePart(userId)}`;
    const masterKey = await getMasterKey(userId);
    let stored: WrappedDeviceKey | null = await readEntry<WrappedDeviceKey>(entryId);
    if (!stored) {
      const deviceId = base64.fromByteArray(crypto.getRandomValues(new Uint8Array(16)));
      const deviceKey = await E2eeWeb.generateDeviceKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const keyInput = buffer(deviceKey);
      let encryptedKey: ArrayBuffer;
      try {
        encryptedKey = await crypto.subtle.encrypt({
          name: "AES-GCM",
          iv: buffer(iv),
          additionalData: buffer(bytes(`halochat:web-device-key:v1:${userId}`)),
        }, masterKey, keyInput);
      } finally {
        deviceKey.fill(0);
        new Uint8Array(keyInput).fill(0);
      }
      const candidate = {
        deviceId,
        iv: base64.fromByteArray(iv),
        encryptedKey: base64.fromByteArray(new Uint8Array(encryptedKey)),
      };
      try {
        await writeEntry(entryId, candidate, true);
        stored = candidate;
      } catch {
        stored = await readEntry<WrappedDeviceKey>(entryId);
      }
    }
    if (!stored) throw new Error("Unable to initialize the browser E2EE device");
    const decryptedKey = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: buffer(base64.toByteArray(stored.iv)),
      additionalData: buffer(bytes(`halochat:web-device-key:v1:${userId}`)),
    }, masterKey, buffer(base64.toByteArray(stored.encryptedKey)));
    return {
      deviceId: stored.deviceId,
      deviceKey: new Uint8Array(decryptedKey),
      context: contextFor(userId, stored.deviceId, "device"),
    };
  })();

  initialization.set(userId, pending);
  try {
    return await pending;
  } catch (error) {
    initialization.delete(userId);
    throw error;
  }
}

function stateKey(userId: string, chatId: string) {
  return `state:${safePart(userId)}:${safePart(chatId)}`;
}

function safetyCodeKey(userId: string, chatId: string) {
  return `safety:${safePart(userId)}:${safePart(chatId)}`;
}

function keyPackageKey(userId: string, chatId: string) {
  return `key-package:${safePart(userId)}:${safePart(chatId)}`;
}

function utf8String(value: Uint8Array) {
  return new TextDecoder().decode(value);
}

function isLocalData(value: unknown): value is E2eeLocalData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<E2eeLocalData>;
  return Number.isSafeInteger(data.lastSeq) && data.lastSeq! >= 0 && Array.isArray(data.pendingMessages) &&
    !!data.plaintextByMessageId && typeof data.plaintextByMessageId === "object";
}

async function readState(userId: string, chatId: string, device: DeviceContext) {
  const stored = await readEntry<StoredState>(stateKey(userId, chatId));
  if (!stored) return null;
  if (stored.version !== 1 || typeof stored.envelope !== "string" || typeof stored.localDataEnvelope !== "string") {
    throw new Error("Invalid encrypted E2EE state in browser storage");
  }
  const localDataBytes = await E2eeWeb.unprotectLocalData(
    base64.toByteArray(stored.localDataEnvelope),
    device.deviceKey.slice(),
    localDataContext(userId, device.deviceId, chatId),
  );
  let localData: unknown;
  try {
    localData = JSON.parse(utf8String(localDataBytes));
  } finally {
    localDataBytes.fill(0);
  }
  if (!isLocalData(localData)) throw new Error("Invalid encrypted local E2EE data");
  return { stored, localData };
}

export async function hasPublishedChatKeyPackage(userId: string, chatId: string, scope = "PARTICIPANT") {
  return (await readEntry<boolean>(keyPackageKey(userId, `${chatId}:${scope}:proof-v1`))) === true;
}

export async function markChatKeyPackagePublished(userId: string, chatId: string, scope = "PARTICIPANT") {
  await writeEntry(keyPackageKey(userId, `${chatId}:${scope}:proof-v1`), true);
}

export async function getTrustedChatSafetyCode(userId: string, chatId: string) {
  return readEntry<string>(safetyCodeKey(userId, chatId));
}

export async function trustChatSafetyCode(userId: string, chatId: string, safetyCode: string) {
  await writeEntry(safetyCodeKey(userId, chatId), safetyCode);
}

export async function initializeE2eeDevice(userId: string) {
  const device = await getDeviceContext(userId);
  const existingState = await loadE2eeState(userId, "device");
  const keyPackage = await readEntry<string>(`device-key-package:${safePart(userId)}`);
  if (existingState && keyPackage) return { deviceId: device.deviceId, keyPackage: base64.toByteArray(keyPackage) };

  const created = await E2eeWeb.createDevice(
    asciiBytes(`halochat:user:${userId}:device:${device.deviceId}`),
    device.deviceKey,
    device.context,
  );
  await saveE2eeState(userId, "device", created.state);
  await writeEntry(`device-key-package:${safePart(userId)}`, base64.fromByteArray(created.keyPackage));
  return { deviceId: device.deviceId, keyPackage: created.keyPackage };
}

export async function loadE2eeState(userId: string, chatId: string): Promise<E2eeState | null> {
  const device = await getDeviceContext(userId);
  const stored = await readState(userId, chatId, device);
  if (!stored) return null;
  return {
    envelope: base64.toByteArray(stored.stored.envelope),
    deviceKey: device.deviceKey,
    context: contextFor(userId, device.deviceId, chatId),
  };
}

export async function loadE2eeStateRecord(userId: string, chatId: string): Promise<E2eeStateRecord | null> {
  const device = await getDeviceContext(userId);
  const stored = await readState(userId, chatId, device);
  if (!stored) return null;
  return {
    state: {
      envelope: base64.toByteArray(stored.stored.envelope),
      deviceKey: device.deviceKey,
      context: contextFor(userId, device.deviceId, chatId),
    },
    localData: stored.localData,
  };
}

export async function getE2eeContext(userId: string, scope: string) {
  const device = await getDeviceContext(userId);
  return contextFor(userId, device.deviceId, scope);
}

export async function saveE2eeState(
  userId: string,
  chatId: string,
  state: E2eeState,
  updatedLocalData?: E2eeLocalData,
) {
  const device = await getDeviceContext(userId);
  const context = contextFor(userId, device.deviceId, chatId);
  if (state.deviceKey.length !== 32 || state.context.length === 0 ||
    !state.deviceKey.every((byte, index) => byte === device.deviceKey[index]) ||
    !state.context.every((byte, index) => byte === context[index]) || state.context.length !== context.length) {
    throw new Error("E2EE state belongs to a different browser device");
  }
  const previous = await readState(userId, chatId, device);
  const localData = updatedLocalData ?? previous?.localData ?? EMPTY_LOCAL_DATA;
  if (!isLocalData(localData)) throw new Error("Invalid local E2EE data");
  const localDataEnvelope = await E2eeWeb.protectLocalData(
    bytes(JSON.stringify(localData)),
    device.deviceKey.slice(),
    localDataContext(userId, device.deviceId, chatId),
  );
  await writeEntry(stateKey(userId, chatId), {
    version: 1,
    envelope: base64.fromByteArray(state.envelope),
    localDataEnvelope: base64.fromByteArray(localDataEnvelope),
  } satisfies StoredState);
}
