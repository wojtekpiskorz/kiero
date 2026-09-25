# EU media container image. Bounded, honest:
# - Node 22 slim + ffmpeg: the conversion/segmentation runtime the scoped
#   EU Container exists for (architecture "Deployment and ownership").
# - The entry serves the segment protocol (/healthz, /probe, /segment) with
#   PCM WAV slicing exact and FFmpeg conversion of non-WAV retained audio
#   (the voice byte channel): the container process verifies the
#   binary at startup and converts under explicit bounds (input byte cap,
#   output duration cap, wall-clock timeout; typed refusals on breach).
# - No credentials are baked in: R2 media S3 keys and the segment bearer
#   token arrive as container runtime env (forwarded by the DO class),
#   never as image layers.
# - This image builds for linux/amd64 and deploys under the EU jurisdiction
#   constraints on the current account.

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
