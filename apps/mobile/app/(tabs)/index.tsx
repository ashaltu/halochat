import React, { useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { apiRequest } from "../../src/api/client.js";
import { theme } from "../../src/theme.js";
import { useRealtimeStore } from "../../src/stores/realtime.js";
import { useAuthStore } from "../../src/stores/auth.js";

export default function ChatsListScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const { subscribe } = useRealtimeStore();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["chats"],
    queryFn: () => apiRequest<{ chats: any[] }>("/api/v1/chats"),
  });

  useEffect(() => {
    const unsub1 = subscribe("chat.updated", () => {
      queryClient.invalidateQueries({ queryKey: ["chats"] });
    });
    const unsub2 = subscribe("message.new", () => {
      queryClient.invalidateQueries({ queryKey: ["chats"] });
    });
    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  const chats = data?.chats || [];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.welcomeText}>Welcome back,</Text>
          <Text style={styles.usernameText}>@{user?.username}</Text>
        </View>
        <TouchableOpacity
          style={styles.newChatBtn}
          onPress={() => router.push("/(tabs)/requests")}
        >
          <Text style={styles.newChatBtnText}>+ New Contact</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : chats.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>💬</Text>
          <Text style={styles.emptyTitle}>No Conversations Yet</Text>
          <Text style={styles.emptySubtitle}>
            Send a contact request to start chatting safely in Comfort or Protected mode.
          </Text>
          <TouchableOpacity
            style={styles.emptyActionBtn}
            onPress={() => router.push("/(tabs)/requests")}
          >
            <Text style={styles.emptyActionText}>Reach Out to Someone</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={chats}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={theme.colors.primary}
            />
          }
          renderItem={({ item }) => {
            const partnerId =
              item.requesterUserId === user?.id ? item.recipientUserId : item.requesterUserId;
            const isProtected = item.mode === "PROTECTED";

            return (
              <TouchableOpacity
                style={styles.chatCard}
                onPress={() => router.push(`/chat/${item.id}`)}
              >
                <View style={styles.chatCardTop}>
                  <View style={styles.partnerInfo}>
                    <Text style={styles.partnerAvatar}>
                      {isProtected ? "🛡️" : "👤"}
                    </Text>
                    <View>
                      <Text style={styles.partnerName}>
                        Conversation with {partnerId.substring(0, 8)}...
                      </Text>
                      <Text style={styles.lastMessageDate}>
                        {item.lastMessageAt
                          ? new Date(item.lastMessageAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "Started " + new Date(item.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.badges}>
                    <View
                      style={[
                        styles.modeBadge,
                        isProtected ? styles.modeProtected : styles.modeComfort,
                      ]}
                    >
                      <Text
                        style={[
                          styles.modeText,
                          isProtected ? styles.modeTextProtected : styles.modeTextComfort,
                        ]}
                      >
                        {item.mode}
                      </Text>
                    </View>

                    {item.status === "ENDED" ? (
                      <View style={styles.endedBadge}>
                        <Text style={styles.endedText}>ENDED</Text>
                      </View>
                    ) : null}

                    {item.isSendingRestricted ? (
                      <View style={styles.restrictedBadge}>
                        <Text style={styles.restrictedText}>PAUSED</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={styles.listContent}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  header: {
    padding: theme.spacing.lg,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  welcomeText: {
    fontSize: 12,
    color: theme.colors.textMuted,
  },
  usernameText: {
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.text,
  },
  newChatBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radii.full,
  },
  newChatBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing.xl,
  },
  emptyIcon: {
    fontSize: 56,
    marginBottom: theme.spacing.md,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: theme.colors.text,
    marginBottom: theme.spacing.xs,
  },
  emptySubtitle: {
    fontSize: 14,
    color: theme.colors.textMuted,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: theme.spacing.lg,
  },
  emptyActionBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radii.md,
  },
  emptyActionText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
  listContent: {
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  chatCard: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
  },
  chatCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  partnerInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  partnerAvatar: {
    fontSize: 24,
  },
  partnerName: {
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.text,
  },
  lastMessageDate: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  badges: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  modeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.radii.full,
    borderWidth: 1,
  },
  modeComfort: {
    backgroundColor: "rgba(59, 130, 246, 0.15)",
    borderColor: theme.colors.comfort,
  },
  modeProtected: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderColor: theme.colors.protected,
  },
  modeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  modeTextComfort: {
    color: theme.colors.comfort,
  },
  modeTextProtected: {
    color: theme.colors.protected,
  },
  endedBadge: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderColor: theme.colors.danger,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  endedText: {
    color: theme.colors.danger,
    fontSize: 10,
    fontWeight: "700",
  },
  restrictedBadge: {
    backgroundColor: "rgba(245, 158, 11, 0.2)",
    borderColor: theme.colors.warning,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  restrictedText: {
    color: theme.colors.warning,
    fontSize: 10,
    fontWeight: "700",
  },
});
