import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { theme } from "../src/theme.js";
import { apiRequest } from "../src/api/client.js";
import { useAuthStore } from "../src/stores/auth.js";

const SLIDES = [
  {
    title: "Welcome to HaloChat",
    badge: "1-to-1 Messaging",
    description:
      "HaloChat is designed to make one-to-one conversations comfortable and safe. Whether chatting with friends, acquaintances, or strangers, you control your boundaries.",
    icon: "💬",
  },
  {
    title: "Comfort & Protected Modes",
    badge: "Modes & Indicators",
    description:
      "Chats have two clear modes:\n\n• Comfort Mode (Blue): Direct private chat without Angel supervision.\n• Protected Mode (Green): An assigned trusted Angel oversees the conversation to help protect you.",
    icon: "🛡️",
  },
  {
    title: "Your Trusted Angels",
    badge: "Angel Protection",
    description:
      "Angels are trusted people (such as a mahram, guardian, or advisor) you invite. They do not participate in the conversation, but can whisper privately or pause sending if something feels unsafe.",
    icon: "✨",
  },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const { user, setUser } = useAuthStore();
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleNext = async () => {
    if (currentSlide < SLIDES.length - 1) {
      setCurrentSlide(currentSlide + 1);
    } else {
      setIsSubmitting(true);
      try {
        const res = await apiRequest<{ user: any }>("/api/v1/me", {
          method: "PATCH",
          body: JSON.stringify({ onboardingCompleted: true }),
        });
        if (res.user) {
          setUser(res.user);
        }
        router.replace("/(tabs)");
      } catch (err) {
        console.error("Failed to complete onboarding", err);
        router.replace("/(tabs)");
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const slide = SLIDES[currentSlide];

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.icon}>{slide.icon}</Text>
        <View style={styles.badgeContainer}>
          <Text style={styles.badgeText}>{slide.badge}</Text>
        </View>
        <Text style={styles.title}>{slide.title}</Text>
        <Text style={styles.description}>{slide.description}</Text>
      </View>

      <View style={styles.footer}>
        <View style={styles.dots}>
          {SLIDES.map((_, index) => (
            <View
              key={index}
              style={[styles.dot, currentSlide === index && styles.activeDot]}
            />
          ))}
        </View>

        <TouchableOpacity
          style={styles.button}
          onPress={handleNext}
          disabled={isSubmitting}
        >
          <Text style={styles.buttonText}>
            {currentSlide === SLIDES.length - 1 ? "Get Started" : "Continue"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
    justifyContent: "space-between",
    padding: theme.spacing.xl,
  },
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  icon: {
    fontSize: 64,
    marginBottom: theme.spacing.lg,
  },
  badgeContainer: {
    backgroundColor: "rgba(99, 102, 241, 0.15)",
    borderColor: theme.colors.primary,
    borderWidth: 1,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 4,
    borderRadius: theme.radii.full,
    marginBottom: theme.spacing.md,
  },
  badgeText: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: theme.colors.text,
    textAlign: "center",
    marginBottom: theme.spacing.md,
  },
  description: {
    fontSize: 16,
    color: theme.colors.textMuted,
    textAlign: "center",
    lineHeight: 24,
    paddingHorizontal: theme.spacing.md,
  },
  footer: {
    gap: theme.spacing.lg,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: theme.spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.border,
  },
  activeDot: {
    width: 24,
    backgroundColor: theme.colors.primary,
  },
  button: {
    backgroundColor: theme.colors.primary,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radii.md,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
