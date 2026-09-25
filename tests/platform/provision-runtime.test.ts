/**
 * The self-generated runtime values have the shapes their consumers
 * parse: Convex Auth signs with the one-line PKCS#8 key and verifies with
 * the JWKS, Web Push signs with the VAPID pair, and the calendar sealing
 * key is 32 raw bytes.
 */

import { createPrivateKey, createPublicKey, createSign, createVerify, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OWNER_PROVIDED,
  TARGETS,
  generatedValues,
} from "../../infra/environments/provision-runtime.mjs";

describe("provision-runtime generated values", () => {
  const values = generatedValues("staging");

  it("produces a Convex Auth key pair that signs and verifies", () => {
    expect(values.JWT_PRIVATE_KEY).not.toContain("\n");
    const privateKey = createPrivateKey(pemFromOneLine(values.JWT_PRIVATE_KEY));
    const jwks = JSON.parse(values.JWKS) as { keys: { use: string; kty: string }[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ use: "sig", kty: "RSA" });
    const publicKey = createPublicKey({ key: jwks.keys[0] as never, format: "jwk" });
    const signature = createSign("RSA-SHA256").update("kiero").sign(privateKey);
    expect(createVerify("RSA-SHA256").update("kiero").verify(publicKey, signature)).toBe(true);
  });

  it("produces a VAPID pair in the shapes the push protocol imports", async () => {
    const publicPoint = Buffer.from(values.WEB_PUSH_VAPID_PUBLIC_KEY, "base64url");
    expect(publicPoint).toHaveLength(65);
    expect(publicPoint[0]).toBe(0x04);
    await expect(
      webcrypto.subtle.importKey(
        "pkcs8",
        new Uint8Array(Buffer.from(values.WEB_PUSH_VAPID_PRIVATE_KEY, "base64url")),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
    ).resolves.toBeDefined();
  });

  it("produces a 32-byte calendar sealing key and distinct service tokens", () => {
    expect(Buffer.from(values.KIERO_CALENDAR_TOKEN_KEY, "base64")).toHaveLength(32);
    expect(values.KIERO_SERVICE_TOKEN).not.toBe(values.KIERO_MEDIA_WORKER_TOKEN);
  });

  it("never generates an owner-held provider credential", () => {
    for (const target of Object.keys(TARGETS)) {
      const names = Object.keys(generatedValues(target as keyof typeof TARGETS));
      expect(names.filter((name) => OWNER_PROVIDED.includes(name))).toEqual([]);
    }
  });
});

/** Rebuilds the PEM Convex Auth reads from the one-line form. */
function pemFromOneLine(oneLine: string): string {
  const body = oneLine
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .trim()
    .split(" ")
    .join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}
