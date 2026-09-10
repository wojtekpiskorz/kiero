/**
 * Calendar credential storage (G1): the at-rest home of the Google tokens.
 *
 * Convex has no built-in per-field encryption, so this module implements
 * AES-256-GCM envelope encryption with a deployment-held key: the key lives
 * ONLY in the deployment environment (`KIERO_CALENDAR_TOKEN_KEY`, base64 of
 * 32 raw key bytes, injected with `npx convex env set`; never committed,
 * never logged), a fresh 12-byte IV is drawn per encryption, and the stored
 * value is `base64url(iv || ciphertext)`.
 *
 * Documented dev limitation: without the key name configured the bundle is
 * stored base64-encoded plaintext and the row records
 * `credentialStorage: "plaintext_dev"` — an honest, visible state, not a
 * silent downgrade. Every other code path treats the two storages
 * identically: the value NEVER crosses a client boundary, never appears in
 * results, logs or errors, and is cleared on disconnect/error.
 */

/** The deployment variable name holding the base64 AES-256 key. */
export const CALENDAR_TOKEN_KEY_ENV = "KIERO_CALENDAR_TOKEN_KEY";

/** The credential material one live connection holds. */
export interface CalendarCredentialBundle {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly accessTokenExpiresAtMs: number;
  readonly obtainedAtMs: number;
}

/** How a row's credential material is stored. */
export type CredentialStorageKind = "encrypted_aesgcm" | "plaintext_dev" | "none";

/** The sealed result persisted on the row. */
export interface SealedCredential {
  readonly storage: Exclude<CredentialStorageKind, "none">;
  readonly ciphertext: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Imports the configured key, or null when the name is not configured. */
async function importKey(env: { KIERO_CALENDAR_TOKEN_KEY?: string }): Promise<CryptoKey | null> {
  const configured = env.KIERO_CALENDAR_TOKEN_KEY;
  if (typeof configured !== "string" || configured.length === 0) {
    return null;
  }
  try {
    const raw = fromBase64(configured);
    if (raw.byteLength !== 32) {
      return null;
    }
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    return null;
  }
}

/** Seals one credential bundle for storage (encrypted when a key exists). */
export async function sealCredential(
  bundle: CalendarCredentialBundle,
  env: { KIERO_CALENDAR_TOKEN_KEY?: string },
): Promise<SealedCredential> {
  const key = await importKey(env);
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  if (key === null) {
    // Documented plaintext-dev limitation; visible on the row.
    return { storage: "plaintext_dev", ciphertext: toBase64(plaintext) };
  }
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const combined = new Uint8Array(iv.byteLength + sealed.byteLength);
  combined.set(iv, 0);
  combined.set(sealed, iv.byteLength);
  return { storage: "encrypted_aesgcm", ciphertext: toBase64(combined).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
}

/**
 * Opens a stored bundle. Returns null for absent material, an unknown
 * storage kind, or a ciphertext the configured key cannot open (a rotated
 * key is an honest "no usable credential", never a crash).
 */
export async function openCredential(
  storage: CredentialStorageKind | undefined,
  ciphertext: string | undefined,
  env: { KIERO_CALENDAR_TOKEN_KEY?: string },
): Promise<CalendarCredentialBundle | null> {
  if (storage === undefined || storage === "none" || ciphertext === undefined || ciphertext === "") {
    return null;
  }
  let bytes: Uint8Array;
  if (storage === "plaintext_dev") {
    bytes = fromBase64(ciphertext);
  } else {
    const key = await importKey(env);
    if (key === null) {
      return null;
    }
    try {
      const combined = fromBase64(
        ciphertext.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((ciphertext.length + 3) % 4),
      );
      if (combined.byteLength <= 12) {
        return null;
      }
      const iv = combined.slice(0, 12);
      const body = combined.slice(12);
      bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body));
    } catch {
      return null;
    }
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.accessToken !== "string" || record.accessToken.length === 0) {
      return null;
    }
    return {
      accessToken: record.accessToken,
      refreshToken: typeof record.refreshToken === "string" ? record.refreshToken : null,
      accessTokenExpiresAtMs:
        typeof record.accessTokenExpiresAtMs === "number" ? record.accessTokenExpiresAtMs : 0,
      obtainedAtMs: typeof record.obtainedAtMs === "number" ? record.obtainedAtMs : 0,
    };
  } catch {
    return null;
  }
}

/** A fresh 32-byte key in the exact base64 form `convex env set` expects. */
export function generateTokenKeyBase64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64(bytes);
}
