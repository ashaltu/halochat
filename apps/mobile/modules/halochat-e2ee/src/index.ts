import { requireNativeModule } from 'expo-modules-core';

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

type HaloChatE2eeNativeModule = {
  generateDeviceKey(): Promise<Uint8Array>;
  protectLocalData(data: Uint8Array, deviceKey: Uint8Array, context: Uint8Array): Promise<Uint8Array>;
  unprotectLocalData(envelope: Uint8Array, deviceKey: Uint8Array, context: Uint8Array): Promise<Uint8Array>;
  createDevice(identity: Uint8Array, deviceKey: Uint8Array, context: Uint8Array): Promise<E2eeDevice>;
  createKeyPackage(state: E2eeState): Promise<E2eeKeyPackage>;
  deviceIdentity(state: E2eeState): Promise<E2eeMember>;
  createGroup(state: E2eeState, groupId: Uint8Array, context: Uint8Array): Promise<E2eeState>;
  addMember(state: E2eeState, keyPackage: Uint8Array, expectedMember: E2eeMember): Promise<E2eeAddMember>;
  joinGroup(state: E2eeState, welcome: Uint8Array, context: Uint8Array): Promise<E2eeState>;
  processCommit(state: E2eeState, commit: Uint8Array, expectedMembers: E2eeMember[]): Promise<E2eeState>;
  removeMember(state: E2eeState, leafIndex: number): Promise<E2eeCommit>;
  encryptApplication(state: E2eeState, plaintext: Uint8Array): Promise<E2eeApplication>;
  decryptApplication(state: E2eeState, message: Uint8Array): Promise<E2eeApplication>;
  groupMembers(state: E2eeState): Promise<E2eeMember[]>;
};

export default requireNativeModule<HaloChatE2eeNativeModule>('HaloChatE2ee');
