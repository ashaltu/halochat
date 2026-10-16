import { getDb, inArray, pushTokens } from "@halochat/db";
import { wsManager } from "../realtime/index.js";

export async function notifyOfflineUsers(userIds: string[], title: string, data: Record<string, unknown>) {
  const offline = [...new Set(userIds)].filter((userId) => !wsManager.hasConnections(userId));
  if (offline.length === 0) return;
  const db = await getDb();
  const tokens = await db.select().from(pushTokens).where(inArray(pushTokens.userId, offline));
  if (tokens.length === 0) return;
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokens.map((token) => ({ to: token.expoToken, title, body: "Open HaloChat to view the update.", data }))),
  });
}
