/**
 * Shared service-credential verification tests (I2 round-1 repair): ONE
 * digest-compare definition used by both HTTP boundaries.
 */

import { describe, expect, it } from "vitest";
import { verifyServiceBearerToken } from "../../convex/operations/telemetry/serviceToken";

describe("verifyServiceBearerToken", () => {
  it("accepts the matching bearer credential", async () => {
    expect(await verifyServiceBearerToken("Bearer s3cret-value", "s3cret-value")).toBe(true);
  });

  it("rejects wrong credentials, missing headers and missing configuration", async () => {
    expect(await verifyServiceBearerToken("Bearer wrong", "s3cret-value")).toBe(false);
    expect(await verifyServiceBearerToken(null, "s3cret-value")).toBe(false);
    expect(await verifyServiceBearerToken("Basic s3cret-value", "s3cret-value")).toBe(false);
    expect(await verifyServiceBearerToken("Bearer s3cret-value", undefined)).toBe(false);
    expect(await verifyServiceBearerToken("Bearer s3cret-value", "")).toBe(false);
  });

  it("never needs the presented and expected lengths to match (digest compare)", async () => {
    expect(await verifyServiceBearerToken("Bearer short", "a-much-longer-expected-value")).toBe(
      false,
    );
    expect(await verifyServiceBearerToken("Bearer a-much-longer-presented", "short")).toBe(false);
  });
});
