FROM node:20-slim

# Install system dependencies, Python, and build tools for the PO Token generator
RUN apt-get update && apt-get install -y ffmpeg python3 python3-venv python3-pip git curl build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Deno (for yt-dlp JS runtime)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV PATH="/root/.deno/bin:${PATH}"

# Install yt-dlp[default] and the PO Token plugin via pip
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir -U "yt-dlp[default]" bgutil-ytdlp-pot-provider

# Clone and build the PO Token generator script
RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil
WORKDIR /opt/bgutil/server
RUN npm install && npx tsc

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "bot.js"]
