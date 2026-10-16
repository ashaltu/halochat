import crypto from "node:crypto";
import { expo } from "@better-auth/expo";
import {
  accounts,
  auditLogs,
  getDb,
  protectionSettings,
  sessions,
  twoFactors,
  users,
  verifications,
} from "@halochat/db";
import { AuditAction } from "@halochat/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, twoFactor, username } from "better-auth/plugins";
import { sendEmail } from "../notifications/email.js";
import { hashPassword, verifyPassword } from "./index.js";

let authPromise: ReturnType<typeof createHaloAuth> | null = null;

export function getHaloAuth() {
  return (authPromise ??= createHaloAuth());
}

async function createHaloAuth() {
  const db = await getDb();
  const secret = process.env.BETTER_AUTH_SECRET ||
    (process.env.NODE_ENV === "production" ? "" : "halochat-development-secret-change-me");
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required in production");

  return betterAuth({
    appName: "HaloChat",
    secret,
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    database: drizzleAdapter(db as any, {
      provider: "pg",
      schema: { users, sessions, accounts, verifications, twoFactors },
      usePlural: true,
    }),
    user: {
      fields: { name: "displayName" },
      additionalFields: {
        dateOfBirth: { type: "string", required: true },
        sex: { type: "string", required: true },
        onboardingCompletedAt: { type: "date", required: false, input: false },
        enforcementAction: { type: "string", required: false, input: false, returned: false },
        restrictedUntil: { type: "date", required: false, input: false, returned: false },
      },
    },
    session: { expiresIn: 30 * 24 * 60 * 60 },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification:
        process.env.NODE_ENV !== "test" && process.env.REQUIRE_EMAIL_VERIFICATION !== "false",
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: async (password) => hashPassword(password),
        verify: async ({ password, hash }) => verifyPassword(password, hash),
      },
      sendResetPassword: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Reset your HaloChat password",
          html: `<p><a href="${url}">Reset password</a></p>`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: process.env.NODE_ENV !== "test",
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Verify your HaloChat email",
          html: `<p><a href="${url}">Verify email</a></p>`,
        });
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const adminEmails = (process.env.ADMIN_EMAILS || "")
              .split(",")
              .map((value) => value.trim().toLowerCase())
              .filter(Boolean);
            const existingUsers = await db.select({ id: users.id }).from(users).limit(1);
            const role =
              adminEmails.includes(user.email.toLowerCase()) ||
              (process.env.NODE_ENV === "test" && existingUsers.length === 0)
                ? "admin"
                : "user";
            return {
              data: {
                ...user,
                role,
                emailVerified:
                  process.env.NODE_ENV === "test" ||
                  process.env.REQUIRE_EMAIL_VERIFICATION === "false"
                    ? true
                    : user.emailVerified,
              },
            };
          },
          after: async (user) => {
            await db.insert(protectionSettings).values({
              userId: user.id,
              approvalThreshold: "ANY_ONE",
            });
            await db.insert(auditLogs).values({
              id: crypto.randomUUID(),
              actorId: user.id,
              action: AuditAction.USER_SIGNUP,
              targetType: "user",
              targetId: user.id,
            });
          },
        },
      },
    },
    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 20 }),
      admin(),
      twoFactor({ issuer: "HaloChat" }),
      expo() as any,
    ],
    trustedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:8081,http://localhost:3001")
      .split(",")
      .map((origin) => origin.trim()),
    rateLimit: { enabled: process.env.NODE_ENV !== "test", window: 60, max: 100 },
  });
}
