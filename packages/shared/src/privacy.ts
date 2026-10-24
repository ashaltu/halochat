import { ChatMode, ChatStatus, ContactRequestState } from "./enums.js";

export interface MessageRecord {
  id: string;
  chatId: string;
  senderId: string;
  ciphertext: string;
  encryptionMetadata?: Record<string, unknown> | null;
  seq: number;
  createdAt: string;
}

export interface AngelAccessPeriod {
  authorizedFrom: string;
  authorizedUntil: string | null;
}

export interface TimelineGapNotice {
  isGapNotice: true;
  from: string;
  until: string;
  message: string;
}

export type TimelineItem = MessageRecord | TimelineGapNotice;

export function isParticipantOnlyMessage(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const envelope = metadata as Record<string, unknown>;
  return envelope.protocol === "MLS" && envelope.version === 1 && envelope.kind === "welcome";
}

/**
 * Filters message history for an Angel based on their authorized access periods (D6).
 * Inserts timeline notices for gaps when access was inactive.
 */
export function filterMessagesForAngel(
  messages: MessageRecord[],
  accessPeriods: AngelAccessPeriod[]
): TimelineItem[] {
  if (accessPeriods.length === 0) {
    return [];
  }

  // Sort periods chronologically
  const sortedPeriods = [...accessPeriods].sort(
    (a, b) => new Date(a.authorizedFrom).getTime() - new Date(b.authorizedFrom).getTime()
  );

  const result: TimelineItem[] = [];

  // Group messages into authorized periods and create gap notices between periods
  for (let i = 0; i < sortedPeriods.length; i++) {
    const currentPeriod = sortedPeriods[i];
    const fromTime = new Date(currentPeriod.authorizedFrom).getTime();
    const untilTime = currentPeriod.authorizedUntil
      ? new Date(currentPeriod.authorizedUntil).getTime()
      : Infinity;

    // Check if there was a gap between previous period and this period
    if (i > 0) {
      const prevPeriod = sortedPeriods[i - 1];
      if (prevPeriod.authorizedUntil) {
        const gapStart = prevPeriod.authorizedUntil;
        const gapEnd = currentPeriod.authorizedFrom;
        result.push({
          isGapNotice: true,
          from: gapStart,
          until: gapEnd,
          message: `Access inactive from ${gapStart} until ${gapEnd}`,
        });
      }
    }

    // Filter messages belonging to this authorized period
    const periodMessages = messages.filter((msg) => {
      if (isParticipantOnlyMessage(msg.encryptionMetadata)) return false;
      const msgTime = new Date(msg.createdAt).getTime();
      return msgTime >= fromTime && msgTime <= untilTime;
    });

    result.push(...periodMessages);
  }

  return result;
}

export interface ChatDTO {
  id: string;
  requesterUserId: string;
  recipientUserId: string;
  mode: ChatMode;
  status: ChatStatus;
  endedBy?: string | null;
  lastMessageAt?: string | null;
  createdAt: string;
  ownAngels?: {
    id: string;
    authorizedFrom?: string;
    angelUserId: string;
    angelUsername?: string;
    angelDisplayName?: string;
    status: string;
    hasActiveRestriction: boolean;
  }[];
  ownAngelAccessPeriods?: {
    id: string;
    angelUserId: string;
    authorizedFrom: string;
    authorizedUntil: string | null;
  }[];
  isSendingRestricted?: boolean;
}

/**
 * Filters chat metadata for a participant (requester or recipient).
 * Never exposes the other participant's Angels, Angel identities, or Angel counts (§5.1).
 */
export function sanitizeChatForParticipant(
  chat: ChatDTO,
  viewerUserId: string,
  ownAngels: {
    id: string;
    authorizedFrom?: string;
    angelUserId: string;
    angelUsername?: string;
    angelDisplayName?: string;
    status: string;
    hasActiveRestriction: boolean;
  }[] = [],
  activeRestrictionsOnViewer: boolean = false,
  ownAngelAccessPeriods: NonNullable<ChatDTO["ownAngelAccessPeriods"]> = [],
): ChatDTO {
  return {
    id: chat.id,
    requesterUserId: chat.requesterUserId,
    recipientUserId: chat.recipientUserId,
    mode: chat.mode,
    status: chat.status,
    // Hide endedBy if ended by an Angel to keep Angel identity private (D13)
    endedBy: chat.status === ChatStatus.ENDED ? (chat.endedBy === viewerUserId ? viewerUserId : "OTHER") : null,
    lastMessageAt: chat.lastMessageAt,
    createdAt: chat.createdAt,
    ownAngels: ownAngels,
    ownAngelAccessPeriods,
    isSendingRestricted: activeRestrictionsOnViewer,
  };
}

/**
 * Filters contact request for the requester.
 * Ensures that requester sees only PENDING / ACCEPTED / DECLINED and never learns
 * whether recipient or Angel declined, or recipient's Angel identities (D10, §5.1).
 */
export function sanitizeRequestForRequester(request: {
  id: string;
  requesterUserId: string;
  recipientUserId: string;
  purpose: string;
  state: ContactRequestState;
  createdAt: string;
  updatedAt: string;
}) {
  let displayState: "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED" = "PENDING";
  if (request.state === ContactRequestState.ACCEPTED) {
    displayState = "ACCEPTED";
  } else if (
    request.state === ContactRequestState.DECLINED_BY_RECIPIENT ||
    request.state === ContactRequestState.DECLINED_BY_ANGEL
  ) {
    displayState = "DECLINED";
  } else if (request.state === ContactRequestState.CANCELLED) {
    displayState = "CANCELLED";
  }

  return {
    id: request.id,
    requesterUserId: request.requesterUserId,
    recipientUserId: request.recipientUserId,
    purpose: request.purpose,
    state: displayState,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}
