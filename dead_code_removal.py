content = open('bot.js', encoding='utf-8').read()
start_anchor = 'async function handleCommand(sock, ctx, msg, content, from, isGroup, sender, senderNumber, owner, cmd, args) {'
end_anchor = 'const server = http.createServer(async (req, res) => {'
start_pos = content.find(start_anchor)
end_pos = content.find(end_anchor)
assert start_pos != -1 and end_pos != -1 and end_pos > start_pos, 'anchor check failed - stop, do not proceed'
new_content = content[:start_pos] + content[end_pos:]
open('bot.js', 'w', encoding='utf-8').write(new_content)
print('Removed', end_pos - start_pos, 'characters of dead code')
