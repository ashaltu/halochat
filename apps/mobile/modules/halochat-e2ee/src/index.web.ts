import initWasm, * as wasm from "./wasm/halochat_e2ee_core.js";

export type E2eeMember = {
  identity: Uint8Array;
  signatureKey: Uint8Array;
};

export type E2eeState = {
  envelope: Uint8Array;
  deviceKey: Uint8Array;
  context: Uint8Array;
};

export type E2eeDevice = {
  state: E2eeState;
  keyPackage: Uint8Array;
};

export type E2eeKeyPackage = E2eeDevice;

export type E2eeCommit = {
  state: E2eeState;
  commit: Uint8Array;
};

export type E2eeAddMember = E2eeCommit & {
  welcome: Uint8Array;
};

export type E2eeApplication = {
  state: E2eeState;
  message: Uint8Array;
};

type RawDevice = { state: Uint8Array; keyPackage: Uint8Array };
type RawAdded = { state: Uint8Array; commit: Uint8Array; welcome: Uint8Array };
type RawApplication = { state: Uint8Array; ciphertext?: Uint8Array; plaintext?: Uint8Array };

let initialized: Promise<unknown> | undefined;

function ensureInitialized() {
  initialized ??= initWasm("/halochat_e2ee_core_bg.wasm").catch((error) => {
    initialized = undefined;
    throw error;
  });
  return initialized;
}

function protect(rawState: Uint8Array, deviceKey: Uint8Array, context: Uint8Array): E2eeState {
  return {
    envelope: wasm.protectState(rawState, deviceKey, context),
    deviceKey: deviceKey.slice(),
    context: context.slice(),
  };
}

async function open(state: E2eeState) {
  await ensureInitialized();
  return wasm.unprotectState(state.envelope, state.deviceKey, state.context);
}

function memberJson(member: E2eeMember) {
  return new TextEncoder().encode(JSON.stringify({
    identity: Array.from(member.identity),
    signature_key: Array.from(member.signatureKey),
  }));
}

function membersJson(members: E2eeMember[]) {
  return new TextEncoder().encode(JSON.stringify(members.map((member) => ({
    identity: Array.from(member.identity),
    signature_key: Array.from(member.signatureKey),
  }))));
}

function randomBytes(length: number) {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure browser randomness is unavailable");
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

const E2eeWeb = {
  async generateDeviceKey() {
    return randomBytes(32);
  },
  async protectLocalData(data: Uint8Array, deviceKey: Uint8Array, context: Uint8Array) {
    await ensureInitialized();
    return wasm.protectState(data, deviceKey, context);
  },
  async unprotectLocalData(envelope: Uint8Array, deviceKey: Uint8Array, context: Uint8Array) {
    await ensureInitialized();
    return wasm.unprotectState(envelope, deviceKey, context);
  },
  async createDevice(identity: Uint8Array, deviceKey: Uint8Array, context: Uint8Array): Promise<E2eeDevice> {
    await ensureInitialized();
    const result = wasm.createDevice(identity) as RawDevice;
    return { state: protect(result.state, deviceKey, context), keyPackage: result.keyPackage };
  },
  async createKeyPackage(state: E2eeState): Promise<E2eeKeyPackage> {
    const result = wasm.createKeyPackage(await open(state)) as RawDevice;
    return { state: protect(result.state, state.deviceKey, state.context), keyPackage: result.keyPackage };
  },
  async deviceIdentity(state: E2eeState): Promise<E2eeMember> {
    return wasm.deviceIdentity(await open(state)) as E2eeMember;
  },
  async createGroup(state: E2eeState, groupId: Uint8Array, context: Uint8Array): Promise<E2eeState> {
    const result = wasm.createGroup(await open(state), groupId);
    return protect(result, state.deviceKey, context);
  },
  async addMember(state: E2eeState, keyPackage: Uint8Array, expectedMember: E2eeMember): Promise<E2eeAddMember> {
    const result = wasm.addMember(await open(state), keyPackage, memberJson(expectedMember)) as RawAdded;
    return {
      state: protect(result.state, state.deviceKey, state.context),
      commit: result.commit,
      welcome: result.welcome,
    };
  },
  async joinGroup(state: E2eeState, welcome: Uint8Array, context: Uint8Array): Promise<E2eeState> {
    const result = wasm.joinGroup(await open(state), welcome);
    return protect(result, state.deviceKey, context);
  },
  async processCommit(state: E2eeState, commit: Uint8Array, expectedMembers: E2eeMember[]): Promise<E2eeState> {
    const result = wasm.processCommit(await open(state), commit, membersJson(expectedMembers));
    return protect(result, state.deviceKey, state.context);
  },
  async removeMember(state: E2eeState, leafIndex: number): Promise<E2eeCommit> {
    const result = wasm.removeMember(await open(state), leafIndex) as { state: Uint8Array; commit: Uint8Array };
    return { state: protect(result.state, state.deviceKey, state.context), commit: result.commit };
  },
  async encryptApplication(state: E2eeState, plaintext: Uint8Array): Promise<E2eeApplication> {
    const result = wasm.encryptApplication(await open(state), plaintext) as RawApplication;
    if (!result.ciphertext) throw new Error("MLS encryption did not return ciphertext");
    return { state: protect(result.state, state.deviceKey, state.context), message: result.ciphertext };
  },
  async decryptApplication(state: E2eeState, message: Uint8Array): Promise<E2eeApplication> {
    const result = wasm.decryptApplication(await open(state), message) as RawApplication;
    if (!result.plaintext) throw new Error("MLS decryption did not return plaintext");
    return { state: protect(result.state, state.deviceKey, state.context), message: result.plaintext };
  },
  async groupMembers(state: E2eeState): Promise<E2eeMember[]> {
    return wasm.groupMembers(await open(state)) as E2eeMember[];
  },
  async safetyFingerprint(state: E2eeState): Promise<Uint8Array> {
    return wasm.safetyFingerprint(await open(state));
  },
};

export default E2eeWeb;
