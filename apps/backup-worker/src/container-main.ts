/**
 * The EU container's own HTTP entry (I5): a zero-dependency Node server the
 * Dockerfile starts on $PORT (the D6 container-main pattern). Cloudflare
 * Containers proxy HTTP to this process through the app's Durable Object,
 * and the protocol it serves is the ONE shared handler
 * (./backup-service.ts) with the REAL deps built from the container env
 * (./deps.ts). No second copy of the boundary exists to drift.
 *
 * Node >= 22.12 runs this file directly with type transformation
 * (`node --experimental-transform-types`; strip-only mode cannot parse the
 * parameter properties in ports.ts/convex-export.ts), so the image needs
 * no build step and no added dependency; intra-app imports therefore carry
 * explicit `.ts` extensions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleBackupProtocol } from "./backup-service.ts";
import { buildBackupDeps } from "./deps.ts";
import type { BackupWorkerEnv } from "./ports.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DEPS = buildBackupDeps(process.env as unknown as BackupWorkerEnv);

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
    const served = await handleBackupProtocol(webRequest, process.env, DEPS);
    reply(
      response,
      served.status,
      await served.text(),
      served.headers.get("content-type") ?? "application/json",
    );
  })().catch(() => reply(response, 500, JSON.stringify({ ok: false, code: "internal" }), "application/json"));
});

server.listen(PORT, () => {
  process.stdout.write(`backup-worker container listening on ${PORT}\n`);
});
