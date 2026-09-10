/**
 * The text-encoded tool-call rescue (E6): the inherited flash-model
 * defect fix, pure and deterministic so it stays unit-testable.
 *
 * When the model writes `{"narzedzie":...,"argumenty":...}` as PROSE
 * instead of a real tool call, the loop still decodes it through the
 * DECLARED tool's schema — the same decode authority, fail-closed on any
 * malformed shape — and hands it to the same reducer/checked paths. No
 * gate is bypassed: an undeclared name or undecodable arguments make
 * this return nothing and the turn stays plain text.
 */

import { Schema } from "effect";
import { ANSWER_TOOLS } from "./tools";
import type { DecodedAnswerCall } from "./reducer";

/**
 * Extracts text-encoded tool calls from one model turn's text: each
 * `{"narzedzie":...,"argumenty":...}` object whose name matches a
 * DECLARED tool and whose arguments decode against that tool's schema
 * becomes a decoded call (with a generated `text-N` id); everything
 * else stays plain text.
 */
export function parseTextToolCalls(text: string): DecodedAnswerCall[] {
  const calls: DecodedAnswerCall[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const marker = text.indexOf('"narzedzie"', cursor);
    if (marker === -1) {
      break;
    }
    // Walk back to the nearest opening brace, forward to its match.
    let start = -1;
    for (let i = marker; i >= 0; i -= 1) {
      if (text[i] === "{") {
        start = i;
        break;
      }
      if (text[i] === "}") {
        break; // a closer before an opener: not an object start
      }
    }
    if (start === -1) {
      cursor = marker + 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      cursor = marker + 1;
      continue;
    }
    cursor = end + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const candidate = parsed as { narzedzie?: unknown; argumenty?: unknown };
    if (typeof candidate.narzedzie !== "string") {
      continue;
    }
    const spec = ANSWER_TOOLS.find((tool) => tool.name === candidate.narzedzie);
    if (spec === undefined) {
      continue; // undeclared name: stays text, never widens the surface
    }
    try {
      const arguments_ = Schema.decodeUnknownSync(spec.input)(candidate.argumenty);
      calls.push({ id: `text-${calls.length}`, name: spec.name, arguments: arguments_ });
    } catch {
      // Malformed arguments: the call stays unexecutable (fail closed).
    }
  }
  return calls;
}
