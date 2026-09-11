/**
 * The statement-to-source send loop (J1's proved path, one shared home;
 * H2 review round 1): the ONLY way a boss's spoken statement becomes a
 * durable accepted source on the client.
 *
 * `sources.prepareUpload` (the text-only source's durable upload row) then
 * `sources.acceptSource`, with ONE idempotency key per logical statement:
 * the key is the prepareUpload draft id AND the accept idempotency key
 * (never two unrelated fresh keys), and it rotates only after a CONFIRMED
 * acceptance. A lost response retried with the same key therefore hits the
 * server's acceptance-key uniqueness and converges on the ONE source that
 * may already exist; a resubmit can never accept the same statement as a
 * second source.
 *
 * The conversation surface (H1) and the extension value recording (H2)
 * both ride this module; the pure `sendStatementAsSource` half is the
 * deterministic test surface for the convergence property.
 */

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { Schema } from "effect";
import {
  sourcesOperations,
  newIdempotencyKey,
  type CommandEnvelope,
  type IdempotencyKey,
  type ResultEnvelope,
} from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import { envelopeOf } from "./CompanyGate";

/** The typed result shapes of the two send commands (contract authority). */
const prepareUploadResult = sourcesOperations["sources.prepareUpload"].result;
const acceptSourceResult = sourcesOperations["sources.acceptSource"].result;

/** The typed receipt of one accepted source (contract authority). */
export type AcceptSourceReceipt = Schema.Schema.Type<typeof acceptSourceResult>;

/** One logical statement the boss sends: the text plus its send context. */
export interface StatementForSource {
  readonly authorText: string;
  readonly timezoneSnapshot: string;
  readonly projectHints: readonly string[];
}

/**
 * One send's outcome: `accepted` with the source's receipt, `refused` with
 * the closed error, or `lost` when the response never came back (the
 * statement MAY already be a durable source; the same key retries safely).
 */
export type StatementSendOutcome =
  | { readonly _tag: "accepted"; readonly receipt: AcceptSourceReceipt }
  | { readonly _tag: "refused"; readonly code: string; readonly message: string }
  | { readonly _tag: "lost" };

/** The two command mutations the loop rides (injectable for the tests). */
export interface StatementSourceMutations {
  readonly prepareUpload: (args: { readonly envelope: CommandEnvelope }) => Promise<ResultEnvelope>;
  readonly acceptSource: (args: { readonly envelope: CommandEnvelope }) => Promise<ResultEnvelope>;
}

/**
 * A fresh idempotency key per logical statement: the contract's own
 * certified constructor (`idem_` + v4-uuid from the baseline CSPRNG), the
 * one source of that shape instead of per-surface copies.
 */
export function freshStatementKey(): IdempotencyKey {
  return newIdempotencyKey();
}

/**
 * The key discipline, pure: one key per logical statement, rotated only
 * after a CONFIRMED acceptance. A refusal keeps the key (the statement may
 * be edited and resent); a lost response keeps the key (the retry must hit
 * the server's acceptance-key uniqueness, not mint a second source).
 */
export function nextStatementKey(current: IdempotencyKey, outcome: StatementSendOutcome): IdempotencyKey {
  return outcome._tag === "accepted" ? freshStatementKey() : current;
}

/**
 * Sends one logical statement as a real accepted source, under `idemKey`.
 * The SAME key rides the prepareUpload draft id and the acceptSource
 * idempotency key; a thrown response (network lost) is reported as `lost`
 * so the caller retries the SAME key.
 */
export async function sendStatementAsSource(
  mutations: StatementSourceMutations,
  idemKey: IdempotencyKey,
  statement: StatementForSource,
): Promise<StatementSendOutcome> {
  try {
    const prepared = await mutations.prepareUpload({
      envelope: envelopeOf("sources.prepareUpload", {
        draftId: idemKey,
        parts: 1,
        mediaKinds: [],
      }),
    });
    if (prepared._tag === "error") {
      return { _tag: "refused", code: prepared.error.code, message: prepared.error.message };
    }
    const upload = Schema.decodeUnknownSync(prepareUploadResult)(prepared.value);
    const accepted = await mutations.acceptSource({
      envelope: {
        operation: "sources.acceptSource",
        input: {
          uploadId: upload.uploadId,
          authorText: statement.authorText,
          timezoneSnapshot: statement.timezoneSnapshot,
          projectHints: [...statement.projectHints],
        },
        expectedRevisions: [],
        idempotencyKey: idemKey,
      },
    });
    if (accepted._tag === "error") {
      return { _tag: "refused", code: accepted.error.code, message: accepted.error.message };
    }
    const receipt = Schema.decodeUnknownSync(acceptSourceResult)(accepted.value);
    return { _tag: "accepted", receipt };
  } catch {
    // Unknown response (network lost): the caller MUST retry the same key,
    // so the server's acceptance-key uniqueness answers with the source
    // that may already exist, never a duplicate.
    return { _tag: "lost" };
  }
}

/** The hook every statement-sending surface rides: the key state plus the send. */
export function useStatementSource(): {
  /** Sends the current logical statement under its ONE idem key. */
  readonly send: (statement: StatementForSource) => Promise<StatementSendOutcome>;
} {
  const [idemKey, setIdemKey] = useState(freshStatementKey);
  const prepareUpload = useMutation(api.sources.uploads.commands.prepareUploadCommand);
  const acceptSource = useMutation(api.sources.accept.commands.acceptSourceCommand);

  const send = useCallback(
    async (statement: StatementForSource): Promise<StatementSendOutcome> => {
      const outcome = await sendStatementAsSource({ prepareUpload, acceptSource }, idemKey, statement);
      // Rotation is part of the send, not the caller's duty: only a
      // confirmed acceptance completes the logical statement and mints the
      // next one's key. The callers serialize sends behind their busy
      // state, so a resubmit after a lost response re-enters here with the
      // SAME key and converges on one source.
      setIdemKey((current) => nextStatementKey(current, outcome));
      return outcome;
    },
    [prepareUpload, acceptSource, idemKey],
  );

  return { send };
}
