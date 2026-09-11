/**
 * The ONE bytes-to-sha256-hex helper of the backup executor (I5): WebCrypto
 * only, no imports, so the same definition runs in the Worker runtime and
 * in the Node container (the store, the exporter and the pipeline all hash
 * through it; a mirror per module was a drift hazard).
 */

export async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
