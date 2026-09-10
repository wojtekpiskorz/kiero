/**
 * The analysis dialogue builder (E3): the Polish system prompt, the first
 * user message from the bounded context, and the deterministic
 * assistant/tool-result turn encodings the bounded agent loop replays.
 *
 * E2's typed single-turn interface carries only user/assistant text parts,
 * so the loop encodes its own prior turns deterministically here: the
 * assistant's tool calls serialize as one JSON block per call, and each
 * tool result becomes a user turn prefixed `WYNIK NARZĘDZIA <name>:`.
 * The prompt text below is part of {@link PLANNING_PROMPT_VERSION}: any
 * wording change is a version bump so recorded runs stay interpretable.
 *
 * Everything here is pure: same inputs, same prompt bytes.
 */

import { MAX_PROMPT_SOURCE_CHARS } from "./versions";
import type { AnalysisContext } from "./context";
import type { DecodedPlanningCall } from "./reducer";

/** The Polish system prompt (versioned by PLANNING_PROMPT_VERSION). */
export function analysisSystemPrompt(): string {
  return [
    "Jesteś agentem pamięci firmy budowlanej Kiero. Porządkujesz wypowiedzi szefów w ustalenia.",
    "Pracujesz wyłącznie na wiadomości źródłowej i kontekście, który otrzymujesz.",
    "Zasady:",
    "1. Zapisuj ustalenia przez narzędzie memory_upsert_finding; każde ustalenie wymaga dosłownego cytatu z wiadomości.",
    "2. Pewność odczytu nie zmienia znaczenia wypowiedzi: szacunek zostaje szacunkiem, uzgodnienie uzgodnieniem.",
    "3. Wyraźna zmiana wcześniejszej wartości (np. „zmieniamy na piątek”) to intent=correct z replacesFindingId.",
    "4. Sprzeczność, której nie rozstrzygasz w kontekście, to memory_ask_clarification — nigdy zgadywanie wartości.",
    "5. Informacje o różnych projektach zapisuj osobno, z właściwym projectId; wątpliwe przypisanie wyjaśnij pytaniem.",
    "6. Daty względne podawaj jako expression (serwer wylicza dzień); kwoty bez netto/brutto jako taxBasis=not_specified.",
    "7. Nie wymyślaj danych, których nie ma w wiadomości. Nie łącz dwóch klientów ani projektów.",
    "8. Odpowiedź tekstowa NIE zapisuje nic do pamięci — jedynym kanałem zapisu są narzędzia. Zakończ turę bez wywołań tylko wtedy, gdy wiadomość nie zawiera żadnych ustaleń do zapisania.",
  ].join("\n");
}

/** Serializes the bounded context into the first user message. */
export function sourceUserMessage(context: AnalysisContext): string {
  const source = context.source;
  const text =
    source.authorText.length > MAX_PROMPT_SOURCE_CHARS
      ? `${source.authorText.slice(0, MAX_PROMPT_SOURCE_CHARS)}\n[tekst ucięty do limitu]`
      : source.authorText;
  const projects = context.projects
    .map((p) => `- ${p.projectId}${p.codename === null ? "" : ` (${p.codename})`}: ${p.displayName}`)
    .join("\n");
  const findings = context.findings
    .map(
      (f) =>
        `- ${f.findingId} [${f.scope.kind === "company" ? "firma" : `projekt ${f.scope.projectId}`}] ${f.semanticKey} = ${JSON.stringify(f.value)} (${JSON.stringify(f.knowledgeState)}, rewizja ${f.revisionCounter})`,
    )
    .join("\n");
  const recent = context.recentSources
    .filter((r) => r.sourceId !== source.sourceId)
    .map((r) => `- ${r.sourceId} @${new Date(r.sentAtMs).toISOString()}: ${r.preview}`)
    .join("\n");
  const hints =
    source.hintProjectIds.length === 0
      ? "(brak)"
      : source.hintProjectIds.join(", ");
  const coverage = `tekst: ${source.lifecycle === "active" ? "pełny" : "NIEAKTYWNE ŹRÓDŁO"}; inne medium: ${context.coverage.pendingSegments.length === 0 ? "brak" : `oczekujące: ${context.coverage.pendingSegments.join(", ")}`}`;
  return [
    `WIADOMOŚĆ ŹRÓDŁOWA (${source.sourceId}):`,
    `Wysłano: ${new Date(source.sentAtMs).toISOString()} w strefie ${source.sentAtTimezone}`,
    `Tabletki projektów wskazane przez nadawcę (kontekst, nie rozstrzygnięcie): ${hints}`,
    `Zakres przeanalizowanych materiałów: ${coverage}`,
    "",
    text,
    "",
    "PROJEKTY FIRMY:",
    projects.length === 0 ? "(brak)" : projects,
    "",
    "AKTUALNE USTALENIA (rewizje, których używasz):",
    findings.length === 0 ? "(brak)" : findings,
    "",
    "OSTATNIE ŹRÓDŁA (kontekst):",
    recent.length === 0 ? "(brak)" : recent,
    "",
    context.run.kind === "reanalysis"
      ? `To ponowna analiza tego samego źródła (poprzedni run: ${context.run.reanalysisOfRunId ?? "?"}). Uwzględnij aktualny stan pamięci.`
      : "Przeanalizuj wiadomość i zaproponuj zmiany pamięci narzędziami.",
  ].join("\n");
}

/** Serializes the assistant's tool calls as its own prior turn text. */
export function assistantToolCallsMessage(calls: readonly DecodedPlanningCall[]): string {
  return calls
    .map((call) => JSON.stringify({ narzedzie: call.name, argumenty: call.arguments }))
    .join("\n");
}

/** Encodes one tool result as the user turn the model reads next. */
export function toolResultMessage(toolName: string, result: string): string {
  return `WYNIK NARZĘDZIA ${toolName}: ${result}`;
}

/** The final user nudge when the turn budget is nearly exhausted. */
export function finalTurnInstruction(): string {
  return "To ostatnia tura: doprecyzuj najważniejsze propozycje lub zadaj sprawę do wyjaśnienia, potem zakończ.";
}

/** The nudge when a turn ended text-only while the plan is still empty. */
export function emptyPlanNudge(): string {
  return "Nie zapisano dotąd nic narzędziami. Przeanalizuj wiadomość źródłową jeszcze raz i zapisz ustalenia narzędziami (projects_identify, memory_upsert_finding, memory_ask_clarification). Odpowiedź tekstowa nie zapisuje nic. Jeśli naprawdę nic nie wynika, zakończ bez wywołań.";
}
