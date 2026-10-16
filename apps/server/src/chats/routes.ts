import crypto from "node:crypto";
import { Hono } from "hono";
import {
  getDb,
  users,
  chats,
  messages,
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
  ChatAccessRequestSchema,
  ChatAngelInvitationSchema,
  sanitizeChatForParticipant,
  WsEventType,
} from "@halochat/shared";
import { wsManager } from "../realtime/index.js";
import { AppEnv } from "../types.js";
import { notifyOfflineUsers } from "../notifications/push.js";

export const chatsRouter = new Hono<AppEnv>();

chatsRouter.use("*", authMiddleware);

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
          eq(angelAssignments.userId, currentUser.id),
          isNull(chatAngelAccess.authorizedUntil)
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

    const ownAngels = ownAccess.map((row) => ({
      id: row.access.id,
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
        activeRestrictions.length > 0
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
        eq(angelAssignments.userId, currentUser.id),
        isNull(chatAngelAccess.authorizedUntil)
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

  const ownAngels = ownAccess.map((row) => ({
    id: row.access.id,
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
    activeRestrictions.length > 0
  );

  return c.json({ chat: sanitized });
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
        ciphertext: parseResult.data.ciphertext,
        encryptionMetadata: parseResult.data.encryptionMetadata || null,
        seq: nextSeq,
        createdAt: now,
      });
      inserted = true;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }

  await db.update(chats).set({ lastMessageAt: now, updatedAt: now }).where(eq(chats.id, chatId));

  const msgPayload = {
    id: messageId,
    chatId,
    senderId: currentUser.id,
    ciphertext: parseResult.data.ciphertext,
    encryptionMetadata: parseResult.data.encryptionMetadata || null,
    seq: nextSeq,
    createdAt: now.toISOString(),
  };

  // Broadcast to participants
  wsManager.sendToUser(chat.requesterUserId, {
    type: WsEventType.MESSAGE_NEW,
    message: msgPayload,
  });
  wsManager.sendToUser(chat.recipientUserId, {
    type: WsEventType.MESSAGE_NEW,
    message: msgPayload,
  });

  // Broadcast to currently authorized angels
  const activeAngels = await db
    .select()
    .from(chatAngelAccess)
    .where(and(eq(chatAngelAccess.chatId, chatId), isNull(chatAngelAccess.authorizedUntil)));

  for (const access of activeAngels) {
    wsManager.sendToUser(access.angelUserId, {
      type: WsEventType.MESSAGE_NEW,
      message: msgPayload,
    });
  }

  await notifyOfflineUsers(
    [chat.requesterUserId, chat.recipientUserId, ...activeAngels.map((access) => access.angelUserId)],
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
