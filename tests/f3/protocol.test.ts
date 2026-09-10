/**
 * F3 protocol tests: the Web Push wire protocol against the RFC's OWN
 * numbers (the only authority that is not this code), plus an independent
 * decrypt roundtrip through Node crypto primitives (createECDH/hkdfSync/
 * createDecipheriv - never this module's functions) and the bounded-leg
 * status vocabulary.
 *
 * RFC 8291 Appendix A pins every intermediate value of the "watermelon"
 * example; RFC 8292 section 2.4 pins the JWT header/body shape and the
 * Authorization header form. Node's crypto verifies the ES256 signature
 * as a push service would.
 */

import { describe, expect, it } from "vitest";
import { createECDH, createDecipheriv, createVerify, hkdfSync } from "node:crypto";
import {
  MAX_PLAINTEXT_BYTES,
  base64UrlDecode,
  base64UrlEncode,
  classifyPushStatus,
  deliverOneWebPush,
  encryptPushPayload,
  isBase64Url,
  originOf,
  runtimeCrypto,
  vapidAuthorization,
  vapidKeysOf,
  type ProtocolCrypto,
} from "../../convex/attention/push/protocol";

/** The RFC 8291 Appendix A fixture, verbatim. */
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
} as const;

/** The runtime crypto with the RFC's salt injected (deterministic run). */
const rfcCrypto = (): ProtocolCrypto => ({
  ...runtimeCrypto(),
  randomSalt: () => base64UrlDecode(RFC8291.salt),
});

describe("RFC 8291 aes128gcm encryption", () => {
  it("reproduces the Appendix A body byte for byte", async () => {
    const result = await encryptPushPayload(rfcCrypto(), {
      plaintext: new TextEncoder().encode(RFC8291.plaintext),
      p256dhBase64Url: RFC8291.uaPublic,
      authBase64Url: RFC8291.authSecret,
      ephemeral: {
        privateKey: base64UrlDecode(RFC8291.asPrivate),
        publicKey: base64UrlDecode(RFC8291.asPublic),
      },
    });
    expect(base64UrlEncode(result.body)).toBe(RFC8291.body);
    expect(base64UrlEncode(result.ephemeralPublicKey)).toBe(RFC8291.asPublic);
  });

  it("matches the Appendix A intermediates through independent Node crypto", () => {
    // ecdh_secret: ECDH(as_private, ua_public) with Node's ECDH.
    const ua = createECDH("prime256v1");
    ua.setPrivateKey(Buffer.from(base64UrlDecode(RFC8291.uaPrivate)));
    const ecdhSecret = ua.computeSecret(Buffer.from(base64UrlDecode(RFC8291.asPublic)));
    expect(base64UrlEncode(new Uint8Array(ecdhSecret))).toBe(RFC8291.ecdhSecret);
    // The RFC 8291 section 3 HKDF chain, spelled with hkdfSync.
    const authSecret = Buffer.from(base64UrlDecode(RFC8291.authSecret));
    const ikm = Buffer.from(
      hkdfSync(
        "sha256",
        ecdhSecret,
        authSecret,
        Buffer.concat([
          Buffer.from("WebPush: info\0", "utf8"),
          Buffer.from(base64UrlDecode(RFC8291.uaPublic)),
          Buffer.from(base64UrlDecode(RFC8291.asPublic)),
        ]),
        32,
      ),
    );
    const salt = Buffer.from(base64UrlDecode(RFC8291.salt));
    const cek = Buffer.from(
      hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16),
    );
    const nonce = Buffer.from(
      hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12),
    );
    expect(base64UrlEncode(new Uint8Array(cek))).toBe(RFC8291.cek);
    expect(base64UrlEncode(new Uint8Array(nonce))).toBe(RFC8291.nonce);
  });

  it("roundtrips through INDEPENDENT Node crypto primitives (as a push service decrypts)", async () => {
    // The user agent side: a fresh P-256 keypair from Node's ECDH.
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const uaPublic = base64UrlEncode(new Uint8Array(ua.getPublicKey()));
    const uaPrivate = base64UrlEncode(new Uint8Array(ua.getPrivateKey()));
    const authSecret = base64UrlEncode(new Uint8Array(16));
    const plaintext = new TextEncoder().encode(
      'Nowy wpis: Banan\nAnna: Klient potwierdził termin na piątek.',
    );

    const encrypted = await encryptPushPayload(runtimeCrypto(), {
      plaintext,
      p256dhBase64Url: uaPublic,
      authBase64Url: authSecret,
    });

    // Decrypt per RFC 8291 with Node primitives only.
    const body = Buffer.from(encrypted.body);
    const salt = body.subarray(0, 16);
    const idlen = body[20]!;
    const keyId = body.subarray(21, 21 + idlen);
    const ciphertext = body.subarray(21 + idlen);

    // Recreate the app-server private side is impossible; instead derive
    // the shared secret from the USER AGENT's private key and the ephemeral
    // public key carried in the record header (the mirror of the sender's
    // derivation).
    const ephemeralPublic = Buffer.from(keyId);
    ua.setPrivateKey(Buffer.from(base64UrlDecode(uaPrivate)));
    const ecdhSecret = ua.computeSecret(ephemeralPublic);

    const ikm = Buffer.from(
      hkdfSync(
        "sha256",
        ecdhSecret,
        Buffer.from(base64UrlDecode(authSecret)),
        Buffer.concat([
          Buffer.from("WebPush: info\0", "utf8"),
          Buffer.from(base64UrlDecode(uaPublic)),
          ephemeralPublic,
        ]),
        32,
      ),
    );
    const cek = Buffer.from(
      hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16),
    );
    const nonce = Buffer.from(
      hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12),
    );
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const decrypted = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
      decipher.final(),
    ]);
    // The padding delimiter 0x02 trails the plaintext.
    expect(new Uint8Array(decrypted.subarray(0, plaintext.length))).toEqual(plaintext);
    expect(decrypted[plaintext.length]).toBe(0x02);
  });

  it("rejects payloads beyond the single-record budget", async () => {
    const oversized = new Uint8Array(MAX_PLAINTEXT_BYTES + 1);
    await expect(
      encryptPushPayload(runtimeCrypto(), {
        plaintext: oversized,
        p256dhBase64Url: RFC8291.uaPublic,
        authBase64Url: RFC8291.authSecret,
      }),
    ).rejects.toThrow(/too large/);
  });
});

/** A generated VAPID pair in the exact stored form (PKCS#8 DER). */
async function generatedVapidKeys(): Promise<{
  publicKey: string;
  privateKey: string;
  rawPublic: Uint8Array;
  privateDer: Uint8Array;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    publicKey: base64UrlEncode(rawPublic),
    privateKey: base64UrlEncode(privateDer),
    rawPublic,
    privateDer,
  };
}

describe("RFC 8292 VAPID", () => {
  it("builds a verifiable ES256 JWT with the pinned claims shape", async () => {
    const generated = await generatedVapidKeys();
    const keys = vapidKeysOf(
      generated.publicKey,
      generated.privateKey,
      "mailto:ops@kiero.example",
    );
    expect(keys).not.toBeNull();
    const nowMs = Date.parse("2026-09-10T08:00:00.000Z");
    const header = await vapidAuthorization(
      runtimeCrypto(),
      keys!,
      "https://fcm.googleapis.com/fcm/send/dABC123",
      nowMs,
    );
    expect(header.startsWith("vapid t=")).toBe(true);
    const token = /t=([^,]+),/.exec(header)?.[1];
    const keyParam = /, k=(.+)$/.exec(header)?.[1];
    expect(token).toBeDefined();
    expect(keyParam).toBe(generated.publicKey);

    const [encodedHeader, encodedClaims, encodedSignature] = token!.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedHeader!)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedClaims!)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.exp).toBe(Math.floor(nowMs / 1000) + 12 * 60 * 60);
    expect(claims.sub).toBe("mailto:ops@kiero.example");

    // Verify as the push service would: JOSE ES256 (raw r||s) over the
    // signing input, with the public key named by k=.
    const signature = Buffer.from(base64UrlDecode(encodedSignature!));
    expect(signature.length).toBe(64);
    const verify = createVerify("SHA256");
    verify.update(`${encodedHeader}.${encodedClaims}`);
    const jwk = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: base64UrlEncode(generated.rawPublic.subarray(1, 33)),
        y: base64UrlEncode(generated.rawPublic.subarray(33, 65)),
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        jwk,
        signature as BufferSource,
        new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`) as BufferSource,
      ),
    ).toBe(true);
  });

  it("rejects malformed key material", () => {
    expect(vapidKeysOf(undefined, "x", "mailto:a@b.c")).toBeNull();
    expect(vapidKeysOf("short", "x", "mailto:a@b.c")).toBeNull();
    expect(vapidKeysOf("aGVsbG8", "x", "not-a-uri")).toBeNull();
  });
});

describe("the bounded leg", () => {
  it("maps provider statuses to the honest vocabulary", () => {
    expect(classifyPushStatus(201)).toEqual({ kind: "delivered" });
    expect(classifyPushStatus(404)).toEqual({ kind: "gone" });
    expect(classifyPushStatus(410)).toEqual({ kind: "gone" });
    expect(classifyPushStatus(400)).toEqual({ kind: "rejected" });
    expect(classifyPushStatus(401)).toEqual({ kind: "unauthorized" });
    expect(classifyPushStatus(403)).toEqual({ kind: "unauthorized" });
    expect(classifyPushStatus(429)).toEqual({ kind: "retry_later" });
    expect(classifyPushStatus(503)).toEqual({ kind: "unknown" });
  });

  it("posts the RFC 8291 body with TTL, encoding and VAPID Authorization", async () => {
    const generated = await generatedVapidKeys();
    const keys = vapidKeysOf(generated.publicKey, generated.privateKey, "mailto:ops@kiero.example")!;
    const seen: { endpoint: string; headers: Record<string, string>; body: Uint8Array }[] = [];
    const report = await deliverOneWebPush(runtimeCrypto(), {
      endpoint: "https://push.example.net/p/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
      p256dhBase64Url: RFC8291.uaPublic,
      authBase64Url: RFC8291.authSecret,
      payloadJson: JSON.stringify({ v: 1, title: "Nowy wpis: Firma" }),
      ttlSeconds: 86_400,
      keys,
      nowMs: Date.now(),
      transport: async (endpoint, headers, body) => {
        seen.push({ endpoint, headers, body });
        return { status: 201 };
      },
    });
    expect(report).toEqual({ kind: "delivered" });
    const leg = seen[0]!;
    expect(seen.length).toBe(1);
    expect(leg.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(leg.headers.TTL).toBe("86400");
    expect(leg.headers.Authorization?.startsWith("vapid t=")).toBe(true);
    // 86-byte header + 16-byte tag around the plaintext.
    expect(leg.body.length).toBe(86 + 16 + JSON.stringify({ v: 1, title: "Nowy wpis: Firma" }).length + 1);
  });

  it("carries the distinct timeout cause on a deadline hit", async () => {
    const generated = await generatedVapidKeys();
    const keys = vapidKeysOf(generated.publicKey, generated.privateKey, "mailto:ops@kiero.example")!;
    const report = await deliverOneWebPush(runtimeCrypto(), {
      endpoint: "https://push.example.net/p/timeout",
      p256dhBase64Url: RFC8291.uaPublic,
      authBase64Url: RFC8291.authSecret,
      payloadJson: "{}",
      ttlSeconds: 60,
      keys,
      nowMs: Date.now(),
      transport: async () => ({ status: 0, failure: "unknown_timeout" }),
    });
    expect(report).toEqual({ kind: "unknown", cause: "timeout" });
  });
});

describe("helpers", () => {
  it("base64url roundtrips and validates", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64UrlEncode(bytes)).toBe("AAEC-vv8_f7_");
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    expect(isBase64Url(base64UrlEncode(bytes))).toBe(true);
    expect(isBase64Url("not valid!")).toBe(false);
  });

  it("extracts the push service origin for the aud claim", () => {
    expect(originOf("https://push.example.net/p/x")).toBe("https://push.example.net");
    expect(originOf("http://127.0.0.1:8787/probe")).toBe("http://127.0.0.1:8787");
    expect(originOf("not a url")).toBeNull();
  });
});
