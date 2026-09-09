/**
 * B2 focused verification: the account feature's client-side contract.
 *
 * Pins the twin literals between server and client (the client cannot
 * import server modules; this test imports both sides): the machine
 * markers and the full typed-rejection copy map must be equal, error
 * classification keys on the marker + code token (never prose), and the
 * email shape check stays honest.
 */

import { describe, expect, it } from "vitest";
import {
  LINK_REJECTED_MARKER,
  linkingRejectionCopy,
  type LinkRejectionCode,
} from "../../convex/access/linking/policy";
import { EMAIL_DELIVERY_FAILED_MARKER } from "../../convex/integrations/email/send";
import {
  ACCOUNT_ERROR_MARKERS,
  accountCopy,
  accountPendingLabel,
  classifyAccountError,
  isValidEmail,
} from "../../apps/web/src/features/account/state";

describe("twin literals (server <-> client)", () => {
  it("pins the link-rejected machine marker", () => {
    expect(ACCOUNT_ERROR_MARKERS.linkRejected).toBe(LINK_REJECTED_MARKER);
  });

  it("pins the delivery-failure machine marker (B1's, reused)", () => {
    expect(ACCOUNT_ERROR_MARKERS.emailDeliveryFailed).toBe(EMAIL_DELIVERY_FAILED_MARKER);
  });

  it("mirrors every server rejection copy exactly (typed codes, no drift)", () => {
    for (const code of Object.keys(linkingRejectionCopy) as LinkRejectionCode[]) {
      expect(accountCopy.failures[code], code).toBe(linkingRejectionCopy[code]);
    }
    expect(Object.keys(linkingRejectionCopy)).toHaveLength(
      (Object.keys(accountCopy.failures) as string[]).filter((key) =>
        key in linkingRejectionCopy,
      ).length,
    );
  });
});

describe("classifyAccountError", () => {
  it("classifies by marker + code token, never prose", () => {
    const message = `${LINK_REJECTED_MARKER}[proof_stale] ${linkingRejectionCopy.proof_stale}`;
    expect(classifyAccountError(new Error(message))).toBe("proof_stale");
  });

  it("classifies every typed code the server can send", () => {
    for (const code of Object.keys(linkingRejectionCopy) as LinkRejectionCode[]) {
      const message = `${LINK_REJECTED_MARKER}[${code}] ${linkingRejectionCopy[code]}`;
      expect(classifyAccountError(new Error(message)), code).toBe(code);
    }
  });

  it("classifies the email delivery failure marker", () => {
    expect(
      classifyAccountError(new Error(`${EMAIL_DELIVERY_FAILED_MARKER} Nie udało się…`)),
    ).toBe("email_delivery_failed");
  });

  it("falls back to unknown without leaking anything", () => {
    expect(classifyAccountError(new Error("weird upstream failure"))).toBe("unknown");
    expect(classifyAccountError("not an error")).toBe("unknown");
  });

  it("recognizes network-shaped failures", () => {
    expect(classifyAccountError(new Error("Failed to fetch"))).toBe("network");
  });
});

describe("account state helpers", () => {
  it("labels every pending state from the copy table", () => {
    expect(accountPendingLabel({ step: "sending-code", leg: "email_code" })).toBe(
      accountCopy.sending,
    );
    expect(accountPendingLabel({ step: "verifying-code", leg: "email_code" })).toBe(
      accountCopy.verifying,
    );
    expect(accountPendingLabel({ step: "google-pending" })).toBe(accountCopy.googlePending);
    expect(accountPendingLabel({ step: "idle" })).toBeNull();
  });

  it("keeps the email shape check strict enough for a UI gate", () => {
    expect(isValidEmail("szef@firma.pl")).toBe(true);
    expect(isValidEmail("  Szef@Firma.PL ")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.pl")).toBe(false);
  });
});
