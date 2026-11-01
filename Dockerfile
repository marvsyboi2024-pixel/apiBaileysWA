FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-venv git curl ca-certificates unzip xz-utils webp \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -U pip "yt-dlp[default]" bgutil-ytdlp-pot-provider gallery-dl \
 && ln -sf /opt/venv/bin/yt-dlp /usr/local/bin/yt-dlp \
 && ln -sf /opt/venv/bin/gallery-dl /usr/local/bin/gallery-dl

RUN V=$(/opt/venv/bin/pip show bgutil-ytdlp-pot-provider | awk '/^Version:/{print $2}') \
 && git clone --depth 1 --branch "$V" https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
 && cd /opt/bgutil/server && npm install && npx tsc

RUN yt-dlp --version && deno --version && ffmpeg -version | head -1 \
 && test -f /opt/bgutil/server/build/generate_once.js

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "bot.js"]
