const assert = require("node:assert/strict");
const {
  addMember,
  createDevice,
  createGroup,
  decryptApplication,
  encryptApplication,
  joinGroup,
  removeMember,
} = require("../target/wasm-node/halochat_e2ee_core.js");

const alice = createDevice(Buffer.from("alice/device-1"));
const bob = createDevice(Buffer.from("bob/device-1"));
let aliceState = createGroup(alice.state, Buffer.from("chat-group-1"));
const added = addMember(aliceState, bob.keyPackage);
aliceState = added.state;
let bobState = joinGroup(bob.state, added.welcome);

const sent = encryptApplication(aliceState, Buffer.from("hello from wasm"));
aliceState = sent.state;
const received = decryptApplication(bobState, sent.ciphertext);
bobState = received.state;
assert.equal(Buffer.from(received.plaintext).toString(), "hello from wasm");

const reply = encryptApplication(bobState, Buffer.from("wasm reply"));
bobState = reply.state;
const roundTrip = decryptApplication(aliceState, reply.ciphertext);
assert.equal(Buffer.from(roundTrip.plaintext).toString(), "wasm reply");

const removed = removeMember(roundTrip.state, 1);
const afterRemoval = encryptApplication(removed.state, Buffer.from("new epoch only"));
assert.throws(() => decryptApplication(bobState, afterRemoval.ciphertext));

assert.throws(() => createDevice(new Uint8Array()), /identity cannot be empty/);
console.log("WASM MLS two-member round-trip passed");
