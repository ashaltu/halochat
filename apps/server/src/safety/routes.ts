import crypto from "node:crypto";
import { Hono } from "hono";
import {
  getDb,
  users,
  blocks,
  reports,
  chats,
  contactRequests,
  auditLogs,
  eq,
  and,
  or,
} from "@halochat/db";
import { authMiddleware } from "../auth/index.js";
import { AuditAction, ReportChatSchema, WsEventType } from "@halochat/shared";
import { wsManager } from "../realtime/index.js";
import { AppEnv } from "../types.js";

export const safetyRouter = new Hono<AppEnv>();

safetyRouter.use("*", authMiddleware);

safetyRouter.post("/users/:id/block", async (c) => {
  const currentUser = c.get("user");
  const targetUserId = c.req.param("id");

  if (currentUser.id === targetUserId) {
    return c.json({ code: "INVALID_TARGET", message: "Cannot block yourself" }, 400);
  }

  const db = await getDb();

  const existing = await db
    .select()
    .from(blocks)
    .where(and(eq(blocks.blockerId, currentUser.id), eq(blocks.blockedId, targetUserId)));

  if (existing.length === 0) {
    await db.insert(blocks).values({
      id: crypto.randomUUID(),
      blockerId: currentUser.id,
      blockedId: targetUserId,
    });
  }

  // Cancel any pending requests between the users
  await db
    .update(contactRequests)
    .set({ state: "CANCELLED", updatedAt: new Date() })
    .where(
      and(
        or(
          and(
            eq(contactRequests.requesterUserId, currentUser.id),
            eq(contactRequests.recipientUserId, targetUserId)
          ),
          and(
            eq(contactRequests.requesterUserId, targetUserId),
            eq(contactRequests.recipientUserId, currentUser.id)
          )
        ),
        or(
          eq(contactRequests.state, "PENDING_RECIPIENT"),
          eq(contactRequests.state, "PENDING_ANGEL")
        )
      )
    );

  // End active chats between the users
  const activeChats = await db
    .select()
    .from(chats)
    .where(
      and(
        or(
          and(eq(chats.requesterUserId, currentUser.id), eq(chats.recipientUserId, targetUserId)),
          and(eq(chats.requesterUserId, targetUserId), eq(chats.recipientUserId, currentUser.id))
        ),
        eq(chats.status, "ACTIVE")
      )
    );

  const now = new Date();
  for (const chat of activeChats) {
    await db
      .update(chats)
      .set({ status: "ENDED", endedBy: "SYSTEM", updatedAt: now })
      .where(eq(chats.id, chat.id));

    wsManager.sendToUser(targetUserId, {
      type: WsEventType.CHAT_UPDATED,
      chatId: chat.id,
      status: "ENDED",
    });
  }

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: currentUser.id,
    action: AuditAction.BLOCK_USER,
    targetType: "user",
    targetId: targetUserId,
  });

  return c.json({ success: true });
});

safetyRouter.post("/users/:id/unblock", async (c) => {
  const currentUser = c.get("user");
  const targetUserId = c.req.param("id");
  const db = await getDb();

  await db
    .delete(blocks)
    .where(and(eq(blocks.blockerId, currentUser.id), eq(blocks.blockedId, targetUserId)));

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: currentUser.id,
    action: AuditAction.UNBLOCK_USER,
    targetType: "user",
    targetId: targetUserId,
  });

  return c.json({ success: true });
});

safetyRouter.post("/chats/:id/report", async (c) => {
  const currentUser = c.get("user");
  const chatId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = ReportChatSchema.safeParse(body);
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
  const reportedUserId =
    chat.requesterUserId === currentUser.id ? chat.recipientUserId : chat.requesterUserId;

  const reportId = crypto.randomUUID();
  await db.insert(reports).values({
    id: reportId,
    reporterId: currentUser.id,
    chatId,
    reportedUserId,
    reason: parseResult.data.reason,
    details: parseResult.data.details || null,
    evidence: parseResult.data.evidence || null,
    state: "PENDING",
  });

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: currentUser.id,
    action: AuditAction.CREATE_REPORT,
    targetType: "report",
    targetId: reportId,
    meta: { chatId, reportedUserId },
  });

  return c.json({ success: true, reportId }, 201);
});
