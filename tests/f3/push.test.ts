/**
 * F3 transaction tests: registration binding, the per-device delivery
 * prepare/settle pair, and the revocation rules - over the REAL
 * transaction functions with the in-memory db (tests/d2/harness.ts, the
 * F2 precedent).
 *
 * The focused-verification injections issue 43 names:
 * - provider timeout-after-acceptance (unknown blocks blind re-sends);
 * - expired subscription (404/410 revokes it terminally);
 * - concurrent retry (prepare twice collapses onto the same rows);
 * - session revocation and membership revocation (delivery denied at
 *   prepare time, before any cleanup persists it; the hygiene sweep
 *   converges the stored state afterwards).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { asTx, errorOf, fakeCtx, valueOf, type FakeCtx } from "../d2/harness";
import {
  performRegisterPushSubscription,
  performRevokePushSubscription,
  performPreparePushDelivery,
  performCompletePushLegs,
  performPushHygiene,
  performStalePendingIntentIds,
  registrationIssue,
  type PreparedLeg,
} from "../../convex/attention/push/operations";
import { base64UrlEncode } from "../../convex/attention/push/protocol";
import { projectEventToJobInputs } from "../../convex/platform/outbox";
import { pushDeliveryExecutor } from "../../convex/attention/push/executor";
import type { RequestContext } from "@kiero/runtime";

/** RFC 8291-shaped fixture keys: 65-byte 0x04-prefixed point, 16-byte auth. */
const VALID_P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const VALID_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

const TABLES = [
  "companies",
  "users",
  "sessions",
  "memberships",
  "projects",
  "sources",
  "attachments",
  "clarifications",
  "notificationPreferences",
  "notificationIntents",
  "pushSubscriptions",
  "pushDeliveries",
  "notificationAttempts",
  "outboxEvents",
  "durableJobs",
] as const;

const T0 = Date.parse("2026-09-09T10:00:00.000Z");

let ctx: FakeCtx;
const tx = () => asTx(ctx);

interface Firm {
  readonly companyId: string;
  readonly authorId: string; // the entry author (never a recipient of own entry)
  readonly bossId: string; // the recipient
  readonly otherFirmBossId: string;
  readonly otherCompanyId: string;
  readonly sessionId: string;
  readonly secondDeviceSessionId: string;
}

async function seedUser(email: string, displayName: string): Promise<string> {
  return ctx.db.insert("users", { email, displayName, createdAtMs: T0 });
}

async function seedFirm(): Promise<Firm> {
  const companyId = await ctx.db.insert("companies", {
    name: "F3 test firm",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: T0,
  });
  const authorId = await seedUser("f3-author@kiero.invalid", "Autor");
  const bossId = await seedUser("f3-boss@kiero.invalid", "Anna");
  for (const userId of [authorId, bossId]) {
    await ctx.db.insert("memberships", {
      companyId,
      userId,
      role: "member",
      state: "active",
      createdAtMs: T0,
    });
  }
  const sessionId = await ctx.db.insert("sessions", {
    userId: bossId,
    startedAtMs: T0,
    lastSeenAtMs: T0,
    deviceLabel: "telefon Anny",
  });
  const secondDeviceSessionId = await ctx.db.insert("sessions", {
    userId: bossId,
    startedAtMs: T0,
    lastSeenAtMs: T0,
    deviceLabel: "tablet Anny",
  });
  // A second firm with its own boss, for tenant isolation checks.
  const otherCompanyId = await ctx.db.insert("companies", {
    name: "F3 other firm",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: T0,
  });
  const otherFirmBossId = await seedUser("f3-other@kiero.invalid", "Obcy");
  await ctx.db.insert("memberships", {
    companyId: otherCompanyId,
    userId: otherFirmBossId,
    role: "member",
    state: "active",
    createdAtMs: T0,
  });
  return {
    companyId,
    authorId,
    bossId,
    otherCompanyId,
    otherFirmBossId,
    sessionId,
    secondDeviceSessionId,
  };
}

/** The resolved actor context the dispatch would hand the transaction. */
function actorOf(userId: string, companyId: string, sessionId: string): RequestContext {
  return {
    actor: {
      userId,
      companyId,
      membershipRole: "member",
      isGm: false,
      sessionId,
      via: "user",
    },
    resolvedAtMs: T0,
  } as unknown as RequestContext;
}

interface SubscriptionFixture {
  readonly pushSubscriptionId: string;
}

async function seedSubscription(
  firm: Firm,
  overrides: Partial<{
    userId: string;
    companyId: string;
    sessionId: string | null;
    endpoint: string;
    revokedAtMs: number | undefined;
  }> = {},
): Promise<SubscriptionFixture> {
  const pushSubscriptionId = await ctx.db.insert("pushSubscriptions", {
    userId: overrides.userId ?? firm.bossId,
    companyId: overrides.companyId ?? firm.companyId,
    ...(overrides.sessionId === null ? {} : { sessionId: overrides.sessionId ?? firm.sessionId }),
    endpoint: overrides.endpoint ?? "https://push.example.net/p/f3-1",
    p256dhKeyBase64: VALID_P256DH,
    authKeyBase64: VALID_AUTH,
    deviceLabel: "telefon Anny",
    createdAtMs: T0,
    ...(overrides.revokedAtMs === undefined ? {} : { revokedAtMs: overrides.revokedAtMs }),
  });
  return { pushSubscriptionId };
}

/** One delivered source_entry intent for the boss, with its summary. */
async function seedDeliveredIntent(
  firm: Firm,
  options: {
    readonly kind?: "company" | "project";
    readonly projectIds?: string[];
    readonly authorText?: string | null;
    readonly audioCount?: number;
    readonly photoCount?: number;
    readonly scopeSourceIds?: string[];
  } = {},
): Promise<string> {
  const sourceId = await ctx.db.insert("sources", {
    companyId: firm.companyId,
    authorUserId: firm.authorId,
    authorText: options.authorText ?? "Klient potwierdził termin na piątek.",
    sentAtMs: T0,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: T0,
    lifecycle: "active",
  });
  for (let index = 0; index < (options.audioCount ?? 0); index += 1) {
    await ctx.db.insert("attachments", {
      uploadId: `kuploadaudio${index}ttttttttt`,
      sourceId,
      kind: "audio",
      objectKey: `proof/audio/${index}`,
      createdAtMs: T0,
    });
  }
  for (let index = 0; index < (options.photoCount ?? 0); index += 1) {
    await ctx.db.insert("attachments", {
      uploadId: `kuploadphoto${index}ttttttttt`,
      sourceId,
      kind: "image",
      objectKey: `proof/photo/${index}`,
      createdAtMs: T0,
    });
  }
  const sourceIds = options.scopeSourceIds ?? [sourceId];
  const projectIds = options.projectIds ?? [];
  const intentId = await ctx.db.insert("notificationIntents", {
    companyId: firm.companyId,
    recipientUserId: firm.bossId,
    semanticKind: "source_entry",
    sourceId,
    dedupKey: `source_entry:${sourceId}:${firm.bossId}`,
    state: "delivered",
    dueAtMs: T0 + 60_000,
    deliveryJson: JSON.stringify({
      semanticKind: "source_entry",
      bucket: options.kind === "project" ? `project:${projectIds[0] ?? ""}` : "company",
      scope:
        options.kind === "project"
          ? { kind: "project", projectIds }
          : { kind: "company", projectIds: [] },
      sourceIds,
      clarificationIds: [],
      deliveredAtMs: T0 + 60_000,
    }),
    deliveredAtMs: T0 + 60_000,
    payloadJson: "{}",
    createdAtMs: T0,
  });
  return intentId;
}

beforeEach(() => {
  ctx = fakeCtx([...TABLES]);
});

// ---------------------------------------------------------------------------
// Registration: binding, renewal, removal, policy.
// ---------------------------------------------------------------------------

describe("device registration", () => {
  it("binds the subscription to the RESOLVED actor (user, company, session)", async () => {
    const firm = await seedFirm();
    const result = valueOf(
      await performRegisterPushSubscription(
        tx(),
        actorOf(firm.bossId, firm.companyId, firm.sessionId),
        {
          endpoint: "https://push.example.net/p/new-device",
          p256dhKeyBase64: VALID_P256DH,
          authKeyBase64: VALID_AUTH,
          deviceLabel: "telefon Anny",
        },
      ),
    );
    const row = ctx.db
      .rows("pushSubscriptions")
      .find((candidate) => candidate._id === result.pushSubscriptionId);
    expect(row).toMatchObject({
      userId: firm.bossId,
      companyId: firm.companyId,
      sessionId: firm.sessionId,
      endpoint: "https://push.example.net/p/new-device",
    });
  });

  it("renews an existing endpoint in place (same row, refreshed keys)", async () => {
    const firm = await seedFirm();
    // Two distinct but RFC 8291-shaped key pairs (65-byte 0x04-prefixed
    // p256dh, 16-byte auth): renewal must accept and store the new pair.
    const firstP256dh = base64UrlEncode(new Uint8Array([0x04, ...new Uint8Array(64)]));
    const firstAuth = base64UrlEncode(new Uint8Array(16));
    const secondP256dh = base64UrlEncode(new Uint8Array([0x04, ...new Uint8Array(63), 0x01]));
    const secondAuth = base64UrlEncode(new Uint8Array([1, ...new Uint8Array(15)]));
    const first = valueOf(
      await performRegisterPushSubscription(
        tx(),
        actorOf(firm.bossId, firm.companyId, firm.sessionId),
        {
          endpoint: "https://push.example.net/p/renew",
          p256dhKeyBase64: firstP256dh,
          authKeyBase64: firstAuth,
          deviceLabel: "telefon",
        },
      ),
    );
    const second = valueOf(
      await performRegisterPushSubscription(
        tx(),
        actorOf(firm.bossId, firm.companyId, firm.secondDeviceSessionId),
        {
          endpoint: "https://push.example.net/p/renew",
          p256dhKeyBase64: secondP256dh,
          authKeyBase64: secondAuth,
        },
      ),
    );
    expect(second.pushSubscriptionId).toBe(first.pushSubscriptionId);
    expect(ctx.db.rows("pushSubscriptions")).toHaveLength(1);
    expect(ctx.db.rows("pushSubscriptions")[0]).toMatchObject({
      sessionId: firm.secondDeviceSessionId,
      p256dhKeyBase64: secondP256dh,
      authKeyBase64: secondAuth,
    });
  });

  it("applies the endpoint policy (https, or loopback http for dev proofs)", () => {
    expect(registrationIssue({
      endpoint: "https://push.example.net/p/x",
      p256dhKeyBase64: VALID_P256DH,
      authKeyBase64: VALID_AUTH,
      deviceLabel: "telefon",
    })).toBeNull();
    expect(registrationIssue({
      endpoint: "http://127.0.0.1:8787/probe",
      p256dhKeyBase64: VALID_P256DH,
      authKeyBase64: VALID_AUTH,
      deviceLabel: "telefon",
    })).toBeNull();
    expect(registrationIssue({
      endpoint: "http://evil.example.net/p/x",
      p256dhKeyBase64: VALID_P256DH,
      authKeyBase64: VALID_AUTH,
      deviceLabel: "telefon",
    })).toBe("endpoint_not_https");
    expect(registrationIssue({
      endpoint: "https://push.example.net/p/x",
      p256dhKeyBase64: "has spaces!",
      authKeyBase64: VALID_AUTH,
      deviceLabel: "telefon",
    })).toBe("subscription_keys_not_base64url");
  });

  it("rejects structurally invalid subscription keys (RFC 8291 shapes)", () => {
    const shapeIssue = (p256dh: Uint8Array, auth: Uint8Array): string | null =>
      registrationIssue({
        endpoint: "https://push.example.net/p/x",
        p256dhKeyBase64: base64UrlEncode(p256dh),
        authKeyBase64: base64UrlEncode(auth),
        deviceLabel: "telefon",
      });
    const validP256dh = new Uint8Array(65);
    validP256dh[0] = 0x04;
    const validAuth = new Uint8Array(16);
    expect(shapeIssue(validP256dh, validAuth)).toBeNull();
    // p256dh must be the 65-byte uncompressed point (0x04 || x || y).
    const wrongLength = validP256dh.slice(0, 64);
    expect(shapeIssue(wrongLength, validAuth)).toBe("subscription_keys_invalid_shape");
    const notUncompressed = new Uint8Array(65);
    notUncompressed[0] = 0x02;
    expect(shapeIssue(notUncompressed, validAuth)).toBe("subscription_keys_invalid_shape");
    // auth must be the 16-byte secret.
    expect(shapeIssue(validP256dh, new Uint8Array(15))).toBe("subscription_keys_invalid_shape");
    expect(shapeIssue(validP256dh, new Uint8Array(17))).toBe("subscription_keys_invalid_shape");
  });

  it("refuses to register structurally invalid keys (no healthy-looking dead row)", async () => {
    const firm = await seedFirm();
    const result = await performRegisterPushSubscription(
      tx(),
      actorOf(firm.bossId, firm.companyId, firm.sessionId),
      {
        endpoint: "https://push.example.net/p/bad-keys",
        p256dhKeyBase64: "AAA",
        authKeyBase64: VALID_AUTH,
        deviceLabel: "telefon",
      },
    );
    expect(errorOf(result).code).toBe("subscription_keys_invalid_shape");
    expect(ctx.db.rows("pushSubscriptions")).toHaveLength(0);
  });

  it("removes only the actor's OWN subscription, idempotently", async () => {
    const firm = await seedFirm();
    const seeded = await seedSubscription(firm);
    // A different person (their own firm's actor context) cannot remove it.
    const foreign = await performRevokePushSubscription(
      tx(),
      actorOf(firm.otherFirmBossId, firm.otherCompanyId, "k1111111111111111111111"),
      { pushSubscriptionId: seeded.pushSubscriptionId as never },
    );
    expect(errorOf(foreign).code).toBe("tenant_scope_mismatch");
    expect(ctx.db.rows("pushSubscriptions")[0]!.revokedAtMs).toBeUndefined();
    // The owner can, and a second removal is an idempotent no-op.
    const owner = valueOf(
      await performRevokePushSubscription(
        tx(),
        actorOf(firm.bossId, firm.companyId, firm.sessionId),
        { pushSubscriptionId: seeded.pushSubscriptionId as never },
      ),
    );
    expect(owner).toEqual({ revoked: "revoked" });
    const again = valueOf(
      await performRevokePushSubscription(
        tx(),
        actorOf(firm.bossId, firm.companyId, firm.sessionId),
        { pushSubscriptionId: seeded.pushSubscriptionId as never },
      ),
    );
    expect(again).toEqual({ revoked: "revoked" });
    expect(ctx.db.rows("pushSubscriptions")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Delivery prepare: live rights, idempotency, payload honesty.
// ---------------------------------------------------------------------------

describe("delivery prepare", () => {
  it("delivers one eligible intent to every ACTIVE subscription once per device", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm, { endpoint: "https://push.example.net/p/f3-1" });
    await seedSubscription(firm, {
      sessionId: firm.secondDeviceSessionId,
      endpoint: "https://push.example.net/p/f3-2",
    });
    const intentId = await seedDeliveredIntent(firm);

    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") {
      throw new Error("unreachable");
    }
    expect(prepared.legs).toHaveLength(2);
    expect(prepared.legs.map((leg) => leg.endpoint).sort()).toEqual([
      "https://push.example.net/p/f3-1",
      "https://push.example.net/p/f3-2",
    ]);
    // Every leg carries the SAME collapsed notification.
    const payloads = new Set(prepared.legs.map((leg) => leg.payloadJson));
    expect(payloads.size).toBe(1);
    expect(JSON.parse(prepared.legs[0]!.payloadJson)).toMatchObject({
      v: 1,
      kind: "source_entry",
      title: "Nowy wpis: Firma",
    });
  });

  it("concurrent retry collapses: a second prepare finds no pending work for settled rows", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const intentId = await seedDeliveredIntent(firm);
    const first = await performPreparePushDelivery(tx(), intentId as never);
    if (first.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    // The concurrent duplicate job prepare BEFORE completion: rows exist,
    // both still pending - the SAME legs come back (no duplicates).
    const second = await performPreparePushDelivery(tx(), intentId as never);
    expect(ctx.db.rows("pushDeliveries")).toHaveLength(1);
    expect(second.kind).toBe("prepared");
    if (second.kind !== "prepared") {
      throw new Error("unreachable");
    }
    expect(second.legs.map((leg) => leg.deliveryId)).toEqual(
      first.legs.map((leg) => leg.deliveryId),
    );
    // After a delivered completion, a replayed event's prepare is a no-op.
    await performCompletePushLegs(tx(), [
      {
        deliveryId: first.legs[0]!.deliveryId,
        subscriptionId: first.legs[0]!.subscriptionId,
        report: { kind: "delivered" },
      },
    ]);
    const third = await performPreparePushDelivery(tx(), intentId as never);
    expect(third).toEqual({ kind: "nothing_pending" });
    expect(ctx.db.rows("notificationAttempts")).toHaveLength(1);
  });

  it("denies delivery when the membership was revoked, before any cleanup", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const intentId = await seedDeliveredIntent(firm);
    const membership = ctx.db
      .rows("memberships")
      .find((row) => row.userId === firm.bossId && row.companyId === firm.companyId)!;
    await ctx.db.patch(membership._id, { state: "revoked", revokedAtMs: T0 });
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    expect(prepared).toEqual({ kind: "denied", reason: "membership_not_active" });
    expect(ctx.db.rows("pushDeliveries")).toHaveLength(0);
  });

  it("denies delivery when the bound session was revoked, even while the subscription row still looks enabled", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm); // bound to firm.sessionId
    const intentId = await seedDeliveredIntent(firm);
    await ctx.db.patch(firm.sessionId, { revokedAtMs: T0 });
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    expect(prepared).toEqual({ kind: "denied", reason: "no_active_subscription" });
    expect(ctx.db.rows("pushDeliveries")).toHaveLength(0);
  });

  it("inactive/revoked subscriptions receive nothing", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm, { revokedAtMs: T0 });
    const intentId = await seedDeliveredIntent(firm);
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    expect(prepared).toEqual({ kind: "denied", reason: "no_active_subscription" });
  });

  it("ignores intents that are not F2-delivered (suppressed/failed/pending notify nobody)", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const intentId = await seedDeliveredIntent(firm);
    await ctx.db.patch(intentId, { state: "suppressed", deliveryJson: undefined });
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "denied",
      reason: "intent_suppressed",
    });
  });

  it("composes the preview at delivery time from current data (project alias, media counts)", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const projectId = await ctx.db.insert("projects", {
      companyId: firm.companyId,
      displayName: "Banan",
      stage: "inquiry",
      createdAtMs: T0,
    });
    const intentId = await seedDeliveredIntent(firm, {
      kind: "project",
      projectIds: [projectId],
      authorText: "",
      audioCount: 1,
      photoCount: 2,
    });
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    expect(JSON.parse(prepared.legs[0]!.payloadJson)).toMatchObject({
      title: "Nowy wpis: Banan",
      body: "Autor: Nagranie i Zdjęcia: 2",
    });
  });

  it("honors the hide-preview preference re-read at delivery time", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const intentId = await seedDeliveredIntent(firm);
    await ctx.db.insert("notificationPreferences", {
      companyId: firm.companyId,
      userId: firm.bossId,
      mutedProjectIds: [],
      companyEntriesMuted: false,
      taskRemindersMuted: false,
      hidePreviewContent: true,
      updatedAtMs: T0,
    });
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    const payload = JSON.parse(prepared.legs[0]!.payloadJson);
    expect(payload.title).toBe("Nowe powiadomienie");
    expect(payload.body).toBe("Otwórz Kiero, żeby zobaczyć.");
  });
});

// ---------------------------------------------------------------------------
// Leg completion: attempts, terminal death, uncertainty.
// ---------------------------------------------------------------------------

describe("leg completion", () => {
  async function preparedLeg(firm: Firm): Promise<PreparedLeg> {
    await seedSubscription(firm);
    const intentId = await seedDeliveredIntent(firm);
    const prepared = await performPreparePushDelivery(tx(), intentId as never);
    if (prepared.kind !== "prepared") {
      throw new Error("expected prepared");
    }
    return prepared.legs[0]!;
  }

  it("records the delivered attempt on the shared ledger and settles the row", async () => {
    const firm = await seedFirm();
    const leg = await preparedLeg(firm);
    const completion = await performCompletePushLegs(tx(), [
      { ...leg, report: { kind: "delivered" } },
    ]);
    expect(completion).toEqual({ pendingRemaining: 0, revokedSubscriptions: 0 });
    expect(ctx.db.rows("pushDeliveries")[0]).toMatchObject({ state: "delivered", attempts: 1 });
    expect(ctx.db.rows("notificationAttempts")[0]).toMatchObject({
      outcome: "delivered",
      providerRef: leg.subscriptionId,
    });
  });

  it("a terminal 404 expires the subscription (and it stops receiving later intents)", async () => {
    const firm = await seedFirm();
    const leg = await preparedLeg(firm);
    const completion = await performCompletePushLegs(tx(), [{ ...leg, report: { kind: "gone" } }]);
    expect(completion).toEqual({ pendingRemaining: 0, revokedSubscriptions: 1 });
    expect(ctx.db.rows("pushDeliveries")[0]).toMatchObject({
      state: "failed",
      lastErrorKind: "push_subscription_gone",
    });
    expect(ctx.db.rows("pushSubscriptions")[0]!.revokedAtMs).toBeDefined();
    // A NEW eligible intent reaches nothing: the device is gone.
    const secondIntentId = await seedDeliveredIntent(firm);
    expect(await performPreparePushDelivery(tx(), secondIntentId as never)).toEqual({
      kind: "denied",
      reason: "no_active_subscription",
    });
  });

  it("timeout-after-send stays unknown and is never re-driven", async () => {
    const firm = await seedFirm();
    const leg = await preparedLeg(firm);
    await performCompletePushLegs(tx(), [
      { ...leg, report: { kind: "unknown", cause: "timeout" } },
    ]);
    expect(ctx.db.rows("pushDeliveries")[0]).toMatchObject({
      state: "unknown",
      lastErrorKind: "push_timeout_after_send",
    });
    expect(ctx.db.rows("notificationAttempts")[0]).toMatchObject({ outcome: "unknown" });
    // A replayed event/job finds NOTHING pending: no blind re-send.
    const intentId = ctx.db.rows("pushDeliveries")[0]!.intentId;
    expect(await performPreparePushDelivery(tx(), intentId as never)).toEqual({
      kind: "nothing_pending",
    });
  });

  it("retry_later legs stay pending, bounded by MAX attempts", async () => {
    const firm = await seedFirm();
    const leg = await preparedLeg(firm);
    const first = await performCompletePushLegs(tx(), [
      { ...leg, report: { kind: "retry_later" } },
    ]);
    expect(first.pendingRemaining).toBe(1);
    // The next sweep re-drives the SAME pending row (the per-device row is
    // the retry unit, never a fresh duplicate).
    const intentId = ctx.db.rows("pushDeliveries")[0]!.intentId;
    const again = await performPreparePushDelivery(tx(), intentId as never);
    if (again.kind !== "prepared") {
      throw new Error("expected prepared again");
    }
    expect(again.legs).toHaveLength(1);
    expect(again.legs[0]!.attempts).toBe(1);
    await performCompletePushLegs(tx(), [{ ...leg, report: { kind: "retry_later" } }]);
    await performCompletePushLegs(tx(), [{ ...leg, report: { kind: "retry_later" } }]);
    expect(ctx.db.rows("pushDeliveries")[0]).toMatchObject({
      state: "failed",
      lastErrorKind: "push_attempts_exhausted",
      attempts: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// Hygiene and the safety net input.
// ---------------------------------------------------------------------------

describe("revocation hygiene and the safety net", () => {
  it("disables subscriptions whose session died or membership was revoked", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm); // session-bound
    await seedSubscription(firm, {
      sessionId: null,
      endpoint: "https://push.example.net/p/f3-unbound",
    }); // no session: hygiene keys on membership
    await ctx.db.patch(firm.sessionId, { revokedAtMs: T0 });
    const membership = ctx.db
      .rows("memberships")
      .find((row) => row.userId === firm.bossId && row.companyId === firm.companyId)!;
    await ctx.db.patch(membership._id, { state: "revoked", revokedAtMs: T0 });
    const pass = await performPushHygiene(tx());
    expect(pass.disabled).toBe(2);
    for (const row of ctx.db.rows("pushSubscriptions")) {
      expect(row.revokedAtMs).toBeDefined();
    }
  });

  it("leaves healthy subscriptions untouched", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    expect(await performPushHygiene(tx())).toEqual({ disabled: 0 });
  });

  it("converges past the 200-row window: disabled rows leave the swept range", async () => {
    const firm = await seedFirm();
    await ctx.db.patch(firm.sessionId, { revokedAtMs: T0 });
    // One MORE dead subscription than a bounded pass inspects
    // (HYGIENE_LIMIT is 200). A table scan would re-read the same oldest
    // 200 forever; the by_revoked sweep must disable the next window on
    // every pass until the table drains.
    for (let index = 0; index < 201; index += 1) {
      await seedSubscription(firm, { endpoint: `https://push.example.net/p/f3-sweep-${index}` });
    }
    const first = await performPushHygiene(tx());
    const second = await performPushHygiene(tx());
    const third = await performPushHygiene(tx());
    expect(first.disabled).toBe(200);
    expect(second.disabled).toBe(1);
    expect(third.disabled).toBe(0);
    for (const row of ctx.db.rows("pushSubscriptions")) {
      expect(row.revokedAtMs).toBeDefined();
    }
  });

  it("surfaces stale pending intents as the cron safety net's input", async () => {
    const firm = await seedFirm();
    await seedSubscription(firm);
    const intentId = await seedDeliveredIntent(firm);
    await performPreparePushDelivery(tx(), intentId as never);
    // Fresh pending rows are NOT stale yet (the bounded backoff owns them).
    expect(await performStalePendingIntentIds(tx())).toEqual([]);
    const row = ctx.db.rows("pushDeliveries")[0]!;
    await ctx.db.patch(row._id, { updatedAtMs: Date.now() - 120_000 });
    expect(await performStalePendingIntentIds(tx())).toEqual([intentId]);
  });
});

// ---------------------------------------------------------------------------
// The declared consumer seam (registry projection + executor shape).
// ---------------------------------------------------------------------------

describe("the intentDelivered consumer seam", () => {
  it("projects the delivered event onto one per-intent deliver_push job", () => {
    expect(
      projectEventToJobInputs(
        "attention.intentDelivered",
        { notificationIntentId: "k1111111111111111111111", outcome: "delivered" },
        "row-dedup",
      ),
    ).toEqual([
      {
        kind: "job",
        jobKind: "attention.deliver_push",
        input: { notificationIntentId: "k1111111111111111111111" },
        dedupKey: "attention.deliver_push:k1111111111111111111111",
      },
    ]);
  });

  it("registers the executor for the certified job kind", () => {
    expect(pushDeliveryExecutor.jobKind).toBe("attention.deliver_push");
  });
});
