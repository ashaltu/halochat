import { WebSocket, WebSocketServer } from "ws";
import { Server as HttpServer } from "node:http";
import { validateSessionToken } from "../auth/index.js";

type SessionValidator = (token: string) => Promise<{ user: { id: string } } | null>;

export class WebSocketManager {
  private userSockets = new Map<string, Set<WebSocket>>();
  private socketUsers = new Map<WebSocket, string>();
  private wss: WebSocketServer | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionValidator: SessionValidator = validateSessionToken,
    private readonly authenticationTimeoutMs = 5000
  ) {}

  init(server: HttpServer) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
      if (url.pathname === "/ws") {
        this.wss?.handleUpgrade(request, socket, head, (ws) => {
          this.wss?.emit("connection", ws, request);
        });
      }
    });

    this.wss.on("connection", (ws: WebSocket) => {
      let authenticatedUserId: string | null = null;
      const authenticationTimeout = setTimeout(() => {
        if (!authenticatedUserId) ws.close(4001, "Authentication timeout");
      }, this.authenticationTimeoutMs);

      ws.on("message", async (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (!authenticatedUserId && parsed.type === "auth" && typeof parsed.token === "string") {
            const sessionData = await this.sessionValidator(parsed.token);
            if (sessionData) {
              authenticatedUserId = sessionData.user.id;
              clearTimeout(authenticationTimeout);
              this.registerSocket(authenticatedUserId, ws);
              ws.send(JSON.stringify({ type: "authenticated", userId: authenticatedUserId }));
            } else {
              ws.send(JSON.stringify({ type: "error", message: "Invalid session token" }));
              ws.close(4001, "Unauthorized");
            }
          } else if (authenticatedUserId && parsed.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          } else if (!authenticatedUserId) {
            ws.send(JSON.stringify({ type: "error", message: "Authentication required" }));
            ws.close(4001, "Unauthorized");
          }
        } catch {
          ws.close(1003, "Invalid message");
        }
      });

      ws.on("close", () => {
        clearTimeout(authenticationTimeout);
        this.unregisterSocket(ws);
      });

      ws.on("error", () => {
        clearTimeout(authenticationTimeout);
        this.unregisterSocket(ws);
      });
    });

    // Heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return;
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        }
      }
    }, 30000);
  }

  registerSocket(userId: string, ws: WebSocket) {
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)?.add(ws);
    this.socketUsers.set(ws, userId);
  }

  unregisterSocket(ws: WebSocket) {
    const userId = this.socketUsers.get(ws);
    if (userId) {
      const set = this.userSockets.get(userId);
      set?.delete(ws);
      if (set?.size === 0) {
        this.userSockets.delete(userId);
      }
      this.socketUsers.delete(ws);
    }
  }

  sendToUser(userId: string, payload: unknown) {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    const data = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  hasConnections(userId: string) {
    return (this.userSockets.get(userId)?.size || 0) > 0;
  }

  broadcastToUsers(userIds: string[], payload: unknown) {
    for (const id of userIds) {
      this.sendToUser(id, payload);
    }
  }

  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.wss?.close();
    this.wss = null;
    this.userSockets.clear();
    this.socketUsers.clear();
  }
}

export const wsManager = new WebSocketManager();
