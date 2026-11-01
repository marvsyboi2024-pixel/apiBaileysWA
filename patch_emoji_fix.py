import re

content = open('bot.js', encoding='utf-8').read()
changes = []

def rep(pattern, new, label):
    global content
    # Using re.subn so it ignores invisible spacing issues
    content, c = re.subn(pattern, new, content, flags=re.DOTALL)
    if c == 0:
        print(f"[SKIP] not found: {label}")
        return
    if c > 1:
        print(f"[WARN] '{label}' appears {c}x, replacing all")
    changes.append(label)

# 1. Silent Cooldown (stops spamming errors)
rep(
    r"if \(wait > 0\) \{\s*await say\(skError\(`Please wait \$\{wait\}s before using \$\{prefix\}\$\{kind\} again\.`\)\)\s*return\s*\}",
    """if (wait > 0) {
            if (!silentWhenNoReply) await say(skError(`Please wait ${wait}s before using ${prefix}${kind} again.`))
            return
        }""",
    "Silent cooldown error"
)

# 2. Silent "Not View-Once" error
rep(
    r"if \(!target\) \{\s*if \(!ci\) \{ if \(silentWhenNoReply\) return; await say\(skError\(`Reply to a view-once photo/video/voice note with \$\{prefix\}\$\{kind\}`\)\) \}\s*else await say\(skError\('This only works on unopened view-once media\.'\)\)\s*return\s*\}",
    """if (!target) {
            if (silentWhenNoReply) return;
            if (!ci) { await say(skError(`Reply to a view-once photo/video/voice note with ${prefix}${kind}`)) }
            else { await say(skError('This only works on unopened view-once media.')) }
            return
        }""",
    "Silent non-view-once error"
)

# 3. Silent Download error
rep(
    r"(\s*)console\.log\(`\.\$\{kind\} error:`,\s*e\?\.message \|\| e\)\s*await say\(skError\('Failed to get that view-once\. WhatsApp may have deleted it\.'\)\)",
    r"\g<1>console.log(`.${kind} error:`, e?.message || e)\n\g<1>if (!silentWhenNoReply) {\n\g<1>    await say(skError('Failed to get that view-once. WhatsApp may have deleted it.'))\n\g<1>}",
    "Silent download error"
)

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
