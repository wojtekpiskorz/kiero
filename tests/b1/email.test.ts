/**
 * B1 focused verification: the Resend application-email adapter.
 *
 * Delivery outcomes (sent / failed / unknown) without a real key, no code
 * or secret leakage in any failure surface, Polish copy, and the honest
 * not-configured behavior when RESEND_API_KEY is absent by name.
 */

import { describe, expect, it } from "vitest";
import {
  renderApplicationEmail,
  formatExpiryPl,
} from "../../convex/integrations/email/copy";
import {
  DEFAULT_RESEND_FROM,
  RESEND_API_KEY_NAME,
  resendDepsFromEnv,
  sendViaResend,
  type ResendDeps,
} from "../../convex/integrations/email/resend";
import {
  deliverApplicationEmail,
  deliveryFailureCopy,
  emailDeliveryFailureCopy,
} from "../../convex/integrations/email/send";

const SECRET = "re_live_secret_do_not_leak_012345";

function deps(overrides: Partial<ResendDeps>): ResendDeps {
  return {
    fetchImpl: async () => new Response("{}", { status: 200 }),
    apiKey: SECRET,
    from: DEFAULT_RESEND_FROM,
    deadlineMs: 50,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("renderApplicationEmail (Polish copy)", () => {
  const expiresAtMs = Date.parse("2026-09-09T12:00:00Z");

  it("renders the sign-in code email with code and expiry only", () => {
    const rendered = renderApplicationEmail({
      kind: "sign_in_code",
      code: "42424242",
      expiresAtMs,
    });
    expect(rendered.subject).toBe("Kiero — kod do logowania");
    expect(rendered.text).toContain("42424242");
    expect(rendered.text).toContain(formatExpiryPl(expiresAtMs));
    expect(rendered.text).toContain("zignoruj tę wiadomość");
    expect(rendered.text).not.toContain("http");
  });

  it("renders the invitation email through the same adapter surface", () => {
    const rendered = renderApplicationEmail({
      kind: "invitation_code",
      companyName: "Bud-Mar",
      code: "9988776",
      expiresAtMs,
    });
    expect(rendered.subject).toBe("Kiero — zaproszenie do firmy");
    expect(rendered.text).toContain("Bud-Mar");
    expect(rendered.text).toContain("9988776");
  });
});

describe("sendViaResend outcomes", () => {
  it("reports sent with the provider email id on success", async () => {
    const outcome = await sendViaResend(
      { to: "szef@firma.pl", subject: "s", text: "t" },
      deps({ fetchImpl: async () => jsonResponse({ id: "email-1" }, 200) }),
    );
    expect(outcome).toEqual({ outcome: "sent", providerEmailId: "email-1" });
  });

  it("records the key's absence honestly as not_configured (no throw)", async () => {
    const outcome = await sendViaResend(
      { to: "szef@firma.pl", subject: "s", text: "t" },
      deps({ apiKey: undefined }),
    );
    expect(outcome).toEqual({ outcome: "failed", reason: "not_configured" });
  });

  it("sanitizes provider rejections to failed/rejected without payload", async () => {
    const outcome = await sendViaResend(
      { to: "szef@firma.pl", subject: "s", text: "t" },
      deps({
        fetchImpl: async () =>
          jsonResponse({ message: "domain not verified", name: "validation_error" }, 403),
      }),
    );
    expect(outcome).toEqual({ outcome: "failed", reason: "rejected" });
    expect(JSON.stringify(outcome)).not.toContain("validation_error");
  });

  it("treats a deadline after the request as unknown (may have delivered)", async () => {
    const outcome = await sendViaResend(
      { to: "szef@firma.pl", subject: "s", text: "t" },
      deps({
        deadlineMs: 5,
        fetchImpl: () =>
          new Promise<Response>((_resolve, reject) =>
            setTimeout(() => reject(new DOMException("aborted", "AbortError")), 500),
          ),
      }),
    );
    expect(outcome).toEqual({ outcome: "unknown", reason: "deadline_exceeded" });
  });

  it("treats network errors as unknown", async () => {
    const outcome = await sendViaResend(
      { to: "szef@firma.pl", subject: "s", text: "t" },
      deps({ fetchImpl: async () => Promise.reject(new TypeError("fetch failed")) }),
    );
    expect(outcome).toEqual({ outcome: "unknown", reason: "network_error" });
  });

  it("never counts an unexpected 2xx shape as success", async () => {
    const outcome = await sendViaResend(
      { to: "szef@firma.pl", subject: "s", text: "t" },
      deps({ fetchImpl: async () => jsonResponse({ nope: true }, 200) }),
    );
    expect(outcome).toEqual({ outcome: "unknown", reason: "unexpected_response" });
  });

  it("sends the key only in the Authorization header (checked via capture)", async () => {
    let captured: Request | undefined;
    await sendViaResend(
      { to: "szef@firma.pl", subject: "s", text: "t" },
      deps({
        fetchImpl: async (_url, init) => {
          captured = new Request("https://api.resend.com/emails", init);
          return jsonResponse({ id: "e" }, 200);
        },
      }),
    );
    expect(captured?.headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
  });
});

describe("env handling (names only)", () => {
  it("an empty RESEND_API_KEY value reads as not configured", () => {
    const resolved = resendDepsFromEnv({ RESEND_API_KEY: "" });
    expect(resolved.apiKey).toBeUndefined();
  });

  it("RESEND_FROM falls back to the sandbox sender", () => {
    expect(resendDepsFromEnv({}).from).toBe(DEFAULT_RESEND_FROM);
    expect(resendDepsFromEnv({ RESEND_FROM: "Kiero <no-reply@firma.pl>" }).from).toBe(
      "Kiero <no-reply@firma.pl>",
    );
  });

  it("the key env var name is RESEND_API_KEY", () => {
    expect(RESEND_API_KEY_NAME).toBe("RESEND_API_KEY");
  });
});

describe("deliverApplicationEmail + failure copy", () => {
  it("maps every outcome to Polish copy or null on success", () => {
    expect(deliveryFailureCopy({ outcome: "sent", providerEmailId: "x" })).toBeNull();
    expect(deliveryFailureCopy({ outcome: "failed", reason: "not_configured" })).toBe(
      emailDeliveryFailureCopy.not_configured,
    );
    expect(deliveryFailureCopy({ outcome: "failed", reason: "rejected" })).toBe(
      emailDeliveryFailureCopy.rejected,
    );
    expect(deliveryFailureCopy({ outcome: "unknown", reason: "network_error" })).toBe(
      emailDeliveryFailureCopy.unknown,
    );
  });

  it("delivers without a key by reporting not_configured (testable path)", async () => {
    const outcome = await deliverApplicationEmail(
      "szef@firma.pl",
      { kind: "sign_in_code", code: "11112222", expiresAtMs: Date.now() + 60_000 },
      {},
    );
    expect(outcome).toEqual({ outcome: "failed", reason: "not_configured" });
  });
});
