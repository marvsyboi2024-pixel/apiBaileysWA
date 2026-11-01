# Use Node 22 as required by bgutil
FROM node:22-slim

# Prevent debconf interactive prompts and install required tools
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg git curl build-essential libterm-readline-gnu-perl \
    && rm -rf /var/lib/apt/lists/*

# Install Deno
RUN curl -fsSL https://deno.land/install.sh | sh
ENV PATH="/root/.deno/bin:${PATH}"

# Set up Python venv for yt-dlp and the PO Token plugin
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir -U "yt-dlp[default]" bgutil-ytdlp-pot-provider

# Clone and build the PO Token generator
RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil
WORKDIR /opt/bgutil/server
RUN npm install && npx tsc

# Set up the bot app
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "bot.js"]
