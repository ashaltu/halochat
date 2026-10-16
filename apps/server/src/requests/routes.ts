import crypto from "node:crypto";
import { Hono } from "hono";
import {
  getDb,
  users,
  blocks,
  contactRequests,
  contactRequestAngels,
  angelAssignments,
  angelConditions,
  protectionSettings,
  chats,
  chatAngelAccess,
  auditLogs,
  eq,
  and,
  or,
  inArray,
  desc,
} from "@halochat/db";
import { authMiddleware } from "../auth/index.js";
import {
  AuditAction,
  ContactRequestState,
  CreateContactRequestSchema,
  matchingActiveAngels,
  sanitizeRequestForRequester,
  PersonCondition,
  WsEventType,
} from "@halochat/shared";
import { getConversationPurposes } from "../config/routes.js";
import { wsManager } from "../realtime/index.js";
import { reevaluateContactRequest } from "../angels/routes.js";
import { AppEnv } from "../types.js";

export const requestsRouter = new Hono<AppEnv>();

requestsRouter.use("*", authMiddleware);

requestsRouter.post("/", async (c) => {
  const currentUser = c.get("user");
  if (!currentUser.emailVerified && process.env.REQUIRE_EMAIL_VERIFICATION !== "false") {
    return c.json({ code: "EMAIL_NOT_VERIFIED", message: "Verify your email before sending requests" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const parseResult = CreateContactRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { recipientId, purpose } = parseResult.data;

  if (recipientId === currentUser.id) {
    return c.json({ code: "INVALID_RECIPIENT", message: "You cannot send a contact request to yourself" }, 400);
  }

  const validPurposes = getConversationPurposes();
  if (!validPurposes.some((p) => p.toLowerCase() === purpose.toLowerCase())) {
    return c.json({ code: "INVALID_PURPOSE", message: "Invalid conversation purpose" }, 400);
  }

  const db = await getDb();

  // Check if blocked
  const blockRes = await db
    .select()
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, currentUser.id), eq(blocks.blockedId, recipientId)),
        and(eq(blocks.blockerId, recipientId), eq(blocks.blockedId, currentUser.id))
      )
    );

  if (blockRes.length > 0) {
    // Return generic error so block is not revealed (D10, §12.2)
    return c.json({ code: "NOT_ALLOWED", message: "Action not permitted" }, 403);
  }

  const recipientRes = await db.select().from(users).where(eq(users.id, recipientId));
  if (recipientRes.length === 0 || recipientRes[0].banned) {
    return c.json({ code: "NOT_FOUND", message: "Recipient user not found" }, 404);
  }
  const recipient = recipientRes[0];

  // Check duplicate pending request
  const existingPending = await db
    .select()
    .from(contactRequests)
    .where(
      and(
        eq(contactRequests.requesterUserId, currentUser.id),
        eq(contactRequests.recipientUserId, recipientId),
        or(
          eq(contactRequests.state, "PENDING_RECIPIENT"),
          eq(contactRequests.state, "PENDING_ANGEL")
        )
      )
    );

  if (existingPending.length > 0) {
    return c.json({ code: "REQUEST_EXISTS", message: "A pending request to this user already exists" }, 409);
  }

  // Check if active chat already exists
  const existingChat = await db
    .select()
    .from(chats)
    .where(
      and(
        or(
          and(eq(chats.requesterUserId, currentUser.id), eq(chats.recipientUserId, recipientId)),
          and(eq(chats.requesterUserId, recipientId), eq(chats.recipientUserId, currentUser.id))
        ),
        eq(chats.status, "ACTIVE")
      )
    );

  const isStranger = existingChat.length === 0;

  // Snapshot active angels and evaluate matching rules for requester
  const requesterAssignments = await db
    .select({
      assignment: angelAssignments,
      condition: angelConditions,
    })
    .from(angelAssignments)
    .leftJoin(angelConditions, eq(angelConditions.angelAssignmentId, angelAssignments.id))
    .where(
      and(
        eq(angelAssignments.userId, currentUser.id),
        eq(angelAssignments.status, "ACTIVE")
      )
    );

  const matchingRequesterAngels = matchingActiveAngels({
    actor: currentUser,
    target: recipient,
    purpose,
    isStranger,
    assignments: requesterAssignments.map((r) => ({
      id: r.assignment.id,
      userId: r.assignment.userId,
      angelUserId: r.assignment.angelUserId,
      status: r.assignment.status,
      conditions: r.condition
        ? {
            personConditions: r.condition.personConditions as PersonCondition[],
            purposeCategories: r.condition.purposeCategories as string[],
            combination: (r.condition.combination as "AND" | "OR") || "OR",
          }
        : null,
    })),
  });

  // Snapshot active angels and evaluate matching rules for recipient
  const recipientAssignments = await db
    .select({
      assignment: angelAssignments,
      condition: angelConditions,
    })
    .from(angelAssignments)
    .leftJoin(angelConditions, eq(angelConditions.angelAssignmentId, angelAssignments.id))
    .where(
      and(
        eq(angelAssignments.userId, recipient.id),
        eq(angelAssignments.status, "ACTIVE")
      )
    );

  const matchingRecipientAngels = matchingActiveAngels({
    actor: recipient,
    target: currentUser,
    purpose,
    isStranger,
    assignments: recipientAssignments.map((r) => ({
      id: r.assignment.id,
      userId: r.assignment.userId,
      angelUserId: r.assignment.angelUserId,
      status: r.assignment.status,
      conditions: r.condition
        ? {
            personConditions: r.condition.personConditions as PersonCondition[],
            purposeCategories: r.condition.purposeCategories as string[],
            combination: (r.condition.combination as "AND" | "OR") || "OR",
          }
        : null,
    })),
  });

  const requestId = crypto.randomUUID();
  const requesterSettings = await db
    .select()
    .from(protectionSettings)
    .where(eq(protectionSettings.userId, currentUser.id));
  const recipientSettings = await db
    .select()
    .from(protectionSettings)
    .where(eq(protectionSettings.userId, recipientId));

  await db.insert(contactRequests).values({
    id: requestId,
    requesterUserId: currentUser.id,
    recipientUserId: recipientId,
    purpose,
    state: "PENDING_RECIPIENT",
    requesterApprovalThreshold: requesterSettings[0]?.approvalThreshold || "ANY_ONE",
    recipientApprovalThreshold: recipientSettings[0]?.approvalThreshold || "ANY_ONE",
  });

  // Record snapshots in contact_request_angel
  for (const angel of matchingRequesterAngels) {
    await db.insert(contactRequestAngels).values({
      id: crypto.randomUUID(),
      requestId,
      side: "REQUESTER",
      angelUserId: angel.angelUserId,
      status: "PENDING",
    });
  }

  for (const angel of matchingRecipientAngels) {
    await db.insert(contactRequestAngels).values({
      id: crypto.randomUUID(),
      requestId,
      side: "RECIPIENT",
      angelUserId: angel.angelUserId,
      status: "PENDING",
    });
  }

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: currentUser.id,
    action: AuditAction.REQUEST_CREATE,
    targetType: "contact_request",
    targetId: requestId,
  });

  // Notify recipient
  wsManager.sendToUser(recipientId, {
    type: WsEventType.REQUEST_UPDATED,
    requestId,
    state: "PENDING_RECIPIENT",
  });

  return c.json({ success: true, requestId }, 201);
});

requestsRouter.get("/", async (c) => {
  const currentUser = c.get("user");
  const box = c.req.query("box") || "inbox";
  const db = await getDb();

  if (box === "inbox") {
    const list = await db
      .select({
        request: contactRequests,
        requester: {
          id: users.id,
          username: users.username,
          displayName: users.displayName,
        },
      })
      .from(contactRequests)
      .innerJoin(users, eq(contactRequests.requesterUserId, users.id))
      .where(eq(contactRequests.recipientUserId, currentUser.id))
      .orderBy(desc(contactRequests.createdAt));

    return c.json({ requests: list });
  } else {
    // Outbox (requester view): sanitized! (D10, §5.1)
    const list = await db
      .select({
        request: contactRequests,
        recipient: {
          id: users.id,
          username: users.username,
          displayName: users.displayName,
        },
      })
      .from(contactRequests)
      .innerJoin(users, eq(contactRequests.recipientUserId, users.id))
      .where(eq(contactRequests.requesterUserId, currentUser.id))
      .orderBy(desc(contactRequests.createdAt));

    const sanitized = list.map((item) => ({
      ...item,
      request: sanitizeRequestForRequester({
        id: item.request.id,
        requesterUserId: item.request.requesterUserId,
        recipientUserId: item.request.recipientUserId,
        purpose: item.request.purpose,
        state: item.request.state as ContactRequestState,
        createdAt: item.request.createdAt.toISOString(),
        updatedAt: item.request.updatedAt.toISOString(),
      }),
    }));

    return c.json({ requests: sanitized });
  }
});

requestsRouter.post("/:id/accept", async (c) => {
  const currentUser = c.get("user");
  const requestId = c.req.param("id");
  const db = await getDb();

  const reqRes = await db
    .select()
    .from(contactRequests)
    .where(
      and(
        eq(contactRequests.id, requestId),
        eq(contactRequests.recipientUserId, currentUser.id),
        eq(contactRequests.state, "PENDING_RECIPIENT")
      )
    );

  if (reqRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Pending request not found" }, 404);
  }

  const request = reqRes[0];
  const now = new Date();

  // Check if any angels were matched on either side
  const angelVotes = await db
    .select()
    .from(contactRequestAngels)
    .where(eq(contactRequestAngels.requestId, requestId));

  if (angelVotes.length === 0) {
    // Direct recipient accept -> open Comfort chat immediately!
    const chatId = crypto.randomUUID();
    await db.insert(chats).values({
      id: chatId,
      requesterUserId: request.requesterUserId,
      recipientUserId: request.recipientUserId,
      mode: "COMFORT",
      status: "ACTIVE",
      purpose: request.purpose,
    });

    await db
      .update(contactRequests)
      .set({
        state: "ACCEPTED",
        recipientDecidedAt: now,
        chatId,
        updatedAt: now,
      })
      .where(eq(contactRequests.id, requestId));

    wsManager.sendToUser(request.requesterUserId, {
      type: WsEventType.REQUEST_UPDATED,
      requestId,
      state: "ACCEPTED",
      chatId,
    });
    wsManager.sendToUser(request.recipientUserId, {
      type: WsEventType.REQUEST_UPDATED,
      requestId,
      state: "ACCEPTED",
      chatId,
    });

    return c.json({ success: true, state: "ACCEPTED", chatId });
  }

  // Angels required! Move to PENDING_ANGEL and request approvals
  await db
    .update(contactRequests)
    .set({
      state: "PENDING_ANGEL",
      recipientDecidedAt: now,
      updatedAt: now,
    })
    .where(eq(contactRequests.id, requestId));

  // Notify assigned angels
  for (const vote of angelVotes) {
    wsManager.sendToUser(vote.angelUserId, {
      type: WsEventType.ANGEL_APPROVAL_NEEDED,
      requestId,
      side: vote.side,
    });
  }

  // Trigger evaluation in case auto-approval thresholds apply
  await reevaluateContactRequest(requestId);

  return c.json({ success: true, state: "PENDING_ANGEL" });
});

requestsRouter.post("/:id/decline", async (c) => {
  const currentUser = c.get("user");
  const requestId = c.req.param("id");
  const db = await getDb();

  const reqRes = await db
    .select()
    .from(contactRequests)
    .where(
      and(
        eq(contactRequests.id, requestId),
        eq(contactRequests.recipientUserId, currentUser.id),
        eq(contactRequests.state, "PENDING_RECIPIENT")
      )
    );

  if (reqRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Pending request not found" }, 404);
  }

  const now = new Date();
  await db
    .update(contactRequests)
    .set({
      state: "DECLINED_BY_RECIPIENT",
      recipientDecidedAt: now,
      updatedAt: now,
    })
    .where(eq(contactRequests.id, requestId));

  // Requester sees generic DECLINED (D10)
  wsManager.sendToUser(reqRes[0].requesterUserId, {
    type: WsEventType.REQUEST_UPDATED,
    requestId,
    state: "DECLINED",
  });

  return c.json({ success: true });
});

requestsRouter.post("/:id/cancel", async (c) => {
  const currentUser = c.get("user");
  const requestId = c.req.param("id");
  const db = await getDb();

  const reqRes = await db
    .select()
    .from(contactRequests)
    .where(
      and(
        eq(contactRequests.id, requestId),
        eq(contactRequests.requesterUserId, currentUser.id),
        or(
          eq(contactRequests.state, "PENDING_RECIPIENT"),
          eq(contactRequests.state, "PENDING_ANGEL")
        )
      )
    );

  if (reqRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Pending request not found" }, 404);
  }

  await db
    .update(contactRequests)
    .set({
      state: "CANCELLED",
      updatedAt: new Date(),
    })
    .where(eq(contactRequests.id, requestId));

  wsManager.sendToUser(reqRes[0].recipientUserId, {
    type: WsEventType.REQUEST_UPDATED,
    requestId,
    state: "CANCELLED",
  });

  return c.json({ success: true });
});

requestsRouter.get("/:id/angel-approvals", async (c) => {
  const currentUser = c.get("user");
  const requestId = c.req.param("id");
  const db = await getDb();

  const reqRes = await db.select().from(contactRequests).where(eq(contactRequests.id, requestId));
  if (reqRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Request not found" }, 404);
  }

  const request = reqRes[0];
  const isRequester = request.requesterUserId === currentUser.id;
  const isRecipient = request.recipientUserId === currentUser.id;

  if (!isRequester && !isRecipient) {
    return c.json({ code: "FORBIDDEN", message: "Not permitted" }, 403);
  }

  const side = isRequester ? "REQUESTER" : "RECIPIENT";

  // Scoped strictly to caller's own side! (D15)
  const votes = await db
    .select({
      id: contactRequestAngels.id,
      side: contactRequestAngels.side,
      status: contactRequestAngels.status,
      reasonCode: contactRequestAngels.reasonCode,
      shortReason: contactRequestAngels.shortReason,
      decidedAt: contactRequestAngels.decidedAt,
      angel: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
    })
    .from(contactRequestAngels)
    .innerJoin(users, eq(contactRequestAngels.angelUserId, users.id))
    .where(
      and(
        eq(contactRequestAngels.requestId, requestId),
        eq(contactRequestAngels.side, side)
      )
    );

  return c.json({ approvals: votes });
});
