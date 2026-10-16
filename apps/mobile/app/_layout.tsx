import React, { useEffect } from "react";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuthStore } from "../src/stores/auth.js";
import { useRealtimeStore } from "../src/stores/realtime.js";
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
