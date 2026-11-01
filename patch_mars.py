import re

content = open('bot.js', encoding='utf-8').read()
changes = []

def rep(pattern, new, label):
    global content
    # Smart search: ignores extra spaces or newlines
    content, c = re.subn(pattern, new, content, flags=re.DOTALL)
    if c == 0:
        print(f"[SKIP] not found: {label}")
        return
    if c > 1:
        print(f"[WARN] '{label}' appears {c}x, replacing all")
    changes.append(label)

# Target only the specific .save line and add the TRIGGERS line right after it
rep(
    r"(\['\.save',\s*'Save status / photo to DM'\])",
    r"\1,\n                ['TRIGGERS', '🌚 😹 🙂 🥺 🥰 😳']",
    "Added secret emojis to .mars"
)

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
