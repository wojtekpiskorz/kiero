/**
 * The multimodal decoded-call reducer (E4): validation and accumulation of
 * a JOINED agent plan — decoded, never executed.
 *
 * This composes E3's pure planning surface (scope equality, quote
 * location, server-side value anchoring, correction discipline) with the
 * joined evidence families of ./grounding: text quotes over the author
 * text, transcript quotes over D6's completed segments (original-time
 * interval anchors) and observation handles from COMPLETED vision
 * extractions (image-region anchors). The validation rules are E3's,
 * carried over modality by modality; what differs is the evidence
 * admission: a proposal may ground in ANY inspectable part, and the parts
 * the run did not inspect offer NOTHING to ground in (there are no
 * observation handles for pending images, no segment text for incomplete
 * transcripts) — the structural form of "text-only fallback cannot claim to
 * have inspected a pending image".
 */

import { Schema } from "effect";
import { FindingValue, type FindingValue as FindingValueType } from "@kiero/contracts";
import {
  MAX_CLARIFICATIONS,
  MAX_PROPOSALS,
} from "../planning/versions";
import {
  findContextFinding,
  findContextProject,
  sameScope,
  type AnalysisContext,
  type ContextScope,
} from "../planning/context";
import { locateQuote } from "../planning/quotes";
import { buildMoneyValue, buildTemporalValue } from "../planning/values";
import {
  ASK_CLARIFICATION_TOOL,
  IDENTIFY_PROJECT_TOOL,
  UPSERT_FINDING_TOOL,
  normalizeStringlyNull,
  type AskClarificationArgs,
  type IdentifyProjectArgs,
} from "../planning/tools";
import type { JoinUpsertFindingArgs } from "./tools";
import type { ProjectBinding } from "../planning/reducer";
import {
  locateTranscriptQuote,
  resolveObservationReference,
  type LocatedEvidence,
  type TranscriptSegmentView,
} from "./grounding";
import type { JoinVisionObservation } from "./vision";
import type { JoinedCoverageSnapshot } from "./coverage";

/** The joined context: E3's analysis context plus the joined media parts. */
export interface JoinAnalysisContext {
  readonly base: AnalysisContext;
  readonly coverage: JoinedCoverageSnapshot;
  /** Assembled segments of every COMPLETED transcript order (bounded). */
  readonly transcriptSegments: readonly TranscriptSegmentView[];
  /** Observations of every COMPLETED vision extraction (bounded). */
  readonly visionObservations: readonly JoinVisionObservation[];
}

/** One validated multimodal finding proposal in wire form (journal-safe). */
export interface MultimodalFindingProposal {
  readonly intent: "record" | "correct";
  readonly semanticKey: string;
  readonly scope: ContextScope;
  /** Encoded (wire) FindingValue: journal-safe, re-decoded at publish. */
  readonly valueWire: unknown;
  readonly knowledgeStateWire: "known";
  /** Mixed-family located evidence: text ranges, audio intervals, image regions. */
  readonly evidence: readonly LocatedEvidence[];
  readonly replacesFindingId: string | null;
  readonly derivesFromFindingIds: readonly string[];
  readonly readConfidence: number;
}

/** One clarification to raise, with mixed-family evidence. */
export interface MultimodalClarificationDraft {
  readonly question: string;
  readonly evidence: readonly LocatedEvidence[];
  readonly scope: ContextScope;
}

/** The accumulated joined plan state (wire-shaped, journal-safe). */
export interface MultimodalPlanningState {
  readonly proposals: readonly MultimodalFindingProposal[];
  readonly projectBindings: readonly ProjectBinding[];
  readonly clarifications: readonly MultimodalClarificationDraft[];
}

/** The empty joined plan state. */
export function emptyMultimodalState(): MultimodalPlanningState {
  return { proposals: [], projectBindings: [], clarifications: [] };
}

/** One decoded tool call as the reducer consumes it. */
export interface DecodedJoinCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** The reducer's answer for one call: the next state plus a tool result. */
export interface JoinReducerOutcome {
  readonly state: MultimodalPlanningState;
  /** The Polish tool-result text shown to the model for this call. */
  readonly toolResult: string;
}

function reject(state: MultimodalPlanningState, message: string): JoinReducerOutcome {
  return { state, toolResult: `ODRZUCONO: ${message}` };
}

function scopeOf(
  context: AnalysisContext,
  scopeKind: "company" | "project",
  projectId: string | null,
  bindings: readonly ProjectBinding[],
): { ok: true; scope: ContextScope; label: string } | { ok: false; reason: string } {
  if (scopeKind === "company") {
    if (projectId !== null) {
      return { ok: false, reason: "zakres firmy (company) nie przyjmuje projectId" };
    }
    return { ok: true, scope: { kind: "company" }, label: "pamięć firmy" };
  }
  if (projectId === null) {
    return { ok: false, reason: "zakres projektu wymaga projectId (kontekst lub uchwyt new:N)" };
  }
  if (projectId.startsWith("new:")) {
    const binding = bindings.find((candidate) => candidate.handle === projectId);
    if (binding === undefined) {
      return { ok: false, reason: `nieznany uchwyt projektu ${projectId}` };
    }
    return { ok: true, scope: { kind: "project", projectId }, label: binding.displayName ?? projectId };
  }
  const project = findContextProject(context, projectId);
  if (project === undefined) {
    return {
      ok: false,
      reason: "projectId nie wskazuje projektu tej firmy z kontekstu (nieznany lub spoza firmy)",
    };
  }
  return { ok: true, scope: { kind: "project", projectId }, label: project.displayName };
}

function encodeFindingValue(value: FindingValueType): unknown {
  return Schema.encodeSync(FindingValue)(value);
}

/** Locates the model's evidence across every inspectable family (pure). */
function locateJoinEvidence(
  context: JoinAnalysisContext,
  quotes: readonly string[],
  transcriptQuotes: readonly string[],
  imageObservationIds: readonly string[],
): { located: LocatedEvidence[]; droppedText: string[]; refusals: string[] } {
  const located: LocatedEvidence[] = [];
  const droppedText: string[] = [];
  const refusals: string[] = [];
  const textExtractionId =
    context.coverage.inputs.find((input) => input.kind === "text")?.extractionId ?? null;
  for (const quote of quotes) {
    const location = locateQuote(context.base.source.authorText, quote);
    if (location.located && textExtractionId !== null) {
      located.push({
        _tag: "text_range",
        quote,
        startOffset: location.startOffset,
        endOffset: location.endOffset,
        extractionId: textExtractionId,
      });
    } else {
      droppedText.push(quote);
    }
  }
  for (const quote of transcriptQuotes) {
    const location = locateTranscriptQuote(context.transcriptSegments, quote);
    if (location.located) {
      located.push({
        _tag: "audio_interval",
        quote,
        startMs: location.startMs,
        endMs: location.endMs,
        extractionId: location.extractionId,
      });
    } else {
      refusals.push(`fragment transkrypcji nie występuje dosłownie: „${quote.slice(0, 80)}”`);
    }
  }
  for (const observationId of imageObservationIds) {
    const resolution = resolveObservationReference(context.visionObservations, observationId);
    if (resolution.resolved) {
      const observation = resolution.observation;
      located.push({
        _tag: "image_region",
        observationId: observation.observationId,
        region: observation.region,
        representationId: observation.representationId,
        extractionId: observation.extractionId,
      });
    } else {
      refusals.push(
        resolution.reason === "malformed_id"
          ? `uchwyt obs niepoprawny: ${observationId}`
          : `uchwyt obs nie wskazuje odczytu z tej analizy: ${observationId}`,
      );
    }
  }
  return { located, droppedText, refusals };
}

/** Applies one decoded `memory_upsert_finding` call with joined evidence. */
function applyUpsertJoin(
  state: MultimodalPlanningState,
  context: JoinAnalysisContext,
  rawArgs: JoinUpsertFindingArgs,
  companyDefaultCurrency: string,
): JoinReducerOutcome {
  const args: JoinUpsertFindingArgs = {
    ...rawArgs,
    projectId: normalizeStringlyNull(rawArgs.projectId),
    replacesFindingId: normalizeStringlyNull(rawArgs.replacesFindingId),
    transcriptQuotes: rawArgs.transcriptQuotes ?? [],
    imageObservationIds: rawArgs.imageObservationIds ?? [],
  };
  if (state.proposals.length >= MAX_PROPOSALS) {
    return reject(state, `plan osiągnął limit ${MAX_PROPOSALS} propozycji`);
  }
  const scope = scopeOf(context.base, args.scopeKind, args.projectId, state.projectBindings);
  if (!scope.ok) {
    return reject(state, scope.reason);
  }
  const duplicateInPlan = state.proposals.some(
    (p) => p.semanticKey === args.semanticKey && sameScope(p.scope, scope.scope),
  );
  if (duplicateInPlan) {
    return reject(state, `propozycja dla ${args.semanticKey} w tym zakresie już istnieje w planie`);
  }

  const grounding = locateJoinEvidence(
    context,
    args.quotes,
    args.transcriptQuotes,
    args.imageObservationIds,
  );
  if (grounding.refusals.length > 0) {
    // A hallucinated observation handle or a transcript quote that does not
    // exist verbatim: the WHOLE call is refused, never partially admitted.
    return reject(state, grounding.refusals[0] ?? "dowód nieodnaleziony");
  }
  if (grounding.located.length === 0 && args.derivesFromFindingIds.length === 0) {
    return reject(
      state,
      "żaden cytat nie występuje dosłownie w wiadomości ani transkrypcji, brak uchwytu zdjęcia i podstawy wnioskowej — popraw dowody",
    );
  }

  // Value construction (server-side anchoring, E3's rules; the tax-basis
  // quote may now come from any evidence family).
  let valueWire: unknown;
  switch (args.value._tag) {
    case "temporal": {
      const built = buildTemporalValue(
        args.value.temporal,
        context.base.source.sentAtMs,
        context.base.source.sentAtTimezone,
      );
      if (!built.built) {
        if (built.reason === "relative_unresolvable") {
          return reject(
            state,
            "wyrażenie daty nierozpoznane — użyj jawnej daty z treści (basis {day}) tylko gdy jest dosłownie podana, w przeciwnym razie memory_ask_clarification",
          );
        }
        if (built.reason === "relative_day_disagrees") {
          return reject(
            state,
            `data sprzeczna z wyliczeniem serwera (serwer: ${built.serverDay}); podaj wyłącznie expression lub zgodną datę`,
          );
        }
        return reject(state, "niepoprawna data/czas ze strefą");
      }
      valueWire = encodeFindingValue({ _tag: "temporal", temporal: built.value });
      break;
    }
    case "money": {
      const firstQuote =
        grounding.located.find((evidence) => evidence._tag !== "image_region") ??
        grounding.located[0];
      const quoteText =
        firstQuote === undefined
          ? ""
          : firstQuote._tag === "image_region"
            ? (context.visionObservations.find((o) => o.observationId === firstQuote.observationId)?.text ?? "")
            : firstQuote.quote;
      const built = buildMoneyValue(args.value.money, quoteText, companyDefaultCurrency);
      if (!built.built) {
        if (built.reason === "tax_basis_not_stated") {
          return reject(
            state,
            "podstawa netto/brutto niezapisana w dowodzie — użyj taxBasis=not_specified",
          );
        }
        return reject(state, "kwota nie przechodzi schematu (zakres/deszyfrowanie)");
      }
      valueWire = encodeFindingValue({ _tag: "money", money: built.value });
      break;
    }
    case "text_note": {
      valueWire = encodeFindingValue({ _tag: "text_note", text: args.value.text });
      break;
    }
  }

  // Correction discipline (E3's rules, unchanged in the joined world).
  const existing = findContextFinding(context.base, scope.scope, args.semanticKey);
  if (args.intent === "correct") {
    if (args.replacesFindingId === null) {
      return reject(state, "intent=correct wymaga replacesFindingId z kontekstu");
    }
    const target = context.base.findings.find((f) => f.findingId === args.replacesFindingId);
    if (target === undefined) {
      return reject(state, "replacesFindingId nie wskazuje ustalenia z kontekstu tej firmy");
    }
    if (target.semanticKey !== args.semanticKey || !sameScope(target.scope, scope.scope)) {
      return reject(
        state,
        "korekta nie może zmieniać znaczenia ani zakresu ustalenia — dopasuj semanticKey i scope",
      );
    }
    if (
      target.currentProvenanceSourceId !== null &&
      target.currentProvenanceSourceId !== context.base.source.sourceId &&
      target.currentProvenanceSourceSentAtMs !== null &&
      target.currentProvenanceSourceSentAtMs > context.base.source.sentAtMs
    ) {
      return reject(
        state,
        "aktualne ustalenie pochodzi z nowszej wiadomości — ponowna analiza starszego źródła nie może jej cofnąć; poprawka wymaga nowej wypowiedzi",
      );
    }
  } else {
    if (args.replacesFindingId !== null) {
      return reject(state, "intent=record tworzy nowe ustalenie — nie podawaj replacesFindingId");
    }
    if (existing !== undefined) {
      return reject(
        state,
        `ustalenie ${args.semanticKey} już istnieje w tym zakresie — użyj intent=correct z replacesFindingId`,
      );
    }
  }

  for (const basisId of args.derivesFromFindingIds) {
    if (basisId === args.replacesFindingId) {
      return reject(state, "wniosek nie może wywodzić się z samego siebie");
    }
    const basis = context.base.findings.find((f) => f.findingId === basisId);
    if (basis === undefined) {
      return reject(state, `podstawa wniosku ${basisId} nie jest ustaleniem z kontekstu`);
    }
  }

  const proposal: MultimodalFindingProposal = {
    intent: args.intent,
    semanticKey: args.semanticKey,
    scope: scope.scope,
    valueWire,
    knowledgeStateWire: "known",
    evidence: grounding.located,
    replacesFindingId: args.replacesFindingId,
    derivesFromFindingIds: [...args.derivesFromFindingIds],
    readConfidence: args.readConfidence,
  };
  const note =
    grounding.droppedText.length > 0
      ? ` (pominięto ${grounding.droppedText.length} cytatu/ów nieznajdujących się dosłownie w wiadomości)`
      : "";
  return {
    state: { ...state, proposals: [...state.proposals, proposal] },
    toolResult: `ZAPROPONOWANO ${args.semanticKey} w ${scope.label}${note}.`,
  };
}

/** Applies one decoded `projects_identify` call (E3's rules). */
function applyIdentifyJoin(
  state: MultimodalPlanningState,
  context: AnalysisContext,
  rawArgs: IdentifyProjectArgs,
): JoinReducerOutcome {
  const args: IdentifyProjectArgs = {
    projectId: normalizeStringlyNull(rawArgs.projectId),
    displayName: normalizeStringlyNull(rawArgs.displayName),
  };
  if (args.projectId !== null && args.displayName !== null) {
    return reject(state, "podaj albo projectId, albo displayName — nie oba");
  }
  if (args.projectId === null && args.displayName === null) {
    return reject(state, "projectId i displayName nie mogą być oba puste");
  }
  if (args.projectId !== null) {
    const project = findContextProject(context, args.projectId);
    if (project === undefined) {
      return reject(state, "projectId nie wskazuje projektu tej firmy z kontekstu");
    }
    if (state.projectBindings.some((b) => b.existingProjectId === args.projectId)) {
      return { state, toolResult: `Projekt ${project.displayName} już związany z tym uruchomieniem.` };
    }
    return {
      state: {
        ...state,
        projectBindings: [
          ...state.projectBindings,
          { handle: args.projectId, displayName: project.displayName, existingProjectId: args.projectId },
        ],
      },
      toolResult: `Projekt ${project.displayName} przywiązany do wypowiedzi.`,
    };
  }
  const displayName = (args.displayName ?? "").trim();
  if (displayName.length === 0 || displayName.length > 80) {
    return reject(state, "displayName musi mieć 1-80 znaków");
  }
  const handle = `new:${state.projectBindings.length + 1}`;
  return {
    state: {
      ...state,
      projectBindings: [...state.projectBindings, { handle, displayName, existingProjectId: null }],
    },
    toolResult: `Nowy projekt „${displayName}” zostanie utworzony; używaj projectId=${handle} w memory_upsert_finding.`,
  };
}

/** Applies one decoded `memory_ask_clarification` call with joined evidence. */
function applyClarificationJoin(
  state: MultimodalPlanningState,
  context: JoinAnalysisContext,
  rawArgs: AskClarificationArgs,
): JoinReducerOutcome {
  const args: AskClarificationArgs = {
    ...rawArgs,
    projectId: normalizeStringlyNull(rawArgs.projectId),
  };
  if (state.clarifications.length >= MAX_CLARIFICATIONS) {
    return reject(state, `limit ${MAX_CLARIFICATIONS} spraw do wyjaśnienia w jednym uruchomieniu`);
  }
  const scope = scopeOf(context.base, args.scopeKind, args.projectId, state.projectBindings);
  if (!scope.ok) {
    return reject(state, scope.reason);
  }
  if (args.projectId !== null && args.projectId.startsWith("new:")) {
    return reject(
      state,
      "sprawa do wyjaśnienia wymaga istniejącego projektu z kontekstu albo zakresu firmy",
    );
  }
  // A conflict may live across modalities (the typed text vs the recording):
  // quotes locate over the author text first, then the transcript.
  const grounding = locateJoinEvidence(context, args.quotes, [], []);
  if (grounding.located.length === 0) {
    const acrossModalities = locateJoinEvidence(context, [], args.quotes, []);
    if (acrossModalities.located.length === 0) {
      return reject(
        state,
        "sprawa do wyjaśnienia wymaga co najmniej jednego dosłownego cytatu z tej wiadomości lub jej transkrypcji",
      );
    }
  }
  return {
    state: {
      ...state,
      clarifications: [
        ...state.clarifications,
        { question: args.question, evidence: grounding.located, scope: scope.scope },
      ],
    },
    toolResult: "SPRAWA DO WYJAŚNIENIA zapisana w planie; nie zapisuj wartości dla tej informacji.",
  };
}

/**
 * Applies one decoded tool call to the joined plan state. Arguments must
 * already be DECODED against the join schemas; deeper context validation
 * refuses with a Polish tool result the model can act on.
 */
export function applyMultimodalCall(
  state: MultimodalPlanningState,
  context: JoinAnalysisContext,
  call: DecodedJoinCall,
  companyDefaultCurrency: string,
): JoinReducerOutcome {
  switch (call.name) {
    case UPSERT_FINDING_TOOL: {
      const args = call.arguments as JoinUpsertFindingArgs;
      return applyUpsertJoin(state, context, args, companyDefaultCurrency);
    }
    case IDENTIFY_PROJECT_TOOL: {
      const args = call.arguments as IdentifyProjectArgs;
      return applyIdentifyJoin(state, context.base, args);
    }
    case ASK_CLARIFICATION_TOOL: {
      const args = call.arguments as AskClarificationArgs;
      return applyClarificationJoin(state, context, args);
    }
    default:
      return reject(state, `nieznane narzędzie ${call.name}`);
  }
}
