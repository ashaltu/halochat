import { Hono } from "hono";
import { getDb, users, sessions, eq } from "@halochat/db";
import { SignUpSchema, SignInSchema, EmailSchema, ResetPasswordSchema } from "@halochat/shared";
import { validateSessionToken } from "./index.js";
import { AppEnv } from "../types.js";
import { getHaloAuth } from "./better-auth.js";

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
  const auth = await getHaloAuth();
  const response = await auth.handler(
    new Request(`${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/api/auth/sign-up/email`, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify({
        email: email.toLowerCase(),
        password,
        name: displayName,
        username: username.toLowerCase(),
        dateOfBirth,
        sex,
      }),
    })
  );
  if (!response.ok) return response;

  const payload = (await response.json()) as { token: string };
  const db = await getDb();
  const user = (await db.select().from(users).where(eq(users.email, email.toLowerCase())))[0];
  const session = (await db.select().from(sessions).where(eq(sessions.token, payload.token)))[0];
  const cookie = response.headers.get("set-cookie");
  if (cookie) c.header("Set-Cookie", cookie);

  return c.json(
    {
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
  const auth = await getHaloAuth();
  const endpoint = emailOrUsername.includes("@") ? "sign-in/email" : "sign-in/username";
  const response = await auth.handler(
    new Request(`${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/api/auth/${endpoint}`, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(
        endpoint.endsWith("username")
          ? { username: emailOrUsername.toLowerCase(), password }
          : { email: emailOrUsername.toLowerCase(), password }
      ),
    })
  );
  if (!response.ok) return response;

  const payload = (await response.json()) as { token?: string; twoFactorRedirect?: boolean };
  const cookie = response.headers.get("set-cookie");
  if (cookie) c.header("Set-Cookie", cookie);
  if (payload.twoFactorRedirect || !payload.token) {
    return c.json({ twoFactorRequired: true }, 202);
  }

  const db = await getDb();
  const session = (await db.select().from(sessions).where(eq(sessions.token, payload.token)))[0];
  const user = (await db.select().from(users).where(eq(users.id, session.userId)))[0];

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
    if (match) token = decodeURIComponent(match[1]).split(".")[0];
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
    if (match) token = decodeURIComponent(match[1]).split(".")[0];
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
      twoFactorEnabled: sessionData.user.twoFactorEnabled,
      emailVerified: sessionData.user.emailVerified,
      onboardingCompletedAt: sessionData.user.onboardingCompletedAt,
    },
  });
});

authRouter.post("/send-verification-email", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = EmailSchema.safeParse(body);
  if (!parsed.success) return c.json({ code: "VALIDATION_ERROR" }, 400);
  const auth = await getHaloAuth();
  return auth.handler(
    new Request(`${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/api/auth/send-verification-email`, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify({
        email: parsed.data.email.toLowerCase(),
        callbackURL: process.env.PUBLIC_APP_URL || "http://localhost:8081",
      }),
    })
  );
});

authRouter.get("/verify-email", async (c) => {
  return (await getHaloAuth()).handler(c.req.raw);
});

authRouter.post("/forget-password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = EmailSchema.safeParse(body);
  if (!parsed.success) return c.json({ code: "VALIDATION_ERROR" }, 400);
  const auth = await getHaloAuth();
  return auth.handler(
    new Request(`${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/api/auth/forget-password`, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify({
        email: parsed.data.email.toLowerCase(),
        redirectTo: `${process.env.PUBLIC_APP_URL || "http://localhost:8081"}/auth/reset-password`,
      }),
    })
  );
});

authRouter.post("/reset-password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResetPasswordSchema.safeParse(body);
  if (!parsed.success) return c.json({ code: "VALIDATION_ERROR" }, 400);
  const auth = await getHaloAuth();
  return auth.handler(
    new Request(`${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/api/auth/reset-password`, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify({ token: parsed.data.token, newPassword: parsed.data.password }),
    })
  );
});

authRouter.all("/*", async (c) => {
  const auth = await getHaloAuth();
  return auth.handler(c.req.raw);
});
