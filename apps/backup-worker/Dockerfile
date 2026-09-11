# EU backup container image (I5). Bounded, honest (the D6 media image
# pattern; no FFmpeg here - the backup executor needs only Node and the
# pinned Convex CLI):
#
# - Node 22 slim; the entry serves the shared backup protocol (/healthz,
#   /run) with zero build steps. The flag is --experimental-transform-types:
#   strip-only mode cannot parse the TypeScript parameter properties the
#   executor's own modules use (ports.ts, convex-export.ts).
# - The pinned Convex CLI is pre-installed GLOBALLY and invoked directly
#   (the `convex` binary), so the headless export never needs network
#   access at runtime; the injected CONVEX_BACKUP_ADMIN_KEY drives it
#   (written to an isolated scratch HOME at runtime, never baked into the
#   image).
# - The image MIRRORS THE REPO LAYOUT for the two cross-tree imports the
#   executor carries (the pure backup decision module
#   convex/operations/backups/slot.ts and the shared bearer helper
#   convex/operations/telemetry/serviceToken.ts): from /app/src the
#   ../../../convex/... specifiers resolve exactly as in the repo, so the
#   container boots with the SAME modules the Worker bundles. wrangler.jsonc
#   sets image_build_context to the repo root (the root .dockerignore keeps
#   that context to just these paths).
# - No credentials are baked in: R2 backup/media-read keys and the service
#   token arrive as container runtime env (forwarded by the DO class).
# - linux/amd64 explicitly: local docker on arm64 Macs would otherwise
#   build an image the Cloudflare Container VM cannot run.
FROM --platform=linux/amd64 node:22-slim

RUN npm install -g convex@1.45.0 \
  && rm -rf /tmp/*

WORKDIR /app/apps/backup-worker
COPY apps/backup-worker/src /app/apps/backup-worker/src
COPY convex/operations/backups/slot.ts /app/convex/operations/backups/slot.ts
COPY convex/operations/telemetry/serviceToken.ts /app/convex/operations/telemetry/serviceToken.ts

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--experimental-transform-types", "src/container-main.ts"]
