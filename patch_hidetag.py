import re

content = open('bot.js', encoding='utf-8').read()
changes = []

def rep(pattern, new, label):
    global content
    # re.DOTALL makes it ignore newlines and spaces
    content, c = re.subn(pattern, new, content, flags=re.DOTALL)
    if c == 0:
        print(f"[SKIP] not found: {label}")
        return
    if c > 1:
        print(f"[WARN] '{label}' appears {c}x")
    changes.append(label)

# 1. Dashboard API hidetag
rep(
    r"(} else if \(act === 'hidetag'\) \{\s*)out = \`\$\{SK_HEADER\}[\s\S]*?\$\{SK_FOOTER\}\`",
    r"\g<1>out = custom ? custom : `📢 ${mono('ATTENTION')}`",
    "Dashboard API hidetag"
)

# 2. WhatsApp command hidetag
rep(
    r"(if \(cmd === 'hidetag'\) \{\s*)let out = \`\$\{SK_HEADER\}[\s\S]*?\$\{SK_FOOTER\}\`",
    r"\g<1>let out = custom ? custom : `📢 ${mono('ATTENTION')}`",
    "WhatsApp command hidetag"
)

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
