import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRouter } from "./auth/routes.js";
import { configRouter } from "./config/routes.js";
import { usersRouter } from "./users/routes.js";
import { angelsRouter } from "./angels/routes.js";
import { requestsRouter } from "./requests/routes.js";
import { chatsRouter } from "./chats/routes.js";
import { safetyRouter } from "./safety/routes.js";
import { supportRouter, adminRouter } from "./support/routes.js";
import { AppEnv } from "./types.js";

export function createApp() {
  const app = new Hono<AppEnv>();

  // CORS middleware supporting cookies and custom headers
  app.use(
    "*",
    cors({
      origin: (origin) => origin || "*",
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "Cookie"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    })
  );

  app.use("*", logger());

  // Better Auth endpoints
  app.route("/api/auth", authRouter);

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

  // API v1 routes
  const v1 = new Hono<AppEnv>();

  // Config
  v1.route("/config", configRouter);

  // Users & Me
  v1.route("/users", usersRouter);
  v1.route("/me", usersRouter);

  // Angels
  v1.route("/", angelsRouter);

  // Requests
  v1.route("/requests", requestsRouter);

  // Chats
  v1.route("/chats", chatsRouter);

  // Safety (blocking & report)
  v1.route("/", safetyRouter);

  // Support & Admin
  v1.route("/support", supportRouter);
  v1.route("/admin", adminRouter);

  app.route("/api/v1", v1);
  // Also route directly without /api/v1 for convenience
  app.route("/", v1);

  // Error handling
  app.onError((err, c) => {
    console.error("Server Error:", err);
    return c.json({ code: "INTERNAL_ERROR", message: err.message || "An unexpected error occurred" }, 500);
  });

  return app;
}
