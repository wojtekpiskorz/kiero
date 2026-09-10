/**
 * The local sharp-based photo normalizer (D5 live-proof executor stand-in).
 *
 * This is the REMOTE NORMALIZER the deployed gateway's remoteNormalizer
 * adapter calls while the Cloudflare Images binding requires the paid plan
 * (the BLOCKED-owner-action swap documented in the issue report): one
 * bytes-in/bytes-out endpoint implementing exactly the port contract from
 * apps/gateway/src/images/normalizer.ts —
 *
 *   POST /?kind=retained|thumbnail&maxEdge=N&quality=Q
 *   body: the raw received image bytes
 *   200 { bytesBase64, width, height, mimeType: "image/webp" }
 *
 * EXIF orientation is baked into the pixels (sharp .rotate()), dimensions
 * are bounded to maxEdge on the longest edge without upscaling, and the
 * output is a conservative WebP re-encode at the requested quality — the
 * same recipe the pure protocol's NormalizationPlan names. Fixture
 * generation for the evidence lives in live-proof.mjs, not here: this
 * service only ever normalizes real uploaded bytes.
 *
 * Run: KIERO_NORMALIZER_PORT=8791 node tests/d5/normalizer.mjs
 */

import { createServer } from "node:http";
import sharp from "sharp";

const PORT = Number(process.env.KIERO_NORMALIZER_PORT ?? 8791);

/** The one recipe: bake orientation, bound the longest edge, re-encode. */
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
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(output));
  } catch (error) {
    // A decode/encode failure is the adapter's typed conversion failure
    // (the gateway service records the exception); 422 keeps it definite.
    response.writeHead(422, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "normalization_failed" }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`d5 local normalizer (sharp ${sharp.versions.sharp}) listening on 127.0.0.1:${PORT}`);
});
