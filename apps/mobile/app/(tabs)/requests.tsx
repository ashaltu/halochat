import React, { useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Modal,
  ScrollView,
} from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../src/api/client.js";
import { theme } from "../../src/theme.js";

export default function RequestsScreen() {
  const queryClient = useQueryClient();
  const [box, setBox] = useState<"inbox" | "outbox">("inbox");
  const [modalVisible, setModalVisible] = useState(false);

  // New Request Form State
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [selectedPurpose, setSelectedPurpose] = useState<string>("Social / personal");
  const [formError, setFormError] = useState<string | null>(null);

  // Fetch Requests
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["requests", box],
    queryFn: () => apiRequest<{ requests: any[] }>(`/api/v1/requests?box=${box}`),
    refetchInterval: 10000,
  });

  // Fetch Purposes from config
  const { data: configData } = useQuery({
    queryKey: ["purposes"],
    queryFn: () => apiRequest<{ purposes: string[] }>("/api/v1/config/conversation-purposes"),
  });

  // Search users for new request
  const { data: searchResults, isFetching: searching } = useQuery({
    queryKey: ["search-users", searchQuery],
    queryFn: () => apiRequest<{ users: any[] }>(`/api/v1/users/search?q=${encodeURIComponent(searchQuery)}`),
    enabled: searchQuery.trim().length > 1,
  });

  // Mutations
  const acceptMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/requests/${id}/accept`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["requests"] });
      queryClient.invalidateQueries({ queryKey: ["chats"] });
    },
  });

  const declineMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/requests/${id}/decline`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["requests"] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/requests/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["requests"] });
    },
  });

  const sendRequestMutation = useMutation({
    mutationFn: () =>
      apiRequest("/api/v1/requests", {
        method: "POST",
        body: JSON.stringify({
          recipientId: selectedUser.id,
          purpose: selectedPurpose,
        }),
      }),
    onSuccess: () => {
      setModalVisible(false);
      setSelectedUser(null);
      setSearchQuery("");
      queryClient.invalidateQueries({ queryKey: ["requests"] });
    },
    onError: (err: any) => {
      setFormError(err.message || "Failed to send request");
    },
  });

  const requests = data?.requests || [];
  const purposes = configData?.purposes || ["Social / personal", "Business inquiry", "Other"];

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <View style={styles.segment}>
          <TouchableOpacity
            style={[styles.segmentBtn, box === "inbox" && styles.segmentBtnActive]}
            onPress={() => setBox("inbox")}
          >
            <Text style={[styles.segmentText, box === "inbox" && styles.segmentTextActive]}>
              Inbox
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segmentBtn, box === "outbox" && styles.segmentBtnActive]}
            onPress={() => setBox("outbox")}
          >
            <Text style={[styles.segmentText, box === "outbox" && styles.segmentTextActive]}>
              Outbox
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.newRequestBtn}
          onPress={() => {
            setFormError(null);
            setModalVisible(true);
          }}
        >
          <Text style={styles.newRequestBtnText}>+ Send Request</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : requests.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>✉️</Text>
          <Text style={styles.emptyText}>No {box} requests found.</Text>
        </View>
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(item) => item.request.id}
          renderItem={({ item }) => {
            const req = item.request;
            const otherUser = box === "inbox" ? item.requester : item.recipient;
            const isPending = req.state === "PENDING" || req.state === "PENDING_RECIPIENT";
            const isPendingAngel = req.state === "PENDING_ANGEL";

            return (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <View>
                    <Text style={styles.cardUsername}>@{otherUser?.username}</Text>
                    <Text style={styles.cardDisplayName}>{otherUser?.displayName}</Text>
                  </View>
                  <View style={styles.purposePill}>
                    <Text style={styles.purposeText}>{req.purpose}</Text>
                  </View>
                </View>

                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>Status:</Text>
                  <Text style={[styles.statusVal, styles[`status_${req.state}` as keyof typeof styles]]}>
                    {isPendingAngel ? "AWAITING ANGEL APPROVAL" : req.state}
                  </Text>
                </View>

                {box === "inbox" && isPending ? (
                  <View style={styles.actionRow}>
                    <TouchableOpacity
                      style={[styles.btn, styles.acceptBtn]}
                      onPress={() => acceptMutation.mutate(req.id)}
                    >
                      <Text style={styles.btnText}>Accept</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.btn, styles.declineBtn]}
                      onPress={() => declineMutation.mutate(req.id)}
                    >
                      <Text style={styles.btnText}>Decline</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}

                {box === "outbox" && (isPending || isPendingAngel) ? (
                  <View style={styles.actionRow}>
                    <TouchableOpacity
                      style={[styles.btn, styles.declineBtn]}
                      onPress={() => cancelMutation.mutate(req.id)}
                    >
                      <Text style={styles.btnText}>Cancel Request</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            );
          }}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* New Request Modal */}
      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Contact Request</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            {formError ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{formError}</Text>
              </View>
            ) : null}

            <ScrollView style={{ maxHeight: 400 }}>
              <Text style={styles.inputLabel}>1. Search User by Username</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Type username..."
                placeholderTextColor={theme.colors.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
              />

              {searching ? <ActivityIndicator size="small" style={{ margin: 8 }} /> : null}

              {searchResults?.users && searchResults.users.length > 0 ? (
                <View style={styles.userList}>
                  {searchResults.users.map((u) => (
                    <TouchableOpacity
                      key={u.id}
                      style={[
                        styles.userItem,
                        selectedUser?.id === u.id && styles.userItemActive,
                      ]}
                      onPress={() => setSelectedUser(u)}
                    >
                      <Text style={styles.userItemName}>@{u.username}</Text>
                      <Text style={styles.userItemSub}>{u.displayName}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}

              {selectedUser ? (
                <View style={styles.selectedBox}>
                  <Text style={styles.selectedLabel}>Target:</Text>
                  <Text style={styles.selectedVal}>@{selectedUser.username} ({selectedUser.displayName})</Text>
                </View>
              ) : null}

              <Text style={[styles.inputLabel, { marginTop: 16 }]}>2. Select Conversation Purpose</Text>
              <View style={styles.purposeList}>
                {purposes.map((p) => (
                  <TouchableOpacity
                    key={p}
                    style={[
                      styles.purposeOption,
                      selectedPurpose === p && styles.purposeOptionActive,
                    ]}
                    onPress={() => setSelectedPurpose(p)}
                  >
                    <Text
                      style={[
                        styles.purposeOptionText,
                        selectedPurpose === p && styles.purposeOptionTextActive,
                      ]}
                    >
                      {p}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>

            <TouchableOpacity
              style={[
                styles.submitBtn,
                (!selectedUser || sendRequestMutation.isPending) && styles.submitBtnDisabled,
              ]}
              disabled={!selectedUser || sendRequestMutation.isPending}
              onPress={() => sendRequestMutation.mutate()}
            >
              {sendRequestMutation.isPending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitBtnText}>Send Request</Text>
              )}
            </TouchableOpacity>
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
  topBar: {
    padding: theme.spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  segment: {
    flexDirection: "row",
    backgroundColor: theme.colors.card,
    borderRadius: theme.radii.full,
    padding: 3,
  },
  segmentBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: theme.radii.full,
  },
  segmentBtnActive: {
    backgroundColor: theme.colors.primary,
  },
  segmentText: {
    color: theme.colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
  },
  segmentTextActive: {
    color: "#fff",
  },
  newRequestBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radii.full,
  },
  newRequestBtnText: {
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
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 8,
  },
  emptyText: {
    color: theme.colors.textMuted,
    fontSize: 15,
  },
  listContent: {
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  card: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  cardUsername: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.text,
  },
  cardDisplayName: {
    fontSize: 13,
    color: theme.colors.textMuted,
  },
  purposePill: {
    backgroundColor: "rgba(99, 102, 241, 0.15)",
    borderColor: theme.colors.primary,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.radii.full,
  },
  purposeText: {
    color: theme.colors.primary,
    fontSize: 11,
    fontWeight: "600",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
  },
  statusLabel: {
    fontSize: 12,
    color: theme.colors.textMuted,
  },
  statusVal: {
    fontSize: 12,
    fontWeight: "700",
  },
  status_PENDING: { color: theme.colors.warning },
  status_PENDING_RECIPIENT: { color: theme.colors.warning },
  status_PENDING_ANGEL: { color: "#ec4899" },
  status_ACCEPTED: { color: theme.colors.protected },
  status_DECLINED: { color: theme.colors.danger },
  status_CANCELLED: { color: theme.colors.textMuted },
  actionRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    marginTop: 12,
  },
  btn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: theme.radii.sm,
    alignItems: "center",
  },
  acceptBtn: {
    backgroundColor: theme.colors.protected,
  },
  declineBtn: {
    backgroundColor: theme.colors.border,
  },
  btnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 13,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  modalContent: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.lg,
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
  inputLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.text,
    marginBottom: 4,
  },
  textInput: {
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: 10,
    color: theme.colors.text,
    fontSize: 14,
  },
  userList: {
    marginTop: 6,
    backgroundColor: theme.colors.bg,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  userItem: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  userItemActive: {
    backgroundColor: "rgba(99, 102, 241, 0.2)",
  },
  userItemName: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 14,
  },
  userItemSub: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
  selectedBox: {
    flexDirection: "row",
    gap: 6,
    marginTop: 8,
    padding: 8,
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderRadius: 6,
  },
  selectedLabel: {
    color: theme.colors.protected,
    fontWeight: "700",
    fontSize: 13,
  },
  selectedVal: {
    color: theme.colors.text,
    fontSize: 13,
  },
  purposeList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
  },
  purposeOption: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
  },
  purposeOptionActive: {
    borderColor: theme.colors.primary,
    backgroundColor: "rgba(99, 102, 241, 0.2)",
  },
  purposeOptionText: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
  purposeOptionTextActive: {
    color: theme.colors.primary,
    fontWeight: "700",
  },
  submitBtn: {
    backgroundColor: theme.colors.primary,
    paddingVertical: 12,
    borderRadius: theme.radii.md,
    alignItems: "center",
    marginTop: 16,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
});
