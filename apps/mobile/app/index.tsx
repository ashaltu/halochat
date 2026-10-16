import React, { useEffect } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useAuthStore } from "../src/stores/auth.js";
import { theme } from "../src/theme.js";

export default function Index() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();

  useEffect(() => {
    if (isLoading) return;

    if (!user) {
      router.replace("/auth/sign-in");
    } else if (!user.onboardingCompletedAt) {
      router.replace("/onboarding");
    } else {
      router.replace("/(tabs)");
    }
  }, [user, isLoading]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
});
