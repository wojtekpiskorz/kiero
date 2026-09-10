/**
 * J1 focused tests, deterministic half: the mounted conversation entry (the
 * registration/consumer seam), the core-text state renderers (encoded wire
 * values to honest Polish), and the send envelope shape the surface issues.
 *
 * The identity repairs (C2's public memory entries, D1's public accept and
 * read entries) cross the real Convex resolution chain; they are proved
 * LIVE with real user tokens in ./live-proof.mjs, per the repo rule that a
 * test mirroring helpers cannot discharge an integration proof.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { sourcesOperations } from "@kiero/contracts";
import { PrepareInput } from "../../convex/sources/uploads/protocol";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { resolveFeatureScreen } from "../../apps/web/src/app/feature-pending";
import { AppServicesProvider } from "../../apps/web/src/app/providers";
import { loadAppConfig } from "../../apps/web/src/app/config";
import { textConversationFeatureEntry } from "../../apps/web/src/composition/text";
import {
  findingValueLabel,
  knowledgeStateLabel,
  processingStateLabels,
} from "../../apps/web/src/features/core-text/state";

/** A representative uploads id (the table-id wire pattern). */
const TEMPLATE_UPLOAD_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";

describe("the text composition mount (J1's sanctioned conversation entry)", () => {
  it("builds the mounted default-route entry through the composition seam", () => {
    const entry = textConversationFeatureEntry();
    expect(entry.featureId).toBe("conversation.company");
    expect(entry.routePath).toBe("/");
    expect(entry.implementation).toBe("mounted");
    if (entry.implementation === "mounted") {
      expect(entry.screen).toBeTypeOf("function");
    }
  });

  it("declares exactly the send operations the surface commands", () => {
    expect([...textConversationFeatureEntry().consumedOperations].sort()).toEqual([
      "sources.acceptSource",
      "sources.prepareUpload",
    ]);
  });

  it("is the entry the shipped host composes at the default route", () => {
    const conversation = appFeatures[0];
    expect(conversation?.featureId).toBe("conversation.company");
    expect(conversation?.implementation).toBe("mounted");
    expect(conversation?.routePath).toBe("/");
  });

  it("renders the honest disconnected state through the host screen dispatch", () => {
    const conversation = appFeatures[0];
    if (conversation === undefined || conversation.implementation !== "mounted") {
      throw new Error("conversation entry missing or not mounted");
    }
    const html = renderToString(
      createElement(AppServicesProvider, {
        services: { config: loadAppConfig({}) },
        children: createElement(resolveFeatureScreen(conversation)),
      }),
    );
    expect(html).toContain("Rozmowa firmy");
    expect(html).toContain("VITE_CONVEX_URL");
    // No faked entries: the disconnected gate shows no conversation rows.
    expect(html).not.toContain("<li>");
  });
});

describe("the core-text renderers stay honest about precision", () => {
  it("renders a resolved day with its role and the original words", () => {
    expect(
      findingValueLabel({
        _tag: "temporal",
        temporal: {
          shape: { _tag: "day", day: "2026-09-09" },
          originalExpression: "w środę",
          role: "agreed",
        },
      }),
    ).toBe("2026-09-09 (uzgodnione; powiedziano: „w środę”)");
  });

  it("never invents a day for month/year precision", () => {
    expect(
      findingValueLabel({
        _tag: "temporal",
        temporal: {
          shape: { _tag: "month", month: "2026-09" },
          originalExpression: "wrzesień",
          role: "proposed",
        },
      }),
    ).toContain("2026-09 (do danego miesiąca)");
  });

  it("renders an exact money amount with visible tax basis and certainty", () => {
    expect(
      findingValueLabel({
        _tag: "money",
        money: {
          role: "price_proposal",
          amount: { _tag: "exact", value: "10000" },
          currency: "PLN",
          currencyOrigin: "company_default",
          taxBasis: "not_specified",
          certainty: "estimate",
        },
      }),
    ).toBe("wycena: 10000 PLN, podatek nieokreślony, kwota szacunkowa");
  });

  it("renders a money range with open bounds explicit", () => {
    const label = findingValueLabel({
      _tag: "money",
      money: {
        role: "agreed_price",
        amount: { _tag: "range", min: "9000", max: null },
        currency: "PLN",
        currencyOrigin: "stated",
        taxBasis: "net",
        certainty: "exact",
      },
    });
    expect(label).toContain("od 9000 do … PLN");
    expect(label).toContain("netto");
  });

  it("renders text notes verbatim and unknown shapes honestly", () => {
    expect(findingValueLabel({ _tag: "text_note", text: "serwis drukarki" })).toBe(
      "serwis drukarki",
    );
    expect(findingValueLabel({ _tag: "mystery" })).toBe("wartość nieznanej postaci");
  });

  it("renders knowledge states with the conflict visible", () => {
    expect(knowledgeStateLabel({ _tag: "known" })).toBe("ustalone");
    expect(knowledgeStateLabel({ _tag: "conflicted" })).toContain("sprzeczne");
    expect(knowledgeStateLabel({ _tag: "unknown", reason: "brak potwierdzenia" })).toContain(
      "brak potwierdzenia",
    );
  });
});

describe("the derived processing-state vocabulary (the honest watch)", () => {
  it("covers exactly the states the conversation view can derive", () => {
    expect(Object.keys(processingStateLabels).sort()).toEqual([
      "accepted",
      "failed",
      "partial",
      "processed",
      "processing",
    ]);
  });
});

describe("the send commands accept exactly what the surface issues", () => {
  it("decodes the text-only prepare shape (one part, no media kinds)", () => {
    const decoded = Schema.decodeUnknownSync(sourcesOperations["sources.prepareUpload"].input)({
      draftId: "0c2d5f1e-1f6f-4f9e-8a3b-2c7d9e0a1b2c",
      parts: 1,
      mediaKinds: [],
    });
    expect(decoded.mediaKinds).toEqual([]);
  });

  it("decodes the text-only prepare shape through the uploads ledger too (the J1 repair)", () => {
    // The ledger's stricter input once demanded at least one media kind,
    // which made the public prepare command unusable for text-only sources.
    const decoded = Schema.decodeUnknownSync(PrepareInput)({
      draftId: "0c2d5f1e-1f6f-4f9e-8a3b-2c7d9e0a1b2c",
      parts: 1,
      mediaKinds: [],
    });
    expect(decoded.mediaKinds).toEqual([]);
    expect(() =>
      Schema.decodeUnknownSync(PrepareInput)({
        draftId: "x",
        parts: 0,
        mediaKinds: [],
      }),
    ).toThrow();
  });

  it("formats idempotency keys in the certified idem_ + uuid shape", async () => {
    // The command envelope's idempotency-key schema accepts exactly this
    // pattern; a bare UUID (the first draft) is rejected live.
    const { IdempotencyKeySchema } = await import("@kiero/contracts");
    const uuid = "3f2a9c1e-7b4d-4e8f-9a2b-6c1d8e0f4a5b";
    expect(() => Schema.decodeUnknownSync(IdempotencyKeySchema)(`idem_${uuid}`)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(IdempotencyKeySchema)(uuid)).toThrow();
    expect(() => Schema.decodeUnknownSync(IdempotencyKeySchema)(`j1_a_${uuid}`)).toThrow();
  });

  it("decodes the acceptance input the surface builds and rejects an empty zone", () => {
    const decoded = Schema.decodeUnknownSync(sourcesOperations["sources.acceptSource"].input)({
      uploadId: TEMPLATE_UPLOAD_ID,
      authorText: "Projekt Banan: dowóz płytek w środę rano.",
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    });
    expect(decoded.authorText).toContain("Banan");
    expect(() =>
      Schema.decodeUnknownSync(sourcesOperations["sources.acceptSource"].input)({
        uploadId: TEMPLATE_UPLOAD_ID,
        authorText: "x",
        timezoneSnapshot: "",
        projectHints: [],
      }),
    ).toThrow();
  });
});
