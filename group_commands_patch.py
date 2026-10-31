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

anchor = "        if (url === '/api/image' && req.method === 'POST') {"
route = r"""        if (url === '/api/group-info' || url === '/api/group-action') {
            if (!user) return J(401, { error: 'Log in first.' })
            const s = sessions['sess_' + user], ctx = s && s.ctx
            if (!ctx || !s.sock) return J(409, { error: 'Your number is not connected.' })
            const sock = s.sock
            let gid = q.get('group') || ''
            let p = {}
            if (req.method === 'POST') { try { p = JSON.parse(await body(6000)) } catch (e) {} gid = String(p.group || '') }
            if (!/@g\.us$/.test(gid)) return J(400, { error: 'Pick a group first.' })
            let meta
            try { meta = await getGroupMeta(ctx, sock, gid, true) } catch (e) { return J(404, { error: 'That group is not available to this number.' }) }
            const isMe = x => isBotJid(sock, x.id) || [x.jid, x.lid, x.phoneNumber].some(v => v && isBotJid(sock, v))
            if (url === '/api/group-info') {
                return J(200, {
                    id: gid, name: meta.subject, desc: meta.desc || '', muted: !!meta.announce,
                    members: meta.participants.map(x => ({ id: x.id, number: bestNumber(x), admin: x.admin || null, me: isMe(x) }))
                })
            }
            if (req.method !== 'POST') return J(405, { error: 'POST only.' })
            const act = String(p.action || '')
            const refresh = () => getGroupMeta(ctx, sock, gid, true).catch(() => {})
            try {
                if (act === 'mute' || act === 'unmute') {
                    await sock.groupSettingUpdate(gid, act === 'mute' ? 'announcement' : 'not_announcement')
                    await refresh()
                    return J(200, { ok: true, muted: act === 'mute', message: act === 'mute' ? 'Group muted. Admins only.' : 'Group unmuted.' })
                }
                if (act === 'link' || act === 'revoke') {
                    if (act === 'revoke') await sock.groupRevokeInvite(gid)
                    const code = await sock.groupInviteCode(gid)
                    return J(200, { ok: true, link: 'https://chat.whatsapp.com/' + code, message: act === 'revoke' ? 'Link reset.' : 'Link ready.' })
                }
                if (act === 'tagall' || act === 'hidetag' || act === 'tagadmins') {
                    global.__gaLast = global.__gaLast || {}
                    const k = user + gid
                    if (Date.now() - (global.__gaLast[k] || 0) < 5000) return J(429, { error: 'Wait a few seconds between tags.' })
                    global.__gaLast[k] = Date.now()
                    const list = act === 'tagadmins' ? meta.participants.filter(x => x.admin) : meta.participants
                    const mentions = list.map(x => x.id)
                    const custom = String(p.text || '').slice(0, 300)
                    let out
                    if (act === 'tagadmins') {
                        out = `${SK_HEADER}\n\n📢 ${mono('ATTENTION ADMINS')}`
                        if (custom) out += `\n\n${mono(custom)}`
                        out += `\n\n» ${mono('GROUP')}  •  ${mono(meta.subject)}\n» ${mono('ADMINS')}  •  ${mono(String(mentions.length))}\n\n${SK_FOOTER}`
                    } else if (act === 'hidetag') {
                        out = `${SK_HEADER}\n\n📢 ${mono('ATTENTION')}`
                        if (custom) out += `\n\n${mono(custom)}`
                        out += `\n\n${SK_FOOTER}`
                    } else {
                        out = `${SK_HEADER}\n\n📢 ${mono('ATTENTION EVERYONE')}`
                        if (custom) out += `\n\n${mono(custom)}`
                        out += `\n\n» ${mono('GROUP')}  •  ${mono(meta.subject)}\n» ${mono('MEMBERS')}  •  ${mono(String(meta.participants.length))}\n\n${SK_FOOTER}`
                    }
                    await sock.sendMessage(gid, { text: out, mentions })
                    return J(200, { ok: true, message: 'Sent to the group.' })
                }
                if (act === 'promote' || act === 'demote' || act === 'kick') {
                    const wanted = (Array.isArray(p.targets) ? p.targets : []).map(String).slice(0, 5)
                    const ids = []
                    for (const id of wanted) {
                        const part = meta.participants.find(x => x.id === id)
                        if (!part || isMe(part)) continue
                        if ((act === 'kick' || act === 'promote') && part.admin) continue
                        if (act === 'demote' && !part.admin) continue
                        ids.push(id)
                    }
                    if (!ids.length) return J(400, { error: 'Nothing to do for that member. Admins cannot be kicked, and you cannot target yourself.' })
                    const r = await participantsUpdate(sock, gid, ids, act === 'kick' ? 'remove' : act)
                    await refresh()
                    if (!r.ok) return J(403, { error: 'WhatsApp refused that. This number must be a group admin.' })
                    return J(200, { ok: true, message: act === 'kick' ? 'Removed.' : act === 'promote' ? 'Promoted to admin.' : 'Admin removed.' })
                }
                if (act === 'add') {
                    const digits = String(p.number || '').replace(/[^0-9]/g, '')
                    if (digits.length < 7 || digits.length > 15) return J(400, { error: 'Enter a valid number with country code.' })
                    const r = await participantsUpdate(sock, gid, [normalizeJid(digits)], 'add')
                    if (r.ok) { await refresh(); return J(200, { ok: true, message: 'Added +' + digits + '.' }) }
                    const st = String(r.res && r.res[0] && r.res[0].status)
                    if (st === '403') return J(400, { error: 'They only allow adds through an invite link.' })
                    if (st === '409') return J(400, { error: 'Already in the group.' })
                    if (st === '408') return J(400, { error: 'They recently left the group.' })
                    return J(403, { error: 'Could not add. This number must be a group admin.' })
                }
                if (act === 'setname') {
                    const t = String(p.text || '').trim()
                    if (!t || t.length > 100) return J(400, { error: 'Name must be 1 to 100 characters.' })
                    await sock.groupUpdateSubject(gid, t); await refresh()
                    return J(200, { ok: true, message: 'Name changed.' })
                }
                if (act === 'setdesc') {
                    const t = String(p.text || '').trim()
                    if (!t || t.length > 2000) return J(400, { error: 'Description must be 1 to 2000 characters.' })
                    await sock.groupUpdateDescription(gid, t); await refresh()
                    return J(200, { ok: true, message: 'Description saved.' })
                }
                if (act === 'leave') {
                    if (p.confirm !== true) return J(400, { error: 'Confirmation required.' })
                    await sock.groupLeave(gid)
                    delete ctx.metaCache[gid]
                    return J(200, { ok: true, message: 'Left the group.' })
                }
                return J(400, { error: 'Unknown action.' })
            } catch (e) {
                console.log('[group-action]', act, e && e.message || e)
                return J(403, { error: 'WhatsApp refused that. This number must be a group admin.' })
            }
        }

"""
rep(anchor, route + anchor, "new /api/group-info and /api/group-action routes (all group commands, per group)")

open('bot.js', 'w', encoding='utf-8').write(content)
print("\nApplied:", len(changes))
for c in changes: print(" -", c)
