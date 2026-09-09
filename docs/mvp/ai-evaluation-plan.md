# AI evaluation plan

Accepted in Q198, with the application-owned lineup clarified through Q206. This is a test design, not a benchmark result. No inference request or real-source upload was executed during architecture planning.

## Corpus and expected outcomes

Start with about 50 representative Polish cases: 14 text, 16 voice, 12 image and 8 mixed follow-up cases. Use independently grounded expected results. For each case record starting company/project state, source material and anchors, expected current facts/changes, required clarifications, prohibited interpretations and any later correction.

Cover noisy speech, names, amounts, self-corrections, relative dates, date-only versus timed/ranged agreements, unknown net/gross basis, approximate versus agreed prices, handwriting, technical dimensions, similar project names/codenames, mixed-project messages and incomplete evidence. Include newer corrections while old analysis is in flight, source withdrawal/deletion and independent corroboration.

Use synthetic or deliberately approved samples with explicit provenance. Do not derive the answer key solely from the model under test. Keep the same fixed cases when comparing configurations and record deliberate corpus changes separately.

## Selected candidates

- Conversational analysis: `z-ai/glm-5.3-flash`, then `google/gemini-3.8-flash`, then `deepseek/deepseek-v4-flash-0731`.
- Image extraction: GLM then Gemini. DeepSeek uses text and completed visual extraction only.
- Transcription: `microsoft/mai-transcribe-2`, with `openai/whisper-large-v3` backup. MAI's disclosed public-preview/no-SLA status remains a candidate limitation.
- Semantic retrieval: `qwen/qwen3-embedding-8b`, initially proving native 4096 dimensions with Convex and versioned query/document preparation.

## Measurements

Report STT fidelity/timing, vision extraction, retrieval recall and final memory publication separately, then report the complete path. Record actual model/provider, configuration/prompt/schema version, latency to first useful output, total processing time, attempts and metered cost.

The GLM throughput target exceeds 100 output tokens per second where compatible routes permit it. Temporary useful slower responses are accepted. Catalog or provider aggregate speeds are not Kiero observations. Test timeouts, rate limits, unavailable routes, unsupported tool/schema parameters, interrupted streams and unknown external outcomes. Prove the configured order and that no model/tool output bypasses checked domain operations.

Do not count a readable answer as success when it has the wrong amount, date, project, commitment status or source basis. A required clarification is a correct outcome when evidence is insufficient. Separate provider unavailability from incorrect reasoning. Missing transcription segments and unprocessed images remain explicitly incomplete.

## Relation to alpha readiness

This corpus supplies repeatable engineering evidence, not the full live-alpha result. Keep the accepted target of 95% of ordinary sources processed within 60 seconds after full durable acceptance. The ordinary measurement class includes text, one photo or audio up to two minutes; this is not a product duration limit.

The four-week live alpha still measures weekly source-backed answers, actual use by both bosses and critical mistakes under the existing alpha contract. GM-assisted fixes do not count as autonomous success. Re-run affected cases after changes to models, prompts, routes, extraction or schema behavior. Record failures and remediation before widening the alpha.
