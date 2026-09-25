/**
 * The EU container's own HTTP entry: a zero-dependency Node server the
 * Dockerfile starts on $PORT. Cloudflare Containers proxy HTTP to this
 * process through the app's Durable Object — and the protocol it serves is
 * the ONE shared handler (./segment-service.ts `handleMediaProtocol`), the
 * same code the Worker entry and the DO run. This file only adapts
 * node:http streams to a Web `Request` and writes the handler's `Response`
 * back: there is no second copy of the boundary to drift.
 *
 * This surface is where FFmpeg conversion lives (the image ships the
 * binary; the isolates cannot spawn). At startup the process verifies the
 * binary once and injects the converter into the shared handler when — and
 * only when — it is actually there; /healthz then states the verified truth
 * instead of an image-build assumption.
 *
 * Node >= 22.12 runs this file directly with type stripping
 * (`node --experimental-strip-types`), so the image needs no build step and
 * no added dependency; intra-app imports therefore carry explicit `.ts`
 * extensions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleMediaProtocol, type ProtocolDeps } from "./segment-service.ts";
import { ffmpegAvailability, ffmpegConverter } from "./convert.ts";

const PORT = Number(process.env.PORT ?? 8080);

// Verified once at startup: converter present only when ffmpeg answers.
const availability = await ffmpegAvailability();
const deps: ProtocolDeps = availability.ok
  ? { converter: ffmpegConverter(), conversionHealth: "ffmpeg-bounded" }
  : { conversionHealth: "ffmpeg-unavailable" };

function reply(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  return new Request(url, {
    method: request.method ?? "GET",
    headers,
    ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
  });
}

const server = createServer((request, response) => {
  void (async () => {
    const webRequest = await toWebRequest(request);
    const served = await handleMediaProtocol(webRequest, process.env, deps);
    reply(
      response,
      served.status,
      await served.text(),
      served.headers.get("content-type") ?? "application/json",
    );
  })().catch(() => reply(response, 500, JSON.stringify({ ok: false, code: "internal" }), "application/json"));
});

server.listen(PORT, () => {
  process.stdout.write(`media-worker container listening on ${PORT}\n`);
});
