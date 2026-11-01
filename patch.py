import re, os

src = open('bot.js', encoding='utf-8').read()

if 'const ytArgs = [' in src:
    print('bot.js already patched, skipping')
else:
    orig = src
    old = "let YTDLP_AVAILABLE = false\nfunction checkYtDlp() {"
    assert old in src, 'checkYtDlp block not found'
    src = src.replace(old, "const YT_PROXY = process.env.YT_PROXY || ''\n" + old, 1)
    src = src.replace(
        "if (err) console.log('[TT] yt-dlp not found. Install with: pip install yt-dlp')",
        "if (err) console.log('[TT] yt-dlp check failed:', err.message)", 1)

    pat = re.compile(r"execFile\('yt-dlp', \['-x', '--audio-format', 'mp3'.*?function\(err\)\{ if \(err\) reject\(err\); else resolve\(\) \}\)")
    m = pat.search(src)
    assert m, '.song execFile not found'
    song_new = """const ytArgs = [
                    '-f', 'ba/b', '-x', '--audio-format', 'mp3',
                    '--max-filesize', '30M', '--match-filter', 'duration < 300',
                    '--no-playlist', '--no-warnings',
                    '--js-runtimes', 'deno',
                    '--extractor-args', 'youtubepot-bgutilscript:server_home=/opt/bgutil/server',
                    ...(YT_PROXY ? ['--proxy', YT_PROXY] : ['--force-ipv4']),
                    '-o', outPath, '--', src
                ]
                execFile('yt-dlp', ytArgs, { timeout: 120000, maxBuffer: 20*1024*1024 }, function(err, so, se){ if (err) { console.log('[SONG ERR]', String(se).slice(0, 400)); reject(err) } else resolve() })"""
    src = src[:m.start()] + song_new + src[m.end():]

    pat = re.compile(r"(function runYtDlpVideo.*?)'--force-ipv4',", re.S)
    m = pat.search(src)
    assert m, 'runYtDlpVideo not found'
    src = src[:m.start()] + m.group(1) + "...(YT_PROXY ? ['--proxy', YT_PROXY] : ['--force-ipv4'])," + src[m.end():]

    open('bot.js.bak', 'w', encoding='utf-8').write(orig)
    open('bot.js', 'w', encoding='utf-8').write(src)
    print('bot.js patched (backup: bot.js.bak)')

cmd = 'CMD ["node", "bot.js"]'
if os.path.exists('Dockerfile'):
    old_df = open('Dockerfile', encoding='utf-8').read()
    if 'bgutil' in old_df and 'python3-venv' in old_df:
        print('Dockerfile already patched, skipping')
        raise SystemExit
    for ln in old_df.splitlines():
        if ln.strip().startswith('CMD'):
            cmd = ln.strip()
    open('Dockerfile.bak', 'w', encoding='utf-8').write(old_df)

docker = '''FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ffmpeg python3 python3-venv git curl ca-certificates unzip xz-utils webp \\
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

RUN python3 -m venv /opt/venv \\
 && /opt/venv/bin/pip install --no-cache-dir -U pip "yt-dlp[default]" bgutil-ytdlp-pot-provider gallery-dl \\
 && ln -sf /opt/venv/bin/yt-dlp /usr/local/bin/yt-dlp \\
 && ln -sf /opt/venv/bin/gallery-dl /usr/local/bin/gallery-dl

RUN V=$(/opt/venv/bin/pip show bgutil-ytdlp-pot-provider | awk '/^Version:/{print $2}') \\
 && git clone --depth 1 --branch "$V" https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \\
 && cd /opt/bgutil/server && npm install && npx tsc

RUN yt-dlp --version && deno --version && ffmpeg -version | head -1 \\
 && test -f /opt/bgutil/server/build/generate_once.js

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
''' + cmd + '\n'
open('Dockerfile', 'w', encoding='utf-8').write(docker)
print('Dockerfile written (old: Dockerfile.bak), kept:', cmd)
