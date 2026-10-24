import React, { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../src/stores/auth.js";
import { useRealtimeStore } from "../src/stores/realtime.js";
import { apiRequest } from "../src/api/client.js";
import { syncAngelForwardingForChat, type AngelForwardingChat } from "../src/crypto/angel-forwarding.js";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { registerPushToken } from "../src/push.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
  },
});

function AngelForwardingSync() {
  const { user } = useAuthStore();
  const client = useQueryClient();
  const [appActive, setAppActive] = useState(Platform.OS === "web" || AppState.currentState === "active");

  useQuery({
    queryKey: ["angel-forwarding-sync", user?.id],
    queryFn: async () => {
      const { chats } = await apiRequest<{ chats: AngelForwardingChat[] }>("/api/v1/chats");
      for (const chat of chats) {
        if (!(chat.ownAngelAccessPeriods?.length || chat.ownAngels?.length)) continue;
        try {
          const status = await syncAngelForwardingForChat(user!.id, chat);
          client.setQueryData(["angel-forwarding-status", chat.id], status);
        } catch {
          client.setQueryData(["angel-forwarding-status", chat.id], { state: "error", waitingCount: 0 });
        }
      }
      return { syncedAt: Date.now() };
    },
    enabled: !!user?.id && appActive,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (Platform.OS === "web") return;
    const subscription = AppState.addEventListener("change", (state) => {
      setAppActive(state === "active");
      if (state === "active") void client.invalidateQueries({ queryKey: ["angel-forwarding-sync", user?.id] });
    });
    return () => subscription.remove();
  }, [client, user?.id]);

  return null;
}

export default function RootLayout() {
  const { session, checkSession } = useAuthStore();
  const { connect, disconnect } = useRealtimeStore();

  useEffect(() => {
    checkSession();
  }, []);

  useEffect(() => {
    if (session) {
      connect();
      void registerPushToken();
    } else {
      disconnect();
    }
  }, [session]);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AngelForwardingSync />
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: "#131b2e" },
            headerTintColor: "#f8fafc",
            contentStyle: { backgroundColor: "#090d16" },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          <Stack.Screen name="auth/sign-in" options={{ title: "Sign In", headerShown: false }} />
          <Stack.Screen name="auth/sign-up" options={{ title: "Sign Up", headerShown: false }} />
          <Stack.Screen name="auth/forgot-password" options={{ title: "Recover Account" }} />
          <Stack.Screen name="auth/reset-password" options={{ title: "Reset Password" }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="chat/[id]" options={{ title: "Chat" }} />
          <Stack.Screen name="settings/angels" options={{ title: "My Angels" }} />
          <Stack.Screen name="settings/help" options={{ title: "Help & Support" }} />
        </Stack>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
