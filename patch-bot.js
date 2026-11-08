#!/usr/bin/env node
// patch-bot.js: patches bot.js in place (no nano). Usage:  node patch-bot.js [bot.js]
// Safe: backs up first, each patch must match exactly once, syntax-checks before writing.
const fs = require('fs')
const cp = require('child_process')

const target = process.argv[2] || 'bot.js'
if (!fs.existsSync(target)) { console.log('Cannot find ' + target + ' - run this inside your bot folder.'); process.exit(1) }

const self = fs.readFileSync(__filename, 'utf8')
const START = '/*' + '@@PATCHES\n'
const END = '\n@@END' + '*/'
const data = self.slice(self.indexOf(START) + START.length, self.lastIndexOf(END))
const blocks = data.split(/^@@@ /m).slice(1)

let src = fs.readFileSync(target, 'utf8')
const report = []
for (const b of blocks) {
    const m = b.match(/^(.*)\n<<<<\n([\s\S]*?)\n====\n([\s\S]*?)>>>>\s*$/)
    if (!m) { report.push(['BAD BLOCK', b.split('\n')[0]]); continue }
    const name = m[1].trim()
    const oldS = m[2]
    const newS = m[3].replace(/\n$/, '')
    const first = src.indexOf(oldS)
    if (newS !== '' && src.includes(newS) && (first === -1 || newS.includes(oldS))) { report.push(['already applied', name]); continue }
    if (first === -1 && newS === '') { report.push(['already applied', name]); continue }
    if (first === -1) { report.push(['NOT FOUND', name]); continue }
    if (src.indexOf(oldS, first + 1) !== -1) { report.push(['AMBIGUOUS', name]); continue }
    src = src.slice(0, first) + newS + src.slice(first + oldS.length)
    report.push(['applied', name])
}

const tmp = target + '.patchcheck.js'
fs.writeFileSync(tmp, src)
const chk = cp.spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
fs.unlinkSync(tmp)
for (const [st, nm] of report) console.log((st === 'applied' ? '  + ' : st === 'already applied' ? '  = ' : '  X ') + st.padEnd(15) + nm)
if (chk.status !== 0) {
    console.log('\nSYNTAX CHECK FAILED. Nothing was written. Error:\n' + chk.stderr)
    process.exit(1)
}
const nApplied = report.filter(r => r[0] === 'applied').length
if (nApplied === 0) { console.log('\nNothing to change.'); process.exit(0) }
let bak = target + '.bak'
if (fs.existsSync(bak)) bak = target + '.' + Date.now() + '.bak'
fs.copyFileSync(target, bak)
fs.writeFileSync(target, src)
console.log('\nDone. ' + nApplied + ' patches applied. Backup: ' + bak)
const bad = report.filter(r => r[0] === 'NOT FOUND' || r[0] === 'AMBIGUOUS' || r[0] === 'BAD BLOCK')
if (bad.length) console.log('Skipped ' + bad.length + ' (see X above). Your bot.js differs there; tell me which.')
console.log('Restart the bot to load the changes.')
process.exit(0)

/*@@PATCHES
@@@ DEV state: block log field
<<<<
const DEV = { blocked: [], disabled: [], maintenance: false, ownerOnly: false, maxSlots: 0 }
====
const DEV = { blocked: [], blockLog: [], disabled: [], maintenance: false, ownerOnly: false, maxSlots: 0 }
>>>>
@@@ DEV state: fixed file path + Mongo copy + helpers
<<<<
const DEV_FILE = 'dev_state.json'
try { Object.assign(DEV, JSON.parse(fs.readFileSync(DEV_FILE, 'utf-8'))) } catch (e) {}
function saveDev() { try { fs.writeFileSync(DEV_FILE, JSON.stringify(DEV)) } catch (e) {} }
====
const DEV_FILE = path.join(__dirname, 'dev_state.json')
try { Object.assign(DEV, JSON.parse(fs.readFileSync(fs.existsSync(DEV_FILE) ? DEV_FILE : 'dev_state.json', 'utf-8'))) } catch (e) {}
if (!Array.isArray(DEV.blockLog)) DEV.blockLog = []
function saveDev() {
    try { fs.writeFileSync(DEV_FILE, JSON.stringify(DEV)) } catch (e) {}
    if (settingsCollection) settingsCollection.updateOne({ _id: 'dev_state' }, { $set: { value: JSON.parse(JSON.stringify(DEV)) } }, { upsert: true }).catch(() => {})
}
async function loadDevFromMongo() {
    if (!settingsCollection) return
    try {
        const d = await settingsCollection.findOne({ _id: 'dev_state' })
        if (d && d.value) {
            const blocked = new Set([...(DEV.blocked || []), ...(d.value.blocked || [])])
            const log = [...(DEV.blockLog || []), ...(d.value.blockLog || [])]
            const seen = new Set()
            const merged = log.filter(e => { const k = e.number + '|' + e.at; if (seen.has(k)) return false; seen.add(k); return true })
            Object.assign(DEV, d.value)
            DEV.blocked = [...blocked]
            DEV.blockLog = merged.slice(-300)
            if (!Array.isArray(DEV.disabled)) DEV.disabled = []
        }
        saveDev()
    } catch (e) {}
}
function devLogBlock(n, how) {
    const e = DEV.blockLog.find(x => x.number === n && !x.unblockedAt)
    if (e) { e.how = how; return }
    DEV.blockLog.push({ number: n, how, at: Date.now() })
    DEV.blockLog = DEV.blockLog.slice(-300)
}
function devLogUnblock(n) { for (const e of DEV.blockLog) if (e.number === n && !e.unblockedAt) e.unblockedAt = Date.now() }
function devBlockedList() {
    return DEV.blocked.map(n => { const e = [...DEV.blockLog].reverse().find(x => x.number === n && !x.unblockedAt); return { number: n, how: e ? e.how : 'blocked', at: e ? e.at : 0 } })
}
const DEV_TOK = new Map()
function devTokOk(req) {
    const t = String(req.headers['x-dev-token'] || '')
    const e = t && DEV_TOK.get(t)
    if (!e) return false
    if (e < Date.now()) { DEV_TOK.delete(t); return false }
    DEV_TOK.set(t, Date.now() + 3600000)
    return true
}
setInterval(() => { const n = Date.now(); for (const [t, e] of DEV_TOK) if (e < n) DEV_TOK.delete(t) }, 600000).unref()
function hostMemory() {
    const rd = f => { try { return fs.readFileSync(f, 'utf8').trim() } catch (e) { return '' } }
    const total = os.totalmem()
    let lim = rd('/sys/fs/cgroup/memory.max'), cur = rd('/sys/fs/cgroup/memory.current'), v2 = !!cur
    if (!cur) { lim = rd('/sys/fs/cgroup/memory/memory.limit_in_bytes'); cur = rd('/sys/fs/cgroup/memory/memory.usage_in_bytes') }
    let limitB = Number(lim), source = 'container'
    if (!lim || lim === 'max' || !isFinite(limitB) || limitB <= 0 || limitB > total * 2) { limitB = total; source = 'host' }
    let usedB = Number(cur)
    if (!isFinite(usedB) || usedB <= 0) { usedB = total - os.freemem(); source = 'host' }
    else {
        const st = rd(v2 ? '/sys/fs/cgroup/memory.stat' : '/sys/fs/cgroup/memory/memory.stat')
        const m = st.match(/^(?:inactive_file|total_inactive_file) (\d+)/m)
        if (m) usedB = Math.max(0, usedB - Number(m[1]))
    }
    const limit = Math.round(limitB / 1048576), used = Math.min(limit, Math.round(usedB / 1048576))
    return { used, limit, free: Math.max(0, limit - used), source }
}
>>>>
@@@ load dev state from Mongo at startup
<<<<
    await loadKeyOverrides()

    let ids = []
====
    await loadKeyOverrides()
    await loadDevFromMongo()

    let ids = []
>>>>
@@@ dev-keys accepts dev token
<<<<
if (!__isLocalReq(req) && String(req.headers['x-dev-key'] || '') !== (process.env.DEV_KEY || '')) return J(403, { error: 'Wrong developer key.' })
====
if (!__isLocalReq(req) && !devTokOk(req) && String(req.headers['x-dev-key'] || '') !== (process.env.DEV_KEY || '')) return J(403, { error: 'Wrong developer key.' })
>>>>
@@@ dev accepts dev token
<<<<
if (!__isLocalReq(req) && req.headers['x-dev-key'] !== key) return J(403, { error: 'Wrong developer key.' })
====
if (!__isLocalReq(req) && !devTokOk(req) && req.headers['x-dev-key'] !== key) return J(403, { error: 'Wrong developer key.' })
>>>>
@@@ dev GET: host memory + blocked list
<<<<
pid: process.pid, mem: Math.round(process.memoryUsage().rss / 1048576), uptime: formatUptime(process.uptime()) })
====
pid: process.pid, mem: Math.round(process.memoryUsage().rss / 1048576), uptime: formatUptime(process.uptime()),
                    host: hostMemory(), blockedList: devBlockedList(), blockHistory: DEV.blockLog.filter(e => e.unblockedAt).slice(-50).reverse() })
>>>>
@@@ dev: log block
<<<<
if (p.action === 'block' && n) { if (!DEV.blocked.includes(n)) DEV.blocked.push(n) }
====
if (p.action === 'block' && n) { if (!DEV.blocked.includes(n)) DEV.blocked.push(n); devLogBlock(n, 'blocked') }
>>>>
@@@ dev: log unblock
<<<<
else if (p.action === 'unblock' && n) DEV.blocked = DEV.blocked.filter(x => x !== n)
====
else if (p.action === 'unblock' && n) { DEV.blocked = DEV.blocked.filter(x => x !== n); devLogUnblock(n) }
>>>>
@@@ dev: log kill
<<<<
else if (p.action === 'kill' && n) { if (!DEV.blocked.includes(n)) DEV.blocked.push(n); await kill() }
====
else if (p.action === 'kill' && n) { if (!DEV.blocked.includes(n)) DEV.blocked.push(n); devLogBlock(n, 'killed'); saveDev(); await kill() }
>>>>
@@@ dev: freemem returns host stats
<<<<
else if (p.action === 'freemem') { return J(200, Object.assign({ ok: true }, freeMemory())) }
====
else if (p.action === 'freemem') { return J(200, Object.assign({ ok: true }, freeMemory(), { host: hostMemory() })) }
>>>>
@@@ freeMemory: works without --expose-gc
<<<<
    let gcRan = false
    try { if (global.gc) { global.gc(); gcRan = true } } catch (e) {}
    let filesRemoved = 0
    try {
        for (const f of fs.readdirSync('/tmp')) {
            if (/^(song|video|tt|yt)_.*\.(mp3|mp4|webm|m4a|opus|ogg)$/i.test(f)) {
                try { fs.unlinkSync(path.join('/tmp', f)); filesRemoved++ } catch (e) {}
            }
        }
    } catch (e) {}
    CMD_USAGE.recent = CMD_USAGE.recent.slice(0, 40)
====
    let gcRan = false
    try { if (!global.gc) { require('v8').setFlagsFromString('--expose-gc'); global.gc = require('vm').runInNewContext('gc') } } catch (e) {}
    try { for (const s of Object.values(sessions)) { if (s && s.ctx && s.ctx.metaCache) s.ctx.metaCache = {} } } catch (e) {}
    try { dohCache.clear() } catch (e) {}
    let filesRemoved = 0
    for (const dir of [...new Set(['/tmp', os.tmpdir()])]) {
        try {
            for (const f of fs.readdirSync(dir)) {
                if (/^(song|video|tt|yt|sticker|toimg)_.*\.(mp3|mp4|webm|m4a|opus|ogg|webp|png|jpg)$/i.test(f)) {
                    try { fs.unlinkSync(path.join(dir, f)); filesRemoved++ } catch (e) {}
                }
            }
        } catch (e) {}
    }
    CMD_USAGE.recent = CMD_USAGE.recent.slice(0, 40)
    try { if (global.gc) { global.gc(); gcRan = true } } catch (e) {}
>>>>
@@@ API: dev unlock/lock/status, wish, broadcast
<<<<
        if (url === '/api/dev-keys') {
====
        if (url === '/api/dev-unlock' && req.method === 'POST') {
            if (!user) return J(401, { error: 'Log in first.' })
            global.__devAtt = global.__devAtt || {}
            const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
            const hits = global.__devAtt[ip] = (global.__devAtt[ip] || []).filter(x => Date.now() - x < 600000)
            if (hits.length >= 5) return J(429, { error: 'Too many wrong keys. Try again in 10 minutes.' })
            let p = {}; try { p = JSON.parse(await body(1000)) } catch (e) {}
            const real = process.env.DEV_KEY || ''
            const local = __isLocalReq(req)
            if (!local && !real) return J(403, { error: 'Set DEV_KEY in your environment to use developer tools.' })
            if (!local) {
                const h = x => crypto.createHash('sha256').update(String(x || '')).digest()
                if (!crypto.timingSafeEqual(h(p.key), h(real))) { hits.push(Date.now()); return J(403, { error: 'Wrong developer key.' }) }
            }
            const token = crypto.randomBytes(24).toString('hex')
            DEV_TOK.set(token, Date.now() + 3600000)
            return J(200, { token, ttl: 3600000 })
        }
        if (url === '/api/dev-lock' && req.method === 'POST') {
            DEV_TOK.delete(String(req.headers['x-dev-token'] || ''))
            return J(200, { ok: true })
        }
        if (url === '/api/dev-status') {
            return J(200, { unlocked: devTokOk(req) })
        }
        if (url === '/api/wish' && req.method === 'POST') {
            if (!user) return J(401, { error: 'Log in first.' })
            const s = sessions['sess_' + user], ctx = s && s.ctx
            if (!ctx || !s.sock) return J(409, { error: 'Your number is not connected.' })
            if (DEV.blocked.includes(user)) return J(403, { error: skBlocked() })
            if (!isExemptNumber(user)) {
                if (DEV.ownerOnly) return J(403, { error: 'Restricted right now.' })
                if (DEV.maintenance) return J(403, { error: skMaintenance() })
            }
            global.__wishLast = global.__wishLast || {}
            if (Date.now() - (global.__wishLast[user] || 0) < 8000) return J(429, { error: 'Wait a few seconds between wishes.' })
            let p = {}; try { p = JSON.parse(await body(6000)) } catch (e) {}
            const sock = s.sock
            const senderName = String(p.from || '').trim().slice(0, 40) || null
            const celebrant = String(p.name || '').trim().slice(0, 40) || null
            const celebrantDisplay = celebrant ? titleCase(celebrant) : ''
            const quote = String(p.quote || '').trim().slice(0, 400) || ((ctx.cfg.birthdayMsg && ctx.cfg.birthdayMsg.trim()) ? ctx.cfg.birthdayMsg.trim() : getRandom(BIRTHDAY_QUOTES))
            const namedQuote = celebrantDisplay ? quote.replace('{name}', ', ' + celebrantDisplay) : quote.replace('{name}', '')
            const fromLine = senderName ? '» ' + mono('FROM') + '  •  ' + mono(titleCase(senderName)) + '\n\n' : ''
            const mkStages = toLine => [
                `${SK_HEADER}\n\n${italic(titleCase(senderName || 'The realm'))} says...`,
                `${SK_HEADER}\n\n${italic('Happy birthday to you')} 🎈`,
                `${SK_HEADER}\n\n${italic('Happy birthday to you')} 🎉`,
                `${SK_HEADER}\n\n${italic('Happy birthday!')} 🎂`,
                `${SK_HEADER}\n\n${italic('Happy birthday!!')} 🎂🎂`,
                `${SK_HEADER}\n\n${italic('Happy birthday to you!!!')} 🎂🎂🎂`,
                withFooter(`${SK_HEADER}\n\n🎉🎂🎈\n\n${fromLine}${toLine}${italic(namedQuote)}`)
            ]
            const delays = [3500, 1500, 1500, 1500, 1500, 3500]
            if (p.type === 'group') {
                const gid = String(p.group || '')
                if (!/@g\.us$/.test(gid)) return J(400, { error: 'Pick a group first.' })
                try { await getGroupMeta(ctx, sock, gid, true) } catch (e) { return J(404, { error: 'That group is not available to this number.' }) }
                const memberJid = /@(s\.whatsapp\.net|lid)$/.test(String(p.member || '')) ? String(p.member) : ''
                const mnum = String(p.memberNumber || '').replace(/[^0-9]/g, '') || memberJid.split('@')[0]
                const stages = mkStages(memberJid ? '» ' + mono('TO') + '  •  @' + mnum + '\n\n' : '')
                const mentions = memberJid ? mentionJids(sock, [memberJid], [mnum]) : []
                global.__wishLast[user] = Date.now()
                J(200, { ok: true, message: 'The wish is playing in the group.' })
                ;(async () => {
                    try {
                        const img = getImg(ctx, 'birthday')
                        if (img) { try { await sock.sendMessage(gid, { image: img }) } catch (e) {} }
                        const sent = await sock.sendMessage(gid, { text: stages[0] })
                        const k = sent && sent.key
                        if (!k) return
                        for (let i = 1; i < stages.length; i++) {
                            await sleep(delays[i - 1])
                            const last = i === stages.length - 1 && mentions.length
                            try { await sock.sendMessage(gid, last ? { text: stages[i], edit: k, mentions } : { text: stages[i], edit: k }) } catch (e) {}
                        }
                    } catch (e) { console.log('[WISH] group failed:', e && e.message) }
                })()
                return
            }
            if (p.type === 'private') {
                const num = String(p.number || '').replace(/[^0-9]/g, '')
                if (num.length < 7 || num.length > 15) return J(400, { error: 'Enter a valid number with country code.' })
                const toJid = normalizeJid(num)
                const probeFrom = senderName ? sansBold(senderName.toUpperCase()) : sansBold('THE REALM')
                const probeText = withFooter(`${SK_HEADER}\n\n✧ ${sansBold('A MESSAGE FROM')} ${probeFrom}...\n\n⛩️ ${mono('ARE YOU THERE?')}`)
                try { await sock.sendMessage(toJid, { text: probeText }) } catch (e) { return J(400, { error: 'That number is not on WhatsApp.' }) }
                ctx.hbdPending[toJid] = { sender: senderName, celebrant, block: !!p.block, ts: Date.now(), session: ctx.sessionId, stages: mkStages(''), delays }
                global.__wishLast[user] = Date.now()
                setTimeout(async () => {
                    if (!ctx.hbdPending[toJid]) return
                    delete ctx.hbdPending[toJid]
                    const selfJid = getBotJid(sock)
                    if (selfJid) { try { await sock.sendMessage(selfJid, { text: skInfo('⏳', 'NO REPLY', [['TO', '+' + num], ['TIME', '24h elapsed']]) }) } catch (e) {} }
                }, 24 * 60 * 60 * 1000)
                return J(200, { ok: true, message: 'Sent. The wish plays when they reply.' })
            }
            return J(400, { error: 'Pick group or private.' })
        }
        if (url === '/api/broadcast' && req.method === 'POST') {
            if (!user) return J(401, { error: 'Log in first.' })
            const s = sessions['sess_' + user], ctx = s && s.ctx
            if (!ctx || !s.sock) return J(409, { error: 'Your number is not connected.' })
            if (DEV.blocked.includes(user)) return J(403, { error: skBlocked() })
            if (!isExemptNumber(user)) {
                if (DEV.ownerOnly) return J(403, { error: 'Restricted right now.' })
                if (DEV.maintenance) return J(403, { error: skMaintenance() })
            }
            let p = {}; try { p = JSON.parse(await body(4000)) } catch (e) {}
            if (!p.confirm) return J(400, { error: 'Confirm first.' })
            const text = String(p.text || '').trim().slice(0, 800)
            if (!text) return J(400, { error: 'Type a message first.' })
            global.__bcLast = global.__bcLast || {}
            if (Date.now() - (global.__bcLast[user] || 0) < 5 * 60 * 1000) return J(429, { error: 'Wait a few minutes between broadcasts.' })
            let groups = []
            try { groups = Object.keys(await s.sock.groupFetchAllParticipating()).slice(0, 40) } catch (e) { return J(502, { error: 'Could not load your groups.' }) }
            if (!groups.length) return J(400, { error: 'This number is not in any group.' })
            global.__bcLast[user] = Date.now()
            J(200, { ok: true, message: 'Broadcast started for ' + groups.length + ' group(s).' })
            ;(async () => { for (const g of groups) { try { await s.sock.sendMessage(g, { text }) } catch (e) {} await sleep(3000 + Math.floor(Math.random() * 3000)) } })()
            return
        }
        if (url === '/api/dev-keys') {
>>>>
@@@ group-action: send message
<<<<
                if (act === 'promote' || act === 'demote' || act === 'kick') {
====
                if (act === 'send') {
                    const text = String(p.text || '').trim().slice(0, 900)
                    if (!text) return J(400, { error: 'Type a message first.' })
                    global.__gaLast = global.__gaLast || {}
                    const k2 = user + gid + 'send'
                    if (Date.now() - (global.__gaLast[k2] || 0) < 3000) return J(429, { error: 'Wait a few seconds.' })
                    global.__gaLast[k2] = Date.now()
                    await sock.sendMessage(gid, { text })
                    return J(200, { ok: true, message: 'Message sent.' })
                }
                if (act === 'promote' || act === 'demote' || act === 'kick') {
>>>>
@@@ assistant module (normal mode, actions, owner mode, GitHub)
<<<<
const __isLocalReq = req => /localhost|127\.0\.0\.1/.test(String(req.headers.host || '')) && !req.headers['x-forwarded-for'] && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(String(req.socket.remoteAddress || ''))
====
// ===== assistant: normal mode, dashboard control, owner mode =====
const AI_THEME_NAMES = ['Obsidian Gold', 'Midnight Sapphire', 'Royal Amethyst', 'Emerald Noir', 'Burgundy & Gold', 'Rose Gold Dusk', 'Arctic Aurora', 'Carbon Copper', 'Onyx Platinum', 'Deep Ocean Teal', 'Nebula Violet', 'Mocha Bronze', 'Sunset Amber', 'Forest Moss', 'Sakura Twilight', 'Graphite Silver', 'Champagne Ivory', 'Pearl Blush']
const AI_TEXT_NAMES = ['Ivory Cream', 'Pure White', 'Champagne Gold', 'Rose', 'Mint', 'Sky Ice', 'Lavender', 'Peach', 'Silver', 'Amber', 'default']
const AI_PAGES = ['home', 'connect', 'sessions', 'commands', 'settings', 'protection', 'wishes', 'themes', 'logs', 'media', 'apikeys', 'analytics', 'templates', 'owner']
const AI_SETTING_KEYS = ['typing', 'delay', 'read', 'online', 'autoreact', 'statusreact', 'statusview', 'eventsWelcome', 'eventsGoodbye']
function aiFn(name, description, properties, required) { return { type: 'function', function: { name, description, parameters: { type: 'object', properties: properties || {}, required: required || [] } } } }
const AI_TOOLS = [
    aiFn('set_theme', 'Change the dashboard colour theme.', { name: { type: 'string', enum: AI_THEME_NAMES } }, ['name']),
    aiFn('set_text_colour', 'Change the dashboard text colour. Use default to go back to the theme text colour.', { name: { type: 'string', enum: AI_TEXT_NAMES } }, ['name']),
    aiFn('set_light_dark', 'Switch the dashboard between light and dark mode.', { mode: { type: 'string', enum: ['light', 'dark'] } }, ['mode']),
    aiFn('open_page', 'Open a dashboard page.', { page: { type: 'string', enum: AI_PAGES } }, ['page']),
    aiFn('connect_number', 'Link a WhatsApp number and show its pairing code. The number must include the country code, digits only.', { number: { type: 'string' } }, ['number']),
    aiFn('disconnect_number', 'Disconnect the number that is logged in on this device. The user is asked to confirm first.', {}),
    aiFn('toggle_setting', 'Turn one of the logged-in number\'s bot settings on or off.', { setting: { type: 'string', enum: AI_SETTING_KEYS }, value: { type: 'boolean' } }, ['setting', 'value']),
    aiFn('set_bot_mode', 'Set the logged-in number\'s bot mode to public or private.', { mode: { type: 'string', enum: ['public', 'private'] } }, ['mode'])
]
function aiActionsFromCalls(calls) {
    const actions = []
    for (const tc of calls || []) {
        let a = {}; try { a = JSON.parse(tc.function.arguments || '{}') } catch (e) {}
        const n = tc.function && tc.function.name
        if (n === 'set_theme' && AI_THEME_NAMES.includes(a.name)) actions.push({ type: 'theme', name: a.name })
        else if (n === 'set_text_colour' && AI_TEXT_NAMES.includes(a.name)) actions.push({ type: 'text', name: a.name })
        else if (n === 'set_light_dark' && ['light', 'dark'].includes(a.mode)) actions.push({ type: 'mode', value: a.mode })
        else if (n === 'open_page' && AI_PAGES.includes(a.page)) actions.push({ type: 'page', page: a.page })
        else if (n === 'connect_number') { const d = String(a.number || '').replace(/[^0-9]/g, ''); if (d.length >= 8 && d.length <= 15) actions.push({ type: 'connect', number: d }) }
        else if (n === 'disconnect_number') actions.push({ type: 'disconnect', confirm: true })
        else if (n === 'toggle_setting' && AI_SETTING_KEYS.includes(a.setting) && typeof a.value === 'boolean') actions.push({ type: 'setting', key: a.setting, value: a.value })
        else if (n === 'set_bot_mode' && ['public', 'private'].includes(a.mode)) actions.push({ type: 'botmode', value: a.mode })
    }
    return actions.slice(0, 4)
}
function aiActionText(actions) {
    const t = actions.map(a => a.type === 'theme' ? 'Switching to ' + a.name + '.' : a.type === 'text' ? (a.name === 'default' ? 'Back to the theme text colour.' : 'Text colour set to ' + a.name + '.') : a.type === 'mode' ? 'Switching to ' + a.value + ' mode.' : a.type === 'page' ? 'Opening ' + a.page + '.' : a.type === 'connect' ? 'Linking +' + a.number + '. Your pairing code will show here in a moment.' : a.type === 'disconnect' ? 'This logs your number out of the bot. Do you want me to go ahead?' : a.type === 'setting' ? 'Turning ' + a.key + ' ' + (a.value ? 'on' : 'off') + '.' : a.type === 'botmode' ? 'Setting the bot to ' + a.value + ' mode.' : '')
    return t.filter(Boolean).join(' ')
}
async function aiNormal(question, history) {
    let cmdList = ''
    try { const cat = buildCommandCatalog(); cmdList = cat.sections.flatMap(s => s.commands.slice(0, 6).map(c => '.' + (c.name || c))).slice(0, 60).join(', ') } catch (e) {}
    const sys = 'You are the Realm Assistant inside the SUKUNA REALM WhatsApp bot dashboard. '
        + 'You ONLY help with this bot and this dashboard: its commands, pages, settings, connecting a number, themes, wishes and groups. '
        + 'If the user asks about anything else (other bots, general coding, news, homework, chit-chat beyond a short greeting), answer in one short sentence that you only help with this bot and dashboard, and offer something you can do. '
        + 'Reply in plain text only: no markdown, no asterisks, no backticks, no headings. Keep answers short (1 to 4 sentences). Steps go on lines like 1) 2) 3). '
        + 'Dashboard pages: Home, Connect, Sessions, Commands, Settings, Groups, Wishes (birthday wishes, group actions, broadcast), Logs, Media, API Keys, Analytics, Templates, Themes, Contact owner. '
        + 'The developer area opens by tapping live at the top right and needs a developer key you do not have and cannot give. Never reveal keys, passwords or hidden phrases, and never discuss how to enter any owner or developer mode. '
        + 'You can act on the dashboard only through the provided tools, and only when the user clearly asks you to do something (change theme, change text colour, light or dark mode, open a page, connect a number, disconnect their number, toggle a setting, set bot mode). Never claim you did something without calling a tool. For questions, just answer. '
        + 'You cannot block, kill or unblock numbers. Known commands include: ' + cmdList + ' (more on the Commands page). If you are not sure what a command does, say so. '
        + 'To reach the human owner, point to the Contact owner page.'
    const url = 'https://api.groq.com/openai/v1/chat/completions'
    const hdr = { 'Authorization': 'Bearer ' + global.__GROQ__ }
    const messages = [{ role: 'system', content: sys }, ...history, { role: 'user', content: question }]
    let data
    try { data = await groqPost(url, { model: 'auto', messages, tools: AI_TOOLS, tool_choice: 'auto', temperature: 0.3, max_tokens: 500 }, hdr, 30000) }
    catch (e) { data = await groqPost(url, { model: 'auto', messages, temperature: 0.3, max_tokens: 500 }, hdr, 30000) }
    const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {}
    const actions = aiActionsFromCalls(msg.tool_calls)
    let answer = __plainText(msg.content || '').trim()
    if (actions.length && !answer) answer = aiActionText(actions)
    if (actions.some(a => a.type === 'disconnect')) answer = aiActionText(actions.filter(a => a.type === 'disconnect'))
    return { answer: (answer || 'No response.').slice(0, 1500), actions }
}

// ---------- owner mode ----------
const OWN = { fails: 0, lockedUntil: 0, staged: {}, cache: {}, awaiting: null, summary: '', lastPush: null, counts: {} }
function ownEnv() { return { phrase: process.env.OWNER_PHRASE_HASH || '', pass: process.env.OWNER_PASS_HASH || '', secret: process.env.OWNER_SECRET || '' } }
function ownEnabled() { const e = ownEnv(); return !!(e.phrase && e.pass && e.secret.length >= 16) }
function ownNorm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim() }
function ownSafeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y) }
function ownPhraseOk(norm) { return ownSafeEq(crypto.createHash('sha256').update(norm).digest('hex'), ownEnv().phrase.toLowerCase()) }
function ownPassOk(pw) {
    try {
        const [salt, hash] = ownEnv().pass.split(':')
        const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64).toString('hex')
        return ownSafeEq(got, hash.toLowerCase())
    } catch (e) { return false }
}
function ownSign(obj) { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', ownEnv().secret).update(b).digest('base64url') }
function ownVerify(tok, type) {
    if (!tok) return null
    const [b, mac] = String(tok).split('.'); if (!b || !mac) return null
    if (!ownSafeEq(mac, crypto.createHmac('sha256', ownEnv().secret).update(b).digest('base64url'))) return null
    try { const o = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); return (o.t === type && o.exp > Date.now()) ? o : null } catch (e) { return null }
}
function ownCookies(req) { const out = {}; String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim() }); return out }
function ownCookie(req, name, val, maxAge) { const sec = (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? '; Secure' : ''; return name + '=' + val + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + sec }
const OWN_IDLE = 3600000, OWN_DEVICE = 30 * 86400000

function ghCfg() { return { token: process.env.GITHUB_TOKEN || '', repo: process.env.GITHUB_REPO || '', branch: process.env.GITHUB_BRANCH || 'main', dir: String(process.env.GITHUB_DIR || '').replace(/^\/+|\/+$/g, '') } }
function ghOk() { const c = ghCfg(); return !!(c.token && /^[\w.-]+\/[\w.-]+$/.test(c.repo)) }
function ghPath(file) { const c = ghCfg(); return (c.dir ? c.dir + '/' : '') + file }
function ghReq(method, apiPath, bodyObj, raw) {
    const c = ghCfg()
    return new Promise((resolve, reject) => {
        const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null
        const rq = https.request({ hostname: 'api.github.com', path: apiPath, method, headers: Object.assign({ 'Authorization': 'Bearer ' + c.token, 'User-Agent': 'sukuna-realm-bot', 'Accept': raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, r => {
            const ch = []; r.on('data', x => ch.push(x))
            r.on('end', () => {
                const t = Buffer.concat(ch).toString('utf8')
                if (r.statusCode >= 400) return reject(new Error('GitHub ' + r.statusCode + ': ' + t.slice(0, 160).replace(c.token, '***')))
                if (raw) return resolve(t)
                try { resolve(JSON.parse(t || '{}')) } catch (e) { reject(new Error('Bad reply from GitHub')) }
            })
        })
        rq.on('error', reject); rq.setTimeout(30000, () => rq.destroy(new Error('GitHub timeout')))
        if (data) rq.write(data); rq.end()
    })
}
const OWN_FILES = ['bot.js', 'dashboard.html']
async function ownBase(file) {
    const hit = OWN.cache[file]
    if (hit && Date.now() - hit.t < 30000) return hit.content
    let content
    if (ghOk()) { const c = ghCfg(); content = await ghReq('GET', '/repos/' + c.repo + '/contents/' + ghPath(file).split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(c.branch), null, true) }
    else content = fs.readFileSync(path.join(__dirname, file), 'utf8')
    OWN.cache[file] = { t: Date.now(), content }
    return content
}
async function ownCurrent(file) { return OWN.staged[file] ? OWN.staged[file].content : await ownBase(file) }
function ownCheck(file, base, content) {
    const out = []; let ok = true
    const note = (pass, text) => { out.push((pass ? 'OK: ' : 'FAILED: ') + text); if (!pass) ok = false }
    note(content.length >= base.length * 0.7, 'size looks right (' + base.length + ' to ' + content.length + ' characters)')
    if (file === 'bot.js') {
        note(content.split('\n').slice(0, 45).join('\n') === base.split('\n').slice(0, 45).join('\n'), 'first 45 lines untouched')
        const tmp = path.join(os.tmpdir(), 'own_check_' + Date.now() + '.js')
        fs.writeFileSync(tmp, content)
        const r = require('child_process').spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
        try { fs.unlinkSync(tmp) } catch (e) {}
        note(r.status === 0, 'syntax check' + (r.status === 0 ? '' : ': ' + String(r.stderr).split('\n').slice(0, 4).join(' ')))
        for (const k of ['startSession', 'handleCommand', 'http.createServer', 'restoreSessions()']) note(content.includes(k), 'still has ' + k)
    } else {
        const scripts = [...content.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
        let bad = ''
        for (let i = 0; i < scripts.length; i++) { try { new (require('vm').Script)(scripts[i]) } catch (e) { bad = 'script ' + (i + 1) + ': ' + e.message; break } }
        note(!bad, 'page scripts parse' + (bad ? ' (' + bad + ')' : ''))
        const ids = s => new Set([...s.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
        const idsBase = ids(base), idsNew = ids(content)
        const removed = [...idsBase].filter(x => !idsNew.has(x) && new RegExp('getElementById\\([\'"]' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]\\)').test(content))
        note(!removed.length, 'no element the scripts need was removed' + (removed.length ? ' (' + removed.slice(0, 5).join(', ') + ')' : ''))
        note(/<\/html>\s*$/.test(content), 'page ends properly')
    }
    return { ok, lines: out }
}
async function ownTool(name, a) {
    try {
        if (name === 'read_file' || name === 'search_file' || name === 'stage_edit') { if (!OWN_FILES.includes(a.file)) return 'Only bot.js and dashboard.html can be used.' }
        if (name === 'read_file') {
            const lines = (await ownCurrent(a.file)).split('\n')
            const s = Math.max(1, parseInt(a.start) || 1), e = Math.min(lines.length, Math.min(s + 119, parseInt(a.end) || s + 59))
            let out = 'Lines ' + s + '-' + e + ' of ' + lines.length + ':\n'
            for (let i = s; i <= e; i++) out += i + ': ' + lines[i - 1].slice(0, 260) + '\n'
            return out
        }
        if (name === 'search_file') {
            const q = String(a.query || '').toLowerCase(); if (!q) return 'Give a search text.'
            const lines = (await ownCurrent(a.file)).split('\n'), hits = []
            for (let i = 0; i < lines.length && hits.length < 25; i++) if (lines[i].toLowerCase().includes(q)) hits.push((i + 1) + ': ' + lines[i].trim().slice(0, 200))
            return hits.length ? hits.join('\n') : 'No matches.'
        }
        if (name === 'stage_edit') {
            const oldS = String(a.old_str || ''), newS = String(a.new_str == null ? '' : a.new_str)
            if (!oldS) return 'old_str is required (use an existing unique line as the anchor).'
            if (newS.length > 20000) return 'new_str is too long. Split it into smaller edits.'
            const cur = await ownCurrent(a.file), first = cur.indexOf(oldS)
            if (first < 0) return 'old_str was not found. Read the file again and copy the text exactly.'
            if (cur.indexOf(oldS, first + 1) >= 0) return 'old_str appears more than once. Add more surrounding text so it is unique.'
            if (Object.values(OWN.staged).reduce((n, x) => n + x.edits, 0) >= 30) return 'Too many edits staged. Call finish.'
            const next = cur.slice(0, first) + newS + cur.slice(first + oldS.length)
            const base = await ownBase(a.file)
            if (a.file === 'bot.js' && next.split('\n').slice(0, 45).join('\n') !== base.split('\n').slice(0, 45).join('\n')) return 'The first 45 lines of bot.js are protected and cannot be changed.'
            OWN.staged[a.file] = { content: next, edits: (OWN.staged[a.file] ? OWN.staged[a.file].edits : 0) + 1 }
            OWN.awaiting = null
            return 'Edit staged in ' + a.file + ' (' + OWN.staged[a.file].edits + ' so far).'
        }
        if (name === 'show_staged') return Object.keys(OWN.staged).length ? Object.entries(OWN.staged).map(([f, v]) => f + ': ' + v.edits + ' edit(s)').join('\n') : 'Nothing staged.'
        if (name === 'discard_staged') { OWN.staged = {}; OWN.awaiting = null; return 'Staged edits discarded.' }
        if (name === 'finish') {
            const files = Object.keys(OWN.staged)
            if (!files.length) return 'Nothing is staged yet.'
            const report = []; let ok = true
            for (const f of files) { const r = ownCheck(f, await ownBase(f), OWN.staged[f].content); if (!r.ok) ok = false; report.push(f + ':\n  ' + r.lines.join('\n  ')) }
            OWN.checkReport = report.join('\n')
            if (!ok) return 'Checks failed:\n' + OWN.checkReport + '\nFix the problem with more stage_edit calls (or discard_staged), then call finish again.'
            OWN.summary = String(a.summary || 'edit').slice(0, 300)
            OWN.awaiting = 'push'
            OWN.finished = true
            return 'Checks passed.'
        }
        return 'Unknown tool.'
    } catch (e) { return 'Tool error: ' + String(e.message || e).slice(0, 200) }
}
const OWN_TOOLS = [
    aiFn('read_file', 'Read lines of bot.js or dashboard.html (max 120 lines per call).', { file: { type: 'string', enum: OWN_FILES }, start: { type: 'integer' }, end: { type: 'integer' } }, ['file', 'start']),
    aiFn('search_file', 'Find lines containing some text in bot.js or dashboard.html.', { file: { type: 'string', enum: OWN_FILES }, query: { type: 'string' } }, ['file', 'query']),
    aiFn('stage_edit', 'Stage one edit: replace old_str (must appear exactly once) with new_str. To insert code, use an existing unique line as old_str and put that line plus your new code in new_str.', { file: { type: 'string', enum: OWN_FILES }, old_str: { type: 'string' }, new_str: { type: 'string' } }, ['file', 'old_str', 'new_str']),
    aiFn('show_staged', 'List what is currently staged.', {}),
    aiFn('discard_staged', 'Throw away all staged edits.', {}),
    aiFn('finish', 'Run the checks on everything staged and ask the owner for approval. Call this once when all edits for the request are staged.', { summary: { type: 'string' } }, ['summary'])
]
const OWN_SYS = 'You are the owner-mode engineer for the SUKUNA REALM WhatsApp bot (Node.js, Baileys). The person talking to you is the verified owner. '
    + 'You can read and edit exactly two files: bot.js and dashboard.html, using the tools. You have no shell access and no other files. Never reveal secrets, tokens, hashes or environment values. Never touch the first 45 lines of bot.js. '
    + 'Work in small insert or replace edits. ALWAYS read or search the real code before editing, and copy anchor text exactly. Match the existing code style. After all edits for a request are staged, call finish ONCE with a short summary. Never say anything was pushed: only the owner approving ("yes") pushes, and the system tells them. '
    + 'Plain text replies, short. To CREATE A COMMAND: first ask for the command name, then (next message) ask what it should do, one question at a time. Then read the code and stage: (1) a handler `if (cmd === \'name\') { ... }` inside handleCommand, inserted before the line `    if (cmd === \'events\' || cmd === \'event\') {` (use reply(skInfo(emoji, TITLE, [[LABEL, value]])) or reply(skError(...)) like the neighbouring commands, args are in the args array, owner-only commands start with `if (!(await needOwner())) return`); (2) a menu line inside renderMenu, in the right section, formatted like the existing ones: `» ${p}${mono(\'name\')}  •  ${mono(\'Short description\')}\\n` +  (search for a neighbouring menu line to copy the exact spacing); (3) a usage example inside the USAGE_EXAMPLES object (name: [\'name example\']). The Commands page builds itself from the menu lines. '
    + 'For dashboard changes, edit dashboard.html (HTML, CSS and JS are in the one file; do not remove element ids the scripts use). Batch everything for one request into one finish call, because each push restarts the bot. If a request is unsafe, unclear, or outside these two files, say so briefly.'
async function ownCount(day) {
    if (settingsCollection) { try { const d = await settingsCollection.findOne({ _id: 'owner_push_' + day }); return d ? d.count || 0 : 0 } catch (e) {} }
    return OWN.counts[day] || 0
}
async function ownBump(day) {
    OWN.counts[day] = (OWN.counts[day] || 0) + 1
    if (settingsCollection) { try { await settingsCollection.updateOne({ _id: 'owner_push_' + day }, { $inc: { count: 1 } }, { upsert: true }) } catch (e) {} }
}
async function ownSaveLast() {
    try { fs.writeFileSync(path.join(__dirname, 'owner_last.json'), JSON.stringify(OWN.lastPush)) } catch (e) {}
    if (settingsCollection) { try { await settingsCollection.updateOne({ _id: 'owner_last' }, { $set: { value: OWN.lastPush } }, { upsert: true }) } catch (e) {} }
}
async function ownLoadLast() {
    if (OWN.lastPush) return OWN.lastPush
    if (settingsCollection) { try { const d = await settingsCollection.findOne({ _id: 'owner_last' }); if (d && d.value) return (OWN.lastPush = d.value) } catch (e) {} }
    try { return (OWN.lastPush = JSON.parse(fs.readFileSync(path.join(__dirname, 'owner_last.json'), 'utf8'))) } catch (e) { return null }
}
async function ownPush() {
    const c = ghCfg()
    if (!ghOk()) return 'GITHUB_TOKEN or GITHUB_REPO is not set, so nothing was pushed. Your staged edits are kept.'
    const files = Object.keys(OWN.staged)
    if (!files.length) { OWN.awaiting = null; return 'Nothing is staged.' }
    const day = new Date().toISOString().slice(0, 10)
    const used = await ownCount(day)
    if (used >= 18) return 'You have used ' + used + ' deploys today, close to the daily limit. Try again tomorrow. Your staged edits are kept.'
    const ref = await ghReq('GET', '/repos/' + c.repo + '/git/ref/heads/' + c.branch)
    const head = ref.object.sha
    const commit = await ghReq('GET', '/repos/' + c.repo + '/git/commits/' + head)
    const tree = []
    for (const f of files) {
        const blob = await ghReq('POST', '/repos/' + c.repo + '/git/blobs', { content: Buffer.from(OWN.staged[f].content, 'utf8').toString('base64'), encoding: 'base64' })
        tree.push({ path: ghPath(f), mode: '100644', type: 'blob', sha: blob.sha })
    }
    const nt = await ghReq('POST', '/repos/' + c.repo + '/git/trees', { base_tree: commit.tree.sha, tree })
    const nc = await ghReq('POST', '/repos/' + c.repo + '/git/commits', { message: 'Owner AI: ' + String(OWN.summary || 'edit').slice(0, 70), tree: nt.sha, parents: [head] })
    await ghReq('PATCH', '/repos/' + c.repo + '/git/refs/heads/' + c.branch, { sha: nc.sha })
    OWN.lastPush = { prev: head, now: nc.sha, files, at: Date.now() }
    await ownSaveLast(); await ownBump(day)
    OWN.staged = {}; OWN.cache = {}; OWN.awaiting = null; OWN.summary = ''
    return 'Pushed ' + files.length + ' file(s) in one commit (deploy ' + (used + 1) + ' today). Your host redeploys now, so the bot restarts in a moment. Say "undo last change" if something is wrong.'
}
async function ownUndo() {
    const c = ghCfg()
    if (!ghOk()) return 'GITHUB_TOKEN or GITHUB_REPO is not set.'
    const last = await ownLoadLast()
    if (!last) return 'There is no pushed change to undo.'
    const ref = await ghReq('GET', '/repos/' + c.repo + '/git/ref/heads/' + c.branch)
    if (ref.object.sha !== last.now) return 'There are newer commits after that push, so I will not overwrite them. Undo it in GitHub by hand.'
    const prev = await ghReq('GET', '/repos/' + c.repo + '/git/commits/' + last.prev)
    const nc = await ghReq('POST', '/repos/' + c.repo + '/git/commits', { message: 'Undo owner AI change', tree: prev.tree.sha, parents: [last.now] })
    await ghReq('PATCH', '/repos/' + c.repo + '/git/refs/heads/' + c.branch, { sha: nc.sha })
    OWN.lastPush = null; OWN.cache = {}
    try { fs.unlinkSync(path.join(__dirname, 'owner_last.json')) } catch (e) {}
    if (settingsCollection) { try { await settingsCollection.deleteOne({ _id: 'owner_last' }) } catch (e) {} }
    return 'Undone. The last push was reverted in one new commit, and your host redeploys now.'
}
function ownChips() {
    if (OWN.awaiting === 'push') return [{ label: 'Yes, push', send: 'yes' }, { label: 'No, discard', send: 'no' }]
    if (OWN.awaiting === 'undo') return [{ label: 'Yes, undo', send: 'yes' }, { label: 'No', send: 'no' }]
    return []
}
async function ownerChat(question, history) {
    const norm = ownNorm(question)
    const yes = /^(yes|y|yeah|yep|push|confirm|approve|go ahead|ok|okay|do it)$/.test(norm)
    const no = /^(no|n|nope|cancel|discard|stop)$/.test(norm)
    if (OWN.awaiting === 'push' && yes) { try { return { answer: await ownPush() } } catch (e) { return { answer: 'Push failed: ' + String(e.message || e).slice(0, 200) + '. Your staged edits are kept.' } } }
    if (OWN.awaiting === 'undo' && yes) { OWN.awaiting = null; try { return { answer: await ownUndo() } } catch (e) { return { answer: 'Undo failed: ' + String(e.message || e).slice(0, 200) } } }
    if (OWN.awaiting && no) { const was = OWN.awaiting; OWN.awaiting = null; if (was === 'push') OWN.staged = {}; return { answer: was === 'push' ? 'Discarded. Nothing was pushed.' : 'Okay, nothing was undone.' } }
    if (/^undo( the)?( last)?( change)?$/.test(norm)) {
        const last = await ownLoadLast()
        if (!last) return { answer: 'There is no pushed change to undo.' }
        OWN.awaiting = 'undo'
        return { answer: 'This restores ' + last.files.join(' and ') + ' to how they were before the last push (one new commit, then a redeploy). Reply yes to confirm.' }
    }
    if (OWN.awaiting === 'push' && !yes && !no) OWN.awaiting = null
    const url = 'https://api.groq.com/openai/v1/chat/completions'
    const hdr = { 'Authorization': 'Bearer ' + global.__GROQ__ }
    const messages = [{ role: 'system', content: OWN_SYS + (Object.keys(OWN.staged).length ? ' Currently staged: ' + Object.entries(OWN.staged).map(([f, v]) => f + ' (' + v.edits + ' edits)').join(', ') + '.' : '') }, ...history, { role: 'user', content: question }]
    OWN.finished = false
    for (let round = 0; round < 10; round++) {
        let data
        try { data = await groqPost(url, { model: 'auto', messages, tools: OWN_TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 3000 }, hdr, 60000) }
        catch (e) { return { answer: 'The assistant could not respond. Try again.' } }
        const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {}
        if (msg.tool_calls && msg.tool_calls.length) {
            messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls })
            for (const tc of msg.tool_calls) {
                let a = {}; try { a = JSON.parse(tc.function.arguments || '{}') } catch (e) {}
                const out = await ownTool(tc.function.name, a)
                messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 7000) })
            }
            if (OWN.finished) {
                const files = Object.keys(OWN.staged)
                return { answer: 'Ready to push: ' + OWN.summary + '\nFiles: ' + files.join(', ') + '\n' + OWN.checkReport + '\nReply yes to push (one commit, one redeploy) or no to discard.' }
            }
            continue
        }
        return { answer: (__plainText(msg.content || '').trim() || 'No response.').slice(0, 3000) }
    }
    return { answer: 'That took too many steps. Try a smaller request.' }
}
async function aiRoute(ctx) {
    const { req, J, body } = ctx
    global.__aiAtt = global.__aiAtt || {}
    const aip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    const hits = global.__aiAtt[aip] = (global.__aiAtt[aip] || []).filter(x => Date.now() - x < 60000)
    if (hits.length >= 12) return J(429, { error: 'Too many questions at once. Wait a moment.' })
    hits.push(Date.now())
    if (!/json/i.test(String(req.headers['content-type'] || ''))) return J(415, { error: 'Bad request.' })
    if (!global.__GROQ__) return J(503, { error: 'The assistant is not set up yet (no Groq key).' })
    let p = {}; try { p = JSON.parse(await body(8000)) } catch (e) {}
    const history = (Array.isArray(p.history) ? p.history.slice(-10) : []).filter(h => h && (h.role === 'user' || h.role === 'assistant') && h.content).map(h => ({ role: h.role, content: String(h.content).slice(0, 2000) }))
    const question = String(p.question || '').slice(0, 1500).trim()
    if (!question) return J(400, { error: 'Ask something first.' })
    if (ownEnabled()) { for (let i = history.length - 1; i >= 0; i--) { if (ownPhraseOk(ownNorm(history[i].content))) history.splice(i, 1) } }
    try {
        if (ownEnabled()) {
            const ck = ownCookies(req), norm = ownNorm(question), now = Date.now()
            const own = ownVerify(ck.sr_o, 'o'), pend = ownVerify(ck.sr_op, 'p'), dev = ownVerify(ck.sr_od, 'd')
            if (pend) {
                if (OWN.lockedUntil > now) return J(200, { answer: 'Locked. Try again in ' + Math.ceil((OWN.lockedUntil - now) / 60000) + ' minute(s).', owner: 'off' }, { 'Set-Cookie': ownCookie(req, 'sr_op', '', 0) })
                if (ownPassOk(question)) {
                    OWN.fails = 0
                    return J(200, { answer: 'Owner mode is on. It locks after one hour idle, or say "exit owner mode". What do you want to change?', owner: 'on' }, { 'Set-Cookie': [ownCookie(req, 'sr_op', '', 0), ownCookie(req, 'sr_o', ownSign({ t: 'o', exp: now + OWN_IDLE }), OWN_IDLE / 1000), ownCookie(req, 'sr_od', ownSign({ t: 'd', exp: now + OWN_DEVICE }), OWN_DEVICE / 1000)] })
                }
                OWN.fails++
                if (OWN.fails >= 5) { OWN.fails = 0; OWN.lockedUntil = now + 15 * 60000; return J(200, { answer: 'Too many wrong passwords. Locked for 15 minutes.', owner: 'off' }, { 'Set-Cookie': ownCookie(req, 'sr_op', '', 0) }) }
                return J(200, { answer: 'Wrong password.', owner: 'off' }, { 'Set-Cookie': ownCookie(req, 'sr_op', '', 0) })
            }
            if (ownPhraseOk(norm)) {
                if (OWN.lockedUntil > now) return J(200, { answer: 'Locked. Try again in ' + Math.ceil((OWN.lockedUntil - now) / 60000) + ' minute(s).' })
                return J(200, { answer: 'Enter the password.', owner: 'pending' }, { 'Set-Cookie': ownCookie(req, 'sr_op', ownSign({ t: 'p', exp: now + 120000 }), 120) })
            }
            if (norm === 'owner mode' && dev && !own) {
                return J(200, { answer: 'Owner mode is on. What do you want to change?', owner: 'on' }, { 'Set-Cookie': ownCookie(req, 'sr_o', ownSign({ t: 'o', exp: now + OWN_IDLE }), OWN_IDLE / 1000) })
            }
            if (norm === 'forget this device' && (own || dev)) {
                return J(200, { answer: 'This device is forgotten. You will need the phrase and password again.', owner: 'off' }, { 'Set-Cookie': [ownCookie(req, 'sr_o', '', 0), ownCookie(req, 'sr_od', '', 0)] })
            }
            if (own) {
                if (norm === 'exit owner mode') return J(200, { answer: 'Owner mode is off. Staged edits are kept until you discard them.', owner: 'off' }, { 'Set-Cookie': ownCookie(req, 'sr_o', '', 0) })
                const r = await ownerChat(question, history)
                return J(200, { answer: r.answer, owner: 'on', chips: ownChips() }, { 'Set-Cookie': ownCookie(req, 'sr_o', ownSign({ t: 'o', exp: now + OWN_IDLE }), OWN_IDLE / 1000) })
            }
        }
        const r = await aiNormal(question, history)
        return J(200, r)
    } catch (e) { console.log('[AI ERROR]:', String(e.message || e).slice(0, 200)); return J(502, { error: 'The assistant could not respond. Try again.' }) }
}

const __isLocalReq = req => /localhost|127\.0\.0\.1/.test(String(req.headers.host || '')) && !req.headers['x-forwarded-for'] && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(String(req.socket.remoteAddress || ''))
>>>>
@@@ assistant route uses new module
<<<<
        if (url === '/api/ai' && req.method === 'POST') {
            global.__aiAtt = global.__aiAtt || {}
            const aip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
            const hits = global.__aiAtt[aip] = (global.__aiAtt[aip] || []).filter(x => Date.now() - x < 60000)
            if (hits.length >= 10) return J(429, { error: 'Too many questions at once. Wait a moment.' })
            hits.push(Date.now())
            if (!global.__GROQ__) return J(503, { error: 'The assistant is not set up yet (no Groq key).' })
            let p = {}; try { p = JSON.parse(await body(4000)) } catch (e) {}
            const history = (Array.isArray(p.history) ? p.history.slice(-10) : [])
                .filter(h => h && (h.role === 'user' || h.role === 'assistant') && h.content)
                .map(h => ({ role: h.role, content: String(h.content).slice(0, 2000) }))
            const question = String(p.question || '').slice(0, 600)
            if (!question) return J(400, { error: 'Ask something first.' })
            const cat = buildCommandCatalog()
            const cmdList = cat.sections.flatMap(s => s.commands.slice(0, 6).map(c => '.' + (c.name || c))).slice(0, 60).join(', ')
            const sys = 'You are the SUKUNA REALM assistant, built into this WhatsApp bot\'s dashboard. '
                + 'Reply in plain text only: no markdown, no asterisks, no backticks, no headings, no tables. Use short paragraphs, and write steps as lines like 1) 2) 3). Answer fully and helpfully, like a normal friendly chat assistant. The dashboard menu has ONLY these pages: Home, Connect, Sessions, Commands, Settings, Groups, Developer, Logs, Media, API Keys, Analytics, Templates, Contact owner. Never invent buttons, tabs, gear icons or settings that are not in that list. '
                + 'You know this bot has commands like: ' + cmdList + ' (and more, grouped on the Commands page). '
                + 'If someone asks what a command does, explain it in general terms and say plainly when you are not sure of the exact details. '
                + 'You can explain or write small bits of code if asked, but you are not primarily a coding tool. '
                + 'If someone wants to reach the human owner, tell them to use the "Contact owner" page in this dashboard. '
                + 'Never claim to be able to take real actions yourself (you cannot block, disconnect, or change settings) — point them to the right dashboard page instead.'
            try {
                const data = await groqPost('https://api.groq.com/openai/v1/chat/completions', { model: 'auto',
                    messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: question }]
                }, { 'Authorization': `Bearer ${global.__GROQ__}` }, 30000)
                const answer = data?.choices?.[0]?.message?.content || 'No response.'
                return J(200, { answer: __plainText(answer).slice(0, 4000) })
            } catch (e) { console.log('[REAL AI ERROR]:', e.message); return J(502, { error: 'The assistant could not respond. Try again.' }) }
        }
====
        if (url === '/api/ai' && req.method === 'POST') {
            return aiRoute({ req, J, body, user })
        }
>>>>
@@END*/
