const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys')
const { MongoClient } = require('mongodb')
const P = require('pino')
const http = require('http')
const fs = require('fs')
const path = require('path')

const OWNER_NUMBER = '2349034732809' // no longer used for permission checks - kept unused/for reference only
const OWNER_NAME = 'SUKUNA KING'
const BOT_NAME = 'SUKUNA REALM'
const DASHBOARD_PASSWORD = 'Mars2000'
const MONGO_URI = process.env.MONGO_URI || ''
const PORT = process.env.PORT || 3000
const SESSION_DIR = path.join('.', 'sessions')
const LOGO_PATH = path.join('.', 'logo.png')

const sessions = {}
let botMode = 'public'
let botPrefix = '.'
let botTyping = false
let botDelay = false
let botRead = false
let botOnline = false
let botAutoReact = false
let botStatusView = false
let botAutoView = false
const warningCounts = {}
const warnLimit = {}
const groupSettings = {}
const welcomeSettings = {}
const activePolls = {}
const reconnectCooldown = {}
const spamTracker = {}
const SPAM_WINDOW_MS = 7000
const SPAM_MAX_MESSAGES = 5

let mongoClient = null
let sessionsCollection = null
let logoCollection = null

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true })

process.on('unhandledRejection', (reason) => {
    console.log('Unhandled rejection:', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
    console.log('Uncaught exception:', err?.message || err)
})

async function initMongo() {
    if (!MONGO_URI) {
        console.log('[MONGO] No MONGO_URI provided. Sessions will be temporary.')
        return false
    }
    try {
        mongoClient = new MongoClient(MONGO_URI)
        await mongoClient.connect()
        const db = mongoClient.db('sukunabot')
        sessionsCollection = db.collection('sessions')
        logoCollection = db.collection('logo')
        console.log('[MONGO] Connected!')
        return true
    } catch (e) {
        console.log('[MONGO] Connection failed:', e.message)
        return false
    }
}

async function saveSessionToMongo(sessionId, credsData) {
    if (!sessionsCollection) return
    try {
        await sessionsCollection.updateOne(
            { _id: sessionId },
            { $set: { creds: credsData, updatedAt: new Date() } },
            { upsert: true }
        )
    } catch (e) {
        console.log('[MONGO] Save error:', e.message)
    }
}

async function loadSessionFromMongo(sessionId) {
    if (!sessionsCollection) return null
    try {
        const doc = await sessionsCollection.findOne({ _id: sessionId })
        return doc ? doc.creds : null
    } catch (e) {
        console.log('[MONGO] Load error:', e.message)
        return null
    }
}

async function deleteSessionFromMongo(sessionId) {
    if (!sessionsCollection) return
    try {
        await sessionsCollection.deleteOne({ _id: sessionId })
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
    if (!logoCollection) return null
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

function getRandom(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function normalizeJid(number) {
    let n = number.replace(/[^0-9]/g, '')
    return n + '@s.whatsapp.net'
}
function isOwner(senderNumber, sessionOwnNumber) {
    if (!sessionOwnNumber) return false
    return senderNumber === sessionOwnNumber.replace(/[^0-9]/g, '')
}

function getSessionOwnNumber(sock, fallbackNumber) {
    const meId = sock?.authState?.creds?.me?.id
    if (meId) {
        return meId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    }
    return (fallbackNumber || '').replace(/[^0-9]/g, '')
}
function formatUptime(sec) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return `${h}h ${m}m`
}

async function issueWarn(sock, from, targetJid) {
    if (!warningCounts[from]) warningCounts[from] = {}
    warningCounts[from][targetJid] = (warningCounts[from][targetJid] || 0) + 1
    const limit = warnLimit[from] || 3
    const count = warningCounts[from][targetJid]
    if (count >= limit) {
        try {
            await sock.groupParticipantsUpdate(from, [targetJid], 'remove')
            delete warningCounts[from][targetJid]
            return `[KICKED] @${targetJid.split('@')[0]} (${limit}/${limit} warnings).`
        } catch (e) {
            return `[WARN] @${targetJid.split('@')[0]} (${count}/${limit}).`
        }
    }
    return `[WARN] @${targetJid.split('@')[0]} (${count}/${limit}).`
}

// Detects violations for the active anti-* protections in a group and, if
// one is found: deletes the offending message (only if this bot session's
// own account is a group admin - never mentioned either way in the warn
// text), then always sends the warn (regardless of this bot's own admin
// status) and counts it toward the kick limit. Admins are exempt from
// enforcement. antibot and antidelete are left as toggles only for now -
// antibot has no clear detection signal, and antidelete is conceptually a
// different feature (resurfacing deleted messages, not warning senders).
async function handleAntiProtections(sock, msg, from, sender, text, contextInfo) {
    const settings = groupSettings[from]
    if (!settings) return false
    const anyActive = settings.antilink || settings.antispam || settings.antimedia || settings.antitag || settings.antiforward
    if (!anyActive) return false

    let violation = null

    if (settings.antilink && /(https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}|wa\.me\/|chat\.whatsapp\.com\/)/i.test(text)) {
        violation = 'link'
    }
    if (!violation && settings.antimedia) {
        const m = msg.message
        if (m.imageMessage || m.videoMessage || m.documentMessage || m.audioMessage || m.stickerMessage) {
            violation = 'media'
        }
    }
    if (!violation && settings.antitag) {
        const mentionCount = contextInfo?.mentionedJid?.length || 0
        if (mentionCount >= 5) violation = 'mass tag'
    }
    if (!violation && settings.antiforward && contextInfo?.isForwarded) {
        violation = 'forwarded message'
    }
    if (!violation && settings.antispam) {
        const now = Date.now()
        if (!spamTracker[from]) spamTracker[from] = {}
        if (!spamTracker[from][sender]) spamTracker[from][sender] = []
        spamTracker[from][sender] = spamTracker[from][sender].filter(t => now - t < SPAM_WINDOW_MS)
        spamTracker[from][sender].push(now)
        if (spamTracker[from][sender].length > SPAM_MAX_MESSAGES) {
            violation = 'spam'
            spamTracker[from][sender] = []
        }
    }

    if (!violation) return false

    try {
        const isSenderAdmin = await checkAdmin(sock, from, sender)
        if (isSenderAdmin) return false
    } catch (e) {
        return false
    }

    try {
        const sessionOwnNumber = getSessionOwnNumber(sock)
        const botOwnJid = normalizeJid(sessionOwnNumber)
        const isBotAdmin = await checkAdmin(sock, from, botOwnJid)
        if (isBotAdmin) {
            await sock.sendMessage(from, { delete: msg.key })
        }
    } catch (e) {
        // Deletion is best-effort only - never surfaced to the user either way.
    }

    try {
        const warnText = await issueWarn(sock, from, sender)
        await sock.sendMessage(from, { text: warnText, mentions: [sender] })
    } catch (e) {}

    return true
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
async function startSession(sessionId, phoneNumber, forceNewPairing = false) {
    const sessionPath = path.join(SESSION_DIR, sessionId)

    if (forceNewPairing && fs.existsSync(sessionPath)) {
        try { fs.rmSync(sessionPath, { recursive: true, force: true }) } catch (e) {}
        await deleteSessionFromMongo(sessionId)
    }

    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    })

    sessions[sessionId] = sessions[sessionId] || {}
    sessions[sessionId].sock = sock
    sessions[sessionId].number = phoneNumber
    sessions[sessionId].connectedAt = sessions[sessionId].connectedAt || new Date().toISOString()
    sessions[sessionId].status = 'connecting'
    sessions[sessionId].pairingCode = null
    sessions[sessionId].sessionPath = sessionPath

    sock.ev.on('creds.update', async () => {
        saveCreds()
        try {
            const credsFile = path.join(sessionPath, 'creds.json')
            if (fs.existsSync(credsFile)) {
                const credsData = fs.readFileSync(credsFile, 'utf-8')
                await saveSessionToMongo(sessionId, credsData)
            }
        } catch (e) {
            console.log('[MONGO] Creds save error:', e.message)
        }
    })

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) {
                console.log(`[${sessionId}] Reconnecting...`)
                if (sessions[sessionId]) sessions[sessionId].status = 'reconnecting'
                setTimeout(() => startSession(sessionId, phoneNumber), 5000)
            } else {
                console.log(`[${sessionId}] Logged out.`)
                if (sessions[sessionId]) sessions[sessionId].status = 'logged out'
                await deleteSessionFromMongo(sessionId)
            }
        } else if (connection === 'open') {
            if (sock.authState.creds.registered) {
                console.log(`[${sessionId}] Connected!`)
                if (sessions[sessionId]) {
                    sessions[sessionId].status = 'active'
                    sessions[sessionId].pairingCode = null
                }
            } else {
                console.log(`[${sessionId}] Socket open, waiting for pairing...`)
            }
        }
    })

    if (!sock.authState.creds.registered) {
        await sleep(3000)
        try {
            const code = await sock.requestPairingCode(phoneNumber)
            sessions[sessionId].pairingCode = code
            console.log(`[${sessionId}] PAIRING CODE: ${code}`)
        } catch (err) {
            console.log(`[${sessionId}] Pairing error:`, err.message)
        }
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            try {
                if (!msg.message) continue
                const from = msg.key.remoteJid
                if (!from) continue
                const isGroup = from.endsWith('@g.us')
                const sender = isGroup ? msg.key.participant : from
                const senderNumber = sender ? sender.split('@')[0] : ''
                const sessionOwnNumber = getSessionOwnNumber(sock, phoneNumber)
                const owner = isOwner(senderNumber, sessionOwnNumber)

                const body = msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption || ''

                const text = body.trim()
                const lowerText = text.toLowerCase()

                const contextInfo = msg.message.extendedTextMessage?.contextInfo
                const quotedMessage = contextInfo?.quotedMessage || null
                const viewOnceTarget = extractViewOnceMedia(quotedMessage) || extractViewOnceMedia(msg.message)

                // Anti-protection enforcement runs regardless of botMode -
                // group safety shouldn't depend on who the bot is replying to.
                if (isGroup && !msg.key.fromMe) {
                    try {
                        const handled = await handleAntiProtections(sock, msg, from, sender, text, contextInfo)
                        if (handled) continue
                    } catch (e) {
                        console.log('Anti-protection error:', e.message)
                    }
                }

                if (lowerText === botPrefix + 'hmm') {
                    if (!contextInfo) {
                        await sock.sendMessage(from, { text: '[X] Reply to a view-once photo/video with .hmm' }, { quoted: msg })
                        continue
                    }
                    if (!viewOnceTarget) {
                        await sock.sendMessage(from, { text: '[X] This only works on view-once media.' }, { quoted: msg })
                        continue
                    }
                    try {
                        const buffer = await downloadMediaMessage(
                            { key: msg.key, message: viewOnceTarget.message },
                            'buffer',
                            {},
                            { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                        )
                        if (viewOnceTarget.type === 'image') {
                            await sock.sendMessage(sender, { image: buffer, caption: 'Saved view-once' })
                        } else {
                            await sock.sendMessage(sender, { video: buffer, caption: 'Saved view-once' })
                        }
                    } catch (e) {
                        console.log('Hmm save error:', e.message)
                    }
                    continue
                }

                if (lowerText === botPrefix + 'vv') {
                    if (!contextInfo) {
                        await sock.sendMessage(from, { text: '[X] Reply to a view-once photo/video with .vv' }, { quoted: msg })
                        continue
                    }
                    if (!viewOnceTarget) {
                        await sock.sendMessage(from, { text: '[X] This only works on *view-once* media.\n\nHow to use:\n1. Wait for a view-once photo/video\n2. Do NOT open it\n3. Reply to it with .vv' }, { quoted: msg })
                        continue
                    }
                    try {
                        const buffer = await downloadMediaMessage(
                            { key: msg.key, message: viewOnceTarget.message },
                            'buffer',
                            {},
                            { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                        )
                        if (viewOnceTarget.type === 'image') {
                            await sock.sendMessage(from, { image: buffer, caption: 'View-once revealed' }, { quoted: msg })
                        } else {
                            await sock.sendMessage(from, { video: buffer, caption: 'View-once revealed' }, { quoted: msg })
                        }
                    } catch (e) {
                        console.log('.vv error:', e.message)
                        await sock.sendMessage(from, { text: '[X] Failed to reveal. WhatsApp may have already deleted it.' }, { quoted: msg })
                    }
                    continue
                }

                if (botMode === 'private' && !owner) continue

                if (botRead && msg.key) {
                    try { await sock.readMessages([msg.key]) } catch (e) {}
                }
                if (botOnline) {
                    try { await sock.sendPresenceUpdate('available', from) } catch (e) {}
                }
                if (botDelay) await sleep(3000 + Math.random() * 3000)
                if (botTyping) {
                    try { await sock.sendPresenceUpdate('composing', from) } catch (e) {}
                }

                if (!text.startsWith(botPrefix)) continue
                const args = text.slice(botPrefix.length).trim().split(/\s+/)
                const cmd = args.shift().toLowerCase()

                await handleCommand(sock, msg, from, isGroup, sender, senderNumber, owner, cmd, args, text)
            } catch (err) {
                console.log('Message handler error:', err.message)
            }
        }
    })

    return sock
}
const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0]

    if (url === '/' || url === '/dashboard' || url === '/logo.png' || url === '/upload-logo' || url === '/api/sessions') {
        const auth = req.headers.authorization
        if (!auth || !checkAuth(auth)) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SUKUNA REALM"' })
            res.end('Authentication required')
            return
        }

        if (url === '/api/sessions') {
            const data = Object.entries(sessions).map(([id, s]) => ({
                number: s.number,
                status: s.status,
                connectedAt: s.connectedAt,
                pairingCode: s.status === 'active' ? null : s.pairingCode
            }))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ sessions: data, mode: botMode, prefix: botPrefix, uptime: formatUptime(process.uptime()), count: Object.keys(sessions).length }))
            return
        }

        if (url === '/upload-logo' && req.method === 'POST') {
            const chunks = []
            req.on('data', c => chunks.push(c))
            req.on('end', async () => {
                const buffer = Buffer.concat(chunks)
                const boundary = req.headers['content-type'].split('boundary=')[1]
                if (!boundary) {
                    res.writeHead(302, { Location: '/dashboard' })
                    res.end()
                    return
                }
                const parts = buffer.toString('binary').split('--' + boundary)
                for (const part of parts) {
                    if (part.includes('filename=') && part.includes('Content-Type: image')) {
                        const headerEnd = part.indexOf('\r\n\r\n')
                        let imgData = part.slice(headerEnd + 4)
                        imgData = imgData.replace(/\r\n--$/, '').replace(/\r\n$/, '')
                        const imgBuffer = Buffer.from(imgData, 'binary')
                        fs.writeFileSync(LOGO_PATH, imgBuffer)
                        await saveLogoToMongo(imgBuffer)
                        break
                    }
                }
                res.writeHead(302, { Location: '/dashboard' })
                res.end()
            })
            return
        }

        if (url === '/logo.png') {
            if (fs.existsSync(LOGO_PATH)) {
                res.writeHead(200, { 'Content-Type': 'image/png' })
                res.end(fs.readFileSync(LOGO_PATH))
            } else {
                res.writeHead(404)
                res.end('No logo')
            }
            return
        }

        if (req.method === 'POST' && url === '/dashboard') {
            let body = ''
            req.on('data', chunk => body += chunk)
            req.on('end', async () => {
                const params = new URLSearchParams(body)
                const action = params.get('action')
                const number = params.get('number')

                if (action === 'connect' && number) {
                    const cleanNum = number.replace(/[^0-9]/g, '')
                    const sessionId = 'sess_' + cleanNum
                    if (!sessions[sessionId]) {
                        await startSession(sessionId, cleanNum)
                    }
                } else if (action === 'disconnect' && number) {
                    const sessionId = 'sess_' + number.replace(/[^0-9]/g, '')
                    if (sessions[sessionId]) {
                        try { await sessions[sessionId].sock.logout() } catch (e) {}
                        delete sessions[sessionId]
                    }
                    await deleteSessionFromMongo(sessionId)
                } else if (action === 'reconnect' && number) {
                    const cleanNum = number.replace(/[^0-9]/g, '')
                    const sessionId = 'sess_' + cleanNum
                    const now = Date.now()
                    if (reconnectCooldown[sessionId] && now - reconnectCooldown[sessionId] < 30000) {
                        res.writeHead(302, { Location: '/dashboard' })
                        res.end()
                        return
                    }
                    reconnectCooldown[sessionId] = now

                    if (sessions[sessionId]) {
                        try { await sessions[sessionId].sock.end(undefined) } catch (e) {}
                        delete sessions[sessionId]
                    }

                    const sessionPath = path.join(SESSION_DIR, sessionId)
                    const credsExist = fs.existsSync(path.join(sessionPath, 'creds.json'))

                    if (credsExist) {
                        await startSession(sessionId, cleanNum, false)
                        setTimeout(async () => {
                            if (sessions[sessionId] && sessions[sessionId].status !== 'active') {
                                console.log(`[${sessionId}] Silent reconnect failed, forcing new pairing`)
                                await startSession(sessionId, cleanNum, true)
                            }
                        }, 10000)
                    } else {
                        await startSession(sessionId, cleanNum, true)
                    }
                }
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

function checkAuth(header) {
    try {
        const b64 = header.split(' ')[1]
        const [user, pass] = Buffer.from(b64, 'base64').toString().split(':')
        return pass === DASHBOARD_PASSWORD
    } catch (e) {
        return false
    }
}

server.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`)
})

async function handleCommand(sock, msg, from, isGroup, sender, senderNumber, owner, cmd, args, rawText) {
    const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg })
    const isAdmin = isGroup ? await checkAdmin(sock, from, sender) : false
    const prefix = botPrefix

    if (cmd === 'ping') return reply('pong 🏓')
    if (cmd === 'hello') return reply(`Hey there! 👋 I am *${BOT_NAME}*`)
    if (cmd === 'time') return reply(`🕐 *Time:* ${new Date().toLocaleTimeString()}`)
    if (cmd === 'date') return reply(`📅 *Date:* ${new Date().toLocaleDateString()}`)

    if (cmd === 'info') {
        return reply(
            `╭━━━〔 *${BOT_NAME}* 〕━━━┈⊷\n` +
            `┃ 👑 *Owner:* ${OWNER_NAME}\n` +
            `┃ ⚙️ *Mode:* ${botMode}\n` +
            `┃ 🔧 *Prefix:* ${prefix}\n` +
            `┃ 📡 *Sessions:* ${Object.keys(sessions).length}\n` +
            `┃ ⏳ *Uptime:* ${formatUptime(process.uptime())}\n` +
            `╰━━━━━━━━━━━━━━━━━┈⊷`
        )
    }

    if (cmd === 'menu' || cmd === 'help') {
        const menuText = renderMenu()
        if (fs.existsSync(LOGO_PATH)) {
            try {
                const buffer = fs.readFileSync(LOGO_PATH)
                return sock.sendMessage(from, { image: buffer, caption: menuText }, { quoted: msg })
            } catch (e) {}
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
            `┃ ${prefix}save\n` +
            `┃ Reply to a WhatsApp Status → saves to your own DM\n\n` +
            `╰━━━━━━━━━━━━━━━━━┈⊷`
        )
    }

    if (cmd === 'mode') {
        if (args[0] === 'public' || args[0] === 'private') {
            botMode = args[0]
            return reply(`[OK] Mode set to *${botMode}*`)
        }
        return reply(`Current mode: *${botMode}*\nUsage: ${prefix}mode public/private`)
    }

    if (cmd === 'prefix') {
        if (args[0]) {
            botPrefix = args[0]
            return reply(`[OK] Prefix changed to *${botPrefix}*`)
        }
        return reply(`Current prefix: *${botPrefix}*`)
    }

    const toggleMap = ['typing', 'delay', 'read', 'online', 'autoreact', 'statusview', 'autoview']
    if (toggleMap.includes(cmd)) {
        const getVal = () => {
            if (cmd === 'typing') return botTyping
            if (cmd === 'delay') return botDelay
            if (cmd === 'read') return botRead
            if (cmd === 'online') return botOnline
            if (cmd === 'autoreact') return botAutoReact
            if (cmd === 'statusview') return botStatusView
            if (cmd === 'autoview') return botAutoView
        }
        const setVal = (v) => {
            if (cmd === 'typing') botTyping = v
            if (cmd === 'delay') botDelay = v
            if (cmd === 'read') botRead = v
            if (cmd === 'online') botOnline = v
            if (cmd === 'autoreact') botAutoReact = v
            if (cmd === 'statusview') botStatusView = v
            if (cmd === 'autoview') botAutoView = v
        }
        if (args[0] === 'on' || args[0] === 'off') {
            setVal(args[0] === 'on')
            return reply(`[OK] *${cmd}* is now *${args[0]}*`)
        }
        return reply(`*${cmd}:* ${getVal() ? 'on' : 'off'}\nUsage: ${prefix}${cmd} on/off`)
    }

    if (cmd === 'save') {
        const quotedInfo = msg.message.extendedTextMessage?.contextInfo
        const quoted = quotedInfo?.quotedMessage
        if (!quoted) return reply('[X] Reply to a WhatsApp Status with this command.')
        try {
            let buffer
            try {
                buffer = await downloadMediaMessage(
                    { key: msg.key, message: quoted },
                    'buffer',
                    {},
                    { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                )
            } catch (firstErr) {
                // Status replies often need an explicitly reconstructed
                // status@broadcast key to resolve, rather than the reply
                // message's own key.
                const statusKey = {
                    remoteJid: 'status@broadcast',
                    id: quotedInfo.stanzaId,
                    participant: quotedInfo.participant || sender,
                    fromMe: false
                }
                buffer = await downloadMediaMessage(
                    { key: statusKey, message: quoted },
                    'buffer',
                    {},
                    { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                )
            }
            if (quoted.imageMessage) {
                await sock.sendMessage(sender, { image: buffer, caption: quoted.imageMessage.caption || 'Saved status' })
            } else if (quoted.videoMessage) {
                await sock.sendMessage(sender, { video: buffer, caption: quoted.videoMessage.caption || 'Saved status' })
            } else {
                await sock.sendMessage(sender, { text: 'Saved status text:\n\n' + (quoted.conversation || quoted.extendedTextMessage?.text || '') })
            }
            return reply('[OK] Status saved to your DM.')
        } catch (e) {
            console.log('Save status error:', e.message)
            return reply('[X] Could not save status. It may be expired or restricted by WhatsApp.')
        }
    }

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

    if (cmd === 'calc') {
        try {
            const result = eval(args.join(' ').replace(/[^0-9+\-*/().]/g, ''))
            return reply(`🧮 *Result:* ${result}`)
        } catch { return reply('[X] Invalid math') }
    }

    if (cmd === 'sticker') {
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
        if (!quoted || !quoted.imageMessage) return reply('[X] Reply to an image.')
        try {
            const buffer = await downloadMediaMessage({ key: msg.key, message: quoted }, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
            return sock.sendMessage(from, { sticker: buffer }, { quoted: msg })
        } catch { return reply('[X] Failed to create sticker.') }
    }

    if (cmd === 'toimg') {
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
        if (!quoted || !quoted.stickerMessage) return reply('[X] Reply to a sticker.')
        try {
            const buffer = await downloadMediaMessage({ key: msg.key, message: quoted }, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
            return sock.sendMessage(from, { image: buffer, caption: 'Sticker converted' }, { quoted: msg })
        } catch { return reply('[X] Failed to convert sticker.') }
    }

    if (cmd === 'warn') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('[X] Mention a user.')
        if (!warningCounts[from]) warningCounts[from] = {}
        warningCounts[from][mentioned] = (warningCounts[from][mentioned] || 0) + 1
        const limit = warnLimit[from] || 3
        const count = warningCounts[from][mentioned]
        if (count >= limit) {
            try {
                await sock.groupParticipantsUpdate(from, [mentioned], 'remove')
                delete warningCounts[from][mentioned]
                return reply(`[KICKED] @${mentioned.split('@')[0]} (${limit}/${limit} warnings).`)
            } catch { return reply('[X] Failed to kick user.') }
        }
        return reply(`[WARN] @${mentioned.split('@')[0]} (${count}/${limit}).`)
    }

    if (cmd === 'warncount') {
        if (!isGroup) return reply('[X] Group only.')
        const num = parseInt(args[0])
        if (!num || num < 1) return reply('Usage: ' + prefix + 'warncount <number>')
        warnLimit[from] = num
        return reply(`[OK] Warning limit set to *${num}*`)
    }

    if (cmd === 'warnlist') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        const list = warningCounts[from] || {}
        if (Object.keys(list).length === 0) return reply('[OK] No warned users.')
        let out = '[WARN] *Warned Users:*\n\n'
        for (const [jid, count] of Object.entries(list)) out += `@${jid.split('@')[0]}: ${count} warnings\n`
        return sock.sendMessage(from, { text: out, mentions: Object.keys(list) })
    }

    if (cmd === 'resetwarn') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('[X] Mention a user.')
        if (warningCounts[from]) delete warningCounts[from][mentioned]
        return reply(`[OK] Warnings reset for @${mentioned.split('@')[0]}`)
    }

    const protectCmds = ['antilink', 'antispam', 'antibot', 'antimedia', 'antitag', 'antidelete', 'antiforward']
    if (protectCmds.includes(cmd)) {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        if (!groupSettings[from]) groupSettings[from] = {}
        if (args[0] === 'on' || args[0] === 'off') {
            groupSettings[from][cmd] = args[0] === 'on'
            return reply(`[OK] *${cmd}* is now *${args[0]}*`)
        }
        return reply(`*${cmd}:* ${groupSettings[from][cmd] ? 'on' : 'off'}\nUsage: ${prefix}${cmd} on/off`)
    }

    if (cmd === 'kick') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('[X] Mention a user.')
        try { await sock.groupParticipantsUpdate(from, [mentioned], 'remove'); return reply(`[OK] Kicked @${mentioned.split('@')[0]}`) }
        catch { return reply('[X] Failed.') }
    }
    if (cmd === 'add') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        if (!args[0]) return reply('Usage: ' + prefix + 'add <number>')
        try { await sock.groupParticipantsUpdate(from, [normalizeJid(args[0])], 'add'); return reply('[OK] Added.') }
        catch { return reply('[X] Failed.') }
    }
    if (cmd === 'promote') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('[X] Mention a user.')
        try { await sock.groupParticipantsUpdate(from, [mentioned], 'promote'); return reply('[OK] Promoted.') }
        catch { return reply('[X] Failed.') }
    }
    if (cmd === 'demote') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('[X] Mention a user.')
        try { await sock.groupParticipantsUpdate(from, [mentioned], 'demote'); return reply('[OK] Demoted.') }
        catch { return reply('[X] Failed.') }
    }
    if (cmd === 'mute' || cmd === 'unmute') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        try {
            await sock.groupSettingUpdate(from, cmd === 'mute' ? 'announcement' : 'not_announcement')
            return reply(`[OK] Group ${cmd === 'mute' ? 'muted' : 'unmuted'}.`)
        } catch { return reply('[X] Failed.') }
    }

    if (cmd === 'tagall' || cmd === 'hidetag') {
        if (!isGroup) return reply('[X] Group only.')
        const groupMeta = await sock.groupMetadata(from)
        const mentions = groupMeta.participants.map(p => p.id)
        const message = args.join(' ') || 'Attention everyone!'
        if (cmd === 'hidetag') return sock.sendMessage(from, { text: message, mentions })
        let out = '*Tag All:*\n\n' + message + '\n\n'
        mentions.forEach(jid => { out += `@${jid.split('@')[0]} ` })
        return sock.sendMessage(from, { text: out, mentions })
    }

    if (cmd === 'groupinfo') {
        if (!isGroup) return reply('[X] Group only.')
        const meta = await sock.groupMetadata(from)
        return reply(
            `╭━━━〔 *GROUP INFO* 〕━━━┈⊷\n` +
            `┃ *Name:* ${meta.subject}\n` +
            `┃ *Members:* ${meta.participants.length}\n` +
            `┃ *Admins:* ${meta.participants.filter(p => p.admin).length}\n` +
            `╰━━━━━━━━━━━━━━━┈⊷`
        )
    }
    if (cmd === 'link') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        try { const code = await sock.groupInviteCode(from); return reply(`https://chat.whatsapp.com/${code}`) }
        catch { return reply('[X] Failed.') }
    }
    if (cmd === 'revoke') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        try { await sock.groupRevokeInvite(from); return reply('[OK] Link revoked.') }
        catch { return reply('[X] Failed.') }
    }
    if (cmd === 'admins') {
        if (!isGroup) return reply('[X] Group only.')
        const meta = await sock.groupMetadata(from)
        const admins = meta.participants.filter(p => p.admin)
        let out = '*Admins:*\n\n'
        admins.forEach(a => out += `@${a.id.split('@')[0]}\n`)
        return sock.sendMessage(from, { text: out, mentions: admins.map(a => a.id) })
    }
    if (cmd === 'members') {
        if (!isGroup) return reply('[X] Group only.')
        const meta = await sock.groupMetadata(from)
        let out = `*Members (${meta.participants.length}):*\n\n`
        meta.participants.forEach(p => out += `@${p.id.split('@')[0]}\n`)
        return sock.sendMessage(from, { text: out, mentions: meta.participants.map(p => p.id) })
    }

    if (cmd === 'welcome' || cmd === 'goodbye') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        if (!welcomeSettings[from]) welcomeSettings[from] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
        if (args[0] === 'on' || args[0] === 'off') {
            welcomeSettings[from][cmd] = args[0] === 'on'
            return reply(`[OK] *${cmd}* is now *${args[0]}*`)
        }
        return reply(`*${cmd}:* ${welcomeSettings[from][cmd] ? 'on' : 'off'}`)
    }
    if (cmd === 'setwelcome' || cmd === 'setgoodbye') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        const txt = args.join(' ')
        if (!txt) return reply('Usage: ' + prefix + cmd + ' <text>')
        if (!welcomeSettings[from]) welcomeSettings[from] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
        welcomeSettings[from][cmd === 'setwelcome' ? 'welcomeMsg' : 'goodbyeMsg'] = txt
        return reply('[OK] Set.')
    }

    if (cmd === 'poll') {
        if (!isGroup) return reply('[X] Group only.')
        const parts = args.join(' ').split('|').map(s => s.trim())
        if (parts.length < 3) return reply('Usage: ' + prefix + 'poll Question | Opt1 | Opt2')
        const [question, ...options] = parts
        activePolls[from] = { question, options, votes: {} }
        let out = `*Poll:* ${question}\n\n`
        options.forEach((opt, i) => out += `${i + 1}. ${opt}\n`)
        out += `\nVote with ${prefix}vote <number>`
        return reply(out)
    }
    if (cmd === 'vote') {
        if (!activePolls[from]) return reply('[X] No active poll.')
        const num = parseInt(args[0]) - 1
        if (isNaN(num) || num < 0 || num >= activePolls[from].options.length) return reply('[X] Invalid vote.')
        activePolls[from].votes[sender] = num
        return reply(`[OK] Voted for *${activePolls[from].options[num]}*`)
    }
    if (cmd === 'endpoll') {
        if (!isGroup || !isAdmin) return reply('[X] Admin only.')
        if (!activePolls[from]) return reply('[X] No active poll.')
        const poll = activePolls[from]
        const tally = {}
        poll.options.forEach((_, i) => tally[i] = 0)
        Object.values(poll.votes).forEach(v => tally[v]++)
        let out = `*Poll Results:* ${poll.question}\n\n`
        poll.options.forEach((opt, i) => out += `${opt}: ${tally[i]} votes\n`)
        delete activePolls[from]
        return reply(out)
    }

    if (cmd === 'tt') return reply('[!] TikTok downloader is temporarily disabled.')

    return reply(`[X] Unknown command: *${prefix}${cmd}*\nType ${prefix}menu for help.`)
}

async function checkAdmin(sock, groupJid, userJid) {
    try {
        const meta = await sock.groupMetadata(groupJid)
        const participant = meta.participants.find(p => p.id === userJid)
        return participant && participant.admin
    } catch { return false }
}

function renderGroupCommandsBox() {
    return (
        `╭━━━〔 👥 GROUP COMMANDS 〕━━━┈⊷\n` +
        `┃ *Protection:*\n` +
        `┃ ${botPrefix}antilink  ${botPrefix}antispam\n` +
        `┃ ${botPrefix}antimedia ${botPrefix}antitag\n` +
        `┃ ${botPrefix}antiforward\n` +
        `┃\n` +
        `┃ *Members:*\n` +
        `┃ ${botPrefix}kick  ${botPrefix}add\n` +
        `┃ ${botPrefix}promote  ${botPrefix}demote\n` +
        `┃ ${botPrefix}mute  ${botPrefix}unmute\n` +
        `┃\n` +
        `┃ *Communication:*\n` +
        `┃ ${botPrefix}tagall  ${botPrefix}hidetag\n` +
        `┃\n` +
        `┃ *Info:*\n` +
        `┃ ${botPrefix}groupinfo  ${botPrefix}link\n` +
        `┃ ${botPrefix}revoke  ${botPrefix}admins\n` +
        `┃ ${botPrefix}members\n` +
        `┃\n` +
        `┃ *Welcome:*\n` +
        `┃ ${botPrefix}welcome  ${botPrefix}goodbye\n` +
        `┃ ${botPrefix}setwelcome  ${botPrefix}setgoodbye\n` +
        `┃\n` +
        `┃ *Warn:*\n` +
        `┃ ${botPrefix}warn  ${botPrefix}warncount\n` +
        `┃ ${botPrefix}warnlist  ${botPrefix}resetwarn\n` +
        `┃\n` +
        `┃ *Polls:*\n` +
        `┃ ${botPrefix}poll  ${botPrefix}vote  ${botPrefix}endpoll\n` +
        `╰━━━━━━━━━━━━━━━┈⊷`
    )
}

function renderMenu() {
    const d = new Date()
    return (
        `╭━━━━━━━〔 👹 ${BOT_NAME} 〕━━━━━━━╮\n\n` +
        `      BOT INFO\n\n` +
        `👤 OWNER  : ${OWNER_NAME}\n` +
        `⚙️ MODE   : ${botMode}\n` +
        `🔧 PREFIX : ${botPrefix}\n` +
        `📅 DATE   : ${d.toLocaleDateString()}\n` +
        `🕐 TIME   : ${d.toLocaleTimeString()}\n` +
        `⏳ UPTIME : ${formatUptime(process.uptime())}\n` +
        `📡 SESSIONS: ${Object.keys(sessions).length}\n\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `╭━━━〔 BASIC 〕━━━┈⊷\n` +
        `┃ ${botPrefix}ping  ${botPrefix}hello  ${botPrefix}time  ${botPrefix}date\n` +
        `┃ ${botPrefix}info  ${botPrefix}menu   ${botPrefix}mode  ${botPrefix}prefix\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 FUN 〕━━━┈⊷\n` +
        `┃ ${botPrefix}joke  ${botPrefix}quote  ${botPrefix}fact  ${botPrefix}dice\n` +
        `┃ ${botPrefix}coin  ${botPrefix}truth  ${botPrefix}dare  ${botPrefix}roast\n` +
        `┃ ${botPrefix}compliment  ${botPrefix}8ball  ${botPrefix}rate  ${botPrefix}ship\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        renderGroupCommandsBox() + `\n\n` +
        `╭━━━〔 PROTECTION SETTINGS 〕━━━┈⊷\n` +
        `┃ ${botPrefix}typing  ${botPrefix}delay  ${botPrefix}read  ${botPrefix}online\n` +
        `┃ ${botPrefix}autoreact ${botPrefix}statusview ${botPrefix}autoview\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 DOWNLOADER 〕━━━┈⊷\n` +
        `┃ ${botPrefix}tt <tiktok url>\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 UTILITY 〕━━━┈⊷\n` +
        `┃ ${botPrefix}calc  ${botPrefix}sticker  ${botPrefix}toimg\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `POWERED BY ${BOT_NAME}`
    )
}

function renderDashboard() {
    const logoHtml = fs.existsSync(LOGO_PATH)
        ? `<img src="/logo.png" style="max-width:100%;border-radius:8px;margin-bottom:15px">`
        : `<p style="color:#888;font-size:13px">No logo uploaded yet.</p>`

    return `<!DOCTYPE html>
<html><head><title>${BOT_NAME} Dashboard</title>
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
a.reload{display:inline-block;padding:8px 14px;background:#550000;color:#fff;text-decoration:none;border-radius:5px;font-size:13px;margin:5px 0;cursor:pointer}
p{font-size:13px;line-height:1.5}
</style></head><body>
<h1>${BOT_NAME}</h1>

<div class="card">
${logoHtml}
<h3>BOT INFO</h3>
<p><b>Owner:</b> ${OWNER_NAME}</p>
<p><b>Mode:</b> <span id="info-mode">${botMode}</span> | <b>Prefix:</b> <span id="info-prefix">${botPrefix}</span></p>
<p><b>Uptime:</b> <span id="info-uptime">${formatUptime(process.uptime())}</span></p>
<p><b>Sessions:</b> <span id="info-count">${Object.keys(sessions).length}</span></p>
<button class="reload" onclick="refreshSessions()">Reload Sessions</button>
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
<form method="POST">
<input type="hidden" name="action" value="connect">
<input type="text" name="number" placeholder="e.g. 2348139761928" required>
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
async function refreshSessions() {
    try {
        const res = await fetch('/api/sessions', { headers: { 'Authorization': 'Basic ' + btoa('admin:${DASHBOARD_PASSWORD}') } });
        const data = await res.json();
        document.getElementById('info-mode').textContent = data.mode;
        document.getElementById('info-prefix').textContent = data.prefix;
        document.getElementById('info-uptime').textContent = data.uptime;
        document.getElementById('info-count').textContent = data.count;

        const list = document.getElementById('sessions-list');
        const pairDiv = document.getElementById('pairing-display');
        pairDiv.innerHTML = '';
        list.innerHTML = '';

        if (data.sessions.length === 0) {
            list.innerHTML = '<p style="color:#888;font-size:13px">No sessions yet.</p>';
            return;
        }

        data.sessions.forEach(s => {
            const statusClass = 'status-' + s.status.replace(' ', '-');
            const card = document.createElement('div');
            card.className = 'session';
            card.innerHTML = '<div class="session-info">' +
                '<b>Number:</b> ' + s.number + '<br>' +
                '<b>Status:</b> <span class="' + statusClass + '">' + s.status + '</span><br>' +
                '<b>Connected:</b> ' + (s.connectedAt ? new Date(s.connectedAt).toLocaleString() : '-') +
                '</div>' +
                '<div class="session-actions">' +
                '<form method="POST" style="display:inline"><input type="hidden" name="action" value="reconnect"><input type="hidden" name="number" value="' + s.number + '"><button type="submit">Reconnect</button></form>' +
                '<form method="POST" style="display:inline"><input type="hidden" name="action" value="disconnect"><input type="hidden" name="number" value="' + s.number + '"><button type="submit" style="background:#880000">Disconnect</button></form>' +
                '</div>';
            list.appendChild(card);

            if (s.pairingCode && s.status !== 'active') {
                const p = document.createElement('div');
                p.innerHTML = '<p style="margin-top:10px;color:#ffcc00;font-size:13px"><b>Pairing code for ' + s.number + ':</b></p>' +
                    '<div class="code-box" id="code-' + s.number + '">' + s.pairingCode + '</div>' +
                    '<button class="copy-btn" onclick="copyCode(\\'' + s.pairingCode + '\\')">Copy Code</button>';
                pairDiv.appendChild(p);
            }
        });
    } catch (e) {
        console.log('Refresh error:', e);
    }
}

function copyCode(code) {
    navigator.clipboard.writeText(code).then(() => {
        alert('Copied: ' + code);
    }).catch(() => {
        const ta = document.createElement('textarea');
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

async function restoreSessions() {
    const connected = await initMongo()

    if (connected && sessionsCollection) {
        try {
            const docs = await sessionsCollection.find({}).toArray()
            for (const doc of docs) {
                const sessionId = doc._id
                const number = sessionId.replace('sess_', '')
                const sessionPath = path.join(SESSION_DIR, sessionId)
                if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })
                if (doc.creds) {
                    fs.writeFileSync(path.join(sessionPath, 'creds.json'), doc.creds)
                }
                console.log(`Restoring session from MongoDB: ${number}`)
                try { await startSession(sessionId, number) } catch (e) { console.log('Restore error:', e.message) }
            }
        } catch (e) {
            console.log('[MONGO] Restore error:', e.message)
        }
    } else {
        if (!fs.existsSync(SESSION_DIR)) return
        const dirs = fs.readdirSync(SESSION_DIR).filter(d => d.startsWith('sess_'))
        for (const dir of dirs) {
            const number = dir.replace('sess_', '')
            console.log(`Restoring local session: ${number}`)
            try { await startSession(dir, number) } catch (e) { console.log('Restore error:', e.message) }
        }
    }

    await loadLogoFromMongo()
}

restoreSessions().catch(e => console.log('Restore failed:', e.message))
