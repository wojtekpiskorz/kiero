/**
 * E2 focused verification: the serializable per-route wire payloads.
 *
 * The wire payload must agree with the typed request shape (review finding
 * 3): chat turns offer only `user` and `assistant` roles — system
 * instructions travel through the typed request's `systemPrompt` — and each
 * payload kind is discriminated so a route/payload mismatch is a typed
 * rejection, never a silent coercion.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ChatAnalysisPayload, ProviderPayload } from "@kiero/providers";

const decodeChat = Schema.decodeUnknownOption(ChatAnalysisPayload);
const decodeUnion = Schema.decodeUnknownOption(ProviderPayload);

describe("wire payload contracts", () => {
  it("accepts user and assistant turns", () => {
    const decoded = decodeChat({
      kind: "chat_analysis",
      messages: [
        { role: "user", text: "wycena na Bananie" },
        { role: "assistant", text: "pytanie o termin" },
        { role: "user", text: "do piatek" },
      ],
    });
    expect(decoded._tag).toBe("Some");
  });

  it("rejects a system role: system instructions are the request's systemPrompt", () => {
    const decoded = decodeChat({
      kind: "chat_analysis",
      messages: [{ role: "system", text: "jestes asystentem firmy" }],
    });
    expect(decoded._tag).toBe("None");
    // The union rejects it too: nothing coerces it into a user turn.
    const union = decodeUnion({
      kind: "chat_analysis",
      messages: [{ role: "system", text: "jestes asystentem firmy" }],
    });
    expect(union._tag).toBe("None");
  });

  it("rejects empty message lists and blank text", () => {
    expect(decodeChat({ kind: "chat_analysis", messages: [] })._tag).toBe("None");
    expect(
      decodeChat({ kind: "chat_analysis", messages: [{ role: "user", text: "" }] })._tag,
    ).toBe("None");
  });

  it("discriminates the four route payload kinds", () => {
    expect(
      decodeUnion({ kind: "embedding", text: "wycena", inputKind: "search_document" })._tag,
    ).toBe("Some");
    expect(
      decodeUnion({
        kind: "speech_to_text",
        audioBase64: "c2lub3NvZmZmZmZm",
        audioFormat: "wav",
        language: "pl",
      })._tag,
    ).toBe("Some");
    expect(
      decodeUnion({
        kind: "vision_extraction",
        instruction: "opisz obrazek",
        images: [{ base64: "c2lub3NvZmZmZmZm", mimeType: "image/png" }],
      })._tag,
    ).toBe("Some");
    expect(decodeUnion({ kind: "something_else" })._tag).toBe("None");
  });
});
