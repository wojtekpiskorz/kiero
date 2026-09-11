/**
 * The answer dialogue builder (E6): the Polish system prompt, the first
 * user message from the bounded answer context, and the deterministic
 * assistant/tool-result turn encodings the bounded answer loop replays.
 *
 * Same convention as E3's planning prompt: E2's typed single-turn interface
 * carries only user/assistant text parts, so the loop encodes its own prior
 * turns deterministically here. The prompt text below is part of
 * {@link ANSWER_PROMPT_VERSION}: any wording change is a version bump so
 * recorded answers stay interpretable.
 *
 * Everything here is pure: same inputs, same prompt bytes.
 */

import {
  MAX_PROMPT_QUESTION_CHARS,
  MAX_ANSWER_SOURCE_PREVIEW_CHARS,
} from "./versions";
import type { AnswerContext } from "./context";
import type { AnswerEvidenceEntry } from "./context";
import { owedDisclosures } from "./context";
import type { DecodedAnswerCall } from "./reducer";

/** Renders one encoded finding value compactly for the model. */
function valuePreview(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? "?" : json.slice(0, 300);
}

/** Renders the knowledge tag with the honest Polish label. */
function knowledgeLabel(tag: string, updating: boolean): string {
  if (updating) {
    return "W TRAKCIE AKTUALIZACJI (nie podawaj jako ustalonego)";
  }
  switch (tag) {
    case "known":
      return "ustalone";
    case "unknown":
      return "nieznane (z powodem)";
    case "conflicted":
      return "SPRZECZNE (zapytaj, nie wybieraj)";
    case "not_applicable":
      return "nie dotyczy";
    default:
      return tag;
  }
}

/** The Polish system prompt (versioned by ANSWER_PROMPT_VERSION). */
export function answerSystemPrompt(): string {
  return [
    "Jesteś agentem firmy budowlanej Kiero. Odpowiadasz szefom na pytania wyłącznie na podstawie aktualnej pamięci i źródeł, które otrzymujesz.",
    "Zasady:",
    "1. Dowody z kontekstu (pod ustaleniami) są już cytowalne uchwytami evN — gdy kontekst odpowiada na pytanie, odpowiadaj z niego bez dodatkowego szukania; agent_search_evidence służy, gdy kontekstu nie wystarcza.",
    "2. Odpowiedź składasz narzędziem agent_submit_answer: każde zdanie faktograficzne ma basis=direct (cytat) albo corroboration (dwa niezależne źródła); wniosek oznaczasz basis=inference z podstawą.",
    "3. Nie zgaduj: kwota bez zapisanej podstawy netto/brutto to „nie określono”, brak daty to brak daty, nieznane pozostaje nieznane.",
    "4. Ustalenia „w trakcie aktualizacji” i sprzeczne ujawniasz w disclosures albo pytasz — nigdy nie podajesz ich jako ustalonych. Prawidłowy kształt: zdanie o tym, CO zapisano, jako basis=direct z cytatem treści źródła (evN), np. „Zapisano wniosek: «ryzyko kary za opóźnienie jest niskie» (ev2).” — a ustalenie weryfikowane wskaż w disclosures, zamiast podawać jego treść jako ustaloną.",
    "5. Sprzeczność, której nie rozstrzygasz w kontekście, to agent_ask_clarification z cytatami obu stron.",
    "6. Nowe źródła w trakcie przetwarzania ujawnij w disclosures: niezależne potwierdzenia możesz podać, ale zapowiedz, że trwa analiza.",
    "7. Zmiany domeny (zadanie, zdarzenie) wykonujesz tylko narzędziami agent_change_task / agent_change_event; przechodzą przez te same reguły co z aplikacji.",
    "8. Tekst bez wywołania narzędzi nic nie zmienia; odpowiedź kończy się wyłącznie agent_submit_answer (albo agent_ask_clarification, gdy pytanie zastępuje odpowiedź).",
    "Przykład (pytanie o ustalenie w trakcie aktualizacji):",
    "PYTANIE: „Czy ryzyko kary jest niskie?”; szukanie znalazło ev5: „…ryzyko kary za opóźnienie jest niskie”; ustalenie ryzyko=… ma status W TRAKCIE AKTUALIZACJI.",
    "POPRAWNIE: statements=[{text:\"Zapisano wniosek: «ryzyko kary za opóźnienie jest niskie» (ev5).\",basis:\"direct\",evidenceIds:[\"ev5\"],derivedFromFindingIds:[]}] oraz disclosures.updatingFindingIds=[id tego ustalenia].",
    "NIEDOPUSZCZALNE: basis=inference z tego ustalenia albo podanie jego treści jako ustalonego faktu.",
  ].join("\n");
}

/** Serializes the bounded context into the first user message. */
export function questionUserMessage(context: AnswerContext): string {
  const question =
    context.question.authorText.length > MAX_PROMPT_QUESTION_CHARS
      ? `${context.question.authorText.slice(0, MAX_PROMPT_QUESTION_CHARS)}\n[tekst ucięty do limitu]`
      : context.question.authorText;
  const projects = context.projects
    .map(
      (p) =>
        `- ${p.projectId}${p.codename === null ? "" : ` (${p.codename})`}: ${p.displayName}`,
    )
    .join("\n");
  const findings = context.findings
    .map(
      (f) =>
        `- ${f.findingId} [${f.scope.kind === "company" ? "firma" : `projekt ${f.scope.projectId}`}] ${f.semanticKey} = ${valuePreview(f.value)} — ${knowledgeLabel(f.knowledgeTag, f.updating)} (rewizja ${f.revisionCounter})`,
    )
    .join("\n");
  const sources = context.sources
    .filter((source) => source.sourceId !== context.question.sourceId)
    .map(
      (source) =>
        `- ${source.sourceId} @${new Date(source.sentAtMs).toISOString()}: ${source.preview.slice(0, MAX_ANSWER_SOURCE_PREVIEW_CHARS)}${source.processing === "processing" ? " [ANALIZA W TOKU]" : ""}${source.lifecycle === "active" ? "" : ` [${source.lifecycle.toUpperCase()}]`}`,
    )
    .join("\n");
  const evidence = context.evidence
    .map(
      (entry) =>
        `- ${entry.evidenceId}: ${entry.sourceId}${entry.fragmentId === null ? "" : ` fragment ${entry.fragmentId}`}: „${entry.quote}”${entry.groundsUpdating ? " [podstawa w trakcie aktualizacji]" : ""}`,
    )
    .join("\n");
  const disclosures = owedDisclosures(context);
  const tasks = context.tasks
    .map((t) => `- ${t.taskId} [projekt ${t.projectId}] ${t.title} — ${t.state} (rewizja ${t.revisionCounter})`)
    .join("\n");
  const events = context.events
    .map((e) => `- ${e.eventId} [projekt ${e.projectId}] ${e.title} — ${e.state} (rewizja ${e.revisionCounter})`)
    .join("\n");
  const clarifications = context.clarifications
    .map(
      (c) =>
        `- ${c.clarificationId} [${c.scopeKind === "company" ? "firma" : `projekt ${c.scopeProjectId}`}] ${c.question}`,
    )
    .join("\n");
  const contacts = context.contacts
    .map((c) => `- ${c.contactId}: ${c.displayName}`)
    .join("\n");
  const memberships = context.memberships
    .map((m) => `- ${m.membershipId}: ${m.bossName}`)
    .join("\n");
  return [
    `PYTANIE SZEFA (źródło ${context.question.sourceId}, wysłano ${new Date(context.question.sentAtMs).toISOString()} w strefie ${context.question.sentAtTimezone}):`,
    question,
    "",
    "PROJEKTY FIRMY:",
    projects.length === 0 ? "(brak)" : projects,
    "",
    "AKTUALNE USTALENIA:",
    findings.length === 0 ? "(brak)" : findings,
    "",
    "ZADANIA:",
    tasks.length === 0 ? "(brak)" : tasks,
    "",
    "ZDARZENIA:",
    events.length === 0 ? "(brak)" : events,
    "",
    "OTWARTE SPRAWY DO WYJAŚNIENIA:",
    clarifications.length === 0 ? "(brak)" : clarifications,
    "",
    "KONTAKTY (wykonawcy z katalogu; użyj id albo null):",
    contacts.length === 0 ? "(brak)" : contacts,
    "",
    "SZEFOWIE (koordynatorzy; użyj id członkostwa albo null):",
    memberships.length === 0 ? "(brak)" : memberships,
    "",
    "OSTATNIE ŹRÓDŁA (kontekst):",
    sources.length === 0 ? "(brak)" : sources,
    "",
    "DOWODY (uchwyty evN):",
    evidence.length === 0 ? "(brak — poszukaj narzędziem agent_search_evidence)" : evidence,
    "",
    disclosures.updatingFindingIds.length > 0
      ? `Ustalenia w trakcie aktualizacji (do ujawnienia, nie do podania jako ustalone): ${disclosures.updatingFindingIds.join(", ")}`
      : "Brak ustaleń w trakcie aktualizacji.",
    disclosures.processingSourceIds.length > 0
      ? `Źródła w trakcie analizy (do ujawnienia): ${disclosures.processingSourceIds.join(", ")}`
      : "",
    "",
    "Odpowiedz na pytanie: najpierw zbierz dowody, potem złóż odpowiedź narzędziem agent_submit_answer (albo zadaj sprawę do wyjaśnienia).",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Serializes the assistant's tool calls as its own prior turn text. */
export function assistantToolCallsMessage(calls: readonly DecodedAnswerCall[]): string {
  return calls
    .map((call) => JSON.stringify({ narzedzie: call.name, argumenty: call.arguments }))
    .join("\n");
}

/** Encodes one tool result as the user turn the model reads next. */
export function toolResultMessage(toolName: string, result: string): string {
  return `WYNIK NARZĘDZIA ${toolName}: ${result}`;
}

/** Encodes search results as the tool-result text the model reads. */
export function evidenceSearchResult(entries: readonly AnswerEvidenceEntry[]): string {
  if (entries.length === 0) {
    return "Brak dosłownych trafień. Kandydaci nie są prawdą: trafność nie ustala niczego; rozszerz lub zmień frazę.";
  }
  const lines = entries.map(
    (entry) =>
      `- ${entry.evidenceId}: ${entry.sourceId} @${new Date(entry.sourceSentAtMs).toISOString()}${entry.fragmentId === null ? "" : ` fragment ${entry.fragmentId}`}: „${entry.quote}”`,
  );
  return [
    `${entries.length} kandydatów (to NIE jest ustalenie prawdy):`,
    ...lines,
  ].join("\n");
}

/** The final-turn nudge when the turn budget is nearly exhausted. */
export function finalTurnInstruction(): string {
  return "To ostatnia tura: złóż odpowiedź narzędziem agent_submit_answer na dowodach, które masz, z uczciwymi ujawnieniami braków — albo zadaj sprawę do wyjaśnienia.";
}

/** The nudge when the turn ended text-only with no submitted answer. */
export function noAnswerNudge(): string {
  return "Tekst nie jest odpowiedzią. Złóż odpowiedź narzędziem agent_submit_answer (z cytatami evN) albo zadaj sprawę do wyjaśnienia agent_ask_clarification.";
}

/** The nudge after a mid-run staleness refresh. */
export function contextRefreshedNudge(moved: readonly string[]): string {
  return `KONTEKST SIĘ ZMIENIŁ: ustalenia ${moved.join(", ")} mają nową rewizję. Stan został odświeżony poniżej. Zawęź odpowiedź do aktualnych ustaleń albo zadaj sprawę do wyjaśnienia — nie dawaj odpowiedzi ze starego stanu.`;
}

/** The refreshed current state after a mid-run staleness recheck. */
export function refreshedStateMessage(context: AnswerContext): string {
  const findings = context.findings
    .map(
      (f) =>
        `- ${f.findingId} ${f.semanticKey} = ${valuePreview(f.value)} — ${knowledgeLabel(f.knowledgeTag, f.updating)} (rewizja ${f.revisionCounter})`,
    )
    .join("\n");
  return ["AKTUALNE USTALENIA PO ODŚWIEŻENIU:", findings.length === 0 ? "(brak)" : findings].join("\n");
}
