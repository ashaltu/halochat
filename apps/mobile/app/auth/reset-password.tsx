import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiRequest } from "../../src/api/client.js";
import { theme } from "../../src/theme.js";

export default function ResetPasswordScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    try {
      await apiRequest("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      router.replace("/auth/sign-in");
    } catch (err: any) {
      setError(err.message || "Unable to reset password.");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Choose a new password</Text>
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholder="At least 8 characters"
        placeholderTextColor={theme.colors.textMuted}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity style={styles.button} onPress={submit}>
        <Text style={styles.buttonText}>Reset password</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.xl, backgroundColor: theme.colors.bg, gap: theme.spacing.md },
  title: { color: theme.colors.text, fontSize: 24, fontWeight: "800" },
  input: { color: theme.colors.text, backgroundColor: theme.colors.card, borderColor: theme.colors.border, borderWidth: 1, borderRadius: theme.radii.md, padding: theme.spacing.md },
  button: { backgroundColor: theme.colors.primary, borderRadius: theme.radii.md, padding: theme.spacing.md, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "700" },
  error: { color: theme.colors.danger },
});
