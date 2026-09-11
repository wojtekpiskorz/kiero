# EU export container image (I3). Bounded, honest:
# - Node 22 slim only: the bounded archive assembly (streaming ZIP of JSON,
#   an escaped HTML index and stored media copies) needs no media tooling —
#   no ffmpeg, no build step (the flag is --experimental-transform-types:
#   strip-only mode cannot parse the TypeScript parameter property the
#   archive writer's own module uses, zip.ts's ByteSink constructor; the
#   I5 backup-worker finding).
# - No credentials are baked in: the media S3 token, the service credential
#   and the Convex endpoint arrive as container runtime env (forwarded by
#   the DO class in src/index.ts), never as image layers.
# - linux/amd64 explicitly: local docker on arm64 Macs would otherwise
#   build an arm64 image the Cloudflare Container VM cannot run (the D6
#   media-worker finding).
# - The image MIRRORS THE REPO LAYOUT for the one cross-tree import the
#   container carries (the zero-dependency half of the export protocol,
#   convex/operations/exports/protocol.ts, imported by service.ts and
#   render.ts): from /app/apps/export-worker/src the ../../../convex/...
#   specifier resolves exactly as in the repo, so the container boots with
#   the SAME module the Worker bundles (the I5 backup-worker precedent).
#   wrangler.jsonc sets image_build_context to the repo root (the root
#   .dockerignore keeps that context to just these paths).
FROM --platform=linux/amd64 node:22-slim

WORKDIR /app/apps/export-worker
COPY apps/export-worker/src /app/apps/export-worker/src
COPY convex/operations/exports/protocol.ts /app/convex/operations/exports/protocol.ts

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--experimental-transform-types", "src/container-main.ts"]
