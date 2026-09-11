/**
 * The EU export container's own HTTP entry (I3): a zero-dependency Node
 * server the Dockerfile starts on $PORT (the D6 media-worker pattern).
 * Cloudflare Containers proxy HTTP to this process through the app's
 * Durable Object — and the protocol it serves is the ONE shared handler
 * (./service.ts `handleBuild`/`handleCleanup`/`handleHealth`), the same
 * code the Worker entry and the DO run. This file only adapts node:http
 * streams to a Web `Request` and writes the handler's `Response` back:
 * there is no second copy of the boundary to drift.
 *
 * Node >= 22.12 runs this file directly with type stripping plus
 * transformation (`node --experimental-transform-types`; strip-only mode
 * cannot parse the parameter property in ./zip.ts), so the image needs no
 * build step and no added dependency; intra-app imports therefore carry
 * explicit `.ts` extensions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleBuild, handleCleanup, handleHealth, type ExportWorkerEnv } from "./service.ts";

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

const env = process.env as unknown as ExportWorkerEnv;

const server = createServer((request, response) => {
  void (async () => {
    const webRequest = await toWebRequest(request);
    const url = new URL(webRequest.url);
    let served: Response;
    if (webRequest.method === "GET" && url.pathname === "/healthz") {
      served = handleHealth(env);
    } else if (webRequest.method === "POST" && url.pathname === "/exports/build") {
      served = await handleBuild(webRequest, env);
    } else if (webRequest.method === "POST" && url.pathname === "/exports/cleanup") {
      served = await handleCleanup(webRequest, env);
    } else {
      served = new Response(JSON.stringify({ _tag: "error", error: { _tag: "unsupported", code: "no_such_route" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    reply(response, served.status, await served.text(), served.headers.get("content-type") ?? "application/json");
  })().catch(() => reply(response, 500, JSON.stringify({ ok: false, code: "internal" }), "application/json"));
});

server.listen(PORT, () => {
  process.stdout.write(`export-worker container listening on ${PORT}\n`);
});
