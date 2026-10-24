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
