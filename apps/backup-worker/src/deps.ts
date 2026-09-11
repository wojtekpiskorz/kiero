/**
 * The container-side dependency wiring (I5): builds the real BackupDeps from
 * the container runtime env (the DO class forwards the Worker's vars and
 * secrets by NAME). NODE-ONLY (imports the CLI exporter); the Worker surface
 * never imports this file - it proxies to the container.
 *
 * Every missing credential produces a typed not-configured stub so a run
 * still executes the protocol (lease attempt, heartbeat, honest failure)
 * instead of silently doing nothing - the D6 honest-pending pattern.
 */

import { ConvexCliExporter } from "./convex-export.ts";
import { convexProtocol } from "./convex-protocol.ts";
import { s3BackupStore, s3MediaReader } from "./s3r2.ts";
import type {
  BackupDeps,
  BackupProtocol,
  BackupStore,
  BackupWorkerEnv,
  DatabaseExporter,
  MediaReader,
} from "./ports.ts";

export type { BackupWorkerEnv };

/** The exporter stub used when the container image pre-installed nothing. */
class NotConfiguredExporter implements DatabaseExporter {
  async export(): Promise<{ ok: false; code: "export_not_configured" }> {
    return { ok: false, code: "export_not_configured" };
  }
}

class NotConfiguredStore implements BackupStore {
  async head(): Promise<{ ok: false; code: "store_not_configured" }> {
    return { ok: false, code: "store_not_configured" };
  }
  async put(): Promise<{ ok: false; code: "store_not_configured" }> {
    return { ok: false, code: "store_not_configured" };
  }
  async get(): Promise<{ ok: false; code: "store_not_configured" }> {
    return { ok: false, code: "store_not_configured" };
  }
  async delete(): Promise<void> {}
  async list(): Promise<readonly { key: string; bytes: number; lastModifiedMs: number }[]> {
    return [];
  }
}

class NotConfiguredMedia implements MediaReader {
  async get(): Promise<{ ok: false; code: "media_not_configured" }> {
    return { ok: false, code: "media_not_configured" };
  }
}

/**
 * The typed not-configured refusal set (review round 2 finding 4): every
 * method answers its channel's closed refusal instead of throwing an
 * untyped error that surfaces as 500 internal.
 */
class NotConfiguredProtocol implements BackupProtocol {
  async begin(): Promise<ProtocolBegin> {
    return { status: "refused", reason: "convex_protocol_not_configured" };
  }
  async complete(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: "convex_protocol_not_configured" };
  }
  async fail(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: "convex_protocol_not_configured" };
  }
  async sweep(): Promise<ProtocolSweepPlan> {
    // An empty plan with zero deletable keys: the sweep is a no-op until
    // the protocol exists, which is the honest typed answer.
    return {
      plan: { expiredSets: [], survivingReferences: [], deletableObjectKeys: [] },
      referencedByAnyManifest: [],
    };
  }
  async sweepComplete(): Promise<{ collected: number; replayed: number; prunedFailed: number; skipped: number }> {
    return { collected: 0, replayed: 0, prunedFailed: 0, skipped: 0 };
  }
}

/** Builds the real deps with typed not-configured fallbacks per channel. */
export function buildBackupDeps(env: BackupWorkerEnv): BackupDeps {
  const protocol = convexProtocol(env);
  const store = s3BackupStore(env);
  const media = s3MediaReader(env);
  const exporter =
    env.CONVEX_EXPORT_DEPLOYMENT !== undefined && env.CONVEX_EXPORT_DEPLOYMENT !== ""
      ? new ConvexCliExporter(env)
      : new NotConfiguredExporter();
  return {
    protocol: "notConfigured" in protocol ? new NotConfiguredProtocol() : protocol,
    exporter,
    media: "notConfigured" in media ? new NotConfiguredMedia() : media,
    store: "notConfigured" in store ? new NotConfiguredStore() : store,
  };
}
