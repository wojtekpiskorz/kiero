/**
 * The E4 proof-side normalizer proxy: the remote normalizer stand-in the
 * deployed gateway's remoteNormalizer adapter calls (the D5 swap while the
 * Cloudflare Images binding requires the paid plan), EXTENDED with a
 * recording ledger: every response's exact bytes are kept (keyed by the
 * request's input sha) so the live proof can order the vision proof
 * channel with BYTE-IDENTICAL bytes to the retained object the gateway
 * wrote — the contentHash pin then holds by construction, not by
 * re-encoding luck.
 *
 * The normalization recipe is tests/d5/normalizer.mjs's verbatim (this
 * repo's sharp): EXIF rotation baked in, bounded longest edge, WebP
 * re-encode. Responses are recorded to /tmp/e4-normalized/<input-sha>.webp.
 *
 * Run: KIERO_NORMALIZER_PORT=8792 node tests/e4/normalizer-proxy.mjs
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";

const PORT = Number(process.env.KIERO_NORMALIZER_PORT ?? 8792);
const LEDGER_DIR = "/tmp/e4-normalized";
mkdirSync(LEDGER_DIR, { recursive: true });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function normalize(bytes, kind, maxEdge, quality) {
  const pipeline = sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality, effort: 4 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    bytesBase64: data.toString("base64"),
    width: info.width,
    height: info.height,
    mimeType: "image/webp",
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const kind = url.searchParams.get("kind") === "thumbnail" ? "thumbnail" : "retained";
  const maxEdge = Number(url.searchParams.get("maxEdge") ?? 4096);
  const quality = Number(url.searchParams.get("quality") ?? 85);
  try {
    const output = await normalize(bytes, kind, maxEdge, quality);
    if (kind === "retained") {
      // Record the EXACT response bytes keyed by the input's sha: the proof
      // reads the matching record to place the contentHash-pinned order.
      // (mkdir on every write: the ledger dir is disposable proof state.)
      mkdirSync(LEDGER_DIR, { recursive: true });
      writeFileSync(`${LEDGER_DIR}/${sha256(bytes)}.webp`, Buffer.from(output.bytesBase64, "base64"));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(output));
  } catch {
    response.writeHead(422, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "normalization_failed" }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`e4 normalizer proxy (recording) listening on 127.0.0.1:${PORT}`);
});
