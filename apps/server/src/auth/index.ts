import crypto from "node:crypto";
import { getDb, users, sessions, accounts, protectionSettings, eq, or } from "@halochat/db";
import { Context, Next } from "hono";
import { SignUpSchema } from "@halochat/shared";
import { AppEnv } from "../types.js";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) return false;
  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

export async function createSession(userId: string, reqHeaders?: Headers) {
  const db = await getDb();
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  const sessionId = crypto.randomUUID();

  await db.insert(sessions).values({
    id: sessionId,
    userId,
    token,
    expiresAt,
    userAgent: reqHeaders?.get("user-agent") || null,
  });

  return { id: sessionId, token, expiresAt };
}

export async function validateSessionToken(token: string) {
  const db = await getDb();
  const result = await db
    .select({
      session: sessions,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.token, token));

  if (result.length === 0) {
    return null;
  }

  const { session, user } = result[0];
  if (new Date() > new Date(session.expiresAt)) {
    await db.delete(sessions).where(eq(sessions.id, session.id));
    return null;
  }

  if (user.banned) {
    return null;
  }

  if (user.restrictedUntil && new Date(user.restrictedUntil) > new Date()) {
    return null;
  }

  return { session, user };
}

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  const cookieHeader = c.req.header("Cookie");

  let token: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else if (cookieHeader) {
    const match = cookieHeader.match(/better-auth\.session_token=([^;]+)/);
    if (match) {
      token = match[1];
    }
  }

  if (!token) {
    return c.json({ code: "UNAUTHORIZED", message: "Authentication required" }, 401);
  }

  const sessionData = await validateSessionToken(token);
  if (!sessionData) {
    return c.json({ code: "UNAUTHORIZED", message: "Invalid or expired session" }, 401);
  }

  c.set("user", sessionData.user);
  c.set("session", sessionData.session);
  await next();
}

export async function adminMiddleware(c: Context<AppEnv>, next: Next) {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ code: "FORBIDDEN", message: "Admin access required" }, 403);
  }
  await next();
}
