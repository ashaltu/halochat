import { Hono } from "hono";
import crypto from "node:crypto";
import { getDb, users, blocks, protectionSettings, pushTokens, eq, or, ilike, and } from "@halochat/db";
import { authMiddleware } from "../auth/index.js";
import { PushTokenSchema, UpdateProfileSchema } from "@halochat/shared";
import { AppEnv } from "../types.js";

export const usersRouter = new Hono<AppEnv>();

usersRouter.use("*", authMiddleware);

usersRouter.get("/me", async (c) => {
  const currentUser = c.get("user");
  const db = await getDb();

  const userRes = await db.select().from(users).where(eq(users.id, currentUser.id));
  if (userRes.length === 0) {
    return c.json({ code: "NOT_FOUND", message: "User not found" }, 404);
  }

  const settingsRes = await db
    .select()
    .from(protectionSettings)
    .where(eq(protectionSettings.userId, currentUser.id));

  const approvalThreshold = settingsRes[0]?.approvalThreshold || "ANY_ONE";

  return c.json({
    user: userRes[0],
    protectionSettings: {
      approvalThreshold,
    },
  });
});

usersRouter.patch("/me", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const parseResult = UpdateProfileSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const db = await getDb();
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (parseResult.data.displayName !== undefined) {
    updates.displayName = parseResult.data.displayName;
  }
  if (parseResult.data.onboardingCompleted) {
    updates.onboardingCompletedAt = new Date();
  }

  await db.update(users).set(updates).where(eq(users.id, currentUser.id));

  const updatedUser = await db.select().from(users).where(eq(users.id, currentUser.id));
  return c.json({ user: updatedUser[0] });
});

usersRouter.post("/me/push-tokens", async (c) => {
  const currentUser = c.get("user");
  const parsed = PushTokenSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: "VALIDATION_ERROR" }, 400);
  const db = await getDb();
  const existing = await db.select().from(pushTokens).where(eq(pushTokens.expoToken, parsed.data.expoToken));
  if (existing[0]) {
    await db.update(pushTokens).set({ userId: currentUser.id, platform: parsed.data.platform, updatedAt: new Date() }).where(eq(pushTokens.id, existing[0].id));
  } else {
    await db.insert(pushTokens).values({ id: crypto.randomUUID(), userId: currentUser.id, ...parsed.data });
  }
  return c.json({ success: true });
});

usersRouter.get("/users/search", async (c) => {
  const currentUser = c.get("user");
  const query = c.req.query("q")?.trim() || "";
  if (!query) {
    return c.json({ users: [] });
  }

  const db = await getDb();

  // Find all blocked relations
  const blockedRows = await db
    .select()
    .from(blocks)
    .where(or(eq(blocks.blockerId, currentUser.id), eq(blocks.blockedId, currentUser.id)));

  const excludedIds = new Set<string>([currentUser.id]);
  for (const row of blockedRows) {
    excludedIds.add(row.blockerId);
    excludedIds.add(row.blockedId);
  }

  const matchedUsers = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      sex: users.sex,
    })
    .from(users)
    .where(
      and(
        or(
          ilike(users.username, `%${query}%`),
          ilike(users.displayName, `%${query}%`)
        ),
        eq(users.banned, false)
      )
    )
    .limit(20);

  const filtered = matchedUsers.filter((u) => !excludedIds.has(u.id));

  return c.json({ users: filtered });
});
