/**
 * One-time proof-code helpers (B2): generation and hashing for the codes
 * the linking ceremony and the email change stage (same shape and the
 * same unbiased sampling as B1's sign-in OTP — one code discipline).
 */

/** One-time proof code: 8 digits, same shape as B1's sign-in OTP. */
export const PROOF_CODE_LENGTH = 8;

/** Rejects sampled bytes for uniform digits (no modulo bias), like B1. */
export function generateProofCode(): string {
  const digits = "0123456789";
  const maxUsableByte = Math.floor(256 / digits.length) * digits.length; // 250
  let code = "";
  while (code.length < PROOF_CODE_LENGTH) {
    const bytes = new Uint8Array(PROOF_CODE_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= maxUsableByte) {
        continue;
      }
      code += digits[byte % digits.length] ?? "0";
      if (code.length === PROOF_CODE_LENGTH) {
        break;
      }
    }
  }
  return code;
}

/** SHA-256 hex digest — the ONLY hashing used for staged codes. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
