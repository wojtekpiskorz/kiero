# EU backup container image (I5). Bounded, honest (the D6 media image
# pattern; no FFmpeg here - the backup executor needs only Node and the
# pinned Convex CLI):
#
# - Node 22 slim; the entry serves the shared backup protocol (/healthz,
#   /run) with zero build steps (node --experimental-strip-types).
# - The pinned Convex CLI is pre-installed GLOBALLY so the headless export
#   (`npx convex@1.45.0 export`) never needs network access at runtime; the
#   injected CONVEX_BACKUP_ADMIN_KEY drives it (written to an isolated
#   scratch HOME at runtime, never baked into the image).
# - No credentials are baked in: R2 backup/media-read keys and the service
#   token arrive as container runtime env (forwarded by the DO class).
# - linux/amd64 explicitly: local docker on arm64 Macs would otherwise
#   build an image the Cloudflare Container VM cannot run.
FROM --platform=linux/amd64 node:22-slim

RUN npm install -g convex@1.45.0 \
  && rm -rf /tmp/*

WORKDIR /app
COPY src /app/src

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/container-main.ts"]
