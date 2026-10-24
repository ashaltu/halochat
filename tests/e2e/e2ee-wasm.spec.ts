import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const smokePath = "http://127.0.0.1:4173/e2ee-wasm-smoke/";
const wasmOutput = resolve("apps/mobile/modules/halochat-e2ee/src/wasm");
const storeBundle = "/private/tmp/halochat-e2ee-web-store-entry.js";

async function installWasmRoutes(page: import("@playwright/test").Page) {
  await page.route(`${smokePath}halochat_e2ee_core.js`, (route) => route.fulfill({
    path: resolve(wasmOutput, "halochat_e2ee_core.js"),
    contentType: "text/javascript",
  }));
  await page.route(`${smokePath}halochat_e2ee_core_bg.wasm`, (route) => route.fulfill({
    path: resolve(wasmOutput, "halochat_e2ee_core_bg.wasm"),
    contentType: "application/wasm",
  }));
}

async function installWebStoreHarness(page: import("@playwright/test").Page) {
  await page.route(`${smokePath}index.html`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><body><script type="module" src="./e2ee-web-store-entry.js"></script></body>`,
  }));
  await page.route(`${smokePath}e2ee-web-store-entry.js`, (route) => route.fulfill({
    path: storeBundle,
    contentType: "text/javascript",
  }));
  await installWasmRoutes(page);
  await page.route("http://127.0.0.1:4173/halochat_e2ee_core_bg.wasm", (route) => route.fulfill({
    path: resolve(wasmOutput, "halochat_e2ee_core_bg.wasm"),
    contentType: "application/wasm",
  }));
  await page.goto(`${smokePath}index.html`);
}

async function prepareWebDevice(page: import("@playwright/test").Page, userId: string) {
  return page.evaluate(async (userId) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      initializeE2eeDevice(userId: string): Promise<{ deviceId: string }>;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
    };
    const encoder = new TextEncoder();
    const device = await api.initializeE2eeDevice(userId);
    const state = (await api.loadE2eeStateRecord(userId, "device"))!.state;
    const member = await api.E2eeWeb.deviceIdentity(state);
    const keyPackage = await api.E2eeWeb.createKeyPackage(state);
    const proof = await api.E2eeWeb.signDeviceBinding(keyPackage.state, encoder.encode(userId), encoder.encode(device.deviceId));
    await api.saveE2eeState(userId, "device", keyPackage.state);
    const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
    return {
      userId,
      deviceId: device.deviceId,
      identity: b64(member.identity),
      signatureKey: b64(member.signatureKey),
      signatureProof: b64(proof),
      keyPackage: b64(keyPackage.keyPackage),
    };
  }, userId);
}

test("browser WASM creates an MLS group and encrypts/decrypts a message", async ({ page }) => {
  await page.route(`${smokePath}index.html`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><body><script type="module">
      import init, { addMember, createDevice, createGroup, decryptApplication, deviceIdentity, encryptApplication, joinGroup, safetyFingerprint } from "./halochat_e2ee_core.js";
      try {
        await init();
        const encoder = new TextEncoder();
        const alice = createDevice(encoder.encode("alice/device-1"));
        const bob = createDevice(encoder.encode("bob/device-1"));
        const group = createGroup(alice.state, encoder.encode("chat-group-1"));
        const member = deviceIdentity(bob.state);
        const added = addMember(group, bob.keyPackage, encoder.encode(JSON.stringify({
          identity: Array.from(member.identity),
          signature_key: Array.from(member.signatureKey),
        })));
        const joined = joinGroup(bob.state, added.welcome);
        const encrypted = encryptApplication(added.state, encoder.encode("browser MLS round trip"));
        const decrypted = decryptApplication(joined, encrypted.ciphertext);
        if (new TextDecoder().decode(decrypted.plaintext) !== "browser MLS round trip") throw new Error("message mismatch");
        if (String(safetyFingerprint(added.state)) !== String(safetyFingerprint(joined))) throw new Error("safety code mismatch");
        document.body.dataset.result = "passed";
      } catch (error) {
        document.body.dataset.error = String(error);
        document.body.dataset.result = "failed";
      }
    </script></body>`,
  }));
  await installWasmRoutes(page);

  await page.goto(`${smokePath}index.html`);
  await page.waitForFunction(() => document.body.dataset.result !== undefined);
  expect(await page.locator("body").getAttribute("data-error")).toBeNull();
  await expect(page.locator("body")).toHaveAttribute("data-result", "passed");
});

test("web adapter encrypts and persists MLS state across reloads", async ({ page }) => {
  const suffix = Date.now().toString();
  const userA = `browser-a-${suffix}`;
  const userB = `browser-b-${suffix}`;
  const chatId = `browser-chat-${suffix}`;
  await page.route(`${smokePath}index.html`, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><body><script type="module" src="./e2ee-web-store-entry.js"></script></body>`,
  }));
  await page.route(`${smokePath}e2ee-web-store-entry.js`, (route) => route.fulfill({
    path: storeBundle,
    contentType: "text/javascript",
  }));
  await installWasmRoutes(page);
  await page.route("http://127.0.0.1:4173/halochat_e2ee_core_bg.wasm", (route) => route.fulfill({
    path: resolve(wasmOutput, "halochat_e2ee_core_bg.wasm"),
    contentType: "application/wasm",
  }));
  await page.goto(`${smokePath}index.html`);

  const setup = await page.evaluate(async ({ userA, userB, chatId }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      getE2eeContext(userId: string, scope: string): Promise<Uint8Array>;
      initializeE2eeDevice(userId: string): Promise<{ deviceId: string; keyPackage: Uint8Array }>;
      loadE2eeStateRecord(userId: string, chatId: string): Promise<any>;
      saveE2eeState(userId: string, chatId: string, state: any, localData?: any): Promise<void>;
    };
    const encoder = new TextEncoder();
    const aliceDevice = await api.initializeE2eeDevice(userA);
    const bobDevice = await api.initializeE2eeDevice(userB);
    let aliceState = await api.loadE2eeStateRecord(userA, "device");
    let bobState = await api.loadE2eeStateRecord(userB, "device");
    const aliceContext = await api.getE2eeContext(userA, chatId);
    const bobContext = await api.getE2eeContext(userB, chatId);
    const group = await api.E2eeWeb.createGroup(aliceState.state, encoder.encode(`halochat:chat:${chatId}`), aliceContext);
    const bobKeyPackage = await api.E2eeWeb.createKeyPackage(bobState.state);
    bobState = { ...bobState, state: bobKeyPackage.state };
    await api.saveE2eeState(userB, "device", bobKeyPackage.state);
    const bobMember = await api.E2eeWeb.deviceIdentity(bobKeyPackage.state);
    const added = await api.E2eeWeb.addMember(group, bobKeyPackage.keyPackage, bobMember);
    const bobGroup = await api.E2eeWeb.joinGroup(bobKeyPackage.state, added.welcome, bobContext);
    const sent = await api.E2eeWeb.encryptApplication(added.state, encoder.encode("persisted browser MLS message"));
    await api.saveE2eeState(userA, chatId, sent.state, {
      lastSeq: 1,
      pendingMessages: [],
      plaintextByMessageId: { local: "persisted browser MLS message" },
    });
    await api.saveE2eeState(userB, chatId, bobGroup, {
      lastSeq: 0,
      pendingMessages: [],
      plaintextByMessageId: {},
    });
    sessionStorage.setItem("halo-e2ee-web-test", JSON.stringify({
      userA,
      userB,
      chatId,
      ciphertext: Array.from(sent.message),
    }));
    return { aliceDeviceId: aliceDevice.deviceId, bobDeviceId: bobDevice.deviceId };
  }, { userA, userB, chatId });
  expect(setup.aliceDeviceId).not.toBe(setup.bobDeviceId);

  await page.reload();
  const result = await page.evaluate(async () => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, chatId: string): Promise<any>;
      saveE2eeState(userId: string, chatId: string, state: any, localData?: any): Promise<void>;
    };
    const saved = JSON.parse(sessionStorage.getItem("halo-e2ee-web-test")!);
    const alice = await api.loadE2eeStateRecord(saved.userA, saved.chatId);
    const bob = await api.loadE2eeStateRecord(saved.userB, saved.chatId);
    const ciphertext = Uint8Array.from(saved.ciphertext);
    const decrypted = await api.E2eeWeb.decryptApplication(bob.state, ciphertext);
    await api.saveE2eeState(saved.userB, saved.chatId, decrypted.state, {
      lastSeq: 1,
      pendingMessages: [],
      plaintextByMessageId: { received: new TextDecoder().decode(decrypted.message) },
    });
    const restoredBob = await api.loadE2eeStateRecord(saved.userB, saved.chatId);
    return {
      plaintext: new TextDecoder().decode(decrypted.message),
      localCache: alice.localData.plaintextByMessageId.local,
      sameSafetyCode: String(await api.E2eeWeb.safetyFingerprint(alice.state)) ===
        String(await api.E2eeWeb.safetyFingerprint(restoredBob.state)),
    };
  });
  expect(result.plaintext).toBe("persisted browser MLS message");
  expect(result.localCache).toBe("persisted browser MLS message");
  expect(result.sameSafetyCode).toBe(true);
});

test("two browser devices establish MLS through the backend and exchange encrypted messages", async ({ browser, page, request }) => {
  const suffix = Date.now().toString();
  const signUp = async (prefix: string, sex: "MALE" | "FEMALE") => {
    const response = await request.post("http://127.0.0.1:3000/api/auth/sign-up/email", {
      data: {
        email: `${prefix}-${suffix}@example.com`,
        username: `${prefix}_${suffix}`,
        displayName: prefix.toUpperCase(),
        password: "password123",
        dateOfBirth: "1995-01-01",
        sex,
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };
  const requester = await signUp("wca", "MALE");
  const recipient = await signUp("wcb", "FEMALE");
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const contactResponse = await request.post("http://127.0.0.1:3000/api/v1/requests", {
    headers: auth(requester.session.token),
    data: { recipientId: recipient.user.id, purpose: "Social / personal" },
  });
  expect(contactResponse.status(), await contactResponse.text()).toBe(201);
  const contact = await contactResponse.json();
  const accepted = await request.post(`http://127.0.0.1:3000/api/v1/requests/${contact.requestId}/accept`, {
    headers: auth(recipient.session.token),
  });
  expect(accepted.status(), await accepted.text()).toBe(200);

  const listedChats = await request.get("http://127.0.0.1:3000/api/v1/chats", {
    headers: auth(requester.session.token),
  });
  const { chats } = await listedChats.json();
  const chatId = chats[0].id as string;

  const recipientContext = await browser.newContext();
  const recipientPage = await recipientContext.newPage();
  await Promise.all([installWebStoreHarness(page), installWebStoreHarness(recipientPage)]);

  const prepareDevice = (targetPage: import("@playwright/test").Page, userId: string) => targetPage.evaluate(async (userId) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      initializeE2eeDevice(userId: string): Promise<{ deviceId: string }>;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
    };
    const encoder = new TextEncoder();
    const device = await api.initializeE2eeDevice(userId);
    const state = (await api.loadE2eeStateRecord(userId, "device"))!.state;
    const member = await api.E2eeWeb.deviceIdentity(state);
    const keyPackage = await api.E2eeWeb.createKeyPackage(state);
    const proof = await api.E2eeWeb.signDeviceBinding(keyPackage.state, encoder.encode(userId), encoder.encode(device.deviceId));
    await api.saveE2eeState(userId, "device", keyPackage.state);
    const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
    return {
      userId,
      deviceId: device.deviceId,
      identity: b64(member.identity),
      signatureKey: b64(member.signatureKey),
      signatureProof: b64(proof),
      keyPackage: b64(keyPackage.keyPackage),
    };
  }, userId);
  const devices = await Promise.all([
    prepareDevice(page, requester.user.id),
    prepareDevice(recipientPage, recipient.user.id),
  ]);

  for (const [index, user] of [requester, recipient].entries()) {
    const response = await request.post(`http://127.0.0.1:3000/api/v1/chats/${chatId}/crypto/key-packages`, {
      headers: auth(user.session.token),
      data: { ...devices[index], scope: "PARTICIPANT" },
    });
    expect(response.status(), await response.text()).toBe(200);
  }

  const claimedPackageResponse = await request.get(
    `http://127.0.0.1:3000/api/v1/chats/${chatId}/crypto/key-packages/${recipient.user.id}?deviceId=${encodeURIComponent(devices[0].deviceId)}`,
    { headers: auth(requester.session.token) },
  );
  expect(claimedPackageResponse.status(), await claimedPackageResponse.text()).toBe(200);
  const claimedPackage = (await claimedPackageResponse.json()).keyPackage;
  const welcome = await page.evaluate(async ({ requesterId, recipientId, chatId, peer }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
      getE2eeContext(userId: string, scope: string): Promise<Uint8Array>;
    };
    const bytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const requesterState = (await api.loadE2eeStateRecord(requesterId, "device"))!.state;
    const expectedIdentity = new TextEncoder().encode(`halochat:user:${recipientId}:device:${peer.deviceId}`);
    const peerIdentity = bytes(peer.identity);
    const peerSignatureKey = bytes(peer.signatureKey);
    if (String(peerIdentity) !== String(expectedIdentity) || !await api.E2eeWeb.verifyDeviceBinding(
      new TextEncoder().encode(recipientId),
      new TextEncoder().encode(peer.deviceId),
      peerIdentity,
      peerSignatureKey,
      bytes(peer.signatureProof),
    )) throw new Error("Recipient device proof failed verification");

    const context = await api.getE2eeContext(requesterId, chatId);
    const group = await api.E2eeWeb.createGroup(requesterState, new TextEncoder().encode(`halochat:chat:${chatId}`), context);
    const added = await api.E2eeWeb.addMember(group, bytes(peer.keyPackage), {
      identity: peerIdentity,
      signatureKey: peerSignatureKey,
    });
    await api.saveE2eeState(requesterId, chatId, added.state, {
      lastSeq: 0,
      pendingMessages: [],
      plaintextByMessageId: {},
    });
    return {
      ciphertext: btoa(String.fromCharCode(...added.welcome)),
      commit: btoa(String.fromCharCode(...added.commit)),
    };
  }, { requesterId: requester.user.id, recipientId: recipient.user.id, chatId, peer: claimedPackage });

  const welcomeClientMsgId = `web-welcome-${suffix}`;
  const welcomeResponse = await request.post(`http://127.0.0.1:3000/api/v1/chats/${chatId}/messages`, {
    headers: auth(requester.session.token),
    data: {
      clientMsgId: welcomeClientMsgId,
      ciphertext: welcome.ciphertext,
      encryptionMetadata: {
        protocol: "MLS",
        version: 1,
        kind: "welcome",
        keyPackageId: claimedPackage.keyPackageId,
        claimantDeviceId: devices[0].deviceId,
        commit: welcome.commit,
      },
    },
  });
  expect(welcomeResponse.status(), await welcomeResponse.text()).toBe(201);
  const welcomeMessage = (await welcomeResponse.json()).message;

  const recipientJoin = await recipientPage.evaluate(async ({ requesterId, recipientId, chatId, welcome, requesterDevice }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      initializeE2eeDevice(userId: string): Promise<{ deviceId: string }>;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
      getE2eeContext(userId: string, scope: string): Promise<Uint8Array>;
    };
    const ciphertext = Uint8Array.from(atob(welcome.ciphertext), (character) => character.charCodeAt(0));
    const deviceState = (await api.loadE2eeStateRecord(recipientId, "device"))!.state;
    const context = await api.getE2eeContext(recipientId, chatId);
    const group = await api.E2eeWeb.joinGroup(deviceState, ciphertext, context);
    const members = await api.E2eeWeb.groupMembers(group);
    const ownDevice = await api.initializeE2eeDevice(recipientId);
    const expected = [
      `halochat:user:${requesterId}:device:${requesterDevice}`,
      `halochat:user:${recipientId}:device:${ownDevice.deviceId}`,
    ].map((identity) => btoa(identity));
    const roster = members.map((member: { identity: Uint8Array }) => btoa(String.fromCharCode(...member.identity)));
    if (members.length !== 2 || expected.some((identity) => !roster.includes(identity))) {
      throw new Error("Joined MLS roster did not match the two expected chat devices");
    }
    await api.saveE2eeState(recipientId, chatId, group, {
      lastSeq: welcome.seq,
      pendingMessages: [],
      plaintextByMessageId: {},
    });
    return { roster };
  }, {
    requesterId: requester.user.id,
    recipientId: recipient.user.id,
    chatId,
    welcome: { ciphertext: welcome.ciphertext, seq: welcomeMessage.seq },
    requesterDevice: devices[0].deviceId,
  });
  expect(recipientJoin.roster).toHaveLength(2);

  const sent = await recipientPage.evaluate(async ({ recipientId, chatId, text }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
    };
    const record = await api.loadE2eeStateRecord(recipientId, chatId);
    const encrypted = await api.E2eeWeb.encryptApplication(record.state, new TextEncoder().encode(text));
    await api.saveE2eeState(recipientId, chatId, encrypted.state);
    return btoa(String.fromCharCode(...encrypted.message));
  }, { recipientId: recipient.user.id, chatId, text: "browser recipient to requester" });
  expect(sent).not.toContain("browser recipient to requester");

  const sentResponse = await request.post(`http://127.0.0.1:3000/api/v1/chats/${chatId}/messages`, {
    headers: auth(recipient.session.token),
    data: { ciphertext: sent, encryptionMetadata: { protocol: "MLS", version: 1, kind: "application" } },
  });
  expect(sentResponse.status(), await sentResponse.text()).toBe(201);
  const storedMessage = (await sentResponse.json()).message;
  expect(storedMessage.ciphertext).toBe(sent);
  expect(storedMessage.ciphertext).not.toContain("browser recipient to requester");

  const decrypted = await page.evaluate(async ({ requesterId, chatId, ciphertext }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
    };
    const record = await api.loadE2eeStateRecord(requesterId, chatId);
    const message = Uint8Array.from(atob(ciphertext), (character) => character.charCodeAt(0));
    const opened = await api.E2eeWeb.decryptApplication(record.state, message);
    await api.saveE2eeState(requesterId, chatId, opened.state);
    return new TextDecoder().decode(opened.message);
  }, { requesterId: requester.user.id, chatId, ciphertext: storedMessage.ciphertext });
  expect(decrypted).toBe("browser recipient to requester");
  await recipientPage.close();
});

test("protected messages are re-encrypted for the assigned Angel's private MLS group", async ({ browser, page, request }) => {
  const suffix = Date.now().toString();
  const signUp = async (prefix: string, sex: "MALE" | "FEMALE") => {
    const response = await request.post("http://127.0.0.1:3000/api/auth/sign-up/email", {
      data: {
        email: `${prefix}-${suffix}@example.com`,
        username: `${prefix}_${suffix.slice(-8)}`,
        displayName: prefix.toUpperCase(),
        password: "password123",
        dateOfBirth: "1995-01-01",
        sex,
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };
  const protectedUser = await signUp("pru", "FEMALE");
  const participant = await signUp("prp", "MALE");
  const angel = await signUp("pra", "MALE");
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const invitation = await request.post("http://127.0.0.1:3000/api/v1/me/angels", {
    headers: auth(protectedUser.session.token),
    data: { angelUserId: angel.user.id },
  });
  expect(invitation.status(), await invitation.text()).toBe(201);
  const assignmentId = (await invitation.json()).assignmentId;
  const acceptedAngel = await request.post(`http://127.0.0.1:3000/api/v1/angel/assignments/${assignmentId}/accept`, {
    headers: auth(angel.session.token),
  });
  expect(acceptedAngel.status(), await acceptedAngel.text()).toBe(200);
  const scope = await request.patch(`http://127.0.0.1:3000/api/v1/me/angels/${assignmentId}`, {
    headers: auth(protectedUser.session.token),
    data: { personConditions: ["OPPOSITE_SEX"], purposeCategories: [], applyToExisting: false },
  });
  expect(scope.status(), await scope.text()).toBe(200);

  const contact = await request.post("http://127.0.0.1:3000/api/v1/requests", {
    headers: auth(participant.session.token),
    data: { recipientId: protectedUser.user.id, purpose: "Social / personal" },
  });
  expect(contact.status(), await contact.text()).toBe(201);
  const requestId = (await contact.json()).requestId;
  const recipientAccepted = await request.post(`http://127.0.0.1:3000/api/v1/requests/${requestId}/accept`, {
    headers: auth(protectedUser.session.token),
  });
  expect(recipientAccepted.status(), await recipientAccepted.text()).toBe(200);
  const angelApproved = await request.post(`http://127.0.0.1:3000/api/v1/angel/requests/${requestId}/approve`, {
    headers: auth(angel.session.token),
  });
  expect(angelApproved.status(), await angelApproved.text()).toBe(200);
  const chatList = await request.get("http://127.0.0.1:3000/api/v1/chats", {
    headers: auth(protectedUser.session.token),
  });
  const chat = (await chatList.json()).chats[0];
  expect(chat.mode).toBe("PROTECTED");
  expect(chat.ownAngels).toHaveLength(1);
  const chatId = chat.id as string;
  const accessId = chat.ownAngelAccessPeriods[0].id as string;

  const participantPage = await browser.newPage();
  const angelPage = await browser.newPage();
  await Promise.all([
    installWebStoreHarness(page),
    installWebStoreHarness(participantPage),
    installWebStoreHarness(angelPage),
  ]);

  const participantDevices = await Promise.all([
    prepareWebDevice(page, protectedUser.user.id),
    prepareWebDevice(participantPage, participant.user.id),
  ]);
  for (const [index, user] of [protectedUser, participant].entries()) {
    const published = await request.post(`http://127.0.0.1:3000/api/v1/chats/${chatId}/crypto/key-packages`, {
      headers: auth(user.session.token),
      data: { ...participantDevices[index], scope: "PARTICIPANT" },
    });
    expect(published.status(), await published.text()).toBe(200);
  }

  const partnerPackageResponse = await request.get(
    `http://127.0.0.1:3000/api/v1/chats/${chatId}/crypto/key-packages/${participant.user.id}?deviceId=${encodeURIComponent(participantDevices[0].deviceId)}`,
    { headers: auth(protectedUser.session.token) },
  );
  expect(partnerPackageResponse.status(), await partnerPackageResponse.text()).toBe(200);
  const participantWelcome = await page.evaluate(async ({ protectedUserId, chatId, peer }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
      getE2eeContext(userId: string, scope: string): Promise<Uint8Array>;
    };
    const bytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
    const state = (await api.loadE2eeStateRecord(protectedUserId, "device"))!.state;
    const peerIdentity = bytes(peer.identity);
    if (!await api.E2eeWeb.verifyDeviceBinding(
      new TextEncoder().encode(peer.userId),
      new TextEncoder().encode(peer.deviceId),
      peerIdentity,
      bytes(peer.signatureKey),
      bytes(peer.signatureProof),
    )) throw new Error("Participant device proof failed verification");
    const context = await api.getE2eeContext(protectedUserId, chatId);
    const group = await api.E2eeWeb.createGroup(state, new TextEncoder().encode(`halochat:chat:${chatId}`), context);
    const added = await api.E2eeWeb.addMember(group, bytes(peer.keyPackage), {
      identity: peerIdentity,
      signatureKey: bytes(peer.signatureKey),
    });
    await api.saveE2eeState(protectedUserId, chatId, added.state, {
      lastSeq: 0,
      pendingMessages: [],
      plaintextByMessageId: {},
    });
    return { ciphertext: b64(added.welcome), commit: b64(added.commit) };
  }, { protectedUserId: protectedUser.user.id, chatId, peer: (await partnerPackageResponse.json()).keyPackage });

  const participantWelcomeId = `participant-welcome-${suffix}`;
  const participantWelcomeResponse = await request.post(`http://127.0.0.1:3000/api/v1/chats/${chatId}/messages`, {
    headers: auth(protectedUser.session.token),
    data: {
      clientMsgId: participantWelcomeId,
      ciphertext: participantWelcome.ciphertext,
      encryptionMetadata: {
        protocol: "MLS", version: 1, kind: "welcome",
        keyPackageId: (await partnerPackageResponse.json()).keyPackage.keyPackageId,
        claimantDeviceId: participantDevices[0].deviceId,
        commit: participantWelcome.commit,
      },
    },
  });
  expect(participantWelcomeResponse.status(), await participantWelcomeResponse.text()).toBe(201);
  const participantWelcomeMessage = (await participantWelcomeResponse.json()).message;
  const participantJoin = await participantPage.evaluate(async ({ protectedUserId, participantId, chatId, welcome, requesterDevice }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      initializeE2eeDevice(userId: string): Promise<{ deviceId: string }>;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
      getE2eeContext(userId: string, scope: string): Promise<Uint8Array>;
    };
    const bytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const deviceState = (await api.loadE2eeStateRecord(participantId, "device"))!.state;
    const context = await api.getE2eeContext(participantId, chatId);
    const group = await api.E2eeWeb.joinGroup(deviceState, bytes(welcome.ciphertext), context);
    const members = await api.E2eeWeb.groupMembers(group);
    const ownDevice = await api.initializeE2eeDevice(participantId);
    const expected = [
      `halochat:user:${protectedUserId}:device:${requesterDevice}`,
      `halochat:user:${participantId}:device:${ownDevice.deviceId}`,
    ].map((identity) => btoa(identity));
    const roster = members.map((member: { identity: Uint8Array }) => btoa(String.fromCharCode(...member.identity)));
    if (members.length !== 2 || expected.some((identity) => !roster.includes(identity))) {
      throw new Error("Participant MLS roster did not match the two conversation devices");
    }
    await api.saveE2eeState(participantId, chatId, group, {
      lastSeq: welcome.seq,
      pendingMessages: [],
      plaintextByMessageId: {},
    });
    return true;
  }, {
    protectedUserId: protectedUser.user.id,
    participantId: participant.user.id,
    chatId,
    welcome: { ciphertext: participantWelcomeMessage.ciphertext, seq: participantWelcomeMessage.seq },
    requesterDevice: participantDevices[0].deviceId,
  });
  expect(participantJoin).toBe(true);

  const whisperScope = `WHISPER:${protectedUser.user.id}:${angel.user.id}:${accessId}`;
  const whisperStateKey = `whisper:${chatId}:${angel.user.id}:${accessId}`;
  const whisperGroupId = `halochat:whisper:${chatId}:${protectedUser.user.id}:${angel.user.id}:${accessId}`;
  const whisperDevices = await Promise.all([
    prepareWebDevice(page, protectedUser.user.id),
    prepareWebDevice(angelPage, angel.user.id),
  ]);
  for (const [index, user] of [protectedUser, angel].entries()) {
    const published = await request.post(`http://127.0.0.1:3000/api/v1/chats/${chatId}/crypto/key-packages`, {
      headers: auth(user.session.token),
      data: { ...whisperDevices[index], scope: whisperScope },
    });
    expect(published.status(), await published.text()).toBe(200);
  }

  const protectedPackageResponse = await request.get(
    `http://127.0.0.1:3000/api/v1/chats/${chatId}/crypto/key-packages/${protectedUser.user.id}?deviceId=${encodeURIComponent(whisperDevices[1].deviceId)}&scope=${encodeURIComponent(whisperScope)}`,
    { headers: auth(angel.session.token) },
  );
  expect(protectedPackageResponse.status(), await protectedPackageResponse.text()).toBe(200);
  const whisperWelcome = await angelPage.evaluate(async ({ protectedUserId, angelId, chatId, stateKey, groupId, peer }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
      getE2eeContext(userId: string, scope: string): Promise<Uint8Array>;
    };
    const bytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
    const state = (await api.loadE2eeStateRecord(angelId, "device"))!.state;
    const peerIdentity = bytes(peer.identity);
    if (!await api.E2eeWeb.verifyDeviceBinding(
      new TextEncoder().encode(peer.userId),
      new TextEncoder().encode(peer.deviceId),
      peerIdentity,
      bytes(peer.signatureKey),
      bytes(peer.signatureProof),
    )) throw new Error("Protected user device proof failed verification");
    const context = await api.getE2eeContext(angelId, stateKey);
    const group = await api.E2eeWeb.createGroup(state, new TextEncoder().encode(groupId), context);
    const added = await api.E2eeWeb.addMember(group, bytes(peer.keyPackage), {
      identity: peerIdentity,
      signatureKey: bytes(peer.signatureKey),
    });
    const members = await api.E2eeWeb.groupMembers(added.state);
    const roster = members.map((member: { identity: Uint8Array }) => btoa(String.fromCharCode(...member.identity)));
    const expected = [
      `halochat:user:${protectedUserId}:device:${peer.deviceId}`,
      `halochat:user:${angelId}:device:${(await api.initializeE2eeDevice(angelId)).deviceId}`,
    ].map((identity) => btoa(identity));
    if (members.length !== 2 || expected.some((identity) => !roster.includes(identity))) {
      throw new Error("Private Angel MLS roster contains an unexpected device");
    }
    await api.saveE2eeState(angelId, stateKey, added.state, {
      lastSeq: 0,
      pendingMessages: [],
      plaintextByMessageId: {},
    });
    return { ciphertext: b64(added.welcome), commit: b64(added.commit), roster };
  }, {
    protectedUserId: protectedUser.user.id,
    angelId: angel.user.id,
    chatId,
    stateKey: whisperStateKey,
    groupId: whisperGroupId,
    peer: (await protectedPackageResponse.json()).keyPackage,
  });

  const whisperWelcomeId = `whisper-welcome-${suffix}`;
  const whisperWelcomeResponse = await request.post(`http://127.0.0.1:3000/api/v1/angel/chats/${chatId}/whispers`, {
    headers: auth(angel.session.token),
    data: {
      clientMsgId: whisperWelcomeId,
      ciphertext: whisperWelcome.ciphertext,
      encryptionMetadata: {
        protocol: "MLS", version: 1, kind: "whisper", mlsContentType: "welcome",
        accessId,
        keyPackageId: (await protectedPackageResponse.json()).keyPackage.keyPackageId,
        claimantDeviceId: whisperDevices[1].deviceId,
      },
      plaintextCharLength: 0,
    },
  });
  expect(whisperWelcomeResponse.status(), await whisperWelcomeResponse.text()).toBe(201);
  const inbox = await request.get(`http://127.0.0.1:3000/api/v1/chats/${chatId}/whispers`, {
    headers: auth(protectedUser.session.token),
  });
  expect(inbox.status(), await inbox.text()).toBe(200);
  const welcomeEnvelope = (await inbox.json()).whispers[0];
  const angelDevicesResponse = await request.get(
    `http://127.0.0.1:3000/api/v1/chats/${chatId}/crypto/devices/${angel.user.id}?scope=${encodeURIComponent(whisperScope)}`,
    { headers: auth(protectedUser.session.token) },
  );
  expect(angelDevicesResponse.status(), await angelDevicesResponse.text()).toBe(200);
  const angelDevices = (await angelDevicesResponse.json()).devices;
  const protectedWhisperJoin = await page.evaluate(async ({ protectedUserId, angelId, chatId, stateKey, envelope }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      initializeE2eeDevice(userId: string): Promise<{ deviceId: string }>;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
      getE2eeContext(userId: string, scope: string): Promise<Uint8Array>;
    };
    const bytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const state = (await api.loadE2eeStateRecord(protectedUserId, "device"))!.state;
    const context = await api.getE2eeContext(protectedUserId, stateKey);
    const group = await api.E2eeWeb.joinGroup(state, bytes(envelope.ciphertext), context);
    const members = await api.E2eeWeb.groupMembers(group);
    const identities = members.map((member: { identity: Uint8Array }) => btoa(String.fromCharCode(...member.identity)));
    const angelDevice = envelope.angelDevices.find((candidate: { deviceId: string }) => candidate.deviceId === envelope.angelDeviceId);
    if (!angelDevice || !await api.E2eeWeb.verifyDeviceBinding(
      new TextEncoder().encode(angelId),
      new TextEncoder().encode(angelDevice.deviceId),
      bytes(angelDevice.identity),
      bytes(angelDevice.signatureKey),
      bytes(angelDevice.signatureProof),
    )) throw new Error("Angel device proof failed verification");
    const expected = [
      `halochat:user:${protectedUserId}:device:${(await api.initializeE2eeDevice(protectedUserId)).deviceId}`,
      `halochat:user:${angelId}:device:${angelDevice.deviceId}`,
    ].map((identity) => btoa(identity));
    if (members.length !== 2 || expected.some((identity) => !identities.includes(identity))) {
      throw new Error("Protected user joined an unexpected Angel Whisper roster");
    }
    await api.saveE2eeState(protectedUserId, stateKey, group, {
      lastSeq: 0,
      pendingMessages: [],
      plaintextByMessageId: {},
    });
    return identities;
  }, {
    protectedUserId: protectedUser.user.id,
    angelId: angel.user.id,
    chatId,
    stateKey: whisperStateKey,
    envelope: {
      ciphertext: welcomeEnvelope.ciphertext,
      angelDeviceId: whisperDevices[1].deviceId,
      angelDevices,
    },
  });
  expect(protectedWhisperJoin).toHaveLength(2);
  expect(whisperWelcome.roster).not.toContain(participantDevices[1].identity);

  const participantMessage = await participantPage.evaluate(async ({ participantId, chatId, text }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
    };
    const record = await api.loadE2eeStateRecord(participantId, chatId);
    const encrypted = await api.E2eeWeb.encryptApplication(record.state, new TextEncoder().encode(text));
    await api.saveE2eeState(participantId, chatId, encrypted.state);
    return btoa(String.fromCharCode(...encrypted.message));
  }, { participantId: participant.user.id, chatId, text: "participant-only source plaintext" });
  const sourceResponse = await request.post(`http://127.0.0.1:3000/api/v1/chats/${chatId}/messages`, {
    headers: auth(participant.session.token),
    data: { ciphertext: participantMessage, encryptionMetadata: { protocol: "MLS", version: 1, kind: "application" } },
  });
  expect(sourceResponse.status(), await sourceResponse.text()).toBe(201);
  const source = (await sourceResponse.json()).message;
  const received = await page.evaluate(async ({ protectedUserId, chatId, source }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
    };
    const record = await api.loadE2eeStateRecord(protectedUserId, chatId);
    const ciphertext = Uint8Array.from(atob(source.ciphertext), (character) => character.charCodeAt(0));
    const decrypted = await api.E2eeWeb.decryptApplication(record.state, ciphertext);
    await api.saveE2eeState(protectedUserId, chatId, decrypted.state);
    return new TextDecoder().decode(decrypted.message);
  }, { protectedUserId: protectedUser.user.id, chatId, source });
  expect(received).toBe("participant-only source plaintext");

  const forwardedCiphertext = await page.evaluate(async ({ protectedUserId, chatId, stateKey, source, plaintext }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
    };
    const record = await api.loadE2eeStateRecord(protectedUserId, stateKey);
    const payload = JSON.stringify({
      senderId: source.senderId,
      sourceMessageId: source.id,
      sourceSeq: source.seq,
      createdAt: source.createdAt,
      plaintext,
    });
    const encrypted = await api.E2eeWeb.encryptApplication(record.state, new TextEncoder().encode(payload));
    await api.saveE2eeState(protectedUserId, stateKey, encrypted.state);
    return btoa(String.fromCharCode(...encrypted.message));
  }, { protectedUserId: protectedUser.user.id, chatId, stateKey: whisperStateKey, source, plaintext: received });
  const forwarded = await request.post(`http://127.0.0.1:3000/api/v1/chats/${chatId}/angel-messages`, {
    headers: auth(protectedUser.session.token),
    data: {
      clientMsgId: `angel-forward-${suffix}`,
      accessId,
      sourceMessageId: source.id,
      sourceSeq: source.seq,
      ciphertext: forwardedCiphertext,
      encryptionMetadata: {
        protocol: "MLS", version: 1, kind: "whisper", mlsContentType: "application", accessId,
      },
    },
  });
  expect(forwarded.status(), await forwarded.text()).toBe(201);

  const timelineResponse = await request.get(`http://127.0.0.1:3000/api/v1/angel/chats/${chatId}/messages`, {
    headers: auth(angel.session.token),
  });
  expect(timelineResponse.status(), await timelineResponse.text()).toBe(200);
  const timeline = (await timelineResponse.json()).timeline;
  const copy = timeline.find((item: { sourceMessageId?: string }) => item.sourceMessageId === source.id);
  expect(copy).toBeTruthy();
  expect(copy.ciphertext).toBe(forwardedCiphertext);
  const angelPlaintext = await angelPage.evaluate(async ({ angelId, stateKey, ciphertext }) => {
    const api = window as typeof window & {
      E2eeWeb: any;
      loadE2eeStateRecord(userId: string, scope: string): Promise<any>;
      saveE2eeState(userId: string, scope: string, state: any, localData?: any): Promise<void>;
    };
    const record = await api.loadE2eeStateRecord(angelId, stateKey);
    const opened = await api.E2eeWeb.decryptApplication(
      record.state,
      Uint8Array.from(atob(ciphertext), (character) => character.charCodeAt(0)),
    );
    await api.saveE2eeState(angelId, stateKey, opened.state);
    return JSON.parse(new TextDecoder().decode(opened.message));
  }, { angelId: angel.user.id, stateKey: whisperStateKey, ciphertext: copy.ciphertext });
  expect(angelPlaintext).toMatchObject({
    senderId: participant.user.id,
    sourceMessageId: source.id,
    sourceSeq: source.seq,
    plaintext: "participant-only source plaintext",
  });

  const participantAngelView = await request.get(`http://127.0.0.1:3000/api/v1/angel/chats/${chatId}/messages`, {
    headers: auth(participant.session.token),
  });
  expect(participantAngelView.status()).toBe(403);
  await Promise.all([participantPage.close(), angelPage.close()]);
});
