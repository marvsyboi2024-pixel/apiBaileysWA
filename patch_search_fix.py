import re

content = open('bot.js', encoding='utf-8').read()

# Match the exact way the search block looks right now and clean it up
pattern = r"execFile\('yt-dlp', \[\s*'--extractor-args', 'youtube:player_client=ios',\s*'--force-ipv4',\s*'--dump-json', '--no-warnings', '--ignore-errors',\s*'--flat-playlist',"
new_code = r"""execFile('yt-dlp', [
            '--js-runtimes', 'deno',
            '--dump-json', '--no-warnings', '--ignore-errors',
            '--flat-playlist',"""

content, c = re.subn(pattern, new_code, content, flags=re.DOTALL)

if c > 0:
    open('bot.js', 'w', encoding='utf-8').write(content)
    print("✅ Search command successfully patched!")
else:
    print("⚠️ Still couldn't find the search command. It might already be clean.")
