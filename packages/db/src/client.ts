import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePgLite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DB = ReturnType<typeof drizzlePgLite<typeof schema>> | ReturnType<typeof drizzlePostgres<typeof schema>>;

let globalDb: DB | null = null;
let pgliteInstance: PGlite | null = null;

export async function createDatabase(databaseUrl?: string): Promise<DB> {
  if (databaseUrl && databaseUrl.startsWith("postgres")) {
    const client = postgres(databaseUrl);
    return drizzlePostgres(client, { schema });
  }

  // Use embedded PGlite for local development and tests without external dependencies
  if (!pgliteInstance) {
    pgliteInstance = new PGlite();
  }
  return drizzlePgLite(pgliteInstance, { schema });
}

export async function getDb(): Promise<DB> {
  if (!globalDb) {
    globalDb = await createDatabase(process.env.DATABASE_URL);
  }
  return globalDb;
}

export async function closeDb(): Promise<void> {
  if (pgliteInstance) {
    await pgliteInstance.close();
    pgliteInstance = null;
  } else if (globalDb && "$client" in globalDb) {
    await (globalDb as any).$client.end?.();
  }
  globalDb = null;
}

export async function initDbSchema(db: DB) {
  // Executes DDL to create tables if they do not exist
  const ddlStatements = [
    `CREATE TABLE IF NOT EXISTS "user" (
      "id" text PRIMARY KEY,
      "email" text NOT NULL UNIQUE,
      "username" text NOT NULL UNIQUE,
      "display_username" text,
      "display_name" text NOT NULL,
      "image" text,
      "date_of_birth" text NOT NULL,
      "sex" text NOT NULL,
      "onboarding_completed_at" timestamp,
      "role" text NOT NULL DEFAULT 'user',
      "banned" boolean NOT NULL DEFAULT false,
      "ban_reason" text,
      "ban_expires" timestamp,
      "two_factor_enabled" boolean NOT NULL DEFAULT false,
      "email_verified" boolean NOT NULL DEFAULT false,
      "enforcement_action" text,
      "restricted_until" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "token" text NOT NULL UNIQUE,
      "expires_at" timestamp NOT NULL,
      "ip_address" text,
      "user_agent" text,
      "impersonated_by" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "account" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "account_id" text NOT NULL,
      "provider_id" text NOT NULL,
      "password" text,
      "access_token" text,
      "refresh_token" text,
      "id_token" text,
      "access_token_expires_at" timestamp,
      "refresh_token_expires_at" timestamp,
      "scope" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "verification" (
      "id" text PRIMARY KEY,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expires_at" timestamp NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "two_factor" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "secret" text NOT NULL,
      "backup_codes" text NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS "angel_assignment" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "angel_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "status" text NOT NULL DEFAULT 'PENDING',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "accepted_at" timestamp
    );`,
    `CREATE TABLE IF NOT EXISTS "protection_settings" (
      "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
      "approval_threshold" text NOT NULL DEFAULT 'ANY_ONE'
    );`,
    `CREATE TABLE IF NOT EXISTS "angel_condition" (
      "id" text PRIMARY KEY,
      "angel_assignment_id" text NOT NULL REFERENCES "angel_assignment"("id") ON DELETE CASCADE,
      "person_conditions" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "purpose_categories" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "combination" text NOT NULL DEFAULT 'OR'
    );`,
    `CREATE TABLE IF NOT EXISTS "contact_request" (
      "id" text PRIMARY KEY,
      "requester_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "recipient_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "purpose" text NOT NULL,
      "state" text NOT NULL DEFAULT 'PENDING_RECIPIENT',
      "recipient_decided_at" timestamp,
      "chat_id" text,
      "requester_approval_threshold" text NOT NULL DEFAULT 'ANY_ONE',
      "recipient_approval_threshold" text NOT NULL DEFAULT 'ANY_ONE',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "contact_request_angel" (
      "id" text PRIMARY KEY,
      "request_id" text NOT NULL REFERENCES "contact_request"("id") ON DELETE CASCADE,
      "side" text NOT NULL,
      "angel_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "status" text NOT NULL DEFAULT 'PENDING',
      "reason_code" text,
      "short_reason" text,
      "decided_at" timestamp
    );`,
    `CREATE TABLE IF NOT EXISTS "chat" (
      "id" text PRIMARY KEY,
      "requester_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "recipient_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "mode" text NOT NULL DEFAULT 'COMFORT',
      "status" text NOT NULL DEFAULT 'ACTIVE',
      "ended_by" text,
      "last_message_at" timestamp,
      "purpose" text NOT NULL DEFAULT 'Other',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "message" (
      "id" text PRIMARY KEY,
      "chat_id" text NOT NULL REFERENCES "chat"("id") ON DELETE CASCADE,
      "sender_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "ciphertext" text NOT NULL,
      "encryption_metadata" jsonb,
      "seq" integer NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "crypto_key_package" (
      "id" text PRIMARY KEY,
      "chat_id" text NOT NULL REFERENCES "chat"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "device_id" text NOT NULL,
      "scope" text NOT NULL DEFAULT 'PARTICIPANT',
      "identity" text NOT NULL,
      "signature_key" text NOT NULL,
      "key_package" text NOT NULL,
      "consumed_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "whisper" (
      "id" text PRIMARY KEY,
      "chat_id" text NOT NULL REFERENCES "chat"("id") ON DELETE CASCADE,
      "angel_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "to_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "ciphertext" text NOT NULL,
      "encryption_metadata" jsonb,
      "created_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "chat_angel_access" (
      "id" text PRIMARY KEY,
      "chat_id" text NOT NULL REFERENCES "chat"("id") ON DELETE CASCADE,
      "angel_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "angel_assignment_id" text NOT NULL REFERENCES "angel_assignment"("id") ON DELETE CASCADE,
      "authorized_from" timestamp NOT NULL DEFAULT now(),
      "authorized_until" timestamp
    );`,
    `CREATE TABLE IF NOT EXISTS "angel_send_restriction" (
      "id" text PRIMARY KEY,
      "chat_id" text NOT NULL REFERENCES "chat"("id") ON DELETE CASCADE,
      "angel_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "protected_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "lifted_at" timestamp
    );`,
    `CREATE TABLE IF NOT EXISTS "angel_access_request" (
      "id" text PRIMARY KEY,
      "chat_id" text NOT NULL REFERENCES "chat"("id") ON DELETE CASCADE,
      "angel_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "type" text NOT NULL,
      "state" text NOT NULL DEFAULT 'PENDING',
      "requested_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "reason" text,
      "decided_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "angel_trust_cooldown" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "angel_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "removed_at" timestamp NOT NULL DEFAULT now(),
      "cooldown_until" timestamp NOT NULL,
      "resets_remaining" integer NOT NULL DEFAULT 3,
      "reset_period_start" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "block" (
      "id" text PRIMARY KEY,
      "blocker_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "blocked_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "created_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "report" (
      "id" text PRIMARY KEY,
      "reporter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "chat_id" text NOT NULL REFERENCES "chat"("id") ON DELETE CASCADE,
      "reported_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "reason" text NOT NULL,
      "details" text,
      "evidence" jsonb,
      "state" text NOT NULL DEFAULT 'PENDING',
      "resolved_at" timestamp,
      "resolved_by" text,
      "resolution_notes" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    );`,
    `CREATE TABLE IF NOT EXISTS "profile_correction_request" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "field" text NOT NULL,
      "proposed_value" text NOT NULL,
      "reason" text NOT NULL,
      "acknowledged_at" timestamp NOT NULL DEFAULT now(),
      "impact_report" jsonb NOT NULL,
      "status" text NOT NULL DEFAULT 'PENDING',
      "reviewed_by" text,
      "resolution" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "resolved_at" timestamp
    );`,
    `CREATE TABLE IF NOT EXISTS "audit_log" (
      "id" text PRIMARY KEY,
      "actor_id" text,
      "action" text NOT NULL,
      "target_type" text NOT NULL,
      "target_id" text NOT NULL,
      "meta" jsonb,
      "created_at" timestamp NOT NULL DEFAULT now()
    );`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "email_verified" boolean NOT NULL DEFAULT false;`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "display_username" text;`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "image" text;`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "ban_expires" timestamp;`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean NOT NULL DEFAULT false;`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "enforcement_action" text;`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "restricted_until" timestamp;`,
    `ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "impersonated_by" text;`,
    `ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "access_token" text;`,
    `ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "refresh_token" text;`,
    `ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "id_token" text;`,
    `ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "access_token_expires_at" timestamp;`,
    `ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamp;`,
    `ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "scope" text;`,
    `ALTER TABLE "contact_request" ADD COLUMN IF NOT EXISTS "requester_approval_threshold" text NOT NULL DEFAULT 'ANY_ONE';`,
    `ALTER TABLE "contact_request" ADD COLUMN IF NOT EXISTS "recipient_approval_threshold" text NOT NULL DEFAULT 'ANY_ONE';`,
    `ALTER TABLE "chat" ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'Other';`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "message_chat_seq_unique" ON "message" ("chat_id", "seq");`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "crypto_key_package_scope_device_unique" ON "crypto_key_package" ("chat_id", "user_id", "device_id", "scope");`,
    `CREATE TABLE IF NOT EXISTS "push_token" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "expo_token" text NOT NULL,
      "platform" text NOT NULL,
      "updated_at" timestamp NOT NULL DEFAULT now()
    );`,
  ];

  for (const statement of ddlStatements) {
    if ("$client" in db && typeof (db as any).$client?.query === "function") {
      await (db as any).$client.query(statement);
    } else if ("session" in db && typeof (db as any).session?.client?.query === "function") {
      await (db as any).session.client.query(statement);
    } else if (typeof (db as any).execute === "function") {
      await (db as any).execute(statement);
    }
  }
}
