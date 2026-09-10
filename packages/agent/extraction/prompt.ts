/**
 * The joined-analysis dialogue builder (E4): the Polish system prompt and
 * context message for a MIXED source (text + audio + images), extending
 * E3's builder with the transcript and image-observation sections and the
 * explicit partial-coverage rules.
 *
 * Everything here is pure and versioned by {@link JOIN_PROMPT_VERSION}:
 * same inputs, same prompt bytes. The coverage statement NAMES every
 * unresolved medium and instructs the model to leave its conclusions
 * alone — the honesty the reducer enforces structurally is also stated in
 * the words the model reads.
 */

import { MAX_PROMPT_SOURCE_CHARS } from "../planning/versions";
import {
  MAX_TRANSCRIPT_PROMPT_CHARS,
  MAX_VISION_PROMPT_CHARS,
} from "./versions";
import type { JoinAnalysisContext } from "./reducer";

/** The Polish joined-analysis system prompt (JOIN_PROMPT_VERSION). */
export function joinAnalysisSystemPrompt(): string {
  return [
    "Jesteś agentem pamięci firmy budowlanej Kiero. Porządkujesz wypowiedzi szefów w ustalenia.",
    "Wiadomość źródłowa może łączyć tekst, nagranie i zdjęcia — analizujesz wszystkie przeanalizowane części razem.",
    "Pracujesz wyłącznie na materiale, który otrzymujesz w kontekście.",
    "Zasady:",
    "1. Zapisuj ustalenia przez narzędzie memory_upsert_finding; każde ustalenie wymaga dowodu: cytatu z tekstu (quotes), fragmentu transkrypcji (transcriptQuotes) albo uchwytu odczytu ze zdjęcia (imageObservationIds).",
    "2. Pewność odczytu nie zmienia znaczenia wypowiedzi: szacunek zostaje szacunkiem, uzgodnienie uzgodnieniem.",
    "3. Wyraźna zmiana wcześniejszej wartości (np. „zmieniamy na piątek”) to intent=correct z replacesFindingId.",
    "4. Sprzeczność, której nie rozstrzygasz w kontekście, to memory_ask_clarification — nigdy zgadywanie wartości.",
    "5. Informacje o różnych projektach zapisuj osobno, z właściwym projectId; wątpliwe przypisanie wyjaśnij pytaniem.",
    "6. Daty względne podawaj jako expression (serwer wylicza dzień); kwoty bez netto/brutto jako taxBasis=not_specified.",
    "7. Nie wymyślaj danych. Nie zmyślaj uchwytów obs ani cytatów z transkrypcji. Jeśli medium jest wskazane jako nieprzeanalizowane (oczekujące), NIE zapisuj ustaleń, które je cytują — ta część pozostanie do wyjaśnienia później.",
    "8. Odpowiedź tekstowa NIE zapisuje nic do pamięci — jedynym kanałem zapisu są narzędzia. Zakończ turę bez wywołań tylko wtedy, gdy wiadomość nie zawiera żadnych ustaleń do zapisania.",
  ].join("\n");
}

/** Serializes the joined context into the first user message. */
export function joinSourceUserMessage(context: JoinAnalysisContext): string {
  const source = context.base.source;
  const text =
    source.authorText.length > MAX_PROMPT_SOURCE_CHARS
      ? `${source.authorText.slice(0, MAX_PROMPT_SOURCE_CHARS)}\n[tekst ucięty do limitu]`
      : source.authorText;
  const projects = context.base.projects
    .map((p) => `- ${p.projectId}${p.codename === null ? "" : ` (${p.codename})`}: ${p.displayName}`)
    .join("\n");
  const findings = context.base.findings
    .map(
      (f) =>
        `- ${f.findingId} [${f.scope.kind === "company" ? "firma" : `projekt ${f.scope.projectId}`}] ${f.semanticKey} = ${JSON.stringify(f.value)} (${JSON.stringify(f.knowledgeState)}, rewizja ${f.revisionCounter})`,
    )
    .join("\n");
  const recent = context.base.recentSources
    .filter((r) => r.sourceId !== source.sourceId)
    .map((r) => `- ${r.sourceId} @${new Date(r.sentAtMs).toISOString()}: ${r.preview}`)
    .join("\n");
  const hints =
    source.hintProjectIds.length === 0 ? "(brak)" : source.hintProjectIds.join(", ");

  // The joined coverage statement: every unresolved medium is NAMED with
  // its honest state (pending / blocked / failed) — the model is told what
  // it may NOT ground in.
  const coverageLines = context.coverage.inputs.map((input) => {
    const label =
      input.kind === "text"
        ? "tekst"
        : input.kind === "audio"
          ? `nagranie (${input.attachmentId ?? "?"})`
          : `zdjęcie (${input.attachmentId ?? "?"})`;
    const state =
      input.status === "complete"
        ? "przeanalizowane"
        : input.status === "externally_blocked"
          ? `NIEPRZEANALIZOWANE — zablokowane zewnętrznie (${input.lastErrorKind ?? "?"}), wznowienie możliwe`
          : input.status === "failed"
            ? `NIEPRZEANALIZOWANE — niepowodzenie (${input.lastErrorKind ?? "?"})`
            : input.status === "replaced_by_newer_version"
              ? "przeanalizowane (istnieje nowsza wersja ekstrakcji)"
              : `NIEPRZEANALIZOWANE — oczekujące (${input.lastErrorKind ?? "w toku"})`;
    return `- ${label}: ${state}`;
  });

  const segments = context.transcriptSegments
    .map(
      (segment) =>
        `[${Math.round(segment.startMs)}ms-${Math.round(segment.endMs)}ms] ${segment.text}`,
    )
    .join("\n");
  const transcriptBlock =
    context.transcriptSegments.length === 0
      ? "(brak nagrania albo transkrypcja niekompletna)"
      : segments.length > MAX_TRANSCRIPT_PROMPT_CHARS
        ? `${segments.slice(0, MAX_TRANSCRIPT_PROMPT_CHARS)}\n[transkrypcja ucięta do limitu]`
        : segments;

  const observations = context.visionObservations
    .map(
      (observation) =>
        `- ${observation.observationId} (zdjęcie ${observation.attachmentId}): „${observation.text}” [obszar x=${observation.region.x}, y=${observation.region.y}, szer=${observation.region.width}, wys=${observation.region.height}]`,
    )
    .join("\n");
  const observationBlock =
    context.visionObservations.length === 0
      ? "(brak zdjęć albo odczyt zdjęć niekompletny)"
      : observations.length > MAX_VISION_PROMPT_CHARS
        ? `${observations.slice(0, MAX_VISION_PROMPT_CHARS)}\n[odczyty ucięte do limitu]`
        : observations;

  return [
    `WIADOMOŚĆ ŹRÓDŁOWA (${source.sourceId}):`,
    `Wysłano: ${new Date(source.sentAtMs).toISOString()} w strefie ${source.sentAtTimezone}`,
    `Podpowiedzi projektów wskazane przez nadawcę (kontekst, nie rozstrzygnięcie): ${hints}`,
    "",
    "ZAKRES PRZEANALIZOWANYCH MATERIAŁÓW:",
    ...coverageLines,
    "",
    "TEKST WIADOMOŚCI:",
    text,
    "",
    "TRANSCRIPT NAGRANIA (fragmenty z przedziałów czasu oryginału):",
    transcriptBlock,
    "",
    "ZDJĘCIA (odczyty z obszarów; cytuj przez imageObservationIds):",
    observationBlock,
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
    context.base.run.kind === "reanalysis"
      ? `To ponowna analiza tego samego źródła (poprzedni run: ${context.base.run.reanalysisOfRunId ?? "?"}). Uwzględnij aktualny stan pamięci.`
      : "Przeanalizuj wiadomość i zaproponuj zmiany pamięci narzędziami.",
  ].join("\n");
}

/** The nudge when a turn ended text-only while the plan is still empty. */
export function emptyJoinPlanNudge(): string {
  return "Nie zapisano dotąd nic narzędziami. Przeanalizuj tekst, transkrypcję i odczyty zdjęć jeszcze raz i zapisz ustalenia narzędziami (projects_identify, memory_upsert_finding, memory_ask_clarification). Odpowiedź tekstowa nie zapisuje nic. Jeśli naprawdę nic nie wynika, zakończ bez wywołań.";
}
