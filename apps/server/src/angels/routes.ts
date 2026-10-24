import crypto from "node:crypto";
import { Hono } from "hono";
import {
  getDb,
  users,
  angelAssignments,
  angelConditions,
  protectionSettings,
  contactRequests,
  contactRequestAngels,
  chats,
  messages,
  whispers,
  angelChatMessages,
  cryptoKeyPackages,
  chatAngelAccess,
  angelSendRestrictions,
  angelAccessRequests,
  angelTrustCooldowns,
  auditLogs,
  eq,
  and,
  or,
  inArray,
  asc,
  desc,
  isNull,
  gt,
} from "@halochat/db";
import { authMiddleware } from "../auth/index.js";
import {
  ApprovalThreshold,
  AuditAction,
  ChatMode,
  ChatStatus,
  ContactRequestState,
  InviteAngelSchema,
  UpdateAngelScopeSchema,
  AngelContactDecisionSchema,
  ProtectionSettingsSchema,
  SendWhisperSchema,
  evaluateContactRequestState,
  filterMessagesForAngel,
  matchesAngelAssignment,
  PersonCondition,
  WsEventType,
} from "@halochat/shared";
import { wsManager } from "../realtime/index.js";
import { AppEnv } from "../types.js";

export const angelsRouter = new Hono<AppEnv>();

angelsRouter.use("*", authMiddleware);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

type ScopeImpact = {
  chatId: string;
  partner: { id: string; username: string; displayName: string };
  purpose: string;
  effect: "GAIN" | "LOSE";
};

async function getScopeImpacts(
  db: Awaited<ReturnType<typeof getDb>>,
  assignment: typeof angelAssignments.$inferSelect,
  currentUser: typeof users.$inferSelect,
  personConditions: PersonCondition[],
  purposeCategories: string[]
) {
  if (assignment.status !== "ACTIVE") return [] as ScopeImpact[];

  const activeChats = await db
    .select()
    .from(chats)
    .where(
      and(
        or(eq(chats.requesterUserId, currentUser.id), eq(chats.recipientUserId, currentUser.id)),
        eq(chats.status, "ACTIVE")
      )
    );
  const impacts: ScopeImpact[] = [];

  for (const chat of activeChats) {
    const partnerId =
      chat.requesterUserId === currentUser.id ? chat.recipientUserId : chat.requesterUserId;
    const partner = (await db.select().from(users).where(eq(users.id, partnerId)))[0];
    if (!partner) continue;

    const isMatch = matchesAngelAssignment(
      {
        id: assignment.id,
        userId: currentUser.id,
        angelUserId: assignment.angelUserId,
        status: assignment.status,
        conditions: { personConditions, purposeCategories, combination: "OR" },
      },
      currentUser,
      partner,
      chat.purpose,
      false
    );
    const existingAccess = await db
      .select()
      .from(chatAngelAccess)
      .where(
        and(
          eq(chatAngelAccess.chatId, chat.id),
          eq(chatAngelAccess.angelAssignmentId, assignment.id),
          isNull(chatAngelAccess.authorizedUntil)
        )
      );

    if (isMatch && existingAccess.length === 0) {
      impacts.push({
        chatId: chat.id,
        partner: { id: partner.id, username: partner.username, displayName: partner.displayName },
        purpose: chat.purpose,
        effect: "GAIN",
      });
    } else if (!isMatch && existingAccess.length > 0) {
      impacts.push({
        chatId: chat.id,
        partner: { id: partner.id, username: partner.username, displayName: partner.displayName },
        purpose: chat.purpose,
        effect: "LOSE",
      });
    }
  }

  return impacts;
}

// --- User Angel Management ---

angelsRouter.post("/me/angels", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = InviteAngelSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { angelUserId, useEarlyReset } = parseResult.data;
  if (angelUserId === currentUser.id) {
    return c.json({ code: "INVALID_TARGET", message: "You cannot assign yourself as your Angel" }, 400);
  }

  const db = await getDb();

  const cooldowns = await db
    .select()
    .from(angelTrustCooldowns)
    .where(
      and(
        eq(angelTrustCooldowns.userId, currentUser.id),
        gt(angelTrustCooldowns.cooldownUntil, new Date())
      )
    )
    .orderBy(desc(angelTrustCooldowns.removedAt));
  const cooldown = cooldowns[0];
  if (cooldown && !useEarlyReset) {
    return c.json({
      code: "ANGEL_COOLDOWN",
      message: "Angel replacement is in a 30-day trust cooldown",
      cooldownUntil: cooldown.cooldownUntil,
      resetsRemaining: cooldown.resetsRemaining,
    }, 409);
  }
  if (cooldown && useEarlyReset) {
    const periodExpired = cooldown.resetPeriodStart < new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const resetsRemaining = periodExpired ? 3 : cooldown.resetsRemaining;
    if (resetsRemaining < 1) {
      return c.json({ code: "NO_EARLY_RESETS", message: "No early resets remain" }, 409);
    }
    await db
      .update(angelTrustCooldowns)
      .set({
        cooldownUntil: new Date(),
        resetsRemaining: resetsRemaining - 1,
        resetPeriodStart: periodExpired ? new Date() : cooldown.resetPeriodStart,
      })
      .where(eq(angelTrustCooldowns.id, cooldown.id));
  }

  const targetUser = await db.select().from(users).where(eq(users.id, angelUserId));
  if (targetUser.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Target user not found" }, 404);
  }

  // Check if assignment already exists
  const existing = await db
    .select()
    .from(angelAssignments)
    .where(
      and(
        eq(angelAssignments.userId, currentUser.id),
        eq(angelAssignments.angelUserId, angelUserId),
        or(eq(angelAssignments.status, "PENDING"), eq(angelAssignments.status, "ACTIVE"))
      )
    );

  if (existing.length > 0) {
    return c.json({ code: "CONFLICT", message: "Angel assignment already pending or active" }, 409);
  }

  const assignmentId = crypto.randomUUID();
  await db.insert(angelAssignments).values({
    id: assignmentId,
    userId: currentUser.id,
    angelUserId,
    status: "PENDING",
  });

  // Create default condition
  await db.insert(angelConditions).values({
    id: crypto.randomUUID(),
    angelAssignmentId: assignmentId,
    personConditions: [],
    purposeCategories: [],
    combination: "OR",
  });

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: currentUser.id,
    action: AuditAction.ANGEL_INVITE,
    targetType: "angel_assignment",
    targetId: assignmentId,
  });

  // Notify angel
  wsManager.sendToUser(angelUserId, {
    type: WsEventType.ANGEL_ASSIGNMENT_UPDATED,
    assignmentId,
    action: "INVITED",
  });

  return c.json({ success: true, assignmentId }, 201);
});

angelsRouter.post("/me/angels/:assignmentId/scope-preview", async (c) => {
  const currentUser = c.get("user");
  const assignmentId = c.req.param("assignmentId");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = UpdateAngelScopeSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const db = await getDb();
  const assignment = (
    await db
      .select()
      .from(angelAssignments)
      .where(
        and(
          eq(angelAssignments.id, assignmentId),
          eq(angelAssignments.userId, currentUser.id)
        )
      )
  )[0];
  if (!assignment) {
    return c.json({ code: "NOT_FOUND", message: "Assignment not found" }, 404);
  }

  const impacts = await getScopeImpacts(
    db,
    assignment,
    currentUser,
    parseResult.data.personConditions as PersonCondition[],
    parseResult.data.purposeCategories
  );
  return c.json({ impacts });
});

angelsRouter.patch("/me/angels/:assignmentId", async (c) => {
  const currentUser = c.get("user");
  const assignmentId = c.req.param("assignmentId");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = UpdateAngelScopeSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const db = await getDb();
  const assignmentRes = await db
    .select()
    .from(angelAssignments)
    .where(
      and(
        eq(angelAssignments.id, assignmentId),
        eq(angelAssignments.userId, currentUser.id)
      )
    );

  if (assignmentRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Assignment not found" }, 404);
  }

  const assignment = assignmentRes[0];
  const { personConditions, purposeCategories, applyToExisting } = parseResult.data;

  // Update conditions
  const conditionRes = await db
    .select()
    .from(angelConditions)
    .where(eq(angelConditions.angelAssignmentId, assignmentId));

  if (conditionRes.length > 0) {
    await db
      .update(angelConditions)
      .set({
        personConditions,
        purposeCategories,
      })
      .where(eq(angelConditions.angelAssignmentId, assignmentId));
  } else {
    await db.insert(angelConditions).values({
      id: crypto.randomUUID(),
      angelAssignmentId: assignmentId,
      personConditions,
      purposeCategories,
      combination: "OR",
    });
  }

  if (applyToExisting && assignment.status === "ACTIVE") {
    const impacts = await getScopeImpacts(
      db,
      assignment,
      currentUser,
      personConditions as PersonCondition[],
      purposeCategories
    );
    for (const impact of impacts) {
      const existingAccess = await db
        .select()
        .from(chatAngelAccess)
        .where(
          and(
            eq(chatAngelAccess.chatId, impact.chatId),
            eq(chatAngelAccess.angelAssignmentId, assignment.id),
            isNull(chatAngelAccess.authorizedUntil)
          )
        );

      if (impact.effect === "GAIN" && existingAccess.length === 0) {
        await db.insert(chatAngelAccess).values({
          id: crypto.randomUUID(),
          chatId: impact.chatId,
          angelUserId: assignment.angelUserId,
          angelAssignmentId: assignment.id,
          authorizedFrom: new Date(),
        });
        await db.update(chats).set({ mode: "PROTECTED" }).where(eq(chats.id, impact.chatId));
      } else if (impact.effect === "LOSE" && existingAccess.length > 0) {
        await db
          .update(chatAngelAccess)
          .set({ authorizedUntil: new Date() })
          .where(eq(chatAngelAccess.id, existingAccess[0].id));

        const remaining = await db
          .select()
          .from(chatAngelAccess)
          .where(
            and(
              eq(chatAngelAccess.chatId, impact.chatId),
              isNull(chatAngelAccess.authorizedUntil)
            )
          );
        if (remaining.length === 0) {
          await db.update(chats).set({ mode: "COMFORT" }).where(eq(chats.id, impact.chatId));
        }
      }
    }
  }

  return c.json({ success: true });
});

angelsRouter.delete("/me/angels/:assignmentId", async (c) => {
  const currentUser = c.get("user");
  const assignmentId = c.req.param("assignmentId");
  const db = await getDb();

  const assignmentRes = await db
    .select()
    .from(angelAssignments)
    .where(
      and(
        eq(angelAssignments.id, assignmentId),
        eq(angelAssignments.userId, currentUser.id)
      )
    );

  if (assignmentRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Assignment not found" }, 404);
  }

  const assignment = assignmentRes[0];

  // Revoke future access immediately
  await db
    .update(angelAssignments)
    .set({ status: "REMOVED" })
    .where(eq(angelAssignments.id, assignmentId));

  // Revoke chat access in affected chats
  const activeAccesses = await db
    .select()
    .from(chatAngelAccess)
    .where(
      and(
        eq(chatAngelAccess.angelAssignmentId, assignmentId),
        isNull(chatAngelAccess.authorizedUntil)
      )
    );

  const now = new Date();
  for (const access of activeAccesses) {
    await db
      .update(chatAngelAccess)
      .set({ authorizedUntil: now })
      .where(eq(chatAngelAccess.id, access.id));

    // Update chat mode if no angels left
    const remaining = await db
      .select()
      .from(chatAngelAccess)
      .where(
        and(eq(chatAngelAccess.chatId, access.chatId), isNull(chatAngelAccess.authorizedUntil))
      );
    if (remaining.length === 0) {
      await db.update(chats).set({ mode: "COMFORT" }).where(eq(chats.id, access.chatId));
    }
  }

  // D14 Cooldown tracking
  const cooldownUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(angelTrustCooldowns).values({
    id: crypto.randomUUID(),
    userId: currentUser.id,
    angelUserId: assignment.angelUserId,
    removedAt: now,
    cooldownUntil,
    resetsRemaining: 3,
  });

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: currentUser.id,
    action: AuditAction.ANGEL_REVOKE,
    targetType: "angel_assignment",
    targetId: assignmentId,
  });

  return c.json({ success: true, cooldownUntil });
});

angelsRouter.get("/me/protection", async (c) => {
  const currentUser = c.get("user");
  const db = await getDb();

  const settingsRes = await db
    .select()
    .from(protectionSettings)
    .where(eq(protectionSettings.userId, currentUser.id));

  const approvalThreshold = settingsRes[0]?.approvalThreshold || "ANY_ONE";

  const assignments = await db
    .select({
      assignment: angelAssignments,
      condition: angelConditions,
      angelUser: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
    })
    .from(angelAssignments)
    .innerJoin(users, eq(angelAssignments.angelUserId, users.id))
    .leftJoin(angelConditions, eq(angelConditions.angelAssignmentId, angelAssignments.id))
    .where(
      and(
        eq(angelAssignments.userId, currentUser.id),
        or(eq(angelAssignments.status, "ACTIVE"), eq(angelAssignments.status, "PENDING"))
      )
    );

  return c.json({
    approvalThreshold,
    angels: assignments.map((row) => ({
      id: row.assignment.id,
      angelUserId: row.angelUser.id,
      username: row.angelUser.username,
      displayName: row.angelUser.displayName,
      status: row.assignment.status,
      createdAt: row.assignment.createdAt,
      acceptedAt: row.assignment.acceptedAt,
      conditions: row.condition
        ? {
            personConditions: row.condition.personConditions,
            purposeCategories: row.condition.purposeCategories,
            combination: row.condition.combination,
          }
        : null,
    })),
  });
});

angelsRouter.patch("/me/protection", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = ProtectionSettingsSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { approvalThreshold } = parseResult.data;
  const db = await getDb();

  const existing = await db
    .select()
    .from(protectionSettings)
    .where(eq(protectionSettings.userId, currentUser.id));

  if (existing.length > 0) {
    await db
      .update(protectionSettings)
      .set({ approvalThreshold })
      .where(eq(protectionSettings.userId, currentUser.id));
  } else {
    await db.insert(protectionSettings).values({
      userId: currentUser.id,
      approvalThreshold,
    });
  }

  return c.json({ success: true, approvalThreshold });
});

// --- Angel Scoped Tab Endpoints ---

angelsRouter.get("/angel/dashboard", async (c) => {
  const angel = c.get("user");
  const db = await getDb();

  // 1. Pending angel assignment invitations
  const pendingAssignments = await db
    .select({
      id: angelAssignments.id,
      userId: angelAssignments.userId,
      username: users.username,
      displayName: users.displayName,
      createdAt: angelAssignments.createdAt,
    })
    .from(angelAssignments)
    .innerJoin(users, eq(angelAssignments.userId, users.id))
    .where(
      and(
        eq(angelAssignments.angelUserId, angel.id),
        eq(angelAssignments.status, "PENDING")
      )
    );

  // 2. Pending contact request approvals
  const pendingRequests = await db
    .select({
      angelVoteId: contactRequestAngels.id,
      requestId: contactRequests.id,
      side: contactRequestAngels.side,
      purpose: contactRequests.purpose,
      createdAt: contactRequests.createdAt,
      requester: {
        id: contactRequests.requesterUserId,
      },
      recipient: {
        id: contactRequests.recipientUserId,
      },
    })
    .from(contactRequestAngels)
    .innerJoin(contactRequests, eq(contactRequestAngels.requestId, contactRequests.id))
    .where(
      and(
        eq(contactRequestAngels.angelUserId, angel.id),
        eq(contactRequestAngels.status, "PENDING"),
        eq(contactRequests.state, "PENDING_ANGEL")
      )
    );

  // 3. Active protected chats where this angel has active access
  const activeChats = await db
    .select({
      chatId: chats.id,
      accessId: chatAngelAccess.id,
      mode: chats.mode,
      status: chats.status,
      lastMessageAt: chats.lastMessageAt,
      authorizedFrom: chatAngelAccess.authorizedFrom,
      protectedUserId: angelAssignments.userId,
    })
    .from(chatAngelAccess)
    .innerJoin(chats, eq(chatAngelAccess.chatId, chats.id))
    .innerJoin(angelAssignments, eq(chatAngelAccess.angelAssignmentId, angelAssignments.id))
    .where(
      and(
        eq(chatAngelAccess.angelUserId, angel.id),
        isNull(chatAngelAccess.authorizedUntil),
        eq(chats.status, "ACTIVE")
      )
    );

  // 4. Pending access requests (leave/rejoin requests)
  const pendingAccessRequests = await db
    .select({
      id: angelAccessRequests.id,
      chatId: angelAccessRequests.chatId,
      type: angelAccessRequests.type,
      requestedBy: angelAccessRequests.requestedBy,
      reason: angelAccessRequests.reason,
      createdAt: angelAccessRequests.createdAt,
    })
    .from(angelAccessRequests)
    .where(
      and(
        eq(angelAccessRequests.angelUserId, angel.id),
        eq(angelAccessRequests.state, "PENDING")
      )
    );

  return c.json({
    pendingAssignments,
    pendingRequests,
    activeChats,
    pendingAccessRequests,
  });
});

angelsRouter.post("/angel/assignments/:id/accept", async (c) => {
  const angel = c.get("user");
  const assignmentId = c.req.param("id");
  const db = await getDb();

  const res = await db
    .select()
    .from(angelAssignments)
    .where(
      and(
        eq(angelAssignments.id, assignmentId),
        eq(angelAssignments.angelUserId, angel.id),
        eq(angelAssignments.status, "PENDING")
      )
    );

  if (res.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Pending assignment not found" }, 404);
  }

  await db
    .update(angelAssignments)
    .set({
      status: "ACTIVE",
      acceptedAt: new Date(),
    })
    .where(eq(angelAssignments.id, assignmentId));

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: angel.id,
    action: AuditAction.ANGEL_ACCEPT,
    targetType: "angel_assignment",
    targetId: assignmentId,
  });

  wsManager.sendToUser(res[0].userId, {
    type: WsEventType.ANGEL_ASSIGNMENT_UPDATED,
    assignmentId,
    action: "ACCEPTED",
  });

  return c.json({ success: true });
});

angelsRouter.post("/angel/assignments/:id/decline", async (c) => {
  const angel = c.get("user");
  const assignmentId = c.req.param("id");
  const db = await getDb();

  const res = await db
    .select()
    .from(angelAssignments)
    .where(
      and(
        eq(angelAssignments.id, assignmentId),
        eq(angelAssignments.angelUserId, angel.id),
        eq(angelAssignments.status, "PENDING")
      )
    );

  if (res.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Pending assignment not found" }, 404);
  }

  await db
    .update(angelAssignments)
    .set({ status: "DECLINED" })
    .where(eq(angelAssignments.id, assignmentId));

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: angel.id,
    action: AuditAction.ANGEL_DECLINE,
    targetType: "angel_assignment",
    targetId: assignmentId,
  });

  wsManager.sendToUser(res[0].userId, {
    type: WsEventType.ANGEL_ASSIGNMENT_UPDATED,
    assignmentId,
    action: "DECLINED",
  });

  return c.json({ success: true });
});

angelsRouter.post("/angel/requests/:id/approve", async (c) => {
  const angel = c.get("user");
  const requestId = c.req.param("id");
  const db = await getDb();

  const voteRes = await db
    .select()
    .from(contactRequestAngels)
    .where(
      and(
        eq(contactRequestAngels.requestId, requestId),
        eq(contactRequestAngels.angelUserId, angel.id),
        eq(contactRequestAngels.status, "PENDING")
      )
    );

  if (voteRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "No pending approval found for this Angel" }, 404);
  }

  const vote = voteRes[0];
  await db
    .update(contactRequestAngels)
    .set({
      status: "APPROVED",
      decidedAt: new Date(),
    })
    .where(eq(contactRequestAngels.id, vote.id));

  // Evaluate request state
  await reevaluateContactRequest(requestId);

  return c.json({ success: true });
});

angelsRouter.post("/angel/requests/:id/decline", async (c) => {
  const angel = c.get("user");
  const requestId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const db = await getDb();

  const voteRes = await db
    .select()
    .from(contactRequestAngels)
    .where(
      and(
        eq(contactRequestAngels.requestId, requestId),
        eq(contactRequestAngels.angelUserId, angel.id),
        eq(contactRequestAngels.status, "PENDING")
      )
    );

  if (voteRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "No pending approval found for this Angel" }, 404);
  }

  const vote = voteRes[0];
  await db
    .update(contactRequestAngels)
    .set({
      status: "DECLINED",
      reasonCode: body.reasonCode || null,
      shortReason: body.shortReason || null,
      decidedAt: new Date(),
    })
    .where(eq(contactRequestAngels.id, vote.id));

  // Evaluate request state
  await reevaluateContactRequest(requestId);

  return c.json({ success: true });
});

angelsRouter.get("/angel/chats/:id/messages", async (c) => {
  const angel = c.get("user");
  const chatId = c.req.param("id");
  const db = await getDb();

  // Find all access periods for this angel in this chat
  const accessPeriods = await db
    .select({ access: chatAngelAccess, assignment: angelAssignments })
    .from(chatAngelAccess)
    .innerJoin(angelAssignments, eq(chatAngelAccess.angelAssignmentId, angelAssignments.id))
    .where(
      and(
        eq(chatAngelAccess.chatId, chatId),
        eq(chatAngelAccess.angelUserId, angel.id)
      )
    );

  if (accessPeriods.length === 0) {
    return c.json({ code: "FORBIDDEN", message: "You have no authorized access history for this chat" }, 403);
  }

  const accessIds = accessPeriods.map(({ access }) => access.id);
  const protectedUserByAccessId = new Map(accessPeriods.map(({ access, assignment }) => [access.id, assignment.userId]));
  const forwardedCopies = await db.select({ copy: angelChatMessages, source: messages })
    .from(angelChatMessages)
    .innerJoin(messages, eq(angelChatMessages.sourceMessageId, messages.id))
    .where(and(
      eq(angelChatMessages.chatId, chatId),
      eq(angelChatMessages.angelUserId, angel.id),
      inArray(angelChatMessages.accessId, accessIds),
    ))
    .orderBy(asc(angelChatMessages.sourceSeq), asc(angelChatMessages.createdAt));

  const formattedMessages = forwardedCopies.map(({ copy, source }) => ({
    id: copy.id,
    chatId: copy.chatId,
    accessId: copy.accessId,
    angelUserId: copy.angelUserId,
    toUserId: protectedUserByAccessId.get(copy.accessId),
    senderId: source.senderId,
    sourceMessageId: copy.sourceMessageId,
    sourceSeq: copy.sourceSeq,
    ciphertext: copy.ciphertext,
    encryptionMetadata: copy.encryptionMetadata as Record<string, unknown> | null,
    seq: copy.sourceSeq,
    createdAt: source.createdAt.toISOString(),
  }));

  const periods = accessPeriods.map((p) => ({
    authorizedFrom: p.access.authorizedFrom.toISOString(),
    authorizedUntil: p.access.authorizedUntil ? p.access.authorizedUntil.toISOString() : null,
  }));

  // Filter messages strictly by authorized periods with gap notices (D6)
  const timeline = filterMessagesForAngel(formattedMessages, periods);

  return c.json({ timeline });
});

angelsRouter.get("/angel/chats/:id/whispers", async (c) => {
  const angel = c.get("user");
  const chatId = c.req.param("id");
  const db = await getDb();
  const accessPeriods = await db.select({ id: chatAngelAccess.id })
    .from(chatAngelAccess)
    .where(and(
      eq(chatAngelAccess.chatId, chatId),
      eq(chatAngelAccess.angelUserId, angel.id),
    )).limit(1);
  if (!accessPeriods.length) {
    return c.json({ code: "FORBIDDEN", message: "You have no authorized access to this chat" }, 403);
  }
  const whisperList = await db.select().from(whispers)
    .where(and(eq(whispers.chatId, chatId), eq(whispers.angelUserId, angel.id)))
    .orderBy(asc(whispers.createdAt));
  return c.json({ whispers: whisperList });
});

angelsRouter.post("/angel/chats/:id/restrict-sending", async (c) => {
  const angel = c.get("user");
  const chatId = c.req.param("id");
  const db = await getDb();

  // Verify angel has active access in this chat
  const accessRes = await db
    .select({
      access: chatAngelAccess,
      assignment: angelAssignments,
    })
    .from(chatAngelAccess)
    .innerJoin(angelAssignments, eq(chatAngelAccess.angelAssignmentId, angelAssignments.id))
    .where(
      and(
        eq(chatAngelAccess.chatId, chatId),
        eq(chatAngelAccess.angelUserId, angel.id),
        isNull(chatAngelAccess.authorizedUntil)
      )
    );

  if (accessRes.length === 0) {
    return c.json({ code: "FORBIDDEN", message: "No active access in this chat" }, 403);
  }

  const protectedUserId = accessRes[0].assignment.userId;

  // Insert or activate restriction
  const existingRestriction = await db
    .select()
    .from(angelSendRestrictions)
    .where(
      and(
        eq(angelSendRestrictions.chatId, chatId),
        eq(angelSendRestrictions.angelUserId, angel.id),
        eq(angelSendRestrictions.protectedUserId, protectedUserId)
      )
    );

  if (existingRestriction.length > 0) {
    await db
      .update(angelSendRestrictions)
      .set({ active: true, liftedAt: null })
      .where(eq(angelSendRestrictions.id, existingRestriction[0].id));
  } else {
    await db.insert(angelSendRestrictions).values({
      id: crypto.randomUUID(),
      chatId,
      angelUserId: angel.id,
      protectedUserId,
      active: true,
    });
  }

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: angel.id,
    action: AuditAction.RESTRICT_SENDING,
    targetType: "chat",
    targetId: chatId,
  });

  // Notify ONLY the protected user! (D13)
  wsManager.sendToUser(protectedUserId, {
    type: WsEventType.CHAT_UPDATED,
    chatId,
    restriction: "RESTRICTED",
  });

  return c.json({ success: true });
});

angelsRouter.post("/angel/chats/:id/allow-sending", async (c) => {
  const angel = c.get("user");
  const chatId = c.req.param("id");
  const db = await getDb();

  const restrictions = await db
    .select()
    .from(angelSendRestrictions)
    .where(
      and(
        eq(angelSendRestrictions.chatId, chatId),
        eq(angelSendRestrictions.angelUserId, angel.id),
        eq(angelSendRestrictions.active, true)
      )
    );

  if (restrictions.length > 0) {
    await db
      .update(angelSendRestrictions)
      .set({ active: false, liftedAt: new Date() })
      .where(eq(angelSendRestrictions.id, restrictions[0].id));

    const protectedUserId = restrictions[0].protectedUserId;

    // Check if any other angel restriction remains on this user
    const remaining = await db
      .select()
      .from(angelSendRestrictions)
      .where(
        and(
          eq(angelSendRestrictions.chatId, chatId),
          eq(angelSendRestrictions.protectedUserId, protectedUserId),
          eq(angelSendRestrictions.active, true)
        )
      );

    wsManager.sendToUser(protectedUserId, {
      type: WsEventType.CHAT_UPDATED,
      chatId,
      restriction: remaining.length === 0 ? "ALLOWED" : "RESTRICTED",
    });
  }

  return c.json({ success: true });
});

angelsRouter.post("/angel/chats/:id/end", async (c) => {
  const angel = c.get("user");
  const chatId = c.req.param("id");
  const db = await getDb();

  const access = await db
    .select()
    .from(chatAngelAccess)
    .where(
      and(
        eq(chatAngelAccess.chatId, chatId),
        eq(chatAngelAccess.angelUserId, angel.id),
        isNull(chatAngelAccess.authorizedUntil)
      )
    );

  if (access.length === 0) {
    return c.json({ code: "FORBIDDEN", message: "Not authorized to end this chat" }, 403);
  }

  const chatRes = await db.select().from(chats).where(eq(chats.id, chatId));
  if (chatRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Chat not found" }, 404);
  }

  const chat = chatRes[0];
  await db
    .update(chats)
    .set({
      status: "ENDED",
      endedBy: angel.id,
      updatedAt: new Date(),
    })
    .where(eq(chats.id, chatId));

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: angel.id,
    action: AuditAction.END_CHAT,
    targetType: "chat",
    targetId: chatId,
  });

  // Notify participants (participants see ended, but do NOT see angel identity, D13)
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

angelsRouter.post("/angel/chats/:id/whispers", async (c) => {
  const angel = c.get("user");
  const chatId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = SendWhisperSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const db = await getDb();
  const accessRes = await db
    .select({
      access: chatAngelAccess,
      assignment: angelAssignments,
    })
    .from(chatAngelAccess)
    .innerJoin(angelAssignments, eq(chatAngelAccess.angelAssignmentId, angelAssignments.id))
    .where(
      and(
        eq(chatAngelAccess.chatId, chatId),
        eq(chatAngelAccess.angelUserId, angel.id),
        isNull(chatAngelAccess.authorizedUntil)
      )
    );

  if (accessRes.length === 0) {
    return c.json({ code: "FORBIDDEN", message: "Not authorized to whisper in this chat" }, 403);
  }

  const protectedUserId = accessRes[0].assignment.userId;
  const scope = `WHISPER:${protectedUserId}:${angel.id}:${accessRes[0].access.id}`;
  if (parseResult.data.encryptionMetadata.accessId !== accessRes[0].access.id) {
    return c.json({ code: "WHISPER_ACCESS_PERIOD_INVALID", message: "Whisper does not match the current access period" }, 409);
  }
  const whisperId = parseResult.data.clientMsgId ?? crypto.randomUUID();
  const [existingWhisper] = await db.select().from(whispers).where(eq(whispers.id, whisperId)).limit(1);
  if (existingWhisper) {
    const sameRequest = existingWhisper.chatId === chatId &&
      existingWhisper.angelUserId === angel.id &&
      existingWhisper.toUserId === protectedUserId &&
      existingWhisper.ciphertext === parseResult.data.ciphertext &&
      canonicalJson(existingWhisper.encryptionMetadata) === canonicalJson(parseResult.data.encryptionMetadata);
    if (!sameRequest) {
      return c.json({ code: "CLIENT_MESSAGE_ID_REUSED", message: "Whisper ID was already used for different content" }, 409);
    }
    return c.json({ success: true, whisper: existingWhisper }, 200);
  }

  if (parseResult.data.encryptionMetadata.mlsContentType === "welcome") {
    const metadata = parseResult.data.encryptionMetadata;
    const consumed = await db.update(cryptoKeyPackages).set({
      consumedAt: new Date(),
      consumedByClientMsgId: whisperId,
    }).where(and(
      eq(cryptoKeyPackages.id, metadata.keyPackageId!),
      eq(cryptoKeyPackages.chatId, chatId),
      eq(cryptoKeyPackages.userId, protectedUserId),
      eq(cryptoKeyPackages.scope, scope),
      eq(cryptoKeyPackages.claimedByDeviceId, metadata.claimantDeviceId!),
      isNull(cryptoKeyPackages.consumedAt),
    )).returning();
    if (!consumed.length) {
      const [retryWhisper] = await db.select().from(whispers).where(eq(whispers.id, whisperId)).limit(1);
      if (!retryWhisper) {
        return c.json({ code: "KEY_PACKAGE_CLAIM_INVALID", message: "Welcome does not match a package claimed by this device" }, 409);
      }
    }
  }

  const [insertedWhisper] = await db.insert(whispers).values({
    id: whisperId,
    chatId,
    angelUserId: angel.id,
    toUserId: protectedUserId,
    ciphertext: parseResult.data.ciphertext,
    encryptionMetadata: parseResult.data.encryptionMetadata || null,
  }).onConflictDoNothing().returning();
  if (!insertedWhisper) {
    const [retryWhisper] = await db.select().from(whispers).where(eq(whispers.id, whisperId)).limit(1);
    if (!retryWhisper || retryWhisper.chatId !== chatId || retryWhisper.angelUserId !== angel.id ||
      retryWhisper.toUserId !== protectedUserId || retryWhisper.ciphertext !== parseResult.data.ciphertext ||
      canonicalJson(retryWhisper.encryptionMetadata) !== canonicalJson(parseResult.data.encryptionMetadata)) {
      return c.json({ code: "CLIENT_MESSAGE_ID_REUSED", message: "Whisper ID was already used for different content" }, 409);
    }
  }

  const whisperData = {
    id: whisperId,
    chatId,
    angelUserId: angel.id,
    toUserId: protectedUserId,
    ciphertext: parseResult.data.ciphertext,
    encryptionMetadata: parseResult.data.encryptionMetadata,
    createdAt: new Date().toISOString(),
  };

  // Deliver ONLY to protected user and sending angel connections (D13, §5.1)
  wsManager.sendToUser(protectedUserId, {
    type: WsEventType.WHISPER_NEW,
    whisper: whisperData,
  });
  wsManager.sendToUser(angel.id, {
    type: WsEventType.WHISPER_NEW,
    whisper: whisperData,
  });

  return c.json({ success: true, whisper: whisperData }, 201);
});

angelsRouter.post("/angel/access-requests/:id/accept", async (c) => {
  const angel = c.get("user");
  const requestId = c.req.param("id");
  const db = await getDb();

  const reqRes = await db
    .select()
    .from(angelAccessRequests)
    .where(
      and(
        eq(angelAccessRequests.id, requestId),
        eq(angelAccessRequests.angelUserId, angel.id),
        eq(angelAccessRequests.state, "PENDING")
      )
    );

  if (reqRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Pending access request not found" }, 404);
  }

  const accessReq = reqRes[0];
  const now = new Date();

  await db
    .update(angelAccessRequests)
    .set({
      state: "ACCEPTED",
      decidedAt: now,
    })
    .where(eq(angelAccessRequests.id, requestId));

  if (accessReq.type === "LEAVE") {
    // Revoke this angel's active access
    await db
      .update(chatAngelAccess)
      .set({ authorizedUntil: now })
      .where(
        and(
          eq(chatAngelAccess.chatId, accessReq.chatId),
          eq(chatAngelAccess.angelUserId, angel.id),
          isNull(chatAngelAccess.authorizedUntil)
        )
      );

    // Update chat mode if no angels left
    const remaining = await db
      .select()
      .from(chatAngelAccess)
      .where(
        and(
          eq(chatAngelAccess.chatId, accessReq.chatId),
          isNull(chatAngelAccess.authorizedUntil)
        )
      );

    if (remaining.length === 0) {
      await db.update(chats).set({ mode: "COMFORT" }).where(eq(chats.id, accessReq.chatId));
    }
  } else if (accessReq.type === "REJOIN" || accessReq.type === "INVITE") {
    // Find angel assignment
    const assignmentRes = await db
      .select()
      .from(angelAssignments)
      .where(
        and(
          eq(angelAssignments.userId, accessReq.requestedBy),
          eq(angelAssignments.angelUserId, angel.id)
        )
      );

    if (assignmentRes.length > 0) {
      await db.insert(chatAngelAccess).values({
        id: crypto.randomUUID(),
        chatId: accessReq.chatId,
        angelUserId: angel.id,
        angelAssignmentId: assignmentRes[0].id,
        authorizedFrom: now,
      });

      await db.update(chats).set({ mode: "PROTECTED" }).where(eq(chats.id, accessReq.chatId));

      const chatRes = await db.select().from(chats).where(eq(chats.id, accessReq.chatId));
      if (chatRes[0]) {
        wsManager.broadcastToUsers(
          [chatRes[0].requesterUserId, chatRes[0].recipientUserId],
          { type: WsEventType.CHAT_UPDATED, chatId: accessReq.chatId, mode: "PROTECTED" }
        );
      }
    }
  }

  wsManager.sendToUser(accessReq.requestedBy, {
    type: WsEventType.ACCESS_REQUEST_UPDATED,
    requestId,
    state: "ACCEPTED",
    typeAction: accessReq.type,
  });

  return c.json({ success: true });
});

angelsRouter.post("/angel/access-requests/:id/decline", async (c) => {
  const angel = c.get("user");
  const requestId = c.req.param("id");
  const db = await getDb();

  const reqRes = await db
    .select()
    .from(angelAccessRequests)
    .where(
      and(
        eq(angelAccessRequests.id, requestId),
        eq(angelAccessRequests.angelUserId, angel.id),
        eq(angelAccessRequests.state, "PENDING")
      )
    );

  if (reqRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Pending access request not found" }, 404);
  }

  await db
    .update(angelAccessRequests)
    .set({
      state: "DECLINED",
      decidedAt: new Date(),
    })
    .where(eq(angelAccessRequests.id, requestId));

  wsManager.sendToUser(reqRes[0].requestedBy, {
    type: WsEventType.ACCESS_REQUEST_UPDATED,
    requestId,
    state: "DECLINED",
    typeAction: reqRes[0].type,
  });

  return c.json({ success: true });
});

// Helper function to reevaluate contact request after an angel decision
export async function reevaluateContactRequest(requestId: string) {
  const db = await getDb();
  const requestRes = await db.select().from(contactRequests).where(eq(contactRequests.id, requestId));
  if (requestRes.length === 0) return;
  const request = requestRes[0];

  const votes = await db
    .select()
    .from(contactRequestAngels)
    .where(eq(contactRequestAngels.requestId, requestId));

  const recipientVotes = votes
    .filter((v) => v.side === "RECIPIENT")
    .map((v) => ({
      angelUserId: v.angelUserId,
      side: "RECIPIENT" as const,
      status: v.status as "PENDING" | "APPROVED" | "DECLINED",
      reasonCode: v.reasonCode || undefined,
      shortReason: v.shortReason || undefined,
    }));

  const requesterVotes = votes
    .filter((v) => v.side === "REQUESTER")
    .map((v) => ({
      angelUserId: v.angelUserId,
      side: "REQUESTER" as const,
      status: v.status as "PENDING" | "APPROVED" | "DECLINED",
      reasonCode: v.reasonCode || undefined,
      shortReason: v.shortReason || undefined,
    }));

  const recipientThreshold = request.recipientApprovalThreshold as ApprovalThreshold;
  const requesterThreshold = request.requesterApprovalThreshold as ApprovalThreshold;

  const nextState = evaluateContactRequestState({
    recipientThreshold,
    recipientVotes,
    requesterThreshold,
    requesterVotes,
  });

  if (nextState !== request.state) {
    if (nextState === ContactRequestState.ACCEPTED) {
      // Create chat!
      const chatId = crypto.randomUUID();
      const approvedAngels = votes.filter((v) => v.status === "APPROVED");
      const mode = approvedAngels.length > 0 ? "PROTECTED" : "COMFORT";

      await db.insert(chats).values({
        id: chatId,
        requesterUserId: request.requesterUserId,
        recipientUserId: request.recipientUserId,
        mode,
        status: "ACTIVE",
        purpose: request.purpose,
      });

      // Grant initial access to all approved angels
      const now = new Date();
      for (const angelVote of approvedAngels) {
        const assignmentRes = await db
          .select()
          .from(angelAssignments)
          .where(
            and(
              eq(
                angelAssignments.userId,
                angelVote.side === "RECIPIENT" ? request.recipientUserId : request.requesterUserId
              ),
              eq(angelAssignments.angelUserId, angelVote.angelUserId)
            )
          );

        if (assignmentRes.length > 0) {
          await db.insert(chatAngelAccess).values({
            id: crypto.randomUUID(),
            chatId,
            angelUserId: angelVote.angelUserId,
            angelAssignmentId: assignmentRes[0].id,
            authorizedFrom: now,
          });
        }
      }

      await db
        .update(contactRequests)
        .set({
          state: "ACCEPTED",
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
    } else if (nextState === ContactRequestState.DECLINED_BY_ANGEL) {
      await db
        .update(contactRequests)
        .set({
          state: "DECLINED_BY_ANGEL",
          updatedAt: new Date(),
        })
        .where(eq(contactRequests.id, requestId));

      // Requester sees only DECLINED (D10)
      wsManager.sendToUser(request.requesterUserId, {
        type: WsEventType.REQUEST_UPDATED,
        requestId,
        state: "DECLINED",
      });
      wsManager.sendToUser(request.recipientUserId, {
        type: WsEventType.REQUEST_UPDATED,
        requestId,
        state: "DECLINED",
      });
    }
  }
}
