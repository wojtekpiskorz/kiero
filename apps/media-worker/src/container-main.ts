/**
 * The EU container's own HTTP entry (D6): a zero-dependency Node server the
 * Dockerfile starts on $PORT. Cloudflare Containers proxy HTTP to this
 * process through the app's Durable Object — and the protocol it serves is
 * the ONE shared handler (./segment-service.ts `handleMediaProtocol`), the
 * same code the Worker entry and the DO run. This file only adapts
 * node:http streams to a Web `Request` and writes the handler's `Response`
 * back: there is no second copy of the boundary to drift.
 *
 * Node >= 22.12 runs this file directly with type stripping
 * (`node --experimental-strip-types`), so the image needs no build step and
 * no added dependency; intra-app imports therefore carry explicit `.ts`
 * extensions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleMediaProtocol } from "./segment-service.ts";

const PORT = Number(process.env.PORT ?? 8080);

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
    const served = await handleMediaProtocol(webRequest, process.env);
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
