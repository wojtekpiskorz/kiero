# EU export container image (I3). Bounded, honest:
# - Node 22 slim only: the bounded archive assembly (streaming ZIP of JSON,
#   an escaped HTML index and stored media copies) needs no media tooling —
#   no ffmpeg, no build step (`node --experimental-strip-types` runs the
#   TypeScript entry directly).
# - No credentials are baked in: the media S3 token, the service credential
#   and the Convex endpoint arrive as container runtime env (forwarded by
#   the DO class in src/index.ts), never as image layers.
# - linux/amd64 explicitly: local docker on arm64 Macs would otherwise
#   build an arm64 image the Cloudflare Container VM cannot run (the D6
#   media-worker finding).
FROM --platform=linux/amd64 node:22-slim

WORKDIR /app
COPY src /app/src

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/container-main.ts"]
