const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const {
  addMember,
  createDevice,
  createGroup,
  deviceIdentity,
  decryptApplication,
  encryptApplication,
  groupMembers,
  joinGroup,
  processCommit,
  protectState,
  removeMember,
  unprotectState,
} = require("../target/wasm-node/halochat_e2ee_core.js");

const memberJson = (member) =>
  Buffer.from(
    JSON.stringify({
      identity: Array.from(member.identity),
      signature_key: Array.from(member.signatureKey),
    }),
  );
const membersJson = (members) => Buffer.from(JSON.stringify(members.map((member) => ({
  identity: Array.from(member.identity),
  signature_key: Array.from(member.signatureKey),
}))));

const alice = createDevice(Buffer.from("alice/device-1"));
const bob = createDevice(Buffer.from("bob/device-1"));
let aliceState = createGroup(alice.state, Buffer.from("chat-group-1"));
const storageKey = randomBytes(32);
const stateContext = Buffer.from("account:alice/device:1/group:chat-group-1");
const protectedState = protectState(aliceState, storageKey, stateContext);
assert.equal(Buffer.from(protectedState).includes(Buffer.from("alice/device-1")), false);
assert.deepEqual(
  Buffer.from(unprotectState(protectedState, storageKey, stateContext)),
  Buffer.from(aliceState),
);
assert.throws(() => unprotectState(protectedState, randomBytes(32), stateContext));
assert.throws(() => unprotectState(protectedState, storageKey, Buffer.from("other group")));
aliceState = unprotectState(protectedState, storageKey, stateContext);
const added = addMember(aliceState, bob.keyPackage, memberJson(deviceIdentity(bob.state)));
aliceState = added.state;
let bobState = joinGroup(bob.state, added.welcome);

const charlie = createDevice(Buffer.from("charlie/device-1"));
const mallory = createDevice(Buffer.from("mallory/device-1"));
assert.throws(() =>
  addMember(aliceState, charlie.keyPackage, memberJson(deviceIdentity(mallory.state))),
);
const addCharlie = addMember(
  aliceState,
  charlie.keyPackage,
  memberJson(deviceIdentity(charlie.state)),
);
aliceState = addCharlie.state;
const expectedAfterAdd = groupMembers(aliceState);
assert.throws(() =>
  processCommit(bobState, addCharlie.commit, membersJson([deviceIdentity(bob.state)])),
);
bobState = processCommit(bobState, addCharlie.commit, membersJson(expectedAfterAdd));
let charlieState = joinGroup(charlie.state, addCharlie.welcome);

const sent = encryptApplication(aliceState, Buffer.from("hello from wasm"));
aliceState = sent.state;
const received = decryptApplication(bobState, sent.ciphertext);
bobState = received.state;
assert.equal(Buffer.from(received.plaintext).toString(), "hello from wasm");
const charlieReceived = decryptApplication(charlieState, sent.ciphertext);
charlieState = charlieReceived.state;
assert.equal(Buffer.from(charlieReceived.plaintext).toString(), "hello from wasm");

const reply = encryptApplication(bobState, Buffer.from("wasm reply"));
bobState = reply.state;
const roundTrip = decryptApplication(aliceState, reply.ciphertext);
aliceState = roundTrip.state;
assert.equal(Buffer.from(roundTrip.plaintext).toString(), "wasm reply");

const removed = removeMember(aliceState, 1);
charlieState = processCommit(
  charlieState,
  removed.commit,
  membersJson(groupMembers(removed.state)),
);
const afterRemoval = encryptApplication(removed.state, Buffer.from("new epoch only"));
assert.throws(() => decryptApplication(bobState, afterRemoval.ciphertext));
const charlieAfterRemoval = decryptApplication(charlieState, afterRemoval.ciphertext);
assert.equal(Buffer.from(charlieAfterRemoval.plaintext).toString(), "new epoch only");

assert.throws(() => createDevice(new Uint8Array()), /identity cannot be empty/);
console.log("WASM MLS state protection, membership, commit, messaging, and removal tests passed");
