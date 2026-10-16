import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  TextInput,
  RefreshControl,
} from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../src/api/client.js";
import { theme } from "../../src/theme.js";

export default function AngelTabScreen() {
  const queryClient = useQueryClient();

  // Whisper modal state
  const [whisperModalVisible, setWhisperModalVisible] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [whisperText, setWhisperText] = useState("");
  const [whisperError, setWhisperError] = useState<string | null>(null);

  // Decline Reason modal state
  const [declineModalVisible, setDeclineModalVisible] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["angel-dashboard"],
    queryFn: () =>
      apiRequest<{
        pendingAssignments: any[];
        pendingRequests: any[];
        activeChats: any[];
        pendingAccessRequests: any[];
      }>("/api/v1/angel/dashboard"),
    refetchInterval: 10000,
  });

  // Assignment Mutations
  const acceptAssignment = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/angel/assignments/${id}/accept`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["angel-dashboard"] }),
  });

  const declineAssignment = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/angel/assignments/${id}/decline`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["angel-dashboard"] }),
  });

  // Contact Approvals Mutations
  const approveRequest = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/angel/requests/${id}/approve`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["angel-dashboard"] }),
  });

  const declineRequest = useMutation({
    mutationFn: (params: { id: string; shortReason?: string }) =>
      apiRequest(`/api/v1/angel/requests/${params.id}/decline`, {
        method: "POST",
        body: JSON.stringify({ shortReason: params.shortReason }),
      }),
    onSuccess: () => {
      setDeclineModalVisible(false);
      setDeclineReason("");
      queryClient.invalidateQueries({ queryKey: ["angel-dashboard"] });
    },
  });

  // Angel Chat Controls Mutations
  const restrictSending = useMutation({
    mutationFn: (chatId: string) =>
      apiRequest(`/api/v1/angel/chats/${chatId}/restrict-sending`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["angel-dashboard"] }),
  });

  const allowSending = useMutation({
    mutationFn: (chatId: string) =>
      apiRequest(`/api/v1/angel/chats/${chatId}/allow-sending`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["angel-dashboard"] }),
  });

  const endChat = useMutation({
    mutationFn: (chatId: string) =>
      apiRequest(`/api/v1/angel/chats/${chatId}/end`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["angel-dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["chats"] });
    },
  });

  const sendWhisper = useMutation({
    mutationFn: () => {
      if (whisperText.length > 50) {
        throw new Error("Whispers are limited to 50 characters.");
      }
      return apiRequest(`/api/v1/angel/chats/${selectedChatId}/whispers`, {
        method: "POST",
        body: JSON.stringify({
          ciphertext: whisperText,
          plaintextCharLength: whisperText.length,
        }),
      });
    },
    onSuccess: () => {
      setWhisperModalVisible(false);
      setWhisperText("");
      setWhisperError(null);
    },
    onError: (err: any) => {
      setWhisperError(err.message || "Failed to send whisper");
    },
  });

  // Access Request Decisions
  const acceptAccess = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/angel/access-requests/${id}/accept`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["angel-dashboard"] }),
  });

  const declineAccess = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/angel/access-requests/${id}/decline`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["angel-dashboard"] }),
  });

  const pendingAssignments = data?.pendingAssignments || [];
  const pendingRequests = data?.pendingRequests || [];
  const activeChats = data?.activeChats || [];
  const pendingAccessRequests = data?.pendingAccessRequests || [];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={theme.colors.primary} />
      }
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>✨ Angel Dashboard</Text>
        <Text style={styles.headerSubtitle}>
          Oversight & controls for the people who trusted you to protect them.
        </Text>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : null}

      {/* 1. Pending Assignment Invitations */}
      {pendingAssignments.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            Pending Angel Invitations ({pendingAssignments.length})
          </Text>
          {pendingAssignments.map((a) => (
            <View key={a.id} style={styles.card}>
              <Text style={styles.cardBold}>@{a.username}</Text>
              <Text style={styles.cardSub}>
                invited you to be their Angel ({new Date(a.createdAt).toLocaleDateString()})
              </Text>
              <View style={styles.btnRow}>
                <TouchableOpacity
                  style={[styles.btn, styles.acceptBtn]}
                  onPress={() => acceptAssignment.mutate(a.id)}
                >
                  <Text style={styles.btnText}>Accept Role</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.declineBtn]}
                  onPress={() => declineAssignment.mutate(a.id)}
                >
                  <Text style={styles.btnText}>Decline</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* 2. Contact Requests Requiring Approval */}
      {pendingRequests.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            Contact Approvals Needed ({pendingRequests.length})
          </Text>
          {pendingRequests.map((r) => (
            <View key={r.angelVoteId} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardBold}>Request Purpose: {r.purpose}</Text>
                <View style={styles.sideBadge}>
                  <Text style={styles.sideBadgeText}>{r.side}</Text>
                </View>
              </View>
              <Text style={styles.cardSub}>
                Your protected user needs your approval before this chat opens.
              </Text>
              <View style={styles.btnRow}>
                <TouchableOpacity
                  style={[styles.btn, styles.acceptBtn]}
                  onPress={() => approveRequest.mutate(r.requestId)}
                >
                  <Text style={styles.btnText}>Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.declineBtn]}
                  onPress={() => {
                    setSelectedRequestId(r.requestId);
                    setDeclineModalVisible(true);
                  }}
                >
                  <Text style={styles.btnText}>Decline with Reason</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* 3. Leave / Rejoin Access Requests */}
      {pendingAccessRequests.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            Access Requests ({pendingAccessRequests.length})
          </Text>
          {pendingAccessRequests.map((ar) => (
            <View key={ar.id} style={styles.card}>
              <Text style={styles.cardBold}>
                {ar.type === "LEAVE"
                  ? "Request to Leave Chat (I'm Comfortable)"
                  : ar.type === "INVITE"
                    ? "Invitation to Protect Chat"
                    : "Request to Rejoin Chat"}
              </Text>
              {ar.reason ? (
                <Text style={styles.privateReasonText}>Private Reason: "{ar.reason}"</Text>
              ) : null}
              <View style={styles.btnRow}>
                <TouchableOpacity
                  style={[styles.btn, styles.acceptBtn]}
                  onPress={() => acceptAccess.mutate(ar.id)}
                >
                  <Text style={styles.btnText}>Accept</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.declineBtn]}
                  onPress={() => declineAccess.mutate(ar.id)}
                >
                  <Text style={styles.btnText}>Decline</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* 4. Active Protected Chats */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Active Protected Chats ({activeChats.length})
        </Text>
        {activeChats.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.cardSub}>No active chats under your supervision.</Text>
          </View>
        ) : (
          activeChats.map((c) => (
            <View key={c.chatId} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardBold}>Chat #{c.chatId.substring(0, 8)}</Text>
                <View style={styles.modePill}>
                  <Text style={styles.modePillText}>PROTECTED</Text>
                </View>
              </View>

              <Text style={styles.cardSub}>
                Authorized since {new Date(c.authorizedFrom).toLocaleDateString()}
              </Text>

              {/* Protective Controls */}
              <View style={styles.controlsGrid}>
                <TouchableOpacity
                  style={styles.controlBtn}
                  onPress={() => {
                    setSelectedChatId(c.chatId);
                    setWhisperText("");
                    setWhisperError(null);
                    setWhisperModalVisible(true);
                  }}
                >
                  <Text style={styles.controlBtnText}>💬 Send Whisper (≤50 chars)</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.controlBtn, { backgroundColor: "rgba(245, 158, 11, 0.2)" }]}
                  onPress={() => restrictSending.mutate(c.chatId)}
                >
                  <Text style={[styles.controlBtnText, { color: theme.colors.warning }]}>
                    ⏸️ Pause Protected Person Sending
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.controlBtn, { backgroundColor: "rgba(16, 185, 129, 0.2)" }]}
                  onPress={() => allowSending.mutate(c.chatId)}
                >
                  <Text style={[styles.controlBtnText, { color: theme.colors.protected }]}>
                    ▶️ Allow Sending
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.controlBtn, { backgroundColor: "rgba(239, 68, 68, 0.2)" }]}
                  onPress={() => {
                    if (confirm("Are you sure you want to end this conversation?")) {
                      endChat.mutate(c.chatId);
                    }
                  }}
                >
                  <Text style={[styles.controlBtnText, { color: theme.colors.danger }]}>
                    🛑 End Chat
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </View>

      {/* Whisper Modal */}
      <Modal visible={whisperModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Send Private Whisper</Text>
            <Text style={styles.modalSub}>
              Only visible to your protected person. The other participant and other Angels cannot see it.
            </Text>

            {whisperError ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{whisperError}</Text>
              </View>
            ) : null}

            <TextInput
              style={styles.modalInput}
              placeholder="Type whisper (max 50 characters)..."
              placeholderTextColor={theme.colors.textMuted}
              value={whisperText}
              onChangeText={setWhisperText}
              maxLength={50}
            />
            <Text style={styles.charCount}>{whisperText.length}/50 characters</Text>

            <View style={styles.btnRow}>
              <TouchableOpacity
                style={[styles.btn, styles.acceptBtn]}
                onPress={() => sendWhisper.mutate()}
                disabled={sendWhisper.isPending || !whisperText.trim()}
              >
                <Text style={styles.btnText}>Send Whisper</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.declineBtn]}
                onPress={() => setWhisperModalVisible(false)}
              >
                <Text style={styles.btnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Decline Reason Modal */}
      <Modal visible={declineModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Decline Request with Reason</Text>
            <Text style={styles.modalSub}>
              Your reason is private between you and your protected user. Requester never sees it.
            </Text>

            <TextInput
              style={styles.modalInput}
              placeholder="e.g. Inappropriate purpose, please decline..."
              placeholderTextColor={theme.colors.textMuted}
              value={declineReason}
              onChangeText={setDeclineReason}
              maxLength={200}
            />

            <View style={styles.btnRow}>
              <TouchableOpacity
                style={[styles.btn, styles.declineBtn]}
                onPress={() => {
                  if (selectedRequestId) {
                    declineRequest.mutate({
                      id: selectedRequestId,
                      shortReason: declineReason,
                    });
                  }
                }}
              >
                <Text style={styles.btnText}>Decline Contact</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: theme.colors.card }]}
                onPress={() => setDeclineModalVisible(false)}
              >
                <Text style={styles.btnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  header: {
    padding: theme.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: theme.colors.text,
  },
  headerSubtitle: {
    fontSize: 13,
    color: theme.colors.textMuted,
    marginTop: 4,
    lineHeight: 18,
  },
  center: {
    padding: theme.spacing.xl,
    alignItems: "center",
  },
  section: {
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
  },
  emptyCard: {
    padding: theme.spacing.lg,
    alignItems: "center",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardBold: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.text,
  },
  cardSub: {
    fontSize: 13,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  privateReasonText: {
    fontSize: 13,
    color: "#ec4899",
    fontStyle: "italic",
    marginTop: 4,
  },
  sideBadge: {
    backgroundColor: "rgba(99, 102, 241, 0.2)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  sideBadgeText: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: "700",
  },
  modePill: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderColor: theme.colors.protected,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.radii.full,
  },
  modePillText: {
    color: theme.colors.protected,
    fontSize: 10,
    fontWeight: "700",
  },
  btnRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.md,
  },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: theme.radii.sm,
    alignItems: "center",
  },
  acceptBtn: {
    backgroundColor: theme.colors.protected,
  },
  declineBtn: {
    backgroundColor: theme.colors.danger,
  },
  btnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },
  controlsGrid: {
    gap: 8,
    marginTop: 12,
  },
  controlBtn: {
    backgroundColor: "rgba(236, 72, 153, 0.15)",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radii.sm,
    alignItems: "center",
  },
  controlBtnText: {
    color: "#ec4899",
    fontWeight: "700",
    fontSize: 13,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.8)",
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  modalCard: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.lg,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.text,
  },
  modalSub: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginTop: 4,
    marginBottom: 12,
    lineHeight: 16,
  },
  modalInput: {
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: 10,
    color: theme.colors.text,
    fontSize: 14,
  },
  charCount: {
    fontSize: 11,
    color: theme.colors.textMuted,
    textAlign: "right",
    marginTop: 4,
  },
  errorBox: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    padding: 8,
    borderRadius: 6,
    marginBottom: 8,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 12,
  },
});
