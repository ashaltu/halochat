import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";

export const configRouter = new Hono();

export function getConversationPurposes(): string[] {
  try {
    const filePath = path.resolve(process.cwd(), "assets/config/conversation_purposes.txt");
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  } catch (err) {
    console.error("Error reading conversation_purposes.txt", err);
  }

  // Fallback as defined in PRD §10.1
  return [
    "Social / personal",
    "Business inquiry",
    "Buying or selling",
    "Education / mentoring",
    "Legal / professional services",
    "Work / hiring",
    "Care / support",
    "Housing / property",
    "Other",
  ];
}

configRouter.get("/conversation-purposes", (c) => {
  const purposes = getConversationPurposes();
  return c.json({ purposes });
});
