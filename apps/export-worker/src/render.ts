/**
 * The archive's readable HTML index (I3): a single self-contained, unstyled
 * HTML document rendered from the company snapshot. It is written for a
 * boss who opens the ZIP on any computer: plain headings, lists and links
 * to the media files next to it — no scripts, no styles, no network.
 *
 * HOSTILE CONTENT: every user-controlled string passes `escapeHtml`
 * (the five characters that open tags, attributes or entities) and every
 * link target is an archive path BUILT from server-owned ids through
 * `mediaArchivePath`/`safePathSegment` — never from a stored name. The
 * document carries no `<script>`, no event attributes and no external
 * references, so a hostile project name or message text renders as text.
 *
 * Language: Polish product text (CONTEXT.md glossary terms verbatim:
 * Firma, Wiadomość źródłowa, Zdjęcie źródłowe, Ustalenie, Zadanie,
 * Zdarzenie, Pamięć projektu).
 */

import { escapeHtml } from "../../../convex/operations/exports/protocol.ts";
import type { CompanySnapshot, SnapshotRow } from "../../../convex/operations/exports/protocol.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function dateTime(ms: unknown): string {
  const n = typeof ms === "number" ? ms : Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "-";
}

/** A pre-assembled HTML fragment whose dynamic parts were already escaped. */
interface RawCell {
  readonly html: string;
}

/** Marks a pre-escaped fragment (the ONLY way markup enters a cell). */
function raw(html: string): RawCell {
  return { html };
}

/** An archive-relative link; href and label are id-built, escaped paths. */
function archiveLink(path: string, label: string): RawCell {
  return raw(`<a href="../${escapeHtml(path)}">${escapeHtml(label)}</a>`);
}

function row(items: readonly (string | RawCell)[]): string {
  return `<tr>${items
    .map((cell) => (typeof cell === "string" ? `<td>${escapeHtml(cell)}</td>` : `<td>${cell.html}</td>`))
    .join("")}</tr>`;
}

function table(headers: readonly string[], rows: readonly (string | RawCell)[][]): string {
  if (rows.length === 0) {
    return "<p>Brak wpisów.</p>";
  }
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.map(row).join("")}</tbody></table>`;
}

function section(title: string, body: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

/** A row's display name when it has one, else the id itself. */
function nameOf(rows: readonly SnapshotRow[], id: string): string {
  const row = rows.find((r) => String(r.id) === id);
  if (row === undefined) {
    return id;
  }
  return typeof row.displayName === "string" ? row.displayName : id;
}

/** Renders the whole `index.html` document of one snapshot. */
export function renderIndexHtml(snapshot: CompanySnapshot): string {
  const projects = snapshot.projects;
  const people = snapshot.people;
  const esc = escapeHtml;

  const header = [
    "<header>",
    `<h1>Eksport danych firmy: ${esc(snapshot.company.name)}</h1>`,
    `<p>Moment wykonania migawki: ${dateTime(snapshot.snapshotAtMs)}</p>`,
    `<p>Wersja formatu: ${esc(snapshot.schemaVersion)}</p>`,
    `<p>Strefa czasu firmy: ${esc(snapshot.company.timezone)}; waluta domyślna: ${esc(snapshot.company.defaultCurrency)}</p>`,
    `<p>Ten plik jest częścią archiwum ZIP. Dane w formacie JSON znajdują się w katalogu <code>dane</code>, a zachowane zdjęcia i nagrania w katalogu <code>media</code>.</p>`,
    "</header>",
  ].join("\n");

  const peopleSection = section(
    "Szefowie i członkostwa",
    table(
      ["Osoba", "Rola", "Stan członkostwa", "Od"],
      snapshot.memberships.map((m) => [
        nameOf(people, text(m.userId)),
        text(m.role) === "admin" ? "Administrator firmy" : "Szef",
        text(m.state) === "active" ? "Aktywne" : "Odebrane",
        dateTime(m.createdAtMs),
      ]),
    ),
  );

  const projectsSection = section(
    "Projekty",
    table(
      ["Projekt", "Alias projektu", "Etap projektu", "Wstrzymanie", "Utworzony"],
      snapshot.projects.map((p) => {
        const paused = p.paused as { reason?: string } | undefined;
        return [
          text(p.displayName),
          snapshot.projectAliases
            .filter((a) => a.projectId === p.id && a.active)
            .map((a) => text(a.codename))
            .join(", "),
          text(p.stage),
          paused === undefined ? "-" : `Tak (${text(paused.reason)})`,
          dateTime(p.createdAtMs),
        ];
      }),
    ),
  );

  const sourcesSection = section(
    "Wiadomości źródłowe",
    table(
      ["Wysłana", "Autor", "Treść", "Stan", "Media"],
      snapshot.sources.map((s) => {
        const links = snapshot.media
          .filter((m) => m.sourceId === s.id)
          .map((m) => archiveLink(m.archivePath, m.kind === "image" ? "Zdjęcie źródłowe" : "Nagranie"));
        const lifecycle = text(s.lifecycle);
        return [
          dateTime(s.sentAtMs),
          nameOf(people, text(s.authorUserId)),
          text(s.authorText),
          lifecycle === "active" ? "Aktywna" : lifecycle === "withdrawn" ? "Źródło wycofane" : lifecycle,
          links.length === 0 ? "-" : raw(links.map((link) => link.html).join(" ")),
        ];
      }),
    ),
  );

  const tasksSection = section(
    "Zadania",
    table(
      ["Zadanie", "Projekt", "Stan zadania", "Termin (ustalenie)", "Checklista"],
      snapshot.tasks.map((t) => {
        const items = snapshot.checklistItems.filter((c) => c.taskId === t.id);
        const checked = items.filter((c) => c.state === "checked").length;
        const stateNames: Record<string, string> = {
          todo: "Do zrobienia",
          in_progress: "W toku",
          waiting: "Czeka",
          done: "Wykonane",
          cancelled: "Anulowane",
        };
        return [
          text(t.title),
          nameOf(projects, text(t.projectId)),
          stateNames[text(t.state)] ?? text(t.state),
          t.deadlineFindingId === undefined ? "-" : `Ustalenie ${text(t.deadlineFindingId)}`,
          items.length === 0 ? "-" : `${checked}/${items.length}`,
        ];
      }),
    ),
  );

  const eventsSection = section(
    "Zdarzenia",
    table(
      ["Zdarzenie", "Projekt", "Stan zdarzenia"],
      snapshot.events.map((e) => {
        const stateNames: Record<string, string> = {
          planned: "Planowane",
          occurred: "Odbyło się",
          cancelled: "Anulowane",
        };
        return [
          text(e.title),
          nameOf(projects, text(e.projectId)),
          stateNames[text(e.state)] ?? text(e.state),
        ];
      }),
    ),
  );

  const findingsSection = section(
    "Ustalenia (pamięć firmy i projektów)",
    table(
      ["Zakres", "Klucz", "Wartość (JSON)", "Stan wiedzy", "Rewizje"],
      snapshot.findings.map((f) => {
        const revisions = snapshot.findingRevisions.filter((r) => r.findingId === f.id);
        return [
          f.scopeKind === "project"
            ? `Projekt ${nameOf(projects, text(f.scopeProjectId))}`
            : "Pamięć firmy",
          text(f.semanticKey),
          JSON.stringify(revisions.at(-1)?.value ?? null),
          JSON.stringify(f.knowledgeState),
          String(revisions.length),
        ];
      }),
    ),
  );

  const mediaSection = section(
    "Zachowane media",
    table(
      ["Rodzaj", "Plik w archiwum", "Rozmiar (B)", "Rola"],
      snapshot.media.map((m) => {
        const cells = [
          m.kind === "image" ? "Zdjęcie źródłowe" : "Nagranie",
          archiveLink(m.archivePath, m.archivePath),
          String(m.bytes),
          m.role === "retained" ? "Zachowana reprezentacja" : "Plik wejściowy",
        ];
        return cells;
      }),
    ),
  );

  const historyNote = [
    "<section>",
    "<h2>Historia zmian</h2>",
    "<p>Pełna, niezmienna historia rewizji ustaleń oraz zadań i zdarzeń znajduje się w plikach JSON: </p>",
    "<ul>",
    "<li><code>dane/findingRevisions.json</code> - rewizje ustaleń z autorami, czasem i podstawami,</li>",
    "<li><code>dane/workRevisions.json</code> - historia zadań i zdarzeń,</li>",
    "<li><code>dane/sourceProjectLinks.json</code> - powiązania wiadomości z projektami.</li>",
    "</ul>",
    "</section>",
  ].join("\n");

  return [
    "<!DOCTYPE html>",
    '<html lang="pl">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Eksport danych firmy</title>",
    "</head>",
    "<body>",
    header,
    peopleSection,
    projectsSection,
    sourcesSection,
    tasksSection,
    eventsSection,
    findingsSection,
    mediaSection,
    historyNote,
    "</body>",
    "</html>",
  ].join("\n");
}

/** The archive's per-collection JSON file map (manifest excluded). */
export function collectionJsonFiles(snapshot: CompanySnapshot): { path: string; contents: string }[] {
  const collections: [string, readonly SnapshotRow[]][] = [
    ["people", snapshot.people],
    ["memberships", snapshot.memberships],
    ["projects", snapshot.projects],
    ["projectAliases", snapshot.projectAliases],
    ["contacts", snapshot.contacts],
    ["contactRoles", snapshot.contactRoles],
    ["sources", snapshot.sources],
    ["sourceProjectLinks", snapshot.sourceProjectLinks],
    ["extractions", snapshot.extractions],
    ["sourceFragments", snapshot.sourceFragments],
    ["attachments", snapshot.attachments],
    ["findings", snapshot.findings],
    ["findingRevisions", snapshot.findingRevisions],
    ["evidenceLinks", snapshot.evidenceLinks],
    ["findingDependencies", snapshot.findingDependencies],
    ["clarifications", snapshot.clarifications],
    ["extensionDefinitions", snapshot.extensionDefinitions],
    ["extensionVersions", snapshot.extensionVersions],
    ["tasks", snapshot.tasks],
    ["checklistItems", snapshot.checklistItems],
    ["events", snapshot.events],
    ["workRevisions", snapshot.workRevisions],
  ];
  return collections.map(([name, rows]) => ({
    path: `dane/${name}.json`,
    contents: JSON.stringify(rows, null, 2),
  }));
}

/** The archive's manifest: what this snapshot is, in machine-readable form. */
export function manifestJson(snapshot: CompanySnapshot): string {
  return JSON.stringify(
    {
      schemaVersion: snapshot.schemaVersion,
      snapshotAtMs: snapshot.snapshotAtMs,
      exportId: snapshot.exportId,
      company: snapshot.company,
      counts: {
        sources: snapshot.sources.length,
        media: snapshot.media.length,
        findings: snapshot.findings.length,
        tasks: snapshot.tasks.length,
        events: snapshot.events.length,
      },
      media: snapshot.media,
    },
    null,
    2,
  );
}
