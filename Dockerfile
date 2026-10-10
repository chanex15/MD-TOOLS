# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Install system dependencies, ffmpeg, and python3-pip
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Install the latest stable yt-dlp via pip (handles architectures automatically)
RUN pip3 install --no-cache-dir --break-system-packages --upgrade yt-dlp

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
