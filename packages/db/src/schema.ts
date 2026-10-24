import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// 1. User table (Better Auth compatible + HaloChat extensions)
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  displayUsername: text("display_username"),
  displayName: text("display_name").notNull(),
  image: text("image"),
  dateOfBirth: text("date_of_birth").notNull(),
  sex: text("sex").notNull(), // 'MALE' | 'FEMALE'
  onboardingCompletedAt: timestamp("onboarding_completed_at"),
  role: text("role").notNull().default("user"), // 'user' | 'admin'
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  emailVerified: boolean("email_verified").notNull().default(false),
  enforcementAction: text("enforcement_action"),
  restrictedUntil: timestamp("restricted_until"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// 2. Session table (Better Auth)
export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  impersonatedBy: text("impersonated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// 3. Account table (Better Auth)
export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  password: text("password"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// 4. Verification table (Better Auth)
export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const twoFactors = pgTable("two_factor", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
});

// 5. Angel Assignment
export const angelAssignments = pgTable("angel_assignment", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  angelUserId: text("angel_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("PENDING"), // 'PENDING' | 'ACTIVE' | 'DECLINED' | 'REMOVED'
  createdAt: timestamp("created_at").notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at"),
});

// 6. Protection Settings
export const protectionSettings = pgTable("protection_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  approvalThreshold: text("approval_threshold").notNull().default("ANY_ONE"), // 'ANY_ONE' | 'ALL'
});

// 7. Angel Condition
export const angelConditions = pgTable("angel_condition", {
  id: text("id").primaryKey(),
  angelAssignmentId: text("angel_assignment_id")
    .notNull()
    .references(() => angelAssignments.id, { onDelete: "cascade" }),
  personConditions: jsonb("person_conditions").notNull().$type<string[]>(),
  purposeCategories: jsonb("purpose_categories").notNull().$type<string[]>(),
  combination: text("combination").notNull().default("OR"), // 'AND' | 'OR'
});

// 8. Contact Request
export const contactRequests = pgTable("contact_request", {
  id: text("id").primaryKey(),
  requesterUserId: text("requester_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  recipientUserId: text("recipient_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  state: text("state").notNull().default("PENDING_RECIPIENT"),
  recipientDecidedAt: timestamp("recipient_decided_at"),
  chatId: text("chat_id"),
  requesterApprovalThreshold: text("requester_approval_threshold").notNull().default("ANY_ONE"),
  recipientApprovalThreshold: text("recipient_approval_threshold").notNull().default("ANY_ONE"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// 9. Contact Request Angel Decisions
export const contactRequestAngels = pgTable("contact_request_angel", {
  id: text("id").primaryKey(),
  requestId: text("request_id")
    .notNull()
    .references(() => contactRequests.id, { onDelete: "cascade" }),
  side: text("side").notNull(), // 'REQUESTER' | 'RECIPIENT'
  angelUserId: text("angel_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("PENDING"), // 'PENDING' | 'APPROVED' | 'DECLINED'
  reasonCode: text("reason_code"),
  shortReason: text("short_reason"),
  decidedAt: timestamp("decided_at"),
});

// 10. Chat
export const chats = pgTable("chat", {
  id: text("id").primaryKey(),
  requesterUserId: text("requester_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  recipientUserId: text("recipient_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("COMFORT"), // 'COMFORT' | 'PROTECTED'
  status: text("status").notNull().default("ACTIVE"), // 'ACTIVE' | 'ENDED'
  endedBy: text("ended_by"),
  lastMessageAt: timestamp("last_message_at"),
  purpose: text("purpose").notNull().default("Other"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// 11. Message
export const messages = pgTable("message", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  senderId: text("sender_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  clientMsgId: text("client_msg_id"),
  ciphertext: text("ciphertext").notNull(),
  encryptionMetadata: jsonb("encryption_metadata"),
  seq: integer("seq").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("message_chat_seq_unique").on(table.chatId, table.seq),
  uniqueIndex("message_sender_client_id_unique").on(table.senderId, table.clientMsgId),
]);

export const cryptoKeyPackages = pgTable("crypto_key_package", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),
  scope: text("scope").notNull().default("PARTICIPANT"),
  identity: text("identity").notNull(),
  signatureKey: text("signature_key").notNull(),
  signatureProof: text("signature_proof"),
  keyPackage: text("key_package").notNull(),
  claimedByDeviceId: text("claimed_by_device_id"),
  consumedAt: timestamp("consumed_at"),
  consumedByClientMsgId: text("consumed_by_client_msg_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("crypto_key_package_scope_device_unique").on(table.chatId, table.userId, table.deviceId, table.scope),
]);

// 12. Whisper
export const whispers = pgTable("whisper", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  angelUserId: text("angel_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  toUserId: text("to_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  ciphertext: text("ciphertext").notNull(),
  encryptionMetadata: jsonb("encryption_metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 13. Chat Angel Access
export const chatAngelAccess = pgTable("chat_angel_access", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  angelUserId: text("angel_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  angelAssignmentId: text("angel_assignment_id")
    .notNull()
    .references(() => angelAssignments.id, { onDelete: "cascade" }),
  authorizedFrom: timestamp("authorized_from").notNull().defaultNow(),
  authorizedUntil: timestamp("authorized_until"),
});

// 14. Angel Send Restriction
export const angelSendRestrictions = pgTable("angel_send_restriction", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  angelUserId: text("angel_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  protectedUserId: text("protected_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  liftedAt: timestamp("lifted_at"),
});

// 15. Angel Access Request
export const angelAccessRequests = pgTable("angel_access_request", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  angelUserId: text("angel_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'LEAVE' | 'REJOIN'
  state: text("state").notNull().default("PENDING"), // 'PENDING' | 'ACCEPTED' | 'DECLINED'
  requestedBy: text("requested_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason"),
  decidedAt: timestamp("decided_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 16. Angel Trust Cooldown
export const angelTrustCooldowns = pgTable("angel_trust_cooldown", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  angelUserId: text("angel_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  removedAt: timestamp("removed_at").notNull().defaultNow(),
  cooldownUntil: timestamp("cooldown_until").notNull(),
  resetsRemaining: integer("resets_remaining").notNull().default(3),
  resetPeriodStart: timestamp("reset_period_start").notNull().defaultNow(),
});

// 17. Block
export const blocks = pgTable("block", {
  id: text("id").primaryKey(),
  blockerId: text("blocker_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  blockedId: text("blocked_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 18. Report
export const reports = pgTable("report", {
  id: text("id").primaryKey(),
  reporterId: text("reporter_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  reportedUserId: text("reported_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  details: text("details"),
  evidence: jsonb("evidence").$type<string[]>(),
  state: text("state").notNull().default("PENDING"), // 'PENDING' | 'RESOLVED' | 'DISMISSED'
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: text("resolved_by"),
  resolutionNotes: text("resolution_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 19. Profile Correction Request
export const profileCorrectionRequests = pgTable("profile_correction_request", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  field: text("field").notNull(), // 'DOB' | 'SEX'
  proposedValue: text("proposed_value").notNull(),
  reason: text("reason").notNull(),
  acknowledgedAt: timestamp("acknowledged_at").notNull().defaultNow(),
  impactReport: jsonb("impact_report").notNull(),
  status: text("status").notNull().default("PENDING"), // 'PENDING' | 'APPROVED' | 'REJECTED'
  reviewedBy: text("reviewed_by"),
  resolution: text("resolution"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// 20. Audit Log
export const auditLogs = pgTable("audit_log", {
  id: text("id").primaryKey(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// 21. Push Token
export const pushTokens = pgTable("push_token", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expoToken: text("expo_token").notNull(),
  platform: text("platform").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
