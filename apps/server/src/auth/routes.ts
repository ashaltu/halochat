import crypto from "node:crypto";
import { Hono } from "hono";
import { getDb, users, accounts, sessions, verifications, protectionSettings, auditLogs, eq, or, and } from "@halochat/db";
import { SignUpSchema, SignInSchema, EmailSchema, TokenSchema, ResetPasswordSchema, AuditAction } from "@halochat/shared";
import { hashPassword, verifyPassword, createSession, validateSessionToken } from "./index.js";
import { sendEmail } from "../notifications/email.js";
import { AppEnv } from "../types.js";

export const authRouter = new Hono<AppEnv>();

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

async function createVerification(identifier: string, ttlMs: number) {
  const db = await getDb();
  const token = crypto.randomBytes(32).toString("hex");
  await db.delete(verifications).where(eq(verifications.identifier, identifier));
  await db.insert(verifications).values({
    id: crypto.randomUUID(),
    identifier,
    value: tokenHash(token),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

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

  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const userCount = await db.select().from(users);
  const role =
    adminEmails.includes(email.toLowerCase()) ||
    (process.env.NODE_ENV === "test" && userCount.length === 0)
      ? "admin"
      : "user";
  const emailVerified =
    process.env.NODE_ENV === "test" || process.env.REQUIRE_EMAIL_VERIFICATION === "false";

  await db.insert(users).values({
    id: userId,
    email: email.toLowerCase(),
    username: username.toLowerCase(),
    displayName,
    dateOfBirth,
    sex,
    role,
    emailVerified,
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

  if (!emailVerified) {
    const verificationToken = await createVerification(`email:${userId}`, 24 * 60 * 60 * 1000);
    const publicUrl = process.env.PUBLIC_APP_URL || "http://localhost:3000";
    await sendEmail({
      to: email,
      subject: "Verify your HaloChat email",
      html: `<p>Verify your email:</p><p><a href="${publicUrl}/api/auth/verify-email?token=${verificationToken}">Verify email</a></p>`,
    });
  }

  c.header(
    "Set-Cookie",
    `better-auth.session_token=${session.token}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}; Max-Age=${
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
        emailVerified,
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
    `better-auth.session_token=${session.token}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}; Max-Age=${
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
      emailVerified: user.emailVerified,
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
      emailVerified: sessionData.user.emailVerified,
      onboardingCompletedAt: sessionData.user.onboardingCompletedAt,
    },
  });
});

authRouter.post("/send-verification-email", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = EmailSchema.safeParse(body);
  if (!parsed.success) return c.json({ code: "VALIDATION_ERROR" }, 400);
  const db = await getDb();
  const result = await db.select().from(users).where(eq(users.email, parsed.data.email.toLowerCase()));
  if (result[0] && !result[0].emailVerified) {
    const token = await createVerification(`email:${result[0].id}`, 24 * 60 * 60 * 1000);
    const publicUrl = process.env.PUBLIC_APP_URL || "http://localhost:3000";
    await sendEmail({
      to: result[0].email,
      subject: "Verify your HaloChat email",
      html: `<p><a href="${publicUrl}/api/auth/verify-email?token=${token}">Verify email</a></p>`,
    });
  }
  return c.json({ success: true });
});

authRouter.get("/verify-email", async (c) => {
  const parsed = TokenSchema.safeParse({ token: c.req.query("token") });
  if (!parsed.success) return c.json({ code: "INVALID_TOKEN" }, 400);
  const db = await getDb();
  const rows = await db.select().from(verifications).where(eq(verifications.value, tokenHash(parsed.data.token)));
  const verification = rows.find((row) => row.identifier.startsWith("email:"));
  if (!verification || verification.expiresAt < new Date()) {
    return c.json({ code: "INVALID_TOKEN", message: "Verification link is invalid or expired" }, 400);
  }
  const userId = verification.identifier.slice(6);
  await db.update(users).set({ emailVerified: true, updatedAt: new Date() }).where(eq(users.id, userId));
  await db.delete(verifications).where(eq(verifications.id, verification.id));
  return c.json({ success: true });
});

authRouter.post("/forget-password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = EmailSchema.safeParse(body);
  if (!parsed.success) return c.json({ code: "VALIDATION_ERROR" }, 400);
  const db = await getDb();
  const result = await db.select().from(users).where(eq(users.email, parsed.data.email.toLowerCase()));
  if (result[0]) {
    const token = await createVerification(`reset:${result[0].id}`, 60 * 60 * 1000);
    const publicUrl = process.env.PUBLIC_APP_URL || "http://localhost:8081";
    await sendEmail({
      to: result[0].email,
      subject: "Reset your HaloChat password",
      html: `<p><a href="${publicUrl}/auth/reset-password?token=${token}">Reset password</a></p>`,
    });
  }
  return c.json({ success: true });
});

authRouter.post("/reset-password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResetPasswordSchema.safeParse(body);
  if (!parsed.success) return c.json({ code: "VALIDATION_ERROR" }, 400);
  const db = await getDb();
  const rows = await db.select().from(verifications).where(eq(verifications.value, tokenHash(parsed.data.token)));
  const verification = rows.find((row) => row.identifier.startsWith("reset:"));
  if (!verification || verification.expiresAt < new Date()) {
    return c.json({ code: "INVALID_TOKEN", message: "Reset link is invalid or expired" }, 400);
  }
  const userId = verification.identifier.slice(6);
  await db
    .update(accounts)
    .set({ password: hashPassword(parsed.data.password), updatedAt: new Date() })
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(verifications).where(eq(verifications.id, verification.id));
  return c.json({ success: true });
});
