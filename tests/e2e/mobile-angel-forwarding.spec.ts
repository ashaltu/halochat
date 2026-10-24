import { expect, test } from "@playwright/test";

test("Expo web app forwards a protected chat message into the assigned Angel's encrypted timeline", async ({ browser, request }) => {
  test.setTimeout(150_000);
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
  const protectedUser = await signUp("mep", "FEMALE");
  const participant = await signUp("mec", "MALE");
  const angel = await signUp("mea", "MALE");
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  for (const user of [protectedUser, participant, angel]) {
    const response = await request.patch("http://127.0.0.1:3000/api/v1/me", {
      headers: auth(user.session.token),
      data: { onboardingCompleted: true },
    });
    expect(response.status(), await response.text()).toBe(200);
  }

  const invitation = await request.post("http://127.0.0.1:3000/api/v1/me/angels", {
    headers: auth(protectedUser.session.token),
    data: { angelUserId: angel.user.id },
  });
  expect(invitation.status(), await invitation.text()).toBe(201);
  const { assignmentId } = await invitation.json();
  const acceptedAssignment = await request.post(`http://127.0.0.1:3000/api/v1/angel/assignments/${assignmentId}/accept`, {
    headers: auth(angel.session.token),
  });
  expect(acceptedAssignment.status(), await acceptedAssignment.text()).toBe(200);
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
  const { requestId } = await contact.json();
  const acceptedContact = await request.post(`http://127.0.0.1:3000/api/v1/requests/${requestId}/accept`, {
    headers: auth(protectedUser.session.token),
  });
  expect(acceptedContact.status(), await acceptedContact.text()).toBe(200);
  const approvedContact = await request.post(`http://127.0.0.1:3000/api/v1/angel/requests/${requestId}/approve`, {
    headers: auth(angel.session.token),
  });
  expect(approvedContact.status(), await approvedContact.text()).toBe(200);

  const chatsResponse = await request.get("http://127.0.0.1:3000/api/v1/chats", {
    headers: auth(protectedUser.session.token),
  });
  const { chats } = await chatsResponse.json();
  expect(chats).toHaveLength(1);
  expect(chats[0].mode).toBe("PROTECTED");
  expect(chats[0].ownAngels).toHaveLength(1);
  const chatId = chats[0].id as string;

  const protectedContext = await browser.newContext();
  const participantContext = await browser.newContext();
  const angelContext = await browser.newContext();
  const protectedPage = await protectedContext.newPage();
  const participantPage = await participantContext.newPage();
  const angelPage = await angelContext.newPage();
  const openChat = async (page: typeof protectedPage, user: any, partnerId: string) => {
    await page.goto("http://localhost:8081", { waitUntil: "domcontentloaded", timeout: 20_000 });
    const usernameInput = page.getByPlaceholder("e.g. sara or sara@example.com");
    try {
      await expect(usernameInput).toBeVisible({ timeout: 15_000 });
    } catch {
      throw new Error(`Expo app did not render sign-in: ${await page.locator("body").innerText()}`);
    }
    await usernameInput.fill(user.user.username);
    await page.getByPlaceholder("Enter your password").fill("password123");
    await page.getByText("Sign In", { exact: true }).click();
    await expect(page.getByText(`@${user.user.username}`)).toBeVisible({ timeout: 20_000 });
    await page.getByText(`Conversation with ${partnerId.substring(0, 8)}...`).click();
    await expect(page.getByPlaceholder("Type a message...")).toBeVisible({ timeout: 20_000 });
  };

  await openChat(protectedPage, protectedUser, participant.user.id);
  await expect(protectedPage.getByText("Setting up encrypted messaging…")).toBeVisible();
  await openChat(participantPage, participant, protectedUser.user.id);
  await expect(protectedPage.getByText("Setting up encrypted messaging…")).toBeHidden({ timeout: 60_000 });
  await expect(participantPage.getByText("Setting up encrypted messaging…")).toBeHidden({ timeout: 60_000 });

  await angelPage.goto("http://localhost:8081", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await angelPage.getByPlaceholder("e.g. sara or sara@example.com").fill(angel.user.username);
  await angelPage.getByPlaceholder("Enter your password").fill("password123");
  await angelPage.getByText("Sign In", { exact: true }).click();
  await expect(angelPage.getByText(`@${angel.user.username}`)).toBeVisible({ timeout: 20_000 });
  await angelPage.getByText("Angel Tab", { exact: true }).click();
  await expect(angelPage.getByText("Active Protected Chats (1)")).toBeVisible({ timeout: 20_000 });

  const plaintext = `protected app message ${suffix}`;
  await participantPage.getByPlaceholder("Type a message...").fill(plaintext);
  const sendResponsePromise = participantPage.waitForResponse((response) =>
    response.url() === `http://localhost:3000/api/v1/chats/${chatId}/messages` && response.request().method() === "POST",
  );
  await participantPage.getByText("Send", { exact: true }).click();
  const sendResponse = await sendResponsePromise;
  expect(sendResponse.status(), await sendResponse.text()).toBe(201);
  const sentMessage = await sendResponse.json();
  expect(sentMessage.message.encryptionMetadata).toMatchObject({ protocol: "MLS", kind: "application" });
  await expect(protectedPage.getByText(plaintext)).toBeVisible({ timeout: 20_000 });
  await expect(angelPage.getByText(plaintext)).toBeVisible({ timeout: 60_000 });

  const angelTimeline = await request.get(`http://127.0.0.1:3000/api/v1/angel/chats/${chatId}/messages`, {
    headers: auth(angel.session.token),
  });
  expect(angelTimeline.status(), await angelTimeline.text()).toBe(200);
  const { timeline } = await angelTimeline.json();
  expect(timeline.some((message: { sourceMessageId?: string; encryptionMetadata?: { kind?: string } }) =>
    message.sourceMessageId === sentMessage.message.id && message.encryptionMetadata?.kind === "whisper",
  )).toBe(true);
  expect(JSON.stringify(timeline)).not.toContain(plaintext);

  const participantTimeline = await request.get(`http://127.0.0.1:3000/api/v1/angel/chats/${chatId}/messages`, {
    headers: auth(participant.session.token),
  });
  expect(participantTimeline.status()).toBe(403);
  await Promise.all([protectedContext.close(), participantContext.close(), angelContext.close()]);
});
