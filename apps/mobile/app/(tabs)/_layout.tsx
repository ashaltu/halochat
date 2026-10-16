import React from "react";
import { Tabs } from "expo-router";
import { Text } from "react-native";
import { theme } from "../../src/theme.js";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.card },
        headerTintColor: theme.colors.text,
        tabBarStyle: {
          backgroundColor: theme.colors.card,
          borderTopColor: theme.colors.border,
          height: 60,
          paddingBottom: 8,
          paddingTop: 8,
        },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textMuted,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chats",
          tabBarIcon: ({ focused }) => (
            <Text style={{ fontSize: 20 }}>{focused ? "💬" : "🗨️"}</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="requests"
        options={{
          title: "Requests",
          tabBarIcon: ({ focused }) => (
            <Text style={{ fontSize: 20 }}>{focused ? "📨" : "✉️"}</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="angel"
        options={{
          title: "Angel Tab",
          tabBarIcon: ({ focused }) => (
            <Text style={{ fontSize: 20 }}>{focused ? "🛡️" : "✨"}</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ focused }) => (
            <Text style={{ fontSize: 20 }}>{focused ? "⚙️" : "🔧"}</Text>
          ),
        }}
      />
    </Tabs>
  );
}
