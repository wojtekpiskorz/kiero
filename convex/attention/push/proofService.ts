/**
 * The F3 guarded proof-fixture WEB PUSH SERVICE (dev deployment only): the
 * clearly-labeled fake push service the evidence script
 * (tests/f3/live-proof.mjs) controls - G1/G3's fake-Google pattern, applied
 * to RFC 8030/8291/8292.
 *
 * Everything the live proof needs beyond the production lanes lives HERE,
 * in F3's owned module, beside its protocol vocabulary. The guard is
 * `KIERO_F3_PROOF_ENABLED === "1"`; on any other deployment every entry
 * fails closed 404. Fixture values are constants, never secrets; the
 * VAPID keypair the deployment signs with stays in environment variables
 * and only its PUBLIC half is ever returned or compared.
 *
 * The fake service plays the BROWSER's side of the protocol:
 *
 * - `POST /attention/push/proof/device` - "subscribe": generates one
 *   device keypair (P-256) plus its 16-byte auth secret, stores them, and
 *   returns `{endpoint, p256dh, auth}` exactly like
 *   `pushManager.subscribe().toJSON()` would.
 * - `POST /attention/push/proof/push-service/:token` - the push endpoint
 *   the REAL transport POSTs to. It behaves like a push service: verifies
 *   the VAPID Authorization (ES256 against the deployment's public key,
 *   audience and expiry checked), decrypts the aes128gcm body with the
 *   device's private key, records the message, THEN answers by the
 *   device's behavior (`ok` 201, `gone` 404, `timeout` records the
 *   receipt and stalls past the caller's bounded deadline - the message
 *   EXISTS at the service while the caller can only record `unknown`,
 *   exactly the load-bearing timeout-after-acceptance case).
 * - `POST /attention/push/proof/state` - the guarded evidence read.
 *
 * Wired by the sanctioned append in convex/http.ts.
 */

import { v } from "convex/values";
import { httpAction, internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { base64UrlDecode, base64UrlEncode } from "./protocol";

/** The guard (G1's shape). */
export function pushProofEnabled(env: { KIERO_F3_PROOF_ENABLED?: string }): boolean {
  return env.KIERO_F3_PROOF_ENABLED === "1";
}

/** Longer than the transport's bounded deadline (the stall case). */
const PROOF_STALL_MS = 6_000;

/** Bounded recorded messages per device. */
const MAX_RECORDED = 20;

function disabled(): Response {
  return new Response(JSON.stringify({ error: "proof_disabled" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** The recorded message shape the evidence read returns. */
interface RecordedMessage {
  readonly atMs: number;
  readonly ttl: string | null;
  readonly contentEncoding: string | null;
  readonly vapidVerified: boolean;
  readonly vapidAudience: string | null;
  readonly decrypted: boolean;
  readonly payload: { readonly title?: string; readonly body?: string; readonly v?: number } | null;
  readonly rawBodyBase64Url: string;
}

// ---------------------------------------------------------------------------
// The "browser" device: keypair generation and storage.
// ---------------------------------------------------------------------------

/** Creates one proof device: keygen in the action, storage in the mutation. */
export const proofCreateDevice = internalAction({
  args: { behavior: v.string() },
  handler: async (ctx, args) => {
    const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const authSecret = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
    await ctx.runMutation(internal.attention.push.proofService.insertProofDevice, {
      token,
      behavior: args.behavior,
      publicBase64Url: base64UrlEncode(rawPublic),
      privateJwkJson: JSON.stringify(privateJwk),
      authBase64Url: authSecret,
    });
    return {
      token,
      p256dh: base64UrlEncode(rawPublic),
      auth: authSecret,
    };
  },
});

/** The storage half of device creation. */
export const insertProofDevice = internalMutation({
  args: {
    token: v.string(),
    behavior: v.string(),
    publicBase64Url: v.string(),
    privateJwkJson: v.string(),
    authBase64Url: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("pushProofDevices", {
      token: args.token,
      behavior: args.behavior,
      publicBase64Url: args.publicBase64Url,
      privateJwkJson: args.privateJwkJson,
      authBase64Url: args.authBase64Url,
      messagesJson: "[]",
      createdAtMs: Date.now(),
    });
  },
});

/** Records one received message on the device row. */
export const proofRecordMessage = internalMutation({
  args: {
    token: v.string(),
    message: v.string(),
    vapidVerified: v.boolean(),
    vapidAudience: v.optional(v.string()),
    ttl: v.optional(v.string()),
    contentEncoding: v.optional(v.string()),
    decrypted: v.boolean(),
    payloadJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("pushProofDevices")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (device === null) {
      return { recorded: false };
    }
    const messages = JSON.parse(device.messagesJson) as unknown[];
    const message: RecordedMessage = {
      atMs: Date.now(),
      ttl: args.ttl ?? null,
      contentEncoding: args.contentEncoding ?? null,
      vapidVerified: args.vapidVerified,
      vapidAudience: args.vapidAudience ?? null,
      decrypted: args.decrypted,
      payload:
        args.payloadJson === undefined
          ? null
          : (JSON.parse(args.payloadJson) as RecordedMessage["payload"]),
      rawBodyBase64Url: args.message,
    };
    messages.push(message);
    await ctx.db.patch(device._id, {
      messagesJson: JSON.stringify(messages.slice(-MAX_RECORDED)),
    });
    return { recorded: true };
  },
});

/** The evidence read: devices with their recorded (decrypted) messages. */
export const proofState = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("pushProofDevices").collect();
    return {
      devices: rows.map((row) => ({
        token: row.token,
        behavior: row.behavior,
        messages: JSON.parse(row.messagesJson) as RecordedMessage[],
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// The push-service half: VAPID verification and RFC 8291 decryption.
// ---------------------------------------------------------------------------

/** Verifies the RFC 8292 Authorization header against the public key. */
async function verifyVapid(
  authorization: string | null,
  endpointOrigin: string,
): Promise<{ ok: boolean; audience: string | null }> {
  if (authorization === null || !authorization.startsWith("vapid ")) {
    return { ok: false, audience: null };
  }
  const tokenMatch = /t=([^,]+)/.exec(authorization);
  const keyMatch = /k=([A-Za-z0-9_-]+)/.exec(authorization);
  if (tokenMatch === null || keyMatch === null) {
    return { ok: false, audience: null };
  }
  const expectedPublic = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  if (typeof expectedPublic !== "string" || keyMatch[1] !== expectedPublic) {
    return { ok: false, audience: null };
  }
  const parts = tokenMatch[1]!.split(".");
  if (parts.length !== 3) {
    return { ok: false, audience: null };
  }
  let claims: { aud?: unknown; exp?: unknown };
  let header: { alg?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]!))) as typeof header;
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!))) as typeof claims;
  } catch {
    return { ok: false, audience: null };
  }
  if (header.alg !== "ES256") {
    return { ok: false, audience: null };
  }
  const audience = typeof claims.aud === "string" ? claims.aud : null;
  const expires = typeof claims.exp === "number" ? claims.exp : null;
  if (audience !== endpointOrigin) {
    return { ok: false, audience };
  }
  if (expires === null || expires < Math.floor(Date.now() / 1000)) {
    return { ok: false, audience };
  }
  const verifyKey = await crypto.subtle.importKey(
    "raw",
    base64UrlDecode(expectedPublic) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    base64UrlDecode(parts[2]!) as BufferSource,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`) as BufferSource,
  );
  return { ok: verified, audience };
}

/** Decrypts one aes128gcm body with the device's private key (RFC 8291). */
async function decryptForDevice(
  device: { readonly privateJwkJson: string; readonly publicBase64Url: string; readonly authBase64Url: string },
  body: Uint8Array,
): Promise<Uint8Array | null> {
  if (body.length < 87 || body[20] !== 65) {
    return null;
  }
  const salt = body.slice(0, 16);
  const ephemeral = body.slice(21, 86);
  const sealed = body.slice(86);
  const encoder = new TextEncoder();
  const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  try {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(device.privateJwkJson) as JsonWebKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const ephemeralKey = await crypto.subtle.importKey(
      "raw",
      ephemeral as BufferSource,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const ecdhSecret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralKey }, privateKey, 256),
    );
    const ikmMaterial = await crypto.subtle.importKey("raw", ecdhSecret as BufferSource, "HKDF", false, [
      "deriveBits",
    ]);
    const ikm = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: base64UrlDecode(device.authBase64Url) as BufferSource,
          info: concat(
            encoder.encode("WebPush: info"),
            new Uint8Array([0]),
            base64UrlDecode(device.publicBase64Url),
            ephemeral,
          ) as BufferSource,
        },
        ikmMaterial,
        256,
      ),
    );
    const ikmKey = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
      "deriveBits",
    ]);
    const cek = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: salt as BufferSource,
          info: concat(encoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])) as BufferSource,
        },
        ikmKey,
        128,
      ),
    );
    const nonce = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: salt as BufferSource,
          info: concat(encoder.encode("Content-Encoding: nonce"), new Uint8Array([0])) as BufferSource,
        },
        ikmKey,
        96,
      ),
    );
    const cekKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
      "decrypt",
    ]);
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
        cekKey,
        sealed as BufferSource,
      ),
    );
    // Strip the RFC 8188 padding delimiter tail (0x02 then zero padding).
    let end = plaintext.length;
    while (end > 0 && plaintext[end - 1] === 0) {
      end -= 1;
    }
    if (end > 0 && plaintext[end - 1] === 2) {
      end -= 1;
    }
    return plaintext.slice(0, end);
  } catch {
    return null;
  }
}

/** The fake push endpoint the real transport POSTs to. */
export const proofPushServiceHandler = httpAction(async (ctx, request): Promise<Response> => {
  if (!pushProofEnabled(process.env)) {
    return disabled();
  }
  const url = new URL(request.url);
  const token = url.pathname.split("/").pop() ?? "";
  const body = new Uint8Array(await request.arrayBuffer());
  const vapid = await verifyVapid(request.headers.get("authorization"), url.origin);
  const state = await ctx.runQuery(internal.attention.push.proofService.proofState, {});
  const device = state.devices.find((candidate) => candidate.token === token);
  if (device === undefined) {
    return json(404, { error: "no_such_subscription" });
  }
  const deviceRow = (
    await ctx.runQuery(internal.attention.push.proofService.deviceSecrets, { token })
  );
  if (deviceRow === null) {
    return json(404, { error: "no_such_subscription" });
  }
  let payloadJson: string | undefined;
  let decrypted = false;
  if (vapid.ok) {
    const plaintext = await decryptForDevice(deviceRow, body);
    if (plaintext !== null) {
      decrypted = true;
      try {
        const text = new TextDecoder().decode(plaintext);
        JSON.parse(text);
        payloadJson = text;
      } catch {
        payloadJson = undefined;
      }
    }
  }
  // The receipt exists from THIS moment, before any behavior delay: a
  // caller that aborts on its bounded deadline has still delivered here.
  const recordArgs: {
    token: string;
    message: string;
    vapidVerified: boolean;
    decrypted: boolean;
    vapidAudience?: string;
    ttl?: string;
    contentEncoding?: string;
    payloadJson?: string;
  } = {
    token,
    message: base64UrlEncode(body),
    vapidVerified: vapid.ok,
    decrypted,
  };
  if (vapid.audience !== null) {
    recordArgs.vapidAudience = vapid.audience;
  }
  const ttl = request.headers.get("ttl");
  if (ttl !== null) {
    recordArgs.ttl = ttl;
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding !== null) {
    recordArgs.contentEncoding = contentEncoding;
  }
  if (payloadJson !== undefined) {
    recordArgs.payloadJson = payloadJson;
  }
  await ctx.runMutation(internal.attention.push.proofService.proofRecordMessage, recordArgs);
  if (device.behavior === "gone") {
    return json(404, { error: "subscription_expired" });
  }
  if (device.behavior === "timeout") {
    await new Promise((resolve) => setTimeout(resolve, PROOF_STALL_MS));
  }
  return json(201, { received: true });
});

/** The internal read of one device's decryption secrets (guarded). */
export const deviceSecrets = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("pushProofDevices")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (row === null) {
      return null;
    }
    return {
      privateJwkJson: row.privateJwkJson,
      publicBase64Url: row.publicBase64Url,
      authBase64Url: row.authBase64Url,
    };
  },
});

/** "Subscribe": creates a device and answers like the browser would. */
export const proofDeviceHandler = httpAction(async (ctx, request): Promise<Response> => {
  if (!pushProofEnabled(process.env)) {
    return disabled();
  }
  let behavior = "ok";
  try {
    const parsed = (await request.json()) as { behavior?: unknown };
    if (typeof parsed.behavior === "string") {
      behavior = parsed.behavior;
    }
  } catch {
    behavior = "ok";
  }
  const created = await ctx.runAction(internal.attention.push.proofService.proofCreateDevice, {
    behavior,
  });
  const site = process.env.CONVEX_SITE_URL ?? new URL(request.url).origin;
  return json(201, {
    endpoint: `${site}/attention/push/proof/push-service/${created.token}`,
    keys: { p256dh: created.p256dh, auth: created.auth },
  });
});

/** The guarded evidence read over HTTP (the proof script's inspection). */
export const proofStateHandler = httpAction(async (ctx, _request): Promise<Response> => {
  if (!pushProofEnabled(process.env)) {
    return disabled();
  }
  return json(200, await ctx.runQuery(internal.attention.push.proofService.proofState, {}));
});
