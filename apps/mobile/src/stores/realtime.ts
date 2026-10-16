import { create } from "zustand";
import { API_BASE_URL, getAuthToken } from "../api/client.js";

type EventListener = (data: any) => void;

interface RealtimeState {
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  listeners: Map<string, Set<EventListener>>;
  subscribe: (eventType: string, listener: EventListener) => () => void;
  emit: (eventType: string, data: any) => void;
}

let ws: WebSocket | null = null;
let reconnectTimer: any = null;
let reconnectDelay = 1000;

export const useRealtimeStore = create<RealtimeState>((set, get) => ({
  isConnected: false,
  listeners: new Map(),

  subscribe: (eventType, listener) => {
    const listeners = get().listeners;
    if (!listeners.has(eventType)) {
      listeners.set(eventType, new Set());
    }
    listeners.get(eventType)?.add(listener);

    return () => {
      listeners.get(eventType)?.delete(listener);
    };
  },

  emit: (eventType, data) => {
    const setOfListeners = get().listeners.get(eventType);
    if (setOfListeners) {
      for (const listener of setOfListeners) {
        listener(data);
      }
    }
  },

  connect: () => {
    const token = getAuthToken();
    if (!token) return;

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = API_BASE_URL.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(token)}`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        set({ isConnected: true });
        reconnectDelay = 1000;
        ws?.send(JSON.stringify({ type: "auth", token }));
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type) {
            get().emit(payload.type, payload);
          }
        } catch (e) {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        set({ isConnected: false });
        // Exponential backoff reconnect
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
          get().connect();
        }, reconnectDelay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    } catch (err) {
      console.error("WebSocket connection error:", err);
    }
  },

  disconnect: () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
      ws.close();
      ws = null;
    }
    set({ isConnected: false });
  },
}));
