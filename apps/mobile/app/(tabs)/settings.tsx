import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Modal,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { theme } from "../../src/theme.js";
import { useAuthStore } from "../../src/stores/auth.js";
import { apiRequest } from "../../src/api/client.js";

export default function SettingsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, setUser, logout } = useAuthStore();

  // Correction Modal State
  const [correctionModalVisible, setCorrectionModalVisible] = useState(false);
  const [correctionField, setCorrectionField] = useState<"DOB" | "SEX">("DOB");
  const [proposedValue, setProposedValue] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  // Edit Display Name State
  const [isEditingName, setIsEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(user?.displayName || "");

  // Protection Settings Query
  const { data: protectionData } = useQuery({
    queryKey: ["my-protection"],
    queryFn: () =>
      apiRequest<{ approvalThreshold: string; angels: any[] }>("/api/v1/me/protection"),
  });

  const updateThresholdMutation = useMutation({
    mutationFn: (threshold: "ANY_ONE" | "ALL") =>
      apiRequest("/api/v1/me/protection", {
        method: "PATCH",
        body: JSON.stringify({ approvalThreshold: threshold }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-protection"] }),
  });

  const updateNameMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest<{ user: any }>("/api/v1/me", {
        method: "PATCH",
        body: JSON.stringify({ displayName: name }),
      }),
    onSuccess: (res) => {
      setUser(res.user);
      setIsEditingName(false);
    },
  });

  const submitCorrectionMutation = useMutation({
    mutationFn: () => {
      if (!acknowledged) {
        throw new Error("You must acknowledge the review consequences.");
      }
      return apiRequest("/api/v1/support/profile-corrections", {
        method: "POST",
        body: JSON.stringify({
          field: correctionField,
          proposedValue,
          reason: correctionReason,
          acknowledgement: true,
        }),
      });
    },
    onSuccess: () => {
      setCorrectionModalVisible(false);
      setProposedValue("");
      setCorrectionReason("");
      setAcknowledged(false);
      setCorrectionError(null);
      alert("Correction ticket submitted for admin review.");
    },
    onError: (err: any) => {
      setCorrectionError(err.message || "Failed to submit correction");
    },
  });

  const threshold = protectionData?.approvalThreshold || "ANY_ONE";

  return (
    <ScrollView style={styles.container}>
      {/* Profile Card */}
      <View style={styles.card}>
        <View style={styles.avatarRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {user?.displayName ? user.displayName[0].toUpperCase() : "U"}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            {isEditingName ? (
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <TextInput
                  style={[styles.input, { flex: 1, padding: 6 }]}
                  value={displayName}
                  onChangeText={setDisplayName}
                />
                <TouchableOpacity
                  style={[styles.smallBtn, { backgroundColor: theme.colors.primary }]}
                  onPress={() => updateNameMutation.mutate(displayName)}
                >
                  <Text style={styles.smallBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={styles.displayName}>{user?.displayName}</Text>
                <TouchableOpacity onPress={() => setIsEditingName(true)}>
                  <Text style={{ fontSize: 13, color: theme.colors.primary }}>Edit</Text>
                </TouchableOpacity>
              </View>
            )}
            <Text style={styles.username}>@{user?.username}</Text>
          </View>
        </View>

        <View style={styles.infoGrid}>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Date of Birth</Text>
            <Text style={styles.infoVal}>{user?.dateOfBirth}</Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>Sex</Text>
            <Text style={styles.infoVal}>{user?.sex}</Text>
          </View>
        </View>
      </View>

      {/* Angels Navigation */}
      <TouchableOpacity
        style={styles.navRow}
        onPress={() => router.push("/settings/angels")}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text style={{ fontSize: 20 }}>🛡️</Text>
          <View>
            <Text style={styles.navRowTitle}>My Angels & Protection Scope</Text>
            <Text style={styles.navRowSub}>
              {protectionData?.angels?.length || 0} active/pending Angels
            </Text>
          </View>
        </View>
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>

      {/* Approval Policy */}
      <View style={styles.card}>
        <Text style={styles.sectionHeading}>Angel Approval Threshold</Text>
        <Text style={styles.sectionSub}>
          Determines how many Angels must approve a contact request before opening a Protected chat.
        </Text>

        <View style={styles.thresholdOptions}>
          <TouchableOpacity
            style={[
              styles.thresholdBtn,
              threshold === "ANY_ONE" && styles.thresholdBtnActive,
            ]}
            onPress={() => updateThresholdMutation.mutate("ANY_ONE")}
          >
            <Text
              style={[
                styles.thresholdBtnText,
                threshold === "ANY_ONE" && styles.thresholdBtnTextActive,
              ]}
            >
              Any One Angel (Recommended)
            </Text>
            <Text style={styles.thresholdDesc}>
              One approval is sufficient even if other Angels decline.
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.thresholdBtn, threshold === "ALL" && styles.thresholdBtnActive]}
            onPress={() => updateThresholdMutation.mutate("ALL")}
          >
            <Text
              style={[
                styles.thresholdBtnText,
                threshold === "ALL" && styles.thresholdBtnTextActive,
              ]}
            >
              All Angels Required
            </Text>
            <Text style={styles.thresholdDesc}>
              Every assigned Angel must approve. Any decline blocks the request.
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* DOB/Sex Correction */}
      <View style={styles.card}>
        <Text style={styles.sectionHeading}>Account Verification & Data</Text>
        <Text style={styles.sectionSub}>
          Date of birth and sex are immutable for safety. You may request a correction with staff review.
        </Text>
        <TouchableOpacity
          style={styles.correctionBtn}
          onPress={() => {
            setCorrectionError(null);
            setCorrectionModalVisible(true);
          }}
        >
          <Text style={styles.correctionBtnText}>Request DOB / Sex Correction</Text>
        </TouchableOpacity>
      </View>

      {/* Help & Support */}
      <TouchableOpacity
        style={styles.navRow}
        onPress={() => router.push("/settings/help")}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text style={{ fontSize: 20 }}>📖</Text>
          <View>
            <Text style={styles.navRowTitle}>Help & Support</Text>
            <Text style={styles.navRowSub}>Articles, Safety, and Contacting Support</Text>
          </View>
        </View>
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>

      {/* Sign Out */}
      <TouchableOpacity
        style={styles.signOutBtn}
        onPress={async () => {
          await logout();
          router.replace("/auth/sign-in");
        }}
      >
        <Text style={styles.signOutBtnText}>Sign Out</Text>
      </TouchableOpacity>

      {/* Correction Modal */}
      <Modal visible={correctionModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Request Profile Correction</Text>
            <Text style={styles.modalSub}>
              Changes require manual admin review and an automated impact analysis of your active chats.
            </Text>

            {correctionError ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{correctionError}</Text>
              </View>
            ) : null}

            <Text style={styles.inputLabel}>Field to Correct</Text>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
              <TouchableOpacity
                style={[
                  styles.fieldSelectBtn,
                  correctionField === "DOB" && styles.fieldSelectBtnActive,
                ]}
                onPress={() => setCorrectionField("DOB")}
              >
                <Text
                  style={[
                    styles.fieldSelectText,
                    correctionField === "DOB" && styles.fieldSelectTextActive,
                  ]}
                >
                  Date of Birth
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.fieldSelectBtn,
                  correctionField === "SEX" && styles.fieldSelectBtnActive,
                ]}
                onPress={() => setCorrectionField("SEX")}
              >
                <Text
                  style={[
                    styles.fieldSelectText,
                    correctionField === "SEX" && styles.fieldSelectTextActive,
                  ]}
                >
                  Sex
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Proposed New Value</Text>
            <TextInput
              style={styles.input}
              placeholder={correctionField === "DOB" ? "YYYY-MM-DD (e.g. 2004-05-20)" : "MALE or FEMALE"}
              placeholderTextColor={theme.colors.textMuted}
              value={proposedValue}
              onChangeText={setProposedValue}
            />

            <Text style={[styles.inputLabel, { marginTop: 12 }]}>Reason for Correction</Text>
            <TextInput
              style={[styles.input, { minHeight: 60 }]}
              placeholder="Explain why this correction is needed..."
              placeholderTextColor={theme.colors.textMuted}
              multiline
              value={correctionReason}
              onChangeText={setCorrectionReason}
            />

            <TouchableOpacity
              style={styles.checkboxRow}
              onPress={() => setAcknowledged(!acknowledged)}
            >
              <View style={[styles.checkbox, acknowledged && styles.checkboxActive]}>
                {acknowledged ? <Text style={{ color: "#fff", fontSize: 10 }}>✓</Text> : null}
              </View>
              <Text style={styles.checkboxLabel}>
                I acknowledge that review may affect my conversation protections and false submissions may lead to suspension.
              </Text>
            </TouchableOpacity>

            <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalSubmitBtn]}
                onPress={() => submitCorrectionMutation.mutate()}
                disabled={submitCorrectionMutation.isPending}
              >
                {submitCorrectionMutation.isPending ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.modalBtnText}>Submit Ticket</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalCancelBtn]}
                onPress={() => setCorrectionModalVisible(false)}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
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
  card: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  avatarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
  },
  displayName: {
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.text,
  },
  username: {
    fontSize: 14,
    color: theme.colors.textMuted,
  },
  infoGrid: {
    flexDirection: "row",
    gap: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing.md,
  },
  infoItem: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 12,
    color: theme.colors.textMuted,
  },
  infoVal: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.text,
    marginTop: 2,
  },
  navRow: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: theme.spacing.md,
  },
  navRowTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.text,
  },
  navRowSub: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  chevron: {
    fontSize: 22,
    color: theme.colors.textMuted,
  },
  sectionHeading: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.text,
  },
  sectionSub: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginTop: 4,
    marginBottom: theme.spacing.md,
    lineHeight: 18,
  },
  thresholdOptions: {
    gap: 8,
  },
  thresholdBtn: {
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: 12,
  },
  thresholdBtnActive: {
    borderColor: theme.colors.primary,
    backgroundColor: "rgba(99, 102, 241, 0.15)",
  },
  thresholdBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.textMuted,
  },
  thresholdBtnTextActive: {
    color: theme.colors.primary,
  },
  thresholdDesc: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  correctionBtn: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderColor: theme.colors.warning,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: 12,
    alignItems: "center",
  },
  correctionBtnText: {
    color: theme.colors.warning,
    fontWeight: "700",
    fontSize: 14,
  },
  signOutBtn: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderColor: theme.colors.danger,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: 14,
    alignItems: "center",
    marginVertical: theme.spacing.lg,
  },
  signOutBtnText: {
    color: theme.colors.danger,
    fontWeight: "700",
    fontSize: 15,
  },
  input: {
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: 10,
    color: theme.colors.text,
    fontSize: 14,
  },
  smallBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  smallBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.8)",
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
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.text,
  },
  modalSub: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginTop: 4,
    marginBottom: 14,
    lineHeight: 16,
  },
  errorBox: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    padding: 8,
    borderRadius: 6,
    marginBottom: 10,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 12,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textMuted,
    marginBottom: 4,
  },
  fieldSelectBtn: {
    flex: 1,
    padding: 10,
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.sm,
    alignItems: "center",
  },
  fieldSelectBtnActive: {
    borderColor: theme.colors.primary,
    backgroundColor: "rgba(99, 102, 241, 0.2)",
  },
  fieldSelectText: {
    color: theme.colors.textMuted,
    fontWeight: "600",
    fontSize: 13,
  },
  fieldSelectTextActive: {
    color: theme.colors.primary,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 14,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  checkboxActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  checkboxLabel: {
    flex: 1,
    fontSize: 12,
    color: theme.colors.textMuted,
    lineHeight: 16,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: theme.radii.md,
    alignItems: "center",
  },
  modalSubmitBtn: {
    backgroundColor: theme.colors.primary,
  },
  modalCancelBtn: {
    backgroundColor: theme.colors.border,
  },
  modalBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
});
