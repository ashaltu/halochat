import crypto from "node:crypto";
import { Hono } from "hono";
import {
  getDb,
  users,
  sessions,
  reports,
  profileCorrectionRequests,
  auditLogs,
  chats,
  angelAssignments,
  angelConditions,
  eq,
  and,
  or,
  desc,
  ilike,
} from "@halochat/db";
import { authMiddleware, adminMiddleware } from "../auth/index.js";
import {
  AuditAction,
  EnforcementAction,
  PersonCondition,
  ProfileCorrectionField,
  ProfileCorrectionRequestSchema,
  AdminResolveCorrectionSchema,
  AdminResolveReportSchema,
  AdminRevokeSessionsSchema,
  AdminUserEnforcementSchema,
  computeProfileCorrectionImpact,
  Sex,
} from "@halochat/shared";
import { AppEnv } from "../types.js";

export const supportRouter = new Hono<AppEnv>();

// User endpoints
supportRouter.post("/profile-corrections", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = ProfileCorrectionRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { field, proposedValue, reason } = parseResult.data;
  const db = await getDb();

  // Find active chats
  const activeChats = await db
    .select()
    .from(chats)
    .where(
      and(
        or(eq(chats.requesterUserId, currentUser.id), eq(chats.recipientUserId, currentUser.id)),
        eq(chats.status, "ACTIVE")
      )
    );

  const activeChatContexts = [];
  for (const chat of activeChats) {
    const partnerId =
      chat.requesterUserId === currentUser.id ? chat.recipientUserId : chat.requesterUserId;
    const partnerRes = await db.select().from(users).where(eq(users.id, partnerId));
    if (partnerRes.length > 0) {
      activeChatContexts.push({
        id: chat.id,
        partnerId,
        partnerSex: partnerRes[0].sex as Sex,
        partnerDob: partnerRes[0].dateOfBirth,
        mode: chat.mode,
      });
    }
  }

  // Find user's active angel assignments
  const assignments = await db
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

  const angelContexts = assignments.map((row) => ({
    id: row.assignment.id,
    angelUserId: row.assignment.angelUserId,
    personConditions: (row.condition?.personConditions as PersonCondition[]) || [],
    purposeCategories: (row.condition?.purposeCategories as string[]) || [],
  }));

  // Compute impact assessment (D16)
  const impact = computeProfileCorrectionImpact({
    user: {
      id: currentUser.id,
      username: currentUser.username,
      sex: currentUser.sex as Sex,
      dateOfBirth: currentUser.dateOfBirth,
    },
    field,
    proposedValue,
    activeChats: activeChatContexts,
    angelAssignments: angelContexts,
  });

  const requestId = crypto.randomUUID();
  await db.insert(profileCorrectionRequests).values({
    id: requestId,
    userId: currentUser.id,
    field,
    proposedValue,
    reason,
    impactReport: impact,
    status: "PENDING",
  });

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: currentUser.id,
    action: AuditAction.PROFILE_CORRECTION_REQUEST,
    targetType: "profile_correction_request",
    targetId: requestId,
    meta: { field, proposedValue },
  });

  return c.json({ success: true, requestId, impact }, 201);
});

supportRouter.get("/profile-corrections/mine", authMiddleware, async (c) => {
  const currentUser = c.get("user");
  const db = await getDb();

  const requests = await db
    .select()
    .from(profileCorrectionRequests)
    .where(eq(profileCorrectionRequests.userId, currentUser.id))
    .orderBy(desc(profileCorrectionRequests.createdAt));

  return c.json({ requests });
});

// Admin-only endpoints
export const adminRouter = new Hono<AppEnv>();
adminRouter.use("*", authMiddleware, adminMiddleware);

adminRouter.get("/users", async (c) => {
  const query = c.req.query("query")?.trim() || "";
  const db = await getDb();

  const userList = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      displayName: users.displayName,
      dateOfBirth: users.dateOfBirth,
      sex: users.sex,
      role: users.role,
      banned: users.banned,
      banReason: users.banReason,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      query
        ? or(
            ilike(users.email, `%${query}%`),
            ilike(users.username, `%${query}%`),
            ilike(users.displayName, `%${query}%`)
          )
        : undefined
    )
    .limit(50);

  return c.json({ users: userList });
});

adminRouter.get("/users/:id", async (c) => {
  const userId = c.req.param("id");
  const db = await getDb();

  const userRes = await db.select().from(users).where(eq(users.id, userId));
  if (userRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "User not found" }, 404);
  }

  const userSessions = await db.select().from(sessions).where(eq(sessions.userId, userId));

  return c.json({
    user: userRes[0],
    sessions: userSessions,
  });
});

adminRouter.post("/users/:id/enforcement", async (c) => {
  const admin = c.get("user");
  const userId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = AdminUserEnforcementSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { action, reason } = parseResult.data;
  const db = await getDb();

  if (action === EnforcementAction.BAN) {
    await db
      .update(users)
      .set({
        banned: true,
        banReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    // Invalidate all active sessions for banned user
    await db.delete(sessions).where(eq(sessions.userId, userId));
  }

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: admin.id,
    action: AuditAction.APPLY_ENFORCEMENT,
    targetType: "user",
    targetId: userId,
    meta: { action, reason },
  });

  return c.json({ success: true, action });
});

adminRouter.post("/users/:id/revoke-sessions", async (c) => {
  const admin = c.get("user");
  const userId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = AdminRevokeSessionsSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const db = await getDb();
  await db.delete(sessions).where(eq(sessions.userId, userId));

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: admin.id,
    action: AuditAction.REVOKE_SESSIONS,
    targetType: "user",
    targetId: userId,
    meta: { reason: parseResult.data.reason },
  });

  return c.json({ success: true });
});

adminRouter.get("/reports", async (c) => {
  const db = await getDb();
  const reportList = await db
    .select({
      report: reports,
      reporter: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
    })
    .from(reports)
    .innerJoin(users, eq(reports.reporterId, users.id))
    .orderBy(desc(reports.createdAt));

  return c.json({ reports: reportList });
});

adminRouter.get("/reports/:id", async (c) => {
  const reportId = c.req.param("id");
  const db = await getDb();

  const reportRes = await db.select().from(reports).where(eq(reports.id, reportId));
  if (reportRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Report not found" }, 404);
  }

  const report = reportRes[0];
  const reporter = (await db.select().from(users).where(eq(users.id, report.reporterId)))[0];
  const reportedUser = (
    await db.select().from(users).where(eq(users.id, report.reportedUserId))
  )[0];

  return c.json({
    report,
    reporter,
    reportedUser,
  });
});

adminRouter.post("/reports/:id/resolve", async (c) => {
  const admin = c.get("user");
  const reportId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = AdminResolveReportSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { decision, reason, enforcement } = parseResult.data;
  const db = await getDb();

  const reportRes = await db.select().from(reports).where(eq(reports.id, reportId));
  if (reportRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Report not found" }, 404);
  }

  const report = reportRes[0];
  const now = new Date();

  await db
    .update(reports)
    .set({
      state: decision,
      resolvedAt: now,
      resolvedBy: admin.id,
      resolutionNotes: reason,
    })
    .where(eq(reports.id, reportId));

  if (enforcement === EnforcementAction.BAN) {
    await db
      .update(users)
      .set({
        banned: true,
        banReason: `Report resolution: ${reason}`,
        updatedAt: now,
      })
      .where(eq(users.id, report.reportedUserId));

    await db.delete(sessions).where(eq(sessions.userId, report.reportedUserId));
  }

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: admin.id,
    action: AuditAction.RESOLVE_REPORT,
    targetType: "report",
    targetId: reportId,
    meta: { decision, reason, enforcement },
  });

  return c.json({ success: true, decision });
});

adminRouter.get("/profile-corrections", async (c) => {
  const db = await getDb();
  const list = await db
    .select({
      correction: profileCorrectionRequests,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        sex: users.sex,
        dateOfBirth: users.dateOfBirth,
      },
    })
    .from(profileCorrectionRequests)
    .innerJoin(users, eq(profileCorrectionRequests.userId, users.id))
    .orderBy(desc(profileCorrectionRequests.createdAt));

  return c.json({ corrections: list });
});

adminRouter.get("/profile-corrections/:id/impact", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();

  const res = await db
    .select()
    .from(profileCorrectionRequests)
    .where(eq(profileCorrectionRequests.id, id));

  if (res.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Correction request not found" }, 404);
  }

  return c.json({ impact: res[0].impactReport });
});

adminRouter.post("/profile-corrections/:id/resolve", async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = AdminResolveCorrectionSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { decision, reason, remediation, noticePlan } = parseResult.data;
  const db = await getDb();

  const res = await db
    .select()
    .from(profileCorrectionRequests)
    .where(eq(profileCorrectionRequests.id, id));

  if (res.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "Correction request not found" }, 404);
  }

  const correction = res[0];
  const now = new Date();

  await db
    .update(profileCorrectionRequests)
    .set({
      status: decision,
      reviewedBy: admin.id,
      resolution: reason,
      resolvedAt: now,
    })
    .where(eq(profileCorrectionRequests.id, id));

  if (decision === "APPROVED") {
    // Atomically update user's profile field (D16)
    if (correction.field === ProfileCorrectionField.DOB) {
      await db
        .update(users)
        .set({ dateOfBirth: correction.proposedValue, updatedAt: now })
        .where(eq(users.id, correction.userId));
    } else if (correction.field === ProfileCorrectionField.SEX) {
      await db
        .update(users)
        .set({ sex: correction.proposedValue, updatedAt: now })
        .where(eq(users.id, correction.userId));
    }
  }

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: admin.id,
    action: AuditAction.PROFILE_CORRECTION_RESOLVE,
    targetType: "profile_correction_request",
    targetId: id,
    meta: { decision, reason, remediation, noticePlan },
  });

  return c.json({ success: true, decision });
});

adminRouter.get("/audit-logs", async (c) => {
  const db = await getDb();
  const logs = await db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);

  return c.json({ logs });
});
