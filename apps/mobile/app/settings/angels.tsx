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
  Switch,
  Alert,
} from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { theme } from "../../src/theme.js";
import { apiRequest } from "../../src/api/client.js";

export default function MyAngelsScreen() {
  const queryClient = useQueryClient();

  // Invite Angel state
  const [inviteModalVisible, setInviteModalVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Scope Editor state
  const [scopeModalVisible, setScopeModalVisible] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<any>(null);
  const [personConditions, setPersonConditions] = useState<string[]>([]);
  const [purposeCategories, setPurposeCategories] = useState<string[]>([]);
  const [applyToExisting, setApplyToExisting] = useState(false);

  // Fetch Angels
  const { data, isLoading } = useQuery({
    queryKey: ["my-protection"],
    queryFn: () =>
      apiRequest<{ approvalThreshold: string; angels: any[] }>("/api/v1/me/protection"),
  });

  // Fetch Purposes from config
  const { data: configData } = useQuery({
    queryKey: ["purposes"],
    queryFn: () => apiRequest<{ purposes: string[] }>("/api/v1/config/conversation-purposes"),
  });

  // Search users for invite
  const { data: searchResults, isFetching: searching } = useQuery({
    queryKey: ["search-angel-users", searchQuery],
    queryFn: () => apiRequest<{ users: any[] }>(`/api/v1/users/search?q=${encodeURIComponent(searchQuery)}`),
    enabled: searchQuery.trim().length > 1,
  });

  // Mutations
  const inviteMutation = useMutation({
    mutationFn: (angelUserId: string) =>
      apiRequest("/api/v1/me/angels", {
        method: "POST",
        body: JSON.stringify({ angelUserId }),
      }),
    onSuccess: () => {
      setInviteModalVisible(false);
      setSelectedUser(null);
      setSearchQuery("");
      setInviteError(null);
      queryClient.invalidateQueries({ queryKey: ["my-protection"] });
    },
    onError: (err: any) => {
      setInviteError(err.message || "Failed to invite Angel");
    },
  });

  const updateScopeMutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/me/angels/${editingAssignment.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          personConditions,
          purposeCategories,
          applyToExisting,
        }),
      }),
    onSuccess: () => {
      setScopeModalVisible(false);
      setEditingAssignment(null);
      queryClient.invalidateQueries({ queryKey: ["my-protection"] });
      alert("Angel protection scope updated.");
    },
  });

  const previewScopeMutation = useMutation({
    mutationFn: () =>
      apiRequest<{
        impacts: Array<{
          chatId: string;
          partner: { username: string; displayName: string };
          purpose: string;
          effect: "GAIN" | "LOSE";
        }>;
      }>(`/api/v1/me/angels/${editingAssignment.id}/scope-preview`, {
        method: "POST",
        body: JSON.stringify({ personConditions, purposeCategories, applyToExisting: true }),
      }),
    onSuccess: ({ impacts }) => {
      const details = impacts.length
        ? impacts
            .map(
              (impact) =>
                `${impact.effect === "GAIN" ? "+" : "−"} @${impact.partner.username} · ${impact.purpose}`
            )
            .join("\n")
        : "No active chats would change.";
      Alert.alert(
        "Review existing chat access",
        `${details}\n\nNew access starts now and never includes earlier messages. Removed access ends immediately.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Confirm Changes", onPress: () => updateScopeMutation.mutate() },
        ]
      );
    },
  });

  const removeAngelMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/me/angels/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-protection"] });
      alert("Angel removed. 30-day trust cooldown initiated (D14).");
    },
  });

  const angels = data?.angels || [];
  const purposes = configData?.purposes || ["Social / personal", "Business inquiry", "Other"];

  const openScopeEditor = (assignment: any) => {
    setEditingAssignment(assignment);
    setPersonConditions(assignment.conditions?.personConditions || []);
    setPurposeCategories(assignment.conditions?.purposeCategories || []);
    setApplyToExisting(false);
    setScopeModalVisible(true);
  };

  const togglePersonCondition = (cond: string) => {
    setPersonConditions((prev) =>
      prev.includes(cond) ? prev.filter((c) => c !== cond) : [...prev, cond]
    );
  };

  const togglePurpose = (purp: string) => {
    setPurposeCategories((prev) =>
      prev.includes(purp) ? prev.filter((p) => p !== purp) : [...prev, purp]
    );
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>My Angels</Text>
          <Text style={styles.headerSubtitle}>
            Configure trusted people who oversee your conversations and keep you comfortable.
          </Text>
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => {
            setInviteError(null);
            setInviteModalVisible(true);
          }}
        >
          <Text style={styles.addBtnText}>+ Invite Angel</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : angels.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyIcon}>🛡️</Text>
          <Text style={styles.emptyTitle}>No Angels Assigned Yet</Text>
          <Text style={styles.emptySubtitle}>
            Invite someone you trust (such as a mahram, guardian, or business manager). They must accept before protection activates.
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {angels.map((a) => {
            const isActive = a.status === "ACTIVE";
            const conds = a.conditions?.personConditions || [];
            const purps = a.conditions?.purposeCategories || [];

            return (
              <View key={a.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <View>
                    <Text style={styles.angelName}>@{a.username}</Text>
                    <Text style={styles.angelDisplay}>{a.displayName}</Text>
                  </View>
                  <View
                    style={[
                      styles.statusPill,
                      isActive ? styles.statusActive : styles.statusPending,
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusText,
                        isActive ? styles.statusTextActive : styles.statusTextPending,
                      ]}
                    >
                      {a.status}
                    </Text>
                  </View>
                </View>

                {isActive ? (
                  <View style={styles.scopeSummary}>
                    <Text style={styles.scopeTitle}>Protection Scope:</Text>
                    <Text style={styles.scopeItem}>
                      • People Conditions:{" "}
                      {conds.length > 0 ? conds.join(", ") : "None configured"}
                    </Text>
                    <Text style={styles.scopeItem}>
                      • Purpose Categories:{" "}
                      {purps.length > 0 ? purps.join(", ") : "All purposes"}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.pendingNotice}>
                    Invitation sent. Awaiting acceptance from @{a.username}.
                  </Text>
                )}

                <View style={styles.btnRow}>
                  {isActive ? (
                    <TouchableOpacity
                      style={[styles.btn, styles.scopeBtn]}
                      onPress={() => openScopeEditor(a)}
                    >
                      <Text style={styles.btnText}>Configure Scope</Text>
                    </TouchableOpacity>
                  ) : null}

                  <TouchableOpacity
                    style={[styles.btn, styles.removeBtn]}
                    onPress={() => {
                      if (
                        confirm(
                          `Are you sure you want to remove @${a.username}? Trust-related Angel removal starts a 30-day cooldown (D14).`
                        )
                      ) {
                        removeAngelMutation.mutate(a.id);
                      }
                    }}
                  >
                    <Text style={[styles.btnText, { color: theme.colors.danger }]}>
                      Remove Angel
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* Scope Editor Modal */}
      <Modal visible={scopeModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              Configure Scope for @{editingAssignment?.username}
            </Text>
            <Text style={styles.modalSub}>
              Choose who and what this Angel protects. Multiple Angels can protect overlapping conversations (D12).
            </Text>

            <ScrollView style={{ maxHeight: 380 }}>
              <Text style={styles.groupHeading}>1. Person Conditions</Text>
              <View style={styles.chipRow}>
                {["OPPOSITE_SEX", "STRANGER", "ALL_CONTACTS"].map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[styles.chip, personConditions.includes(c) && styles.chipActive]}
                    onPress={() => togglePersonCondition(c)}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        personConditions.includes(c) && styles.chipTextActive,
                      ]}
                    >
                      {c.replace("_", " ")}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[styles.groupHeading, { marginTop: 14 }]}>
                2. Conversation Purposes
              </Text>
              <View style={styles.chipRow}>
                {purposes.map((p) => (
                  <TouchableOpacity
                    key={p}
                    style={[styles.chip, purposeCategories.includes(p) && styles.chipActive]}
                    onPress={() => togglePurpose(p)}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        purposeCategories.includes(p) && styles.chipTextActive,
                      ]}
                    >
                      {p}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.switchLabel}>Apply to Existing Chats (D9)</Text>
                  <Text style={styles.switchSub}>
                    Defaults to new conversations only. Turn on to update active chats.
                  </Text>
                </View>
                <Switch
                  value={applyToExisting}
                  onValueChange={setApplyToExisting}
                  trackColor={{ true: theme.colors.primary, false: theme.colors.border }}
                />
              </View>
            </ScrollView>

            <View style={styles.btnRow}>
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: theme.colors.primary }]}
                onPress={() =>
                  applyToExisting
                    ? previewScopeMutation.mutate()
                    : updateScopeMutation.mutate()
                }
                disabled={updateScopeMutation.isPending || previewScopeMutation.isPending}
              >
                <Text style={styles.btnText}>Save Scope</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: theme.colors.card }]}
                onPress={() => setScopeModalVisible(false)}
              >
                <Text style={styles.btnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Invite Angel Modal */}
      <Modal visible={inviteModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Invite Trusted Angel</Text>
            <Text style={styles.modalSub}>
              Search by username. The user will receive an invitation to accept (D1).
            </Text>

            {inviteError ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{inviteError}</Text>
              </View>
            ) : null}

            <TextInput
              style={styles.modalInput}
              placeholder="Search username (e.g. sara_guardian)..."
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
                <Text style={styles.selectedLabel}>Target Angel:</Text>
                <Text style={styles.selectedVal}>@{selectedUser.username}</Text>
              </View>
            ) : null}

            <View style={[styles.btnRow, { marginTop: 16 }]}>
              <TouchableOpacity
                style={[
                  styles.btn,
                  { backgroundColor: theme.colors.primary },
                  (!selectedUser || inviteMutation.isPending) && { opacity: 0.5 },
                ]}
                disabled={!selectedUser || inviteMutation.isPending}
                onPress={() => inviteMutation.mutate(selectedUser.id)}
              >
                <Text style={styles.btnText}>Send Angel Invitation</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: theme.colors.card }]}
                onPress={() => setInviteModalVisible(false)}
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
    padding: theme.spacing.md,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: theme.spacing.md,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: theme.colors.text,
  },
  headerSubtitle: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginTop: 2,
    lineHeight: 16,
  },
  addBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radii.full,
  },
  addBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  center: {
    padding: 30,
    alignItems: "center",
  },
  emptyCard: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.xl,
    alignItems: "center",
    marginTop: 20,
  },
  emptyIcon: { fontSize: 48, marginBottom: 8 },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.text,
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 13,
    color: theme.colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
  list: { gap: theme.spacing.sm },
  card: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
  },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  angelName: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.text,
  },
  angelDisplay: {
    fontSize: 13,
    color: theme.colors.textMuted,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.radii.full,
    borderWidth: 1,
  },
  statusActive: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderColor: theme.colors.protected,
  },
  statusPending: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderColor: theme.colors.warning,
  },
  statusText: { fontSize: 10, fontWeight: "700" },
  statusTextActive: { color: theme.colors.protected },
  statusTextPending: { color: theme.colors.warning },
  scopeSummary: {
    backgroundColor: theme.colors.bg,
    padding: 10,
    borderRadius: 6,
    marginTop: 10,
  },
  scopeTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.textMuted,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  scopeItem: {
    fontSize: 12,
    color: theme.colors.text,
    lineHeight: 18,
  },
  pendingNotice: {
    fontSize: 12,
    color: theme.colors.warning,
    fontStyle: "italic",
    marginTop: 8,
  },
  btnRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  btn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: "center",
  },
  scopeBtn: {
    backgroundColor: "rgba(99, 102, 241, 0.15)",
    borderColor: theme.colors.primary,
    borderWidth: 1,
  },
  removeBtn: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderColor: theme.colors.danger,
    borderWidth: 1,
  },
  btnText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: "600",
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
  groupHeading: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.text,
    marginBottom: 6,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
  },
  chipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: "rgba(99, 102, 241, 0.2)",
  },
  chipText: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
  chipTextActive: {
    color: theme.colors.primary,
    fontWeight: "700",
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 14,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  switchLabel: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  switchSub: {
    color: theme.colors.textMuted,
    fontSize: 11,
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
  userList: {
    marginTop: 6,
    backgroundColor: theme.colors.bg,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  userItem: {
    padding: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  userItemActive: {
    backgroundColor: "rgba(99, 102, 241, 0.2)",
  },
  userItemName: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 13,
  },
  userItemSub: {
    color: theme.colors.textMuted,
    fontSize: 11,
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
    fontSize: 12,
  },
  selectedVal: {
    color: theme.colors.text,
    fontSize: 12,
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
