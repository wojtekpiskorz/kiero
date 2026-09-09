#!/usr/bin/env node
/**
 * Deterministic generator for all synthetic image assets of the Kiero
 * evaluation corpus (issue E1).
 *
 * - Pure Node, zero dependencies, fully reproducible: fixed layout data and a
 *   seeded PRNG (mulberry32) with a fixed seed per asset. Running it twice
 *   produces byte-identical files.
 * - Two styles: "hand" (handwriting-like marker/pen using a cursive font stack
 *   with seeded rotation/baseline jitter) and "print" (clean sans-serif
 *   documents). Rendering varies with the viewer's fonts; the authoritative
 *   content is embedded in <desc> and mirrored in the case fixture's
 *   contentDescription and the answer key.
 * - After writing each SVG it records sha256 into the corresponding
 *   case.json assetProvenance, so the validator can detect any tampering.
 *
 * Usage: node evals/corpus/assets/generate-images.mjs
 */

import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES = join(CORPUS, "cases");

// Deterministic PRNG (mulberry32).
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HAND_FONT = "'Bradley Hand','Comic Sans MS','Segoe Script','Comic Neue',cursive";
const PRINT_FONT = "Arial, Helvetica, sans-serif";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Canvas builder. */
function doc({ w, h, bg, desc }) {
  const parts = [];
  const api = {
    w,
    h,
    rect(x, y, rw, rh, { fill = "none", stroke = "none", sw = 1, dash } = {}) {
      parts.push(
        `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${
          dash ? ` stroke-dasharray="${dash}"` : ""
        }/>`
      );
      return api;
    },
    line(x1, y1, x2, y2, { stroke = "#333", sw = 2, dash } = {}) {
      parts.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"${
          dash ? ` stroke-dasharray="${dash}"` : ""
        }/>`
      );
      return api;
    },
    hand(x, y, size, str, { color = "#1c2f6e", rot, weight = "normal" } = {}, rand = Math.random) {
      const r = rot ?? (rand() * 4 - 2).toFixed(2);
      const dy = (rand() * 4 - 2).toFixed(2);
      parts.push(
        `<text x="${x}" y="${(y + Number(dy)).toFixed(2)}" font-family="${HAND_FONT}" font-size="${size}" fill="${color}" font-weight="${weight}" transform="rotate(${r} ${x} ${y})">${esc(str)}</text>`
      );
      return api;
    },
    print(x, y, size, str, { color = "#111", weight = "normal", anchor = "start", spacing } = {}) {
      parts.push(
        `<text x="${x}" y="${y}" font-family="${PRINT_FONT}" font-size="${size}" fill="${color}" font-weight="${weight}"${
          anchor !== "start" ? ` text-anchor="${anchor}"` : ""
        }${spacing ? ` letter-spacing="${spacing}"` : ""}>${esc(str)}</text>`
      );
      return api;
    },
    ellipse(cx, cy, rx, ry, { stroke = "#c62828", sw = 3 } = {}) {
      parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`);
      return api;
    },
    svg() {
      return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
        `<desc>${esc(desc)}</desc>`,
        `<rect width="${w}" height="${h}" fill="${bg}"/>`,
        ...parts,
        `</svg>`,
        ``,
      ].join("\n");
    },
  };
  return api;
}

function ruled(c, { top = 90, gap = 44, color = "#dcd6c4" } = {}) {
  for (let y = top; y < c.h - 30; y += gap) c.line(30, y, c.w - 30, y, { stroke: color, sw: 1 });
}

function grid(c, { gap = 20, color = "#dfe7ee" } = {}) {
  for (let x = gap; x < c.w; x += gap) c.line(x, 0, x, c.h, { stroke: color, sw: 1 });
  for (let y = gap; y < c.h; y += gap) c.line(0, y, c.w, y, { stroke: color, sw: 1 });
}

// ---------------------------------------------------------------------------
// Asset specs. Content mirrors the case fixture contentDescription exactly.
// ---------------------------------------------------------------------------

function buildI01() {
  const rand = prng(101);
  const c = doc({ w: 800, h: 600, bg: "#8a7f6b", desc: "Żółta kartka samoprzylepna, odręczne napisy: KACZMAREK — UMOWA, 9 800 zł, podkreślone dwa razy." });
  c.rect(120, 80, 560, 460, { fill: "#f6e58d", stroke: "#e0c96a", sw: 2 });
  c.hand(200, 180, 54, "KACZMAREK", { color: "#1c2f6e", weight: "bold" }, rand);
  c.hand(240, 280, 60, "9 800 zł", { color: "#16324f", weight: "bold" }, rand);
  c.line(230, 300, 530, 296, { stroke: "#16324f", sw: 3 });
  c.line(228, 312, 535, 308, { stroke: "#16324f", sw: 2 });
  c.hand(210, 420, 44, "UMOWA", { color: "#7a1f1f", weight: "bold" }, rand);
  return { file: "sketch.svg", svg: c.svg() };
}

function buildI02() {
  const rand = prng(102);
  const c = doc({ w: 800, h: 600, bg: "#fdfcf7", desc: "Szkic łazienki na papierze w kratkę: pokój 2,4 × 1,8 m, wylewka 6 cm, płytki 60×60." });
  grid(c);
  c.rect(120, 120, 384, 288, { stroke: "#1c2f6e", sw: 3 });
  c.hand(140, 100, 30, "łazienka 2,4 × 1,8 m", { color: "#1c2f6e" }, rand);
  c.line(120, 440, 504, 440, { stroke: "#444", sw: 2 });
  c.hand(230, 480, 30, "wylewka 6 cm", { color: "#7a1f1f" }, rand);
  c.hand(540, 200, 30, "płytki 60×60", { color: "#1c2f6e" }, rand);
  c.line(560, 220, 620, 260, { stroke: "#888", sw: 2, dash: "6 4" });
  return { file: "plan.svg", svg: c.svg() };
}

function buildI03() {
  const c = doc({ w: 600, h: 800, bg: "#ffffff", desc: "Wydruk dostawy: Płytki gres 45 m², netto 6 300,00 zł, VAT 23% 1 449,00 zł, razem brutto 7 749,00 zł." });
  c.print(60, 80, 26, "DOSTAWA nr 118/2026", { weight: "bold", spacing: "1" });
  c.print(60, 112, 15, "Ceramica Synth sp. z o.o. (dane syntetyczne)");
  c.line(60, 140, 540, 140, { stroke: "#111", sw: 2 });
  c.print(60, 190, 16, "Pozycja", { weight: "bold" });
  c.print(360, 190, 16, "Ilość", { weight: "bold" });
  c.print(460, 190, 16, "Wartość", { weight: "bold" });
  c.line(60, 205, 540, 205, { stroke: "#999", sw: 1 });
  c.print(60, 240, 16, "Płytki gres");
  c.print(360, 240, 16, "45 m²");
  c.print(460, 240, 16, "6 300,00 zł");
  c.line(60, 265, 540, 265, { stroke: "#999", sw: 1 });
  c.print(360, 310, 16, "netto:", { anchor: "end" });
  c.print(460, 310, 16, "6 300,00 zł", { weight: "bold" });
  c.print(360, 340, 16, "VAT 23%:", { anchor: "end" });
  c.print(460, 340, 16, "1 449,00 zł");
  c.print(360, 380, 16, "brutto:", { anchor: "end", weight: "bold" });
  c.print(460, 380, 16, "7 749,00 zł", { weight: "bold" });
  return { file: "delivery-note.svg", svg: c.svg() };
}

function buildI04() {
  const c = doc({ w: 800, h: 500, bg: "#ffffff", desc: "Wizytówka: WIŚNIEWSKI INSTALACJE, Marek Wiśniewski, tel. 601 202 303, kontakt@wisniewski-instalacje.example.pl." });
  c.rect(40, 40, 720, 420, { fill: "#f4f6fa", stroke: "#1c2f6e", sw: 4 });
  c.print(80, 140, 34, "WIŚNIEWSKI INSTALACJE", { color: "#1c2f6e", weight: "bold", spacing: "2" });
  c.print(80, 200, 22, "Marek Wiśniewski");
  c.print(80, 260, 20, "tel. 601 202 303");
  c.print(80, 300, 16, "kontakt@wisniewski-instalacje.example.pl");
  return { file: "business-card.svg", svg: c.svg() };
}

function buildI05() {
  const rand = prng(105);
  const c = doc({ w: 800, h: 600, bg: "#ffffff", desc: "Zdjęcie białej tablicy: kolumna BANAN — start 28.09, kolumna BANANOWA — start 5.10." });
  c.rect(20, 20, 760, 560, { fill: "#ffffff", stroke: "#cfd4da", sw: 6 });
  c.hand(90, 140, 48, "BANAN", { color: "#1565c0", weight: "bold" }, rand);
  c.hand(110, 240, 36, "start 28.09", { color: "#1565c0" }, rand);
  c.line(400, 80, 400, 540, { stroke: "#e0e0e0", sw: 3 });
  c.hand(470, 140, 48, "BANANOWA", { color: "#2e7d32", weight: "bold" }, rand);
  c.hand(490, 240, 36, "start 5.10", { color: "#2e7d32" }, rand);
  return { file: "whiteboard.svg", svg: c.svg() };
}

function buildI06() {
  const rand = prng(106);
  const c = doc({ w: 800, h: 600, bg: "#fdfcf7", desc: "Szkic układu płytek na papierze w kratkę: pomieszczenie 14,4 m², dopisek zapas 10%." });
  grid(c);
  c.rect(140, 120, 480, 360, { stroke: "#1c2f6e", sw: 3 });
  for (let x = 140 + 60; x < 620; x += 60) c.line(x, 120, x, 480, { stroke: "#9db3cc", sw: 1 });
  for (let y = 120 + 60; y < 480; y += 60) c.line(140, y, 620, y, { stroke: "#9db3cc", sw: 1 });
  c.hand(160, 100, 34, "14,4 m²", { color: "#7a1f1f", weight: "bold" }, rand);
  c.hand(200, 540, 30, "zapas 10%", { color: "#1c2f6e" }, rand);
  return { file: "tile-layout.svg", svg: c.svg() };
}

function buildI07() {
  const c = doc({ w: 600, h: 800, bg: "#ffffff", desc: "Wydruk oferty 41/2026: Termin realizacji: 20.10.2026, data podpisania 12.09.2026." });
  c.print(60, 90, 28, "OFERTA nr 41/2026", { weight: "bold" });
  c.line(60, 110, 540, 110, { stroke: "#111", sw: 2 });
  c.print(60, 170, 16, "Przedmiot: remont łazienki, płytki gres (dane syntetyczne)");
  c.print(60, 380, 20, "Termin realizacji: 20.10.2026", { weight: "bold" });
  c.print(60, 700, 16, "podpisano: 12.09.2026");
  c.line(60, 710, 260, 710, { stroke: "#111", sw: 1 });
  return { file: "quote.svg", svg: c.svg() };
}

function buildI08() {
  const c = doc({ w: 800, h: 600, bg: "#ffffff", desc: "Wydruk listy materiałów z nagłówkiem SZACUNEK: klej 320 zł, grunty 140 zł, silikony 90 zł, płytki 3 650 zł, razem ~ 4 200 zł." });
  c.print(60, 80, 24, "SZACUNEK — MATERIAŁY", { weight: "bold" });
  c.line(60, 100, 740, 100, { stroke: "#111", sw: 2 });
  const rows = [
    ["klej", "320 zł"],
    ["grunty", "140 zł"],
    ["silikony", "90 zł"],
    ["płytki", "3 650 zł"],
  ];
  rows.forEach(([name, value], i) => {
    c.print(60, 150 + i * 40, 18, name);
    c.print(640, 150 + i * 40, 18, value, { anchor: "end" });
  });
  c.line(60, 330, 740, 330, { stroke: "#111", sw: 1 });
  c.print(560, 380, 22, "razem ~ 4 200", { anchor: "end", weight: "bold" });
  return { file: "estimate.svg", svg: c.svg() };
}

function buildI09() {
  const rand = prng(109);
  const c = doc({ w: 800, h: 600, bg: "#efe9da", desc: "Tablica na budowie, odręcznie: BANAN — płytki GRIS, BANANOWA — płytki BIAŁE." });
  c.rect(60, 60, 680, 480, { fill: "#f7f3e8", stroke: "#8a7f6b", sw: 4 });
  c.hand(100, 170, 44, "BANAN — płytki GRIS", { color: "#16324f", weight: "bold" }, rand);
  c.hand(100, 330, 44, "BANANOWA — płytki BIAŁE", { color: "#7a1f1f", weight: "bold" }, rand);
  return { file: "site-board.svg", svg: c.svg() };
}

function buildI10() {
  const c = doc({ w: 800, h: 600, bg: "#ffffff", desc: "Wydruk kalendarza PAŹDZIERNIK 2026; 15 października zakreślone na czerwono z dopiskiem wpłata 5 000." });
  c.print(60, 70, 26, "PAŹDZIERNIK 2026", { weight: "bold", spacing: "2" });
  const cols = ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"];
  const x0 = 60;
  const y0 = 110;
  const cw = 96;
  const ch = 78;
  cols.forEach((name, i) => c.print(x0 + i * cw + 12, y0 + 24, 16, name, { weight: "bold" }));
  // October 2026 starts on Thursday (index 3, Monday-first).
  let col = 3;
  let row = 0;
  for (let day = 1; day <= 31; day++) {
    const x = x0 + col * cw;
    const y = y0 + row * ch;
    c.print(x + 12, y + 46, 18, String(day), day === 15 ? { color: "#c62828", weight: "bold" } : {});
    if (day === 15) c.ellipse(x + 24, y + 40, 26, 22);
    col++;
    if (col > 6) {
      col = 0;
      row++;
    }
  }
  c.print(60, 560, 24, "wpłata 5 000", { color: "#c62828", weight: "bold" });
  return { file: "calendar.svg", svg: c.svg() };
}

function buildI11() {
  const c = doc({ w: 800, h: 600, bg: "#ffffff", desc: "Rysunek techniczny z trzema wymiarami: 1200 mm, 80 cm, 3,5 m — jednostki oryginalne, bez przeliczeń." });
  c.rect(120, 160, 520, 280, { stroke: "#111", sw: 2 });
  c.line(120, 120, 640, 120, { stroke: "#111", sw: 1 });
  c.line(120, 110, 120, 130, { stroke: "#111", sw: 1 });
  c.line(640, 110, 640, 130, { stroke: "#111", sw: 1 });
  c.print(310, 105, 20, "1200 mm", { anchor: "middle" });
  c.line(680, 160, 680, 440, { stroke: "#111", sw: 1 });
  c.line(670, 160, 690, 160, { stroke: "#111", sw: 1 });
  c.line(670, 440, 690, 440, { stroke: "#111", sw: 1 });
  c.print(712, 310, 20, "80 cm");
  c.line(240, 500, 520, 500, { stroke: "#111", sw: 1 });
  c.print(340, 540, 20, "3,5 m");
  return { file: "dimensions.svg", svg: c.svg() };
}

function buildI12() {
  const rand = prng(112);
  const c = doc({ w: 800, h: 600, bg: "#f6f2e4", desc: "Odręczna notatka: Faktura Kowalski; kwota 7 200 zł przekreślona, obok poprawiona na 7 900 zł z dopiskiem była 7 2." });
  ruled(c);
  c.hand(90, 160, 40, "Faktura Kowalski", { color: "#16324f", weight: "bold" }, rand);
  c.hand(130, 260, 44, "7 200 zł", { color: "#999999" }, rand);
  c.line(120, 246, 360, 254, { stroke: "#7a1f1f", sw: 4 });
  c.hand(430, 260, 48, "7 900 zł", { color: "#7a1f1f", weight: "bold" }, rand);
  c.hand(150, 380, 28, "była 7 2", { color: "#7a1f1f" }, rand);
  return { file: "corrected-invoice.svg", svg: c.svg() };
}

function buildM03() {
  const rand = prng(203);
  const c = doc({ w: 800, h: 600, bg: "#8a7f6b", desc: "Kartka z odręcznym zapisem: ŁAZIENKA — 6 500 zł. Brak nazwy projektu." });
  c.rect(140, 90, 520, 440, { fill: "#f6e58d", stroke: "#e0c96a", sw: 2 });
  c.hand(210, 220, 46, "ŁAZIENKA", { color: "#1c2f6e", weight: "bold" }, rand);
  c.hand(230, 330, 56, "6 500 zł", { color: "#16324f", weight: "bold" }, rand);
  return { file: "quote-note.svg", svg: c.svg() };
}

function buildM05() {
  const c = doc({ w: 600, h: 800, bg: "#ffffff", desc: "Wydruk FV 12/2026, projekt BANAN, płytki 60×60, ilość 20 m²." });
  c.print(60, 90, 26, "FV 12/2026", { weight: "bold" });
  c.line(60, 110, 540, 110, { stroke: "#111", sw: 2 });
  c.print(60, 170, 18, "Projekt: BANAN");
  c.print(60, 240, 18, "płytki 60×60");
  c.print(360, 240, 18, "20 m²");
  return { file: "delivery-note.svg", svg: c.svg() };
}

const SPECS = {
  I01: buildI01,
  I02: buildI02,
  I03: buildI03,
  I04: buildI04,
  I05: buildI05,
  I06: buildI06,
  I07: buildI07,
  I08: buildI08,
  I09: buildI09,
  I10: buildI10,
  I11: buildI11,
  I12: buildI12,
  M03: buildM03,
  M05: buildM05,
};

// ---------------------------------------------------------------------------

const results = [];
for (const [caseId, build] of Object.entries(SPECS)) {
  const { file, svg } = build();
  const caseDir = join(CASES, caseId);
  writeFileSync(join(caseDir, file), svg, "utf8");
  const sha = createHash("sha256").update(svg, "utf8").digest("hex");

  const caseJsonPath = join(caseDir, "case.json");
  const kase = JSON.parse(readFileSync(caseJsonPath, "utf8"));
  let patched = 0;
  for (const source of kase.sources ?? []) {
    for (const part of source.parts ?? []) {
      if (part.type === "image" && part.asset === file) {
        part.assetProvenance = { ...part.assetProvenance, status: "generated", sha256: sha };
        patched++;
      }
    }
  }
  if (patched === 0) throw new Error(`${caseId}: no image part references ${file}; fixture and generator disagree`);
  writeFileSync(caseJsonPath, JSON.stringify(kase, null, 2) + "\n", "utf8");
  results.push({ caseId, file, sha256: sha.slice(0, 16) + "...", bytes: Buffer.byteLength(svg) });
}

console.log("Generated deterministic SVG assets (idempotent; sha256 recorded into case fixtures):");
for (const r of results) console.log(`  ${r.caseId}  ${r.file.padEnd(22)} ${r.bytes} B  ${r.sha256}`);
