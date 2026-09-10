/**
 * The decoded-tool-call reducer (E3): validation and accumulation of an
 * agent plan — decoded, never executed.
 *
 * E2's chat adapter hands each tool call back with its arguments DECODED
 * against the declared schema; this reducer then validates the decoded
 * arguments against the analysis context (the tenant-filtered truth) and
 * accumulates them into a serializable plan state. Nothing here writes, and
 * nothing here trusts: a wrong project id, a hallucinated quote, an
 * unstated tax basis, a self-derivation or a retargeted correction is
 * refused with a Polish tool-result message the model can act on. The
 * EXECUTION of what survives happens later, in one checked transaction per
 * publication group, through C2's `prepareChangeSet`/`publishChangeSet`.
 *
 * The accumulated state is WIRE-shaped on purpose (encoded FindingValue,
 * plain strings/numbers): it crosses the workflow journal between the model
 * stage and the publish stage, so it must stay Convex-serializable.
 */

import { Schema } from "effect";
import { FindingValue, type FindingValue as FindingValueType } from "@kiero/contracts";
import {
  MAX_CLARIFICATIONS,
  MAX_PROPOSALS,
} from "./versions";
import {
  findContextFinding,
  findContextProject,
  type AnalysisContext,
  type ContextScope,
} from "./context";
import { locateQuote } from "./quotes";
import { buildMoneyValue, buildTemporalValue } from "./values";
import type {
  AskClarificationArgs,
  IdentifyProjectArgs,
  UpsertFindingArgs,
} from "./tools";
import {
  ASK_CLARIFICATION_TOOL,
  IDENTIFY_PROJECT_TOOL,
  UPSERT_FINDING_TOOL,
  normalizeStringlyNull,
} from "./tools";

/** One located evidence quote with its resolved text range. */
export interface LocatedQuote {
  readonly quote: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** One validated finding proposal in wire form (journal-safe). */
export interface FindingProposal {
  readonly intent: "record" | "correct";
  readonly semanticKey: string;
  readonly scope: ContextScope;
  /** Encoded (wire) FindingValue: journal-safe, re-decoded at publish. */
  readonly valueWire: unknown;
  readonly knowledgeStateWire: "known";
  readonly evidence: readonly LocatedQuote[];
  /** Null = create; otherwise must address a live context finding. */
  readonly replacesFindingId: string | null;
  readonly derivesFromFindingIds: readonly string[];
  readonly readConfidence: number;
}

/** One project binding made during the run (existing or to-be-created). */
export interface ProjectBinding {
  /** `new:N` handle for a to-be-created project, or the real project id. */
  readonly handle: string;
  readonly displayName: string | null;
  readonly existingProjectId: string | null;
}

/** One clarification to raise (Sprawa do wyjaśnienia, source-backed). */
export interface ClarificationDraft {
  readonly question: string;
  readonly quotes: readonly LocatedQuote[];
  readonly scope: ContextScope;
}

/** The accumulated plan state (wire-shaped, journal-safe). */
export interface PlanningState {
  readonly proposals: readonly FindingProposal[];
  readonly projectBindings: readonly ProjectBinding[];
  readonly clarifications: readonly ClarificationDraft[];
}

/** The empty plan state. */
export function emptyPlanningState(): PlanningState {
  return { proposals: [], projectBindings: [], clarifications: [] };
}

/** One decoded tool call as the reducer consumes it. */
export interface DecodedPlanningCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** The reducer's answer for one call: the next state plus a tool result. */
export interface ReducerOutcome {
  readonly state: PlanningState;
  /** The Polish tool-result text shown to the model for this call. */
  readonly toolResult: string;
}

function reject(state: PlanningState, message: string): ReducerOutcome {
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
      return { ok: false, reason: "zakaz firmy (company) nie przyjmuje projectId" };
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
  return {
    ok: true,
    scope: { kind: "project", projectId },
    label: project.displayName,
  };
}

/** Locates every quote; keeps located ones, reports dropped ones. */
function locateEvidence(
  sourceText: string,
  quotes: readonly string[],
): { located: LocatedQuote[]; dropped: string[] } {
  const located: LocatedQuote[] = [];
  const dropped: string[] = [];
  for (const quote of quotes) {
    const location = locateQuote(sourceText, quote);
    if (location.located) {
      located.push({
        quote,
        startOffset: location.startOffset,
        endOffset: location.endOffset,
      });
    } else {
      dropped.push(quote);
    }
  }
  return { located, dropped };
}

function encodeFindingValue(value: FindingValueType): unknown {
  return Schema.encodeSync(FindingValue)(value);
}

/** Applies one decoded `memory_upsert_finding` call. */
function applyUpsert(
  state: PlanningState,
  context: AnalysisContext,
  rawArgs: UpsertFindingArgs,
  companyDefaultCurrency: string,
): ReducerOutcome {
  const args: UpsertFindingArgs = {
    ...rawArgs,
    projectId: normalizeStringlyNull(rawArgs.projectId),
    replacesFindingId: normalizeStringlyNull(rawArgs.replacesFindingId),
  };
  if (state.proposals.length >= MAX_PROPOSALS) {
    return reject(state, `plan osiągnął limit ${MAX_PROPOSALS} propozycji`);
  }
  const scope = scopeOf(context, args.scopeKind, args.projectId, state.projectBindings);
  if (!scope.ok) {
    return reject(state, scope.reason);
  }
  const duplicateInPlan = state.proposals.some(
    (p) =>
      p.semanticKey === args.semanticKey &&
      p.scope.kind === scope.scope.kind &&
      (scope.scope.kind === "company" ||
        (p.scope.kind === "project" && p.scope.projectId === scope.scope.projectId)),
  );
  if (duplicateInPlan) {
    return reject(state, `propozycja dla ${args.semanticKey} w tym zakresie już istnieje w planie`);
  }

  // Evidence: quotes must ground in THIS source's text.
  const { located, dropped } = locateEvidence(context.source.authorText, args.quotes);
  if (located.length === 0 && args.derivesFromFindingIds.length === 0) {
    return reject(
      state,
      "żaden cytat nie występuje dosłownie w wiadomości, a brak podstawy wnioskowej — popraw cytaty",
    );
  }
  if (dropped.length > 0) {
    // Partial grounding is honest: keep located quotes, name the dropped.
    void dropped;
  }

  // Value construction (server-side anchoring and guards).
  let valueWire: unknown;
  switch (args.value._tag) {
    case "temporal": {
      const built = buildTemporalValue(
        args.value.temporal,
        context.source.sentAtMs,
        context.source.sentAtTimezone,
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
      const firstQuote = located[0]?.quote ?? "";
      const built = buildMoneyValue(args.value.money, firstQuote, companyDefaultCurrency);
      if (!built.built) {
        if (built.reason === "tax_basis_not_stated") {
          return reject(
            state,
            "podstawa netto/brutto niezapisana w cytacie — użyj taxBasis=not_specified",
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

  // Correction discipline: `correct` addresses a live finding; `record`
  // creates, and a live identity forbids a second create.
  const existing = findContextFinding(context, scope.scope, args.semanticKey);
  if (args.intent === "correct") {
    if (args.replacesFindingId === null) {
      return reject(state, "intent=correct wymaga replacesFindingId z kontekstu");
    }
    const target = context.findings.find((f) => f.findingId === args.replacesFindingId);
    if (target === undefined) {
      return reject(state, "replacesFindingId nie wskazuje ustalenia z kontekstu tej firmy");
    }
    if (target.semanticKey !== args.semanticKey || target.scope.kind !== scope.scope.kind || (scope.scope.kind === "project" && (target.scope.kind !== "project" || target.scope.projectId !== scope.scope.projectId))) {
      return reject(
        state,
        "korekta nie może zmieniać znaczenia ani zakresu ustalenia — dopasuj semanticKey i scope",
      );
    }
    // Issue #8 precedence, server-side: re-running an OLDER source cannot
    // revert a truth published from a NEWER source. A correction from this
    // analysis source is refused when the target's current revision stands
    // on a different, later-sent source; the recovery is a NEW boss
    // message, not a re-analysis.
    if (
      target.currentProvenanceSourceId !== null &&
      target.currentProvenanceSourceId !== context.source.sourceId &&
      target.currentProvenanceSourceSentAtMs !== null &&
      target.currentProvenanceSourceSentAtMs > context.source.sentAtMs
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

  // Derivation basis: real context findings, never the finding itself.
  for (const basisId of args.derivesFromFindingIds) {
    if (basisId === args.replacesFindingId) {
      return reject(state, "wniosek nie może wywodzić się z samego siebie");
    }
    const basis = context.findings.find((f) => f.findingId === basisId);
    if (basis === undefined) {
      return reject(state, `podstawa wniosku ${basisId} nie jest ustaleniem z kontekstu`);
    }
  }

  const proposal: FindingProposal = {
    intent: args.intent,
    semanticKey: args.semanticKey,
    scope: scope.scope,
    valueWire,
    knowledgeStateWire: "known",
    evidence: located,
    replacesFindingId: args.replacesFindingId,
    derivesFromFindingIds: [...args.derivesFromFindingIds],
    readConfidence: args.readConfidence,
  };
  const note =
    dropped.length > 0
      ? ` (pominięto ${dropped.length} cytatu/ów nieznajdujących się dosłownie w wiadomości)`
      : "";
  return {
    state: { ...state, proposals: [...state.proposals, proposal] },
    toolResult: `ZAPROPONOWANO ${args.semanticKey} w ${scope.label}${note}.`,
  };
}

/** Applies one decoded `projects_identify` call. */
function applyIdentify(
  state: PlanningState,
  context: AnalysisContext,
  rawArgs: IdentifyProjectArgs,
): ReducerOutcome {
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
      return {
        state,
        toolResult: `Projekt ${project.displayName} już związany z tym uruchomieniem.`,
      };
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
      projectBindings: [
        ...state.projectBindings,
        { handle, displayName, existingProjectId: null },
      ],
    },
    toolResult: `Nowy projekt „${displayName}” zostanie utworzony; używaj projectId=${handle} w memory_upsert_finding.`,
  };
}

/** Applies one decoded `memory_ask_clarification` call. */
function applyClarification(
  state: PlanningState,
  context: AnalysisContext,
  rawArgs: AskClarificationArgs,
): ReducerOutcome {
  const args: AskClarificationArgs = {
    ...rawArgs,
    projectId: normalizeStringlyNull(rawArgs.projectId),
  };
  if (state.clarifications.length >= MAX_CLARIFICATIONS) {
    return reject(state, `limit ${MAX_CLARIFICATIONS} spraw do wyjaśnienia w jednym uruchomieniu`);
  }
  const scope = scopeOf(context, args.scopeKind, args.projectId, state.projectBindings);
  if (!scope.ok) {
    return reject(state, scope.reason);
  }
  if (args.projectId !== null && args.projectId.startsWith("new:")) {
    return reject(
      state,
      "sprawa do wyjaśnienia wymaga istniejącego projektu z kontekstu albo zakresu firmy",
    );
  }
  const { located } = locateEvidence(context.source.authorText, args.quotes);
  if (located.length < 1) {
    return reject(
      state,
      "sprawa do wyjaśnienia wymaga co najmniej jednego dosłownego cytatu z tej wiadomości",
    );
  }
  return {
    state: {
      ...state,
      clarifications: [
        ...state.clarifications,
        { question: args.question, quotes: located, scope: scope.scope },
      ],
    },
    toolResult: "SPRAWA DO WYJAŚNIENIA zapisana w planie; nie zapisuj wartości dla tej informacji.",
  };
}

/**
 * Applies one decoded tool call to the plan state. Arguments must already
 * be DECODED (E2's adapter guarantees this); a call whose arguments fail
 * the deeper context validation is refused with a Polish tool result the
 * model can correct in a later turn. Unknown tool names are refused —
 * though E2's adapter already fails those closed.
 */
export function applyDecodedCall(
  state: PlanningState,
  context: AnalysisContext,
  call: DecodedPlanningCall,
  companyDefaultCurrency: string,
): ReducerOutcome {
  switch (call.name) {
    case UPSERT_FINDING_TOOL: {
      const args = call.arguments as UpsertFindingArgs;
      return applyUpsert(state, context, args, companyDefaultCurrency);
    }
    case IDENTIFY_PROJECT_TOOL: {
      const args = call.arguments as IdentifyProjectArgs;
      return applyIdentify(state, context, args);
    }
    case ASK_CLARIFICATION_TOOL: {
      const args = call.arguments as AskClarificationArgs;
      return applyClarification(state, context, args);
    }
    default:
      return reject(state, `nieznane narzędzie ${call.name}`);
  }
}
