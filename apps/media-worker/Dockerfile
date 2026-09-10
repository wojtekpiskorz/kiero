# EU media container image (D6). Bounded, honest:
# - Node 22 slim + ffmpeg: the conversion/segmentation runtime the scoped
#   EU Container exists for (architecture "Deployment and ownership").
# - The entry serves the segment protocol (/healthz, /probe, /segment) with
#   PCM WAV slicing exact and FFmpeg conversion arriving with the container
#   follow-up (non-WAV answers `format_requires_container` until then).
# - No credentials are baked in: R2 media S3 keys and the segment bearer
#   token arrive as container runtime env, never as image layers.
# - Deploying requires the Containers runtime (Workers Paid enablement —
#   BLOCKED owner action recorded in the D6 evidence).

# linux/amd64 explicitly: local docker on arm64 Macs would otherwise build
# an arm64 image the Cloudflare Container VM cannot run (requirement:
# "Image must run on linux/amd64").
FROM --platform=linux/amd64 node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src /app/src

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/container-main.ts"]
