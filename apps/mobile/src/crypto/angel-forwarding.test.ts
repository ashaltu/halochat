import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  ensureChatE2ee: vi.fn(),
  ensureWhisperGroup: vi.fn(),
  hasWhisperGroupState: vi.fn(),
  decryptWhisper: vi.fn(),
  fetchAndDecryptChatMessages: vi.fn(),
  forwardChatMessagesToAngel: vi.fn(),
}));

vi.mock("./session.js", () => session);
const api = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("../api/client.js", () => api);

import { syncAngelForwardingForChat } from "./angel-forwarding.js";

const chat = (id: string) => ({
  id,
  requesterUserId: "protected-user",
  recipientUserId: "chat-participant",
  mode: "PROTECTED",
  status: "ACTIVE",
  ownAngels: [{
    id: `access-${id}`,
    angelUserId: "angel-user",
    authorizedFrom: "2026-01-01T00:00:02.000Z",
  }],
});

describe("foreground Angel message sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.ensureChatE2ee.mockResolvedValue("ready");
    session.ensureWhisperGroup.mockResolvedValue("ready");
    session.hasWhisperGroupState.mockResolvedValue(true);
    session.decryptWhisper.mockResolvedValue(undefined);
    api.apiRequest.mockResolvedValue({ whispers: [] });
    session.fetchAndDecryptChatMessages.mockResolvedValue([
      { id: "before-access", createdAt: "2026-01-01T00:00:01.000Z", plaintext: "hidden" },
      { id: "authorized", createdAt: "2026-01-01T00:00:03.000Z", plaintext: "shared" },
    ]);
    session.forwardChatMessagesToAngel.mockResolvedValue(0);
  });

  it("loads authorized history once, then switches to incremental catch-up", async () => {
    const protectedChat = chat(`history-${Date.now()}`);

    await expect(syncAngelForwardingForChat("protected-user", protectedChat)).resolves.toEqual({
      state: "current",
      waitingCount: 0,
    });
    await syncAngelForwardingForChat("protected-user", protectedChat);

    expect(session.fetchAndDecryptChatMessages).toHaveBeenNthCalledWith(1, "protected-user", protectedChat.id, true);
    expect(session.fetchAndDecryptChatMessages).toHaveBeenNthCalledWith(2, "protected-user", protectedChat.id, false);
    expect(session.forwardChatMessagesToAngel).toHaveBeenCalledWith(
      "protected-user",
      protectedChat.id,
      "protected-user",
      "angel-user",
      `access-${protectedChat.id}`,
      [expect.objectContaining({ id: "authorized" })],
      true,
    );
  });

  it("keeps loading history until the Angel group and its copy outbox are ready", async () => {
    const protectedChat = chat(`waiting-${Date.now()}`);
    session.ensureWhisperGroup.mockResolvedValueOnce("waiting").mockResolvedValue("ready");
    session.forwardChatMessagesToAngel.mockResolvedValue(0);

    await expect(syncAngelForwardingForChat("protected-user", protectedChat)).resolves.toEqual({
      state: "waiting",
      waitingCount: 1,
    });
    await expect(syncAngelForwardingForChat("protected-user", protectedChat)).resolves.toEqual({
      state: "current",
      waitingCount: 0,
    });

    expect(session.fetchAndDecryptChatMessages).toHaveBeenNthCalledWith(1, "protected-user", protectedChat.id, true);
    expect(session.fetchAndDecryptChatMessages).toHaveBeenNthCalledWith(2, "protected-user", protectedChat.id, true);
  });

  it("skips non-protected and inactive chats", async () => {
    const comfortChat = { ...chat("comfort"), mode: "COMFORT" };
    const endedChat = { ...chat("ended"), status: "ENDED" };

    await expect(syncAngelForwardingForChat("protected-user", comfortChat)).resolves.toEqual({ state: "idle", waitingCount: 0 });
    await expect(syncAngelForwardingForChat("protected-user", endedChat)).resolves.toEqual({ state: "idle", waitingCount: 0 });
    expect(session.ensureChatE2ee).not.toHaveBeenCalled();
  });

  it("uses retained group state for an ended period and excludes messages from its gap", async () => {
    const protectedChat = {
      ...chat(`historical-${Date.now()}`),
      ownAngels: [],
      ownAngelAccessPeriods: [{
        id: "ended-period",
        angelUserId: "angel-user",
        authorizedFrom: "2026-01-01T00:00:00.000Z",
        authorizedUntil: "2026-01-01T00:00:10.000Z",
      }],
    };
    session.fetchAndDecryptChatMessages.mockResolvedValue([
      { id: "during-access", createdAt: "2026-01-01T00:00:05.000Z", plaintext: "visible" },
      { id: "during-gap", createdAt: "2026-01-01T00:00:11.000Z", plaintext: "hidden" },
    ]);

    await syncAngelForwardingForChat("protected-user", protectedChat);

    expect(session.hasWhisperGroupState).toHaveBeenCalledWith(
      "protected-user", protectedChat.id, "angel-user", "ended-period",
    );
    expect(session.forwardChatMessagesToAngel).toHaveBeenCalledWith(
      "protected-user",
      protectedChat.id,
      "protected-user",
      "angel-user",
      "ended-period",
      [expect.objectContaining({ id: "during-access" })],
      true,
    );
  });
});
