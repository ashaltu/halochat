import React, { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme.js";
import { apiRequest } from "../../src/api/client.js";
import { useAuthStore } from "../../src/stores/auth.js";

export default function SignInScreen() {
  const router = useRouter();
  const { setUser, setSession } = useAuthStore();
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    if (!emailOrUsername || !password) {
      setError("Please fill in all fields.");
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const res = await apiRequest<{ session: any; user: any }>("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ emailOrUsername, password }),
      });

      setUser(res.user);
      setSession(res.session);

      if (!res.user.onboardingCompletedAt) {
        router.replace("/onboarding");
      } else {
        router.replace("/(tabs)");
      }
    } catch (err: any) {
      setError(err.message || "Failed to sign in. Please check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.logo}>🛡️ HaloChat</Text>
        <Text style={styles.subtitle}>Sign in to your account</Text>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.form}>
        <View style={styles.inputGroup}>
          <Text style={styles.label}>Email or Username</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. sara or sara@example.com"
            placeholderTextColor={theme.colors.textMuted}
            value={emailOrUsername}
            onChangeText={setEmailOrUsername}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter your password"
            placeholderTextColor={theme.colors.textMuted}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
        </View>

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSignIn}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Sign In</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Don't have an account?</Text>
        <TouchableOpacity onPress={() => router.push("/auth/sign-up")}>
          <Text style={styles.linkText}>Create Account</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={() => router.push("/auth/forgot-password")}>
        <Text style={[styles.linkText, { textAlign: "center", marginTop: 16 }]}>Forgot password?</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
    padding: theme.spacing.xl,
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    marginBottom: theme.spacing.xl,
  },
  logo: {
    fontSize: 32,
    fontWeight: "800",
    color: theme.colors.primary,
    marginBottom: theme.spacing.xs,
  },
  subtitle: {
    fontSize: 16,
    color: theme.colors.textMuted,
  },
  errorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderColor: theme.colors.danger,
    borderWidth: 1,
    padding: theme.spacing.md,
    borderRadius: theme.radii.md,
    marginBottom: theme.spacing.lg,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 14,
  },
  form: {
    gap: theme.spacing.md,
  },
  inputGroup: {
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.text,
  },
  input: {
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
    color: theme.colors.text,
    fontSize: 16,
  },
  button: {
    backgroundColor: theme.colors.primary,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radii.md,
    alignItems: "center",
    marginTop: theme.spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginTop: theme.spacing.xl,
  },
  footerText: {
    color: theme.colors.textMuted,
    fontSize: 14,
  },
  linkText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "600",
  },
});
