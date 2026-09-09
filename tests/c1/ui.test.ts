/**
 * C1 focused verification: the barebones project-catalog feature surface.
 *
 * The host entry for `/projekty` stays PENDING by design (mounting is the
 * A4 host lane's edit); what this pins is the feature surface the host will
 * mount: the Polish vocabularies rendered from the single domain source,
 * the copy completeness, and the failure hints for the load-bearing codes.
 * Node-safe: state-only imports, no React tree.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ProjectStage } from "@kiero/contracts";
import { PROJECT_STAGE_LABELS } from "../../packages/domain/projects/index";
import {
  catalogCopy,
  contactKindLabels,
  contactRoleLabels,
  failureHint,
  stageLabels,
  stageOrder,
} from "../../apps/web/src/features/project-catalog/state";

const CONTRACT_STAGES = [
  "inquiry",
  "offer_preparation",
  "awaiting_decision",
  "agreed",
  "in_progress",
  "completed",
  "cancelled",
] as const;

describe("the project-catalog feature vocabulary", () => {
  it("renders exactly the contract stage vocabulary, in Polish", () => {
    // Every contract stage token encodes, renders and appears in the order
    // list; nothing outside the vocabulary does.
    for (const token of CONTRACT_STAGES) {
      expect(() => Schema.decodeUnknownSync(ProjectStage)(token)).not.toThrow();
      expect(stageLabels[token as keyof typeof stageLabels]).toBeTypeOf("string");
    }
    expect(() => Schema.decodeUnknownSync(ProjectStage)("paused")).toThrow();
    expect(Object.keys(stageLabels).sort()).toEqual([...CONTRACT_STAGES].sort());
    expect(stageLabels).toEqual(PROJECT_STAGE_LABELS);
    expect(stageOrder).toEqual(CONTRACT_STAGES);
  });

  it("renders contact kinds and roles in Polish", () => {
    expect(contactKindLabels).toEqual({ person: "Osoba", organization: "Organizacja" });
    expect(contactRoleLabels).toEqual({
      client: "Klient",
      executor: "Wykonawca",
      supplier: "Dostawca",
    });
  });

  it("carries honest copy for the closed-list and pause semantics", () => {
    expect(catalogCopy.closedNote).toContain("zachowają aliasy");
    expect(catalogCopy.pauseIntro).toContain("Nie zmienia etapu");
    expect(catalogCopy.codenameIntro).toContain("zarezerwowany na zawsze");
    expect(catalogCopy.stageIntro).toContain("Cisza");
  });

  it("hints the load-bearing machine codes", () => {
    for (const code of [
      "codename_reserved",
      "codename_generated_namespace",
      "project_closed",
      "revision_mismatch",
    ]) {
      expect(failureHint(code), code).toMatch(/.+/u);
    }
    expect(failureHint("never_seen_code")).toBeNull();
    expect(failureHint(undefined)).toBeNull();
  });
});
