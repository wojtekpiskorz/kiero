/**
 * R5 focused tests (issue #130): the canonical source-reference route
 * contract and every consumer that renders a source link.
 *
 * One serializer/parser (`apps/web/src/features/source-detail/source-route`)
 * is the single authority for the stable form `/zrodlo?zrodlo=<encoded-id>`
 * with an optional `fragment` (the matched anchor) and an optional `projekt`
 * (navigation context only — never an access input; the dossier's own
 * backend reads stay the authority on tenancy and lifecycle).
 *
 * This suite pins:
 *
 * - the round trip: `parse(serialize(x))` recovers `x` for every shape
 *   (plain source, fragment, project context, both options);
 * - encoding: id values stay inside the closed URL-safe charset, and
 *   values that could break the path/query/fragment structure of the URL
 *   are refused by the parser instead of being smuggled through;
 * - duplicates: one repeated identical value collapses; CONFLICTING
 *   repeated values are an ambiguous deep link and refuse the whole parse;
 * - the legacy conversation deep link (`/?zrodlo=<id>` on "/"): it either
 *   redirects to the canonical target (keeping fragment identity) or is
 *   reported malformed — never silently opened against the capped feed;
 * - the hand-built-route guard: none of the listed in-app consumers
 *   constructs a user-facing source URL by hand anymore (`/?zrodlo=`,
 *   ad hoc `/zrodlo?zrodlo=` or an ad hoc `fragment=` param).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRAGMENT_PARAM,
  SOURCE_ROUTE_PATH,
  inspectSourceSearch,
  parseSourceReference,
  serializeSourceReference,
  type SourceReference,
} from "../../apps/web/src/features/source-detail/source-route";
import { PROJECT_PARAM, SOURCE_PARAM } from "../../apps/web/src/features/company/route-params";

/** Representative table ids (the wire pattern the reads carry). */
const SOURCE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";
const FRAGMENT_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2g";
const PROJECT_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2p";

/** The listed in-app consumers of source links (R5's acceptance set). */
const CONSUMER_FILES = [
  "apps/web/src/features/conversation/ConversationFeature.ts",
  "apps/web/src/features/memory/MemoryFeature.ts",
  "apps/web/src/features/search/SearchFeature.ts",
  "apps/web/src/features/now/NowFeature.ts",
  "apps/web/src/features/source-detail/SourceDetailFeature.ts",
] as const;

describe("the canonical serializer (one stable form)", () => {
  it("serializes the plain whole-source reference", () => {
    expect(serializeSourceReference({ sourceId: SOURCE_ID, fragmentId: null, projectId: null })).toBe(
      `${SOURCE_ROUTE_PATH}?${SOURCE_PARAM}=${SOURCE_ID}`,
    );
  });

  it("appends the fragment and project context in a fixed order", () => {
    const href = serializeSourceReference({
      sourceId: SOURCE_ID,
      fragmentId: FRAGMENT_ID,
      projectId: PROJECT_ID,
    });
    expect(href).toBe(
      `${SOURCE_ROUTE_PATH}?${SOURCE_PARAM}=${SOURCE_ID}&${FRAGMENT_PARAM}=${FRAGMENT_ID}&${PROJECT_PARAM}=${PROJECT_ID}`,
    );
  });

  it("round-trips every reference shape through the parser", () => {
    const cases: readonly SourceReference[] = [
      { sourceId: SOURCE_ID, fragmentId: null, projectId: null },
      { sourceId: SOURCE_ID, fragmentId: FRAGMENT_ID, projectId: null },
      { sourceId: SOURCE_ID, fragmentId: null, projectId: PROJECT_ID },
      { sourceId: SOURCE_ID, fragmentId: FRAGMENT_ID, projectId: PROJECT_ID },
    ];
    for (const reference of cases) {
      expect(parseSourceReference(serializeSourceReference(reference))).toEqual(reference);
    }
  });
});

describe("the canonical parser (encoding, fragments, context, duplicates)", () => {
  it("parses with or without the leading question mark", () => {
    const expected: SourceReference = { sourceId: SOURCE_ID, fragmentId: null, projectId: null };
    expect(parseSourceReference(`?${SOURCE_PARAM}=${SOURCE_ID}`)).toEqual(expected);
    expect(parseSourceReference(`${SOURCE_PARAM}=${SOURCE_ID}`)).toEqual(expected);
  });

  it("keeps fragment identity and navigation context", () => {
    expect(
      parseSourceReference(`?${SOURCE_PARAM}=${SOURCE_ID}&${FRAGMENT_PARAM}=${FRAGMENT_ID}&${PROJECT_PARAM}=${PROJECT_ID}`),
    ).toEqual({ sourceId: SOURCE_ID, fragmentId: FRAGMENT_ID, projectId: PROJECT_ID });
  });

  it("falls back truthfully to the whole source when the fragment is unusable", () => {
    // A fragment that cannot denote an anchor (here: path-breaking content
    // delivered pre-decoded) never refuses the SOURCE: the dossier opens
    // the whole original ("Fragment źródła", CONTEXT.md: gdy nie da się
    // wiarygodnie wskazać fragmentu, podstawą pozostaje cały materiał).
    expect(parseSourceReference(`?${SOURCE_PARAM}=${SOURCE_ID}&${FRAGMENT_PARAM}=%2Foops`)).toEqual({
      sourceId: SOURCE_ID,
      fragmentId: null,
      projectId: null,
    });
    // Navigation context is the same: unusable context is dropped, never a
    // refusal — it grants nothing.
    expect(parseSourceReference(`?${SOURCE_PARAM}=${SOURCE_ID}&${PROJECT_PARAM}=%2Foops`)).toEqual({
      sourceId: SOURCE_ID,
      fragmentId: null,
      projectId: null,
    });
  });

  it("refuses a missing, empty or malformed source id", () => {
    expect(parseSourceReference("")).toBeNull();
    expect(parseSourceReference(`?${PROJECT_PARAM}=${PROJECT_ID}`)).toBeNull();
    expect(parseSourceReference(`?${SOURCE_PARAM}=`)).toBeNull();
    expect(parseSourceReference(`?${SOURCE_PARAM}=%20`)).toBeNull();
    expect(parseSourceReference(`?${SOURCE_PARAM}=not%20an%20id`)).toBeNull();
    // Path/query/fragment-breaking payloads decode before validation.
    expect(parseSourceReference(`?${SOURCE_PARAM}=%2F..%2Fetc`)).toBeNull();
    expect(parseSourceReference(`?${SOURCE_PARAM}=a%3Fb`)).toBeNull();
    expect(parseSourceReference(`?${SOURCE_PARAM}=a%23b`)).toBeNull();
    expect(parseSourceReference(`?${SOURCE_PARAM}=%`)).toBeNull();
    expect(parseSourceReference(`?${SOURCE_PARAM}=${"x".repeat(65)}`)).toBeNull();
  });

  it("collapses one repeated identical value and refuses conflicting duplicates", () => {
    // One value repeated is idempotent…
    expect(parseSourceReference(`?${SOURCE_PARAM}=${SOURCE_ID}&${SOURCE_PARAM}=${SOURCE_ID}`)).toEqual({
      sourceId: SOURCE_ID,
      fragmentId: null,
      projectId: null,
    });
    // …but two DIFFERENT values are an ambiguous deep link: the whole
    // reference refuses, for every known key.
    expect(parseSourceReference(`?${SOURCE_PARAM}=${SOURCE_ID}&${SOURCE_PARAM}=k57other0123456789abcdefghij`)).toBeNull();
    expect(
      parseSourceReference(`?${SOURCE_PARAM}=${SOURCE_ID}&${FRAGMENT_PARAM}=${FRAGMENT_ID}&${FRAGMENT_PARAM}=k57other0123456789abcdefghij`),
    ).toBeNull();
    expect(parseSourceReference(`?${SOURCE_PARAM}=${SOURCE_ID}&${PROJECT_PARAM}=${PROJECT_ID}&${PROJECT_PARAM}=k57other0123456789abcdefghij`)).toBeNull();
  });
});

describe("the legacy conversation deep link redirects or refuses honestly", () => {
  it("reports an absent source param as nothing to do", () => {
    expect(inspectSourceSearch("")).toEqual({ kind: "absent" });
    expect(inspectSourceSearch(`?${PROJECT_PARAM}=${PROJECT_ID}`)).toEqual({ kind: "absent" });
  });

  it("redirects the legacy form to the canonical target, keeping fragment identity", () => {
    const inspection = inspectSourceSearch(
      `?${SOURCE_PARAM}=${SOURCE_ID}&${FRAGMENT_PARAM}=${FRAGMENT_ID}`,
    );
    expect(inspection).toEqual({
      kind: "reference",
      reference: { sourceId: SOURCE_ID, fragmentId: FRAGMENT_ID, projectId: null },
    });
    if (inspection.kind === "reference") {
      // The redirect target IS the canonical serialization: the legacy URL
      // never re-opens against the capped conversation feed.
      expect(serializeSourceReference(inspection.reference)).toBe(
        `${SOURCE_ROUTE_PATH}?${SOURCE_PARAM}=${SOURCE_ID}&${FRAGMENT_PARAM}=${FRAGMENT_ID}`,
      );
    }
  });

  it("reports malformed legacy values instead of redirecting", () => {
    expect(inspectSourceSearch(`?${SOURCE_PARAM}=`)).toEqual({ kind: "malformed" });
    expect(inspectSourceSearch(`?${SOURCE_PARAM}=%2F..%2Fetc`)).toEqual({ kind: "malformed" });
    expect(
      inspectSourceSearch(`?${SOURCE_PARAM}=${SOURCE_ID}&${SOURCE_PARAM}=k57other0123456789abcdefghij`),
    ).toEqual({ kind: "malformed" });
  });
});

describe("no listed consumer hand-builds a source route", () => {
  it("renders source links only through the shared serializer", () => {
    // Hand-built forms this guard must catch: a template or literal
    // `/?zrodlo=` conversation deep link, an ad hoc `/zrodlo?zrodlo=`
    // dossier link, and an ad hoc `fragment=` query append. Every listed
    // consumer must import the serializer instead.
    const handBuilt = [
      new RegExp(`/\\?\\$\\{${SOURCE_PARAM}\\}`), // `/?${SOURCE_PARAM}=`
      new RegExp(`/\\?${SOURCE_PARAM}=`), // "/?zrodlo="
      new RegExp(`/zrodlo\\?\\$\\{${SOURCE_PARAM}\\}`), // `/zrodlo?${SOURCE_PARAM}=`
      new RegExp(`/zrodlo\\?${SOURCE_PARAM}=`), // "/zrodlo?zrodlo="
      new RegExp(`&\\$\\{?${FRAGMENT_PARAM}`), // ad hoc "&fragment=" append
    ];
    const offenders: string[] = [];
    for (const file of CONSUMER_FILES) {
      const source = readFileSync(join(import.meta.dirname, "..", "..", file), "utf8");
      for (const pattern of handBuilt) {
        if (pattern.test(source)) {
          offenders.push(`${file} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports the shared serializer (the one authority each consumer uses)", () => {
    const missing: string[] = [];
    for (const file of CONSUMER_FILES) {
      const source = readFileSync(join(import.meta.dirname, "..", "..", file), "utf8");
      if (!source.includes("source-route")) {
        missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });
});
