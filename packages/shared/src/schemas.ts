import { z } from "zod";
import {
  ApprovalThreshold,
  EnforcementAction,
  PersonCondition,
  ProfileCorrectionField,
  Sex,
} from "./enums.js";

export const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

export function calculateAge(dobString: string): number {
  const birthDate = new Date(dobString);
  if (isNaN(birthDate.getTime())) {
    return 0;
  }
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

export function isAtLeast13(dobString: string): boolean {
  return calculateAge(dobString) >= 13;
}

// User & Auth Schemas
export const SignUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  username: z
    .string()
    .toLowerCase()
    .regex(USERNAME_REGEX, "Username must be 3-20 characters of lowercase letters, numbers, or underscores"),
  displayName: z.string().min(1, "Display name is required").max(50),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be in YYYY-MM-DD format")
    .refine(isAtLeast13, {
      message: "HaloChat is only available for users aged 13 and older.",
    }),
  sex: z.nativeEnum(Sex),
});

export const SignInSchema = z.object({
  emailOrUsername: z.string().min(1),
  password: z.string().min(1),
});

export const EmailSchema = z.object({ email: z.string().email() });

export const TokenSchema = z.object({ token: z.string().min(32) });

export const ResetPasswordSchema = TokenSchema.extend({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const UpdateProfileSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  onboardingCompleted: z.boolean().optional(),
});

export const PushTokenSchema = z.object({
  expoToken: z.string().startsWith("ExponentPushToken[").or(z.string().startsWith("ExpoPushToken[")),
  platform: z.enum(["ios", "android", "web"]),
});

// Angel Assignment & Scope Schemas
export const InviteAngelSchema = z.object({
  angelUserId: z.string().min(1),
  useEarlyReset: z.boolean().default(false),
});

export const UpdateAngelScopeSchema = z.object({
  personConditions: z.array(z.nativeEnum(PersonCondition)).default([]),
  purposeCategories: z.array(z.string()).default([]),
  applyToExisting: z.boolean().default(false),
});

export const AngelDecisionSchema = z.object({
  reasonCode: z.string().optional(),
  shortReason: z.string().max(200).optional(),
});

export const ProtectionSettingsSchema = z.object({
  approvalThreshold: z.nativeEnum(ApprovalThreshold),
});

// Contact Request Schemas
export const CreateContactRequestSchema = z.object({
  recipientId: z.string().min(1),
  purpose: z.string().min(1),
});

export const AngelContactDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "DECLINE"]),
  reasonCode: z.string().optional(),
  shortReason: z.string().max(200).optional(),
});

// Chat & Message Schemas
const BASE64_BYTES = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MlsEnvelopeMetadataSchema = z.object({
  protocol: z.literal("MLS"),
  version: z.literal(1),
  kind: z.enum(["welcome", "application", "commit"]),
}).passthrough().superRefine((metadata, context) => {
  if (metadata.kind === "welcome") {
    if (typeof metadata.keyPackageId !== "string" || metadata.keyPackageId.length < 1 || metadata.keyPackageId.length > 120) {
      context.addIssue({ code: "custom", path: ["keyPackageId"], message: "A claimed KeyPackage ID is required" });
    }
    if (typeof metadata.claimantDeviceId !== "string" || !/^[A-Za-z0-9+/=_-]{20,80}$/.test(metadata.claimantDeviceId)) {
      context.addIssue({ code: "custom", path: ["claimantDeviceId"], message: "A valid claimant device ID is required" });
    }
  }
});

export const SendMessageSchema = z.object({
  ciphertext: z.string().min(1, "Encrypted message content cannot be empty").regex(BASE64_BYTES),
  encryptionMetadata: MlsEnvelopeMetadataSchema,
  clientMsgId: z.string().min(1).max(80).optional(),
}).superRefine((message, context) => {
  if (message.encryptionMetadata.kind === "welcome" && !message.clientMsgId) {
    context.addIssue({ code: "custom", path: ["clientMsgId"], message: "Welcome messages need an idempotency key" });
  }
});

export const PublishChatKeyPackageSchema = z.object({
  deviceId: z.string().min(20).max(80),
  scope: z.string().min(1).max(200).regex(/^(?:PARTICIPANT|WHISPER:[^:\s]{1,80}:[^:\s]{1,80})$/).optional(),
  identity: z.string().min(8).max(256).regex(BASE64_BYTES),
  signatureKey: z.string().min(40).max(128).regex(BASE64_BYTES),
  signatureProof: z.string().min(80).max(128).regex(BASE64_BYTES),
  keyPackage: z.string().min(64).max(16_384).regex(BASE64_BYTES),
});

export const SendWhisperSchema = z.object({
  ciphertext: z.string().min(1).regex(BASE64_BYTES),
  encryptionMetadata: z.object({
    protocol: z.literal("MLS"),
    version: z.literal(1),
    kind: z.literal("whisper"),
  }).passthrough(),
  plaintextCharLength: z.number().int().min(0).max(50, "Whispers are limited to 50 characters"),
});

export const ChatAccessRequestSchema = z.object({
  type: z.enum(["LEAVE", "REJOIN"]),
  angelUserId: z.string().min(1),
  reason: z.string().max(200).optional(),
});

export const ChatAngelInvitationSchema = z.object({
  angelAssignmentId: z.string().min(1),
});

// Safety Schemas
export const BlockUserSchema = z.object({
  userId: z.string().min(1),
});

export const ReportChatSchema = z.object({
  reason: z.string().min(1).max(200),
  details: z.string().max(1000).optional(),
  evidence: z.array(z.string().min(1).max(65_536)).max(20).optional(),
});

// Support & Profile Correction Schemas
export const ProfileCorrectionRequestSchema = z.object({
  field: z.nativeEnum(ProfileCorrectionField),
  proposedValue: z.string().min(1),
  reason: z.string().min(5, "A descriptive reason is required").max(500),
  acknowledgement: z.literal(true, {
    errorMap: () => ({
      message: "You must acknowledge that review may affect conversations or lead to suspension for abuse.",
    }),
  }),
});

// Admin Operations Schemas
export const AdminUserEnforcementSchema = z.object({
  action: z.nativeEnum(EnforcementAction),
  reason: z.string().min(1, "Reason is required"),
  durationDays: z.number().int().positive().optional(),
});

export const AdminRevokeSessionsSchema = z.object({
  reason: z.string().min(1, "Reason is required"),
});

export const AdminResolveReportSchema = z.object({
  decision: z.enum(["RESOLVED", "DISMISSED"]),
  reason: z.string().min(1),
  enforcement: z.nativeEnum(EnforcementAction).optional(),
});

export const AdminResolveCorrectionSchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    reason: z.string().min(1),
    remediation: z.string().optional(),
    noticePlan: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.decision === "APPROVED" && !value.remediation?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remediation"],
        message: "Approved corrections require a remediation plan",
      });
    }
    if (value.decision === "APPROVED" && !value.noticePlan?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["noticePlan"],
        message: "Approved corrections require a notice plan",
      });
    }
  });

export type SignUpInput = z.infer<typeof SignUpSchema>;
export type SignInInput = z.infer<typeof SignInSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;
export type InviteAngelInput = z.infer<typeof InviteAngelSchema>;
export type UpdateAngelScopeInput = z.infer<typeof UpdateAngelScopeSchema>;
export type ProtectionSettingsInput = z.infer<typeof ProtectionSettingsSchema>;
export type CreateContactRequestInput = z.infer<typeof CreateContactRequestSchema>;
export type SendMessageInput = z.infer<typeof SendMessageSchema>;
export type PublishChatKeyPackageInput = z.infer<typeof PublishChatKeyPackageSchema>;
export type SendWhisperInput = z.infer<typeof SendWhisperSchema>;
export type ProfileCorrectionRequestInput = z.infer<typeof ProfileCorrectionRequestSchema>;
