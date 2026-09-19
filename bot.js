const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const P = require('pino')
const http = require('http')

const jokes = [
    'Why did the developer go broke? Because he used up all his cache! 💸',
    'Why do programmers prefer dark mode? Because light attracts bugs! 🐛',
    'I would tell you a UDP joke, but you might not get it. 📡',
    'Why did the Java developer wear glasses? Because he could not C#. 👓'
]

const quotes = [
    'The only way to do great work is to love what you do. — Steve Jobs',
    'Believe you can and you are halfway there. — Theodore Roosevelt',
    'It always seems impossible until it is done. — Nelson Mandela',
    'The future belongs to those who believe in the beauty of their dreams. — Eleanor Roosevelt'
]

const facts = [
    'Honey never spoils. Archaeologists have found 3000-year-old honey in Egyptian tombs that is still edible. 🍯',
    'Octopuses have three hearts and blue blood. 🐙',
    'A day on Venus is longer than a year on Venus. 🪐',
    'Bananas are berries, but strawberries are not. 🍌'
]

function getRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)]
}

// Tiny web server so Render sees an open port
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Bot is running!\n')
}).listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`)
})

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' })
    })
    
    sock.ev.on('creds.update', saveCreds)
    
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            if (code !== DisconnectReason.loggedOut) {
                console.log('Reconnecting...')
                startBot()
            } else {
                console.log('Logged out.')
            }
        } else if (connection === 'open') {
            console.log('✅ Bot is connected!')
        }
    })
    
    if (!sock.authState.creds.registered) {
        const phoneNumber = '2348139761928'
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber)
                console.log(`\n🔑 YOUR PAIRING CODE: ${code}\n`)
                console.log('Go to WhatsApp > Linked Devices > Link with phone number instead')
            } catch (err) {
                console.log('Error getting pairing code:', err.message)
            }
        }, 3000)
    }
    
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        
        for (const msg of messages) {
            if (!msg.message) continue
            
            const text = msg.message.conversation ||
                         msg.message.extendedTextMessage?.text || ''
            const lowerText = text.toLowerCase().trim()
            const jid = msg.key.remoteJid
            
            console.log('Received:', text)
            
            if (lowerText === '!ping') {
                await sock.sendMessage(jid, { text: 'pong 🏓' })
            }
            
            if (lowerText === '!hello') {
                await sock.sendMessage(jid, { text: 'Hey there! 👋 I am your bot.' })
            }
            
            if (lowerText === '!time') {
                const now = new Date()
                await sock.sendMessage(jid, { text: `🕐 Time: ${now.toLocaleTimeString()}` })
            }
            
            if (lowerText === '!date') {
                const now = new Date()
                await sock.sendMessage(jid, { text: `📅 Date: ${now.toLocaleDateString()}` })
            }
            
            if (lowerText === '!joke') {
                await sock.sendMessage(jid, { text: '😄 ' + getRandom(jokes) })
            }
            
            if (lowerText === '!quote') {
                await sock.sendMessage(jid, { text: '💬 ' + getRandom(quotes) })
            }
            
            if (lowerText === '!fact') {
                await sock.sendMessage(jid, { text: '🧠 ' + getRandom(facts) })
            }
            
            if (lowerText === '!dice') {
                const roll = Math.floor(Math.random() * 6) + 1
                await sock.sendMessage(jid, { text: `🎲 You rolled a ${roll}!` })
            }
            
            if (lowerText === '!coin') {
                const result = Math.random() < 0.5 ? 'Heads' : 'Tails'
                await sock.sendMessage(jid, { text: `🪙 ${result}!` })
            }
            
            if (lowerText.startsWith('!8ball')) {
                const answers = [
                    'Yes, definitely! ✅', 'No way. ❌', 'Maybe... 🤔',
                    'Ask again later. ⏳', 'Absolutely! 💯', 'Not looking good. 😬',
                    'I have a good feeling about this. 🌟', 'Very doubtful. 🙅'
                ]
                await sock.sendMessage(jid, { text: '🎱 ' + getRandom(answers) })
            }
            
            if (lowerText === '!help' || lowerText === '!menu') {
                const menu = `📋 *MY BOT COMMANDS*\n\n` +
                    `🟢 *Basic*\n` +
                    `!ping - Check if bot is alive\n` +
                    `!hello - Say hello\n` +
                    `!time - Show current time\n` +
                    `!date - Show today's date\n` +
                    `!help / !menu - Show this menu\n\n` +
                    `🎉 *Fun*\n` +
                    `!joke - Random joke\n` +
                    `!quote - Motivational quote\n` +
                    `!fact - Fun fact\n` +
                    `!dice - Roll a dice\n` +
                    `!coin - Flip a coin\n` +
                    `!8ball <question> - Magic 8-ball`
                await sock.sendMessage(jid, { text: menu })
            }
        }
    })
}

startBot()
