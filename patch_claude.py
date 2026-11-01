import re

content = open('bot.js', encoding='utf-8').read()
changes = []

def rep(pattern, new, label):
    global content
    content, c = re.subn(pattern, new, content, flags=re.DOTALL)
    if c == 0:
        print(f"[SKIP] not found: {label}")
    else:
        changes.append(label)

# 1. Update the Search command (remove ios, add defaults)
rep(
    r"execFile\('yt-dlp', \[\s*'--dump-json', '--no-warnings', '--ignore-errors',\s*'--flat-playlist',\s*'--extractor-args', 'youtube:player_client=ios',\s*'--force-ipv4',",
    r"execFile('yt-dlp', [\n            '--js-runtimes', 'deno',\n            '--dump-json', '--no-warnings', '--ignore-errors',\n            '--flat-playlist', '--force-ipv4',",
    "Search command"
)

# 2. Update the Video downloader
rep(
    r"execFile\('yt-dlp', \[\s*'-f', fmt,\s*'--extractor-args', 'youtube:player_client=ios',\s*'--force-ipv4',",
    r"execFile('yt-dlp', [\n                '--js-runtimes', 'deno',\n                '--extractor-args', 'youtubepot-bgutilscript:server_home=/opt/bgutil/server',\n                '-f', fmt,\n                '--force-ipv4',",
    "Video downloader"
)

# 3. Update the .song command
rep(
    r"execFile\('yt-dlp', \['-x', '--audio-format', 'mp3', '--max-filesize', '30M', '--match-filter', 'duration < 300', '-o', outPath, '--no-playlist', '--extractor-args', 'youtube:player_client=ios', '--force-ipv4', '--', src\]",
    r"execFile('yt-dlp', ['-x', '--audio-format', 'mp3', '--max-filesize', '30M', '--match-filter', 'duration < 300', '-o', outPath, '--no-playlist', '--js-runtimes', 'deno', '--extractor-args', 'youtubepot-bgutilscript:server_home=/opt/bgutil/server', '--force-ipv4', '--', src]",
    "Song command"
)

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
