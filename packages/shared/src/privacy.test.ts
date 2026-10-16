import { describe, expect, it } from "vitest";
import { ChatMode, ChatStatus, ContactRequestState } from "./enums.js";
import { filterMessagesForAngel, sanitizeChatForParticipant, sanitizeRequestForRequester } from "./privacy.js";

describe("privacy filters", () => {
  it("hides messages outside Angel access periods and emits a gap", () => {
    const timeline = filterMessagesForAngel([
      { id: "1", chatId: "c", senderId: "u", ciphertext: "before", seq: 1, createdAt: "2026-01-01T00:00:01Z" },
      { id: "2", chatId: "c", senderId: "u", ciphertext: "hidden", seq: 2, createdAt: "2026-01-01T00:00:03Z" },
      { id: "3", chatId: "c", senderId: "u", ciphertext: "after", seq: 3, createdAt: "2026-01-01T00:00:05Z" },
    ], [
      { authorizedFrom: "2026-01-01T00:00:00Z", authorizedUntil: "2026-01-01T00:00:02Z" },
      { authorizedFrom: "2026-01-01T00:00:04Z", authorizedUntil: null },
    ]);
    expect(timeline.some((item: any) => item.ciphertext === "hidden")).toBe(false);
    expect(timeline.some((item: any) => item.isGapNotice)).toBe(true);
  });

  it("exposes only the participant's own Angels", () => {
    const chat = sanitizeChatForParticipant({
      id: "c",
      requesterUserId: "a",
      recipientUserId: "b",
      mode: ChatMode.PROTECTED,
      status: ChatStatus.ACTIVE,
      createdAt: new Date().toISOString(),
    }, "a", [{ id: "x", angelUserId: "angel-a", status: "ACTIVE", hasActiveRestriction: false }]);
    expect(chat.ownAngels?.map((angel) => angel.angelUserId)).toEqual(["angel-a"]);
    expect(chat).not.toHaveProperty("otherAngels");
  });

  it("collapses both decline sources", () => {
    const base = { id: "r", requesterUserId: "a", recipientUserId: "b", purpose: "Other", createdAt: "", updatedAt: "" };
    expect(sanitizeRequestForRequester({ ...base, state: ContactRequestState.DECLINED_BY_RECIPIENT }).state).toBe("DECLINED");
    expect(sanitizeRequestForRequester({ ...base, state: ContactRequestState.DECLINED_BY_ANGEL }).state).toBe("DECLINED");
  });
});
