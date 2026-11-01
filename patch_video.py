import re

content = open('bot.js', encoding='utf-8').read()
changes = []

def rep(pattern, new, label):
    global content
    # re.DOTALL ignores spaces and newlines
    content, c = re.subn(pattern, new, content, flags=re.DOTALL)
    if c == 0:
        print(f"[SKIP] not found: {label}")
    else:
        changes.append(label)

# Target the video downloader specifically
rep(
    r"(execFile\('yt-dlp', \[\s*)'-f', fmt,",
    r"\g<1>'-f', fmt,\n                    '--extractor-args', 'youtube:player_client=ios',\n                    '--force-ipv4',",
    "Added iOS bypass to video downloader"
)

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
