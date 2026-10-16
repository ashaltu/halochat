import { expect, test } from "@playwright/test";

test("two users can establish a comfort chat and exchange a message", async ({ request }) => {
  const suffix = Date.now().toString().slice(-10);
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
    expect(response.status()).toBe(201);
    return response.json();
  };

  const requester = await signUp("e2ea", "MALE");
  const recipient = await signUp("e2eb", "FEMALE");
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const contactResponse = await request.post("http://127.0.0.1:3000/api/v1/requests", {
    headers: auth(requester.session.token),
    data: { recipientId: recipient.user.id, purpose: "Social / personal" },
  });
  expect(contactResponse.status()).toBe(201);
  const contact = await contactResponse.json();

  const acceptResponse = await request.post(
    `http://127.0.0.1:3000/api/v1/requests/${contact.requestId}/accept`,
    { headers: auth(recipient.session.token) }
  );
  expect(acceptResponse.status()).toBe(200);

  const chatsResponse = await request.get("http://127.0.0.1:3000/api/v1/chats", {
    headers: auth(requester.session.token),
  });
  const chats = await chatsResponse.json();
  expect(chats.chats).toHaveLength(1);
  expect(chats.chats[0].mode).toBe("COMFORT");

  const messageResponse = await request.post(
    `http://127.0.0.1:3000/api/v1/chats/${chats.chats[0].id}/messages`,
    {
      headers: auth(requester.session.token),
      data: { ciphertext: "e2e transport test" },
    }
  );
  expect(messageResponse.status()).toBe(201);
  expect((await messageResponse.json()).message.seq).toBe(1);
});
