import base64 from "base64-js";
import * as FileSystem from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import E2eeNative, { type E2eeState } from "@halochat/e2ee-native";

const initialization = new Map<string, Promise<DeviceContext>>();

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

type StateFile = {
  version: 1;
  envelope: string;
  localDataEnvelope: string;
};

const EMPTY_LOCAL_DATA: E2eeLocalData = {
  lastSeq: 0,
  pendingMessages: [],
  plaintextByMessageId: {},
};

function asciiBytes(value: string): Uint8Array {
  if (!/^[\x20-\x7e]+$/.test(value)) throw new Error("Invalid E2EE context");
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function safeFilePart(value: string): string {
  return base64.fromByteArray(asciiBytes(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function contextFor(userId: string, deviceId: string, scope: string): Uint8Array {
  return asciiBytes(`halochat:mls-state:v1:${userId}:${deviceId}:${scope}`);
}

function secureStoreOptions() {
  return { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
}

function deviceIdKey(userId: string) {
  return `halochat.e2ee.device-id.${safeFilePart(userId)}`;
}

function deviceKeyKey(userId: string) {
  return `halochat.e2ee.device-key.${safeFilePart(userId)}`;
}

async function getDeviceContext(userId: string): Promise<DeviceContext> {
  const existing = initialization.get(userId);
  if (existing) return existing;

  const pending = (async () => {
    let deviceId = await SecureStore.getItemAsync(deviceIdKey(userId));
    let encodedKey = await SecureStore.getItemAsync(deviceKeyKey(userId));
    if ((deviceId && !encodedKey) || (!deviceId && encodedKey)) {
      throw new Error("E2EE device key storage is incomplete; account recovery is required");
    }
    if (!deviceId && !encodedKey) {
      const idBytes = await E2eeNative.generateDeviceKey();
      const keyBytes = await E2eeNative.generateDeviceKey();
      deviceId = base64.fromByteArray(idBytes.subarray(0, 16));
      encodedKey = base64.fromByteArray(keyBytes);
      await SecureStore.setItemAsync(deviceKeyKey(userId), encodedKey, secureStoreOptions());
      await SecureStore.setItemAsync(deviceIdKey(userId), deviceId, secureStoreOptions());
    }
    if (!deviceId || !encodedKey) throw new Error("Unable to initialize E2EE device storage");

    return {
      deviceId,
      deviceKey: base64.toByteArray(encodedKey),
      context: contextFor(userId, deviceId, "device"),
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

function stateUri(userId: string, deviceId: string, chatId: string, version: string) {
  const root = FileSystem.documentDirectory;
  if (!root) throw new Error("Private app storage is unavailable");
  return `${root}e2ee-${safeFilePart(userId)}-${safeFilePart(deviceId)}-${safeFilePart(chatId)}-${version}.state`;
}

function pointerKey(userId: string, chatId: string) {
  return `halochat.e2ee.state.${safeFilePart(userId)}.${safeFilePart(chatId)}`;
}

function keyPackagePublishedKey(userId: string, chatId: string) {
  return `halochat.e2ee.key-package.${safeFilePart(userId)}.${safeFilePart(chatId)}`;
}

function localDataContext(userId: string, deviceId: string, chatId: string) {
  return contextFor(userId, deviceId, `local-cache:${chatId}`);
}

function utf8Bytes(value: string): Uint8Array {
  const encoded = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return Uint8Array.from(encoded, (character) => character.charCodeAt(0));
}

function utf8String(value: Uint8Array): string {
  const encoded = Array.from(value, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  return decodeURIComponent(encoded);
}

function isLocalData(value: unknown): value is E2eeLocalData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<E2eeLocalData>;
  return Number.isSafeInteger(data.lastSeq) && data.lastSeq! >= 0 &&
    Array.isArray(data.pendingMessages) &&
    !!data.plaintextByMessageId && typeof data.plaintextByMessageId === "object";
}

async function readStateFile(userId: string, chatId: string, device: DeviceContext) {
  const filename = await SecureStore.getItemAsync(pointerKey(userId, chatId));
  if (!filename) return null;

  const uri = stateUri(userId, device.deviceId, chatId, filename);
  const contents = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
  let parsed: Partial<StateFile>;
  try {
    parsed = JSON.parse(contents) as Partial<StateFile>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { filename, stateEnvelope: contents, localData: EMPTY_LOCAL_DATA };
    }
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.envelope !== "string" || typeof parsed.localDataEnvelope !== "string") {
    throw new Error("Invalid encrypted E2EE state file");
  }
  const localDataBytes = await E2eeNative.unprotectLocalData(
    base64.toByteArray(parsed.localDataEnvelope),
    device.deviceKey.slice(),
    localDataContext(userId, device.deviceId, chatId).slice(),
  );
  let localData: unknown;
  try {
    localData = JSON.parse(utf8String(localDataBytes));
  } finally {
    localDataBytes.fill(0);
  }
  if (!isLocalData(localData)) throw new Error("Invalid encrypted local E2EE data");

  return { filename, stateEnvelope: parsed.envelope, localData };
}

export async function hasPublishedChatKeyPackage(userId: string, chatId: string) {
  return (await SecureStore.getItemAsync(keyPackagePublishedKey(userId, chatId))) === "1";
}

export async function markChatKeyPackagePublished(userId: string, chatId: string) {
  await SecureStore.setItemAsync(keyPackagePublishedKey(userId, chatId), "1", secureStoreOptions());
}

export async function initializeE2eeDevice(userId: string) {
  const device = await getDeviceContext(userId);
  const existingState = await loadE2eeState(userId, "device");
  const deviceState = await SecureStore.getItemAsync(`halochat.e2ee.device-state.${safeFilePart(userId)}`);
  if (existingState && deviceState) {
    return { deviceId: device.deviceId, keyPackage: base64.toByteArray(deviceState) };
  }

  const created = await E2eeNative.createDevice(
    asciiBytes(`halochat:user:${userId}:device:${device.deviceId}`),
    device.deviceKey,
    device.context,
  );
  await saveE2eeState(userId, "device", created.state);
  await SecureStore.setItemAsync(
    `halochat.e2ee.device-state.${safeFilePart(userId)}`,
    base64.fromByteArray(created.keyPackage),
    secureStoreOptions(),
  );
  return { deviceId: device.deviceId, keyPackage: created.keyPackage };
}

export async function loadE2eeState(userId: string, chatId: string): Promise<E2eeState | null> {
  const device = await getDeviceContext(userId);
  const stored = await readStateFile(userId, chatId, device);
  if (!stored) return null;
  return {
    envelope: base64.toByteArray(stored.stateEnvelope),
    deviceKey: device.deviceKey,
    context: contextFor(userId, device.deviceId, chatId),
  };
}

export async function loadE2eeStateRecord(userId: string, chatId: string): Promise<E2eeStateRecord | null> {
  const device = await getDeviceContext(userId);
  const stored = await readStateFile(userId, chatId, device);
  if (!stored) return null;
  return {
    state: {
      envelope: base64.toByteArray(stored.stateEnvelope),
      deviceKey: device.deviceKey,
      context: contextFor(userId, device.deviceId, chatId),
    },
    localData: stored.localData,
  };
}

export async function getE2eeContext(userId: string, scope: string): Promise<Uint8Array> {
  const device = await getDeviceContext(userId);
  return contextFor(userId, device.deviceId, scope);
}

export async function saveE2eeState(
  userId: string,
  chatId: string,
  state: E2eeState,
  updatedLocalData?: E2eeLocalData,
): Promise<void> {
  const device = await getDeviceContext(userId);
  if (state.deviceKey.length !== 32 || state.context.length === 0) {
    throw new Error("Invalid E2EE device state");
  }

  if (!sameBytes(state.deviceKey, device.deviceKey) || !sameBytes(state.context, contextFor(userId, device.deviceId, chatId))) {
    throw new Error("E2EE state belongs to a different device");
  }
  const version = safeFilePart(base64.fromByteArray(await E2eeNative.generateDeviceKey()));
  const uri = stateUri(userId, device.deviceId, chatId, version);
  const previous = await readStateFile(userId, chatId, device);
  const localData = updatedLocalData ?? previous?.localData ?? EMPTY_LOCAL_DATA;
  if (!isLocalData(localData)) throw new Error("Invalid local E2EE data");
  const localDataEnvelope = await E2eeNative.protectLocalData(
    utf8Bytes(JSON.stringify(localData)),
    device.deviceKey.slice(),
    localDataContext(userId, device.deviceId, chatId).slice(),
  );
  const stored: StateFile = {
    version: 1,
    envelope: base64.fromByteArray(state.envelope),
    localDataEnvelope: base64.fromByteArray(localDataEnvelope),
  };
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(stored), {
    encoding: FileSystem.EncodingType.UTF8,
  });

  try {
    await SecureStore.setItemAsync(pointerKey(userId, chatId), version, secureStoreOptions());
  } catch (error) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    throw error;
  }

  if (previous) {
    await FileSystem.deleteAsync(stateUri(userId, device.deviceId, chatId, previous.filename), { idempotent: true });
  }
}
