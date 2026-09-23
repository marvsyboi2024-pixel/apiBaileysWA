/*
 * SUKUNA REALM — WhatsApp bot (Baileys) + Telegram control panel
 *
 * Env vars:
 *   MONGO_URI           (optional) MongoDB connection string
 *   MONGO_DB            (optional) default: whatsappbot
 *   DASHBOARD_PASSWORD  (optional) default: Mars2000
 *   BOT_NAME            (optional) default: SUKUNA REALM
 *   BOT_TIMEZONE        (optional) e.g. Africa/Lagos
 *   PORT                (optional) default: 3000
 *   TELEGRAM_TOKEN      (optional) Telegram bot token. If unset, Telegram is skipped.
 *
 * System tools: ffmpeg (needed for .sticker / .toimg), yt-dlp (needed for .tt)
 * Optional npm: node-telegram-bot-api (needed for Telegram control), qrcode (needed for .qrcode)
 *
 * Telegram bot: @DarkMatrix_XBot. Only Telegram user id 7959585602 may use it.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { execFile } = require('child_process')
const P = require('pino')
const { MongoClient } = require('mongodb')
const baileys = require('@whiskeysockets/baileys')
const makeWASocket = baileys.default
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, initAuthCreds, BufferJSON, proto } = baileys

let QRCode = null
try { QRCode = require('qrcode') } catch (e) { QRCode = null }

// ─────────────────────────── config ───────────────────────────
const BOT_NAME = process.env.BOT_NAME || 'SUKUNA REALM'
const MONGO_URI = process.env.MONGO_URI || ''
const MONGO_DB = process.env.MONGO_DB || 'whatsappbot'
const PORT = process.env.PORT || 3000
const TIMEZONE = process.env.BOT_TIMEZONE || undefined
const SESSION_DIR = path.join('.', 'sessions')
const LOGO_PATH = path.join('.', 'logo.png')
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Mars2000'

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

async function useMongoAuthState(sessionId, legacyCredsStr) {
    const id = (name) => `${sessionId}:${name}`
    const writeData = async (name, data) => {
        try {
            return await authCollection.updateOne(
                { _id: id(name) },
                { $set: { sid: sessionId, data: JSON.stringify(data, BufferJSON.replacer) } },
                { upsert: true }
            )
        } catch (e) { console.log('[MONGO] writeData error:', e?.message || e); return null }
    }
    const readData = async (name) => {
        try {
            const d = await authCollection.findOne({ _id: id(name) })
            return d ? JSON.parse(d.data, BufferJSON.reviver) : null
        } catch (e) { console.log('[MONGO] readData error:', e?.message || e); return null }
    }
    const removeData = async (name) => {
        try { return await authCollection.deleteOne({ _id: id(name) }) }
        catch (e) { console.log('[MONGO] removeData error:', e?.message || e); return null }
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
    } catch (e) { console.log('[MONGO] Delete error:', e.message) }
}

async function saveLogoToMongo(buffer) {
    if (!logoCollection) return
    try {
        await logoCollection.updateOne(
            { _id: 'botlogo' },
            { $set: { data: buffer.toString('base64'), updatedAt: new Date() } },
            { upsert: true }
        )
    } catch (e) { console.log('[MONGO] Logo save error:', e.message) }
}

async function loadLogoFromMongo() {
    if (!logoCollection) return false
    try {
        const doc = await logoCollection.findOne({ _id: 'botlogo' })
        if (doc && doc.data) {
            fs.writeFileSync(LOGO_PATH, Buffer.from(doc.data, 'base64'))
            return true
        }
    } catch (e) { console.log('[MONGO] Logo load error:', e.message) }
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
// Static, keyless bad-word list for .antibadword. Deliberately modest — this is a light
// filter, not a full profanity database.
const BAD_WORDS = [
    'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'pussy', 'nigger', 'nigga',
    'cunt', 'whore', 'slut', 'faggot', 'retard'
]
const bioLines = [
    '⚡ SUKUNA REALM is watching...',
    '👹 Domain Expansion: Malevolent Shrine',
    '🔮 Powered by SUKUNA REALM',
    '⛩️ Type .menu to summon the commands',
    '🗡️ 20 Fingers. Infinite Power.'
]

// ─────────────────────────── SUKUNA REALM message templates ───────────────────────────
function skSig() { return '        ⟡ *SUKUNA REALM* ⟡' }

function skBasic(emoji, fields) {
    let out = `╭━〔 ${emoji} *SUKUNA REALM* 〕━╮\n`
    for (const [k, v] of fields) out += `▸ ${k} ─→ ${v}\n`
    out += `\n${skSig()}`
    return out
}

function skContent(emoji, label, content) {
    return `╭━〔 ${emoji} *SUKUNA REALM* 〕━╮\n\n▸ ${label}\n└─ ${content}\n\n${skSig()}`
}

function skError(reason) {
    return `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n▸ ERROR ─→ ${reason}\n\n${skSig()}`
}

function skInfo(emoji, title, fields) {
    let out = `╭━〔 ${emoji} *SUKUNA REALM* 〕━╮\n\n▸ ${title}\n\n`
    for (const [k, v] of fields) out += `◈ *${k}*\n└─ ${v}\n\n`
    out += skSig()
    return out
}

function skGroup(emoji, title, fields, byJid) {
    let out = `╭━〔 ${emoji} *SUKUNA REALM* 〕━╮\n┃\n`
    out += `┃      ${emoji} *${title}*\n┃\n`
    if (byJid) out += `┃  ◈ *BY*\n┃  └─ @${cleanNumber(byJid)}\n┃\n`
    for (const [k, v] of fields) out += `┃  ◈ *${k}*\n┃  └─ ${v}\n┃\n`
    out += `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`
    return out
}

// ─────────────────────────── helpers ───────────────────────────
function getRandom(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function normalizeJid(number) { return number.replace(/[^0-9]/g, '') + '@s.whatsapp.net' }
function formatUptime(sec) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return `${h}h ${m}m`
}
function cleanNumber(jid) { return jid ? String(jid).split('@')[0].split(':')[0] : '' }
function cleanJid(jid) {
    if (!jid) return ''
    const [user, domain] = String(jid).split('@')
    return user.split(':')[0] + '@' + (domain || 's.whatsapp.net')
}
function getBotJid(sock) { return cleanJid(sock.user?.id || sock.authState?.creds?.me?.id || '') }
function botIds(sock) {
    const ids = new Set()
    const add = (j) => { const n = cleanNumber(j); if (n) ids.add(n) }
    add(sock.user?.id); add(sock.user?.lid)
    add(sock.authState?.creds?.me?.id); add(sock.authState?.creds?.me?.lid)
    return ids
}
function isBotJid(sock, jid) { return !!jid && botIds(sock).has(cleanNumber(jid)) }
function ownerName(sock) { return sock.user?.name || cleanNumber(sock.user?.id) || 'Owner' }

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
    if (inner?.audioMessage) return { type: 'audio', message: inner }
    if (message.imageMessage?.viewOnce) return { type: 'image', message: { imageMessage: message.imageMessage } }
    if (message.videoMessage?.viewOnce) return { type: 'video', message: { videoMessage: message.videoMessage } }
    if (message.audioMessage?.viewOnce) return { type: 'audio', message: { audioMessage: message.audioMessage } }
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
        while (peek() === '+' || peek() === '-') { const op = next(); const r = parseTerm(); v = op === '+' ? v + r : v - r }
        return v
    }
    function parseTerm() {
        let v = parsePow()
        while (peek() === '*' || peek() === '/' || peek() === '%') { const op = next(); const r = parsePow(); v = op === '*' ? v * r : op === '/' ? v / r : v % r }
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
        if (t === '(') { const v = parseExpr(); if (next() !== ')') throw new Error('bad'); return v }
        if (t === undefined || isNaN(Number(t))) throw new Error('bad')
        return Number(t)
    }
    const result = parseExpr()
    if (i !== tokens.length || !isFinite(result)) throw new Error('bad')
    return result
}

// ─────────────────────────── http helpers (keyless APIs) ───────────────────────────
function httpGetBuffer(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode && res.statusCode >= 400) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return }
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => resolve(Buffer.concat(chunks)))
        })
        req.on('error', reject)
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    })
}
async function httpGetJson(url, timeoutMs = 10000) {
    const buffer = await httpGetBuffer(url, timeoutMs)
    return JSON.parse(buffer.toString('utf-8'))
}
async function httpGetText(url, timeoutMs = 10000) {
    const buffer = await httpGetBuffer(url, timeoutMs)
    return buffer.toString('utf-8')
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
            statusview: false,
            autobio: false
        },
        groupSettings: {},
        warnLimit: {},
        welcomeSettings: {},
        warningCounts: {},
        activePolls: {},
        spam: {},
        metaCache: {},
        statusCache: new Map(),
        messageCache: new Map(),
        ttUsage: [],
        extractCooldown: {},
        pendingConfirm: {},
        activity: {},
        afk: {},
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
    if (isBotJid(sock, target)) return skError('Cannot target myself.')
    if (await checkAdmin(ctx, sock, from, [target])) return skError('That user is a group admin.')
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
        if (list.length >= 6) { ctx.spam[from][sender] = []; return 'spam' }
    }
    return null
}

async function enforceProtection(sock, ctx, msg, content, from, sender, senderNumber, text) {
    const settings = ctx.groupSettings[from]
    if (!settings || !Object.values(settings).some(Boolean)) return false

    const ci = getContextInfo(content)
    const reason = detectViolation(ctx, settings, msg, content, ci, text, from, sender)
    if (!reason) return false

    if (await checkAdmin(ctx, sock, from, [sender])) return false

    if (!ctx.warningCounts[from]) ctx.warningCounts[from] = {}
    const key = cleanJid(sender)
    ctx.warningCounts[from][key] = (ctx.warningCounts[from][key] || 0) + 1
    const limit = ctx.warnLimit[from] || 3
    const count = ctx.warningCounts[from][key]

    const botAdmin = await checkAdmin(ctx, sock, from, [...botIds(sock)])
    if (botAdmin) {
        try { await sock.sendMessage(from, { delete: msg.key }) } catch (e) {}
    }

    try {
        await sock.sendMessage(from, {
            text: skGroup('⚠️', 'WARN', [
                ['USER', `@${senderNumber}`],
                ['REASON', reason],
                ['COUNT', `${Math.min(count, limit)} / ${limit}`]
            ]),
            mentions: [sender]
        })
    } catch (e) {}

    if (count >= limit && botAdmin) {
        try {
            await sock.groupParticipantsUpdate(from, [sender], 'remove')
            delete ctx.warningCounts[from][key]
            await sock.sendMessage(from, {
                text: skGroup('🚫', 'KICKED', [
                    ['USER', `@${senderNumber}`],
                    ['REASON', 'Warning limit reached']
                ]),
                mentions: [sender]
            })
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
            } catch (e) { console.log('Status download failed:', e?.message || e) }
            continue
        }
        const t = c.message.conversation || c.message.extendedTextMessage?.text
        if (t) { await sock.sendMessage(sender, { text: 'Saved status text:\n\n' + t }); return true }
    }
    return false
}

// ─────────────────────────── save / hmm / vv ───────────────────────────
// Shared per-user cooldown for .save/.hmm/.vv: these commands pull ephemeral/view-once
// media, which is exactly the kind of rapid, bot-shaped activity WhatsApp's anti-automation
// systems watch for. One minute between uses (per user, per session) keeps it human-paced.
function checkExtractCooldown(ctx, sender) {
    if (!ctx.extractCooldown) ctx.extractCooldown = {}
    const key = cleanJid(sender)
    const now = Date.now()
    const last = ctx.extractCooldown[key] || 0
    const remaining = 60000 - (now - last)
    if (remaining > 0) return Math.ceil(remaining / 1000)
    ctx.extractCooldown[key] = now
    return 0
}

async function handleSave(sock, ctx, msg, content, from, sender) {
    const prefix = ctx.cfg.prefix
    const ci = getContextInfo(content)
    const toDM = (payload) => sock.sendMessage(sender, payload).catch(() => {})
    const cleanup = async () => {
        if (msg.key.fromMe) {
            try { await sock.sendMessage(from, { delete: msg.key }) } catch (e) {}
        }
    }

    const wait = checkExtractCooldown(ctx, sender)
    if (wait > 0) {
        await toDM({ text: skError(`Please wait ${wait}s before using ${prefix}save again.`) })
        return
    }

    if (!ci || (!ci.quotedMessage && !ci.stanzaId)) {
        await toDM({ text: skError(`Reply to a status or a photo/video with ${prefix}save`) })
        return
    }

    if (ci.remoteJid === 'status@broadcast') {
        let saved = false
        try { saved = await saveStatus(sock, ctx, ci, sender) } catch (e) { console.log('Save status error:', e?.message || e) }
        if (!saved) await toDM({ text: skError('Could not save status. It may be expired or hidden.') })
        await cleanup()
        return
    }

    if (!ci.quotedMessage) {
        await toDM({ text: skError('Could not read the replied message.') })
        return
    }
    const quoted = unwrapEphemeral(ci.quotedMessage)
    const vo = extractViewOnceMedia(quoted)
    const message = vo ? vo.message : quoted
    const info = getMediaInfo(message)
    if (!info) {
        const t = quoted.conversation || quoted.extendedTextMessage?.text
        if (t) await toDM({ text: 'Saved text:\n\n' + t })
        else await toDM({ text: skError('That message has no media to save.') })
        await cleanup()
        return
    }
    try {
        const buffer = await downloadBuffer(sock, getQuotedKey(sock, from, ci), message)
        await sleep(1500 + Math.random() * 2500) // human-like pause before sending the saved media
        await sendSaved(sock, sender, info, buffer, 'Saved')
    } catch (e) {
        console.log('.save error:', e?.message || e)
        await toDM({ text: skError('Failed to save that media. It may have expired.') })
    }
    await cleanup()
}

async function handleViewOnceCmd(sock, ctx, msg, content, from, sender, kind) {
    const prefix = ctx.cfg.prefix
    const silent = kind === 'hmm'
    const say = (text) => (silent
        ? sock.sendMessage(sender, { text })
        : sock.sendMessage(from, { text }, { quoted: msg })).catch(() => {})

    const wait = checkExtractCooldown(ctx, sender)
    if (wait > 0) {
        await say(skError(`Please wait ${wait}s before using ${prefix}${kind} again.`))
        return
    }

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
        if (!ci) await say(skError(`Reply to a view-once photo/video/voice note with ${prefix}${kind}`))
        else await say(skError('This only works on unopened view-once media.'))
        return
    }

    try {
        const buffer = await downloadBuffer(sock, key, target.message)
        await sleep(1500 + Math.random() * 2500) // human-like pause before sending
        const caption = silent ? 'Saved view-once' : 'View-once revealed'
        let payload
        if (target.type === 'image') payload = { image: buffer, caption }
        else if (target.type === 'video') payload = { video: buffer, caption }
        else payload = { audio: buffer, mimetype: target.message.audioMessage?.mimetype || 'audio/ogg; codecs=opus', ptt: true }
        if (silent) await sock.sendMessage(sender, payload)
        else await sock.sendMessage(from, payload, { quoted: msg })
    } catch (e) {
        console.log(`.${kind} error:`, e?.message || e)
        await say(skError('Failed to get that view-once. WhatsApp may have deleted it.'))
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
    const sender = fromMe ? getBotJid(sock) : (isGroup ? (msg.key.participant || msg.participant) : from)
    if (!sender) return
    const senderNumber = cleanNumber(sender)
    const owner = fromMe

    if (isGroup && sender && !fromMe) {
        if (!ctx.activity) ctx.activity = {}
        if (!ctx.activity[from]) ctx.activity[from] = {}
        const _k = cleanJid(sender)
        const _prev = ctx.activity[from][_k] || { count: 0, last: 0 }
        ctx.activity[from][_k] = { count: _prev.count + 1, last: Date.now() }
    }

    const content = unwrap(msg.message)

    // .antidelete — WhatsApp delivers a deletion as a protocolMessage(type REVOKE) pointing
    // at the original message's key. If we cached that message, repost it into the group.
    if (isGroup && content?.protocolMessage?.type === 0) {
        const settings = ctx.groupSettings[from]
        if (settings?.antidelete) {
            const delId = content.protocolMessage.key?.id
            const cached = delId ? ctx.messageCache?.get(delId) : null
            if (cached) {
                sock.sendMessage(from, {
                    text: skGroup('🗑️', 'MESSAGE DELETED', [
                        ['USER', `@${cleanNumber(cached.sender)}`],
                        ['CONTENT', cached.hasMedia ? `[${cached.mediaType}]` : (cached.body || '(no text)')]
                    ], cached.sender),
                    mentions: [cached.sender]
                }).catch(() => {})
            }
        }
        return
    }

    const body = content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption || ''
    const text = body.trim()
    const lowerText = text.toLowerCase()
    const prefix = ctx.cfg.prefix
    const isCmd = text.startsWith(prefix)

    if (isCmd) {
        if (lowerText === prefix + 'hmm') { await handleViewOnceCmd(sock, ctx, msg, content, from, sender, 'hmm'); return }
        if (lowerText === prefix + 'vv') { await handleViewOnceCmd(sock, ctx, msg, content, from, sender, 'vv'); return }
        if (lowerText === prefix + 'save') { await handleSave(sock, ctx, msg, content, from, sender); return }
    }

    if (isGroup && !fromMe) {
        const handled = await enforceProtection(sock, ctx, msg, content, from, sender, senderNumber, text)
        if (handled) return
    }

    if (ctx.cfg.mode === 'private' && !fromMe) return

    if (ctx.cfg.read && !fromMe) {
        try { await sock.readMessages([msg.key]) } catch (e) {}
    }
    if (ctx.cfg.online) {
        try { await sock.sendPresenceUpdate('available', from) } catch (e) {}
    }

    const hasPending = !!(ctx.pendingConfirm && ctx.pendingConfirm[from])
    const isBareYesNo = (lowerText === 'yes' || lowerText === 'no')

    let args, cmd
    if (isCmd) {
        args = text.slice(prefix.length).trim().split(/\s+/)
        cmd = (args.shift() || '').toLowerCase()
    } else if (hasPending && isBareYesNo) {
        args = []
        cmd = lowerText
    } else {
        return
    }
    if (!cmd || !/^[a-z0-9]+$/.test(cmd)) return

    if (ctx.cfg.delay) await sleep(3000 + Math.random() * 3000)
    if (ctx.cfg.typing) {
        try { await sock.sendPresenceUpdate('composing', from) } catch (e) {}
    }
    try {
        await handleCommand(sock, ctx, msg, content, from, isGroup, sender, senderNumber, owner, cmd, args)
    } catch (e) {
        console.log(`Command .${cmd} error:`, e?.message || e)
        try { await sock.sendMessage(from, { text: skError('Something went wrong running that command.') }, { quoted: msg }) } catch (e2) {}
    } finally {
        if (ctx.cfg.typing) {
            try { await sock.sendPresenceUpdate('paused', from) } catch (e) {}
        }
    }
}

// ─────────────────────────── send throttle (anti-ban) ───────────────────────────
// Wraps sock.sendMessage once per socket so every existing call site in the file
// (warnings, kicks, menus, .save/.hmm/.vv, everything) automatically gets: a small
// randomized gap between any two outgoing messages (avoids bursty, bot-shaped traffic),
// and an automatic cooldown if WhatsApp starts returning rate-limit-shaped errors.
function attachSendThrottle(sock) {
    const original = sock.sendMessage.bind(sock)
    let queue = Promise.resolve()
    let lastSend = 0
    let backoffUntil = 0

    sock.sendMessage = (...sendArgs) => {
        const run = queue.then(async () => {
            const now1 = Date.now()
            if (backoffUntil > now1) await sleep(backoffUntil - now1)

            const gap = 400 + Math.random() * 900 // 0.4-1.3s human-like spacing
            const since = Date.now() - lastSend
            if (since < gap) await sleep(gap - since)

            try {
                const result = await original(...sendArgs)
                lastSend = Date.now()
                return result
            } catch (e) {
                lastSend = Date.now()
                const status = e?.output?.statusCode || e?.status
                const msg = String(e?.message || e)
                if (status === 429 || /rate.?limit|too many requests/i.test(msg)) {
                    backoffUntil = Date.now() + 30000
                    console.log('[THROTTLE] Rate-limit signal from WhatsApp, backing off 30s')
                }
                throw e
            }
        })
        // Keep the queue chain alive even if this particular send rejects.
        queue = run.catch(() => {})
        return run
    }
}

// ─────────────────────────── session ───────────────────────────
function stopSocket(sessionId) {
    const s = sessions[sessionId]
    if (!s) return
    s.gen = (s.gen || 0) + 1
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
    attachSendThrottle(sock)

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
            const { id, participants, action, author } = update
            delete ctx.metaCache[id]
            const ws = ctx.welcomeSettings[id] || {}

            let memberCount = null
            try {
                const meta = await getGroupMeta(ctx, sock, id, true)
                memberCount = meta.participants.length
            } catch (e) {}

            for (const p of participants) {
                const jid = typeof p === 'string' ? p : p.id
                if (!jid) continue

                if (isBotJid(sock, jid)) {
                    if (action === 'remove') console.log(`[${sessionId}] Bot removed from ${id}`)
                    continue
                }

                const num = cleanNumber(jid)

                if (action === 'add' && ws.welcome) {
                    const fields = [['USER', `@${num}`]]
                    const mentions = [jid]
                    if (author && !isBotJid(sock, author)) {
                        fields.push(['ADDED BY', `@${cleanNumber(author)}`])
                        mentions.push(author)
                    } else {
                        fields.push(['JOINED VIA', '🔗 INVITE LINK'])
                    }
                    if (memberCount !== null) fields.push(['MEMBERS', String(memberCount)])
                    await sock.sendMessage(id, {
                        text: skGroup('🎉', 'WELCOME', fields),
                        mentions
                    })
                }

                if (action === 'remove' && ws.goodbye) {
                    const fields = [['USER', `@${num}`]]
                    const mentions = [jid]
                    const wasKicked = author && author !== jid && !isBotJid(sock, author)
                    if (wasKicked) {
                        fields.push(['BY', `@${cleanNumber(author)}`])
                        mentions.push(author)
                        if (memberCount !== null) fields.push(['MEMBERS', String(memberCount)])
                        await sock.sendMessage(id, {
                            text: skGroup('👢', 'REMOVED', fields),
                            mentions
                        })
                    } else {
                        fields.push(['LEFT', 'Left the group'])
                        if (memberCount !== null) fields.push(['MEMBERS', String(memberCount)])
                        await sock.sendMessage(id, {
                            text: skGroup('👋', 'GOODBYE', fields),
                            mentions
                        })
                    }
                }

                if (action === 'promote' && ws.promote) {
                    const fields = [['USER', `@${num}`], ['ROLE', '👑 ADMIN']]
                    const mentions = [jid]
                    if (author && !isBotJid(sock, author) && author !== jid) {
                        fields.splice(1, 0, ['BY', `@${cleanNumber(author)}`])
                        mentions.push(author)
                    }
                    await sock.sendMessage(id, {
                        text: skGroup('👑', 'PROMOTED', fields),
                        mentions
                    })
                }

                if (action === 'demote' && ws.demote) {
                    const fields = [['USER', `@${num}`], ['ROLE', '👤 MEMBER']]
                    const mentions = [jid]
                    if (author && !isBotJid(sock, author) && author !== jid) {
                        fields.splice(1, 0, ['BY', `@${cleanNumber(author)}`])
                        mentions.push(author)
                    }
                    await sock.sendMessage(id, {
                        text: skGroup('⬇️', 'DEMOTED', fields),
                        mentions
                    })
                }
            }
        } catch (e) { console.log('Group update error:', e?.message || e) }
    })

    sock.ev.on('groups.update', async (updates) => {
        if (!isCurrent()) return
        try {
            for (const update of updates || []) {
                const id = update.id
                if (!id) continue
                delete ctx.metaCache[id]
                const updater = update.author || update.participant || null
                const updaterNum = updater ? cleanNumber(updater) : null
                const mentions = updater && !isBotJid(sock, updater) ? [updater] : []

                if (update.subject !== undefined && update.subject) {
                    const fields = []
                    if (updaterNum && !isBotJid(sock, updater)) fields.push(['BY', `@${updaterNum}`])
                    fields.push(['NEW NAME', update.subject])
                    await sock.sendMessage(id, { text: skGroup('📝', 'NAME CHANGED', fields), mentions })
                }

                if (update.desc !== undefined) {
                    const fields = []
                    if (updaterNum && !isBotJid(sock, updater)) fields.push(['BY', `@${updaterNum}`])
                    fields.push(['NEW DESC', update.desc || '(empty)'])
                    await sock.sendMessage(id, { text: skGroup('📝', 'DESC UPDATED', fields), mentions })
                }

                if (update.announce !== undefined) {
                    const locked = !!update.announce
                    await sock.sendMessage(id, {
                        text: skGroup(locked ? '🔒' : '🔓', locked ? 'GROUP LOCKED' : 'GROUP UNLOCKED', [
                            ['STATUS', locked ? '🔒 ADMINS ONLY' : '🟢 EVERYONE']
                        ])
                    })
                }

                if (update.picture !== undefined && update.picture !== null) {
                    await sock.sendMessage(id, {
                        text: skGroup('🖼️', 'ICON CHANGED', [['GROUP', update.subject || id]])
                    })
                }
            }
        } catch (e) { console.log('Groups update error:', e?.message || e) }
    })

    sock.ev.on('groups.upsert', async (groups) => {
        if (!isCurrent()) return
        try {
            for (const g of groups || []) {
                const id = g.id
                if (!id) continue
                delete ctx.metaCache[id]
                await sock.sendMessage(id, {
                    text: skGroup('👹', 'I HAVE ARRIVED', [
                        ['GROUP', g.subject || 'Unnamed'],
                        ['MEMBERS', String((g.participants || []).length)],
                        ['TIP', 'Type .menu for commands']
                    ])
                })
            }
        } catch (e) { console.log('Groups upsert error:', e?.message || e) }
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
}// ─────────────────────────── ffmpeg (replaces sharp) ───────────────────────────
let FFMPEG_AVAILABLE = false
function checkFfmpeg() {
    execFile('ffmpeg', ['-version'], { timeout: 10000 }, (err) => {
        FFMPEG_AVAILABLE = !err
        if (err) console.log('[FFMPEG] not found. Install with: pkg install ffmpeg')
    })
}
function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        execFile('ffmpeg', args, { timeout: 30000 }, (err) => { if (err) reject(err); else resolve() })
    })
}

// ─────────────────────────── confirm-gate helpers ───────────────────────────
function skConfirmBox(actionLabel, byJid, warning) {
    let out = `╭━〔 ⚠️ *SUKUNA REALM* 〕━╮\n┃\n`
    out += `┃     ⚠️ *CONFIRM*\n┃\n`
    out += `┃  ◈ *ACTION*\n┃  └─ ${actionLabel}\n┃\n`
    if (byJid) out += `┃  ◈ *BY*\n┃  └─ @${cleanNumber(byJid)}\n┃\n`
    if (warning) out += `┃  ◈ *WARNING*\n┃  └─ ${warning}\n┃\n`
    out += `┃  ⏳ Expires in 30s\n┃\n`
    out += `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n`
    out += `Reply with:\n▸ *yes*\n▸ *no*`
    return out
}
function skCancelledBox(actionLabel) {
    let out = `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n┃\n`
    out += `┃    ❌ *CANCELLED*\n┃\n`
    out += `┃  ◈ *ACTION*\n┃  └─ ${actionLabel}\n┃\n`
    out += `┃  ◈ *STATUS*\n┃  └─ 🔴 ABORTED\n┃\n`
    out += `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`
    return out
}

// ─────────────────────────── commands ───────────────────────────
async function handleCommand(sock, ctx, msg, content, from, isGroup, sender, senderNumber, owner, cmd, args) {
    const prefix = ctx.cfg.prefix
    const reply = (text, mentions) => sock.sendMessage(from, mentions ? { text, mentions } : { text }, { quoted: msg })
    const now = new Date()

    // CONFIRM GATE first
    if (ctx.pendingConfirm && ctx.pendingConfirm[from]) {
        const pending = ctx.pendingConfirm[from]
        if (Date.now() - pending.ts > 30000) {
            delete ctx.pendingConfirm[from]
        } else if (pending.by === sender) {
            if (cmd === 'yes') {
                delete ctx.pendingConfirm[from]
                return executeConfirmed(sock, ctx, msg, content, from, isGroup, sender, senderNumber, owner, pending.action)
            } else if (cmd === 'no') {
                delete ctx.pendingConfirm[from]
                return reply(skCancelledBox(pending.label))
            } else {
                delete ctx.pendingConfirm[from]
            }
        }
    }

    let adminCache = null
    const canManage = async () => {
        if (owner) return true
        if (!isGroup) return false
        if (adminCache === null) adminCache = await checkAdmin(ctx, sock, from, [sender])
        return adminCache
    }
    const needGroup = async () => {
        if (isGroup) return true
        await reply(skError('Group only.'))
        return false
    }
    const needManage = async () => {
        if (!(await needGroup())) return false
        if (await canManage()) return true
        await reply(skError('Admin only.'))
        return false
    }
    const needOwner = async () => {
        if (owner) return true
        await reply(skError('Owner only.'))
        return false
    }

    if (cmd === 'ping') return reply(skBasic('⚡', [['STATUS', '⚡ ONLINE']]))
    if (cmd === 'alive') return reply(skInfo('𖤐', 'BOT ALIVE', [['STATUS', '🟢 READY'], ['SYSTEM', '⚡ ONLINE']]))
    if (cmd === 'time') {
        return reply(skBasic('⏰', [
            ['DATE', now.toLocaleDateString('en-US', { timeZone: TIMEZONE })],
            ['DAY', now.toLocaleDateString('en-US', { weekday: 'long', timeZone: TIMEZONE })],
            ['TIME', now.toLocaleTimeString('en-US', { timeZone: TIMEZONE })]
        ]))
    }
    if (cmd === 'info') {
        return reply(skInfo('⚡', 'BOT INFO', [
            ['OWNER', ownerName(sock)],
            ['MODE', ctx.cfg.mode],
            ['PREFIX', prefix],
            ['SESSIONS', String(Object.keys(sessions).length)],
            ['UPTIME', formatUptime(process.uptime())]
        ]))
    }
    if (cmd === 'menu' || cmd === 'help') {
        const menuText = renderMenu(ctx, sock)
        if (fs.existsSync(LOGO_PATH)) {
            try {
                const buffer = fs.readFileSync(LOGO_PATH)
                await sock.sendMessage(from, { image: buffer, caption: menuText }, { quoted: msg })
                return
            } catch (e) { console.log('Menu image failed:', e?.message || e) }
        }
        return reply(menuText)
    }
    if (cmd === 'mars') {
        return reply(skInfo('🔒', 'HIDDEN COMMANDS', [
            ['.vv', 'Reveal view-once in chat'],
            ['.hmm', 'Silent save view-once to DM'],
            ['.save', 'Save status / photo to DM']
        ]))
    }
    if (cmd === 'mode') {
        if (!(await needOwner())) return
        if (args[0] === 'public' || args[0] === 'private') {
            ctx.cfg.mode = args[0]
            saveCtx(ctx)
            return reply(skBasic('⚙️', [['MODE', args[0] === 'public' ? '🟢 PUBLIC' : '🔒 PRIVATE']]))
        }
        return reply(skBasic('⚙️', [['MODE', ctx.cfg.mode]]))
    }
    if (cmd === 'prefix') {
        if (!(await needOwner())) return
        if (args[0]) {
            if (args[0].length > 3) return reply(skError('Prefix max 3 chars.'))
            ctx.cfg.prefix = args[0]
            saveCtx(ctx)
            return reply(skBasic('🔧', [['PREFIX', args[0]]]))
        }
        return reply(skBasic('🔧', [['PREFIX', ctx.cfg.prefix]]))
    }
    const toggles = ['typing', 'delay', 'read', 'online', 'autoreact', 'statusview']
    if (toggles.includes(cmd)) {
        if (!(await needOwner())) return
        if (args[0] === 'on' || args[0] === 'off') {
            ctx.cfg[cmd] = args[0] === 'on'
            saveCtx(ctx)
            return reply(skBasic('⚡', [[cmd.toUpperCase(), args[0] === 'on' ? '🟢 ON' : '🔴 OFF']]))
        }
        return reply(skBasic('⚡', [[cmd.toUpperCase(), ctx.cfg[cmd] ? '🟢 ON' : '🔴 OFF']]))
    }

    if (cmd === 'joke') return reply(skContent('😄', 'JOKE', getRandom(jokes)))
    if (cmd === 'quote') return reply(skContent('💬', 'QUOTE', getRandom(quotes)))
    if (cmd === 'fact') return reply(skContent('🧠', 'FACT', getRandom(facts)))
    if (cmd === 'truth') return reply(skContent('❓', 'TRUTH', getRandom(truths)))
    if (cmd === 'dare') return reply(skContent('🔥', 'DARE', getRandom(dares)))
    if (cmd === 'roast') return reply(skContent('💀', 'ROAST', getRandom(roasts)))
    if (cmd === 'compliment') return reply(skContent('💖', 'COMPLIMENT', getRandom(compliments)))
    if (cmd === 'dice') return reply(skBasic('🎲', [['RESULT', String(Math.floor(Math.random() * 6) + 1)]]))
    if (cmd === 'coin') return reply(skBasic('🪙', [['RESULT', Math.random() < 0.5 ? 'HEADS' : 'TAILS']]))
    if (cmd === '8ball') {
        const answers = ['Yes', 'No', 'Maybe', 'Ask later', 'Absolutely', 'Doubtful', 'Good feeling', 'Very doubtful']
        return reply(skContent('🎱', 'ANSWER', getRandom(answers)))
    }
    if (cmd === 'rate') {
        const thing = args.join(' ')
        if (!thing) return reply(skError('Usage: ' + prefix + 'rate <thing>'))
        return reply(skBasic('⭐', [['THING', thing], ['RATING', `${Math.floor(Math.random() * 10) + 1}/10`]]))
    }
    if (cmd === 'ship') {
        if (args.length < 2) return reply(skError('Usage: ' + prefix + 'ship <a> <b>'))
        return reply(skBasic('💕', [['PAIR', `${args[0]} + ${args[1]}`], ['MATCH', `${Math.floor(Math.random() * 100) + 1}%`]]))
    }

    if (cmd === 'calc') {
        if (!args.length) return reply(skError('Usage: ' + prefix + 'calc 2+2*3'))
        try { return reply(skBasic('🧮', [['INPUT', args.join(' ')], ['RESULT', String(safeCalc(args.join(' ')))]])) }
        catch (e) { return reply(skError('Invalid math.')) }
    }

    if (cmd === 'sticker') {
        if (!FFMPEG_AVAILABLE) return reply(skError('Image tools need ffmpeg on the server.'))
        const ci = getContextInfo(content)
        const quoted = ci?.quotedMessage ? unwrapEphemeral(ci.quotedMessage) : null
        if (!quoted || !quoted.imageMessage) return reply(skError('Reply to an image.'))
        const inPath = path.join(os.tmpdir(), `sk_in_${crypto.randomBytes(6).toString('hex')}.jpg`)
        const outPath = path.join(os.tmpdir(), `sk_out_${crypto.randomBytes(6).toString('hex')}.webp`)
        try {
            const buffer = await downloadBuffer(sock, getQuotedKey(sock, from, ci), quoted)
            fs.writeFileSync(inPath, buffer)
            await runFfmpeg([
                '-y', '-i', inPath,
                '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
                outPath
            ])
            const webp = fs.readFileSync(outPath)
            await sock.sendMessage(from, { sticker: webp }, { quoted: msg })
        } catch (e) {
            console.log('.sticker error:', e?.message || e)
            return reply(skError('Failed to create sticker.'))
        } finally {
            try { fs.unlinkSync(inPath) } catch (e) {}
            try { fs.unlinkSync(outPath) } catch (e) {}
        }
        return
    }

    if (cmd === 'toimg') {
        if (!FFMPEG_AVAILABLE) return reply(skError('Image tools need ffmpeg on the server.'))
        const ci = getContextInfo(content)
        const quoted = ci?.quotedMessage ? unwrapEphemeral(ci.quotedMessage) : null
        if (!quoted || !quoted.stickerMessage) return reply(skError('Reply to a sticker.'))
        const inPath = path.join(os.tmpdir(), `sk_in_${crypto.randomBytes(6).toString('hex')}.webp`)
        const outPath = path.join(os.tmpdir(), `sk_out_${crypto.randomBytes(6).toString('hex')}.png`)
        try {
            const buffer = await downloadBuffer(sock, getQuotedKey(sock, from, ci), quoted)
            fs.writeFileSync(inPath, buffer)
            await runFfmpeg(['-y', '-i', inPath, outPath])
            const png = fs.readFileSync(outPath)
            await sock.sendMessage(from, { image: png, caption: 'Sticker converted' }, { quoted: msg })
        } catch (e) {
            console.log('.toimg error:', e?.message || e)
            return reply(skError('Failed to convert sticker.'))
        } finally {
            try { fs.unlinkSync(inPath) } catch (e) {}
            try { fs.unlinkSync(outPath) } catch (e) {}
        }
        return
    }

    if (cmd === 'tt') {
        if (!YTDLP_AVAILABLE) return
        if (isGroup) return reply(skError('.tt only works in private chat.'))
        if (!owner) return reply(skError('Owner only.'))
        const url = args[0]
        if (!url || !isTikTokUrl(url)) return reply(skError('Invalid TikTok URL.'))
        const tnow = Date.now()
        ctx.ttUsage = (ctx.ttUsage || []).filter(t => tnow - t < 3600000)
        if (ctx.ttUsage.length >= 2) return reply(skError('TikTok limit reached. Try later.'))
        ctx.ttUsage.push(tnow)
        await reply(skBasic('📥', [['STATUS', '⏳ DOWNLOADING'], ['SOURCE', 'TikTok']]))
        const outPath = path.join(os.tmpdir(), `tt_${crypto.randomBytes(6).toString('hex')}.mp4`)
        try {
            await runYtDlp(url, outPath)
            if (!fs.existsSync(outPath)) throw new Error('no output')
            if (fs.statSync(outPath).size > 30 * 1024 * 1024) return reply(skError('Video > 30MB.'))
            await sleep(10000)
            const buffer = fs.readFileSync(outPath)
            await sock.sendMessage(from, { video: buffer, caption: 'TikTok download' }, { quoted: msg })
        } catch (e) {
            console.log('.tt error:', e?.message || e)
            return reply(skError('Download failed. Video may be private or yt-dlp not installed.'))
        } finally {
            try { fs.unlinkSync(outPath) } catch (e) {}
        }
        return
    }

    if (cmd === 'warn') {
        if (!(await needManage())) return
        const target = getTarget(content)
        if (!target) return reply(skError('Mention or reply to a user.'))
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
                if (!r.ok) return reply(skError('Could not remove them. Am I admin?'))
                delete ctx.warningCounts[from][key]
                return sock.sendMessage(from, {
                    text: skGroup('🚫', 'KICKED', [
                        ['USER', `@${cleanNumber(target)}`],
                        ['COUNT', `${limit} / ${limit}`]
                    ], sender),
                    mentions: [target]
                })
            } catch (e) { return reply(skError('Failed to kick.')) }
        }
        return sock.sendMessage(from, {
            text: skGroup('⚠️', 'WARN', [
                ['USER', `@${cleanNumber(target)}`],
                ['COUNT', `${count} / ${limit}`]
            ], sender),
            mentions: [target]
        })
    }
    if (cmd === 'warncount') {
        if (!(await needManage())) return
        const num = parseInt(args[0])
        if (!num || num < 1) return reply(skError('Usage: ' + prefix + 'warncount <n>'))
        ctx.warnLimit[from] = num
        saveCtx(ctx)
        return reply(skGroup('⚙️', 'WARN LIMIT', [['LIMIT', String(num)]], sender))
    }
    if (cmd === 'warnlist') {
        if (!(await needManage())) return
        const list = ctx.warningCounts[from] || {}
        const keys = Object.keys(list)
        if (keys.length === 0) return reply(skBasic('📋', [['WARNED', 'none']]))
        const lines = keys.map(k => `• ${cleanNumber(k)} ─→ ${list[k]}`).join('\n')
        return reply(skContent('📋', 'WARN LIST', '\n' + lines))
    }
    if (cmd === 'resetwarn') {
        if (!(await needManage())) return
        const target = getTarget(content)
        if (!target) return reply(skError('Mention or reply to a user.'))
        if (ctx.warningCounts[from]) delete ctx.warningCounts[from][cleanJid(target)]
        return sock.sendMessage(from, {
            text: skGroup('✅', 'RESET WARN', [['USER', `@${cleanNumber(target)}`], ['STATUS', '🟢 CLEARED']], sender),
            mentions: [target]
        })
    }

    const protectCmds = ['antilink', 'antispam', 'antibot', 'antimedia', 'antitag', 'antiforward']
    if (protectCmds.includes(cmd)) {
        if (!(await needManage())) return
        if (!ctx.groupSettings[from]) ctx.groupSettings[from] = {}
        if (args[0] === 'on' || args[0] === 'off') {
            ctx.groupSettings[from][cmd] = args[0] === 'on'
            saveCtx(ctx)
            const emoji = { antilink: '🔗', antispam: '🚫', antibot: '🤖', antimedia: '🖼️', antitag: '🏷️', antiforward: '↪️' }[cmd]
            return reply(skGroup(emoji, cmd.toUpperCase(), [['STATUS', args[0] === 'on' ? '🟢 ENABLED' : '🔴 DISABLED']], sender))
        }
        const cur = ctx.groupSettings[from][cmd] ? '🟢 ON' : '🔴 OFF'
        return reply(skBasic('🛡️', [[cmd.toUpperCase(), cur]]))
    }

    if (cmd === 'lockdown') {
        if (!(await needManage())) return
        if (!ctx.groupSettings[from]) ctx.groupSettings[from] = {}
        const s = ctx.groupSettings[from]
        s.antilink = true; s.antimedia = true; s.antitag = true; s.antiforward = true; s.antispam = true
        saveCtx(ctx)
        try { await sock.groupSettingUpdate(from, 'announcement') } catch (e) {}
        return reply(skGroup('🔒', 'LOCKDOWN', [
            ['ANTILINK', '🟢 ON'], ['ANTISPAM', '🟢 ON'],
            ['ANTIMEDIA', '🟢 ON'], ['ANTITAG', '🟢 ON'],
            ['ANTIFORWARD', '🟢 ON'], ['GROUP MUTE', '🔒 ADMINS ONLY']
        ], sender))
    }
    if (cmd === 'unlockdown') {
        if (!(await needManage())) return
        if (!ctx.groupSettings[from]) ctx.groupSettings[from] = {}
        const s = ctx.groupSettings[from]
        s.antilink = false; s.antimedia = false; s.antitag = false; s.antiforward = false; s.antispam = false
        saveCtx(ctx)
        try { await sock.groupSettingUpdate(from, 'not_announcement') } catch (e) {}
        return reply(skGroup('🔓', 'UNLOCKDOWN', [
            ['ANTILINK', '🔴 OFF'], ['ANTISPAM', '🔴 OFF'],
            ['ANTIMEDIA', '🔴 OFF'], ['ANTITAG', '🔴 OFF'],
            ['ANTIFORWARD', '🔴 OFF'], ['GROUP MUTE', '🟢 EVERYONE']
        ], sender))
    }

    if (cmd === 'kick') {
        if (!(await needManage())) return
        const ci = getContextInfo(content)
        const mentions = [...(ci?.mentionedJid || [])]
        if (ci?.participant && !mentions.includes(ci.participant)) mentions.push(ci.participant)
        if (mentions.length === 0) return reply(skError('Mention or reply to a user.'))
        if (mentions.length > 5) return reply(skError('Max 5 users per kick.'))
        const filtered = []
        for (const t of mentions) {
            if (isBotJid(sock, t)) continue
            if (await checkAdmin(ctx, sock, from, [t])) continue
            filtered.push(t)
        }
        if (filtered.length === 0) return reply(skError('No valid targets (bot/admins excluded).'))
        try {
            const r = await participantsUpdate(sock, from, filtered, 'remove')
            if (!r.ok) return reply(skError('Could not kick. Am I admin?'))
            return sock.sendMessage(from, {
                text: skGroup('👢', 'KICK', [
                    ['USERS', filtered.map(t => '@' + cleanNumber(t)).join(', ')]
                ], sender),
                mentions: filtered
            })
        } catch (e) { return reply(skError('Failed to kick.')) }
    }

    if (cmd === 'add') {
        if (!(await needManage())) return
        const digits = (args[0] || '').replace(/[^0-9]/g, '')
        if (digits.length < 7) return reply(skError('Usage: ' + prefix + 'add <number>'))
        try {
            const r = await participantsUpdate(sock, from, [normalizeJid(digits)], 'add')
            if (r.ok) return reply(skGroup('➕', 'ADD', [['USER', `+${digits}`], ['STATUS', '🟢 ADDED']], sender))
            const st = String(r.res?.[0]?.status)
            if (st === '403') return reply(skError('User only allows adds via link.'))
            if (st === '409') return reply(skError('Already in group.'))
            if (st === '408') return reply(skError('Recently left the group.'))
            return reply(skError('Could not add.'))
        } catch (e) { return reply(skError('Failed to add.')) }
    }

    if (cmd === 'promote' || cmd === 'demote') {
        if (!(await needManage())) return
        const target = getTarget(content)
        if (!target) return reply(skError('Mention or reply to a user.'))
        try {
            const r = await participantsUpdate(sock, from, [target], cmd)
            if (!r.ok) return reply(skError(`Could not ${cmd}. Am I admin?`))
            const newRole = cmd === 'promote' ? '👑 ADMIN' : '👤 MEMBER'
            const emoji = cmd === 'promote' ? '👑' : '⬇️'
            return sock.sendMessage(from, {
                text: skGroup(emoji, cmd.toUpperCase() + 'D', [
                    ['USER', `@${cleanNumber(target)}`],
                    ['ROLE', newRole]
                ], sender),
                mentions: [target]
            })
        } catch (e) { return reply(skError(`Failed to ${cmd}.`)) }
    }

    if (cmd === 'demoteall') {
        if (!(await needManage())) return
        const meta = await getGroupMeta(ctx, sock, from, true)
        const creator = meta.owner || meta.creator || null
        const admins = meta.participants.filter(p => p.admin && p.id !== creator && !isBotJid(sock, p.id))
        if (admins.length === 0) return reply(skBasic('✅', [['ADMINS', 'none to demote']]))
        ctx.pendingConfirm[from] = { action: 'demoteall', by: sender, ts: Date.now(), label: 'DEMOTE ALL', targets: admins.map(a => a.id) }
        return reply(skConfirmBox('DEMOTE ALL ADMINS', sender, `Will demote ${admins.length} admin(s). Creator is exempt.`))
    }

    if (cmd === 'del') {
        if (!(await needManage())) return
        const ci = getContextInfo(content)
        if (!ci?.stanzaId) return reply(skError('Reply to a message to delete it.'))
        try {
            await sock.sendMessage(from, {
                delete: {
                    remoteJid: from,
                    id: ci.stanzaId,
                    participant: ci.participant || undefined,
                    fromMe: false
                }
            })
        } catch (e) { return reply(skError('Could not delete. Am I admin?')) }
        return
    }

    if (cmd === 'left') {
        if (!(await needManage())) return
        try {
            await reply(skBasic('👋', [['STATUS', '🚪 LEAVING GROUP']]))
            await sleep(1500)
            await sock.groupLeave(from)
        } catch (e) { return reply(skError('Failed to leave.')) }
        return
    }

    if (cmd === 'mute' || cmd === 'unmute') {
        if (!(await needManage())) return
        try {
            await sock.groupSettingUpdate(from, cmd === 'mute' ? 'announcement' : 'not_announcement')
            const emoji = cmd === 'mute' ? '🔇' : '🔊'
            const grp = cmd === 'mute' ? '🔒 ADMINS ONLY' : '🟢 EVERYONE'
            return reply(skGroup(emoji, cmd.toUpperCase() + ' GROUP', [['GROUP', grp]], sender))
        } catch (e) { return reply(skError('Failed. Am I admin?')) }
    }

    if (cmd === 'tagall' || cmd === 'hidetag') {
        if (!(await needManage())) return
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            const mentions = meta.participants.map(p => p.id)
            const message = args.join(' ') || 'Attention everyone!'
            if (cmd === 'hidetag') {
                return sock.sendMessage(from, { text: message, mentions })
            }
            const lines = ['*Tag All*', '', message, '']
            mentions.forEach(jid => { lines.push(`@${cleanNumber(jid)}`) })
            return sock.sendMessage(from, { text: lines.join('\n'), mentions })
        } catch (e) { return reply(skError('Failed to fetch members.')) }
    }

    if (cmd === 'pin') {
        if (!(await needManage())) return
        const ci = getContextInfo(content)
        if (!ci?.stanzaId) return reply(skError('Reply to a message to pin it.'))
        try {
            await sock.sendMessage(from, { pin: { remoteJid: from, id: ci.stanzaId, fromMe: false, participant: ci.participant } })
            return reply(skBasic('📌', [['STATUS', '🟢 PINNED']]))
        } catch (e) { return reply(skError('Pin not supported by this Baileys version.')) }
    }

    if (cmd === 'groupinfo') {
        if (!(await needGroup())) return
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            return reply(skInfo('📊', 'GROUP INFO', [
                ['NAME', meta.subject],
                ['ID', meta.id],
                ['MEMBERS', String(meta.participants.length)],
                ['ADMINS', String(meta.participants.filter(p => p.admin).length)],
                ['CREATOR', cleanNumber(meta.owner || 'unknown')]
            ]))
        } catch (e) { return reply(skError('Failed to fetch group info.')) }
    }

    if (cmd === 'groupdesc') {
        if (!(await needGroup())) return
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            return reply(skContent('📝', 'GROUP DESC', meta.desc || '(empty)'))
        } catch (e) { return reply(skError('Failed to fetch description.')) }
    }

    if (cmd === 'link') {
        if (!(await needManage())) return
        try {
            const code = await sock.groupInviteCode(from)
            return reply(skInfo('🔗', 'GROUP LINK', [['GROUP', (await getGroupMeta(ctx, sock, from)).subject], ['LINK', `https://chat.whatsapp.com/${code}`]]))
        } catch (e) { return reply(skError('Failed. Am I admin?')) }
    }

    if (cmd === 'revoke') {
        if (!(await needManage())) return
        try {
            await sock.groupRevokeInvite(from)
            return reply(skGroup('🔐', 'REVOKE LINK', [['STATUS', '🟢 NEW LINK GENERATED']], sender))
        } catch (e) { return reply(skError('Failed. Am I admin?')) }
    }

    if (cmd === 'admins') {
        if (!(await needGroup())) return
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            const admins = meta.participants.filter(p => p.admin)
            const lines = admins.map(a => `• ${cleanNumber(a.id)}`).join('\n')
            return reply(skContent('👑', 'GROUP ADMINS', '\n' + lines))
        } catch (e) { return reply(skError('Failed to fetch admins.')) }
    }

    if (cmd === 'members') {
        if (!(await needGroup())) return
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            const lines = meta.participants.map(p => `• ${cleanNumber(p.id)}`).join('\n')
            return reply(skContent('👥', `MEMBERS (${meta.participants.length})`, '\n' + lines))
        } catch (e) { return reply(skError('Failed to fetch members.')) }
    }

    if (cmd === 'grouplist') {
        try {
            const all = await sock.groupFetchAllParticipating()
            const entries = Object.values(all).map(g => `• ${g.subject} ─→ ${cleanNumber(g.id)}`)
            if (entries.length === 0) return reply(skBasic('📡', [['GROUPS', 'none']]))
            return reply(skContent('📡', `GROUPS (${entries.length})`, '\n' + entries.join('\n')))
        } catch (e) { return reply(skError('Failed to fetch groups.')) }
    }

    if (cmd === 'topmembers') {
        if (!(await needGroup())) return
        try {
            const act = (ctx.activity && ctx.activity[from]) || {}
            const entries = Object.entries(act).sort((a, b) => (b[1].count || 0) - (a[1].count || 0)).slice(0, 10)
            if (entries.length === 0) return reply(skBasic('📊', [['ACTIVITY', 'no data yet']]))
            const lines = entries.map(([jid, v]) => `• ${cleanNumber(jid)} ─→ ${v.count || 0}`).join('\n')
            return reply(skContent('📊', 'TOP MEMBERS', '\n' + lines))
        } catch (e) { return reply(skError('Failed to compute.')) }
    }

    if (cmd === 'kickinactive') {
        if (!(await needManage())) return
        const days = parseInt(args[0]) || 30
        if (days < 1 || days > 365) return reply(skError('Days must be 1-365.'))
        ctx.pendingKickDays = days
        ctx.pendingConfirm[from] = { action: 'kickinactive', by: sender, ts: Date.now(), label: 'KICK INACTIVE' }
        return reply(skConfirmBox(`KICK INACTIVE (${days} days)`, sender, 'Will kick members idle for that period.'))
    }

    if (cmd === 'requests') {
        if (!(await needManage())) return
        try {
            const list = await sock.groupRequestParticipantsList(from)
            if (!list || list.length === 0) return reply(skBasic('📋', [['REQUESTS', 'none']]))
            const lines = list.map(r => `• ${cleanNumber(r.jid)}`).join('\n')
            return reply(skContent('📋', `JOIN REQUESTS (${list.length})`, '\n' + lines))
        } catch (e) { return reply(skError('Failed to fetch requests.')) }
    }
    if (cmd === 'approveall') {
        if (!(await needManage())) return
        try {
            const list = await sock.groupRequestParticipantsList(from)
            if (!list || list.length === 0) return reply(skBasic('✅', [['REQUESTS', 'none']]))
            const jids = list.map(r => r.jid)
            await sock.groupRequestParticipantsUpdate(from, jids, 'approve')
            return reply(skGroup('✅', 'APPROVE ALL', [['COUNT', String(jids.length)]], sender))
        } catch (e) { return reply(skError('Failed to approve.')) }
    }
    if (cmd === 'rejectall') {
        if (!(await needManage())) return
        try {
            const list = await sock.groupRequestParticipantsList(from)
            if (!list || list.length === 0) return reply(skBasic('❌', [['REQUESTS', 'none']]))
            const jids = list.map(r => r.jid)
            await sock.groupRequestParticipantsUpdate(from, jids, 'reject')
            return reply(skGroup('❌', 'REJECT ALL', [['COUNT', String(jids.length)]], sender))
        } catch (e) { return reply(skError('Failed to reject.')) }
    }

    if (cmd === 'setname') {
        if (!(await needManage())) return
        const txt = args.join(' ')
        if (!txt) return reply(skError('Usage: ' + prefix + 'setname <name>'))
        try {
            await sock.groupUpdateSubject(from, txt)
            return reply(skGroup('📝', 'NAME CHANGED', [['NEW NAME', txt]], sender))
        } catch (e) { return reply(skError('Failed. Am I admin?')) }
    }
    if (cmd === 'setdesc') {
        if (!(await needManage())) return
        const txt = args.join(' ')
        if (!txt) return reply(skError('Usage: ' + prefix + 'setdesc <text>'))
        try {
            await sock.groupUpdateDescription(from, txt)
            return reply(skGroup('📝', 'DESC UPDATED', [['STATUS', '🟢 SAVED']], sender))
        } catch (e) { return reply(skError('Failed. Am I admin?')) }
    }

    if (cmd === 'welcome' || cmd === 'goodbye') {
        if (!(await needManage())) return
        if (!ctx.welcomeSettings[from]) ctx.welcomeSettings[from] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
        if (args[0] === 'on' || args[0] === 'off') {
            ctx.welcomeSettings[from][cmd] = args[0] === 'on'
            saveCtx(ctx)
            const emoji = cmd === 'welcome' ? '🎉' : '👋'
            return reply(skGroup(emoji, cmd.toUpperCase(), [['STATUS', args[0] === 'on' ? '🟢 ENABLED' : '🔴 DISABLED']], sender))
        }
        const cur = ctx.welcomeSettings[from][cmd] ? '🟢 ON' : '🔴 OFF'
        return reply(skBasic('⚙️', [[cmd.toUpperCase(), cur]]))
    }
    if (cmd === 'setwelcome' || cmd === 'setgoodbye') {
        if (!(await needManage())) return
        const txt = args.join(' ')
        if (!txt) return reply(skError('Usage: ' + prefix + cmd + ' <text>'))
        if (!ctx.welcomeSettings[from]) ctx.welcomeSettings[from] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
        ctx.welcomeSettings[from][cmd === 'setwelcome' ? 'welcomeMsg' : 'goodbyeMsg'] = txt
        saveCtx(ctx)
        return reply(skGroup('📝', 'SET MESSAGE', [['TYPE', cmd.toUpperCase().replace('SET', '')], ['STATUS', '🟢 SAVED']], sender))
    }

    if (cmd === 'promotenotify' || cmd === 'demotenotify') {
        if (!(await needManage())) return
        if (!ctx.welcomeSettings[from]) ctx.welcomeSettings[from] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '', promote: false, demote: false }
        const key = cmd === 'promotenotify' ? 'promote' : 'demote'
        if (args[0] === 'on' || args[0] === 'off') {
            ctx.welcomeSettings[from][key] = args[0] === 'on'
            saveCtx(ctx)
            const emoji = key === 'promote' ? '👑' : '⬇️'
            return reply(skGroup(emoji, cmd.toUpperCase(), [['STATUS', args[0] === 'on' ? '🟢 ENABLED' : '🔴 DISABLED']], sender))
        }
        const cur = ctx.welcomeSettings[from][key] ? '🟢 ON' : '🔴 OFF'
        return reply(skBasic('⚙️', [[cmd.toUpperCase(), cur]]))
    }

    if (cmd === 'poll') {
        if (!(await needGroup())) return
        const parts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean)
        if (parts.length < 3) return reply(skError('Usage: ' + prefix + 'poll Q | Opt1 | Opt2'))
        const [question, ...options] = parts
        ctx.activePolls[from] = { question, options, votes: {} }
        const optLines = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')
        return reply(skContent('📊', 'POLL', `${question}\n\n${optLines}\n\nVote with ${prefix}vote <n>`))
    }
    if (cmd === 'vote') {
        if (!ctx.activePolls[from]) return reply(skError('No active poll.'))
        const num = parseInt(args[0]) - 1
        if (isNaN(num) || num < 0 || num >= ctx.activePolls[from].options.length) return reply(skError('Invalid vote.'))
        ctx.activePolls[from].votes[cleanJid(sender)] = num
        return reply(skBasic('🗳️', [['VOTED', ctx.activePolls[from].options[num]]]))
    }
    if (cmd === 'endpoll') {
        if (!(await needManage())) return
        if (!ctx.activePolls[from]) return reply(skError('No active poll.'))
        const poll = ctx.activePolls[from]
        const tally = {}
        poll.options.forEach((_, i) => { tally[i] = 0 })
        Object.values(poll.votes).forEach(v => { tally[v]++ })
        const lines = poll.options.map((opt, i) => `${opt}: ${tally[i]}`).join('\n')
        delete ctx.activePolls[from]
        return reply(skContent('📊', 'POLL RESULTS', `${poll.question}\n\n${lines}`))
    }

    return
}

async function executeConfirmed(sock, ctx, msg, content, from, isGroup, sender, senderNumber, owner, action) {
    if (!isGroup) return
    if (action === 'demoteall') {
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            const creator = meta.owner || meta.creator || null
            const admins = meta.participants.filter(p => p.admin && p.id !== creator && !isBotJid(sock, p.id))
            if (admins.length === 0) return
            const jids = admins.map(a => a.id)
            await sock.groupParticipantsUpdate(from, jids, 'demote')
            await sock.sendMessage(from, {
                text: skGroup('⬇️', 'DEMOTE ALL', [
                    ['ADMINS DEMOTED', String(jids.length)],
                    ['EXEMPT', '👑 CREATOR']
                ], sender),
                mentions: jids
            })
        } catch (e) {
            console.log('demoteall error:', e?.message || e)
            try { await sock.sendMessage(from, { text: skError('Failed to demote.') }) } catch (e2) {}
        }
        return
    }
    if (action === 'kickinactive') {
        try {
            const meta = await getGroupMeta(ctx, sock, from, true)
            const creator = meta.owner || meta.creator || null
            const days = ctx.pendingKickDays || 30
            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
            const act = (ctx.activity && ctx.activity[from]) || {}
            const inactive = meta.participants.filter(p => {
                if (p.id === creator) return false
                if (isBotJid(sock, p.id)) return false
                if (p.admin) return false
                const last = act[cleanJid(p.id)]?.last || 0
                return last < cutoff
            }).map(p => p.id)
            if (inactive.length === 0) {
                return sock.sendMessage(from, { text: skBasic('✅', [['INACTIVE', 'none found']]) })
            }
            await sock.groupParticipantsUpdate(from, inactive, 'remove')
            await sock.sendMessage(from, {
                text: skGroup('👢', 'KICK INACTIVE', [
                    ['DAYS', String(days)],
                    ['KICKED', String(inactive.length)]
                ], sender),
                mentions: inactive
            })
        } catch (e) {
            console.log('kickinactive error:', e?.message || e)
            try { await sock.sendMessage(from, { text: skError('Failed to kick inactive.') }) } catch (e2) {}
        }
        return
    }
}// ─────────────────────────── menu ───────────────────────────
function renderGroupCommandsBox(p) {
    return (
        `╭━〔 👥 *GROUP COMMANDS* 〕━╮\n` +
        `\n` +
        `  🛡️ *PROTECTION*\n` +
        `  ▸ ${p}antilink ─→ Block links\n` +
        `  ▸ ${p}antispam ─→ Block spam\n` +
        `  ▸ ${p}antibot ─→ Remove bots\n` +
        `  ▸ ${p}antimedia ─→ Block media\n` +
        `  ▸ ${p}antitag ─→ Block mass tags\n` +
        `  ▸ ${p}antiforward ─→ Block forwarded\n` +
        `  ▸ ${p}lockdown ─→ Lock everything\n` +
        `  ▸ ${p}unlockdown ─→ Unlock everything\n` +
        `\n` +
        `  👤 *MEMBERS*\n` +
        `  ▸ ${p}kick ─→ Remove user(s)\n` +
        `  ▸ ${p}add ─→ Add user\n` +
        `  ▸ ${p}promote ─→ Make admin\n` +
        `  ▸ ${p}demote ─→ Remove admin\n` +
        `  ▸ ${p}demoteall ─→ Demote all admins\n` +
        `  ▸ ${p}mute ─→ Lock chat\n` +
        `  ▸ ${p}unmute ─→ Unlock chat\n` +
        `  ▸ ${p}del ─→ Delete a message\n` +
        `  ▸ ${p}left ─→ Bot leaves group\n` +
        `  ▸ ${p}topmembers ─→ Most active\n` +
        `  ▸ ${p}kickinactive ─→ Kick idle\n` +
        `\n` +
        `  📢 *COMMUNICATION*\n` +
        `  ▸ ${p}tagall ─→ Tag everyone\n` +
        `  ▸ ${p}hidetag ─→ Silent tag\n` +
        `  ▸ ${p}pin ─→ Pin replied msg\n` +
        `\n` +
        `  📊 *INFO*\n` +
        `  ▸ ${p}groupinfo ─→ Group details\n` +
        `  ▸ ${p}groupdesc ─→ Group desc\n` +
        `  ▸ ${p}link ─→ Invite link\n` +
        `  ▸ ${p}revoke ─→ Reset link\n` +
        `  ▸ ${p}admins ─→ List admins\n` +
        `  ▸ ${p}members ─→ List members\n` +
        `  ▸ ${p}grouplist ─→ All groups\n` +
        `\n` +
        `  🚪 *JOIN REQUESTS*\n` +
        `  ▸ ${p}requests ─→ Pending list\n` +
        `  ▸ ${p}approveall ─→ Approve all\n` +
        `  ▸ ${p}rejectall ─→ Reject all\n` +
        `\n` +
        `  ⚙️ *SETTINGS*\n` +
        `  ▸ ${p}setname ─→ Change name\n` +
        `  ▸ ${p}setdesc ─→ Change desc\n` +
        `\n` +
        `  🎉 *WELCOME*\n` +
        `  ▸ ${p}welcome ─→ Toggle welcome\n` +
        `  ▸ ${p}goodbye ─→ Toggle goodbye\n` +
        `  ▸ ${p}setwelcome ─→ Set welcome\n` +
        `  ▸ ${p}setgoodbye ─→ Set goodbye\n` +
        `  ▸ ${p}promotenotify ─→ Toggle promote msg\n` +
        `  ▸ ${p}demotenotify ─→ Toggle demote msg\n` +
        `\n` +
        `  ⚠️ *WARN*\n` +
        `  ▸ ${p}warn ─→ Warn a user\n` +
        `  ▸ ${p}warncount ─→ Set limit\n` +
        `  ▸ ${p}warnlist ─→ List warned\n` +
        `  ▸ ${p}resetwarn ─→ Clear warnings\n` +
        `\n` +
        `  📊 *POLLS*\n` +
        `  ▸ ${p}poll ─→ Create poll\n` +
        `  ▸ ${p}vote ─→ Vote\n` +
        `  ▸ ${p}endpoll ─→ End poll\n` +
        `\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`
    )
}

function renderMenu(ctx, sock) {
    const p = ctx.cfg.prefix
    const d = new Date()
    const dateStr = d.toLocaleDateString('en-US', { timeZone: TIMEZONE })
    const timeStr = d.toLocaleTimeString('en-US', { timeZone: TIMEZONE })
    return (
        `╭━〔 𖤐 *SUKUNA REALM* 〕━╮\n` +
        `\n` +
        `▸ OWNER ─→ ${ownerName(sock)}\n` +
        `▸ MODE ─→ ${ctx.cfg.mode}\n` +
        `▸ PREFIX ─→ ${p}\n` +
        `▸ DATE ─→ ${dateStr}\n` +
        `▸ TIME ─→ ${timeStr}\n` +
        `▸ UPTIME ─→ ${formatUptime(process.uptime())}\n` +
        `▸ SESSIONS ─→ ${Object.keys(sessions).length}\n` +
        `\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `\n` +
        `╭━〔 ⚡ *BASIC* 〕━╮\n` +
        `▸ ${p}ping ─→ Check status\n` +
        `▸ ${p}alive ─→ Say hi\n` +
        `▸ ${p}time ─→ Date + time\n` +
        `▸ ${p}info ─→ Bot info\n` +
        `▸ ${p}menu ─→ This menu\n` +
        `▸ ${p}mode ─→ public/private\n` +
        `▸ ${p}prefix ─→ Change prefix\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `\n` +
        `╭━〔 🎉 *FUN* 〕━╮\n` +
        `▸ ${p}joke ─→ Random joke\n` +
        `▸ ${p}quote ─→ Motivation\n` +
        `▸ ${p}fact ─→ Fun fact\n` +
        `▸ ${p}dice ─→ Roll a dice\n` +
        `▸ ${p}coin ─→ Flip a coin\n` +
        `▸ ${p}truth ─→ Truth question\n` +
        `▸ ${p}dare ─→ Dare challenge\n` +
        `▸ ${p}roast ─→ Roast someone\n` +
        `▸ ${p}compliment ─→ Compliment\n` +
        `▸ ${p}8ball ─→ Magic 8-ball\n` +
        `▸ ${p}rate ─→ Rate a thing\n` +
        `▸ ${p}ship ─→ Compatibility\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `\n` +
        renderGroupCommandsBox(p) +
        `\n\n` +
        `╭━〔 ⚙️ *OWNER SETTINGS* 〕━╮\n` +
        `▸ ${p}typing ─→ Typing toggle\n` +
        `▸ ${p}delay ─→ Delay toggle\n` +
        `▸ ${p}read ─→ Read toggle\n` +
        `▸ ${p}online ─→ Online toggle\n` +
        `▸ ${p}statusview ─→ View statuses\n` +
        `▸ ${p}autoreact ─→ Auto react\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `\n` +
        `╭━〔 🛠️ *UTILITY* 〕━╮\n` +
        `▸ ${p}calc ─→ Calculate math\n` +
        `▸ ${p}sticker ─→ Make sticker\n` +
        `▸ ${p}toimg ─→ Sticker to image\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `\n` +
        `╭━〔 📥 *DOWNLOADER* 〕━╮\n` +
        `▸ ${p}tt <url> ─→ TikTok (owner)\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `\n` +
        `        ⟡ *SUKUNA REALM* ⟡`
    )
}// ─────────────────────────── web dashboard ───────────────────────────
function checkAuth(header) {
    try {
        const b64 = header.split(' ')[1]
        const decoded = Buffer.from(b64, 'base64').toString()
        const pass = decoded.slice(decoded.indexOf(':') + 1)
        const a = crypto.createHash('sha256').update(pass).digest()
        const b = crypto.createHash('sha256').update(DASHBOARD_PASSWORD).digest()
        return crypto.timingSafeEqual(a, b)
    } catch (e) { return false }
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
                if (size > 5 * 1024 * 1024) { aborted = true; res.writeHead(413); res.end('Too large'); req.destroy(); return }
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
                                let imgData = part.slice(headerEnd + 4).replace(/\r\n$/, '')
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
            } else { res.writeHead(404); res.end('No logo') }
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

// ─────────────────────────── tiktok downloader ───────────────────────────
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
    } catch (e) { return false }
}

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
    f.method = 'POST'; f.action = '/dashboard'; f.style.display = 'inline';
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
        pairDiv.innerHTML = ''; list.innerHTML = '';
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
    } catch (e) { console.log('Refresh error:', e); }
}
function copyCode(code) {
    navigator.clipboard.writeText(code).then(function () { alert('Copied: ' + code); })
    .catch(function () {
        var ta = document.createElement('textarea'); ta.value = code;
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        alert('Copied: ' + code);
    });
}
refreshSessions();
</script>

</body></html>`
}

// ─────────────────────────── telegram control bot ───────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ''
const TELEGRAM_ALLOWED_USER_ID = 7959585602
let tgBot = null
const tgPending = new Map()

function tgAuth(id) { return Number(id) === TELEGRAM_ALLOWED_USER_ID }

function tgMainKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔗 Connect', callback_data: 'connect' }, { text: '📊 Status', callback_data: 'status' }],
            [{ text: '📋 Sessions', callback_data: 'sessions' }, { text: '🔄 Reconnect', callback_data: 'reconnect' }],
            [{ text: '❌ Disconnect', callback_data: 'disconnect' }, { text: '📂 Menu', callback_data: 'wa_menu' }]
        ]
    }
}
function tgBackKeyboard() {
    return { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu' }]] }
}

async function tgEditOrSend(chatId, messageId, text, keyboard, parseMode = 'Markdown') {
    const opts = { reply_markup: keyboard }
    if (parseMode) opts.parse_mode = parseMode
    if (messageId) {
        try { await tgBot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId }); return } catch (e) {}
    }
    try { await tgBot.sendMessage(chatId, text, opts) }
    catch (e) {
        try { await tgBot.sendMessage(chatId, text, { reply_markup: keyboard }) }
        catch (e2) { console.log('[TELEGRAM] send failed:', e2?.message || e2) }
    }
}

async function tgShowMenu(chatId, messageId) {
    const text =
        `╭━〔 𖤐 *SUKUNA REALM* 〕━╮\n` +
        `\n` +
        `       ⚡ *CONTROL PANEL*\n` +
        `\n` +
        `▸ Select an option below\n` +
        `▸ to manage sessions.\n` +
        `\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `\n` +
        `        ⟡ *SUKUNA REALM* ⟡`
    await tgEditOrSend(chatId, messageId, text, tgMainKeyboard())
}

async function tgShowStatus(chatId, messageId) {
    const list = Object.values(sessions)
    let text
    if (list.length === 0) {
        text =
            `╭━〔 📊 *SUKUNA REALM* 〕━╮\n\n` +
            `       📊 *STATUS*\n\n` +
            `◈ *SESSIONS*\n` +
            `└─ none connected\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `        ⟡ *SUKUNA REALM* ⟡`
    } else {
        const active = list.filter(s => s.status === 'active')
        const lines = list.map(s =>
            `◈ *${s.number}*\n└─ ${s.status === 'active' ? '🟢 ACTIVE' : s.status === 'connecting' ? '🟡 CONNECTING' : s.status === 'reconnecting' ? '🟠 RECONNECTING' : '🔴 OFFLINE'}`
        ).join('\n\n')
        text =
            `╭━〔 📊 *SUKUNA REALM* 〕━╮\n\n` +
            `       📊 *STATUS*\n\n` +
            `◈ *TOTAL*\n` +
            `└─ ${active.length} / ${list.length} active\n\n` +
            `${lines}\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `        ⟡ *SUKUNA REALM* ⟡`
    }
    await tgEditOrSend(chatId, messageId, text, tgBackKeyboard())
}

async function tgShowSessions(chatId, messageId) {
    const entries = Object.entries(sessions)
    let text
    if (entries.length === 0) {
        text =
            `╭━〔 📋 *SUKUNA REALM* 〕━╮\n\n` +
            `       📋 *SESSIONS*\n\n` +
            `◈ *LIST*\n└─ empty\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `        ⟡ *SUKUNA REALM* ⟡`
    } else {
        const blocks = entries.map(([, s]) =>
            `◈ *${s.number}*\n` +
            `├─ STATUS\n│  └─ ${s.status}\n` +
            `├─ MODE\n│  └─ ${s.ctx?.cfg?.mode || '-'}\n` +
            `└─ SINCE\n   └─ ${s.connectedAt ? new Date(s.connectedAt).toLocaleString() : '-'}`
        ).join('\n\n')
        text =
            `╭━〔 📋 *SUKUNA REALM* 〕━╮\n\n` +
            `       📋 *SESSIONS*\n\n` +
            `${blocks}\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `        ⟡ *SUKUNA REALM* ⟡`
    }
    await tgEditOrSend(chatId, messageId, text, tgBackKeyboard())
}

async function tgShowReconnectList(chatId, messageId) {
    const ids = Object.keys(sessions)
    if (ids.length === 0) {
        await tgEditOrSend(chatId, messageId,
            `╭━〔 🔄 *SUKUNA REALM* 〕━╮\n\n` +
            `      🔄 *RECONNECT*\n\n` +
            `◈ *SESSIONS*\n└─ none\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            tgBackKeyboard())
        return
    }
    const rows = ids.map(id => [{ text: `🔄 ${sessions[id].number} (${sessions[id].status})`, callback_data: `reconnect:${id}` }])
    rows.push([{ text: '🔙 Back to Menu', callback_data: 'menu' }])
    await tgEditOrSend(chatId, messageId,
        `╭━〔 🔄 *SUKUNA REALM* 〕━╮\n\n` +
        `      🔄 *RECONNECT*\n\n` +
        `◈ *SELECT A SESSION*\n\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
        { inline_keyboard: rows })
}

async function tgShowDisconnectList(chatId, messageId) {
    const ids = Object.keys(sessions)
    if (ids.length === 0) {
        await tgEditOrSend(chatId, messageId,
            `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
            `     ❌ *DISCONNECT*\n\n` +
            `◈ *SESSIONS*\n└─ none\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            tgBackKeyboard())
        return
    }
    const rows = ids.map(id => [{ text: `❌ ${sessions[id].number} (${sessions[id].status})`, callback_data: `disconnect:${id}` }])
    rows.push([{ text: '🔙 Back to Menu', callback_data: 'menu' }])
    await tgEditOrSend(chatId, messageId,
        `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
        `     ❌ *DISCONNECT*\n\n` +
        `◈ *SELECT A SESSION*\n\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
        { inline_keyboard: rows })
}

async function tgShowWaMenu(chatId, messageId) {
    const active = Object.values(sessions).find(s => s.status === 'active' && s.sock && s.ctx)
    if (!active) {
        await tgEditOrSend(chatId, messageId,
            `╭━〔 ⚠️ *SUKUNA REALM* 〕━╮\n\n` +
            `       ⚠️ *NOTICE*\n\n` +
            `◈ *STATUS*\n└─ ❌ No active WhatsApp\n     session yet\n\n` +
            `⚡ Connect one first.\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            tgBackKeyboard())
        return
    }
    const menuText = renderMenu(active.ctx, active.sock)
    const wrapped = `╭━〔 𖤐 *SUKUNA REALM* 〕━╮\n\n▸ WHATSAPP MENU\n\n${menuText}\n\n╰━━━━━━━━━━━━━━━━━━━━━━━━╯`
    await tgEditOrSend(chatId, messageId, wrapped, tgBackKeyboard())
}

async function tgPollPairingCode(sessionId, gen, timeoutMs = 15000, intervalMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const s = sessions[sessionId]
        if (!s || s.gen !== gen) return null
        if (s.pairingCode) return s.pairingCode
        if (s.status === 'active') return null
        await sleep(intervalMs)
    }
    return null
}

async function tgConnectNumber(chatId, rawNumber) {
    const cleanNum = String(rawNumber || '').replace(/[^0-9]/g, '')
    if (cleanNum.length < 7) {
        await tgBot.sendMessage(chatId,
            `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
            `       ❌ *INVALID*\n\n` +
            `▸ Send digits only,\n▸ with country code.\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        return
    }
    const sessionId = 'sess_' + cleanNum
    try {
        const existing = sessions[sessionId]
        if (existing?.status === 'active') {
            await tgBot.sendMessage(chatId,
                `╭━〔 ✅ *SUKUNA REALM* 〕━╮\n\n` +
                `       ✅ *ONLINE*\n\n` +
                `◈ *NUMBER*\n└─ ${cleanNum}\n\n` +
                `◈ *STATUS*\n└─ 🟢 ALREADY ACTIVE\n\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
            return
        }
        if (!existing) await startSession(sessionId, cleanNum)
        else if (existing.status === 'logged out') { stopSocket(sessionId); await startSession(sessionId, cleanNum, true) }

        const gen = sessions[sessionId]?.gen
        await tgBot.sendMessage(chatId,
            `╭━〔 ⚡ *SUKUNA REALM* 〕━╮\n\n` +
            `      ⚡ *CONNECTING*\n\n` +
            `◈ *NUMBER*\n└─ ${cleanNum}\n\n` +
            `◈ *STATUS*\n└─ 🟡 WAITING\n\n` +
            `🔐 Preparing pairing code.\n   Please wait...\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: 'Markdown' })

        const code = await tgPollPairingCode(sessionId, gen)
        const s = sessions[sessionId]
        if (code) {
            await tgBot.sendMessage(chatId,
                `╭━〔 🔗 *SUKUNA REALM* 〕━╮\n\n` +
                `       🔗 *PAIRING*\n\n` +
                `◈ *NUMBER*\n└─ ${cleanNum}\n\n` +
                `🔑 *CODE*\n└─ \`${code}\`\n\n` +
                `⚡ WhatsApp →\n   Linked Devices →\n   Link with phone number.\n\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        } else if (s?.status === 'active') {
            await tgBot.sendMessage(chatId,
                `╭━〔 ✅ *SUKUNA REALM* 〕━╮\n\n` +
                `       ✅ *ONLINE*\n\n` +
                `◈ *NUMBER*\n└─ ${cleanNum}\n\n` +
                `◈ *STATUS*\n└─ 🟢 CONNECTED\n\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        } else {
            await tgBot.sendMessage(chatId,
                `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
                `       ❌ *TIMEOUT*\n\n` +
                `◈ *NUMBER*\n└─ ${cleanNum}\n\n` +
                `◈ *STATUS*\n└─ 🔴 FAILED\n\n` +
                `⚡ Try /reconnect ${cleanNum}\n\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        }
    } catch (e) {
        console.log('[TELEGRAM] connect error:', e?.message || e)
        await tgBot.sendMessage(chatId,
            `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
            `       ❌ *FAILED*\n\n` +
            `▸ ${(e?.message || 'unknown error').slice(0, 80)}\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
    }
}

async function tgReconnectSession(chatId, sessionId) {
    const existing = sessions[sessionId]
    if (!existing) {
        await tgBot.sendMessage(chatId,
            `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
            `    ❌ *NOT FOUND*\n\n` +
            `▸ Session does not exist.\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        return
    }
    const number = existing.number
    const now = Date.now()
    if (reconnectCooldown[sessionId] && now - reconnectCooldown[sessionId] < 30000) {
        await tgBot.sendMessage(chatId,
            `╭━〔 ⚠️ *SUKUNA REALM* 〕━╮\n\n` +
            `       ⚠️ *SLOW DOWN*\n\n` +
            `▸ Please wait before\n▸ reconnecting again.\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
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
        await tgBot.sendMessage(chatId,
            `╭━〔 🔄 *SUKUNA REALM* 〕━╮\n\n` +
            `     🔄 *RECONNECTING*\n\n` +
            `◈ *NUMBER*\n└─ ${number}\n\n` +
            `◈ *STATUS*\n└─ 🟡 WAITING\n\n` +
            `⚡ If a code is required,\n   it will appear next.\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: 'Markdown' })
        const code = await tgPollPairingCode(sessionId, gen)
        const s = sessions[sessionId]
        if (code) {
            await tgBot.sendMessage(chatId,
                `╭━〔 🔗 *SUKUNA REALM* 〕━╮\n\n` +
                `      🔗 *PAIRING*\n\n` +
                `◈ *NUMBER*\n└─ ${number}\n\n` +
                `🔑 *CODE*\n└─ \`${code}\`\n\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        } else if (s?.status === 'active') {
            await tgBot.sendMessage(chatId,
                `╭━〔 ✅ *SUKUNA REALM* 〕━╮\n\n` +
                `       ✅ *ONLINE*\n\n` +
                `◈ *NUMBER*\n└─ ${number}\n\n` +
                `◈ *STATUS*\n└─ 🟢 CONNECTED\n\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        } else {
            await tgBot.sendMessage(chatId,
                `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
                `       ❌ *TIMEOUT*\n\n` +
                `◈ *NUMBER*\n└─ ${number}\n\n` +
                `⚡ Try /reconnect again\n\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        }
    } catch (e) {
        console.log('[TELEGRAM] reconnect error:', e?.message || e)
        await tgBot.sendMessage(chatId,
            `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
            `    ❌ *RECONNECT FAILED*\n\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
    }
}

async function tgDisconnectSession(chatId, sessionId) {
    const existing = sessions[sessionId]
    if (!existing) {
        await tgBot.sendMessage(chatId,
            `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
            `    ❌ *NOT FOUND*\n\n╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
        return
    }
    const number = existing.number
    try { await existing.sock.logout() } catch (e) {}
    stopSocket(sessionId)
    delete sessions[sessionId]
    try { fs.rmSync(path.join(SESSION_DIR, sessionId), { recursive: true, force: true }) } catch (e) {}
    await deleteSessionFromMongo(sessionId)
    await tgBot.sendMessage(chatId,
        `╭━〔 ❌ *SUKUNA REALM* 〕━╮\n\n` +
        `     ❌ *DISCONNECTED*\n\n` +
        `◈ *NUMBER*\n└─ ${number}\n\n` +
        `◈ *STATUS*\n└─ ⚫ OFFLINE\n\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
        { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
}

function tgHelpText() {
    return (
        `╭━〔 ⚡ *SUKUNA REALM* 〕━╮\n\n` +
        `      ⚡ *COMMANDS*\n\n` +
        `▸ /start ─→ Main menu\n` +
        `▸ /connect <n> ─→ Link\n` +
        `▸ /status ─→ Sessions\n` +
        `▸ /sessions ─→ List all\n` +
        `▸ /reconnect <n> ─→ Retry\n` +
        `▸ /disconnect <n> ─→ Unlink\n` +
        `▸ /menu ─→ Panel\n` +
        `▸ /help ─→ This\n\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `        ⟡ *SUKUNA REALM* ⟡`
    )
}

function initTelegram() {
    if (!TELEGRAM_TOKEN) { console.log('[TELEGRAM] TELEGRAM_TOKEN not set. Skipping.'); return }
    let TelegramBot
    try { TelegramBot = require('node-telegram-bot-api') }
    catch (e) { console.log('[TELEGRAM] node-telegram-bot-api not found. Run: npm install node-telegram-bot-api'); return }
    try { tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true }) }
    catch (e) { console.log('[TELEGRAM] Failed to start bot:', e?.message || e); return }

    let tgPollErrorCount = 0
    let tgLastPollError = ''
    tgBot.on('polling_error', (e) => {
        const errMsg = e?.message || String(e)
        console.log('[TELEGRAM] Polling error:', errMsg)
        if (errMsg === tgLastPollError) tgPollErrorCount++
        else { tgLastPollError = errMsg; tgPollErrorCount = 1 }
        if (tgPollErrorCount === 3) {
            console.log('[TELEGRAM] Polling failed 3x. TELEGRAM_TOKEN may be invalid.')
        }
    })

    tgBot.onText(/^\/start\b/, async (msg) => { if (!tgAuth(msg.from.id)) return; tgPending.delete(msg.chat.id); await tgShowMenu(msg.chat.id) })
    tgBot.onText(/^\/menu\b/, async (msg) => { if (!tgAuth(msg.from.id)) return; tgPending.delete(msg.chat.id); await tgShowMenu(msg.chat.id) })
    tgBot.onText(/^\/help\b/, async (msg) => { if (!tgAuth(msg.from.id)) return; tgPending.delete(msg.chat.id); await tgBot.sendMessage(msg.chat.id, tgHelpText(), { parse_mode: 'Markdown' }) })
    tgBot.onText(/^\/connect(?:\s+(.+))?/, async (msg, match) => {
        if (!tgAuth(msg.from.id)) return
        const num = match?.[1]
        if (!num) {
            tgPending.set(msg.chat.id, 'connect')
            await tgBot.sendMessage(msg.chat.id,
                `╭━〔 🔗 *SUKUNA REALM* 〕━╮\n\n` +
                `       🔗 *CONNECT*\n\n` +
                `▸ Send the WhatsApp\n▸ number with country\n▸ code (digits only).\n\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: 'Markdown', reply_markup: tgBackKeyboard() })
            return
        }
        tgPending.delete(msg.chat.id)
        await tgConnectNumber(msg.chat.id, num)
    })
    tgBot.onText(/^\/status\b/, async (msg) => { if (!tgAuth(msg.from.id)) return; tgPending.delete(msg.chat.id); await tgShowStatus(msg.chat.id) })
    tgBot.onText(/^\/sessions\b/, async (msg) => { if (!tgAuth(msg.from.id)) return; tgPending.delete(msg.chat.id); await tgShowSessions(msg.chat.id) })
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
            try { await tgBot.answerCallbackQuery(query.id, { text: '🚫 Access Denied', show_alert: true }) } catch (e) {}
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
                await tgEditOrSend(chatId, messageId,
                    `╭━〔 🔗 *SUKUNA REALM* 〕━╮\n\n` +
                    `       🔗 *CONNECT*\n\n` +
                    `▸ Send the WhatsApp\n▸ number with country\n▸ code (digits only).\n\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`,
                    tgBackKeyboard())
                return
            }
            if (data === 'reconnect') { await tgShowReconnectList(chatId, messageId); return }
            if (data === 'disconnect') { await tgShowDisconnectList(chatId, messageId); return }
            if (data.startsWith('reconnect:')) { await tgReconnectSession(chatId, data.slice('reconnect:'.length)); return }
            if (data.startsWith('disconnect:')) { await tgDisconnectSession(chatId, data.slice('disconnect:'.length)); return }
        } catch (e) { console.log('[TELEGRAM] callback error:', e?.message || e) }
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
        } catch (e) { console.log('[MONGO] Restore error:', e.message) }
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
checkFfmpeg()