import crypto from "node:crypto";
import { Hono } from "hono";
import { getDb, users, accounts, sessions, protectionSettings, auditLogs, eq, or } from "@halochat/db";
import { SignUpSchema, SignInSchema, AuditAction } from "@halochat/shared";
import { hashPassword, verifyPassword, createSession, validateSessionToken } from "./index.js";
import { AppEnv } from "../types.js";

export const authRouter = new Hono<AppEnv>();

authRouter.post("/sign-up/email", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parseResult = SignUpSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { email, password, username, displayName, dateOfBirth, sex } = parseResult.data;
  const db = await getDb();

  // Check unique username and email
  const existing = await db
    .select()
    .from(users)
    .where(or(eq(users.username, username.toLowerCase()), eq(users.email, email.toLowerCase())));

  if (existing.length > 0) {
    const isUsername = existing.some((u) => u.username.toLowerCase() === username.toLowerCase());
    return c.json(
      {
        code: "CONFLICT",
        message: isUsername ? "Username is already taken" : "Email is already registered",
      },
      409
    );
  }

  const userId = crypto.randomUUID();
  const hashedPassword = hashPassword(password);

  // Check if first registered user can be made admin or regular user
  const userCount = await db.select().from(users);
  const role = userCount.length === 0 ? "admin" : "user";

  await db.insert(users).values({
    id: userId,
    email: email.toLowerCase(),
    username: username.toLowerCase(),
    displayName,
    dateOfBirth,
    sex,
    role,
  });

  await db.insert(accounts).values({
    id: crypto.randomUUID(),
    userId,
    accountId: email.toLowerCase(),
    providerId: "credential",
    password: hashedPassword,
  });

  // Initialize default protection settings (D15 default ANY_ONE)
  await db.insert(protectionSettings).values({
    userId,
    approvalThreshold: "ANY_ONE",
  });

  // Audit log
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: userId,
    action: AuditAction.USER_SIGNUP,
    targetType: "user",
    targetId: userId,
    meta: { username, role },
  });

  const session = await createSession(userId, c.req.raw.headers);

  c.header(
    "Set-Cookie",
    `better-auth.session_token=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
      30 * 24 * 60 * 60
    }`
  );

  return c.json(
    {
      session,
      user: {
        id: userId,
        email: email.toLowerCase(),
        username: username.toLowerCase(),
        displayName,
        dateOfBirth,
        sex,
        role,
        onboardingCompletedAt: null,
      },
    },
    201
  );
});

authRouter.post("/sign-in/email", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parseResult = SignInSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      { code: "VALIDATION_ERROR", errors: parseResult.error.flatten().fieldErrors },
      400
    );
  }

  const { emailOrUsername, password } = parseResult.data;
  const db = await getDb();

  const userRes = await db
    .select()
    .from(users)
    .where(
      or(
        eq(users.email, emailOrUsername.toLowerCase()),
        eq(users.username, emailOrUsername.toLowerCase())
      )
    );

  if (userRes.length === 0) {
    return c.json({ code: "INVALID_CREDENTIALS", message: "Invalid email/username or password" }, 401);
  }

  const user = userRes[0];

  if (user.banned) {
    return c.json(
      {
        code: "BANNED",
        message: user.banReason || "Your account has been suspended.",
      },
      403
    );
  }

  const accountRes = await db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, user.id));

  if (accountRes.length === 0 || !accountRes[0].password) {
    return c.json({ code: "INVALID_CREDENTIALS", message: "Invalid credentials" }, 401);
  }

  const isPasswordValid = verifyPassword(password, accountRes[0].password);
  if (!isPasswordValid) {
    return c.json({ code: "INVALID_CREDENTIALS", message: "Invalid email/username or password" }, 401);
  }

  const session = await createSession(user.id, c.req.raw.headers);

  c.header(
    "Set-Cookie",
    `better-auth.session_token=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
      30 * 24 * 60 * 60
    }`
  );

  return c.json({
    session,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      dateOfBirth: user.dateOfBirth,
      sex: user.sex,
      role: user.role,
      onboardingCompletedAt: user.onboardingCompletedAt,
    },
  });
});

authRouter.post("/sign-out", async (c) => {
  const authHeader = c.req.header("Authorization");
  const cookieHeader = c.req.header("Cookie");
  let token: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else if (cookieHeader) {
    const match = cookieHeader.match(/better-auth\.session_token=([^;]+)/);
    if (match) token = match[1];
  }

  if (token) {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.token, token));
  }

  c.header("Set-Cookie", `better-auth.session_token=; Path=/; HttpOnly; Max-Age=0`);
  return c.json({ success: true });
});

authRouter.get("/get-session", async (c) => {
  const authHeader = c.req.header("Authorization");
  const cookieHeader = c.req.header("Cookie");
  let token: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else if (cookieHeader) {
    const match = cookieHeader.match(/better-auth\.session_token=([^;]+)/);
    if (match) token = match[1];
  }

  if (!token) {
    return c.json({ session: null, user: null });
  }

  const sessionData = await validateSessionToken(token);
  if (!sessionData) {
    return c.json({ session: null, user: null });
  }

  return c.json({
    session: sessionData.session,
    user: {
      id: sessionData.user.id,
      email: sessionData.user.email,
      username: sessionData.user.username,
      displayName: sessionData.user.displayName,
      dateOfBirth: sessionData.user.dateOfBirth,
      sex: sessionData.user.sex,
      role: sessionData.user.role,
      onboardingCompletedAt: sessionData.user.onboardingCompletedAt,
    },
  });
});
