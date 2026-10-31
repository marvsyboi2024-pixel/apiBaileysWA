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

rep(
    "var ALIVE_PATH = path.join('.', 'alive.png')",
    "var ALIVE_PATH = path.join('.', 'alive.png')\nvar BIRTHDAY_PATH = path.join('.', 'birthday.png')",
    "new BIRTHDAY_PATH constant"
)

rep(
    "const IMG = { menu: LOGO_PATH, menu2: MENU2_LOGO_PATH, ping: PING_PATH, alive: ALIVE_PATH }",
    "const IMG = { menu: LOGO_PATH, menu2: MENU2_LOGO_PATH, ping: PING_PATH, alive: ALIVE_PATH, birthday: BIRTHDAY_PATH }",
    "add birthday to the IMG upload/serve map"
)

rep(
    "        const quote = getRandom(BIRTHDAY_QUOTES)",
    "        const quote = (ctx.cfg.birthdayMsg && ctx.cfg.birthdayMsg.trim()) ? ctx.cfg.birthdayMsg.trim() : getRandom(BIRTHDAY_QUOTES)",
    "birthday: custom message override"
)

rep(
    """        if (!targetNum) {
            const sent = await reply(stages[0])""",
    """        if (!targetNum) {
            if (fs.existsSync(BIRTHDAY_PATH)) {
                try { await sock.sendMessage(from, { image: fs.readFileSync(BIRTHDAY_PATH) }, { quoted: msg }) } catch (e) {}
            }
            const sent = await reply(stages[0])""",
    "birthday: send uploaded image before the animated text"
)

rep(
    "                else if (p.key === 'prefix' && typeof p.value === 'string' && p.value.length >= 1 && p.value.length <= 3) ctx.cfg.prefix = p.value",
    "                else if (p.key === 'prefix' && typeof p.value === 'string' && p.value.length >= 1 && p.value.length <= 3) ctx.cfg.prefix = p.value\n"
    "                else if (p.key === 'birthdayMsg' && typeof p.value === 'string' && p.value.length <= 300) ctx.cfg.birthdayMsg = p.value",
    "add birthdayMsg to /api/settings POST"
)

old_route_get = """            if (req.method === 'GET' && gid) {
                const gs = ctx.groupSettings[gid] || {}
                return J(200, { settings: gs })
            }"""
new_route_get = """            if (req.method === 'GET' && gid) {
                const gs = ctx.groupSettings[gid] || {}
                const ws = ctx.welcomeSettings[gid] || { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
                return J(200, { settings: gs, welcome: ws })
            }"""
rep(old_route_get, new_route_get, "group-settings GET: also return welcome/goodbye")

old_route_post = """                if (ANTI_KEYS.includes(p.key)) gs[p.key] = !!p.value
                else if (ANTI_KEYS.some(k => p.key === k + 'Action') && ['warn', 'kick'].includes(p.value)) gs[p.key] = p.value
                else if (ANTI_KEYS.some(k => p.key === k + 'Limit') && (p.value === 'none' || (Number.isInteger(+p.value) && +p.value >= 1 && +p.value <= 10))) gs[p.key] = p.value === 'none' ? 'none' : +p.value
                else if (p.key === 'slowmode' && Number.isInteger(+p.value) && +p.value >= 0) gs.slowmode = +p.value
                else if (p.key === 'blacklist' && Array.isArray(p.value)) gs.blacklist = p.value.map(String).slice(0, 100)
                else return J(400, { error: 'Invalid setting.' })
                saveCtx(ctx)
                return J(200, { settings: gs })"""
new_route_post = """                if (!ctx.welcomeSettings[g]) ctx.welcomeSettings[g] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
                const ws = ctx.welcomeSettings[g]
                if (ANTI_KEYS.includes(p.key)) gs[p.key] = !!p.value
                else if (ANTI_KEYS.some(k => p.key === k + 'Action') && ['warn', 'kick'].includes(p.value)) gs[p.key] = p.value
                else if (ANTI_KEYS.some(k => p.key === k + 'Limit') && (p.value === 'none' || (Number.isInteger(+p.value) && +p.value >= 1 && +p.value <= 10))) gs[p.key] = p.value === 'none' ? 'none' : +p.value
                else if (p.key === 'slowmode' && Number.isInteger(+p.value) && +p.value >= 0) gs.slowmode = +p.value
                else if (p.key === 'blacklist' && Array.isArray(p.value)) gs.blacklist = p.value.map(String).slice(0, 100)
                else if (p.key === 'welcome' || p.key === 'goodbye') ws[p.key] = !!p.value
                else if ((p.key === 'welcomeMsg' || p.key === 'goodbyeMsg') && typeof p.value === 'string' && p.value.length <= 500) ws[p.key] = p.value
                else return J(400, { error: 'Invalid setting.' })
                saveCtx(ctx)
                return J(200, { settings: gs, welcome: ws })"""
rep(old_route_post, new_route_post, "group-settings POST: welcome/goodbye toggle + text")

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
