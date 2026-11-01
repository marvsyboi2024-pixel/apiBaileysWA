import re

content = open('bot.js', encoding='utf-8').read()
changes = []

def rep(pattern, new, label):
    global content
    content, c = re.subn(pattern, new, content, flags=re.DOTALL)
    if c == 0:
        print(f"[SKIP] not found: {label}")
        return
    changes.append(label)

# Target the .song command specifically
rep(
    r"execFile\('yt-dlp', \['-x', '--audio-format', 'mp3', '--max-filesize', '30M', '--match-filter', 'duration < 300', '-o', outPath, '--no-playlist', '--', src\]",
    r"execFile('yt-dlp', ['-x', '--audio-format', 'mp3', '--max-filesize', '30M', '--match-filter', 'duration < 300', '-o', outPath, '--no-playlist', '--extractor-args', 'youtube:player_client=ios', '--force-ipv4', '--', src]",
    "Added iOS bypass to .song command"
)

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
