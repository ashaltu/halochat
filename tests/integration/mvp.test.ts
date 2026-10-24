import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createApp } from "../../apps/server/src/app.js";
import { chatAngelAccess, closeDb, eq, getDb, initDbSchema, messages, users } from "@halochat/db";
import {
  ApprovalThreshold,
  ChatMode,
  ContactRequestState,
  isAtLeast13,
  PersonCondition,
  computeProfileCorrectionImpact,
  filterMessagesForAngel,
  ProfileCorrectionField,
  Sex,
} from "@halochat/shared";

function createDeviceBinding(accountId: string, deviceId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signatureKey = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const identity = Buffer.from(`halochat:user:${accountId}:device:${deviceId}`);
  const fields = [Buffer.from(accountId), Buffer.from(deviceId), identity, signatureKey];
  const message = Buffer.concat([
    Buffer.from("halochat:device-binding:v1"),
    ...fields.flatMap((field) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(field.length);
      return [length, field];
    }),
  ]);
  return {
    deviceId,
    identity: identity.toString("base64"),
    signatureKey: signatureKey.toString("base64"),
    signatureProof: sign(null, message, privateKey).toString("base64"),
  };
}

describe("HaloChat MVP Integration Tests", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const db = await getDb();
    await initDbSchema(db);
    app = createApp();
  });

  afterAll(async () => {
    await closeDb();
  });

  // Helper for app requests
  async function api(path: string, options: { method?: string; body?: any; token?: string } = {}) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.token) {
      headers["Authorization"] = `Bearer ${options.token}`;
    }

    const res = await app.request(path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  }

  function opaqueTransportFixture(label: string, kind: "application" | "whisper" = "application") {
    return {
      ciphertext: createHash("sha256").update(`test-only:${label}`).digest("base64"),
      encryptionMetadata: { protocol: "MLS", version: 1, kind },
    };
  }

  let adminToken: string;
  let aishaToken: string;
  let aishaId: string;
  let omarToken: string;
  let omarId: string;
  let fatimaToken: string;
  let fatimaId: string;
  let saraToken: string;
  let saraId: string;
  let fatimaAssignmentId: string;
  let saraAssignmentId: string;

  describe("1. User Registration & Auth (D2, D16)", () => {
    it("rejects under-13 registration", async () => {
      const res = await api("/api/auth/sign-up/email", {
        method: "POST",
        body: {
          email: "kid@example.com",
          username: "young_kid",
          displayName: "Young Kid",
          password: "password123",
          dateOfBirth: "2018-05-10", // < 13 years old
          sex: "FEMALE",
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("registers admin user", async () => {
      const res = await api("/api/auth/sign-up/email", {
        method: "POST",
        body: {
          email: "admin@halochat.app",
          username: "superadmin",
          displayName: "Super Admin",
          password: "adminpassword123",
          dateOfBirth: "1995-01-01",
          sex: "FEMALE",
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe("admin");
      adminToken = res.body.session.token;
    });

    it("registers Aisha (13+, female)", async () => {
      const res = await api("/api/auth/sign-up/email", {
        method: "POST",
        body: {
          email: "aisha@example.com",
          username: "aisha_m",
          displayName: "Aisha",
          password: "password123",
          dateOfBirth: "2002-06-15",
          sex: "FEMALE",
        },
      });

      expect(res.status).toBe(201);
      aishaToken = res.body.session.token;
      aishaId = res.body.user.id;
    });

    it("registers Omar (13+, male)", async () => {
      const res = await api("/api/auth/sign-up/email", {
        method: "POST",
        body: {
          email: "omar@example.com",
          username: "omar_k",
          displayName: "Omar",
          password: "password123",
          dateOfBirth: "2000-03-20",
          sex: "MALE",
        },
      });

      expect(res.status).toBe(201);
      omarToken = res.body.session.token;
      omarId = res.body.user.id;
    });

    it("registers Fatima (Angel 1)", async () => {
      const res = await api("/api/auth/sign-up/email", {
        method: "POST",
        body: {
          email: "fatima@example.com",
          username: "fatima_angel",
          displayName: "Fatima",
          password: "password123",
          dateOfBirth: "1998-11-10",
          sex: "FEMALE",
        },
      });

      expect(res.status).toBe(201);
      fatimaToken = res.body.session.token;
      fatimaId = res.body.user.id;
    });

    it("registers Sara (Angel 2)", async () => {
      const res = await api("/api/auth/sign-up/email", {
        method: "POST",
        body: {
          email: "sara@example.com",
          username: "sara_business",
          displayName: "Sara",
          password: "password123",
          dateOfBirth: "1997-04-05",
          sex: "FEMALE",
        },
      });

      expect(res.status).toBe(201);
      saraToken = res.body.session.token;
      saraId = res.body.user.id;
    });

    it("signs in through Better Auth with a username", async () => {
      const res = await api("/api/auth/sign-in/email", {
        method: "POST",
        body: { emailOrUsername: "aisha_m", password: "password123" },
      });

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(aishaId);
      expect(res.body.session.token).toBeTruthy();
      aishaToken = res.body.session.token;
    });
  });

  describe("2. Angel Assignment & Scope Configuration (D1, D8, D12)", () => {
    it("Aisha invites Fatima as Angel (status PENDING)", async () => {
      const res = await api("/api/v1/me/angels", {
        method: "POST",
        token: aishaToken,
        body: { angelUserId: fatimaId },
      });

      expect(res.status).toBe(201);
      fatimaAssignmentId = res.body.assignmentId;
    });

    it("Fatima accepts invitation via Angel dashboard (D1)", async () => {
      const res = await api(`/api/v1/angel/assignments/${fatimaAssignmentId}/accept`, {
        method: "POST",
        token: fatimaToken,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("Aisha invites Sara as Angel, Sara accepts", async () => {
      const inviteRes = await api("/api/v1/me/angels", {
        method: "POST",
        token: aishaToken,
        body: { angelUserId: saraId },
      });
      saraAssignmentId = inviteRes.body.assignmentId;

      const acceptRes = await api(`/api/v1/angel/assignments/${saraAssignmentId}/accept`, {
        method: "POST",
        token: saraToken,
      });
      expect(acceptRes.status).toBe(200);
    });

    it("Aisha configures scopes: Fatima protects OPPOSITE_SEX, Sara protects 'Business inquiry'", async () => {
      // Fatima: OPPOSITE_SEX
      const res1 = await api(`/api/v1/me/angels/${fatimaAssignmentId}`, {
        method: "PATCH",
        token: aishaToken,
        body: {
          personConditions: ["OPPOSITE_SEX"],
          purposeCategories: [],
          applyToExisting: false,
        },
      });
      expect(res1.status).toBe(200);

      // Sara: Business inquiry
      const res2 = await api(`/api/v1/me/angels/${saraAssignmentId}`, {
        method: "PATCH",
        token: aishaToken,
        body: {
          personConditions: [],
          purposeCategories: ["Business inquiry"],
          applyToExisting: false,
        },
      });
      expect(res2.status).toBe(200);
    });
  });

  describe("3. Contact Request Routing, Multi-Angel Matching & Approvals (D12, D15, §8.3)", () => {
    let requestId: string;
    let chatId: string;

    it("Omar sends contact request to Aisha with purpose 'Business inquiry'", async () => {
      const res = await api("/api/v1/requests", {
        method: "POST",
        token: omarToken,
        body: {
          recipientId: aishaId,
          purpose: "Business inquiry",
        },
      });

      expect(res.status).toBe(201);
      requestId = res.body.requestId;
    });

    it("Recipient Aisha decides first: accepts request", async () => {
      // Both Fatima (OPPOSITE_SEX) and Sara (Business inquiry) matched!
      const res = await api(`/api/v1/requests/${requestId}/accept`, {
        method: "POST",
        token: aishaToken,
      });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe("PENDING_ANGEL");
    });

    it("Requester Omar's outbox view is sanitized (D10, §5.1)", async () => {
      const res = await api("/api/v1/requests?box=outbox", {
        token: omarToken,
      });

      expect(res.status).toBe(200);
      const req = res.body.requests[0]?.request;
      expect(req.state).toBe("PENDING"); // Omar sees only generic PENDING
      expect(req.recipientAngels).toBeUndefined(); // No Angel identities disclosed!
    });

    it("Fatima approves request on Aisha's side (default ANY_ONE threshold met -> opens chat!)", async () => {
      const res = await api(`/api/v1/angel/requests/${requestId}/approve`, {
        method: "POST",
        token: fatimaToken,
      });

      expect(res.status).toBe(200);

      // Chat should now be created!
      const chatsRes = await api("/api/v1/chats", { token: aishaToken });
      expect(chatsRes.body.chats.length).toBe(1);
      const chat = chatsRes.body.chats[0];
      expect(chat.mode).toBe("PROTECTED");
      expect(chat.status).toBe("ACTIVE");
      chatId = chat.id;
    });

    it("Privacy check: Omar sees Protected mode but cannot see Aisha's Angels (D8, §5.1)", async () => {
      const res = await api(`/api/v1/chats/${chatId}`, { token: omarToken });
      expect(res.status).toBe(200);
      const chat = res.body.chat;
      expect(chat.mode).toBe("PROTECTED");
      expect(chat.ownAngels.length).toBe(0); // Omar has no Angels
      // Omar must not receive Fatima or Sara's names or counts
    });

    it("previews existing chats that would lose Angel access", async () => {
      const res = await api(`/api/v1/me/angels/${fatimaAssignmentId}/scope-preview`, {
        method: "POST",
        token: aishaToken,
        body: {
          personConditions: [],
          purposeCategories: [],
          applyToExisting: true,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.impacts).toContainEqual(
        expect.objectContaining({ chatId, effect: "LOSE" })
      );
    });
  });

  describe("4. Chat Messaging & Monotonic Sequence (D11, §8.4)", () => {
    let chatId: string;
    let claimedPackageId: string;

    beforeAll(async () => {
      const res = await api("/api/v1/chats", { token: aishaToken });
      chatId = res.body.chats[0].id;
    });

    describe("participant KeyPackage delivery", () => {
      const omarDeviceId = "device_omar_0123456789";
      const aishaDeviceId = "device_aisha_01234567";
      let omarBinding: ReturnType<typeof createDeviceBinding>;
      let aishaBinding: ReturnType<typeof createDeviceBinding>;
      const keyPackage = Buffer.alloc(64, 9).toString("base64");

      beforeAll(() => {
        omarBinding = createDeviceBinding(omarId, omarDeviceId);
        aishaBinding = createDeviceBinding(aishaId, aishaDeviceId);
      });

      it("binds published KeyPackages to the authenticated device identity", async () => {
        const res = await api(`/api/v1/chats/${chatId}/crypto/key-packages`, {
          method: "POST",
          token: omarToken,
          body: {
            ...omarBinding,
            keyPackage,
          },
        });
        expect(res.status).toBe(200);

        const mismatch = await api(`/api/v1/chats/${chatId}/crypto/key-packages`, {
          method: "POST",
          token: omarToken,
          body: {
            ...omarBinding,
            identity: Buffer.from("halochat:user:someone-else:device:device_omar_0123456789").toString("base64"),
            keyPackage,
          },
        });
        expect(mismatch.status).toBe(400);
        expect(mismatch.body.code).toBe("INVALID_DEVICE_IDENTITY");

        const invalidProof = await api(`/api/v1/chats/${chatId}/crypto/key-packages`, {
          method: "POST",
          token: omarToken,
          body: { ...omarBinding, signatureProof: Buffer.alloc(64, 1).toString("base64"), keyPackage },
        });
        expect(invalidProof.status).toBe(400);
        expect(invalidProof.body.code).toBe("INVALID_DEVICE_BINDING");
      });

      it("allows only one peer device to claim a KeyPackage and keeps same-device retries recoverable", async () => {
        const published = await api(`/api/v1/chats/${chatId}/crypto/key-packages`, {
          method: "POST",
          token: aishaToken,
          body: {
            ...aishaBinding,
            keyPackage,
          },
        });
        expect(published.status).toBe(200);

        const selfFetch = await api(`/api/v1/chats/${chatId}/crypto/key-packages/${omarId}`, {
          token: omarToken,
        });
        expect(selfFetch.status).toBe(404);

        const claims = await Promise.all([
          api(`/api/v1/chats/${chatId}/crypto/key-packages/${aishaId}?deviceId=${omarDeviceId}`, { token: omarToken }),
          api(`/api/v1/chats/${chatId}/crypto/key-packages/${aishaId}?deviceId=${omarDeviceId}`, { token: omarToken }),
        ]);
        expect(claims.map((claim) => claim.status)).toEqual([200, 200]);
        const claimed = claims[0];
        claimedPackageId = claimed.body.keyPackage.keyPackageId;
        expect(claimed.body.keyPackage).toMatchObject({
          userId: aishaId,
          deviceId: aishaDeviceId,
          signatureKey: aishaBinding.signatureKey,
        signatureProof: aishaBinding.signatureProof,
          keyPackage,
        });
        const rejected = await api(`/api/v1/chats/${chatId}/crypto/key-packages/${aishaId}?deviceId=device_other_0123456789`, { token: omarToken });
        expect(rejected.status).toBe(409);
        expect(rejected.body.code).toBe("KEY_PACKAGE_UNAVAILABLE");
      });

      it("does not disclose packages to non-participants", async () => {
        const res = await api(`/api/v1/chats/${chatId}/crypto/key-packages/${aishaId}`, {
          token: fatimaToken,
        });
        expect(res.status).toBe(404);
      });
    });

    it("rejects unencoded message values without the required MLS envelope shape", async () => {
      const res = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: omarToken,
        body: { ciphertext: "this is plaintext" },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("Omar sends message -> seq 1", async () => {
      const body = {
        ...opaqueTransportFixture("hello-aisha"),
        clientMsgId: `${chatId}-omar-seq1`,
      };
      const res = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: omarToken,
        body,
      });

      expect(res.status).toBe(201);
      expect(res.body.message.seq).toBe(1);
      const db = await getDb();
      const [storedMessage] = await db.select().from(messages).where(eq(messages.clientMsgId, body.clientMsgId));
      expect(storedMessage.ciphertext).toBe(body.ciphertext);
      expect(storedMessage.chatId).toBe(chatId);
      expect(storedMessage.senderId).toBe(omarId);
      expect(storedMessage.encryptionMetadata).toEqual(body.encryptionMetadata);

      const retry = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: omarToken,
        body,
      });
      expect(retry.body.code).not.toBe("CLIENT_MESSAGE_ID_REUSED");
      expect(retry.status).toBe(200);
      expect(retry.body.message.id).toBe(res.body.message.id);

      const reusedId = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: omarToken,
        body: { ...body, ...opaqueTransportFixture("different-ciphertext") },
      });
      expect(reusedId.status).toBe(409);
      expect(reusedId.body.code).toBe("CLIENT_MESSAGE_ID_REUSED");
    });

    it("Aisha replies -> seq 2", async () => {
      const res = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: aishaToken,
        body: opaqueTransportFixture("aisha-reply"),
      });

      expect(res.status).toBe(201);
      expect(res.body.message.seq).toBe(2);
    });

    it("consumes the claimed KeyPackage with its durable Welcome idempotency key", async () => {
      const body = {
        ...opaqueTransportFixture("mls-welcome"),
        clientMsgId: `${chatId}-welcome`,
        encryptionMetadata: {
          protocol: "MLS",
          version: 1,
          kind: "welcome",
          keyPackageId: claimedPackageId,
          claimantDeviceId: "device_omar_0123456789",
        },
      };
      const sent = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: omarToken,
        body,
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);

      const retry = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: omarToken,
        body,
      });
      expect(retry.status).toBe(200);
      expect(retry.body.message.id).toBe(sent.body.message.id);

      const reused = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: omarToken,
        body: { ...body, clientMsgId: `${chatId}-welcome-replay` },
      });
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe("KEY_PACKAGE_CLAIM_INVALID");
    });
  });

  describe("5. Angel Protective Controls: Whisper & Send Restriction (D13, §8.5)", () => {
    let chatId: string;
    let accessId: string;
    let scope: string;

    beforeAll(async () => {
      const res = await api("/api/v1/chats", { token: aishaToken });
      chatId = res.body.chats[0].id;
      const detail = await api(`/api/v1/chats/${chatId}`, { token: aishaToken });
      accessId = detail.body.chat.ownAngels.find((item: { angelUserId: string }) => item.angelUserId === fatimaId).id;
      scope = `WHISPER:${aishaId}:${fatimaId}:${accessId}`;
    });

    it("scopes Whisper KeyPackages to the protected user and their authorized Angel", async () => {
      const aishaDeviceId = "device_aisha_whisper_0123";
      const fatimaDeviceId = "device_fatima_whisper_0123";
      const aishaBinding = createDeviceBinding(aishaId, aishaDeviceId);
      const fatimaBinding = createDeviceBinding(fatimaId, fatimaDeviceId);
      const keyPackage = Buffer.alloc(64, 7).toString("base64");

      const publishProtectedUser = await api(`/api/v1/chats/${chatId}/crypto/key-packages`, {
        method: "POST",
        token: aishaToken,
        body: { ...aishaBinding, scope, keyPackage },
      });
      const publishAngel = await api(`/api/v1/chats/${chatId}/crypto/key-packages`, {
        method: "POST",
        token: fatimaToken,
        body: { ...fatimaBinding, scope, keyPackage },
      });
      expect(publishProtectedUser.status).toBe(200);
      expect(publishAngel.status).toBe(200);

      const devices = await api(
        `/api/v1/chats/${chatId}/crypto/devices/${fatimaId}?scope=${encodeURIComponent(scope)}`,
        { token: aishaToken },
      );
      expect(devices.status).toBe(200);
      expect(devices.body.devices).toContainEqual(expect.objectContaining({
        deviceId: fatimaDeviceId,
        identity: fatimaBinding.identity,
        signatureKey: fatimaBinding.signatureKey,
        signatureProof: fatimaBinding.signatureProof,
      }));

      const angelFetch = await api(
        `/api/v1/chats/${chatId}/crypto/key-packages/${aishaId}?deviceId=${fatimaDeviceId}&scope=${encodeURIComponent(scope)}`,
        { token: fatimaToken },
      );
      expect(angelFetch.status).toBe(200);
      expect(angelFetch.body.keyPackage.userId).toBe(aishaId);

      const otherParticipantFetch = await api(
        `/api/v1/chats/${chatId}/crypto/key-packages/${aishaId}?deviceId=device_omar_whisper_0123&scope=${encodeURIComponent(scope)}`,
        { token: omarToken },
      );
      expect(otherParticipantFetch.status).toBe(404);
    });

    it("consumes the scoped KeyPackage with its idempotent MLS Welcome Whisper", async () => {
      const protectedDeviceId = "device_aisha_welcome_0123";
      const angelDeviceId = "device_fatima_welcome_0123";
      const binding = createDeviceBinding(aishaId, protectedDeviceId);
      const keyPackage = Buffer.alloc(64, 8).toString("base64");
      await api(`/api/v1/chats/${chatId}/crypto/key-packages`, {
        method: "POST",
        token: aishaToken,
        body: { ...binding, scope, keyPackage },
      });
      const claimed = await api(
        `/api/v1/chats/${chatId}/crypto/key-packages/${aishaId}?deviceId=${angelDeviceId}&scope=${encodeURIComponent(scope)}`,
        { token: fatimaToken },
      );
      expect(claimed.status).toBe(200);

      const welcome = {
        clientMsgId: "whisper-welcome-id-0001",
        ciphertext: Buffer.alloc(64, 3).toString("base64"),
        encryptionMetadata: {
          protocol: "MLS",
          version: 1,
          kind: "whisper",
          mlsContentType: "welcome",
          keyPackageId: claimed.body.keyPackage.keyPackageId,
          claimantDeviceId: angelDeviceId,
          accessId,
        },
        plaintextCharLength: 0,
      };
      const wrongPeriod = await api(`/api/v1/angel/chats/${chatId}/whispers`, {
        method: "POST",
        token: fatimaToken,
        body: {
          ...welcome,
          clientMsgId: "whisper-welcome-wrong-period",
          encryptionMetadata: { ...welcome.encryptionMetadata, accessId: "stale-access-period" },
        },
      });
      expect(wrongPeriod.status).toBe(409);
      expect(wrongPeriod.body.code).toBe("WHISPER_ACCESS_PERIOD_INVALID");

      const first = await api(`/api/v1/angel/chats/${chatId}/whispers`, {
        method: "POST",
        token: fatimaToken,
        body: welcome,
      });
      const retry = await api(`/api/v1/angel/chats/${chatId}/whispers`, {
        method: "POST",
        token: fatimaToken,
        body: welcome,
      });
      expect(first.status).toBe(201);
      expect(retry.status).toBe(200);

      const replay = await api(`/api/v1/angel/chats/${chatId}/whispers`, {
        method: "POST",
        token: fatimaToken,
        body: { ...welcome, clientMsgId: "whisper-welcome-id-0002" },
      });
      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe("KEY_PACKAGE_CLAIM_INVALID");
    });

    it("rejects unencoded Whispers and accepts the opaque MLS-tagged envelope shape", async () => {
      const plaintext = await api(`/api/v1/angel/chats/${chatId}/whispers`, {
        method: "POST",
        token: fatimaToken,
        body: { ciphertext: "do not store this plaintext" },
      });
      expect(plaintext.status).toBe(400);

      const res = await api(`/api/v1/angel/chats/${chatId}/whispers`, {
        method: "POST",
        token: fatimaToken,
        body: {
          ...opaqueTransportFixture("whisper", "whisper"),
          encryptionMetadata: {
            protocol: "MLS",
            version: 1,
            kind: "whisper",
            mlsContentType: "application",
            accessId,
          },
          plaintextCharLength: 30,
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.whisper.toUserId).toBe(aishaId);

      const protectedHistory = await api(`/api/v1/chats/${chatId}/whispers`, { token: aishaToken });
      const otherParticipantHistory = await api(`/api/v1/chats/${chatId}/whispers`, { token: omarToken });
      expect(protectedHistory.status).toBe(200);
      expect(protectedHistory.body.whispers.length).toBeGreaterThan(0);
      expect(protectedHistory.body.whispers.every((whisper: { toUserId: string }) => whisper.toUserId === aishaId)).toBe(true);
      expect(otherParticipantHistory.body.whispers).toEqual([]);
    });

    it("routes participant-message copies only to the matching Angel and access period", async () => {
      const source = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: aishaToken,
        body: {
          ...opaqueTransportFixture(`angel-source-${crypto.randomUUID()}`),
          clientMsgId: `angel-source-${crypto.randomUUID()}`,
        },
      });
      expect(source.status).toBe(201);

      const message = {
        clientMsgId: `angel-forward-${crypto.randomUUID()}`,
        accessId,
        sourceMessageId: source.body.message.id,
        sourceSeq: source.body.message.seq,
        ...opaqueTransportFixture(`angel-copy-${crypto.randomUUID()}`, "whisper"),
        encryptionMetadata: {
          protocol: "MLS",
          version: 1,
          kind: "whisper",
          mlsContentType: "application",
          accessId,
        },
      };
      const first = await api(`/api/v1/chats/${chatId}/angel-messages`, {
        method: "POST",
        token: aishaToken,
        body: message,
      });
      const retry = await api(`/api/v1/chats/${chatId}/angel-messages`, {
        method: "POST",
        token: aishaToken,
        body: message,
      });
      expect(first.status).toBe(201);
      expect(retry.status).toBe(200);
      expect(retry.body.message.id).toBe(first.body.message.id);

      const angelHistory = await api(`/api/v1/angel/chats/${chatId}/messages`, { token: fatimaToken });
      expect(angelHistory.status).toBe(200);
      expect(angelHistory.body.timeline).toContainEqual(expect.objectContaining({
        id: first.body.message.id,
        accessId,
        sourceMessageId: source.body.message.id,
        ciphertext: message.ciphertext,
      }));
      expect(angelHistory.body.timeline).not.toContainEqual(expect.objectContaining({
        id: source.body.message.id,
        ciphertext: source.body.message.ciphertext,
      }));
      expect((await api(`/api/v1/angel/chats/${chatId}/messages`, { token: omarToken })).status).toBe(403);
      expect((await api(`/api/v1/angel/chats/${chatId}/messages`, { token: saraToken })).status).toBe(403);

      const raceSource = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: aishaToken,
        body: {
          ...opaqueTransportFixture(`angel-race-source-${crypto.randomUUID()}`),
          clientMsgId: `angel-source-${crypto.randomUUID()}`,
        },
      });
      const raceClientMsgId = `angel-race-${crypto.randomUUID()}`;
      const raceMessage = {
        ...message,
        clientMsgId: raceClientMsgId,
        sourceMessageId: raceSource.body.message.id,
        sourceSeq: raceSource.body.message.seq,
      };
      const [raceFirst, raceConflict] = await Promise.all([
        api(`/api/v1/chats/${chatId}/angel-messages`, { method: "POST", token: aishaToken, body: raceMessage }),
        api(`/api/v1/chats/${chatId}/angel-messages`, {
          method: "POST",
          token: aishaToken,
          body: { ...raceMessage, ciphertext: opaqueTransportFixture("angel-race-altered", "whisper").ciphertext },
        }),
      ]);
      expect([raceFirst.status, raceConflict.status].sort()).toEqual([201, 409]);

      const stalePeriod = await api(`/api/v1/chats/${chatId}/angel-messages`, {
        method: "POST",
        token: aishaToken,
        body: { ...message, accessId: "stale-access-period", encryptionMetadata: { ...message.encryptionMetadata, accessId: "stale-access-period" } },
      });
      expect(stalePeriod.status).toBe(409);
      expect(stalePeriod.body.code).toBe("ANGEL_ACCESS_INACTIVE");

      const db = await getDb();
      const [access] = await db.select().from(chatAngelAccess).where(eq(chatAngelAccess.id, accessId)).limit(1);
      const priorMessages = await db.select({ seq: messages.seq }).from(messages).where(eq(messages.chatId, chatId));
      const oldMessage = {
        id: `before-access-${crypto.randomUUID()}`,
        chatId,
        senderId: aishaId,
        ciphertext: opaqueTransportFixture("before-access").ciphertext,
        encryptionMetadata: { protocol: "MLS", version: 1, kind: "application" },
        seq: Math.max(0, ...priorMessages.map((item) => item.seq)) + 1,
        createdAt: new Date(access.authorizedFrom.getTime() - 1),
      };
      await db.insert(messages).values(oldMessage);
      const preAuthorization = await api(`/api/v1/chats/${chatId}/angel-messages`, {
        method: "POST",
        token: aishaToken,
        body: {
          ...message,
          clientMsgId: `angel-forward-${crypto.randomUUID()}`,
          sourceMessageId: oldMessage.id,
          sourceSeq: oldMessage.seq,
        },
      });
      expect(preAuthorization.status).toBe(409);
      expect(preAuthorization.body.code).toBe("SOURCE_MESSAGE_OUTSIDE_ACCESS");
    });

    it("rejects conflicting concurrent reuse of a Whisper id", async () => {
      const clientMsgId = `whisper-race-${crypto.randomUUID()}`;
      const ciphertext = opaqueTransportFixture(clientMsgId, "whisper").ciphertext;
      const metadata = {
        protocol: "MLS",
        version: 1,
        kind: "whisper",
        mlsContentType: "application",
        accessId,
      };
      const base = {
        clientMsgId,
        ciphertext,
        encryptionMetadata: metadata,
        plaintextCharLength: 12,
      };
      const [first, altered] = await Promise.all([
        api(`/api/v1/angel/chats/${chatId}/whispers`, { method: "POST", token: fatimaToken, body: base }),
        api(`/api/v1/angel/chats/${chatId}/whispers`, {
          method: "POST",
          token: fatimaToken,
          body: { ...base, encryptionMetadata: { ...metadata, senderHint: "changed" } },
        }),
      ]);

      expect([first.status, altered.status].sort()).toEqual([201, 409]);
      expect([first.body.code, altered.body.code]).toContain("CLIENT_MESSAGE_ID_REUSED");
    });

    it("Fatima pauses Aisha's sending ability", async () => {
      const res = await api(`/api/v1/angel/chats/${chatId}/restrict-sending`, {
        method: "POST",
        token: fatimaToken,
      });
      expect(res.status).toBe(200);

      // Aisha tries to send -> 409 SENDING_RESTRICTED (D13)
      const sendRes = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: aishaToken,
        body: opaqueTransportFixture("restricted-send"),
      });
      expect(sendRes.status).toBe(409);
      expect(sendRes.body.code).toBe("SENDING_RESTRICTED");

      // Omar is NOT restricted!
      const omarSend = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: omarToken,
        body: opaqueTransportFixture("omar-followup"),
      });
      expect(omarSend.status).toBe(201);
    });

    it("Fatima allows sending again", async () => {
      const res = await api(`/api/v1/angel/chats/${chatId}/allow-sending`, {
        method: "POST",
        token: fatimaToken,
      });
      expect(res.status).toBe(200);

      // Aisha can send again
      const sendRes = await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: aishaToken,
        body: opaqueTransportFixture("aisha-back"),
      });
      expect(sendRes.status).toBe(201);
    });
  });

  describe("6. Leave, Rejoin, and History Gaps (D6, D7, §8.6)", () => {
    let chatId: string;
    let accessRequestId: string;
    let oldAccessId: string;

    beforeAll(async () => {
      const res = await api("/api/v1/chats", { token: aishaToken });
      chatId = res.body.chats[0].id;
      const detail = await api(`/api/v1/chats/${chatId}`, { token: aishaToken });
      oldAccessId = detail.body.chat.ownAngels.find((item: { angelUserId: string }) => item.angelUserId === fatimaId).id;
    });

    it("Aisha sends 'I'm Comfortable' leave request to Fatima", async () => {
      const res = await api(`/api/v1/chats/${chatId}/access-requests`, {
        method: "POST",
        token: aishaToken,
        body: {
          type: "LEAVE",
          angelUserId: fatimaId,
          reason: "I feel safe now.",
        },
      });

      expect(res.status).toBe(201);
      accessRequestId = res.body.requestId;
    });

    it("Fatima accepts leave request -> chat transitions to COMFORT mode", async () => {
      const res = await api(`/api/v1/angel/access-requests/${accessRequestId}/accept`, {
        method: "POST",
        token: fatimaToken,
      });
      expect(res.status).toBe(200);

      const chatRes = await api(`/api/v1/chats/${chatId}`, { token: aishaToken });
      expect(chatRes.body.chat.mode).toBe("COMFORT");
      const staleKeyPackage = await api(
        `/api/v1/chats/${chatId}/crypto/key-packages/${aishaId}?deviceId=device_fatima_whisper_0123&scope=${encodeURIComponent(`WHISPER:${aishaId}:${fatimaId}:${oldAccessId}`)}`,
        { token: fatimaToken },
      );
      expect(staleKeyPackage.status).toBe(404);
      const historicalDevices = await api(
        `/api/v1/chats/${chatId}/crypto/devices/${fatimaId}?scope=${encodeURIComponent(`WHISPER:${aishaId}:${fatimaId}:${oldAccessId}`)}`,
        { token: aishaToken },
      );
      expect(historicalDevices.status).toBe(200);
    });

    it("Messages sent while Fatima is absent are masked by history gap upon rejoin (D6)", async () => {
      // Message exchanged while Fatima is gone
      const hiddenMessage = opaqueTransportFixture("angel-gap-message");
      await api(`/api/v1/chats/${chatId}/messages`, {
        method: "POST",
        token: omarToken,
        body: hiddenMessage,
      });

      // Aisha requests Fatima to rejoin
      const rejoinReq = await api(`/api/v1/chats/${chatId}/access-requests`, {
        method: "POST",
        token: aishaToken,
        body: {
          type: "REJOIN",
          angelUserId: fatimaId,
        },
      });

      // Fatima accepts rejoin
      await api(`/api/v1/angel/access-requests/${rejoinReq.body.requestId}/accept`, {
        method: "POST",
        token: fatimaToken,
      });

      const db = await getDb();
      const chatMessages = await db.select().from(messages).where(eq(messages.chatId, chatId));
      const welcomeId = `welcome-${chatId}`;
      await db.insert(messages).values({
        id: welcomeId,
        chatId,
        senderId: omarId,
        ciphertext: createHash("sha256").update("test-only:participant-welcome").digest("base64"),
        encryptionMetadata: { protocol: "MLS", version: 1, kind: "welcome" },
        seq: Math.max(0, ...chatMessages.map((message) => message.seq)) + 1,
        createdAt: new Date(),
      });

      // Fatima inspects messages
      const timelineRes = await api(`/api/v1/angel/chats/${chatId}/messages`, {
        token: fatimaToken,
      });

      expect(timelineRes.status).toBe(200);
      const timeline = timelineRes.body.timeline;

      // Ensure the message during absence is NOT visible to Fatima!
      const secretMsg = timeline.find(
        (t: any) => t.ciphertext === hiddenMessage.ciphertext
      );
      expect(secretMsg).toBeUndefined();

      // Ensure gap notice exists
      const gapNotice = timeline.find((t: any) => t.isGapNotice === true);
      expect(gapNotice).toBeDefined();
      expect(timeline.some((item: any) => item.id === welcomeId)).toBe(false);
    });
  });

  describe("7. Safety: Block & Report (Part 1 §8.7 & Part 2)", () => {
    let chatId: string;
    let reportId: string;

    beforeAll(async () => {
      const res = await api("/api/v1/chats", { token: aishaToken });
      chatId = res.body.chats[0].id;
    });

    it("Aisha files a safety report on Omar with message evidence", async () => {
      const res = await api(`/api/v1/chats/${chatId}/report`, {
        method: "POST",
        token: aishaToken,
        body: {
          reason: "Suspicious contract demands",
          details: "Asked for off-platform contact",
          evidence: ["Ciphertext sample evidence 1", "Ciphertext sample evidence 2"],
        },
      });

      expect(res.status).toBe(201);
      reportId = res.body.reportId;
    });

    it("Admin reviews report and evidence in admin queue", async () => {
      const res = await api(`/api/v1/admin/reports/${reportId}`, {
        token: adminToken,
      });

      expect(res.status).toBe(200);
      expect(res.body.report.reason).toBe("Suspicious contract demands");
      expect(res.body.report.evidence.length).toBe(2);
    });

    it("Admin resolves report with warning", async () => {
      const res = await api(`/api/v1/admin/reports/${reportId}/resolve`, {
        method: "POST",
        token: adminToken,
        body: {
          decision: "RESOLVED",
          reason: "Reviewed evidence and issued warning to user.",
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("RESOLVED");
    });
  });

  describe("8. Support: Profile Correction & Automated Impact Assessment (D16, Part 2 §3.4)", () => {
    let ticketId: string;

    it("Omar submits DOB/Sex correction ticket with required acknowledgement", async () => {
      const res = await api("/api/v1/support/profile-corrections", {
        method: "POST",
        token: omarToken,
        body: {
          field: "SEX",
          proposedValue: "FEMALE",
          reason: "Registered incorrect sex by mistake during onboarding.",
          acknowledgement: true,
        },
      });

      expect(res.status).toBe(201);
      ticketId = res.body.requestId;
      expect(res.body.impact).toBeDefined();
      expect(res.body.impact.field).toBe("SEX");
    });

    it("Admin inspects impact assessment and resolves with approval", async () => {
      const impactRes = await api(`/api/v1/admin/profile-corrections/${ticketId}/impact`, {
        token: adminToken,
      });
      expect(impactRes.status).toBe(200);

      const resolveRes = await api(`/api/v1/admin/profile-corrections/${ticketId}/resolve`, {
        method: "POST",
        token: adminToken,
        body: {
          decision: "APPROVED",
          reason: "Valid correction verified by support staff.",
          remediation: "Remediated chat rules.",
          noticePlan: "Notified affected participants.",
        },
      });

      expect(resolveRes.status).toBe(200);

      // Verify Omar's sex was updated in DB atomically
      const userRes = await api(`/api/v1/admin/users/${omarId}`, { token: adminToken });
      expect(userRes.body.user.sex).toBe("FEMALE");
    });

    it("Admin revokes user sessions and applies enforcement", async () => {
      const revokeRes = await api(`/api/v1/admin/users/${omarId}/revoke-sessions`, {
        method: "POST",
        token: adminToken,
        body: { reason: "Security refresh" },
      });
      expect(revokeRes.status).toBe(200);

      // Check sessions count
      const userRes = await api(`/api/v1/admin/users/${omarId}`, { token: adminToken });
      expect(userRes.body.sessions.length).toBe(0);
    });

    it("Admin audit logs recorded all operations", async () => {
      const res = await api("/api/v1/admin/audit-logs", { token: adminToken });
      expect(res.status).toBe(200);
      expect(res.body.logs.length).toBeGreaterThan(5);
    });
  });
});
