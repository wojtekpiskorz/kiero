/**
 * The photo-normalizer port and its adapters (D5).
 *
 * Q210 selected the Cloudflare Images binding as the normalization
 * executor ("Images binding" in the architecture's provider table): the
 * Worker materializes an optimized object from the received stream through
 * `env.IMAGES.input(stream).transform(...).output({format})` and writes it
 * to private R2. That binding requires the Images PAID plan (research
 * facts, 2026-09-08); until the owner enables it, the same port is served
 * by the REMOTE normalizer adapter — a configured bytes-in/bytes-out
 * endpoint (the local sharp-based proof service) — so the executor swap is
 * configuration, not code: `resolveNormalizer` prefers the binding and
 * falls back to `KIERO_NORMALIZER_URL`, answering the honest typed
 * `unavailable` when neither exists.
 *
 * Both adapters return the same output contract (encoded bytes, baked
 * orientation, bounded dimensions, content type), so the drive logic in
 * ./service.ts and the pure decisions in convex/processing/images/
 * protocol.ts never learn which executor ran.
 */

import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { unavailableError } from "@kiero/runtime";
import type {
  NormalizationPlan,
  SniffedFormat,
} from "../../../../convex/processing/images/protocol";

/** One normalization request the executor must fulfill. */
export interface NormalizerRequest {
  /** Which derived representation this is (archival or presentation). */
  readonly kind: "retained" | "thumbnail";
  readonly bytes: Uint8Array;
  /** Longest-edge bound; downscale only, never upscale. */
  readonly maxEdge: number;
  readonly quality: number;
}

/** One fulfilled normalization. */
export interface NormalizerOutput {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/webp";
}

/** The port every normalizer executor implements. */
export interface PhotoNormalizer {
  /** Stable identifier for evidence (which executor produced the bytes). */
  readonly id: string;
  /** Input formats this executor PROVED it decodes (the decision input). */
  readonly supportedFormats: readonly SniffedFormat[];
  normalize(request: NormalizerRequest): Promise<NormalizerOutput>;
}

/**
 * Structural view of the Cloudflare Images binding (the runtime type lives
 * behind the experimental types edition; the shape used here is exactly the
 * documented pipeline: input -> transform -> output -> response).
 */
interface ImagesBindingLike {
  input(body: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality?: number }): {
        response(): Promise<Response>;
      };
    };
  };
}

/** The Q210-selected executor: the Images binding (requires Images Paid). */
export function imagesBindingNormalizer(binding: ImagesBindingLike): PhotoNormalizer {
  return {
    id: "cloudflare-images-binding",
    // The binding's documented supported-input list (research facts):
    // JPEG, PNG, GIF, WebP, AVIF (Enterprise-only input) and HEIC. The
    // conservative production set excludes AVIF input until the plan proves
    // it; HEIC stays because phones send it.
    supportedFormats: ["jpeg", "png", "webp", "gif", "heic"],
    normalize: async (request) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(request.bytes);
          controller.close();
        },
      });
      const response = await binding
        .input(stream)
        .transform({
          // Downscale so the longest edge fits the bound; the binding never
          // upscales. Orientation: the binding renders EXIF-oriented pixels
          // (non-JPEG output drops the metadata, so orientation must be —
          // and is — baked by the transform).
          width: request.maxEdge,
          height: request.maxEdge,
          fit: "scale-down",
        })
        .output({ format: "image/webp", quality: request.quality })
        .response();
      if (!response.ok) {
        throw new Error(`images binding transform failed: ${response.status}`);
      }
      const output = new Uint8Array(await response.arrayBuffer());
      // The binding's response does not report output dimensions; the drive
      // decodes them from the output bytes for the recorded evidence.
      return { bytes: output, width: 0, height: 0, mimeType: "image/webp" };
    },
  };
}

/** The remote bytes-in/bytes-out adapter (the local sharp proof service). */
export function remoteNormalizer(url: string): PhotoNormalizer {
  return {
    id: `remote-normalizer(${new URL(url).host})`,
    supportedFormats: ["jpeg", "png", "webp", "gif", "avif", "tiff"],
    normalize: async (request) => {
      const target = `${url.replace(/\/$/, "")}?kind=${request.kind}&maxEdge=${request.maxEdge}&quality=${request.quality}`;
      const response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: request.bytes,
      });
      if (!response.ok) {
        throw new Error(`remote normalizer failed: ${response.status}`);
      }
      const payload = (await response.json()) as {
        bytesBase64?: unknown;
        width?: unknown;
        height?: unknown;
        mimeType?: unknown;
      };
      if (
        typeof payload.bytesBase64 !== "string" ||
        typeof payload.width !== "number" ||
        typeof payload.height !== "number" ||
        payload.mimeType !== "image/webp"
      ) {
        throw new Error("remote normalizer response invalid");
      }
      const binary = atob(payload.bytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return { bytes, width: payload.width, height: payload.height, mimeType: "image/webp" };
    },
  };
}

/** The env the images lane's normalizer selection consumes. */
export interface NormalizerEnv {
  /** The Cloudflare Images binding, when the account provides it (paid). */
  readonly IMAGES?: ImagesBindingLike;
  /** The remote normalizer endpoint (the local sharp proof service). */
  readonly KIERO_NORMALIZER_URL?: string;
}

/**
 * Resolves the selected normalizer: the Images binding when the account
 * provides it, else the configured remote endpoint, else the honest typed
 * `unavailable` (a missing executor is never a fake success).
 */
export function resolveNormalizer(
  env: NormalizerEnv,
): { ok: true; normalizer: PhotoNormalizer } | { ok: false; error: ResultEnvelope } {
  if (env.IMAGES !== undefined) {
    return { ok: true, normalizer: imagesBindingNormalizer(env.IMAGES) };
  }
  const remote = env.KIERO_NORMALIZER_URL;
  if (remote !== undefined && remote !== "") {
    return { ok: true, normalizer: remoteNormalizer(remote) };
  }
  return {
    ok: false,
    error: errorResult(unavailableError(true, "images_executor_unavailable")),
  };
}

/** The plan this port fulfills (narrowed view of the protocol's plan). */
export type NormalizerPlan = NormalizationPlan;
