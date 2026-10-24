declare module "*halochat_e2ee_core.js" {
  export function addMember(state: Uint8Array, keyPackage: Uint8Array, expectedMember: Uint8Array): unknown;
  export function createDevice(identity: Uint8Array): unknown;
  export function createKeyPackage(state: Uint8Array): unknown;
  export function createGroup(state: Uint8Array, groupId: Uint8Array): Uint8Array;
  export function decryptApplication(state: Uint8Array, message: Uint8Array): unknown;
  export function deviceIdentity(state: Uint8Array): unknown;
  export function encryptApplication(state: Uint8Array, plaintext: Uint8Array): unknown;
  export function groupMembers(state: Uint8Array): unknown;
  export function joinGroup(state: Uint8Array, welcome: Uint8Array): Uint8Array;
  export function processCommit(state: Uint8Array, commit: Uint8Array, expectedMembers: Uint8Array): Uint8Array;
  export function protectState(state: Uint8Array, key: Uint8Array, context: Uint8Array): Uint8Array;
  export function removeMember(state: Uint8Array, leafIndex: number): unknown;
  export function safetyFingerprint(state: Uint8Array): Uint8Array;
  export function unprotectState(envelope: Uint8Array, key: Uint8Array, context: Uint8Array): Uint8Array;
  export default function init(): Promise<unknown>;
}
