export function encodeSafetyCode(fingerprint: Uint8Array) {
  if (fingerprint.length !== 32) throw new Error("Unexpected MLS safety fingerprint length");
  return Array.from(fingerprint, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function formatSafetyCode(safetyCode: string) {
  return safetyCode.match(/.{1,4}/g)?.join(" ") ?? "";
}

export function getSafetyCodeStatus(safetyCode: string, trustedCode: string | null) {
  return {
    verified: trustedCode === safetyCode,
    changed: !!trustedCode && trustedCode !== safetyCode,
  };
}
