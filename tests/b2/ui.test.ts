/**
 * B2 focused verification: the account feature's client-side contract.
 *
 * Pins the twin literals between server and client (the client cannot
 * import server modules; this test imports both sides): the machine
 * markers and the full typed-rejection copy map must be equal, error
 * classification keys on the marker + code token (never prose), and the
 * email shape check stays honest.
 *
 * R26: the linking refusals now travel as `ConvexError` DATA carrying
 * the closed code (the message keeps the marker/copy text for logs).
 * The pins below assert the data construction for every code, and that
 * the (not yet data-aware) account classifier still classifies the new
 * error shape through its message fallback.
 */

import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  LINK_REJECTED_MARKER,
  linkRejectionData,
  linkingRejectionCopy,
  type LinkRejectionCode,
} from "../../convex/access/linking/policy";
import {
  LINK_REJECTION_CODES,
  accessRefusalData,
  decodeAccessRefusalCode,
} from "../../convex/access/errorCodes";
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

describe("structured link rejections (R26: data, never the message)", () => {
  it("every rejection code the cores can return carries itself in the data", () => {
    for (const code of LINK_REJECTION_CODES) {
      const data = linkRejectionData(code);
      expect(decodeAccessRefusalCode(data), code).toBe(code);
      expect(data.code, code).toBe(code);
    }
  });

  it("the data message keeps the marker + code token + copy byte-for-byte (log/dev fidelity)", () => {
    for (const code of Object.keys(linkingRejectionCopy) as LinkRejectionCode[]) {
      expect(linkRejectionData(code).message, code).toBe(
        `${LINK_REJECTED_MARKER}[${code}] ${linkingRejectionCopy[code]}`,
      );
    }
  });

  it("the closed vocabulary holds exactly the ten linking codes", () => {
    expect([...LINK_REJECTION_CODES]).toEqual([
      "method_already_attached",
      "target_account_established",
      "ceremony_in_progress",
      "no_active_ceremony",
      "proof_stale",
      "mismatched_address",
      "google_email_unproven",
      "code_wrong_or_expired",
      "too_many_attempts",
      "ambiguous_registry",
    ]);
  });

  it("the account classifier still reads the code token from the new error shape (dev compat)", () => {
    // The account feature is not yet data-aware (outside R26's owned
    // paths); ConvexError embeds the data message in its message, so the
    // marker+token classification keeps working wherever messages are
    // visible (dev). Production copy for this surface is the R26
    // follow-up defect, tracked by the coordinator.
    for (const code of Object.keys(linkingRejectionCopy) as LinkRejectionCode[]) {
      expect(classifyAccountError(new ConvexError(linkRejectionData(code))), code).toBe(code);
    }
    expect(
      classifyAccountError(
        new ConvexError(
          accessRefusalData(
            "email_delivery_failed",
            `${EMAIL_DELIVERY_FAILED_MARKER} Nie udało się wysłać wiadomości.`,
          ),
        ),
      ),
    ).toBe("email_delivery_failed");
  });

  it("foreign payloads decode to nothing (fail closed)", () => {
    expect(decodeAccessRefusalCode(undefined)).toBeNull();
    expect(decodeAccessRefusalCode("proof_stale")).toBeNull();
    expect(decodeAccessRefusalCode({ code: "method_conflict " })).toBeNull();
    expect(decodeAccessRefusalCode({ code: ["proof_stale"] })).toBeNull();
    expect(decodeAccessRefusalCode({ message: "no code field" })).toBeNull();
  });
});
