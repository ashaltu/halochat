import React from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Linking } from "react-native";
import { theme } from "../../src/theme.js";

const ARTICLES = [
  {
    title: "1. Comfort Mode vs Protected Mode",
    body: "• Comfort Mode (Blue): Direct 1-to-1 conversation without Angel involvement.\n• Protected Mode (Green): Selected conversations overseen by trusted Angels you have assigned. Angels protect you from scams, manipulation, or crossing social boundaries without becoming conversational participants.",
  },
  {
    title: "2. How Angel Oversight Works",
    body: "Angels can read authorized message periods, pause your sending ability if something feels unsafe, end the chat, or send private whispers directly to you. Other chat participants never see your Angel's identity, count, or whispers.",
  },
  {
    title: "3. Leave & Rejoin ('I'm Comfortable')",
    body: "You can ask your Angel to leave an active Protected chat when you feel comfortable. If accepted, the chat shifts to Comfort Mode. Messages exchanged while the Angel was absent remain strictly hidden even if they later rejoin (history gaps).",
  },
  {
    title: "4. End-to-End Encryption & Privacy",
    body: "Message content is encrypted directly on your device. The HaloChat server enforces access and routing without possessing keys to read your plaintext messages or private whispers.",
  },
  {
    title: "5. Profile Corrections (DOB & Sex)",
    body: "Date of birth and sex are immutable after registration to prevent evading safeguarding and Angel protection rules. To correct an error, submit a support ticket under Settings; staff reviews an automated impact assessment before applying changes.",
  },
];

export default function HelpSupportScreen() {
  const handleEmailSupport = () => {
    Linking.openURL("mailto:support@halochat.app?subject=HaloChat%20Support%20Inquiry");
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Help & Support Center</Text>
        <Text style={styles.headerSubtitle}>
          Learn how HaloChat keeps you protected and comfortable.
        </Text>
      </View>

      <View style={styles.articlesList}>
        {ARTICLES.map((art, idx) => (
          <View key={idx} style={styles.articleCard}>
            <Text style={styles.articleTitle}>{art.title}</Text>
            <Text style={styles.articleBody}>{art.body}</Text>
          </View>
        ))}
      </View>

      {/* Support Contact Box */}
      <View style={styles.contactCard}>
        <Text style={styles.contactTitle}>Need Personal Assistance?</Text>
        <Text style={styles.contactSub}>
          Our safety and support team is here to assist with account compromise, privacy inquiries, and safety concerns.
        </Text>
        <TouchableOpacity style={styles.emailBtn} onPress={handleEmailSupport}>
          <Text style={styles.emailBtnText}>✉️ Contact support@halochat.app</Text>
        </TouchableOpacity>
      </View>
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
    marginBottom: theme.spacing.lg,
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
  },
  articlesList: {
    gap: theme.spacing.md,
    marginBottom: theme.spacing.xl,
  },
  articleCard: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
  },
  articleTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.primary,
    marginBottom: 6,
  },
  articleBody: {
    fontSize: 13,
    color: theme.colors.textMuted,
    lineHeight: 20,
  },
  contactCard: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: theme.spacing.lg,
    alignItems: "center",
    marginBottom: theme.spacing.xl,
  },
  contactTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.text,
  },
  contactSub: {
    fontSize: 12,
    color: theme.colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
    marginVertical: 8,
  },
  emailBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 12,
    borderRadius: theme.radii.md,
    marginTop: 6,
  },
  emailBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
});
