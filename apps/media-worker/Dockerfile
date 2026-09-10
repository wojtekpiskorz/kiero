# EU media container image (D6). Bounded, honest:
# - Node 22 slim + ffmpeg: the conversion/segmentation runtime the scoped
#   EU Container exists for (architecture "Deployment and ownership").
# - The entry serves the segment protocol (/healthz, /probe, /segment) with
#   PCM WAV slicing exact and FFmpeg conversion arriving with the container
#   follow-up (non-WAV answers `format_requires_container` until then).
# - No credentials are baked in: R2 media S3 keys and the segment bearer
#   token arrive as container runtime env (forwarded by the DO class),
#   never as image layers.
# - Deploy state (observed live by D6): this image builds for linux/amd64,
#   deploys and serves under the EU jurisdiction constraints on the current
#   account — the preflight's Workers-Paid assumption did not materialize.
#   The only pending owner action is the R2 media S3 token (dashboard).

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
