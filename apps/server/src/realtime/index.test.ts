import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WebSocketManager } from "./index.js";

describe("WebSocketManager", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("requires a valid first-frame session and never authenticates URL tokens", async () => {
    const manager = new WebSocketManager(
      async (token) => (token === "valid-token" ? { user: { id: "user-1" } } : null),
      100
    );
    const server = createServer();
    manager.init(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => manager.close());
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;

    const querySocket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=valid-token`);
    await new Promise<void>((resolve, reject) => {
      querySocket.once("open", () => querySocket.send(JSON.stringify({ type: "ping" })));
      querySocket.once("close", (code) => {
        try {
          expect(code).toBe(4001);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      querySocket.once("error", reject);
    });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const authenticated = await new Promise<Record<string, string>>((resolve, reject) => {
      socket.once("open", () =>
        socket.send(JSON.stringify({ type: "auth", token: "valid-token" }))
      );
      socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      socket.once("error", reject);
    });

    expect(authenticated).toEqual({ type: "authenticated", userId: "user-1" });
    expect(manager.hasConnections("user-1")).toBe(true);
    socket.close();
  });
});
