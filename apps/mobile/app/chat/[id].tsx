import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  ScrollView,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../src/api/client.js";
import { theme } from "../../src/theme.js";
import { useAuthStore } from "../../src/stores/auth.js";
import { useRealtimeStore } from "../../src/stores/realtime.js";
import {
  ensureChatE2ee,
  ensureWhisperGroup,
  encryptAndSendChatMessage,
  fetchAndDecryptChatMessages,
  decryptWhisper,
  getChatSafetyVerification,
  markChatSafetyCodeVerified,
} from "../../src/crypto/session.js";
import { formatSafetyCode } from "../../src/crypto/safety-code.js";

export default function ChatConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const { subscribe } = useRealtimeStore();

  const [inputText, setInputText] = useState("");
  const [infoModalVisible, setInfoModalVisible] = useState(false);
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const flatListRef = useRef<FlatList>(null);

  // Fetch Chat details
  const { data: chatData, isLoading: chatLoading } = useQuery({
    queryKey: ["chat", id],
    queryFn: () => apiRequest<{ chat: any }>(`/api/v1/chats/${id}`),
    refetchInterval: 5000,
  });

  const chat = chatData?.chat;
  const partnerId =
    chat?.requesterUserId === user?.id ? chat?.recipientUserId : chat?.requesterUserId;

  const e2eeQuery = useQuery({
    queryKey: ["e2ee", id, user?.id, partnerId],
    queryFn: () => ensureChatE2ee(user!.id, String(id), partnerId!, chat!.requesterUserId),
    enabled: !!user?.id && !!id && !!partnerId && !!chat?.requesterUserId,
    refetchInterval: (query) => query.state.data === "waiting" ? 3000 : false,
  });

  useQuery({
    queryKey: ["whisper-group-setup", id, user?.id, chat?.ownAngels?.map((angel: any) => angel.id).join(",")],
    queryFn: async () => {
      if (!user?.id || !Array.isArray(chat?.ownAngels)) return [];
      return Promise.all(chat.ownAngels.map((angel: any) =>
        ensureWhisperGroup(user.id, String(id), user.id, angel.angelUserId, angel.id)
      ));
    },
    enabled: !!user?.id && e2eeQuery.data === "ready" && !!chat?.ownAngels?.length,
  });

  const safetyVerificationQuery = useQuery({
    queryKey: ["e2ee-safety", id, user?.id],
    queryFn: () => getChatSafetyVerification(user!.id, String(id)),
    enabled: !!user?.id && e2eeQuery.data === "ready" && infoModalVisible,
  });

  const verifySafetyCodeMutation = useMutation({
    mutationFn: () => {
      if (!user?.id) throw new Error("Sign in to verify this conversation");
      return markChatSafetyCodeVerified(user.id, String(id));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["e2ee-safety", id, user?.id] }),
  });

  // Fetch Messages
  const { data: messagesData, isLoading: messagesLoading } = useQuery({
    queryKey: ["messages", id],
    queryFn: async () => {
      if (!user?.id) return { messages: [] };
      const previous = queryClient.getQueryData<{ messages: any[] }>(["messages", id])?.messages || [];
      const incoming = await fetchAndDecryptChatMessages(user.id, String(id), previous.length === 0);
      const merged = new Map(previous.map((message) => [message.id, message]));
      incoming.forEach((message) => merged.set(message.id, message));
      return {
        messages: [...merged.values()].sort((left, right) => left.seq - right.seq),
      };
    },
    enabled: e2eeQuery.data === "ready" && !!user?.id,
    refetchInterval: 3000,
  });

  const { data: whisperData } = useQuery({
    queryKey: ["whispers", id, user?.id],
    queryFn: async () => {
      if (!user?.id) return { whispers: [] };
      const response = await apiRequest<{ whispers: any[] }>(`/api/v1/chats/${id}/whispers`);
      const decrypted = [];
      for (const whisper of response.whispers) {
        const plaintext = await decryptWhisper(user.id, String(id), user.id, whisper.angelUserId, whisper);
        if (plaintext !== null) decrypted.push({ ...whisper, plaintext });
      }
      return { whispers: decrypted };
    },
    enabled: !!user?.id && !!chat && e2eeQuery.data === "ready",
    refetchInterval: 3000,
  });

  // Fetch user's angels for "Invite Angel" action
  const { data: protectionData } = useQuery({
    queryKey: ["my-protection"],
    queryFn: () => apiRequest<{ angels: any[] }>("/api/v1/me/protection"),
  });

  // Realtime listeners
  useEffect(() => {
    const unsubMsg = subscribe("message.new", (payload) => {
      if (payload.message?.chatId === id) {
        queryClient.invalidateQueries({ queryKey: ["messages", id] });
      }
    });

    const unsubWhisper = subscribe("whisper.new", (payload) => {
      if (payload.whisper?.chatId === id) {
        queryClient.invalidateQueries({ queryKey: ["whispers", id, user?.id] });
      }
    });

    const unsubChat = subscribe("chat.updated", (payload) => {
      if (payload.chatId === id) {
        queryClient.invalidateQueries({ queryKey: ["chat", id] });
      }
    });

    return () => {
      unMsg: unsubMsg();
      unsubWhisper();
      unsubChat();
    };
  }, [id, user?.id]);

  // Mutations
  const sendMessageMutation = useMutation({
    mutationFn: (text: string) => {
      if (!user?.id) throw new Error("Sign in to send a message");
      return encryptAndSendChatMessage(user.id, String(id), text);
    },
    onSuccess: () => {
      setInputText("");
      queryClient.invalidateQueries({ queryKey: ["messages", id] });
    },
  });

  const endChatMutation = useMutation({
    mutationFn: () => apiRequest(`/api/v1/chats/${id}/end`, { method: "POST" }),
    onSuccess: () => {
      setInfoModalVisible(false);
      queryClient.invalidateQueries({ queryKey: ["chat", id] });
    },
  });

  const leaveRequestMutation = useMutation({
    mutationFn: (angelUserId: string) => {
      const reason = prompt("Enter a short reason for your Angel (optional):") || undefined;
      return apiRequest(`/api/v1/chats/${id}/access-requests`, {
        method: "POST",
        body: JSON.stringify({
          type: "LEAVE",
          angelUserId,
          reason,
        }),
      });
    },
    onSuccess: () => {
      alert("Request sent to your Angel to leave the chat.");
      setInfoModalVisible(false);
    },
  });

  const inviteAngelMutation = useMutation({
    mutationFn: (angelAssignmentId: string) =>
      apiRequest(`/api/v1/chats/${id}/angel-invitations`, {
        method: "POST",
        body: JSON.stringify({ angelAssignmentId }),
      }),
    onSuccess: () => {
      alert("Invitation sent. The chat becomes Protected after your Angel accepts.");
      setInfoModalVisible(false);
      queryClient.invalidateQueries({ queryKey: ["chat", id] });
    },
  });

  const blockUserMutation = useMutation({
    mutationFn: (partnerId: string) =>
      apiRequest(`/api/v1/users/${partnerId}/block`, { method: "POST" }),
    onSuccess: () => {
      alert("User blocked.");
      router.replace("/(tabs)");
    },
  });

  const submitReportMutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/chats/${id}/report`, {
        method: "POST",
        body: JSON.stringify({
          reason: reportReason,
          details: reportDetails,
          evidence: (messagesData?.messages || [])
            .filter((message) => selectedEvidenceIds.includes(message.id) && message.plaintext)
            .map((message) => message.plaintext),
        }),
      }),
    onSuccess: () => {
      setReportModalVisible(false);
      setReportReason("");
      setReportDetails("");
      setSelectedEvidenceIds([]);
      alert("Report submitted for support staff review.");
    },
  });

  const messages = messagesData?.messages || [];
  const isProtected = chat?.mode === "PROTECTED";
  const isRestricted = chat?.isSendingRestricted;
  const isEnded = chat?.status === "ENDED";

  const handleSend = () => {
    if (!inputText.trim() || isRestricted || isEnded || e2eeQuery.data !== "ready") return;
    sendMessageMutation.mutate(inputText.trim());
  };

  // Combine messages & whispers sorted
  const combinedItems = [
    ...messages.map((m) => ({ ...m, isWhisper: false })),
    ...(whisperData?.whispers ?? []).map((w) => ({ ...w, isWhisper: true })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return (
    <View style={styles.container}>
      {/* Chat Top Banner */}
      <View style={styles.topBanner}>
        <View style={styles.bannerInfo}>
          <Text style={styles.partnerHeaderTitle}>
            Participant #{partnerId?.substring(0, 8)}
          </Text>
          <View
            style={[
              styles.modePill,
              isProtected ? styles.modeProtected : styles.modeComfort,
            ]}
          >
            <Text
              style={[
                styles.modePillText,
                isProtected ? styles.modeTextProtected : styles.modeTextComfort,
              ]}
            >
              {isProtected ? "🛡️ PROTECTED MODE" : "💬 COMFORT MODE"}
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.infoBtn}
          onPress={() => setInfoModalVisible(true)}
        >
          <Text style={styles.infoBtnText}>⚙️ Chat Info</Text>
        </TouchableOpacity>
      </View>

      {/* Sending Restricted Notice (D13) */}
      {isRestricted ? (
        <View style={styles.restrictionBanner}>
          <Text style={styles.restrictionIcon}>⏸️</Text>
          <Text style={styles.restrictionText}>
            Your Angel has temporarily paused your sending in this chat.
          </Text>
        </View>
      ) : null}

      {/* Messages List */}
      {e2eeQuery.isError ? (
        <View style={styles.center}>
          <Text style={styles.messageText}>
            Could not set up encrypted messaging. This chat stays unavailable until encryption is ready.
          </Text>
        </View>
      ) : chatLoading || e2eeQuery.data !== "ready" || messagesLoading ? (
        <View style={styles.center}>
          {e2eeQuery.data === "waiting" ? (
            <Text style={styles.messageText}>Setting up encrypted messaging…</Text>
          ) : (
            <ActivityIndicator size="large" color={theme.colors.primary} />
          )}
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={combinedItems}
          keyExtractor={(item) => (item.isWhisper ? `whisper-${item.id}` : `msg-${item.id}`)}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => {
            if (item.isWhisper) {
              return (
                <View style={styles.whisperBubble}>
                  <Text style={styles.whisperHeader}>✨ Private Angel Whisper</Text>
                  <Text style={styles.whisperText}>{item.plaintext}</Text>
                  <Text style={styles.whisperTime}>
                    {new Date(item.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Text>
                </View>
              );
            }

            const isMine = item.senderId === user?.id;
            return (
              <View
                style={[
                  styles.messageBubble,
                  isMine ? styles.myMessage : styles.partnerMessage,
                ]}
              >
                <Text style={styles.messageText}>{item.plaintext || "Message unavailable"}</Text>
                <Text style={styles.messageTime}>
                  {new Date(item.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Text>
              </View>
            );
          }}
          contentContainerStyle={styles.messagesList}
        />
      )}

      {/* Composer */}
      <View style={styles.composerContainer}>
        {isEnded ? (
          <View style={styles.disabledComposer}>
            <Text style={styles.disabledComposerText}>This conversation has ended.</Text>
          </View>
        ) : isRestricted ? (
          <View style={styles.disabledComposer}>
            <Text style={styles.disabledComposerText}>
              Composer paused by your Angel.
            </Text>
          </View>
        ) : (
          <View style={styles.composerRow}>
            <TextInput
              style={styles.composerInput}
              placeholder="Type a message..."
              placeholderTextColor={theme.colors.textMuted}
              value={inputText}
              onChangeText={setInputText}
              multiline
            />
            <TouchableOpacity
              style={[
                styles.sendBtn,
                (!inputText.trim() || sendMessageMutation.isPending) && styles.sendBtnDisabled,
              ]}
              onPress={handleSend}
              disabled={!inputText.trim() || sendMessageMutation.isPending || e2eeQuery.data !== "ready"}
            >
              <Text style={styles.sendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Chat Info Modal */}
      <Modal visible={infoModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Conversation Controls</Text>
              <TouchableOpacity onPress={() => setInfoModalVisible(false)}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 400 }}>
              <View style={styles.sheetSection}>
                <Text style={styles.sheetSectionTitle}>Encryption identity</Text>
                {safetyVerificationQuery.isLoading ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : safetyVerificationQuery.data ? (
                  <>
                    <Text style={styles.safetyCode}>
                      {formatSafetyCode(safetyVerificationQuery.data.safetyCode)}
                    </Text>
                    <Text style={styles.sheetMuted}>
                      {safetyVerificationQuery.data.verified
                        ? "Verified on this device."
                        : safetyVerificationQuery.data.changed
                          ? "This code changed. Verify it with your partner again."
                          : "Not verified. Compare this code with your partner over a separate trusted channel."}
                    </Text>
                    {!safetyVerificationQuery.data.verified ? (
                      <TouchableOpacity
                        style={styles.safetyVerifyBtn}
                        onPress={() => verifySafetyCodeMutation.mutate()}
                        disabled={verifySafetyCodeMutation.isPending}
                      >
                        <Text style={styles.safetyVerifyText}>
                          {verifySafetyCodeMutation.isPending ? "Saving…" : "I compared the code and it matches"}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.sheetMuted}>The encryption verification code is unavailable.</Text>
                )}
              </View>

              {/* Own Angels Status (D8) */}
              <View style={styles.sheetSection}>
                <Text style={styles.sheetSectionTitle}>Your Assigned Angels</Text>
                {chat?.ownAngels && chat.ownAngels.length > 0 ? (
                  chat.ownAngels.map((a: any) => (
                    <View key={a.id} style={styles.angelCard}>
                      <View>
                        <Text style={styles.angelName}>@{a.angelUsername || a.angelUserId}</Text>
                        <Text style={styles.angelStatus}>
                          {a.hasActiveRestriction ? "Imposed send pause" : "Active oversight"}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={styles.leaveReqBtn}
                        onPress={() => leaveRequestMutation.mutate(a.angelUserId)}
                      >
                        <Text style={styles.leaveReqBtnText}>"I'm Comfortable" (Ask to Leave)</Text>
                      </TouchableOpacity>
                    </View>
                  ))
                ) : (
                  <Text style={styles.sheetMuted}>No Angels currently protecting your side.</Text>
                )}
              </View>

              {/* Invite Angel into Chat (D7) */}
              {!isProtected ? (
                <View style={styles.sheetSection}>
                  <Text style={styles.sheetSectionTitle}>Invite Angel to Supervise</Text>
                  {protectionData?.angels && protectionData.angels.length > 0 ? (
                    protectionData.angels.map((a) => (
                      <TouchableOpacity
                        key={a.id}
                        style={styles.inviteAngelBtn}
                        onPress={() => inviteAngelMutation.mutate(a.id)}
                      >
                        <Text style={styles.inviteAngelBtnText}>
                          Invite @{a.username} into this chat
                        </Text>
                      </TouchableOpacity>
                    ))
                  ) : (
                    <Text style={styles.sheetMuted}>
                      Configure Angels in Settings to invite them here.
                    </Text>
                  )}
                </View>
              ) : null}

              {/* Safety Actions */}
              <View style={styles.sheetSection}>
                <Text style={styles.sheetSectionTitle}>Safety & Actions</Text>
                <TouchableOpacity
                  style={[styles.actionBtn, { borderColor: theme.colors.warning }]}
                  onPress={() => {
                    setInfoModalVisible(false);
                    setSelectedEvidenceIds([]);
                    setReportModalVisible(true);
                  }}
                >
                  <Text style={[styles.actionBtnText, { color: theme.colors.warning }]}>
                    ⚠️ Report Conversation
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.actionBtn, { borderColor: theme.colors.danger }]}
                  onPress={() => {
                    if (confirm("Are you sure you want to block this user?")) {
                      blockUserMutation.mutate(partnerId);
                    }
                  }}
                >
                  <Text style={[styles.actionBtnText, { color: theme.colors.danger }]}>
                    🚫 Block User
                  </Text>
                </TouchableOpacity>

                {!isEnded ? (
                  <TouchableOpacity
                    style={[styles.actionBtn, { borderColor: theme.colors.textMuted }]}
                    onPress={() => {
                      if (confirm("End this conversation?")) {
                        endChatMutation.mutate();
                      }
                    }}
                  >
                    <Text style={[styles.actionBtnText, { color: theme.colors.text }]}>
                      🛑 End Conversation
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Report Modal */}
      <Modal visible={reportModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Report Conversation</Text>
            <Text style={styles.modalSub}>
              Choose only the messages you want support staff to review. No messages are attached by default.
            </Text>

            <Text style={styles.evidenceHeading}>Optional message evidence</Text>
            <ScrollView style={styles.evidenceList} nestedScrollEnabled>
              {messages.slice(-10).map((message) => {
                const selected = selectedEvidenceIds.includes(message.id);
                return (
                  <TouchableOpacity
                    key={message.id}
                    style={[styles.evidenceItem, selected && styles.evidenceItemSelected]}
                    onPress={() =>
                      setSelectedEvidenceIds((current) =>
                        selected
                          ? current.filter((id) => id !== message.id)
                          : [...current, message.id]
                      )
                    }
                  >
                    <Text style={styles.evidenceCheck}>{selected ? "☑" : "☐"}</Text>
                    <Text style={styles.evidenceText} numberOfLines={2}>
                      {message.plaintext || "Message unavailable"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TextInput
              style={styles.reportInput}
              placeholder="Reason (e.g. harassment, scam, inappropriate conduct)..."
              placeholderTextColor={theme.colors.textMuted}
              value={reportReason}
              onChangeText={setReportReason}
            />

            <TextInput
              style={[styles.reportInput, { minHeight: 60, marginTop: 8 }]}
              placeholder="Additional details..."
              placeholderTextColor={theme.colors.textMuted}
              multiline
              value={reportDetails}
              onChangeText={setReportDetails}
            />

            <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
              <TouchableOpacity
                style={[styles.modalSubmitBtn, !reportReason.trim() && { opacity: 0.5 }]}
                disabled={!reportReason.trim() || submitReportMutation.isPending}
                onPress={() => submitReportMutation.mutate()}
              >
                <Text style={styles.modalBtnText}>Submit Report</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setReportModalVisible(false)}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  topBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: theme.colors.card,
    padding: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  bannerInfo: {
    gap: 4,
  },
  partnerHeaderTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.text,
  },
  modePill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  modeComfort: {
    backgroundColor: "rgba(59, 130, 246, 0.15)",
    borderColor: theme.colors.comfort,
  },
  modeProtected: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderColor: theme.colors.protected,
  },
  modePillText: {
    fontSize: 10,
    fontWeight: "700",
  },
  modeTextComfort: { color: theme.colors.comfort },
  modeTextProtected: { color: theme.colors.protected },
  infoBtn: {
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radii.full,
  },
  infoBtnText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  restrictionBanner: {
    backgroundColor: "rgba(245, 158, 11, 0.2)",
    borderColor: theme.colors.warning,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    gap: 8,
  },
  restrictionIcon: { fontSize: 16 },
  restrictionText: {
    color: theme.colors.warning,
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  messagesList: {
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  messageBubble: {
    maxWidth: "80%",
    padding: 12,
    borderRadius: theme.radii.md,
  },
  myMessage: {
    alignSelf: "flex-end",
    backgroundColor: theme.colors.primary,
    borderBottomRightRadius: 2,
  },
  partnerMessage: {
    alignSelf: "flex-start",
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderBottomLeftRadius: 2,
  },
  messageText: {
    color: "#fff",
    fontSize: 15,
    lineHeight: 20,
  },
  messageTime: {
    fontSize: 10,
    color: "rgba(255,255,255,0.6)",
    alignSelf: "flex-end",
    marginTop: 4,
  },
  whisperBubble: {
    backgroundColor: "rgba(236, 72, 153, 0.15)",
    borderColor: "#ec4899",
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: 12,
    marginVertical: 4,
    alignSelf: "center",
    width: "90%",
  },
  whisperHeader: {
    color: "#ec4899",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    marginBottom: 4,
  },
  whisperText: {
    color: theme.colors.text,
    fontSize: 14,
    fontStyle: "italic",
  },
  whisperTime: {
    fontSize: 10,
    color: theme.colors.textMuted,
    alignSelf: "flex-end",
    marginTop: 4,
  },
  composerContainer: {
    backgroundColor: theme.colors.card,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing.sm,
  },
  composerRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  composerInput: {
    flex: 1,
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.full,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: theme.colors.text,
    maxHeight: 100,
    fontSize: 14,
  },
  sendBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: theme.radii.full,
  },
  sendBtnDisabled: {
    opacity: 0.5,
  },
  sendBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
  disabledComposer: {
    padding: 12,
    alignItems: "center",
  },
  disabledComposerText: {
    color: theme.colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.8)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: theme.colors.card,
    borderTopLeftRadius: theme.radii.lg,
    borderTopRightRadius: theme.radii.lg,
    padding: theme.spacing.lg,
    borderColor: theme.colors.border,
    borderWidth: 1,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: theme.spacing.md,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.text,
  },
  modalCloseText: {
    fontSize: 18,
    color: theme.colors.textMuted,
  },
  sheetSection: {
    marginBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingBottom: theme.spacing.md,
  },
  sheetSectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.textMuted,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  safetyCode: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  safetyVerifyBtn: {
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.primary,
    borderWidth: 1,
    padding: 10,
    borderRadius: theme.radii.sm,
    alignItems: "center",
    marginTop: 10,
  },
  safetyVerifyText: {
    color: theme.colors.primary,
    fontWeight: "600",
    fontSize: 13,
  },
  sheetMuted: {
    fontSize: 13,
    color: theme.colors.textMuted,
    fontStyle: "italic",
  },
  angelCard: {
    backgroundColor: theme.colors.bg,
    padding: 10,
    borderRadius: theme.radii.sm,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  angelName: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 14,
  },
  angelStatus: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
  leaveReqBtn: {
    backgroundColor: "rgba(99, 102, 241, 0.2)",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  leaveReqBtnText: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: "700",
  },
  inviteAngelBtn: {
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.primary,
    borderWidth: 1,
    padding: 10,
    borderRadius: theme.radii.sm,
    alignItems: "center",
    marginBottom: 6,
  },
  inviteAngelBtnText: {
    color: theme.colors.primary,
    fontWeight: "600",
    fontSize: 13,
  },
  actionBtn: {
    backgroundColor: theme.colors.bg,
    borderWidth: 1,
    padding: 12,
    borderRadius: theme.radii.sm,
    alignItems: "center",
    marginBottom: 8,
  },
  actionBtnText: {
    fontWeight: "700",
    fontSize: 13,
  },
  reportInput: {
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.sm,
    padding: 10,
    color: theme.colors.text,
    fontSize: 14,
  },
  evidenceHeading: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 6,
  },
  evidenceList: {
    maxHeight: 150,
    marginBottom: 10,
  },
  evidenceItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.sm,
    padding: 8,
    marginBottom: 6,
  },
  evidenceItemSelected: {
    borderColor: theme.colors.warning,
  },
  evidenceCheck: {
    color: theme.colors.warning,
    fontSize: 16,
  },
  evidenceText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 12,
  },
  modalSub: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginBottom: 12,
  },
  modalSubmitBtn: {
    flex: 1,
    backgroundColor: theme.colors.danger,
    padding: 12,
    borderRadius: theme.radii.sm,
    alignItems: "center",
  },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: theme.colors.border,
    padding: 12,
    borderRadius: theme.radii.sm,
    alignItems: "center",
  },
  modalBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
});
