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

# 1. Rewrite enforceProtection to support per-type Action (warn/kick) and a real "no limit"
old_fn = """async function enforceProtection(sock, ctx, msg, content, from, sender, senderNumber, text) {
    const settings = ctx.groupSettings[from]
    if (!settings || !Object.values(settings).some(Boolean)) return false

    const ci = getContextInfo(content)
    const reason = detectViolation(ctx, settings, msg, content, ci, text, from, sender)
    if (!reason) return false

    if (await checkAdmin(ctx, sock, from, [sender])) return false

    if (!ctx.warningCounts[from]) ctx.warningCounts[from] = {}
    const key = cleanJid(sender)
    ctx.warningCounts[from][key] = (ctx.warningCounts[from][key] || 0) + 1
    const _reasonMap = { 'links': 'antilink', 'spam': 'antispam', 'media': 'antimedia', 'tags': 'antitag', 'forwarded messages': 'antiforward', 'bad words': 'antibadword' }
    const _cmdKey = _reasonMap[reason] || ''
    const _cmdLimit = _cmdKey && ctx.groupSettings[from] ? ctx.groupSettings[from][_cmdKey + 'Limit'] : null
    const limit = _cmdLimit || ctx.warnLimit[from] || 3
    const count = ctx.warningCounts[from][key]
    const realNum = await resolveNumber(ctx, sock, from, sender)

    const botAdmin = await checkAdmin(ctx, sock, from, [...botIds(sock)])
    if (botAdmin) {
        try { await sock.sendMessage(from, { delete: msg.key }) } catch (e) {}
    }

    try {
        await sock.sendMessage(from, {
            text: skInfo('⚠️', 'WARN', [
                ['USER', `@${realNum}`],
                ['REASON', reason],
                ['COUNT', `${Math.min(count, limit)} / ${limit}`]
            ]),
            mentions: mentionJids(sock, [sender], [realNum])
        })
    } catch (e) {}

    if (count >= limit && botAdmin) {
        try {
            await sock.groupParticipantsUpdate(from, [sender], 'remove')
            delete ctx.warningCounts[from][key]
            await sock.sendMessage(from, {
                text: skInfo('🚫', 'KICKED', [
                    ['USER', `@${realNum}`],
                    ['REASON', 'Warning limit reached']
                ]),
                mentions: mentionJids(sock, [sender], [realNum])
            })
        } catch (e) {}
    }
    return true
}"""

new_fn = """async function enforceProtection(sock, ctx, msg, content, from, sender, senderNumber, text) {
    const settings = ctx.groupSettings[from]
    if (!settings || !Object.values(settings).some(Boolean)) return false

    const ci = getContextInfo(content)
    const reason = detectViolation(ctx, settings, msg, content, ci, text, from, sender)
    if (!reason) return false

    if (await checkAdmin(ctx, sock, from, [sender])) return false

    const _reasonMap = { 'links': 'antilink', 'spam': 'antispam', 'media': 'antimedia', 'tags': 'antitag', 'forwarded messages': 'antiforward', 'bad words': 'antibadword' }
    const _cmdKey = _reasonMap[reason] || ''
    const action = (_cmdKey && settings[_cmdKey + 'Action']) || 'warn'
    const realNum = await resolveNumber(ctx, sock, from, sender)
    const botAdmin = await checkAdmin(ctx, sock, from, [...botIds(sock)])

    if (botAdmin) {
        try { await sock.sendMessage(from, { delete: msg.key }) } catch (e) {}
    }

    // Kick action: always deletes (above), always kicks immediately, no warning message, no count.
    if (action === 'kick') {
        if (botAdmin) {
            try {
                await sock.groupParticipantsUpdate(from, [sender], 'remove')
                await sock.sendMessage(from, {
                    text: skInfo('🚫', 'KICKED', [['USER', `@${realNum}`], ['REASON', reason]]),
                    mentions: mentionJids(sock, [sender], [realNum])
                })
            } catch (e) {}
        }
        return true
    }

    // Warn action: deletes (above), counts, warns, kicks at limit - unless the limit is 'none', which
    // never kicks regardless of count.
    if (!ctx.warningCounts[from]) ctx.warningCounts[from] = {}
    const key = cleanJid(sender)
    ctx.warningCounts[from][key] = (ctx.warningCounts[from][key] || 0) + 1
    const _cmdLimit = _cmdKey ? settings[_cmdKey + 'Limit'] : null
    const limit = _cmdLimit || ctx.warnLimit[from] || 3
    const count = ctx.warningCounts[from][key]
    const limitText = limit === 'none' ? `${count} (no limit)` : `${Math.min(count, limit)} / ${limit}`

    try {
        await sock.sendMessage(from, {
            text: skInfo('⚠️', 'WARN', [
                ['USER', `@${realNum}`],
                ['REASON', reason],
                ['COUNT', limitText]
            ]),
            mentions: mentionJids(sock, [sender], [realNum])
        })
    } catch (e) {}

    if (limit !== 'none' && count >= limit && botAdmin) {
        try {
            await sock.groupParticipantsUpdate(from, [sender], 'remove')
            delete ctx.warningCounts[from][key]
            await sock.sendMessage(from, {
                text: skInfo('🚫', 'KICKED', [
                    ['USER', `@${realNum}`],
                    ['REASON', 'Warning limit reached']
                ]),
                mentions: mentionJids(sock, [sender], [realNum])
            })
        } catch (e) {}
    }
    return true
}"""
rep(old_fn, new_fn, "enforceProtection: per-type Action (warn/kick) + real No Limit support")

# 2. New /api/group-settings route, inserted right before the existing /api/image route.
anchor = "        if (url === '/api/image' && req.method === 'POST') {"
new_route = """        if (url === '/api/group-settings') {
            if (!user) return J(401, { error: 'Log in first.' })
            const s = sessions['sess_' + user], ctx = s && s.ctx
            if (!ctx || !s.sock) return J(409, { error: 'Your number is not connected.' })
            const ANTI_KEYS = ['antilink', 'antispam', 'antibot', 'antimedia', 'antitag', 'antiforward', 'antidelete', 'antibadword']
            const gid = q.get('group')
            if (req.method === 'GET' && !gid) {
                try {
                    const groups = await s.sock.groupFetchAllParticipating()
                    const list = Object.values(groups).map(g => ({ id: g.id, name: g.subject }))
                    return J(200, { groups: list })
                } catch (e) { return J(500, { error: 'Could not fetch groups.' }) }
            }
            if (req.method === 'GET' && gid) {
                const gs = ctx.groupSettings[gid] || {}
                return J(200, { settings: gs })
            }
            if (req.method === 'POST') {
                let p = {}; try { p = JSON.parse(await body(2000)) } catch (e) {}
                const g = String(p.group || '')
                if (!g) return J(400, { error: 'Missing group.' })
                if (!ctx.groupSettings[g]) ctx.groupSettings[g] = {}
                const gs = ctx.groupSettings[g]
                if (ANTI_KEYS.includes(p.key)) gs[p.key] = !!p.value
                else if (ANTI_KEYS.some(k => p.key === k + 'Action') && ['warn', 'kick'].includes(p.value)) gs[p.key] = p.value
                else if (ANTI_KEYS.some(k => p.key === k + 'Limit') && (p.value === 'none' || (Number.isInteger(+p.value) && +p.value >= 1 && +p.value <= 10))) gs[p.key] = p.value === 'none' ? 'none' : +p.value
                else if (p.key === 'slowmode' && Number.isInteger(+p.value) && +p.value >= 0) gs.slowmode = +p.value
                else if (p.key === 'blacklist' && Array.isArray(p.value)) gs.blacklist = p.value.map(String).slice(0, 100)
                else return J(400, { error: 'Invalid setting.' })
                saveCtx(ctx)
                return J(200, { settings: gs })
            }
            return J(400, { error: 'Unknown request.' })
        }
"""
rep(anchor, new_route + anchor, "new /api/group-settings route (list groups, get/set per-group protection)")

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
