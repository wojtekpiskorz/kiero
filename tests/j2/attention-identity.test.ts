/**
 * J2 focused tests, identity half: the attention-lane identity repair the
 * join owns (the gap H2 recorded on its public reads).
 *
 * The user path of every attention read/dispatch must resolve through
 * B1's live-session chain (auth-session subject -> sessions registry ->
 * A3 canonical resolution), never through the platform-generic
 * `identityFromConvexAuth` whose subject (`<userId>|<authSessions id>`)
 * is not a sessions-registry id: the defect that made myTaskReminders,
 * the snooze command, the read-state projection and the push-state read
 * refuse under ordinary user tokens.
 *
 * The behavioral proof runs LIVE (an ordinary user token reading
 * myTaskReminders and snoozing on dev/j2, in e2e/core-flow/live-proof.mjs);
 * this deterministic file pins the wiring seam so a regression to the
 * platform-generic chain fails the suite, not a boss's notification click.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const read = (relative: string): string =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), relative), "utf8");

const attentionContext = read("../../convex/attention/context.ts");
const pushQueries = read("../../convex/attention/push/queries.ts");

describe("the attention identity seam after J2's repair", () => {
  it("resolves the user path through B1's live-session chain on reads and dispatches", () => {
    expect(attentionContext).toContain("resolveAccessContextFromConvexAuth");
    expect(attentionContext).toContain("resolveAccessContextWithProvisioning");
  });

  it("no longer feeds the platform-generic subject into the canonical resolution", () => {
    expect(attentionContext).not.toMatch(/import[^\n]*identityFromConvexAuth/);
    expect(attentionContext).not.toMatch(/await identityFromConvexAuth/);
  });

  it("covers the F3 sibling: the public push-state read rides the same chain", () => {
    expect(pushQueries).toContain("resolveAccessContextFromConvexAuth");
    expect(pushQueries).not.toMatch(/import[^\n]*identityFromConvexAuth/);
  });
});
