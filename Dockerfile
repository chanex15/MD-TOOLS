# syntax=docker/dockerfile:1
#
# MD-TOOL — production image.
#
# A container host (Fly.io, Render, Railway, a VPS) is required: the app spawns
# yt-dlp and ffmpeg child processes and runs conversions that take minutes, so
# it cannot run on a serverless platform such as Vercel.
#
# Both binaries are installed into the image:
#   * ffmpeg  — from Debian, and it brings ffprobe with it.
#   * yt-dlp  — the standalone release build, so no Python runtime is needed.

FROM node:20-bookworm-slim

ARG TARGETARCH

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Pin the architecture-specific yt-dlp asset. amd64 and arm64 are the builds
# that ship as bare binaries (armv7 is a .zip) and the ones container hosts use.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      arm64) asset="yt-dlp_linux_aarch64" ;; \
      *)     asset="yt-dlp_linux" ;; \
    esac; \
    curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}" \
      -o /usr/local/bin/yt-dlp; \
    chmod +x /usr/local/bin/yt-dlp; \
    yt-dlp --version; \
    ffmpeg -version | head -1

WORKDIR /app

# Dependency layer first, so it caches across source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public

# The base image ships a non-root `node` user; hand it the app directory.
RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
