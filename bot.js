const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys')
const P = require('pino')
const http = require('http')
const fs = require('fs')
const path = require('path')

const OWNER_NUMBER = '2348139761928'
const OWNER_NAME = 'SUKUNA KING'
const BOT_NAME = 'SUKUNA REALM'
const DASHBOARD_PASSWORD = 'Mars2000'
const PORT = process.env.PORT || 3000
const SESSION_DIR = path.join('/tmp', 'sessions')

const sessions = {}
let botMode = 'public'
let botPrefix = '.'
let botTyping = true
let botDelay = true
let botRead = true
let botOnline = true
let botAutoReact = false
let botStatusView = false
let botAutoView = false
const warningCounts = {}
const warnLimit = {}
const groupSettings = {}
const welcomeSettings = {}
const activePolls = {}

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true })

const jokes = [
    'Why did the developer go broke? Because he used up all his cache!',
    'Why do programmers prefer dark mode? Because light attracts bugs!',
    'I would tell you a UDP joke, but you might not get it.',
    'Why did the Java developer wear glasses? Because he could not C#.',
    'How many programmers does it take to change a light bulb? None, that is a hardware problem.'
]

const quotes = [
    'The only way to do great work is to love what you do. — Steve Jobs',
    'Believe you can and you are halfway there. — Theodore Roosevelt',
    'It always seems impossible until it is done. — Nelson Mandela',
    'The future belongs to those who believe in the beauty of their dreams. — Eleanor Roosevelt',
    'Success is not final, failure is not fatal. — Winston Churchill'
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
function isOwner(jid) { return jid.startsWith(OWNER_NUMBER) }
// ==================== WHATSAPP CONNECTION ====================

async function startSession(sessionId, phoneNumber) {
    const sessionPath = path.join(SESSION_DIR, sessionId)
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    })

    sessions[sessionId] = {
        sock,
        number: phoneNumber,
        connectedAt: new Date().toISOString(),
        status: 'connecting',
        sessionPath
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) {
                console.log(`[${sessionId}] Reconnecting...`)
                sessions[sessionId].status = 'reconnecting'
                setTimeout(() => startSession(sessionId, phoneNumber), 5000)
            } else {
                console.log(`[${sessionId}] Logged out.`)
                sessions[sessionId].status = 'logged out'
            }
        } else if (connection === 'open') {
            console.log(`[${sessionId}] Connected!`)
            sessions[sessionId].status = 'active'
        }
    })

    // Pairing code (only if not registered yet)
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

    // ============ MESSAGE HANDLER ============
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            try {
                if (!msg.message) continue
                const from = msg.key.remoteJid
                const isGroup = from.endsWith('@g.us')
                const sender = isGroup ? msg.key.participant : from
                const senderNumber = sender ? sender.split('@')[0] : ''
                const owner = isOwner(senderNumber)

                const body = msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption || ''

                const text = body.trim()
                const lowerText = text.toLowerCase()

                // ============ VIEW-ONCE EMOJI SAVER (owner only) ============
                const viewOnceMsg = msg.message.viewOnceMessage ||
                    msg.message.viewOnceMessageV2 ||
                    msg.message.viewOnceMessageV2Extension

                if (viewOnceMsg && owner) {
                    const emojiRegex = /^\.[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u
                    if (emojiRegex.test(text)) {
                        try {
                            const innerMsg = viewOnceMsg.message
                            const mediaMsg = innerMsg.imageMessage || innerMsg.videoMessage
                            if (mediaMsg) {
                                const buffer = await downloadMediaMessage(
                                    { key: msg.key, message: innerMsg },
                                    'buffer',
                                    {},
                                    { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                                )
                                const ownerJid = normalizeJid(OWNER_NUMBER)
                                if (innerMsg.imageMessage) {
                                    await sock.sendMessage(ownerJid, { image: buffer, caption: '📥 Saved view-once' })
                                } else if (innerMsg.videoMessage) {
                                    await sock.sendMessage(ownerJid, { video: buffer, caption: '📥 Saved view-once' })
                                }
                            }
                        } catch (e) {
                            console.log('Emoji save error:', e.message)
                        }
                        continue
                    }
                }

                // ============ .vv (view-once reveal in current chat) ============
                if (lowerText === botPrefix + 'vv' && viewOnceMsg) {
                    try {
                        const innerMsg = viewOnceMsg.message
                        const mediaMsg = innerMsg.imageMessage || innerMsg.videoMessage
                        if (mediaMsg) {
                            const buffer = await downloadMediaMessage(
                                { key: msg.key, message: innerMsg },
                                'buffer',
                                {},
                                { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                            )
                            if (innerMsg.imageMessage) {
                                await sock.sendMessage(from, { image: buffer, caption: '👁️ View-once revealed' }, { quoted: msg })
                            } else if (innerMsg.videoMessage) {
                                await sock.sendMessage(from, { video: buffer, caption: '👁️ View-once revealed' }, { quoted: msg })
                            }
                        }
                    } catch (e) {
                        console.log('.vv error:', e.message)
                    }
                    continue
                }

                // ============ MODE / OWNER GATE ============
                if (botMode === 'private' && !owner) continue

                // ============ HUMAN-LIKE BEHAVIOR ============
                if (botRead && msg.key) {
                    try { await sock.readMessages([msg.key]) } catch (e) {}
                }
                if (botOnline) {
                    try { await sock.sendPresenceUpdate('available', from) } catch (e) {}
                }
                if (botDelay) await sleep(1500 + Math.random() * 2500)
                if (botTyping) {
                    try { await sock.sendPresenceUpdate('composing', from) } catch (e) {}
                }

                // ============ COMMAND DISPATCH ============
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

// ==================== WEB SERVER / DASHBOARD ====================

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0]

    if (url === '/' || url === '/dashboard') {
        const auth = req.headers.authorization
        if (!auth || !checkAuth(auth)) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SUKUNA REALM"' })
            res.end('Authentication required')
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
    const b64 = header.split(' ')[1]
    const [user, pass] = Buffer.from(b64, 'base64').toString().split(':')
    return pass === DASHBOARD_PASSWORD
}

server.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`)
    console.log(`Dashboard: http://localhost:${PORT}/dashboard (password: ${DASHBOARD_PASSWORD})`)
})
// ==================== COMMAND HANDLER ====================

async function handleCommand(sock, msg, from, isGroup, sender, senderNumber, owner, cmd, args, rawText) {
    const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg })
    const isAdmin = isGroup ? await checkAdmin(sock, from, sender) : false
    const prefix = botPrefix

    // ============ BASIC ============
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
        return reply(renderMenu())
    }

    if (cmd === 'mode') {
        if (!owner) return reply('❌ Owner only.')
        if (args[0] === 'public' || args[0] === 'private') {
            botMode = args[0]
            return reply(`✅ Mode set to *${botMode}*`)
        }
        return reply(`Current mode: *${botMode}*\nUsage: ${prefix}mode public/private`)
    }

    if (cmd === 'prefix') {
        if (!owner) return reply('❌ Owner only.')
        if (args[0]) {
            botPrefix = args[0]
            return reply(`✅ Prefix changed to *${botPrefix}*`)
        }
        return reply(`Current prefix: *${botPrefix}*`)
    }

    // ============ BAN-REDUCTION TOGGLES ============
    const toggles = {
        typing: () => botTyping, v => botTyping = v,
        delay: () => botDelay, v => botDelay = v,
        read: () => botRead, v => botRead = v,
        online: () => botOnline, v => botOnline = v,
        autoreact: () => botAutoReact, v => botAutoReact = v,
        statusview: () => botStatusView, v => botStatusView = v,
        autoview: () => botAutoView, v => botAutoView = v
    }
    if (toggles[cmd]) {
        if (!owner) return reply('❌ Owner only.')
        if (args[0] === 'on' || args[0] === 'off') {
            toggles[cmd](args[0] === 'on')
            return reply(`✅ *${cmd}* is now *${args[0]}*`)
        }
        return reply(`*${cmd}:* ${toggles[cmd]() ? 'on' : 'off'}\nUsage: ${prefix}${cmd} on/off`)
    }

    // ============ FUN ============
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
        const answers = ['Yes ✅', 'No ❌', 'Maybe 🤔', 'Ask later ⏳', 'Absolutely 💯', 'Doubtful 🙅', 'Good feeling 🌟', 'Very doubtful 😬']
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

    // ============ UTILITY ============
    if (cmd === 'calc') {
        try {
            const result = eval(args.join(' ').replace(/[^0-9+\-*/().]/g, ''))
            return reply(`🧮 *Result:* ${result}`)
        } catch { return reply('❌ Invalid math') }
    }

    if (cmd === 'sticker') {
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
        if (!quoted || !quoted.imageMessage) return reply('❌ Reply to an image.')
        try {
            const buffer = await downloadMediaMessage({ key: msg.key, message: quoted }, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
            return sock.sendMessage(from, { sticker: buffer }, { quoted: msg })
        } catch { return reply('❌ Failed to create sticker.') }
    }

    // ============ WARNING SYSTEM ============
    if (cmd === 'warn') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('❌ Mention a user.')
        if (!warningCounts[from]) warningCounts[from] = {}
        warningCounts[from][mentioned] = (warningCounts[from][mentioned] || 0) + 1
        const limit = warnLimit[from] || 3
        const count = warningCounts[from][mentioned]
        if (count >= limit) {
            try {
                await sock.groupParticipantsUpdate(from, [mentioned], 'remove')
                delete warningCounts[from][mentioned]
                return reply(`🚫 @${mentioned.split('@')[0]} has been kicked (${limit}/${limit} warnings).`)
            } catch { return reply('❌ Failed to kick user.') }
        }
        return reply(`⚠️ @${mentioned.split('@')[0]} has been warned (${count}/${limit}).`)
    }

    if (cmd === 'warncount') {
        if (!isGroup || !owner) return reply('❌ Owner only.')
        const num = parseInt(args[0])
        if (!num || num < 1) return reply('Usage: ' + prefix + 'warncount <number>')
        warnLimit[from] = num
        return reply(`✅ Warning limit set to *${num}*`)
    }

    if (cmd === 'warnlist') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        const list = warningCounts[from] || {}
        if (Object.keys(list).length === 0) return reply('✅ No warned users.')
        let out = '⚠️ *Warned Users:*\n\n'
        for (const [jid, count] of Object.entries(list)) {
            out += `@${jid.split('@')[0]}: ${count} warnings\n`
        }
        return sock.sendMessage(from, { text: out, mentions: Object.keys(list) })
    }

    if (cmd === 'resetwarn') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('❌ Mention a user.')
        if (warningCounts[from]) delete warningCounts[from][mentioned]
        return reply(`✅ Warnings reset for @${mentioned.split('@')[0]}`)
    }

    // ============ GROUP PROTECTION ============
    const protectCmds = ['antilink', 'antispam', 'antibot', 'antimedia', 'antitag', 'antidelete', 'antiforward']
    if (protectCmds.includes(cmd)) {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        if (!groupSettings[from]) groupSettings[from] = {}
        if (args[0] === 'on' || args[0] === 'off') {
            groupSettings[from][cmd] = args[0] === 'on'
            return reply(`✅ *${cmd}* is now *${args[0]}*`)
        }
        return reply(`*${cmd}:* ${groupSettings[from][cmd] ? 'on' : 'off'}\nUsage: ${prefix}${cmd} on/off`)
    }

    // ============ MEMBER MANAGEMENT ============
    if (cmd === 'kick') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('❌ Mention a user.')
        try { await sock.groupParticipantsUpdate(from, [mentioned], 'remove'); return reply(`✅ Kicked @${mentioned.split('@')[0]}`) }
        catch { return reply('❌ Failed.') }
    }

    if (cmd === 'add') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        if (!args[0]) return reply('Usage: ' + prefix + 'add <number>')
        try { await sock.groupParticipantsUpdate(from, [normalizeJid(args[0])], 'add'); return reply('✅ Added.') }
        catch { return reply('❌ Failed.') }
    }

    if (cmd === 'promote') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('❌ Mention a user.')
        try { await sock.groupParticipantsUpdate(from, [mentioned], 'promote'); return reply('✅ Promoted.') }
        catch { return reply('❌ Failed.') }
    }

    if (cmd === 'demote') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentioned) return reply('❌ Mention a user.')
        try { await sock.groupParticipantsUpdate(from, [mentioned], 'demote'); return reply('✅ Demoted.') }
        catch { return reply('❌ Failed.') }
    }

    if (cmd === 'mute' || cmd === 'unmute') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        try {
            await sock.groupSettingUpdate(from, cmd === 'mute' ? 'announcement' : 'not_announcement')
            return reply(`✅ Group ${cmd === 'mute' ? 'muted' : 'unmuted'}.`)
        } catch { return reply('❌ Failed.') }
    }

    // ============ COMMUNICATION ============
    if (cmd === 'tagall' || cmd === 'hidetag') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        const groupMeta = await sock.groupMetadata(from)
        const mentions = groupMeta.participants.map(p => p.id)
        const message = args.join(' ') || 'Attention everyone!'
        if (cmd === 'hidetag') {
            return sock.sendMessage(from, { text: message, mentions })
        }
        let out = '📢 *Tag All:*\n\n' + message + '\n\n'
        mentions.forEach(jid => { out += `@${jid.split('@')[0]} ` })
        return sock.sendMessage(from, { text: out, mentions })
    }

    // ============ GROUP INFO ============
    if (cmd === 'groupinfo') {
        if (!isGroup) return reply('❌ Group only.')
        const meta = await sock.groupMetadata(from)
        return reply(
            `╭━━━〔 *GROUP INFO* 〕━━━┈⊷\n` +
            `┃ 📛 *Name:* ${meta.subject}\n` +
            `┃ 👥 *Members:* ${meta.participants.length}\n` +
            `┃ 👑 *Admins:* ${meta.participants.filter(p => p.admin).length}\n` +
            `┃ 🆔 *ID:* ${meta.id}\n` +
            `╰━━━━━━━━━━━━━━━┈⊷`
        )
    }

    if (cmd === 'link') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        try { const code = await sock.groupInviteCode(from); return reply(`🔗 https://chat.whatsapp.com/${code}`) }
        catch { return reply('❌ Failed.') }
    }

    if (cmd === 'revoke') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        try { await sock.groupRevokeInvite(from); return reply('✅ Link revoked.') }
        catch { return reply('❌ Failed.') }
    }

    if (cmd === 'admins') {
        if (!isGroup) return reply('❌ Group only.')
        const meta = await sock.groupMetadata(from)
        const admins = meta.participants.filter(p => p.admin)
        let out = '👑 *Admins:*\n\n'
        admins.forEach(a => out += `@${a.id.split('@')[0]}\n`)
        return sock.sendMessage(from, { text: out, mentions: admins.map(a => a.id) })
    }

    if (cmd === 'members') {
        if (!isGroup) return reply('❌ Group only.')
        const meta = await sock.groupMetadata(from)
        let out = `👥 *Members (${meta.participants.length}):*\n\n`
        meta.participants.forEach(p => out += `@${p.id.split('@')[0]}\n`)
        return sock.sendMessage(from, { text: out, mentions: meta.participants.map(p => p.id) })
    }

    // ============ WELCOME / GOODBYE ============
    if (cmd === 'welcome' || cmd === 'goodbye') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        if (!welcomeSettings[from]) welcomeSettings[from] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
        if (args[0] === 'on' || args[0] === 'off') {
            welcomeSettings[from][cmd] = args[0] === 'on'
            return reply(`✅ *${cmd}* is now *${args[0]}*`)
        }
        return reply(`*${cmd}:* ${welcomeSettings[from][cmd] ? 'on' : 'off'}`)
    }

    if (cmd === 'setwelcome' || cmd === 'setgoodbye') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        const text = args.join(' ')
        if (!text) return reply('Usage: ' + prefix + cmd + ' <text>')
        if (!welcomeSettings[from]) welcomeSettings[from] = { welcome: false, goodbye: false, welcomeMsg: '', goodbyeMsg: '' }
        welcomeSettings[from][cmd === 'setwelcome' ? 'welcomeMsg' : 'goodbyeMsg'] = text
        return reply(`✅ Set.`)
    }

    // ============ POLLS ============
    if (cmd === 'poll') {
        if (!isGroup) return reply('❌ Group only.')
        const parts = args.join(' ').split('|').map(s => s.trim())
        if (parts.length < 3) return reply('Usage: ' + prefix + 'poll Question | Opt1 | Opt2')
        const [question, ...options] = parts
        activePolls[from] = { question, options, votes: {} }
        let out = `📊 *Poll:* ${question}\n\n`
        options.forEach((opt, i) => out += `${i + 1}. ${opt}\n`)
        out += `\nVote with ${prefix}vote <number>`
        return reply(out)
    }

    if (cmd === 'vote') {
        if (!activePolls[from]) return reply('❌ No active poll.')
        const num = parseInt(args[0]) - 1
        if (isNaN(num) || num < 0 || num >= activePolls[from].options.length) return reply('❌ Invalid vote.')
        activePolls[from].votes[sender] = num
        return reply(`✅ Voted for *${activePolls[from].options[num]}*`)
    }

    if (cmd === 'endpoll') {
        if (!isGroup || !isAdmin) return reply('❌ Admin only.')
        if (!activePolls[from]) return reply('❌ No active poll.')
        const poll = activePolls[from]
        const tally = {}
        poll.options.forEach((_, i) => tally[i] = 0)
        Object.values(poll.votes).forEach(v => tally[v]++)
        let out = `📊 *Poll Results:* ${poll.question}\n\n`
        poll.options.forEach((opt, i) => out += `${opt}: ${tally[i]} votes\n`)
        delete activePolls[from]
        return reply(out)
    }

    // ============ DOWNLOADERS ============
    if (cmd === 'tt') {
        return reply('⚠️ TikTok downloader is temporarily disabled. Coming soon.')
    }

    // Unknown command
    return reply(`❌ Unknown command: *${prefix}${cmd}*\nType ${prefix}menu for help.`)
}

async function checkAdmin(sock, groupJid, userJid) {
    try {
        const meta = await sock.groupMetadata(groupJid)
        const participant = meta.participants.find(p => p.id === userJid)
        return participant && participant.admin
    } catch { return false }
}

function formatUptime(sec) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return `${h}h ${m}m`
}

// ==================== MENU & DASHBOARD ====================

function renderMenu() {
    const d = new Date()
    return (
        `╭━━━━━━━〔 👹 ${BOT_NAME} 〕━━━━━━━╮\n\n` +
        `      ⚔️ BOT INFO ⚔️\n\n` +
        `👤 OWNER  : ${OWNER_NAME}\n` +
        `⚙️ MODE   : ${botMode}\n` +
        `🔧 PREFIX : ${botPrefix}\n` +
        `📅 DATE   : ${d.toLocaleDateString()}\n` +
        `🕐 TIME   : ${d.toLocaleTimeString()}\n` +
        `⏳ UPTIME : ${formatUptime(process.uptime())}\n\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `╭━━━〔 🛠️ BASIC 〕━━━┈⊷\n` +
        `┃ .ping .hello .time .date\n` +
        `┃ .info .menu .mode .prefix\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 🎉 FUN 〕━━━┈⊷\n` +
        `┃ .joke .quote .fact .dice .coin\n` +
        `┃ .truth .dare .roast .compliment\n` +
        `┃ .8ball .rate .ship\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 👁️ VIEW ONCE 〕━━━┈⊷\n` +
        `┃ .vv - reveal in chat\n` +
        `┃ .<emoji> - save to owner DM\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 📥 DOWNLOAD 〕━━━┈⊷\n` +
        `┃ .tt <tiktok url>\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 🛡️ BAN-REDUCTION 〕━━━┈⊷\n` +
        `┃ .typing .delay .read .online\n` +
        `┃ .autoreact .statusview .autoview\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 ⚠️ WARN SYSTEM 〕━━━┈⊷\n` +
        `┃ .warn @user .warncount <n>\n` +
        `┃ .warnlist .resetwarn @user\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 🛡️ GROUP PROTECT 〕━━━┈⊷\n` +
        `┃ .antilink .antispam .antibot\n` +
        `┃ .antimedia .antitag .antidelete\n` +
        `┃ .antiforward\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 👥 MEMBERS 〕━━━┈⊷\n` +
        `┃ .kick .add .promote .demote\n` +
        `┃ .mute .unmute\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 📢 COMMUNICATION 〕━━━┈⊷\n` +
        `┃ .tagall .hidetag\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 📊 GROUP INFO 〕━━━┈⊷\n` +
        `┃ .groupinfo .link .revoke\n` +
        `┃ .admins .members\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 🎉 WELCOME 〕━━━┈⊷\n` +
        `┃ .welcome .goodbye\n` +
        `┃ .setwelcome .setgoodbye\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 📊 POLLS 〕━━━┈⊷\n` +
        `┃ .poll .vote .endpoll\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 🛠️ UTILITY 〕━━━┈⊷\n` +
        `┃ .calc .sticker\n` +
        `╰━━━━━━━━━━━━━━━┈⊷\n\n` +
        `⚔️ POWERED BY ${BOT_NAME} ⚔️`
    )
}

function renderDashboard() {
    let sessionRows = ''
    for (const [id, s] of Object.entries(sessions)) {
        sessionRows += `<tr>
            <td>${s.number}</td>
            <td>${s.status}</td>
            <td>${s.connectedAt ? new Date(s.connectedAt).toLocaleString() : '-'}</td>
            <td>${s.pairingCode || '-'}</td>
            <td>
                <form method="POST" style="display:inline">
                    <input type="hidden" name="action" value="disconnect">
                    <input type="hidden" name="number" value="${s.number}">
                    <button type="submit">Disconnect</button>
                </form>
            </td>
        </tr>`
    }
    if (!sessionRows) sessionRows = '<tr><td colspan="5">No sessions yet</td></tr>'

    return `<!DOCTYPE html>
<html><head><title>${BOT_NAME} Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:Arial;background:#0a0a0a;color:#eee;padding:20px;max-width:900px;margin:auto}
h1{color:#ff4444}
.card{background:#1a1a1a;padding:20px;border-radius:10px;margin:15px 0;border:1px solid #333}
input,button{padding:10px;font-size:16px;border-radius:5px;border:1px solid #444;background:#222;color:#eee;margin:5px 0;width:100%;box-sizing:border-box}
button{background:#ff4444;border:none;cursor:pointer;font-weight:bold}
button:hover{background:#cc0000}
table{width:100%;border-collapse:collapse;margin-top:10px}
th,td{padding:8px;border-bottom:1px solid #333;text-align:left;font-size:13px}
th{background:#222}
.code{font-size:24px;font-weight:bold;color:#00ff88;letter-spacing:3px}
</style></head><body>
<h1>👹 ${BOT_NAME}</h1>
<div class="card">
<h3>📊 Bot Info</h3>
<p><b>Owner:</b> ${OWNER_NAME}</p>
<p><b>Mode:</b> ${botMode} | <b>Prefix:</b> ${botPrefix}</p>
<p><b>Uptime:</b> ${formatUptime(process.uptime())}</p>
<p><b>Sessions:</b> ${Object.keys(sessions).length}</p>
</div>
<div class="card">
<h3>🔗 Connect a WhatsApp Number</h3>
<form method="POST">
<input type="hidden" name="action" value="connect">
<input type="text" name="number" placeholder="Enter number with country code (e.g. 2348139761928)" required>
<button type="submit">Generate Pairing Code</button>
</form>
<p style="font-size:12px;color:#999">After submitting, wait ~5 seconds and refresh this page to see the pairing code below.</p>
</div>
<div class="card">
<h3>📱 Connected Sessions</h3>
<table>
<tr><th>Number</th><th>Status</th><th>Connected</th><th>Pairing Code</th><th>Action</th></tr>
${sessionRows}
</table>
<p style="font-size:12px;color:#999">To link: WhatsApp → Linked Devices → Link with phone number → enter code above</p>
</div>
</body></html>`
}

// ==================== AUTO-START SAVED SESSIONS ====================

async function restoreSessions() {
    if (!fs.existsSync(SESSION_DIR)) return
    const dirs = fs.readdirSync(SESSION_DIR).filter(d => d.startsWith('sess_'))
    for (const dir of dirs) {
        const number = dir.replace('sess_', '')
        console.log(`Restoring session: ${number}`)
        try { await startSession(dir, number) } catch (e) { console.log('Restore error:', e.message) }
    }
}

restoreSessions().catch(e => console.log('Restore failed:', e.message))
