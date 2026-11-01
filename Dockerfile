FROM node:20-slim

# 1. Install Deno (Required by yt-dlp to bypass YouTube bot checks)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV PATH="/root/.deno/bin:${PATH}"

# 2. Install system dependencies (ffmpeg for stickers, webp for toimg, python for gallery-dl)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip curl webp \
    && rm -rf /var/lib/apt/lists/*

# 3. Install yt-dlp (for .song, .mp4, .tt)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# 4. Install gallery-dl (for .img URL downloads)
RUN pip3 install --break-system-packages gallery-dl

# 5. Set up the app
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# 6. Start the bot
CMD ["node", "bot.js"]
