/**
 * The D2 acceptance gate: the all-attachments-durable verification D1's
 * acceptance transaction runs BEFORE its first insert.
 *
 * `acceptSource` checks ALL attachment references (architecture protocol
 * step 3): the upload's declaration must be fully materialized, every
 * attachment durably completed in R2 (gateway-verified) and every attachment
 * carrying a VERIFIED received representation. The saved receipt is issued
 * only after this gate passes — a source can never appear saved while any
 * required attachment is missing or unverified.
 *
 * This module lives in the D2 uploads fragment; D1's acceptance.ts calls it
 * from its reference-check phase so the gate keeps D1's structural
 * pre-flight pattern (a failing gate returns a typed error envelope with
 * nothing written).
 */

import type { ClosedError } from "@kiero/contracts";
import { validationError, conflictError } from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { decideAttachmentGate } from "./protocol";

/** The verified attachment ids plus whether the upload row must be bound. */
export interface AcceptanceAttachmentBinding {
  readonly attachmentIds: Id<"attachments">[];
  /** True when at least one attachment exists (ledger row gets bound too). */
  readonly bindLedger: boolean;
}

/** Loads the upload's attachments and runs the pure gate over real rows. */
export async function verifyAttachmentsForAcceptance(
  tx: MutationCtx,
  upload: {
    readonly _id: Id<"uploads">;
    readonly stage: "draft" | "uploading" | "finalized" | "orphaned" | "failed";
    readonly attachmentCount?: number | undefined;
  },
): Promise<{ ok: true; binding: AcceptanceAttachmentBinding } | { ok: false; error: ClosedError }> {
  const attachments = await tx.db
    .query("attachments")
    .withIndex("by_upload", (q) => q.eq("uploadId", upload._id))
    .collect();
  if (attachments.length === 0) {
    // Text-only source: no attachment references to verify (D1's semantics).
    return { ok: true, binding: { attachmentIds: [], bindLedger: false } };
  }
  const representations = [];
  for (const attachment of attachments) {
    const received = await tx.db
      .query("mediaRepresentations")
      .withIndex("by_attachment_role", (q) =>
        q.eq("attachmentId", attachment._id).eq("role", "received"),
      )
      .first();
    if (received !== null) {
      representations.push({
        attachmentId: attachment._id,
        ...(received.verifiedAtMs === undefined ? {} : { verifiedAtMs: received.verifiedAtMs }),
      });
    }
  }
  const decision = decideAttachmentGate(
    upload.stage,
    upload.attachmentCount,
    attachments.map((row) => ({
      _id: row._id,
      uploadId: row.uploadId,
      kind: row.kind,
      ...(row.completedAtMs === undefined ? {} : { completedAtMs: row.completedAtMs }),
      ...(row.sourceId === undefined ? {} : { sourceId: row.sourceId }),
    })),
    representations,
  );
  if (!decision.ok) {
    // Declaration/binding mismatches are conflicts; durability gaps are
    // validation refusals. Both leave nothing written.
    return {
      ok: false,
      error:
        decision.code === "attachment_already_bound"
          ? conflictError(decision.code)
          : validationError(decision.code),
    };
  }
  return {
    ok: true,
    binding: {
      attachmentIds: decision.attachmentIds as Id<"attachments">[],
      bindLedger: decision.attachmentIds.length > 0,
    },
  };
}
