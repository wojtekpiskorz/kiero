/**
 * Company access on the in-process backend, through the PUBLIC client
 * entries with Convex Auth identities (subject `<userId>|<authSessionId>`):
 * a boss creates the firm, invites a second boss who joins with the code,
 * and loses company data immediately when the administrator revokes the
 * membership. Anonymous callers fail closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, ok, type Backend } from "./harness";

const CODE = "12345678";
let t: Backend;

beforeEach(() => {
  vi.useFakeTimers();
  process.env.KIERO_B3_PROOF_ENABLED = "1";
  delete process.env.RESEND_API_KEY;
  t = backend();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.KIERO_B3_PROOF_ENABLED;
});

/** A signed-in boss: user row, live Convex Auth session, app session registry. */
async function signIn(email: string) {
  const { userId, authSessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email,
      displayName: email.split("@")[0] ?? email,
      emailVerificationTime: Date.now(),
      createdAtMs: Date.now(),
    });
    const authSessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 30 * 24 * 3600 * 1000,
    });
    return { userId, authSessionId };
  });
  const client = t.withIdentity({ subject: `${userId}|${authSessionId}` });
  const ensured = await client.mutation(api.access.identity.functions.ensureSessionRegistry, {});
  expect(ensured).toMatchObject({ state: "live" });
  return client;
}

const envelope = (operation: string, input: unknown) => ({ operation, input, expectedRevisions: [] });

describe("company access", () => {
  it("lets an invited boss join with the code and cuts access on revocation", async () => {
    const admin = await signIn("szef1@kiero.invalid");
    ok(
      await admin.mutation(api.access.membership.functions.admitCommand, {
        envelope: envelope("access.createCompany", {
          name: "Firma Testowa",
          timezone: "Europe/Warsaw",
          defaultCurrency: "PLN",
        }),
      }),
    );

    const issued = ok<{ invitationId: Id<"invitations">; delivery: string }>(
      await admin.action(api.access.membership.functions.createInvitationCommand, {
        envelope: envelope("access.createInvitation", { email: "szef2@kiero.invalid", role: "member" }),
      }),
    );
    // No RESEND_API_KEY here: delivery fails honestly instead of pretending.
    expect(issued.delivery).toBe("delivery_failed");
    ok(
      await t.action(api.access.membership.probe.b3ProofSetInvitationCode, {
        invitationId: issued.invitationId,
        code: CODE,
      }),
    );

    const second = await signIn("szef2@kiero.invalid");
    const wrong = (await second.mutation(api.access.membership.functions.admitCommand, {
      envelope: envelope("access.acceptInvitation", {
        invitationId: issued.invitationId,
        verificationCode: "00000000",
      }),
    })) as { _tag: string };
    expect(wrong._tag).toBe("error");

    const { membershipId } = ok<{ membershipId: string }>(
      await second.mutation(api.access.membership.functions.admitCommand, {
        envelope: envelope("access.acceptInvitation", {
          invitationId: issued.invitationId,
          verificationCode: CODE,
        }),
      }),
    );
    expect(await second.query(api.access.membership.functions.membershipOverview, {})).toMatchObject({
      state: "member",
      myRole: "member",
    });

    ok(
      await admin.mutation(api.access.membership.functions.dispatchMembership, {
        envelope: envelope("access.revokeMembership", { membershipId }),
      }),
    );

    const after = await second
      .query(api.access.membership.functions.membershipOverview, {})
      .catch(() => null);
    expect(after === null || (after as { state: string }).state === "no_company").toBe(true);
  });

  it("refuses anonymous commands", async () => {
    const result = (await t.mutation(api.access.membership.functions.dispatchMembership, {
      envelope: envelope("access.revokeMembership", { membershipId: "k57anon0000000000000000000" }),
    })) as { _tag: string; error?: { _tag: string } };

    expect(result._tag).toBe("error");
    expect(result.error?._tag).toBe("unauthenticated");
  });
});
