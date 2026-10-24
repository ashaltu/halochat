import {
  decryptWhisper,
  ensureChatE2ee,
  hasWhisperGroupState,
  ensureWhisperGroup,
  fetchAndDecryptChatMessages,
  forwardChatMessagesToAngel,
  type WhisperEnvelope,
} from "./session.js";
import { apiRequest } from "../api/client.js";

export type AngelForwardingChat = {
  id: string;
  requesterUserId: string;
  recipientUserId: string;
  mode: string;
  status: string;
  ownAngels?: Array<{ id: string; angelUserId: string; authorizedFrom: string }>;
  ownAngelAccessPeriods?: Array<{
    id: string;
    angelUserId: string;
    authorizedFrom: string;
    authorizedUntil: string | null;
  }>;
};

const completedAccessPeriods = new Set<string>();

export async function syncAngelForwardingForChat(userId: string, chat: AngelForwardingChat) {
  const activeAngels = chat.ownAngels ?? [];
  const periods = chat.ownAngelAccessPeriods ?? activeAngels.map((angel) => ({
    ...angel,
    authorizedUntil: null,
  }));
  if (chat.status !== "ACTIVE" || chat.mode !== "PROTECTED" || !periods.length) {
    return { state: "idle" as const, waitingCount: 0 };
  }

  const partnerUserId = chat.requesterUserId === userId ? chat.recipientUserId : chat.requesterUserId;
  if (await ensureChatE2ee(userId, chat.id, partnerUserId, chat.requesterUserId) === "waiting") {
    return { state: "waiting" as const, waitingCount: 0 };
  }

  const inbox = await apiRequest<{ whispers: WhisperEnvelope[] }>(`/api/v1/chats/${chat.id}/whispers`);
  for (const whisper of [...inbox.whispers].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const accessId = whisper.encryptionMetadata && typeof whisper.encryptionMetadata.accessId === "string"
      ? whisper.encryptionMetadata.accessId
      : null;
    const period = periods.find((candidate) => candidate.id === accessId && candidate.angelUserId === whisper.angelUserId);
    if (!period) continue;
    await decryptWhisper(userId, chat.id, userId, period.angelUserId, whisper);
  }

  const groups = await Promise.all(periods.map((period) => {
    const active = activeAngels.some((angel) => angel.id === period.id);
    return active
      ? ensureWhisperGroup(userId, chat.id, userId, period.angelUserId, period.id)
      : hasWhisperGroupState(userId, chat.id, period.angelUserId, period.id).then((ready) => ready ? "ready" as const : "waiting" as const);
  }));
  const accessKeys = periods.map((period) => `${userId}:${chat.id}:${period.id}`);
  const needsHistory = groups.includes("waiting") || accessKeys.some((key) => !completedAccessPeriods.has(key));
  const messages = await fetchAndDecryptChatMessages(userId, chat.id, needsHistory);
  let waitingCount = groups.filter((state) => state === "waiting").length;

  for (let index = 0; index < periods.length; index++) {
    const period = periods[index];
    if (groups[index] === "waiting") continue;
    const authorizedFrom = new Date(period.authorizedFrom).getTime();
    const authorizedUntil = period.authorizedUntil ? new Date(period.authorizedUntil).getTime() : Infinity;
    const authorizedMessages = messages.filter((message) => {
      const createdAt = new Date(message.createdAt).getTime();
      return createdAt >= authorizedFrom && createdAt <= authorizedUntil;
    });
    waitingCount += await forwardChatMessagesToAngel(
      userId,
      chat.id,
      userId,
      period.angelUserId,
      period.id,
      authorizedMessages,
      true,
    );
  }

  if (waitingCount === 0) {
    for (const key of accessKeys) completedAccessPeriods.add(key);
    return { state: "current" as const, waitingCount: 0 };
  }
  return { state: "waiting" as const, waitingCount };
}
