content = open('bot.js', encoding='utf-8').read()
changes = []

def rep(old, new, label, n=1):
    global content
    c = content.count(old)
    if c == 0:
        print(f"[SKIP] not found: {label}")
        return
    if c > n:
        print(f"[WARN] '{label}' appears {c}x, only replacing {n}")
    content = content.replace(old, new, n)
    changes.append(label)

# 1. ANTIBOT: real detection. Older Baileys-based bots stamp message IDs with a BAE5 prefix.
rep(
    "    if (settings.antiforward && ci?.isForwarded) return 'forwarded messages'",
    "    if (settings.antiforward && ci?.isForwarded) return 'forwarded messages'\n"
    "    if (settings.antibot && /^BAE5/.test(String(msg.key && msg.key.id || ''))) return 'bots'",
    "antibot: detect bot-sent messages by ID signature"
)
rep(
    "'forwarded messages': 'antiforward', 'bad words': 'antibadword' }",
    "'forwarded messages': 'antiforward', 'bad words': 'antibadword', 'bots': 'antibot' }",
    "antibot: route its Action/Limit through enforceProtection"
)

# 2. BLACKLIST: the group's custom word list is now actually checked (escaped, Unicode-aware boundaries).
lines = content.split('\n')
hit = [i for i, l in enumerate(lines) if l.strip().startswith("if (settings.antibadword && BAD_WORDS.some(")]
if len(hit) == 1:
    lines[hit[0]] = (
        "    if (settings.antibadword && (BAD_WORDS.some(w => new RegExp(`\\\\b${w}\\\\b`, 'i').test(text)) || "
        "(Array.isArray(settings.blacklist) ? settings.blacklist : []).some(w => { "
        "const e = String(w).trim().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'); "
        "return !!e && new RegExp(`(^|[^\\\\p{L}\\\\p{N}_])${e}($|[^\\\\p{L}\\\\p{N}_])`, 'iu').test(text) }))) return 'bad words'"
    )
    content = '\n'.join(lines)
    changes.append("antibadword: also check the group's custom blacklist")
else:
    print(f"[SKIP] antibadword line found {len(hit)} times, expected 1")

rep(
    "else if (p.key === 'blacklist' && Array.isArray(p.value)) gs.blacklist = p.value.map(String).slice(0, 100)",
    "else if (p.key === 'blacklist' && Array.isArray(p.value)) gs.blacklist = p.value.map(x => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 100)",
    "blacklist: cap each word at 40 characters, drop blanks"
)

# 3. BIRTHDAY: attach the uploaded image on the send-to-a-number path too.
rep(
    "const sent = await sock.sendMessage(sender, { text: stages[0] })",
    "if (fs.existsSync(BIRTHDAY_PATH)) {\n"
    "                    try { await sock.sendMessage(sender, { image: fs.readFileSync(BIRTHDAY_PATH) }) } catch (e) {}\n"
    "                }\n"
    "                const sent = await sock.sendMessage(sender, { text: stages[0] })",
    "birthday: attach the image on the target-number path as well"
)

# 4. FIX my earlier bug: saving any group setting used to create welcome:false/goodbye:false for the
#    group, silently overriding the global welcome toggle. Only touch welcome data for welcome keys.
rep(
    """                if (!ctx.welcomeSettings[g]) ctx.welcomeSettings[g] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
                const ws = ctx.welcomeSettings[g]
                if (ANTI_KEYS.includes(p.key)) gs[p.key] = !!p.value""",
    """                const isWelcomeKey = ['welcome', 'goodbye', 'welcomeMsg', 'goodbyeMsg'].includes(p.key)
                if (isWelcomeKey && !ctx.welcomeSettings[g]) ctx.welcomeSettings[g] = {}
                const ws = ctx.welcomeSettings[g] || {}
                if (ANTI_KEYS.includes(p.key)) gs[p.key] = !!p.value""",
    "fix: don't create welcome overrides unless a welcome key is being saved"
)
rep(
    """                const ws = ctx.welcomeSettings[gid] || { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
                return J(200, { settings: gs, welcome: ws })""",
    """                const ws = ctx.welcomeSettings[gid] || {}
                const eff = { welcome: typeof ws.welcome === 'boolean' ? ws.welcome : !!ctx.cfg.eventsWelcome, goodbye: typeof ws.goodbye === 'boolean' ? ws.goodbye : !!ctx.cfg.eventsGoodbye }
                return J(200, { settings: gs, welcome: Object.assign({}, ws, eff) })""",
    "fix: report the EFFECTIVE welcome/goodbye state (group override, else global)"
)

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
