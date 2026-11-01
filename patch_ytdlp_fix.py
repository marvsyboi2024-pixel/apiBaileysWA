content = open('bot.js', encoding='utf-8').read()
changes = []

def rep(old, new, label):
    global content
    c = content.count(old)
    if c == 0:
        print(f"[SKIP] not found: {label}")
        return
    content = content.replace(old, new)
    changes.append(label)

# 1. Fix the YouTube Video Downloader
rep(
"""            execFile('yt-dlp', [
                '-f', fmt,""",
"""            execFile('yt-dlp', [
                '-f', fmt,
                '--extractor-args', 'youtube:player_client=ios',
                '--force-ipv4',""",
"Added iOS bypass to video downloader"
)

# 2. Fix the YouTube Search
rep(
"""        execFile('yt-dlp', [
            '--dump-json', '--no-warnings', '--ignore-errors',""",
"""        execFile('yt-dlp', [
            '--extractor-args', 'youtube:player_client=ios',
            '--force-ipv4',
            '--dump-json', '--no-warnings', '--ignore-errors',""",
"Added iOS bypass to search"
)

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
