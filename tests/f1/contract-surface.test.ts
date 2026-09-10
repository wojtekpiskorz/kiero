/**
 * F1 focused tests: the certified attention contract surface and the D1
 * identity hand-off (issue 41: "Contract tests prove notification
 * eligibility consumes the same source/user identity returned by D1").
 *
 * D1's `SourceConversationRow` is the canonical read shape of an accepted
 * source in BOTH conversation scopes; its `sourceId` (logical source) and
 * `projectIds` (the view's link projection) are exactly the identities the
 * read-state projection and the eligibility evaluation consume. These
 * tests decode a real row through D1's schema and prove each identity
 * round-trips through the F1 surfaces without translation.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  attentionEvents,
  attentionOperations,
  operations,
  parseTableId,
} from "@kiero/contracts";
import {
  SourceConversationRow,
  deriveProcessingState,
} from "../../convex/sources/read/rows";
import { projectReadState } from "../../convex/attention/read_state/state";
import { decidePersonalDelivery } from "../../convex/attention/preferences/evaluation";
import { preferencesHandlers } from "../../convex/attention/preferences/dispatch";

const SOURCE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";
const AUTHOR_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3us1";
const P1 = "k57d0000000000000000000000000p01";
const P2 = "k57d0000000000000000000000000p02";

const changePreferences = attentionOperations["attention.changeNotificationPreferences"];
const markSourceRead = attentionOperations["attention.markSourceRead"];

/** One decoded D1 row: a mixed-project source seen in either scope. */
const row = Schema.decodeUnknownSync(SourceConversationRow)({
  sourceId: SOURCE_ID,
  authorUserId: AUTHOR_ID,
  authorText: "Dowóz płytek na Buniewice i wpłata Kaczmarka",
  sentAtMs: Date.parse("2026-09-09T07:15:00.000Z"),
  sentAtTimezone: "Europe/Warsaw",
  fullyAcceptedAtMs: Date.parse("2026-09-09T07:15:02.000Z"),
  lifecycle: "active",
  processingState: deriveProcessingState(null),
  projectIds: [P1, P2],
});

describe("the composed registry still carries exactly the attention surface", () => {
  it("declares the six attention operations under their certified names", () => {
    // F3 amendment (issue #43): attention.revokePushSubscription joins the
    // certified surface (the sanctioned registry append).
    expect(Object.keys(attentionOperations).sort()).toEqual([
      "attention.changeNotificationPreferences",
      "attention.evaluateDueIntents",
      "attention.markSourceRead",
      "attention.registerPushSubscription",
      "attention.revokePushSubscription",
      "attention.snoozeTaskReminders",
    ]);
    for (const name of Object.keys(attentionOperations)) {
      expect(operations[name]?.name).toBe(name);
    }
  });

  it("registers the preference handler under its certified name only", () => {
    const handlers = preferencesHandlers();
    expect(Object.keys(handlers).sort()).toEqual(["attention.changeNotificationPreferences"]);
    expect(handlers["attention.changeNotificationPreferences"]?.intent).toBe("write");
  });
});

describe("the F1-amended change-preferences input (patch semantics)", () => {
  it("decodes each control alone (independent changes)", () => {
    expect(Schema.decodeUnknownSync(changePreferences.input)({ mutedProjectIds: [P1] }))
      .toEqual({ mutedProjectIds: [P1] });
    expect(Schema.decodeUnknownSync(changePreferences.input)({ companyEntriesMuted: true }))
      .toEqual({ companyEntriesMuted: true });
    expect(Schema.decodeUnknownSync(changePreferences.input)({ taskRemindersMuted: true }))
      .toEqual({ taskRemindersMuted: true });
    expect(Schema.decodeUnknownSync(changePreferences.input)({ hidePreviewContent: true }))
      .toEqual({ hidePreviewContent: true });
    expect(Schema.decodeUnknownSync(changePreferences.input)({ quietHours: null }))
      .toEqual({ quietHours: null });
    expect(
      Schema.decodeUnknownSync(changePreferences.input)({
        quietHours: { startMinuteOfDay: 0, endMinuteOfDay: 1439 },
      }),
    ).toEqual({ quietHours: { startMinuteOfDay: 0, endMinuteOfDay: 1439 } });
  });

  it("decodes the full five-control patch", () => {
    const full = {
      mutedProjectIds: [P1, P2],
      companyEntriesMuted: false,
      taskRemindersMuted: false,
      hidePreviewContent: true,
      quietHours: { startMinuteOfDay: 1200, endMinuteOfDay: 360 },
    };
    expect(Schema.decodeUnknownSync(changePreferences.input)(full)).toEqual(full);
  });

  it("rejects out-of-bounds or fractional quiet-hour bounds", () => {
    expect(() =>
      Schema.decodeUnknownSync(changePreferences.input)({
        quietHours: { startMinuteOfDay: 1440, endMinuteOfDay: 360 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(changePreferences.input)({
        quietHours: { startMinuteOfDay: -1, endMinuteOfDay: 360 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(changePreferences.input)({
        quietHours: { startMinuteOfDay: 1.5, endMinuteOfDay: 360 },
      }),
    ).toThrow();
  });

  it("rejects malformed mute lists", () => {
    expect(() => Schema.decodeUnknownSync(changePreferences.input)({ mutedProjectIds: [42] })).toThrow();
    expect(() => Schema.decodeUnknownSync(changePreferences.input)({ mutedProjectIds: "p1" })).toThrow();
  });

  it("declares exactly the closed error kinds F1 can surface", () => {
    expect([...changePreferences.errorKinds].sort()).toEqual(["forbidden", "validation"]);
  });
});

describe("notification eligibility consumes the D1 identities verbatim", () => {
  it("feeds the row's sourceId into the read-state projection", () => {
    const entries = projectReadState(
      [row.sourceId],
      [{ sourceId: row.sourceId, read: true, readAtMs: 1 }],
    );
    expect(entries).toEqual([{ sourceId: row.sourceId, read: true, readAtMs: 1 }]);
  });

  it("feeds the row's sourceId into the mark-read contract input", () => {
    expect(
      Schema.decodeUnknownSync(markSourceRead.input)({ sourceId: row.sourceId, read: true }),
    ).toEqual({ sourceId: row.sourceId, read: true });
  });

  it("feeds the row's projectIds into the eligibility decision (mixed-project mute)", () => {
    const decision = decidePersonalDelivery({
      kind: "source_entry",
      scope: "project",
      projectIds: row.projectIds,
      isAuthor: false,
      read: false,
      nowMs: Date.parse("2026-09-09T10:00:00.000Z"),
      companyTimezone: row.sentAtTimezone,
      settings: {
        mutedProjectIds: [P2],
        companyEntriesMuted: false,
        taskRemindersMuted: false,
        hidePreviewContent: false,
        quietHours: null,
      },
    });
    expect(decision).toEqual({ decision: "suppressed", reason: "muted_project" });
  });

  it("feeds the row's author identity through the event payload vocabulary", () => {
    // The canonical event carries the same branded user/source identities
    // the resolution chain and D1 rows produce - no translation layer.
    const payload = Schema.decodeUnknownSync(
      attentionEvents["attention.sourceReadChanged"].payload,
    )({ userId: parseTableId("users", AUTHOR_ID), sourceId: row.sourceId, read: true });
    expect(payload.read).toBe(true);
    expect(payload.userId).toBe(AUTHOR_ID);
    expect(payload.sourceId).toBe(row.sourceId);
  });
});
