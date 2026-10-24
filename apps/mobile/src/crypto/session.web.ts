function unavailable(): never {
  throw new Error("Encrypted web messaging is not available in this build");
}

export async function ensureChatE2ee(): Promise<"ready" | "waiting"> {
  return unavailable();
}

export async function encryptAndSendChatMessage(): Promise<never> {
  return unavailable();
}

export async function fetchAndDecryptChatMessages(): Promise<never[]> {
  return unavailable();
}

export async function getChatSafetyVerification(): Promise<never> {
  return unavailable();
}

export async function markChatSafetyCodeVerified(): Promise<never> {
  return unavailable();
}
