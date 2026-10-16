import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { apiRequest } from "../../src/api/client.js";
import { theme } from "../../src/theme.js";

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    try {
      await apiRequest("/api/auth/forget-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSent(true);
      setError("");
    } catch (err: any) {
      setError(err.message || "Unable to start recovery.");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Recover your account</Text>
      <Text style={styles.copy}>Enter your verified email. If it matches an account, we will send a reset link.</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="you@example.com"
        placeholderTextColor={theme.colors.textMuted}
      />
      {sent ? <Text style={styles.success}>Check your email for the reset link.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity style={styles.button} onPress={submit}>
        <Text style={styles.buttonText}>Send reset link</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.xl, backgroundColor: theme.colors.bg, gap: theme.spacing.md },
  title: { color: theme.colors.text, fontSize: 24, fontWeight: "800" },
  copy: { color: theme.colors.textMuted, lineHeight: 20 },
  input: { color: theme.colors.text, backgroundColor: theme.colors.card, borderColor: theme.colors.border, borderWidth: 1, borderRadius: theme.radii.md, padding: theme.spacing.md },
  button: { backgroundColor: theme.colors.primary, borderRadius: theme.radii.md, padding: theme.spacing.md, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "700" },
  success: { color: theme.colors.protected },
  error: { color: theme.colors.danger },
});
