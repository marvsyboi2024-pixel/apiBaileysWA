FROM node:20-slim

# Install system dependencies (ffmpeg, python3, curl)
RUN apt-get update && apt-get install -y ffmpeg python3 curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Set up the app
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Start the bot
CMD ["node", "bot.js"]
