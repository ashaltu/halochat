import crypto from "node:crypto";
import { Hono } from "hono";
import {
  getDb,
  users,
  chats,
  messages,
  whispers,
  angelChatMessages,
  cryptoKeyPackages,
  chatAngelAccess,
  angelAssignments,
  angelSendRestrictions,
  angelAccessRequests,
  auditLogs,
  eq,
  and,
  or,
  gt,
  desc,
  asc,
  isNull,
} from "@halochat/db";
import { authMiddleware } from "../auth/index.js";
import {
  AuditAction,
  ChatMode,
  ChatStatus,
  SendMessageSchema,
  PublishChatKeyPackageSchema,
  ChatAccessRequestSchema,
  ChatAngelInvitationSchema,
  sanitizeChatForParticipant,
  WsEventType,
  SendAngelChatMessageSchema,
} from "@halochat/shared";
import { wsManager } from "../realtime/index.js";
import { AppEnv } from "../types.js";
import { notifyOfflineUsers } from "../notifications/push.js";

export const chatsRouter = new Hono<AppEnv>();

chatsRouter.use("*", authMiddleware);

function messagePayload(message: typeof messages.$inferSelect) {
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    ciphertext: message.ciphertext,
    encryptionMetadata: message.encryptionMetadata,
    seq: message.seq,
    createdAt: message.createdAt.toISOString(),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deviceBindingMessage(accountId: string, deviceId: string, identity: Buffer, signatureKey: Buffer) {
  const fields = [Buffer.from(accountId), Buffer.from(deviceId), identity, signatureKey];
  const lengthPrefix = (length: number) => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(length);
    return prefix;
  };
  return Buffer.concat([
    Buffer.from("halochat:device-binding:v1"),
    ...fields.flatMap((field) => [lengthPrefix(field.length), field]),
  ]);
}

function hasValidDeviceBinding(accountId: string, input: {
  deviceId: string;
  identity: string;
  signatureKey: string;
  signatureProof: string;
}) {
  const identity = Buffer.from(input.identity, "base64");
  const signatureKey = Buffer.from(input.signatureKey, "base64");
  const signatureProof = Buffer.from(input.signatureProof, "base64");
  if (signatureKey.length !== 32 || signatureProof.length !== 64) return false;
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), signatureKey]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      deviceBindingMessage(accountId, input.deviceId, identity, signatureKey),
      publicKey,
      signatureProof,
    );
  } catch {
    return false;
  }
}

function messageMatchesRequest(
  message: typeof messages.$inferSelect,
  chatId: string,
  senderId: string,
  ciphertext: string,
  encryptionMetadata: Record<string, unknown> | undefined
) {
  return (
    message.chatId === chatId &&
    message.senderId === senderId &&
    message.ciphertext === ciphertext &&
    canonicalJson(message.encryptionMetadata ?? null) === canonicalJson(encryptionMetadata ?? null)
  );
}

async function consumeWelcomeKeyPackage(
  db: Awaited<ReturnType<typeof getDb>>,
  chatId: string,
  ownerUserId: string,
  metadata: Record<string, unknown>,
  clientMsgId: string | undefined,
) {
  if (metadata.kind !== "welcome") return true;
  if (
    typeof metadata.keyPackageId !== "string" ||
    typeof metadata.claimantDeviceId !== "string" ||
    !clientMsgId
  ) return false;

  const consumed = await db.update(cryptoKeyPackages).set({
    consumedAt: new Date(),
    consumedByClientMsgId: clientMsgId,
  }).where(and(
    eq(cryptoKeyPackages.id, metadata.keyPackageId),
    eq(cryptoKeyPackages.chatId, chatId),
    eq(cryptoKeyPackages.userId, ownerUserId),
    eq(cryptoKeyPackages.claimedByDeviceId, metadata.claimantDeviceId),
    isNull(cryptoKeyPackages.consumedAt),
  )).returning();
  if (consumed.length) return true;

  const [existingClaim] = await db.select({ consumedByClientMsgId: cryptoKeyPackages.consumedByClientMsgId })
    .from(cryptoKeyPackages)
    .where(and(
      eq(cryptoKeyPackages.id, metadata.keyPackageId),
      eq(cryptoKeyPackages.chatId, chatId),
      eq(cryptoKeyPackages.userId, ownerUserId),
      eq(cryptoKeyPackages.claimedByDeviceId, metadata.claimantDeviceId),
      eq(cryptoKeyPackages.consumedByClientMsgId, clientMsgId),
    )).limit(1);
  return !!existingClaim;
}

function parseWhisperScope(scope: string) {
  const match = /^WHISPER:([^:\s]{1,80}):([^:\s]{1,80}):([^:\s]{1,80})$/.exec(scope);
  if (!match || match[1] === match[2]) return null;
  return { protectedUserId: match[1], angelUserId: match[2], accessId: match[3] };
}

async function isWhisperScopeMember(
  db: Awaited<ReturnType<typeof getDb>>,
  chatId: string,
  userId: string,
  scope: string,
  activeOnly = true,
) {
  const pair = parseWhisperScope(scope);
  if (!pair || (userId !== pair.protectedUserId && userId !== pair.angelUserId)) return false;

  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat || (chat.requesterUserId !== pair.protectedUserId && chat.recipientUserId !== pair.protectedUserId)) {
    return false;
  }

  const access = await db.select({ id: chatAngelAccess.id })
    .from(chatAngelAccess)
    .innerJoin(angelAssignments, eq(chatAngelAccess.angelAssignmentId, angelAssignments.id))
    .where(and(
      eq(chatAngelAccess.chatId, chatId),
      eq(chatAngelAccess.id, pair.accessId),
      eq(chatAngelAccess.angelUserId, pair.angelUserId),
      ...(activeOnly ? [isNull(chatAngelAccess.authorizedUntil)] : []),
      eq(angelAssignments.userId, pair.protectedUserId),
      eq(angelAssignments.angelUserId, pair.angelUserId),
      eq(angelAssignments.status, "ACTIVE"),
    )).limit(1);
  return access.length > 0;
}

chatsRouter.get("/", async (c) => {
  const currentUser = c.get("user");
  const db = await getDb();

  const userChats = await db
    .select()
    .from(chats)
    .where(
      or(eq(chats.requesterUserId, currentUser.id), eq(chats.recipientUserId, currentUser.id))
    )
    .orderBy(desc(chats.updatedAt));

  const result = [];
  for (const chat of userChats) {
    // Fetch own angels protecting current user in this chat
    const ownAccess = await db
      .select({
        access: chatAngelAccess,
        assignment: angelAssignments,
        angelUser: {
          id: users.id,
          username: users.username,
          displayName: users.displayName,
        },
      })
      .from(chatAngelAccess)
      .innerJoin(angelAssignments, eq(chatAngelAccess.angelAssignmentId, angelAssignments.id))
      .innerJoin(users, eq(chatAngelAccess.angelUserId, users.id))
      .where(
        and(
          eq(chatAngelAccess.chatId, chat.id),
          eq(angelAssignments.userId, currentUser.id)
        )
      );

    // Check if user has active send restrictions
    const activeRestrictions = await db
      .select()
      .from(angelSendRestrictions)
      .where(
        and(
          eq(angelSendRestrictions.chatId, chat.id),
          eq(angelSendRestrictions.protectedUserId, currentUser.id),
          eq(angelSendRestrictions.active, true)
        )
      );

    const ownAngelAccessPeriods = ownAccess.map((row) => ({
      id: row.access.id,
      angelUserId: row.angelUser.id,
      authorizedFrom: row.access.authorizedFrom.toISOString(),
      authorizedUntil: row.access.authorizedUntil?.toISOString() ?? null,
    }));
    const ownAngels = ownAccess.filter((row) => !row.access.authorizedUntil).map((row) => ({
      id: row.access.id,
      authorizedFrom: row.access.authorizedFrom.toISOString(),
      angelUserId: row.angelUser.id,
      angelUsername: row.angelUser.username,
      angelDisplayName: row.angelUser.displayName,
      status: "ACTIVE",
      hasActiveRestriction: activeRestrictions.some((r) => r.angelUserId === row.angelUser.id),
    }));

    result.push(
      sanitizeChatForParticipant(
        {
          id: chat.id,
          requesterUserId: chat.requesterUserId,
          recipientUserId: chat.recipientUserId,
          mode: chat.mode as ChatMode,
          status: chat.status as ChatStatus,
          endedBy: chat.endedBy,
          lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
          createdAt: chat.createdAt.toISOString(),
        },
        currentUser.id,
        ownAngels,
        activeRestrictions.length > 0,
        ownAngelAccessPeriods
      )
    );
  }

  return c.json({ chats: result });
});

chatsRouter.get("/:id", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const db = await getDb();

  const chatRes = await db.select().from(chats).where(eq(chats.id, chatId));
  if (chatRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }

  const chat = chatRes[0];
  const isParticipant =
    chat.requesterUserId === currentUser.id || chat.recipientUserId === currentUser.id;

  if (!isParticipant) {
    return c.json({ code: "FORBIDDEN", message: "Not permitted" }, 403);
  }

  const ownAccess = await db
    .select({
      access: chatAngelAccess,
      assignment: angelAssignments,
      angelUser: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
    })
    .from(chatAngelAccess)
    .innerJoin(angelAssignments, eq(chatAngelAccess.angelAssignmentId, angelAssignments.id))
    .innerJoin(users, eq(chatAngelAccess.angelUserId, users.id))
    .where(
      and(
        eq(chatAngelAccess.chatId, chat.id),
        eq(angelAssignments.userId, currentUser.id)
      )
    );

  const activeRestrictions = await db
    .select()
    .from(angelSendRestrictions)
    .where(
      and(
        eq(angelSendRestrictions.chatId, chat.id),
        eq(angelSendRestrictions.protectedUserId, currentUser.id),
        eq(angelSendRestrictions.active, true)
      )
    );

  const ownAngelAccessPeriods = ownAccess.map((row) => ({
    id: row.access.id,
    angelUserId: row.angelUser.id,
    authorizedFrom: row.access.authorizedFrom.toISOString(),
    authorizedUntil: row.access.authorizedUntil?.toISOString() ?? null,
  }));
  const ownAngels = ownAccess.filter((row) => !row.access.authorizedUntil).map((row) => ({
    id: row.access.id,
    authorizedFrom: row.access.authorizedFrom.toISOString(),
    angelUserId: row.angelUser.id,
    angelUsername: row.angelUser.username,
    angelDisplayName: row.angelUser.displayName,
    status: "ACTIVE",
    hasActiveRestriction: activeRestrictions.some((r) => r.angelUserId === row.angelUser.id),
  }));

  const sanitized = sanitizeChatForParticipant(
    {
      id: chat.id,
      requesterUserId: chat.requesterUserId,
      recipientUserId: chat.recipientUserId,
      mode: chat.mode as ChatMode,
      status: chat.status as ChatStatus,
      endedBy: chat.endedBy,
      lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
      createdAt: chat.createdAt.toISOString(),
    },
    currentUser.id,
    ownAngels,
    activeRestrictions.length > 0,
    ownAngelAccessPeriods
  );

  return c.json({ chat: sanitized });
});

chatsRouter.post("/:id/crypto/key-packages", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = PublishChatKeyPackageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ code: "VALIDATION_ERROR", errors: parsed.error.flatten().fieldErrors }, 400);
  }

  const db = await getDb();
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  const scope = parsed.data.scope ?? "PARTICIPANT";
  const authorized = scope === "PARTICIPANT"
    ? !!chat && (chat.requesterUserId === currentUser.id || chat.recipientUserId === currentUser.id)
    : await isWhisperScopeMember(db, chatId, currentUser.id, scope);
  if (!chat || !authorized) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }
  if (chat.status !== "ACTIVE") {
    return c.json({ code: "CHAT_ENDED", message: "This chat has ended" }, 409);
  }

  const expectedIdentity = Buffer.from(
    `halochat:user:${currentUser.id}:device:${parsed.data.deviceId}`,
    "utf8"
  ).toString("base64");
  if (parsed.data.identity !== expectedIdentity) {
    return c.json({ code: "INVALID_DEVICE_IDENTITY", message: "Device identity is not bound to this account" }, 400);
  }
  if (!hasValidDeviceBinding(currentUser.id, parsed.data)) {
    return c.json({ code: "INVALID_DEVICE_BINDING", message: "Device signing key did not prove this account binding" }, 400);
  }

  await db.insert(cryptoKeyPackages).values({
    id: crypto.randomUUID(),
    chatId,
    userId: currentUser.id,
    deviceId: parsed.data.deviceId,
    scope,
    identity: parsed.data.identity,
    signatureKey: parsed.data.signatureKey,
    signatureProof: parsed.data.signatureProof,
    keyPackage: parsed.data.keyPackage,
    consumedAt: null,
  }).onConflictDoUpdate({
    target: [cryptoKeyPackages.chatId, cryptoKeyPackages.userId, cryptoKeyPackages.deviceId, cryptoKeyPackages.scope],
    set: {
      identity: parsed.data.identity,
      signatureKey: parsed.data.signatureKey,
      signatureProof: parsed.data.signatureProof,
      keyPackage: parsed.data.keyPackage,
      claimedByDeviceId: null,
      consumedAt: null,
      consumedByClientMsgId: null,
      createdAt: new Date(),
    },
  });

  return c.json({ ok: true });
});

chatsRouter.get("/:id/crypto/key-packages/:userId", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const targetUserId = c.req.param("userId");
  const claimantDeviceId = c.req.query("deviceId");
  const scope = c.req.query("scope") ?? "PARTICIPANT";
  const db = await getDb();
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  const authorized = scope === "PARTICIPANT"
    ? !!chat && (chat.requesterUserId === currentUser.id || chat.recipientUserId === currentUser.id)
    : await isWhisperScopeMember(db, chatId, currentUser.id, scope);
  if (!chat || !authorized) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }

  const whisperPair = scope === "PARTICIPANT" ? null : parseWhisperScope(scope);
  if (scope !== "PARTICIPANT" && !whisperPair) {
    return c.json({ code: "NOT_FOUND", message: "Key package not found" }, 404);
  }
  const partnerUserId = whisperPair
    ? (currentUser.id === whisperPair.protectedUserId ? whisperPair.angelUserId : whisperPair.protectedUserId)
    : chat.requesterUserId === currentUser.id ? chat.recipientUserId : chat.requesterUserId;
  if (targetUserId !== partnerUserId) {
    return c.json({ code: "NOT_FOUND", message: "Key package not found" }, 404);
  }
  if (chat.status !== "ACTIVE") {
    return c.json({ code: "CHAT_ENDED", message: "This chat has ended" }, 409);
  }
  if (!claimantDeviceId || !/^[A-Za-z0-9+/=_-]{20,80}$/.test(claimantDeviceId)) {
    return c.json({ code: "INVALID_DEVICE_ID", message: "A valid claimant device ID is required" }, 400);
  }

  const candidates = await db.select().from(cryptoKeyPackages).where(and(
    eq(cryptoKeyPackages.chatId, chatId),
    eq(cryptoKeyPackages.userId, partnerUserId),
    eq(cryptoKeyPackages.scope, scope),
    isNull(cryptoKeyPackages.consumedAt),
    or(isNull(cryptoKeyPackages.claimedByDeviceId), eq(cryptoKeyPackages.claimedByDeviceId, claimantDeviceId)),
  )).orderBy(asc(cryptoKeyPackages.createdAt)).limit(1);
  const candidate = candidates[0];
  if (!candidate) {
    return c.json({ code: "KEY_PACKAGE_UNAVAILABLE", message: "The other participant's device is not ready yet" }, 409);
  }

  const claimed = await db.update(cryptoKeyPackages)
    .set({ claimedByDeviceId: claimantDeviceId })
    .where(and(
      eq(cryptoKeyPackages.id, candidate.id),
      isNull(cryptoKeyPackages.consumedAt),
      or(isNull(cryptoKeyPackages.claimedByDeviceId), eq(cryptoKeyPackages.claimedByDeviceId, claimantDeviceId)),
    ))
    .returning();
  if (!claimed.length) {
    return c.json({ code: "KEY_PACKAGE_UNAVAILABLE", message: "A device key package was just claimed; retry" }, 409);
  }

  return c.json({
    keyPackage: {
      keyPackageId: candidate.id,
      userId: candidate.userId,
      deviceId: candidate.deviceId,
      identity: candidate.identity,
      signatureKey: candidate.signatureKey,
      signatureProof: candidate.signatureProof,
      keyPackage: candidate.keyPackage,
    },
  });
});

chatsRouter.get("/:id/crypto/devices/:userId", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const targetUserId = c.req.param("userId");
  const scope = c.req.query("scope") ?? "PARTICIPANT";
  const db = await getDb();
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);

  let expectedPeerId: string | null = null;
  if (scope === "PARTICIPANT") {
    if (chat.requesterUserId !== currentUser.id && chat.recipientUserId !== currentUser.id) {
      return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
    }
    expectedPeerId = chat.requesterUserId === currentUser.id ? chat.recipientUserId : chat.requesterUserId;
  } else {
    if (!await isWhisperScopeMember(db, chatId, currentUser.id, scope, false)) {
      return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
    }
    const pair = parseWhisperScope(scope);
    if (!pair) return c.json({ code: "NOT_FOUND", message: "Device identities not found" }, 404);
    expectedPeerId = currentUser.id === pair.protectedUserId ? pair.angelUserId : pair.protectedUserId;
  }

  if (targetUserId !== expectedPeerId) {
    return c.json({ code: "NOT_FOUND", message: "Device identities not found" }, 404);
  }
  const packages = await db.select({
    deviceId: cryptoKeyPackages.deviceId,
    identity: cryptoKeyPackages.identity,
    signatureKey: cryptoKeyPackages.signatureKey,
    signatureProof: cryptoKeyPackages.signatureProof,
  }).from(cryptoKeyPackages).where(and(
    eq(cryptoKeyPackages.chatId, chatId),
    eq(cryptoKeyPackages.userId, targetUserId),
    eq(cryptoKeyPackages.scope, scope),
  )).orderBy(desc(cryptoKeyPackages.createdAt));
  const seenDevices = new Set<string>();
  const devices = packages.filter((item) => {
    if (seenDevices.has(item.deviceId)) return false;
    seenDevices.add(item.deviceId);
    return true;
  });
  return c.json({ devices });
});

chatsRouter.get("/:id/messages", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const afterSeq = parseInt(c.req.query("after") || "0", 10);
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);

  const db = await getDb();
  const chatRes = await db.select().from(chats).where(eq(chats.id, chatId));
  if (chatRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }

  const chat = chatRes[0];
  const isParticipant =
    chat.requesterUserId === currentUser.id || chat.recipientUserId === currentUser.id;

  if (!isParticipant) {
    return c.json({ code: "FORBIDDEN", message: "Not permitted" }, 403);
  }

  const messageList = await db
    .select()
    .from(messages)
    .where(
      afterSeq > 0
        ? and(eq(messages.chatId, chatId), gt(messages.seq, afterSeq))
        : eq(messages.chatId, chatId)
    )
    .orderBy(asc(messages.seq))
    .limit(limit);

  return c.json({ messages: messageList });
});

chatsRouter.get("/:id/whispers", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const db = await getDb();
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat || (chat.requesterUserId !== currentUser.id && chat.recipientUserId !== currentUser.id)) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }
  const whisperList = await db.select().from(whispers)
    .where(and(eq(whispers.chatId, chatId), eq(whispers.toUserId, currentUser.id)))
    .orderBy(asc(whispers.createdAt));
  return c.json({ whispers: whisperList });
});

chatsRouter.post("/:id/angel-messages", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = SendAngelChatMessageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ code: "VALIDATION_ERROR", errors: parsed.error.flatten().fieldErrors }, 400);
  }

  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [chat] = await tx.select().from(chats).where(eq(chats.id, chatId)).limit(1).for("update");
    if (!chat || (chat.requesterUserId !== currentUser.id && chat.recipientUserId !== currentUser.id)) {
      return { status: 404, body: { code: "NOT_FOUND", message: "Chat not found" } };
    }
    const [access] = await tx.select({ access: chatAngelAccess, assignment: angelAssignments })
      .from(chatAngelAccess)
      .innerJoin(angelAssignments, eq(chatAngelAccess.angelAssignmentId, angelAssignments.id))
      .where(and(
        eq(chatAngelAccess.id, parsed.data.accessId),
        eq(chatAngelAccess.chatId, chatId),
        eq(angelAssignments.userId, currentUser.id),
      )).limit(1).for("update");
    if (!access) return { status: 409, body: { code: "ANGEL_ACCESS_UNKNOWN", message: "This Angel access period is unavailable" } };

    const [source] = await tx.select().from(messages).where(and(
      eq(messages.id, parsed.data.sourceMessageId),
      eq(messages.chatId, chatId),
      eq(messages.seq, parsed.data.sourceSeq),
    )).limit(1);
    if (!source || source.createdAt < access.access.authorizedFrom ||
      (access.access.authorizedUntil && source.createdAt > access.access.authorizedUntil)) {
      return { status: 409, body: { code: "SOURCE_MESSAGE_OUTSIDE_ACCESS", message: "The message is outside this Angel access period" } };
    }

    const matches = (stored: typeof angelChatMessages.$inferSelect) =>
      stored.chatId === chatId && stored.accessId === access.access.id &&
      stored.angelUserId === access.access.angelUserId && stored.senderId === currentUser.id &&
      stored.sourceMessageId === source.id && stored.sourceSeq === source.seq &&
      stored.clientMsgId === parsed.data.clientMsgId && stored.ciphertext === parsed.data.ciphertext &&
      canonicalJson(stored.encryptionMetadata) === canonicalJson(parsed.data.encryptionMetadata);
    const [existing] = await tx.select().from(angelChatMessages).where(and(
      eq(angelChatMessages.accessId, access.access.id),
      eq(angelChatMessages.sourceMessageId, source.id),
    )).limit(1);
    if (existing) {
      if (!matches(existing)) return { status: 409, body: { code: "CLIENT_MESSAGE_ID_REUSED", message: "This source message already has a different Angel copy" } };
      return { status: 200, body: { message: existing } };
    }

    const [inserted] = await tx.insert(angelChatMessages).values({
      id: crypto.randomUUID(),
      chatId,
      accessId: access.access.id,
      angelUserId: access.access.angelUserId,
      senderId: currentUser.id,
      sourceMessageId: source.id,
      sourceSeq: source.seq,
      clientMsgId: parsed.data.clientMsgId,
      ciphertext: parsed.data.ciphertext,
      encryptionMetadata: parsed.data.encryptionMetadata,
    }).onConflictDoNothing().returning();
    if (inserted) return { status: 201, body: { message: inserted } };

    const [raced] = await tx.select().from(angelChatMessages).where(and(
      eq(angelChatMessages.accessId, access.access.id),
      eq(angelChatMessages.sourceMessageId, source.id),
    )).limit(1);
    if (!raced || !matches(raced)) return { status: 409, body: { code: "CLIENT_MESSAGE_ID_REUSED", message: "This source message already has a different Angel copy" } };
    return { status: 200, body: { message: raced } };
  });
  return c.json(result.body, result.status as 200 | 201 | 404 | 409);
});

chatsRouter.post("/:id/messages", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = SendMessageSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const db = await getDb();
  const chatRes = await db.select().from(chats).where(eq(chats.id, chatId));
  if (chatRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }

  const chat = chatRes[0];
  const isParticipant =
    chat.requesterUserId === currentUser.id || chat.recipientUserId === currentUser.id;

  if (!isParticipant) {
    return c.json({ code: "FORBIDDEN", message: "Not permitted" }, 403);
  }

  if (chat.status === "ENDED") {
    return c.json({ code: "CHAT_ENDED", message: "This chat has ended" }, 400);
  }

  // D13 & §8.4: Check active Angel sending restriction on this user
  const restrictions = await db
    .select()
    .from(angelSendRestrictions)
    .where(
      and(
        eq(angelSendRestrictions.chatId, chatId),
        eq(angelSendRestrictions.protectedUserId, currentUser.id),
        eq(angelSendRestrictions.active, true)
      )
    );

  if (restrictions.length > 0) {
    return c.json(
      {
        code: "SENDING_RESTRICTED",
        message: "Your Angel has temporarily paused your ability to send messages.",
      },
      409
    );
  }

  if (parseResult.data.clientMsgId) {
    const [existingMessage] = await db
      .select()
      .from(messages)
      .where(and(
        eq(messages.senderId, currentUser.id),
        eq(messages.clientMsgId, parseResult.data.clientMsgId)
      ))
      .limit(1);
    if (existingMessage) {
      if (!messageMatchesRequest(
        existingMessage,
        chatId,
        currentUser.id,
        parseResult.data.ciphertext,
        parseResult.data.encryptionMetadata
      )) {
        return c.json({ code: "CLIENT_MESSAGE_ID_REUSED", message: "Message ID was already used for different content" }, 409);
      }
      const peerUserId = chat.requesterUserId === currentUser.id ? chat.recipientUserId : chat.requesterUserId;
      if (!await consumeWelcomeKeyPackage(
        db,
        chatId,
        peerUserId,
        parseResult.data.encryptionMetadata,
        parseResult.data.clientMsgId,
      )) {
        return c.json({ code: "KEY_PACKAGE_CLAIM_INVALID", message: "Welcome does not match a package claimed by this device" }, 409);
      }
      return c.json({ message: messagePayload(existingMessage) }, 200);
    }
  }

  const peerUserId = chat.requesterUserId === currentUser.id ? chat.recipientUserId : chat.requesterUserId;
  if (!await consumeWelcomeKeyPackage(
    db,
    chatId,
    peerUserId,
    parseResult.data.encryptionMetadata,
    parseResult.data.clientMsgId,
  )) {
    return c.json({ code: "KEY_PACKAGE_CLAIM_INVALID", message: "Welcome does not match a package claimed by this device" }, 409);
  }

  const messageId = crypto.randomUUID();
  const now = new Date();
  let nextSeq = 1;
  let inserted = false;
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    const lastMsg = await db
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.seq))
      .limit(1);
    nextSeq = lastMsg.length > 0 ? lastMsg[0].seq + 1 : 1;
    try {
      await db.insert(messages).values({
        id: messageId,
        chatId,
        senderId: currentUser.id,
        clientMsgId: parseResult.data.clientMsgId || null,
        ciphertext: parseResult.data.ciphertext,
        encryptionMetadata: parseResult.data.encryptionMetadata || null,
        seq: nextSeq,
        createdAt: now,
      });
      inserted = true;
    } catch (error) {
      if (parseResult.data.clientMsgId) {
        const [existingMessage] = await db
          .select()
          .from(messages)
          .where(and(
            eq(messages.senderId, currentUser.id),
            eq(messages.clientMsgId, parseResult.data.clientMsgId)
          ))
          .limit(1);
        if (existingMessage) {
          if (!messageMatchesRequest(
            existingMessage,
            chatId,
            currentUser.id,
            parseResult.data.ciphertext,
            parseResult.data.encryptionMetadata
          )) {
            return c.json({ code: "CLIENT_MESSAGE_ID_REUSED", message: "Message ID was already used for different content" }, 409);
          }
          const peerUserId = chat.requesterUserId === currentUser.id ? chat.recipientUserId : chat.requesterUserId;
          if (!await consumeWelcomeKeyPackage(
            db,
            chatId,
            peerUserId,
            parseResult.data.encryptionMetadata,
            parseResult.data.clientMsgId,
          )) {
            return c.json({ code: "KEY_PACKAGE_CLAIM_INVALID", message: "Welcome does not match a package claimed by this device" }, 409);
          }
          return c.json({ message: messagePayload(existingMessage) }, 200);
        }
      }
      if (attempt === 2) throw error;
    }
  }

  await db.update(chats).set({ lastMessageAt: now, updatedAt: now }).where(eq(chats.id, chatId));

  const msgPayload = messagePayload({
    id: messageId,
    chatId,
    senderId: currentUser.id,
    clientMsgId: parseResult.data.clientMsgId || null,
    ciphertext: parseResult.data.ciphertext,
    encryptionMetadata: parseResult.data.encryptionMetadata || null,
    seq: nextSeq,
    createdAt: now,
  });

  // Broadcast to participants
  wsManager.sendToUser(chat.requesterUserId, {
    type: WsEventType.MESSAGE_NEW,
    message: msgPayload,
  });
  wsManager.sendToUser(chat.recipientUserId, {
    type: WsEventType.MESSAGE_NEW,
    message: msgPayload,
  });

  await notifyOfflineUsers(
    [chat.requesterUserId, chat.recipientUserId],
    "New HaloChat message",
    { type: WsEventType.MESSAGE_NEW, chatId }
  );

  return c.json({ message: msgPayload }, 201);
});

chatsRouter.post("/:id/end", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const db = await getDb();

  const chatRes = await db.select().from(chats).where(eq(chats.id, chatId));
  if (chatRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }

  const chat = chatRes[0];
  const isParticipant =
    chat.requesterUserId === currentUser.id || chat.recipientUserId === currentUser.id;

  if (!isParticipant) {
    return c.json({ code: "FORBIDDEN", message: "Not permitted" }, 403);
  }

  const now = new Date();
  await db
    .update(chats)
    .set({
      status: "ENDED",
      endedBy: currentUser.id,
      updatedAt: now,
    })
    .where(eq(chats.id, chatId));

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: currentUser.id,
    action: AuditAction.END_CHAT,
    targetType: "chat",
    targetId: chatId,
  });

  // Notify participants
  wsManager.sendToUser(chat.requesterUserId, {
    type: WsEventType.CHAT_UPDATED,
    chatId,
    status: "ENDED",
  });
  wsManager.sendToUser(chat.recipientUserId, {
    type: WsEventType.CHAT_UPDATED,
    chatId,
    status: "ENDED",
  });

  return c.json({ success: true });
});

chatsRouter.post("/:id/access-requests", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = ChatAccessRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { type, angelUserId, reason } = parseResult.data;
  const db = await getDb();

  const chatRes = await db.select().from(chats).where(eq(chats.id, chatId));
  if (chatRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }

  const chat = chatRes[0];
  const isParticipant =
    chat.requesterUserId === currentUser.id || chat.recipientUserId === currentUser.id;

  if (!isParticipant) {
    return c.json({ code: "FORBIDDEN", message: "Not permitted" }, 403);
  }

  // Verify that angelUserId is assigned to currentUser
  const assignmentRes = await db
    .select()
    .from(angelAssignments)
    .where(
      and(
        eq(angelAssignments.userId, currentUser.id),
        eq(angelAssignments.angelUserId, angelUserId),
        eq(angelAssignments.status, "ACTIVE")
      )
    );

  if (assignmentRes.length === 0) {
    return c.json({ code: "NOT_ANGEL", message: "Target user is not your active Angel" }, 400);
  }

  const reqId = crypto.randomUUID();
  await db.insert(angelAccessRequests).values({
    id: reqId,
    chatId,
    angelUserId,
    type,
    state: "PENDING",
    requestedBy: currentUser.id,
    reason: reason || null,
  });

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: currentUser.id,
    action: type === "LEAVE" ? AuditAction.REQUEST_LEAVE : AuditAction.REQUEST_REJOIN,
    targetType: "chat",
    targetId: chatId,
    meta: { angelUserId, reason },
  });

  // Notify the target angel
  wsManager.sendToUser(angelUserId, {
    type: WsEventType.ACCESS_REQUEST_UPDATED,
    requestId: reqId,
    chatId,
    typeAction: type,
  });

  return c.json({ success: true, requestId: reqId }, 201);
});

// D7: Invite Angel into Comfort chat
chatsRouter.post("/:id/angel-invitations", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = ChatAngelInvitationSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { angelAssignmentId } = parseResult.data;
  const db = await getDb();

  const chatRes = await db.select().from(chats).where(eq(chats.id, chatId));
  if (chatRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }

  const chat = chatRes[0];
  const isParticipant =
    chat.requesterUserId === currentUser.id || chat.recipientUserId === currentUser.id;

  if (!isParticipant) {
    return c.json({ code: "FORBIDDEN", message: "Not permitted" }, 403);
  }

  const assignmentRes = await db
    .select()
    .from(angelAssignments)
    .where(
      and(
        eq(angelAssignments.id, angelAssignmentId),
        eq(angelAssignments.userId, currentUser.id),
        eq(angelAssignments.status, "ACTIVE")
      )
    );

  if (assignmentRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Active assignment not found" }, 404);
  }

  const assignment = assignmentRes[0];

  const invitationId = crypto.randomUUID();
  await db.insert(angelAccessRequests).values({
    id: invitationId,
    chatId,
    angelUserId: assignment.angelUserId,
    type: "INVITE",
    state: "PENDING",
    requestedBy: currentUser.id,
  });

  wsManager.sendToUser(assignment.angelUserId, {
    type: WsEventType.ACCESS_REQUEST_UPDATED,
    requestId: invitationId,
    chatId,
    typeAction: "INVITE",
  });

  return c.json({ success: true, invitationId, state: "PENDING" }, 201);
});
