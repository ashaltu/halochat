import { serve } from "@hono/node-server";
import { getDb, initDbSchema } from "@halochat/db";
import { createApp } from "./app.js";
import { wsManager } from "./realtime/index.js";
import type { Server as HttpServer } from "node:http";

const PORT = parseInt(process.env.PORT || "3000", 10);

async function startServer() {
  console.log("Initializing database schema...");
  const db = await getDb();
  await initDbSchema(db);
  console.log("Database schema initialized.");

  const app = createApp();

  const server = serve(
    {
      fetch: app.fetch,
      port: PORT,
    },
    (info) => {
      console.log(`HaloChat Server listening on http://localhost:${info.port}`);
      console.log(`Realtime WebSocket endpoint at ws://localhost:${info.port}/ws`);
    }
  ) as unknown as HttpServer;

  wsManager.init(server);

  const shutdown = () => {
    console.log("Shutting down HaloChat server...");
    wsManager.close();
    server.close(() => {
      console.log("Server closed.");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
