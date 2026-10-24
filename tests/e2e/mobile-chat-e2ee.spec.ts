import { expect, test } from "@playwright/test";

test("Expo web chat establishes MLS and exchanges encrypted messages between signed-in users", async ({ browser, request }) => {
  test.setTimeout(90_000);
  const suffix = Date.now();
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

  const alice = await signUp("mwa", "MALE");
  const bob = await signUp("mwb", "FEMALE");
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  for (const user of [alice, bob]) {
    const onboarding = await request.patch("http://127.0.0.1:3000/api/v1/me", {
      headers: auth(user.session.token),
      data: { onboardingCompleted: true },
    });
    expect(onboarding.status(), await onboarding.text()).toBe(200);
  }

  const contact = await request.post("http://127.0.0.1:3000/api/v1/requests", {
    headers: auth(alice.session.token),
    data: { recipientId: bob.user.id, purpose: "Social / personal" },
  });
  expect(contact.status(), await contact.text()).toBe(201);
  const { requestId } = await contact.json();
  const accepted = await request.post(`http://127.0.0.1:3000/api/v1/requests/${requestId}/accept`, {
    headers: auth(bob.session.token),
  });
  expect(accepted.status(), await accepted.text()).toBe(200);
  const chatResponse = await request.get("http://127.0.0.1:3000/api/v1/chats", {
    headers: auth(alice.session.token),
  });
  const { chats } = await chatResponse.json();
  expect(chats).toHaveLength(1);
  const chatId = chats[0].id as string;

  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alicePage = await aliceContext.newPage();
  const bobPage = await bobContext.newPage();
  const signIn = async (page: typeof alicePage, username: string, partnerId: string) => {
    await page.goto("http://localhost:8081", { waitUntil: "domcontentloaded", timeout: 20_000 });
    const usernameInput = page.getByPlaceholder("e.g. sara or sara@example.com");
    try {
      await expect(usernameInput).toBeVisible({ timeout: 15_000 });
    } catch {
      throw new Error(`Expo app did not render sign-in: ${await page.locator("body").innerText()}`);
    }
    await usernameInput.fill(username);
    await page.getByPlaceholder("Enter your password").fill("password123");
    await page.getByText("Sign In", { exact: true }).click();
    await expect(page.getByText(`@${username}`)).toBeVisible({ timeout: 20_000 });
    await page.getByText(`Conversation with ${partnerId.substring(0, 8)}...`).click();
    await expect(page.getByPlaceholder("Type a message...")).toBeVisible({ timeout: 20_000 });
  };

  await signIn(alicePage, alice.user.username, bob.user.id);
  await expect(alicePage.getByText("Setting up encrypted messaging…")).toBeVisible();
  await signIn(bobPage, bob.user.username, alice.user.id);
  await expect(alicePage.getByText("Setting up encrypted messaging…")).toBeHidden({ timeout: 60_000 });
  await expect(bobPage.getByText("Setting up encrypted messaging…")).toBeHidden({ timeout: 60_000 });
  const aliceComposer = alicePage.getByPlaceholder("Type a message...");
  const bobComposer = bobPage.getByPlaceholder("Type a message...");
  await expect(aliceComposer).toBeEnabled({ timeout: 30_000 });
  await expect(bobComposer).toBeEnabled({ timeout: 30_000 });
  const plaintext = `app MLS message ${suffix}`;
  await aliceComposer.fill(plaintext);
  const sendResponsePromise = alicePage.waitForResponse((response) =>
    response.url() === `http://localhost:3000/api/v1/chats/${chatId}/messages` && response.request().method() === "POST",
  );
  await alicePage.getByText("Send", { exact: true }).click();
  const sendResponse = await sendResponsePromise;
  expect(sendResponse.status(), await sendResponse.text()).toBe(201);
  const sentMessage = await sendResponse.json();
  expect(sentMessage.message.encryptionMetadata).toMatchObject({ protocol: "MLS", kind: "application" });
  const messages = await request.get(`http://127.0.0.1:3000/api/v1/chats/${chatId}/messages`, {
    headers: auth(alice.session.token),
  });
  expect(messages.status(), await messages.text()).toBe(200);
  const { messages: stored } = await messages.json();
  expect(stored.length).toBeGreaterThan(0);
  expect(stored.some((message: { encryptionMetadata?: { protocol?: string; kind?: string } }) =>
    message.encryptionMetadata?.protocol === "MLS" && message.encryptionMetadata.kind === "application",
  )).toBe(true);
  await expect(bobPage.getByText(plaintext)).toBeVisible({ timeout: 20_000 });
  expect(stored.some((message: { ciphertext: string }) => message.ciphertext.includes(plaintext))).toBe(false);
});
