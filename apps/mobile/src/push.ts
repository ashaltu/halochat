import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { apiRequest } from "./api/client.js";

export async function registerPushToken() {
  if (Platform.OS === "web" || !Device.isDevice) return;
  const existing = await Notifications.getPermissionsAsync();
  const permission = existing.status === "granted"
    ? existing
    : await Notifications.requestPermissionsAsync();
  if (permission.status !== "granted") return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return;
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  await apiRequest("/api/v1/me/push-tokens", {
    method: "POST",
    body: JSON.stringify({ expoToken: token.data, platform: Platform.OS }),
  });
}
