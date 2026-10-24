import { describe, expect, it } from "vitest";
import { encodeSafetyCode, formatSafetyCode, getSafetyCodeStatus } from "./safety-code.js";

describe("chat safety codes", () => {
  it("encodes a 32-byte MLS fingerprint as uppercase hex", () => {
    const fingerprint = Uint8Array.from({ length: 32 }, (_, index) => index);
    const code = encodeSafetyCode(fingerprint);

    expect(code).toBe("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
    expect(formatSafetyCode(code)).toBe("0001 0203 0405 0607 0809 0A0B 0C0D 0E0F 1011 1213 1415 1617 1819 1A1B 1C1D 1E1F");
  });

  it("rejects fingerprints with an unexpected length", () => {
    expect(() => encodeSafetyCode(new Uint8Array(31))).toThrow("Unexpected MLS safety fingerprint length");
  });

  it("distinguishes unverified, verified, and changed codes", () => {
    expect(getSafetyCodeStatus("A", null)).toEqual({ verified: false, changed: false });
    expect(getSafetyCodeStatus("A", "A")).toEqual({ verified: true, changed: false });
    expect(getSafetyCodeStatus("B", "A")).toEqual({ verified: false, changed: true });
  });
});
