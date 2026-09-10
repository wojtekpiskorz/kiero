/**
 * The EU container's own HTTP entry (D6): a zero-dependency Node server the
 * Dockerfile starts on $PORT. It serves the SAME segment protocol as the
 * Worker entry (./index.ts) — bearer-guarded `/probe` and `/segment` over
 * the S3-credential R2 reader — because Cloudflare Containers proxy HTTP to
 * this process through the app's Durable Object.
 *
 * Node >= 22.12 runs this file directly with type stripping
 * (`node --experimental-strip-types`), so the image needs no build step and
 * no added dependency; intra-app imports therefore carry explicit `.ts`
 * extensions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { s3ObjectReader } from "./s3r2.ts";
import { serveSegmentRequest } from "./segment-service.ts";

const PORT = Number(process.env.PORT ?? 8080);

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return reply(response, 200, {
        ok: true,
        environment: process.env.ENVIRONMENT ?? "unknown",
        bytes: "s3-credentials",
        wavSlicing: "exact",
        ffmpegConversion: "container-pending",
      });
    }
    if (request.method !== "POST" || (url.pathname !== "/probe" && url.pathname !== "/segment")) {
      return reply(response, 404, { ok: false, code: "unknown_route" });
    }
    const expected = process.env.MEDIA_SEGMENT_TOKEN ?? "";
    if (expected === "") {
      return reply(response, 503, { ok: false, code: "segment_token_not_configured" });
    }
    const presented = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (presented !== expected) {
      return reply(response, 401, { ok: false, code: "unauthorized" });
    }
    const reader = s3ObjectReader(process.env);
    if (!reader.ok) {
      return reply(response, 503, { ok: false, code: reader.code });
    }
    const served = await serveSegmentRequest(reader.read, await readBody(request));
    return reply(response, served.ok ? 200 : 422, served);
  })().catch(() => reply(response, 500, { ok: false, code: "internal" }));
});

server.listen(PORT, () => {
  process.stdout.write(`media-worker container listening on ${PORT}\n`);
});
