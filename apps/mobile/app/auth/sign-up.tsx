import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme.js";
import { apiRequest } from "../../src/api/client.js";
import { useAuthStore } from "../../src/stores/auth.js";
import { isAtLeast13, USERNAME_REGEX } from "@halochat/shared";

export default function SignUpScreen() {
  const router = useRouter();
  const { setUser, setSession } = useAuthStore();

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState(""); // YYYY-MM-DD
  const [sex, setSex] = useState<"MALE" | "FEMALE">("FEMALE");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignUp = async () => {
    setError(null);

    if (!email || !username || !displayName || !password || !dateOfBirth) {
      setError("Please fill in all required fields.");
      return;
    }

    if (!USERNAME_REGEX.test(username.toLowerCase())) {
      setError(
        "Username must be 3-20 characters long and contain only lowercase letters, numbers, and underscores."
      );
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      setError("Date of birth must be in YYYY-MM-DD format (e.g. 2005-04-12).");
      return;
    }

    if (!isAtLeast13(dateOfBirth)) {
      setError("HaloChat is only available for users aged 13 and older.");
      return;
    }

    setLoading(true);

    try {
      const res = await apiRequest<{ session: any; user: any }>("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({
          email,
          username: username.toLowerCase(),
          displayName,
          password,
          dateOfBirth,
          sex,
        }),
      });

      setUser(res.user);
      setSession(res.session);
      router.replace("/onboarding");
    } catch (err: any) {
      setError(err.message || "Failed to create account.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.logo}>🛡️ HaloChat</Text>
        <Text style={styles.subtitle}>Create your safe messaging account</Text>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.form}>
        <View style={styles.inputGroup}>
          <Text style={styles.label}>Display Name</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Aisha M."
            placeholderTextColor={theme.colors.textMuted}
            value={displayName}
            onChangeText={setDisplayName}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Username (@)</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. aisha_m"
            placeholderTextColor={theme.colors.textMuted}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Email Address</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. aisha@example.com"
            placeholderTextColor={theme.colors.textMuted}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Password (min 8 chars)</Text>
          <TextInput
            style={styles.input}
            placeholder="Create a strong password"
            placeholderTextColor={theme.colors.textMuted}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Date of Birth (YYYY-MM-DD)</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 2004-06-15"
            placeholderTextColor={theme.colors.textMuted}
            value={dateOfBirth}
            onChangeText={setDateOfBirth}
          />
          <Text style={styles.fieldHint}>Must be 13 or older. Immutable after registration.</Text>
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Sex</Text>
          <View style={styles.sexSelector}>
            <TouchableOpacity
              style={[styles.sexOption, sex === "FEMALE" && styles.sexOptionActive]}
              onPress={() => setSex("FEMALE")}
            >
              <Text
                style={[styles.sexOptionText, sex === "FEMALE" && styles.sexOptionTextActive]}
              >
                Female
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sexOption, sex === "MALE" && styles.sexOptionActive]}
              onPress={() => setSex("MALE")}
            >
              <Text
                style={[styles.sexOptionText, sex === "MALE" && styles.sexOptionTextActive]}
              >
                Male
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.fieldHint}>Used for Angel opposite-sex protection rules. Not shown publicly.</Text>
        </View>

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSignUp}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Join HaloChat</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Already have an account?</Text>
        <TouchableOpacity onPress={() => router.push("/auth/sign-in")}>
          <Text style={styles.linkText}>Sign In</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.bg,
    flexGrow: 1,
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    marginBottom: theme.spacing.lg,
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
    marginBottom: theme.spacing.md,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 14,
  },
  form: {
    gap: theme.spacing.md,
  },
  inputGroup: {
    gap: 4,
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
  fieldHint: {
    fontSize: 12,
    color: theme.colors.textMuted,
  },
  sexSelector: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  sexOption: {
    flex: 1,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.card,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    alignItems: "center",
  },
  sexOptionActive: {
    borderColor: theme.colors.primary,
    backgroundColor: "rgba(99, 102, 241, 0.15)",
  },
  sexOptionText: {
    color: theme.colors.textMuted,
    fontWeight: "600",
  },
  sexOptionTextActive: {
    color: theme.colors.primary,
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
