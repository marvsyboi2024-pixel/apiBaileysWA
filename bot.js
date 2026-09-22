/*
 * WhatsApp bot (Baileys)
 *
 * NOTHING is hard-coded to a person. The "owner" of each session is the account that
 * is linked to it (messages with key.fromMe). Configure with environment variables:
 *
 *   MONGO_URI           MongoDB connection string (optional, keeps sessions across redeploys)
 *   MONGO_DB            MongoDB database name (default: whatsappbot)
 *   DASHBOARD_PASSWORD  dashboard password (if missing, a random one is generated and logged)
 *   BOT_NAME            display name of the bot (default: WhatsApp Bot)
 *   BOT_TIMEZONE        e.g. Africa/Lagos, used by .time and .date (default: server timezone)
 *   PORT                web server port (default: 3000)
 *   TELEGRAM_TOKEN      Telegram bot token from @BotFather. If unset, Telegram control is skipped entirely.
 *
 * Optional packages: `sharp` (needed for .sticker and better .toimg), `node-telegram-bot-api` (needed for Telegram control)
 *
 * Telegram control bot: @DarkMatrix_XBot. Only Telegram user id 7959585602 may use it.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const crypto = require('crypto')
const { execFile } = require('child_process')
const P = require('pino')
const { MongoClient } = require('mongodb')
const baileys = require('@whiskeysockets/baileys')
const makeWASocket = baileys.default
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, initAuthCreds, BufferJSON, proto } = baileys

let sharp = null
try { sharp = require('sharp') } catch (e) { sharp = null }

// ─────────────────────────── config ───────────────────────────
const BOT_NAME = process.env.BOT_NAME || 'WhatsApp Bot'
const MONGO_URI = process.env.MONGO_URI || ''
const MONGO_DB = process.env.MONGO_DB || 'whatsappbot'
const PORT = process.env.PORT || 3000
const TIMEZONE = process.env.BOT_TIMEZONE || undefined
const SESSION_DIR = path.join('.', 'sessions')
const LOGO_PATH = path.join('.', 'logo.png')

let DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || ''
if (!DASHBOARD_PASSWORD) {
    DASHBOARD_PASSWORD = crypto.randomBytes(9).toString('base64url')
    console.log(`[DASHBOARD] DASHBOARD_PASSWORD is not set. Temporary password for this run: ${DASHBOARD_PASSWORD}`)
}

const silentLogger = P({ level: 'silent' })
const sessions = {}
const reconnectCooldown = {}

let mongoClient = null
let authCollection = null
let legacyCollection = null
let settingsCollection = null
let logoCollection = null

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true })

process.on('unhandledRejection', (reason) => {
    console.log('Unhandled rejection:', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
    console.log('Uncaught exception:', err?.message || err)
})

// ─────────────────────────── mongo ───────────────────────────
async function initMongo() {
    if (!MONGO_URI) {
        console.log('[MONGO] No MONGO_URI provided. Sessions will be temporary.')
        return false
    }
    try {
        mongoClient = new MongoClient(MONGO_URI)
        await mongoClient.connect()
        const db = mongoClient.db(MONGO_DB)
        authCollection = db.collection('auth')
        legacyCollection = db.collection('sessions')
        settingsCollection = db.collection('settings')
        logoCollection = db.collection('logo')
        try { await authCollection.createIndex({ sid: 1 }) } catch (e) {}
        console.log('[MONGO] Connected!')
        return true
    } catch (e) {
        console.log('[MONGO] Connection failed:', e.message)
        authCollection = legacyCollection = settingsCollection = logoCollection = null
        return false
    }
}

// Full auth state (creds + signal keys) in MongoDB, so sessions survive redeploys.
async function useMongoAuthState(sessionId, legacyCredsStr) {
    const id = (name) => `${sessionId}:${name}`
    const writeData = async (name, data) => {
        try {
            return await authCollection.updateOne(
                { _id: id(name) },
                { $set: { sid: sessionId, data: JSON.stringify(data, BufferJSON.replacer) } },
                { upsert: true }
            )
        } catch (e) {
            console.log('[MONGO] writeData error:', e?.message || e)
            return null
        }
    }
    const readData = async (name) => {
        try {
            const d = await authCollection.findOne({ _id: id(name) })
            return d ? JSON.parse(d.data, BufferJSON.reviver) : null
        } catch (e) {
            console.log('[MONGO] readData error:', e?.message || e)
            return null
        }
    }
    const removeData = async (name) => {
        try {
            return await authCollection.deleteOne({ _id: id(name) })
        } catch (e) {
            console.log('[MONGO] removeData error:', e?.message || e)
            return null
        }
    }

    let creds = await readData('creds')
    if (!creds && legacyCredsStr) {
        try {
            creds = JSON.parse(legacyCredsStr, BufferJSON.reviver)
            await writeData('creds', creds)
            console.log(`[MONGO] Migrated legacy creds for ${sessionId}`)
        } catch (e) { creds = null }
    }
    if (!creds) creds = initAuthCreds()

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    await Promise.all(ids.map(async (kid) => {
                        let v = await readData(`${type}-${kid}`)
                        if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v)
                        data[kid] = v
                    }))
                    return data
                },
                set: async (data) => {
                    const tasks = []
                    for (const category in data) {
                        for (const kid in data[category]) {
                            const v = data[category][kid]
                            const name = `${category}-${kid}`
                            tasks.push(v ? writeData(name, v) : removeData(name))
                        }
                    }
                    await Promise.all(tasks)
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    }
}

async function loadLegacyCreds(sessionId) {
    if (!legacyCollection) return null
    try {
        const doc = await legacyCollection.findOne({ _id: sessionId })
        return doc?.creds || null
    } catch (e) { return null }
}

async function deleteSessionFromMongo(sessionId) {
    try {
        if (authCollection) await authCollection.deleteMany({ sid: sessionId })
        if (legacyCollection) await legacyCollection.deleteOne({ _id: sessionId })
    } catch (e) {
        console.log('[MONGO] Delete error:', e.message)
    }
}

async function saveLogoToMongo(buffer) {
    if (!logoCollection) return
    try {
        await logoCollection.updateOne(
            { _id: 'botlogo' },
            { $set: { data: buffer.toString('base64'), updatedAt: new Date() } },
            { upsert: true }
        )
    } catch (e) {
        console.log('[MONGO] Logo save error:', e.message)
    }
}

async function loadLogoFromMongo() {
    if (!logoCollection) return false
    try {
        const doc = await logoCollection.findOne({ _id: 'botlogo' })
        if (doc && doc.data) {
            fs.writeFileSync(LOGO_PATH, Buffer.from(doc.data, 'base64'))
            return true
        }
    } catch (e) {
        console.log('[MONGO] Logo load error:', e.message)
    }
    return false
}

// ─────────────────────────── content lists ───────────────────────────
const jokes = [
    'Why did the developer go broke? Because he used up all his cache!',
    'Why do programmers prefer dark mode? Because light attracts bugs!',
    'I would tell you a UDP joke, but you might not get it.',
    'Why did the Java developer wear glasses? Because he could not C#.',
    'How many programmers does it take to change a light bulb? None, that is a hardware problem.'
]
const quotes = [
    'The only way to do great work is to love what you do. - Steve Jobs',
    'Believe you can and you are halfway there. - Theodore Roosevelt',
    'It always seems impossible until it is done. - Nelson Mandela',
    'The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt',
    'Success is not final, failure is not fatal. - Winston Churchill'
]
const facts = [
    'Honey never spoils. Archaeologists have found 3000-year-old honey in Egyptian tombs that is still edible.',
    'Octopuses have three hearts and blue blood.',
    'A day on Venus is longer than a year on Venus.',
    'Bananas are berries, but strawberries are not.',
    'The Eiffel Tower can be 15 cm taller during the summer.'
]
const truths = [
    'What is the most embarrassing thing you have ever done?',
    'Have you ever lied to your best friend?',
    'What is your biggest fear?',
    'Who was your first crush?',
    'What is the most childish thing you still do?'
]
const dares = [
    'Send a selfie with a funny face to the group.',
    'Speak in a British accent for the next 10 messages.',
    'Tell a secret about yourself.',
    'Do 20 push-ups and describe how it felt.',
    'Send your most recent WhatsApp status screenshot.'
]
const roasts = [
    'You are not stupid, you just have bad luck when you think.',
    'I would agree with you, but then we would both be wrong.',
    'You are the reason shampoo has instructions.',
    'Somewhere a tree is working hard to produce oxygen for you. Thanks, tree.',
    'You are like a cloud - when you disappear, it is a beautiful day.'
]
const compliments = [
    'You are the reason someone smiles today.',
    'Your kindness is contagious.',
    'You have a great sense of humor.',
    'You are stronger than you think.',
    'You make the world a better place just by being in it.'
]

// ─────────────────────────── helpers ───────────────────────────
function getRandom(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function normalizeJid(number) {
    return number.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
}
function formatUptime(sec) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return `${h}h ${m}m`
}

// "1234:5@s.whatsapp.net" -> "1234"
function cleanNumber(jid) {
    return jid ? String(jid).split('@')[0].split(':')[0] : ''
}
// "1234:5@s.whatsapp.net" -> "1234@s.whatsapp.net"   (also works for @lid)
function cleanJid(jid) {
    if (!jid) return ''
    const [user, domain] = String(jid).split('@')
    return user.split(':')[0] + '@' + (domain || 's.whatsapp.net')
}
function getBotJid(sock) {
    return cleanJid(sock.user?.id || sock.authState?.creds?.me?.id || '')
}
function botIds(sock) {
    const ids = new Set()
    const add = (j) => { const n = cleanNumber(j); if (n) ids.add(n) }
    add(sock.user?.id)
    add(sock.user?.lid)
    add(sock.authState?.creds?.me?.id)
    add(sock.authState?.creds?.me?.lid)
    return ids
}
function isBotJid(sock, jid) {
    return !!jid && botIds(sock).has(cleanNumber(jid))
}
function ownerName(sock) {
    return sock.user?.name || cleanNumber(sock.user?.id) || 'Owner'
}

// Strip wrappers that hide the real content (disappearing chats etc.)
function unwrapEphemeral(message) {
    let m = message
    for (let i = 0; i < 5 && m; i++) {
        const inner = m.ephemeralMessage?.message || m.documentWithCaptionMessage?.message
        if (!inner) break
        m = inner
    }
    return m
}
function unwrap(message) {
    let m = message
    for (let i = 0; i < 6 && m; i++) {
        const inner = m.ephemeralMessage?.message ||
            m.documentWithCaptionMessage?.message ||
            m.viewOnceMessage?.message ||
            m.viewOnceMessageV2?.message ||
            m.viewOnceMessageV2Extension?.message
        if (!inner) break
        m = inner
    }
    return m || {}
}
function getContextInfo(m) {
    if (!m) return null
    for (const k of Object.keys(m)) {
        const v = m[k]
        if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo
    }
    return null
}
function extractViewOnceMedia(message) {
    if (!message) return null
    const wrapper = message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension
    const inner = wrapper?.message
    if (inner?.imageMessage) return { type: 'image', message: inner }
    if (inner?.videoMessage) return { type: 'video', message: inner }
    if (message.imageMessage?.viewOnce) return { type: 'image', message: { imageMessage: message.imageMessage } }
    if (message.videoMessage?.viewOnce) return { type: 'video', message: { videoMessage: message.videoMessage } }
    return null
}
function getMediaInfo(m) {
    if (!m) return null
    if (m.imageMessage) return { type: 'image', node: m.imageMessage }
    if (m.videoMessage) return { type: 'video', node: m.videoMessage }
    if (m.audioMessage) return { type: 'audio', node: m.audioMessage }
    if (m.stickerMessage) return { type: 'sticker', node: m.stickerMessage }
    if (m.documentMessage) return { type: 'document', node: m.documentMessage }
    return null
}
// Key of the message that was quoted (needed for media re-upload requests)
function getQuotedKey(sock, from, ci) {
    const participant = ci.participant || undefined
    return {
        remoteJid: from,
        id: ci.stanzaId,
        participant,
        fromMe: participant ? isBotJid(sock, participant) : false
    }
}
async function downloadBuffer(sock, key, message) {
    return downloadMediaMessage(
        { key, message },
        'buffer',
        {},
        { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
    )
}
async function sendSaved(sock, to, info, buffer, label) {
    const caption = info.node.caption || label
    if (info.type === 'image') return sock.sendMessage(to, { image: buffer, caption })
    if (info.type === 'video') return sock.sendMessage(to, { video: buffer, caption, gifPlayback: !!info.node.gifPlayback })
    if (info.type === 'audio') return sock.sendMessage(to, { audio: buffer, mimetype: info.node.mimetype || 'audio/mp4', ptt: !!info.node.ptt })
    if (info.type === 'sticker') return sock.sendMessage(to, { sticker: buffer })
    return sock.sendMessage(to, { document: buffer, mimetype: info.node.mimetype || 'application/octet-stream', fileName: info.node.fileName || 'file', caption })
}
function getTarget(content) {
    const ci = getContextInfo(content)
    return ci?.mentionedJid?.[0] || ci?.participant || null
}

// Safe calculator (no eval)
function safeCalc(input) {
    const src = String(input).replace(/\s+/g, '').replace(/\*\*/g, '^')
    if (!src || src.length > 100) throw new Error('bad')
    const tokens = src.match(/\d+\.?\d*|\.\d+|[-+*/%^()]/g)
    if (!tokens || tokens.join('') !== src) throw new Error('bad')
    let i = 0
    const peek = () => tokens[i]
    const next = () => tokens[i++]
    function parseExpr() {
        let v = parseTerm()
        while (peek() === '+' || peek() === '-') {
            const op = next(); const r = parseTerm()
            v = op === '+' ? v + r : v - r
        }
        return v
    }
    function parseTerm() {
        let v = parsePow()
        while (peek() === '*' || peek() === '/' || peek() === '%') {
            const op = next(); const r = parsePow()
            v = op === '*' ? v * r : op === '/' ? v / r : v % r
        }
        return v
    }
    function parsePow() {
        const base = parseUnary()
        if (peek() === '^') { next(); return Math.pow(base, parsePow()) }
        return base
    }
    function parseUnary() {
        if (peek() === '-') { next(); return -parseUnary() }
        if (peek() === '+') { next(); return parseUnary() }
        return parsePrimary()
    }
    function parsePrimary() {
        const t = next()
        if (t === '(') {
            const v = parseExpr()
            if (next() !== ')') throw new Error('bad')
            return v
        }
        if (t === undefined || isNaN(Number(t))) throw new Error('bad')
        return Number(t)
    }
    const result = parseExpr()
    if (i !== tokens.length || !isFinite(result)) throw new Error('bad')
    return result
}

// ─────────────────────────── per-session state ───────────────────────────
function createCtx(sessionId, sessionPath) {
    return {
        sessionId,
        sessionPath,
        cfg: {
            mode: 'public',
            prefix: '.',
            typing: false,
            delay: false,
            read: false,
            online: false,
            autoreact: false,
            statusview: false
        },
        groupSettings: {},
        warnLimit: {},
        welcomeSettings: {},
        warningCounts: {},
        activePolls: {},
        spam: {},
        metaCache: {},
        statusCache: new Map(),
        ttUsage: [],
        saveTimer: null
    }
}

async function loadCtxState(ctx) {
    let saved = null
    if (settingsCollection) {
        try {
            const d = await settingsCollection.findOne({ _id: ctx.sessionId })
            saved = d?.data || null
        } catch (e) {}
    }
    if (!saved) {
        try {
            const f = path.join(ctx.sessionPath, 'settings.json')
            if (fs.existsSync(f)) saved = JSON.parse(fs.readFileSync(f, 'utf-8'))
        } catch (e) {}
    }
    if (!saved) return
    for (const k of Object.keys(ctx.cfg)) {
        if (saved.cfg && saved.cfg[k] !== undefined) ctx.cfg[k] = saved.cfg[k]
    }
    ctx.groupSettings = saved.groupSettings || {}
    ctx.warnLimit = saved.warnLimit || {}
    ctx.welcomeSettings = saved.welcomeSettings || {}
}

function saveCtx(ctx) {
    clearTimeout(ctx.saveTimer)
    ctx.saveTimer = setTimeout(async () => {
        const data = {
            cfg: ctx.cfg,
            groupSettings: ctx.groupSettings,
            warnLimit: ctx.warnLimit,
            welcomeSettings: ctx.welcomeSettings
        }
        try {
            fs.mkdirSync(ctx.sessionPath, { recursive: true })
            fs.writeFileSync(path.join(ctx.sessionPath, 'settings.json'), JSON.stringify(data))
        } catch (e) {}
        if (settingsCollection) {
            try {
                await settingsCollection.updateOne(
                    { _id: ctx.sessionId },
                    { $set: { data, updatedAt: new Date() } },
                    { upsert: true }
                )
            } catch (e) { console.log('[MONGO] Settings save error:', e.message) }
        }
    }, 1500)
}

// ─────────────────────────── group helpers ───────────────────────────
async function getGroupMeta(ctx, sock, jid, force = false) {
    const c = ctx.metaCache[jid]
    if (!force && c && Date.now() - c.t < 30000) return c.meta
    const meta = await sock.groupMetadata(jid)
    ctx.metaCache[jid] = { t: Date.now(), meta }
    return meta
}

// userIds: array of JIDs or bare numbers. Matches id / lid / phoneNumber, ignores :device suffixes.
async function checkAdmin(ctx, sock, groupJid, userIds) {
    try {
        const meta = await getGroupMeta(ctx, sock, groupJid)
        const nums = new Set(userIds.filter(Boolean).map(cleanNumber))
        return meta.participants.some(p =>
            !!p.admin && [p.id, p.jid, p.lid, p.phoneNumber].some(x => x && nums.has(cleanNumber(x)))
        )
    } catch (e) { return false }
}

async function participantsUpdate(sock, groupJid, jids, action) {
    const res = await sock.groupParticipantsUpdate(groupJid, jids, action)
    const ok = Array.isArray(res) ? res.every(r => String(r.status) === '200') : true
    return { ok, res }
}

async function guardTarget(ctx, sock, from, target) {
    if (isBotJid(sock, target)) return '[X] I will not do that to myself.'
    if (await checkAdmin(ctx, sock, from, [target])) return '[X] That user is a group admin.'
    return null
}

// ─────────────────────────── protection enforcement ───────────────────────────
function detectViolation(ctx, settings, msg, content, ci, text, from, sender) {
    if (settings.antilink && /https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com/i.test(text)) return 'links'

    if (settings.antimedia && (
        content.imageMessage || content.videoMessage || content.stickerMessage ||
        content.audioMessage || content.documentMessage || extractViewOnceMedia(msg.message)
    )) return 'media'

    if (settings.antitag && ci?.mentionedJid?.length > 0) return 'tags'

    if (settings.antiforward && ci?.isForwarded) return 'forwarded messages'

    if (settings.antibot && typeof msg.key.id === 'string' && msg.key.id.startsWith('BAE5')) return 'bots'

    if (settings.antispam) {
        const now = Date.now()
        if (!ctx.spam[from]) ctx.spam[from] = {}
        const list = (ctx.spam[from][sender] || []).filter(t => now - t < 8000)
        list.push(now)
        ctx.spam[from][sender] = list
        if (list.length >= 6) {
            ctx.spam[from][sender] = []
            return 'spam'
        }
    }
    return null
}

// Returns true when the message was handled as a violation.
async function enforceProtection(sock, ctx, msg, content, from, sender, senderNumber, text) {
    const settings = ctx.groupSettings[from]
    if (!settings || !Object.values(settings).some(Boolean)) return false

    const ci = getContextInfo(content)
    const reason = detectViolation(ctx, settings, msg, content, ci, text, from, sender)
    if (!reason) return false

    // Group admins are exempt.
    if (await checkAdmin(ctx, sock, from, [sender])) return false

    if (!ctx.warningCounts[from]) ctx.warningCounts[from] = {}
    const key = cleanJid(sender)
    ctx.warningCounts[from][key] = (ctx.warningCounts[from][key] || 0) + 1
    const limit = ctx.warnLimit[from] || 3
    const count = ctx.warningCounts[from][key]

    // Delete only if the bot is admin. If it is not, quietly skip (no complaints).
    const botAdmin = await checkAdmin(ctx, sock, from, [...botIds(sock)])
    if (botAdmin) {
        try { await sock.sendMessage(from, { delete: msg.key }) } catch (e) {}
    }

    try {
        await sock.sendMessage(from, {
            text: `[WARN] @${senderNumber} (${Math.min(count, limit)}/${limit}) - ${reason} are not allowed.`,
            mentions: [sender]
        })
    } catch (e) {}

    if (count >= limit && botAdmin) {
        try {
            await sock.groupParticipantsUpdate(from, [sender], 'remove')
            delete ctx.warningCounts[from][key]
            await sock.sendMessage(from, { text: `[KICKED] @${senderNumber} reached the warning limit.`, mentions: [sender] })
        } catch (e) {}
    }
    return true
}

// ─────────────────────────── statuses ───────────────────────────
function cacheStatus(ctx, msg) {
    const m = unwrap(msg.message)
    if (!(m.imageMessage || m.videoMessage || m.conversation || m.extendedTextMessage)) return
    const id = msg.key.id
    if (!id) return
    ctx.statusCache.set(id, { t: Date.now(), msg })
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const [k, v] of ctx.statusCache) {
        if (v.t < cutoff || ctx.statusCache.size > 200) ctx.statusCache.delete(k)
        else break
    }
}

async function handleStatus(sock, ctx, msg) {
    if (msg.key.fromMe) return
    const poster = msg.key.participant
    cacheStatus(ctx, msg)
    if (!ctx.cfg.statusview || !poster) return
    try { await sock.readMessages([msg.key]) } catch (e) {}
    if (ctx.cfg.autoreact) {
        try {
            await sock.sendMessage(
                'status@broadcast',
                { react: { text: '❤️', key: msg.key } },
                { statusJidList: [cleanJid(poster), getBotJid(sock)] }
            )
        } catch (e) {}
    }
}

async function saveStatus(sock, ctx, ci, sender) {
    const candidates = []
    const cached = ctx.statusCache.get(ci.stanzaId)
    if (cached) candidates.push({ key: cached.msg.key, message: unwrap(cached.msg.message) })
    if (ci.quotedMessage) {
        candidates.push({
            key: { remoteJid: 'status@broadcast', id: ci.stanzaId, participant: ci.participant, fromMe: false },
            message: unwrapEphemeral(ci.quotedMessage)
        })
    }
    for (const c of candidates) {
        const info = getMediaInfo(c.message)
        if (info) {
            try {
                const buffer = await downloadBuffer(sock, c.key, c.message)
                await sendSaved(sock, sender, info, buffer, 'Saved status')
                return true
            } catch (e) {
                console.log('Status download failed:', e?.message || e)
            }
            continue
        }
        const t = c.message.conversation || c.message.extendedTextMessage?.text
        if (t) {
            await sock.sendMessage(sender, { text: 'Saved status text:\n\n' + t })
            return true
        }
    }
    return false
}

// ─────────────────────────── save / hmm / vv ───────────────────────────
async function handleSave(sock, ctx, msg, content, from, sender) {
    const prefix = ctx.cfg.prefix
    const ci = getContextInfo(content)
    const toDM = (payload) => sock.sendMessage(sender, payload).catch(() => {})
    const cleanup = async () => {
        if (msg.key.fromMe) {
            try { await sock.sendMessage(from, { delete: msg.key }) } catch (e) {}
        }
    }

    if (!ci || (!ci.quotedMessage && !ci.stanzaId)) {
        await toDM({ text: `[X] Reply to a status, or to a photo/video in a chat, with ${prefix}save` })
        return
    }

    // Status (Updates tab) reply
    if (ci.remoteJid === 'status@broadcast') {
        let saved = false
        try { saved = await saveStatus(sock, ctx, ci, sender) } catch (e) { console.log('Save status error:', e?.message || e) }
        if (!saved) await toDM({ text: '[X] Could not save status. It may be expired, hidden, or restricted by WhatsApp.' })
        await cleanup()
        return
    }

    // Normal chat message
    if (!ci.quotedMessage) {
        await toDM({ text: '[X] Could not read the message you replied to.' })
        return
    }
    const quoted = unwrapEphemeral(ci.quotedMessage)
    const vo = extractViewOnceMedia(quoted)
    const message = vo ? vo.message : quoted
    const info = getMediaInfo(message)
    if (!info) {
        const t = quoted.conversation || quoted.extendedTextMessage?.text
        if (t) await toDM({ text: 'Saved text:\n\n' + t })
        else await toDM({ text: '[X] That message has no media to save.' })
        await cleanup()
        return
    }
    try {
        const buffer = await downloadBuffer(sock, getQuotedKey(sock, from, ci), message)
        await sendSaved(sock, sender, info, buffer, 'Saved')
    } catch (e) {
        console.log('.save error:', e?.message || e)
        await toDM({ text: '[X] Failed to save that media. It may have expired.' })
    }
    await cleanup()
}

async function handleViewOnceCmd(sock, ctx, msg, content, from, sender, kind) {
    const prefix = ctx.cfg.prefix
    const silent = kind === 'hmm'
    const say = (text) => (silent
        ? sock.sendMessage(sender, { text })
        : sock.sendMessage(from, { text }, { quoted: msg })).catch(() => {})

    const ci = getContextInfo(content)
    const quoted = ci?.quotedMessage ? unwrapEphemeral(ci.quotedMessage) : null

    let target = quoted ? extractViewOnceMedia(quoted) : null
    let key = null
    if (target) {
        key = getQuotedKey(sock, from, ci)
    } else {
        target = extractViewOnceMedia(msg.message)
        if (target) key = msg.key
    }

    if (!target) {
        if (!ci) await say(`[X] Reply to a view-once photo/video with ${prefix}${kind}`)
        else await say(`[X] This only works on *view-once* media.\n\nHow to use:\n1. Wait for a view-once photo/video\n2. Do NOT open it\n3. Reply to it with ${prefix}${kind}`)
        return
    }

    try {
        const buffer = await downloadBuffer(sock, key, target.message)
        const caption = silent ? 'Saved view-once' : 'View-once revealed'
        const payload = target.type === 'image' ? { image: buffer, caption } : { video: buffer, caption }
        if (silent) await sock.sendMessage(sender, payload)
        else await sock.sendMessage(from, payload, { quoted: msg })
    } catch (e) {
        console.log(`.${kind} error:`, e?.message || e)
        await say('[X] Failed to get that view-once. WhatsApp may have already deleted it.')
    }
    if (silent && msg.key.fromMe) {
        try { await sock.sendMessage(from, { delete: msg.key }) } catch (e) {}
    }
}

// ─────────────────────────── message processing ───────────────────────────
async function processMessage(sock, ctx, msg, type) {
    if (!msg.message || !msg.key) return
    const from = msg.key.remoteJid
    if (!from) return

    if (from === 'status@broadcast') {
        await handleStatus(sock, ctx, msg)
        return
    }
    if (type !== 'notify') return
    if (from.endsWith('@newsletter') || from.endsWith('@broadcast')) return

    const isGroup = from.endsWith('@g.us')
    const fromMe = !!msg.key.fromMe
    // Real sender: your own account for your own messages, otherwise the chat/participant.
    const sender = fromMe ? getBotJid(sock) : (isGroup ? (msg.key.participant || msg.participant) : from)
    if (!sender) return
    const senderNumber = cleanNumber(sender)
    const owner = fromMe

    const content = unwrap(msg.message)
    const body = content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption || ''
    const text = body.trim()
    const lowerText = text.toLowerCase()
    const prefix = ctx.cfg.prefix
    const isCmd = text.startsWith(prefix)

    // Commands that work for everyone, in any mode
    if (isCmd) {
        if (lowerText === prefix + 'hmm') { await handleViewOnceCmd(sock, ctx, msg, content, from, sender, 'hmm'); return }
        if (lowerText === prefix + 'vv') { await handleViewOnceCmd(sock, ctx, msg, content, from, sender, 'vv'); return }
        if (lowerText === prefix + 'save') { await handleSave(sock, ctx, msg, content, from, sender); return }
    }

    // Protection runs first, in every mode, and never on the linked account's own messages
    if (isGroup && !fromMe) {
        const handled = await enforceProtection(sock, ctx, msg, content, from, sender, senderNumber, text)
        if (handled) return
    }

    // Private mode: only the linked account can use the bot
    if (ctx.cfg.mode === 'private' && !fromMe) return

    if (ctx.cfg.read && !fromMe) {
        try { await sock.readMessages([msg.key]) } catch (e) {}
    }
    if (ctx.cfg.online) {
        try { await sock.sendPresenceUpdate('available', from) } catch (e) {}
    }

    if (!isCmd) return
    const args = text.slice(prefix.length).trim().split(/\s+/)
    const cmd = (args.shift() || '').toLowerCase()
    if (!cmd || !/^[a-z0-9]+$/.test(cmd)) return

    if (ctx.cfg.delay) await sleep(3000 + Math.random() * 3000)
    if (ctx.cfg.typing) {
        try { await sock.sendPresenceUpdate('composing', from) } catch (e) {}
    }
    try {
        await handleCommand(sock, ctx, msg, content, from, isGroup, sender, senderNumber, owner, cmd, args)
    } catch (e) {
        console.log(`Command .${cmd} error:`, e?.message || e)
        try { await sock.sendMessage(from, { text: '[X] Something went wrong running that command.' }, { quoted: msg }) } catch (e2) {}
    } finally {
        if (ctx.cfg.typing) {
            try { await sock.sendPresenceUpdate('paused', from) } catch (e) {}
        }
    }
}

// ─────────────────────────── session ───────────────────────────
function stopSocket(sessionId) {
    const s = sessions[sessionId]
    if (!s) return
    s.gen = (s.gen || 0) + 1 // invalidates every handler of the old socket
    try { s.sock?.end(undefined) } catch (e) {}
}

async function startSession(sessionId, phoneNumber, forceNewPairing = false) {
    const sessionPath = path.join(SESSION_DIR, sessionId)

    if (forceNewPairing) {
        try { fs.rmSync(sessionPath, { recursive: true, force: true }) } catch (e) {}
        await deleteSessionFromMongo(sessionId)
    }
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })

    let authObj
    if (authCollection) {
        const legacy = await loadLegacyCreds(sessionId)
        authObj = await useMongoAuthState(sessionId, legacy)
    } else {
        authObj = await useMultiFileAuthState(sessionPath)
    }
    const { state, saveCreds } = authObj

    const s = sessions[sessionId] = sessions[sessionId] || {}
    s.gen = (s.gen || 0) + 1
    const gen = s.gen
    if (!s.ctx) {
        s.ctx = createCtx(sessionId, sessionPath)
        await loadCtxState(s.ctx)
    }
    const ctx = s.ctx

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: silentLogger,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    })

    s.sock = sock
    s.number = phoneNumber
    s.connectedAt = s.connectedAt || new Date().toISOString()
    s.status = 'connecting'
    s.pairingCode = null
    s.sessionPath = sessionPath

    const isCurrent = () => sessions[sessionId]?.gen === gen

    sock.ev.on('creds.update', async () => {
        try { await saveCreds() } catch (e) { console.log('[AUTH] Creds save error:', e?.message || e) }
    })

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (!isCurrent()) return
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) {
                console.log(`[${sessionId}] Reconnecting...`)
                sessions[sessionId].status = 'reconnecting'
                setTimeout(() => {
                    if (!isCurrent()) return
                    startSession(sessionId, phoneNumber).catch(e => console.log(`[${sessionId}] Restart failed:`, e?.message || e))
                }, 5000)
            } else {
                console.log(`[${sessionId}] Logged out.`)
                sessions[sessionId].status = 'logged out'
                try { fs.rmSync(sessionPath, { recursive: true, force: true }) } catch (e) {}
                await deleteSessionFromMongo(sessionId)
            }
        } else if (connection === 'open') {
            if (sock.authState.creds.registered) {
                console.log(`[${sessionId}] Connected!`)
                sessions[sessionId].status = 'active'
                sessions[sessionId].pairingCode = null
            } else {
                console.log(`[${sessionId}] Socket open, waiting for pairing...`)
            }
        }
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (!isCurrent()) return
        for (const msg of messages) {
            processMessage(sock, ctx, msg, type).catch(err => console.log('Message handler error:', err?.message || err))
        }
    })

    sock.ev.on('group-participants.update', async (update) => {
        if (!isCurrent()) return
        try {
            const { id, participants, action } = update
            delete ctx.metaCache[id]
            const ws = ctx.welcomeSettings[id]
            if (!ws) return
            for (const p of participants) {
                const jid = typeof p === 'string' ? p : p.id
                if (!jid || isBotJid(sock, jid)) continue
                const num = cleanNumber(jid)
                if (action === 'add' && ws.welcome) {
                    const t = (ws.welcomeMsg || 'Welcome @user 👋').replace(/@user|{user}/gi, '@' + num)
                    await sock.sendMessage(id, { text: t, mentions: [jid] })
                } else if ((action === 'remove' || action === 'leave') && ws.goodbye) {
                    const t = (ws.goodbyeMsg || 'Goodbye @user 👋').replace(/@user|{user}/gi, '@' + num)
                    await sock.sendMessage(id, { text: t, mentions: [jid] })
                }
            }
        } catch (e) { console.log('Group update error:', e?.message || e) }
    })

    if (!sock.authState.creds.registered) {
        await sleep(3000)
        try {
            const code = await sock.requestPairingCode(phoneNumber)
            if (isCurrent()) sessions[sessionId].pairingCode = code
            console.log(`[${sessionId}] PAIRING CODE: ${code}`)
        } catch (err) {
            console.log(`[${sessionId}] Pairing error:`, err.message)
        }
    }

    return sock
}

// ─────────────────────────── web dashboard ───────────────────────────
function checkAuth(header) {
    try {
        const b64 = header.split(' ')[1]
        const decoded = Buffer.from(b64, 'base64').toString()
        const pass = decoded.slice(decoded.indexOf(':') + 1)
        const a = crypto.createHash('sha256').update(pass).digest()
        const b = crypto.createHash('sha256').update(DASHBOARD_PASSWORD).digest()
        return crypto.timingSafeEqual(a, b)
    } catch (e) {
        return false
    }
}

function sniffImageType(buf) {
    if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf.length > 12 && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp'
    return null
}

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0]

    if (url === '/' || url === '/dashboard' || url === '/logo.png' || url === '/upload-logo' || url === '/api/sessions') {
        const auth = req.headers.authorization
        if (!auth || !checkAuth(auth)) {
            res.writeHead(401, { 'WWW-Authenticate': `Basic realm="${BOT_NAME.replace(/"/g, '')}"` })
            res.end('Authentication required')
            return
        }

        if (url === '/api/sessions') {
            const data = Object.values(sessions).map(s => ({
                number: s.number,
                status: s.status,
                connectedAt: s.connectedAt,
                pairingCode: s.status === 'active' ? null : s.pairingCode,
                mode: s.ctx?.cfg.mode,
                prefix: s.ctx?.cfg.prefix
            }))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ sessions: data, uptime: formatUptime(process.uptime()), count: data.length }))
            return
        }

        if (url === '/upload-logo' && req.method === 'POST') {
            const chunks = []
            let size = 0
            let aborted = false
            req.on('data', c => {
                size += c.length
                if (size > 5 * 1024 * 1024) {
                    aborted = true
                    res.writeHead(413)
                    res.end('Too large')
                    req.destroy()
                    return
                }
                chunks.push(c)
            })
            req.on('end', async () => {
                if (aborted) return
                try {
                    const buffer = Buffer.concat(chunks)
                    const ct = req.headers['content-type'] || ''
                    const boundary = ct.split('boundary=')[1]
                    if (boundary) {
                        const parts = buffer.toString('binary').split('--' + boundary)
                        for (const part of parts) {
                            if (part.includes('filename=') && /Content-Type: image/i.test(part)) {
                                const headerEnd = part.indexOf('\r\n\r\n')
                                let imgData = part.slice(headerEnd + 4)
                                imgData = imgData.replace(/\r\n$/, '')
                                const imgBuffer = Buffer.from(imgData, 'binary')
                                if (sniffImageType(imgBuffer)) {
                                    fs.writeFileSync(LOGO_PATH, imgBuffer)
                                    await saveLogoToMongo(imgBuffer)
                                }
                                break
                            }
                        }
                    }
                } catch (e) { console.log('Logo upload error:', e?.message || e) }
                res.writeHead(302, { Location: '/dashboard' })
                res.end()
            })
            return
        }

        if (url === '/logo.png') {
            if (fs.existsSync(LOGO_PATH)) {
                const buf = fs.readFileSync(LOGO_PATH)
                res.writeHead(200, { 'Content-Type': sniffImageType(buf) || 'image/png' })
                res.end(buf)
            } else {
                res.writeHead(404)
                res.end('No logo')
            }
            return
        }

        if (req.method === 'POST' && (url === '/dashboard' || url === '/')) {
            let body = ''
            req.on('data', chunk => body += chunk)
            req.on('end', async () => {
                try {
                    const params = new URLSearchParams(body)
                    const action = params.get('action')
                    const number = params.get('number')
                    const cleanNum = number ? number.replace(/[^0-9]/g, '') : ''
                    const sessionId = 'sess_' + cleanNum

                    if (action === 'connect' && cleanNum) {
                        const existing = sessions[sessionId]
                        if (!existing) await startSession(sessionId, cleanNum)
                        else if (existing.status === 'logged out') { stopSocket(sessionId); await startSession(sessionId, cleanNum, true) }
                    } else if (action === 'disconnect' && cleanNum) {
                        const existing = sessions[sessionId]
                        if (existing) {
                            try { await existing.sock.logout() } catch (e) {}
                            stopSocket(sessionId)
                            delete sessions[sessionId]
                        }
                        try { fs.rmSync(path.join(SESSION_DIR, sessionId), { recursive: true, force: true }) } catch (e) {}
                        await deleteSessionFromMongo(sessionId)
                    } else if (action === 'reconnect' && cleanNum) {
                        const now = Date.now()
                        if (!(reconnectCooldown[sessionId] && now - reconnectCooldown[sessionId] < 30000)) {
                            reconnectCooldown[sessionId] = now
                            const existing = sessions[sessionId]
                            const wasLoggedOut = existing?.status === 'logged out'
                            if (existing) stopSocket(sessionId)
                            const hasCreds = authCollection
                                ? !!(await authCollection.findOne({ _id: `${sessionId}:creds` }).catch(() => null)) && !wasLoggedOut
                                : fs.existsSync(path.join(SESSION_DIR, sessionId, 'creds.json'))
                            await startSession(sessionId, cleanNum, !hasCreds)
                        }
                    }
                } catch (e) { console.log('Dashboard action error:', e?.message || e) }
                res.writeHead(302, { Location: '/dashboard' })
                res.end()
            })
            return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(renderDashboard())
        return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
})

server.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`)
})

// ─────────────────────────── tiktok downloader (.tt) ───────────────────────────
let YTDLP_AVAILABLE = false
function checkYtDlp() {
    execFile('yt-dlp', ['--version'], { timeout: 10000 }, (err) => {
        YTDLP_AVAILABLE = !err
        if (err) console.log('[TT] yt-dlp not found. Install with: pip install yt-dlp')
    })
}

function isTikTokUrl(str) {
    try {
        const u = new URL(str)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
        const host = u.hostname.toLowerCase()
        return host === 'tiktok.com' || host.endsWith('.tiktok.com')
    } catch (e) {
        return false
    }
}

// Runs yt-dlp as a subprocess with an argument array (never a shell string), so the
// URL can never be interpreted as shell syntax regardless of its content.
function runYtDlp(url, outPath) {
    return new Promise((resolve, reject) => {
        execFile(
            'yt-dlp',
            ['-o', outPath, '--no-playlist', '--max-filesize', '30M', '--', url],
            { timeout: 60000, maxBuffer: 20 * 1024 * 1024 },
            (err) => { if (err) reject(err); else resolve() }
        )
    })
}

// ─────────────────────────── commands ───────────────────────────
async function handleCommand(sock, ctx, msg, content, from, isGroup, sender, senderNumber, owner, cmd, args) {
    const prefix = ctx.cfg.prefix
    const reply = (text, mentions) => sock.sendMessage(from, mentions ? { text, mentions } : { text }, { quoted: msg })

    let adminCache = null
    const canManage = async () => {
        if (owner) return true
        if (!isGroup) return false
        if (adminCache === null) adminCache = await checkAdmin(ctx, sock, from, [sender])
        return adminCache
    }
    const needGroup = async () => {
        if (isGroup) return true
        await reply('[X] Group only.')
        return false
    }
    const needManage = async () => {
        if (!(await needGroup())) return false
        if (await canManage()) return true
        await reply('[X] Admin only.')
        return false
    }
    const needOwner = async () => {
        if (owner) return true
        await reply('[X] Owner only.')
        return false
    }
    const now = new Date()

    if (cmd === 'ping') return reply('pong 🏓')
    if (cmd === 'hello') return reply(`Hey there! 👋 I am *${BOT_NAME}*`)
    if (cmd === 'time') return reply(`🕐 *Time:* ${now.toLocaleTimeString('en-US', { timeZone: TIMEZONE })}`)
    if (cmd === 'date') return reply(`📅 *Date:* ${now.toLocaleDateString('en-US', { timeZone: TIMEZONE })}`)

    if (cmd === 'info') {
        return reply(
            `╭━━━〔 *${BOT_NAME}* 〕━━━┈⊷\n` +
            `┃ 👑 *Owner:* ${ownerName(sock)}\n` +
            `┃ ⚙️ *Mode:* ${ctx.cfg.mode}\n` +
            `┃ 🔧 *Prefix:* ${prefix}\n` +
            `┃ 📡 *Sessions:* ${Object.keys(sessions).length}\n` +
            `┃ ⏳ *Uptime:* ${formatUptime(process.uptime())}\n` +
            `╰━━━━━━━━━━━━━━━━━┈⊷`
        )
    }

    if (cmd === 'menu' || cmd === 'help') {
        const menuText = renderMenu(ctx, sock)
        if (fs.existsSync(LOGO_PATH)) {
            try {
                const buffer = fs.readFileSync(LOGO_PATH)
                await sock.sendMessage(from, { image: buffer, caption: menuText }, { quoted: msg })
                return
            } catch (e) { console.log('Menu image failed, sending text:', e?.message || e) }
        }
        return reply(menuText)
    }

    if (cmd === 'mars') {
        return reply(
            `╭━━━〔 🔒 HIDDEN COMMANDS 〕━━━┈⊷\n\n` +
            `👁️ *View-Once:*\n` +
            `┃ ${prefix}vv\n` +
            `┃ Reply to an UNOPENED view-once → reveals it in this chat\n\n` +
            `┃ ${prefix}hmm\n` +
            `┃ Reply to an UNOPENED view-once → saves silently to your own DM\n\n` +
            `💾 *Save:*\n` +
            `┃ ${prefix}save\n` +
            `┃ Reply to a Status or to a photo/video in a chat → saves to your own DM\n` +
            `┃ (Statuses can only be saved if the bot received them while online)\n\n` +
            `╰━━━━━━━━━━━━━━━━━┈⊷`
        )
    }

    // ── owner-only settings ──
    if (cmd === 'mode') {
        if (!(await needOwner())) return
        if (args[0] === 'public' || args[0] === 'private') {
            ctx.cfg.mode = args[0]
            saveCtx(ctx)
            return reply(`[OK] Mode set to *${ctx.cfg.mode}*`)
        }
        return reply(`Current mode: *${ctx.cfg.mode}*\nUsage: ${prefix}mode public/private`)
    }

    if (cmd === 'prefix') {
        if (!(await needOwner())) return
        if (args[0]) {
            if (args[0].length > 3) return reply('[X] Prefix can be at most 3 characters.')
            ctx.cfg.prefix = args[0]
            saveCtx(ctx)
            return reply(`[OK] Prefix changed to *${ctx.cfg.prefix}*`)
        }
        return reply(`Current prefix: *${ctx.cfg.prefix}*`)
    }

    const toggles = ['typing', 'delay', 'read', 'online', 'autoreact', 'statusview']
    if (toggles.includes(cmd)) {
        if (!(await needOwner())) return
        if (args[0] === 'on' || args[0] === 'off') {
            ctx.cfg[cmd] = args[0] === 'on'
            saveCtx(ctx)
            return reply(`[OK] *${cmd}* is now *${args[0]}*`)
        }
        return reply(`*${cmd}:* ${ctx.cfg[cmd] ? 'on' : 'off'}\nUsage: ${prefix}${cmd} on/off`)
    }

    // ── fun ──
    if (cmd === 'joke') return reply('😄 ' + getRandom(jokes))
    if (cmd === 'quote') return reply('💬 ' + getRandom(quotes))
    if (cmd === 'fact') return reply('🧠 ' + getRandom(facts))
    if (cmd === 'truth') return reply('❓ ' + getRandom(truths))
    if (cmd === 'dare') return reply('🔥 ' + getRandom(dares))
    if (cmd === 'roast') return reply('💀 ' + getRandom(roasts))
    if (cmd === 'compliment') return reply('💖 ' + getRandom(compliments))
    if (cmd === 'dice') return reply(`🎲 You rolled a *${Math.floor(Math.random() * 6) + 1}*!`)
    if (cmd === 'coin') return reply(`🪙 *${Math.random() < 0.5 ? 'Heads' : 'Tails'}!*`)
    if (cmd === '8ball') {
        const answers = ['Yes', 'No', 'Maybe', 'Ask later', 'Absolutely', 'Doubtful', 'Good feeling', 'Very doubtful']
        return reply('🎱 ' + getRandom(answers))
    }
    if (cmd === 'rate') {
        const thing = args.join(' ')
        if (!thing) return reply('Usage: ' + prefix + 'rate <thing>')
        return reply(`⭐ I rate *${thing}* a *${Math.floor(Math.random() * 10) + 1}/10*`)
    }
    if (cmd === 'ship') {
        if (args.length < 2) return reply('Usage: ' + prefix + 'ship <name1> <name2>')
        return reply(`💕 *${args[0]}* + *${args[1]}* = *${Math.floor(Math.random() * 100) + 1}%*`)
    }

    // ── utility ──
    if (cmd === 'calc') {
        if (!args.length) return reply('Usage: ' + prefix + 'calc 2+2*3')
        try {
            return reply(`🧮 *Result:* ${safeCalc(args.join(' '))}`)
        } catch (e) { return reply('[X] Invalid math') }
    }

    if (cmd === 'sticker') {
        const ci = getContextInfo(content)
        const quoted = ci?.quotedMessage ? unwrapEphemeral(ci.quotedMessage) : null
        if (!quoted || !quoted.imageMessage) return reply('[X] Reply to an image.')
        if (!sharp) return reply('[X] Sticker maker needs the *sharp* package installed on the server (npm i sharp).')
        try {
            const buffer = await downloadBuffer(sock, getQuotedKey(sock, from, ci), quoted)
            const webp = await sharp(buffer)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp()
                .toBuffer()
            return sock.sendMessage(from, { sticker: webp }, { quoted: msg })
        } catch (e) { return reply('[X] Failed to create sticker.') }
    }

    if (cmd === 'toimg') {
        const ci = getContextInfo(content)
        const quoted = ci?.quotedMessage ? unwrapEphemeral(ci.quotedMessage) : null
        if (!quoted || !quoted.stickerMessage) return reply('[X] Reply to a sticker.')
        try {
            let buffer = await downloadBuffer(sock, getQuotedKey(sock, from, ci), quoted)
            if (sharp) buffer = await sharp(buffer).png().toBuffer()
            return sock.sendMessage(from, { image: buffer, caption: 'Sticker converted' }, { quoted: msg })
        } catch (e) { return reply('[X] Failed to convert sticker.') }
    }

    if (cmd === 'tt') {
        if (!YTDLP_AVAILABLE) return // disabled silently: yt-dlp is not installed on this server
        if (isGroup) return reply('[X] .tt only works in private chat.')
        if (!owner) return reply('[X] Owner only.')
        const url = args[0]
        if (!url || !isTikTokUrl(url)) return reply('[X] Please send a valid TikTok URL.')

        const now = Date.now()
        ctx.ttUsage = (ctx.ttUsage || []).filter(t => now - t < 3600000)
        if (ctx.ttUsage.length >= 2) return reply('[X] TikTok download limit reached. Try again later.')
        ctx.ttUsage.push(now)

        await reply('[OK] Downloading TikTok...')
        const outPath = path.join(os.tmpdir(), `tt_${crypto.randomBytes(6).toString('hex')}.mp4`)
        try {
            await runYtDlp(url, outPath)
            if (!fs.existsSync(outPath)) throw new Error('yt-dlp produced no output file')
            if (fs.statSync(outPath).size > 30 * 1024 * 1024) {
                return reply('[X] Video is larger than 30MB, cannot send.')
            }
            await sleep(10000)
            const buffer = fs.readFileSync(outPath)
            await sock.sendMessage(from, { video: buffer, caption: 'TikTok download' }, { quoted: msg })
        } catch (e) {
            console.log('.tt error:', e?.message || e)
            return reply('[X] Download failed. The video may be private, deleted, or yt-dlp is not installed.')
        } finally {
            try { fs.unlinkSync(outPath) } catch (e) {}
        }
        return
    }

    // ── warnings ──
    if (cmd === 'warn') {
        if (!(await needManage())) return
        const target = getTarget(content)
        if (!target) return reply('[X] Mention or reply to a user.')
        const guard = await guardTarget(ctx, sock, from, target)
        if (guard) return reply(guard)
        if (!ctx.warningCounts[from]) ctx.warningCounts[from] = {}
        const key = cleanJid(target)
        ctx.warningCounts[from][key] = (ctx.warningCounts[from][key] || 0) + 1
        const limit = ctx.warnLimit[from] || 3
        const count = ctx.warningCounts[from][key]
        if (count >= limit) {
            try {
                const r = await participantsUpdate(sock, from, [target], 'remove')
                if (!r.ok) return reply(`[WARN] @${cleanNumber(target)} (${limit}/${limit}) but I could not remove them. Make sure I am a group admin.`, [target])
                delete ctx.warningCounts[from][key]
                return reply(`[KICKED] @${cleanNumber(target)} (${limit}/${limit} warnings).`, [target])
            } catch (e) { return reply('[X] Failed to kick user. Make sure I am a group admin.') }
        }
        return reply(`[WARN] @${cleanNumber(target)} (${count}/${limit}).`, [target])
    }

    if (cmd === 'warncount') {
        if (!(await needManage())) return
        const num = parseInt(args[0])
        if (!num || num < 1) return reply('Usage: ' + prefix + 'warncount <number>')
        ctx.warnLimit[from] = num
        saveCtx(ctx)
        return reply(`[OK] Warning limit set to *${num}*`)
    }

    if (cmd === 'warnlist') {
        if (!(await needManage())) return
        const list = ctx.warningCounts[from] || {}
        const keys = Object.keys(list)
        if (keys.length === 0) return reply('[OK] No warned users.')
        let out = '[WARN] *Warned Users:*\n\n'
        for (const [jid, count] of Object.entries(list)) out += `@${cleanNumber(jid)}: ${count} warnings\n`
        return reply(out, keys)
    }

    if (cmd === 'resetwarn') {
        if (!(await needManage())) return
        const target = getTarget(content)
        if (!target) return reply('[X] Mention or reply to a user.')
        if (ctx.warningCounts[from]) delete ctx.warningCounts[from][cleanJid(target)]
        return reply(`[OK] Warnings reset for @${cleanNumber(target)}`, [target])
    }

    // ── protection toggles ──
    const protectCmds = ['antilink', 'antispam', 'antibot', 'antimedia', 'antitag', 'antiforward']
    if (protectCmds.includes(cmd)) {
        if (!(await needManage())) return
        if (!ctx.groupSettings[from]) ctx.groupSettings[from] = {}
        if (args[0] === 'on' || args[0] === 'off') {
            ctx.groupSettings[from][cmd] = args[0] === 'on'
            saveCtx(ctx)
            return reply(`[OK] *${cmd}* is now *${args[0]}*`)
        }
        return reply(`*${cmd}:* ${ctx.groupSettings[from][cmd] ? 'on' : 'off'}\nUsage: ${prefix}${cmd} on/off`)
    }

    // ── member management ──
    if (cmd === 'kick') {
        if (!(await needManage())) return
        const target = getTarget(content)
        if (!target) return reply('[X] Mention or reply to a user.')
        const guard = await guardTarget(ctx, sock, from, target)
        if (guard) return reply(guard)
        try {
            const r = await participantsUpdate(sock, from, [target], 'remove')
            if (!r.ok) return reply('[X] Could not kick. Make sure I am a group admin.')
            return reply(`[OK] Kicked @${cleanNumber(target)}`, [target])
        } catch (e) { return reply('[X] Failed. Make sure I am a group admin.') }
    }

    if (cmd === 'add') {
        if (!(await needManage())) return
        const digits = (args[0] || '').replace(/[^0-9]/g, '')
        if (digits.length < 7) return reply('Usage: ' + prefix + 'add <number with country code>')
        try {
            const r = await participantsUpdate(sock, from, [normalizeJid(digits)], 'add')
            if (r.ok) return reply('[OK] Added.')
            const st = String(r.res?.[0]?.status)
            if (st === '403') return reply('[X] That user only allows adds via invite link.')
            if (st === '409') return reply('[X] That user is already in the group.')
            if (st === '408') return reply('[X] That user recently left the group.')
            return reply('[X] Could not add. Make sure I am a group admin.')
        } catch (e) { return reply('[X] Failed. Make sure I am a group admin.') }
    }

    if (cmd === 'promote' || cmd === 'demote') {
        if (!(await needManage())) return
        const target = getTarget(content)
        if (!target) return reply('[X] Mention or reply to a user.')
        try {
            const r = await participantsUpdate(sock, from, [target], cmd)
            if (!r.ok) return reply(`[X] Could not ${cmd}. Make sure I am a group admin.`)
            return reply(`[OK] ${cmd === 'promote' ? 'Promoted' : 'Demoted'} @${cleanNumber(target)}`, [target])
        } catch (e) { return reply('[X] Failed. Make sure I am a group admin.') }
    }

    if (cmd === 'mute' || cmd === 'unmute') {
        if (!(await needManage())) return
        try {
            await sock.groupSettingUpdate(from, cmd === 'mute' ? 'announcement' : 'not_announcement')
            return reply(`[OK] Group ${cmd === 'mute' ? 'muted' : 'unmuted'}.`)
        } catch (e) { return reply('[X] Failed. Make sure I am a group admin.') }
    }

    if (cmd === 'tagall' || cmd === 'hidetag') {
        if (!(await needManage())) return
        try {
            const groupMeta = await getGroupMeta(ctx, sock, from, true)
            const mentions = groupMeta.participants.map(p => p.id)
            const message = args.join(' ') || 'Attention everyone!'
            if (cmd === 'hidetag') return sock.sendMessage(from, { text: message, mentions })
            let out = '*Tag All:*\n\n' + message + '\n\n'
            mentions.forEach(jid => { out += `@${cleanNumber(jid)} ` })
            return sock.sendMessage(from, { text: out, mentions })
        } catch (e) { return reply('[X] Failed to fetch group members.') }
    }

    // ── group info ──
    if (cmd === 'groupinfo') {
        if (!(await needGroup())) return
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            return reply(
                `╭━━━〔 *GROUP INFO* 〕━━━┈⊷\n` +
                `┃ *Name:* ${meta.subject}\n` +
                `┃ *Members:* ${meta.participants.length}\n` +
                `┃ *Admins:* ${meta.participants.filter(p => p.admin).length}\n` +
                `╰━━━━━━━━━━━━━━━┈⊷`
            )
        } catch (e) { return reply('[X] Failed to fetch group info.') }
    }

    if (cmd === 'link') {
        if (!(await needManage())) return
        try { const code = await sock.groupInviteCode(from); return reply(`https://chat.whatsapp.com/${code}`) }
        catch (e) { return reply('[X] Failed. Make sure I am a group admin.') }
    }

    if (cmd === 'revoke') {
        if (!(await needManage())) return
        try { await sock.groupRevokeInvite(from); return reply('[OK] Link revoked.') }
        catch (e) { return reply('[X] Failed. Make sure I am a group admin.') }
    }

    if (cmd === 'admins') {
        if (!(await needGroup())) return
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            const admins = meta.participants.filter(p => p.admin)
            let out = '*Admins:*\n\n'
            admins.forEach(a => { out += `@${cleanNumber(a.id)}\n` })
            return reply(out, admins.map(a => a.id))
        } catch (e) { return reply('[X] Failed to fetch admins.') }
    }

    if (cmd === 'members') {
        if (!(await needGroup())) return
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            let out = `*Members (${meta.participants.length}):*\n\n`
            meta.participants.forEach(p => { out += `@${cleanNumber(p.id)}\n` })
            return reply(out, meta.participants.map(p => p.id))
        } catch (e) { return reply('[X] Failed to fetch members.') }
    }

    // ── welcome / goodbye ──
    if (cmd === 'welcome' || cmd === 'goodbye') {
        if (!(await needManage())) return
        if (!ctx.welcomeSettings[from]) ctx.welcomeSettings[from] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
        if (args[0] === 'on' || args[0] === 'off') {
            ctx.welcomeSettings[from][cmd] = args[0] === 'on'
            saveCtx(ctx)
            return reply(`[OK] *${cmd}* is now *${args[0]}*`)
        }
        return reply(`*${cmd}:* ${ctx.welcomeSettings[from][cmd] ? 'on' : 'off'}\nUsage: ${prefix}${cmd} on/off`)
    }

    if (cmd === 'setwelcome' || cmd === 'setgoodbye') {
        if (!(await needManage())) return
        const txt = args.join(' ')
        if (!txt) return reply('Usage: ' + prefix + cmd + ' <text>  (use @user for the member)')
        if (!ctx.welcomeSettings[from]) ctx.welcomeSettings[from] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
        ctx.welcomeSettings[from][cmd === 'setwelcome' ? 'welcomeMsg' : 'goodbyeMsg'] = txt
        saveCtx(ctx)
        return reply('[OK] Set.')
    }

    // ── polls ──
    if (cmd === 'poll') {
        if (!(await needGroup())) return
        const parts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean)
        if (parts.length < 3) return reply('Usage: ' + prefix + 'poll Question | Opt1 | Opt2')
        const [question, ...options] = parts
        ctx.activePolls[from] = { question, options, votes: {} }
        let out = `*Poll:* ${question}\n\n`
        options.forEach((opt, i) => { out += `${i + 1}. ${opt}\n` })
        out += `\nVote with ${prefix}vote <number>`
        return reply(out)
    }

    if (cmd === 'vote') {
        if (!ctx.activePolls[from]) return reply('[X] No active poll.')
        const num = parseInt(args[0]) - 1
        if (isNaN(num) || num < 0 || num >= ctx.activePolls[from].options.length) return reply('[X] Invalid vote.')
        ctx.activePolls[from].votes[cleanJid(sender)] = num
        return reply(`[OK] Voted for *${ctx.activePolls[from].options[num]}*`)
    }

    if (cmd === 'endpoll') {
        if (!(await needManage())) return
        if (!ctx.activePolls[from]) return reply('[X] No active poll.')
        const poll = ctx.activePolls[from]
        const tally = {}
        poll.options.forEach((_, i) => { tally[i] = 0 })
        Object.values(poll.votes).forEach(v => { tally[v]++ })
        let out = `*Poll Results:* ${poll.question}\n\n`
        poll.options.forEach((opt, i) => { out += `${opt}: ${tally[i]} votes\n` })
        delete ctx.activePolls[from]
        return reply(out)
    }

    // Unknown command: ignore silently so normal chat starting with the prefix is not spammed.
}

// ─────────────────────────── menu ───────────────────────────
function renderGroupCommandsBox(p) {
    return (
        `╭━━━〔 👥 GROUP COMMANDS 〕━━━┈⊷\n` +
        `┃ *Protection:*\n` +
        `┃ ${p}antilink  ${p}antispam\n` +
        `┃ ${p}antibot   ${p}antimedia\n` +
        `┃ ${p}antitag   ${p}antiforward\n` +
        `┃\n` +
        `┃ *Members:*\n` +
        `┃ ${p}kick  ${p}add\n` +
        `┃ ${p}promote  ${p}demote\n` +
        `┃ ${p}mute  ${p}unmute\n` +
        `┃\n` +
        `┃ *Communication:*\n` +
        `┃ ${p}tagall  ${p}hidetag\n` +
        `┃\n` +
        `┃ *Info:*\n` +
        `┃ ${p}groupinfo  ${p}link\n` +
        `┃ ${p}revoke  ${p}admins\n` +
        `┃ ${p}members\n` +
        `┃\n` +
        `┃ *Welcome:*\n` +
        `┃ ${p}welcome  ${p}goodbye\n` +
        `┃ ${p}setwelcome  ${p}setgoodbye\n` +
        `┃\n` +
        `┃ *Warn:*\n` +
        `┃ ${p}warn  ${p}warncount\n` +
        `┃ ${p}warnlist  ${p}resetwarn\n` +
        `┃\n` +
        `┃ *Polls:*\n` +
        `┃ ${p}poll  ${p}vote  ${p}endpoll\n` +
        `╰━━━━━━━━━━━━━━━┈⊷`
    )
}

function renderMenu(ctx, sock) {
    const p = ctx.cfg.prefix
    const d = new Date()
    return (
        `╭━━━━━━━〔 👹 ${BOT_NAME} 〕━━━━━━━╮\n\n` +
        `      BOT INFO\n\n` +
        `👤 OWNER  : ${ownerName(sock)}\n` +
        `⚙️ MODE   : ${ctx.cfg.mode}\n` +
        `🔧 PREFIX : ${p}\n` +
        `📅 DATE   : ${d.toLocaleDateString('en-US', { timeZone: TIMEZONE })}\n` +
        `🕐 TIME   : ${d.toLocaleTimeString('en-US', { timeZone: TIMEZONE })}\n` +
        `⏳ UPTIME : ${formatUptime(process.uptime())}\n` +
        `📡 SESSIONS: ${Object.keys(sessions).length}\n\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `╭━━━〔 BASIC 〕━━━┈⊷\n` +
        `┃ ${p}ping  ${p}hello  ${p}time  ${p}date\n` +
        `┃ ${p}info  ${p}menu   ${p}mode  ${p}prefix\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 FUN 〕━━━┈⊷\n` +
        `┃ ${p}joke  ${p}quote  ${p}fact  ${p}dice\n` +
        `┃ ${p}coin  ${p}truth  ${p}dare  ${p}roast\n` +
        `┃ ${p}compliment  ${p}8ball  ${p}rate  ${p}ship\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        renderGroupCommandsBox(p) + `\n\n` +
        `╭━━━〔 OWNER SETTINGS 〕━━━┈⊷\n` +
        `┃ ${p}typing  ${p}delay  ${p}read  ${p}online\n` +
        `┃ ${p}statusview  ${p}autoreact\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 UTILITY 〕━━━┈⊷\n` +
        `┃ ${p}calc  ${p}sticker  ${p}toimg\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 DOWNLOADER 〕━━━┈⊷\n` +
        `┃ ${p}tt <url>  (owner only)\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `POWERED BY ${BOT_NAME}`
    )
}

// ─────────────────────────── dashboard page ───────────────────────────
function renderDashboard() {
    const title = escapeHtml(BOT_NAME)
    const logoHtml = fs.existsSync(LOGO_PATH)
        ? `<img src="/logo.png" style="max-width:100%;border-radius:8px;margin-bottom:15px">`
        : `<p style="color:#888;font-size:13px">No logo uploaded yet.</p>`

    return `<!DOCTYPE html>
<html><head><title>${title} Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:Arial;background:#0a0000;color:#eee;padding:15px;max-width:900px;margin:auto}
h1{color:#ff2222;font-size:22px;margin:10px 0}
h3{color:#ff6666;font-size:15px;margin:0 0 10px 0}
.card{background:#1a0000;padding:15px;border-radius:10px;margin:12px 0;border:1px solid #440000}
input,button{padding:9px;font-size:14px;border-radius:5px;border:1px solid #440000;background:#220000;color:#eee;margin:4px 0;width:100%;box-sizing:border-box}
button{background:#aa0000;border:none;cursor:pointer;font-weight:bold;color:#fff}
button:hover{background:#dd0000}
.copy-btn{background:#006633;padding:6px 12px;font-size:12px;width:auto;margin-left:8px}
.copy-btn:hover{background:#009944}
.session{background:#220000;border-radius:8px;padding:12px;margin:8px 0;border:1px solid #440000;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.session-info{flex:1;min-width:200px;font-size:13px;line-height:1.6}
.session-info b{color:#ff6666}
.session-actions{display:flex;gap:6px;flex-wrap:wrap}
.session-actions button{padding:6px 12px;font-size:12px;width:auto;margin:0}
.status-active{color:#00ff88;font-weight:bold}
.status-connecting{color:#ffcc00;font-weight:bold}
.status-reconnecting{color:#ff8800;font-weight:bold}
.status-logged-out{color:#ff4444;font-weight:bold}
.code-box{background:#000;padding:10px;border-radius:5px;margin-top:8px;font-family:monospace;font-size:18px;letter-spacing:3px;color:#00ff88;text-align:center;word-break:break-all}
p{font-size:13px;line-height:1.5}
</style></head><body>
<h1>${title}</h1>

<div class="card">
${logoHtml}
<h3>BOT INFO</h3>
<p><b>Uptime:</b> <span id="info-uptime">${formatUptime(process.uptime())}</span></p>
<p><b>Sessions:</b> <span id="info-count">${Object.keys(sessions).length}</span></p>
<button onclick="refreshSessions()">Reload Sessions</button>
</div>

<div class="card">
<h3>UPLOAD LOGO</h3>
<form method="POST" action="/upload-logo" enctype="multipart/form-data">
<input type="file" name="logo" accept="image/*" required>
<button type="submit">Upload Logo</button>
</form>
</div>

<div class="card">
<h3>CONNECT WHATSAPP</h3>
<form method="POST" action="/dashboard">
<input type="hidden" name="action" value="connect">
<input type="text" name="number" placeholder="Number with country code, digits only" required>
<button type="submit">Generate Pairing Code</button>
</form>
<div id="pairing-display"></div>
<p style="font-size:11px;color:#888">After submitting, tap Reload Sessions to see the pairing code here.</p>
</div>

<div class="card">
<h3>SESSIONS</h3>
<div id="sessions-list">
<p style="color:#888;font-size:13px">Tap "Reload Sessions" to load.</p>
</div>
<p style="font-size:11px;color:#888">To link: WhatsApp -> Linked Devices -> Link with phone number</p>
</div>

<script>
function makeForm(action, number, label, extraStyle) {
    var f = document.createElement('form');
    f.method = 'POST';
    f.action = '/dashboard';
    f.style.display = 'inline';
    var a = document.createElement('input'); a.type = 'hidden'; a.name = 'action'; a.value = action;
    var n = document.createElement('input'); n.type = 'hidden'; n.name = 'number'; n.value = number;
    var b = document.createElement('button'); b.type = 'submit'; b.textContent = label;
    if (extraStyle) b.style.cssText = extraStyle;
    f.appendChild(a); f.appendChild(n); f.appendChild(b);
    return f;
}

async function refreshSessions() {
    try {
        var res = await fetch('/api/sessions', { credentials: 'same-origin' });
        var data = await res.json();
        document.getElementById('info-uptime').textContent = data.uptime;
        document.getElementById('info-count').textContent = data.count;

        var list = document.getElementById('sessions-list');
        var pairDiv = document.getElementById('pairing-display');
        pairDiv.innerHTML = '';
        list.innerHTML = '';

        if (data.sessions.length === 0) {
            list.innerHTML = '<p style="color:#888;font-size:13px">No sessions yet.</p>';
            return;
        }

        data.sessions.forEach(function (s) {
            var card = document.createElement('div');
            card.className = 'session';

            var info = document.createElement('div');
            info.className = 'session-info';
            var lines = [
                ['Number', s.number],
                ['Status', s.status],
                ['Mode / Prefix', (s.mode || '-') + ' / ' + (s.prefix || '-')],
                ['Connected', s.connectedAt ? new Date(s.connectedAt).toLocaleString() : '-']
            ];
            lines.forEach(function (l, idx) {
                var b = document.createElement('b'); b.textContent = l[0] + ': ';
                info.appendChild(b);
                var span = document.createElement('span');
                span.textContent = l[1];
                if (l[0] === 'Status') span.className = 'status-' + String(s.status).replace(/ /g, '-');
                info.appendChild(span);
                if (idx < lines.length - 1) info.appendChild(document.createElement('br'));
            });
            card.appendChild(info);

            var actions = document.createElement('div');
            actions.className = 'session-actions';
            actions.appendChild(makeForm('reconnect', s.number, 'Reconnect'));
            actions.appendChild(makeForm('disconnect', s.number, 'Disconnect', 'background:#880000'));
            card.appendChild(actions);
            list.appendChild(card);

            if (s.pairingCode && s.status !== 'active') {
                var p = document.createElement('div');
                var label = document.createElement('p');
                label.style.cssText = 'margin-top:10px;color:#ffcc00;font-size:13px';
                label.textContent = 'Pairing code for ' + s.number + ':';
                var box = document.createElement('div');
                box.className = 'code-box';
                box.textContent = s.pairingCode;
                var copy = document.createElement('button');
                copy.className = 'copy-btn';
                copy.textContent = 'Copy Code';
                copy.addEventListener('click', function () { copyCode(s.pairingCode); });
                p.appendChild(label); p.appendChild(box); p.appendChild(copy);
                pairDiv.appendChild(p);
            }
        });
    } catch (e) {
        console.log('Refresh error:', e);
    }
}

function copyCode(code) {
    navigator.clipboard.writeText(code).then(function () {
        alert('Copied: ' + code);
    }).catch(function () {
        var ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        alert('Copied: ' + code);
    });
}

refreshSessions();
</script>

</body></html>`
}

// ─────────────────────────── telegram control bot ───────────────────────────
// Bot: @DarkMatrix_XBot. Token comes from TELEGRAM_TOKEN; if unset, this whole
// section is skipped (no crash). Only TELEGRAM_ALLOWED_USER_ID may use it.
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ''
const TELEGRAM_ALLOWED_USER_ID = 7959585602
let tgBot = null
const tgPending = new Map() // chatId -> pending action ('connect')

function tgAuth(id) {
    return Number(id) === TELEGRAM_ALLOWED_USER_ID
}

function tgMainKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔗 Connect WhatsApp', callback_data: 'connect' }, { text: '📊 Status', callback_data: 'status' }],
            [{ text: '📋 Sessions', callback_data: 'sessions' }, { text: '🔄 Reconnect', callback_data: 'reconnect' }],
            [{ text: '❌ Disconnect', callback_data: 'disconnect' }, { text: '📁 WhatsApp Menu', callback_data: 'wa_menu' }]
        ]
    }
}
function tgBackKeyboard() {
    return { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu' }]] }
}

// Edits the tapped message in place when possible (nicer UX), falls back to a new message.
// Retries once without parse_mode if Markdown parsing fails on unpredictable content.
async function tgEditOrSend(chatId, messageId, text, keyboard, parseMode = 'Markdown') {
    const opts = { reply_markup: keyboard }
    if (parseMode) opts.parse_mode = parseMode
    if (messageId) {
        try { await tgBot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId }); return } catch (e) {}
    }
    try {
        await tgBot.sendMessage(chatId, text, opts)
    } catch (e) {
        console.log('[TELEGRAM] send error, retrying without parse_mode:', e?.message || e)
        try { await tgBot.sendMessage(chatId, text, { reply_markup: keyboard }) }
        catch (e2) { console.log('[TELEGRAM] send failed:', e2?.message || e2) }
    }
}

async function tgShowMenu(chatId, messageId) {
    await tgEditOrSend(chatId, messageId, `🤖 *${BOT_NAME} — Control Panel*\n\nChoose an option below:`, tgMainKeyboard())
}

async function tgShowStatus(chatId, messageId) {
    const list = Object.values(sessions)
    let text
    if (list.length === 0) {
        text = '📊 *Status*\n\nNo sessions yet.'
    } else {
        const active = list.filter(s => s.status === 'active')
        text = `📊 *Status*\n\nActive: ${active.length} / ${list.length} total\n\n`
        text += active.length
            ? active.map(s => `• *${s.number}* — up ${s.connectedAt ? formatUptime((Date.now() - new Date(s.connectedAt).getTime()) / 1000) : '-'}`).join('\n')
            : '_No active sessions._'
    }
    await tgEditOrSend(chatId, messageId, text, tgBackKeyboard())
}

async function tgShowSessions(chatId, messageId) {
    const entries = Object.entries(sessions)
    let text
    if (entries.length === 0) {
        text = '📋 *Sessions*\n\nNo sessions yet.'
    } else {
        text = '📋 *Sessions*\n\n' + entries.map(([, s]) =>
            `*${s.number}*\nStatus: ${s.status}\nMode: ${s.ctx?.cfg?.mode || '-'}\nConnected: ${s.connectedAt ? new Date(s.connectedAt).toLocaleString() : '-'}`
        ).join('\n\n')
    }
    await tgEditOrSend(chatId, messageId, text, tgBackKeyboard())
}

async function tgShowReconnectList(chatId, messageId) {
    const ids = Object.keys(sessions)
    if (ids.length === 0) { await tgEditOrSend(chatId, messageId, '🔄 *Reconnect*\n\nNo sessions yet.', tgBackKeyboard()); return }
    const rows = ids.map(id => [{ text: `🔄 ${sessions[id].number} (${sessions[id].status})`, callback_data: `reconnect:${id}` }])
    rows.push([{ text: '🔙 Back to Menu', callback_data: 'menu' }])
    await tgEditOrSend(chatId, messageId, '🔄 *Reconnect*\n\nSelect a number:', { inline_keyboard: rows })
}

async function tgShowDisconnectList(chatId, messageId) {
    const ids = Object.keys(sessions)
    if (ids.length === 0) { await tgEditOrSend(chatId, messageId, '❌ *Disconnect*\n\nNo sessions yet.', tgBackKeyboard()); return }
    const rows = ids.map(id => [{ text: `❌ ${sessions[id].number} (${sessions[id].status})`, callback_data: `disconnect:${id}` }])
    rows.push([{ text: '🔙 Back to Menu', callback_data: 'menu' }])
    await tgEditOrSend(chatId, messageId, '❌ *Disconnect*\n\nSelect a number to disconnect:', { inline_keyboard: rows })
}

async function tgShowWaMenu(chatId, messageId) {
    const active = Object.values(sessions).find(s => s.status === 'active' && s.sock && s.ctx)
    if (!active) {
        await tgEditOrSend(chatId, messageId, '[X] No active WhatsApp session yet. Connect one first.', tgBackKeyboard())
        return
    }
    await tgEditOrSend(chatId, messageId, renderMenu(active.ctx, active.sock), tgBackKeyboard())
}

// Polls up to `timeoutMs` for the pairing code to appear. Tracks the session's `gen` so a
// poll started by an earlier attempt stops reporting once a newer startSession() supersedes it.
async function tgPollPairingCode(sessionId, gen, timeoutMs = 15000, intervalMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const s = sessions[sessionId]
        if (!s || s.gen !== gen) return null // session gone or superseded by a newer attempt
        if (s.pairingCode) return s.pairingCode
        if (s.status === 'active') return null // already linked, no code to show
        await sleep(intervalMs)
    }
    return null
}

// Mirrors the dashboard's "connect" action, then polls for the pairing code (startSession's
// own 3s delay means it isn't set the instant startSession() resolves).
async function tgConnectNumber(chatId, rawNumber) {
    const cleanNum = String(rawNumber || '').replace(/[^0-9]/g, '')
    if (cleanNum.length < 7) {
        await tgBot.sendMessage(chatId, '[X] Invalid number. Send digits only, with country code.', { reply_markup: tgBackKeyboard() })
        return
    }
    const sessionId = 'sess_' + cleanNum
    try {
        const existing = sessions[sessionId]
        if (existing?.status === 'active') {
            await tgBot.sendMessage(chatId, `[OK] *${cleanNum}* is already connected.`, { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
            return
        }
        if (!existing) {
            await startSession(sessionId, cleanNum)
        } else if (existing.status === 'logged out') {
            stopSocket(sessionId)
            await startSession(sessionId, cleanNum, true)
        }
        const gen = sessions[sessionId]?.gen
        await tgBot.sendMessage(chatId, `⏳ Connecting *${cleanNum}*... waiting for pairing code.`, { parse_mode: 'Markdown' })
        const code = await tgPollPairingCode(sessionId, gen)
        const s = sessions[sessionId]
        if (code) {
            await tgBot.sendMessage(chatId, `🔗 *Pairing code for ${cleanNum}:*\n\n\`${code}\`\n\nWhatsApp → Linked Devices → Link with phone number.`, { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        } else if (s?.status === 'active') {
            await tgBot.sendMessage(chatId, `[OK] *${cleanNum}* connected.`, { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        } else {
            await tgBot.sendMessage(chatId, `[X] Pairing code was not generated in time (current status: ${s?.status || 'unknown'}). Try /reconnect ${cleanNum}.`, { reply_markup: tgBackKeyboard() })
        }
    } catch (e) {
        console.log('[TELEGRAM] connect error:', e?.message || e)
        await tgBot.sendMessage(chatId, '[X] Failed to start session: ' + (e?.message || 'unknown error'), { reply_markup: tgBackKeyboard() })
    }
}

// Mirrors the dashboard's "reconnect" action (same cooldown map, same hasCreds check), then
// polls for a pairing code the same way tgConnectNumber does.
async function tgReconnectSession(chatId, sessionId) {
    const existing = sessions[sessionId]
    if (!existing) { await tgBot.sendMessage(chatId, '[X] Session not found.', { reply_markup: tgBackKeyboard() }); return }
    const number = existing.number
    const now = Date.now()
    if (reconnectCooldown[sessionId] && now - reconnectCooldown[sessionId] < 30000) {
        await tgBot.sendMessage(chatId, '[X] Please wait before reconnecting again.', { reply_markup: tgBackKeyboard() })
        return
    }
    reconnectCooldown[sessionId] = now
    try {
        const wasLoggedOut = existing.status === 'logged out'
        stopSocket(sessionId)
        const hasCreds = authCollection
            ? !!(await authCollection.findOne({ _id: `${sessionId}:creds` }).catch(() => null)) && !wasLoggedOut
            : fs.existsSync(path.join(SESSION_DIR, sessionId, 'creds.json'))
        await startSession(sessionId, number, !hasCreds)
        const gen = sessions[sessionId]?.gen
        await tgBot.sendMessage(chatId, `⏳ Reconnecting *${number}*... waiting for pairing code (if needed).`, { parse_mode: 'Markdown' })
        const code = await tgPollPairingCode(sessionId, gen)
        const s = sessions[sessionId]
        if (code) {
            await tgBot.sendMessage(chatId, `🔗 *New pairing code for ${number}:*\n\n\`${code}\``, { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        } else if (s?.status === 'active') {
            await tgBot.sendMessage(chatId, `[OK] *${number}* reconnected.`, { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        } else {
            await tgBot.sendMessage(chatId, `[X] Pairing code was not generated in time (current status: ${s?.status || 'unknown'}). Try /reconnect ${number} again.`, { reply_markup: tgBackKeyboard() })
        }
    } catch (e) {
        console.log('[TELEGRAM] reconnect error:', e?.message || e)
        await tgBot.sendMessage(chatId, '[X] Reconnect failed.', { reply_markup: tgBackKeyboard() })
    }
}

// Mirrors the dashboard's "disconnect" action exactly.
async function tgDisconnectSession(chatId, sessionId) {
    const existing = sessions[sessionId]
    if (!existing) { await tgBot.sendMessage(chatId, '[X] Session not found.', { reply_markup: tgBackKeyboard() }); return }
    const number = existing.number
    try { await existing.sock.logout() } catch (e) {}
    stopSocket(sessionId)
    delete sessions[sessionId]
    try { fs.rmSync(path.join(SESSION_DIR, sessionId), { recursive: true, force: true }) } catch (e) {}
    await deleteSessionFromMongo(sessionId)
    await tgBot.sendMessage(chatId, `[OK] Disconnected *${number}*.`, { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
}

function tgHelpText() {
    return '*Commands:*\n\n' +
        '/start - main menu\n' +
        '/connect <number> - link a WhatsApp number\n' +
        '/status - show session statuses\n' +
        '/sessions - list all sessions\n' +
        '/reconnect <number> - reconnect a session\n' +
        '/disconnect <number> - disconnect a session\n' +
        '/menu - main menu\n' +
        '/help - this message'
}

function initTelegram() {
    if (!TELEGRAM_TOKEN) {
        console.log('[TELEGRAM] TELEGRAM_TOKEN not set. Skipping Telegram integration.')
        return
    }
    let TelegramBot
    try {
        TelegramBot = require('node-telegram-bot-api')
    } catch (e) {
        console.log('[TELEGRAM] node-telegram-bot-api not found. Run: npm install node-telegram-bot-api')
        return
    }
    try {
        tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true })
    } catch (e) {
        console.log('[TELEGRAM] Failed to start bot:', e?.message || e)
        return
    }

    let tgPollErrorCount = 0
    let tgLastPollError = ''
    tgBot.on('polling_error', (e) => {
        const errMsg = e?.message || String(e)
        console.log('[TELEGRAM] Polling error:', errMsg)
        if (errMsg === tgLastPollError) tgPollErrorCount++
        else { tgLastPollError = errMsg; tgPollErrorCount = 1 }
        if (tgPollErrorCount === 3) {
            console.log('[TELEGRAM] Polling has failed 3 times in a row with the same error. TELEGRAM_TOKEN is likely invalid or revoked.')
        }
    })

    tgBot.onText(/^\/start\b/, async (msg) => {
        if (!tgAuth(msg.from.id)) return
        tgPending.delete(msg.chat.id)
        await tgShowMenu(msg.chat.id)
    })
    tgBot.onText(/^\/menu\b/, async (msg) => {
        if (!tgAuth(msg.from.id)) return
        tgPending.delete(msg.chat.id)
        await tgShowMenu(msg.chat.id)
    })
    tgBot.onText(/^\/help\b/, async (msg) => {
        if (!tgAuth(msg.from.id)) return
        tgPending.delete(msg.chat.id)
        await tgBot.sendMessage(msg.chat.id, tgHelpText(), { parse_mode: 'Markdown' })
    })
    tgBot.onText(/^\/connect(?:\s+(.+))?/, async (msg, match) => {
        if (!tgAuth(msg.from.id)) return
        const num = match?.[1]
        if (!num) {
            tgPending.set(msg.chat.id, 'connect')
            await tgBot.sendMessage(msg.chat.id, '🔗 Send me the WhatsApp number (digits only, with country code).', { reply_markup: tgBackKeyboard() })
            return
        }
        tgPending.delete(msg.chat.id)
        await tgConnectNumber(msg.chat.id, num)
    })
    tgBot.onText(/^\/status\b/, async (msg) => {
        if (!tgAuth(msg.from.id)) return
        tgPending.delete(msg.chat.id)
        await tgShowStatus(msg.chat.id)
    })
    tgBot.onText(/^\/sessions\b/, async (msg) => {
        if (!tgAuth(msg.from.id)) return
        tgPending.delete(msg.chat.id)
        await tgShowSessions(msg.chat.id)
    })
    tgBot.onText(/^\/reconnect(?:\s+(.+))?/, async (msg, match) => {
        if (!tgAuth(msg.from.id)) return
        tgPending.delete(msg.chat.id)
        const num = match?.[1]?.replace(/[^0-9]/g, '')
        if (!num) { await tgShowReconnectList(msg.chat.id); return }
        await tgReconnectSession(msg.chat.id, 'sess_' + num)
    })
    tgBot.onText(/^\/disconnect(?:\s+(.+))?/, async (msg, match) => {
        if (!tgAuth(msg.from.id)) return
        tgPending.delete(msg.chat.id)
        const num = match?.[1]?.replace(/[^0-9]/g, '')
        if (!num) { await tgShowDisconnectList(msg.chat.id); return }
        await tgDisconnectSession(msg.chat.id, 'sess_' + num)
    })

    // Plain-text follow-up, used after "Connect WhatsApp" asks for a number.
    tgBot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return
        if (!tgAuth(msg.from.id)) return
        const pending = tgPending.get(msg.chat.id)
        if (pending === 'connect') {
            tgPending.delete(msg.chat.id)
            await tgConnectNumber(msg.chat.id, msg.text)
        }
    })

    tgBot.on('callback_query', async (query) => {
        const chatId = query.message?.chat?.id
        const messageId = query.message?.message_id
        if (!chatId) return
        if (!tgAuth(query.from.id)) {
            try { await tgBot.answerCallbackQuery(query.id, { text: '🚫 Not authorized.', show_alert: true }) } catch (e) {}
            return
        }
        try { await tgBot.answerCallbackQuery(query.id) } catch (e) {}
        const data = query.data || ''
        try {
            if (data === 'menu') { await tgShowMenu(chatId, messageId); return }
            if (data === 'status') { await tgShowStatus(chatId, messageId); return }
            if (data === 'sessions') { await tgShowSessions(chatId, messageId); return }
            if (data === 'wa_menu') { await tgShowWaMenu(chatId, messageId); return }
            if (data === 'connect') {
                tgPending.set(chatId, 'connect')
                await tgEditOrSend(chatId, messageId, '🔗 Send me the WhatsApp number to connect (digits only, with country code).', tgBackKeyboard())
                return
            }
            if (data === 'reconnect') { await tgShowReconnectList(chatId, messageId); return }
            if (data === 'disconnect') { await tgShowDisconnectList(chatId, messageId); return }
            if (data.startsWith('reconnect:')) { await tgReconnectSession(chatId, data.slice('reconnect:'.length)); return }
            if (data.startsWith('disconnect:')) { await tgDisconnectSession(chatId, data.slice('disconnect:'.length)); return }
        } catch (e) {
            console.log('[TELEGRAM] callback error:', e?.message || e)
        }
    })

    console.log('[TELEGRAM] Bot started: @DarkMatrix_XBot')
}

// ─────────────────────────── startup ───────────────────────────
async function restoreSessions() {
    const connected = await initMongo()
    await loadLogoFromMongo()

    let ids = []
    if (connected) {
        try {
            const a = await authCollection.distinct('sid')
            const l = await legacyCollection.distinct('_id')
            ids = [...new Set([...a, ...l])]
        } catch (e) {
            console.log('[MONGO] Restore error:', e.message)
        }
    } else if (fs.existsSync(SESSION_DIR)) {
        ids = fs.readdirSync(SESSION_DIR).filter(d => d.startsWith('sess_'))
    }

    for (const sessionId of ids) {
        const number = sessionId.replace('sess_', '')
        console.log(`Restoring session: ${number}`)
        try { await startSession(sessionId, number) } catch (e) { console.log('Restore error:', e.message) }
    }
}

restoreSessions().catch(e => console.log('Restore failed:', e.message))
initTelegram()
checkYtDlp()
