const CATS = [
    ['basic', '⚡ Basic', 'Basic commands'],
    ['cursed', '𖦹 Cursed Arts', 'Cursed techniques'],
    ['fun', '🎮 Fun', 'Fun commands'],
    ['group', '👥 Group', 'Group tools'],
    ['utility', '🛠️ Utility', 'Utilities'],
    ['ai', '🤖 AI', 'AI features'],
    ['games', '🎲 Games', 'Play games'],
    ['dl', '📥 Downloader', 'Download tools'],
    ['owner', '⚙️ Owner', 'Owner settings']
]

const CMDS = {
    basic: [
        ['ping', 'Check status'],
        ['alive', 'Say hi'],
        ['time', 'Date + time'],
        ['info', 'Bot info'],
        ['status', 'Full status'],
        ['system', 'System info'],
        ['throne', 'Owner info'],
        ['command', 'Explain a command'],
        ['menu', 'Text menu'],
        ['mode', 'public/private'],
        ['prefix', 'Change prefix']
    ],
    cursed: [
        ['domain', 'Domain event'],
        ['oracle', 'Prediction'],
        ['ritual', 'Interactive ritual'],
        ['awakening', 'Shrine sequence'],
        ['omen', 'Random sign'],
        ['curse', 'Curse a user'],
        ['tribute', 'Give a title'],
        ['verdict', 'Themed verdict'],
        ['sukuna', 'Signature line'],
        ['technique', 'Random technique'],
        ['power', 'Power level'],
        ['cursedenergy', 'Read energy'],
        ['fate', 'Random fate']
    ],
    fun: [
        ['joke', 'Random joke'],
        ['quote', 'Motivation'],
        ['fact', 'Fun fact'],
        ['dice', 'Roll a dice'],
        ['coin', 'Flip a coin'],
        ['truth', 'Truth question'],
        ['dare', 'Dare challenge'],
        ['roast', 'Roast someone'],
        ['compliment', 'Compliment'],
        ['8ball', 'Magic 8-ball'],
        ['rate', 'Rate a thing'],
        ['ship', 'Compatibility'],
        ['insult', 'Yab someone'],
        ['wyr', 'Would you rather'],
        ['story', 'Start a story'],
        ['riddle', 'Start riddle'],
        ['hbd', 'Birthday msg']
    ],
    group: [
        ['kick', 'Remove user'],
        ['add', 'Add member'],
        ['promote', 'Make admin'],
        ['demote', 'Remove admin'],
        ['demoteall', 'Demote all admins'],
        ['warn', 'Warn a user'],
        ['warncount', 'Set warn limit'],
        ['warnlist', 'List warned'],
        ['resetwarn', 'Clear warnings'],
        ['mute', 'Lock chat'],
        ['unmute', 'Unlock chat'],
        ['pin', 'Pin message'],
        ['del', 'Delete message'],
        ['tagall', 'Tag everyone'],
        ['hidetag', 'Silent tag'],
        ['tagadmins', 'Tag admins'],
        ['setname', 'Set group name'],
        ['setdesc', 'Set group description'],
        ['setwelcome', 'Set welcome msg'],
        ['setgoodbye', 'Set goodbye msg'],
        ['setrules', 'Set rules'],
        ['rules', 'Show rules'],
        ['groupinfo', 'Group details'],
        ['grouppp', 'Group permissions'],
        ['admins', 'List admins'],
        ['members', 'List members'],
        ['invitelink', 'Send invite link'],
        ['revoke', 'Reset invite link'],
        ['requests', 'Join requests'],
        ['poll', 'Create poll'],
        ['vote', 'Vote poll'],
        ['events', 'Events menu'],
        ['lockdown', 'Enable all filters'],
        ['unlockdown', 'Disable all filters'],
        ['antilink', 'Block links'],
        ['antispam', 'Block spam'],
        ['antimedia', 'Block media'],
        ['antitag', 'Block tags'],
        ['antiforward', 'Block forwards'],
        ['antibadword', 'Block bad words'],
        ['antibilling', 'Anti-billing'],
        ['slowmode', 'Slow chat'],
        ['votekick', 'Vote to kick']
    ],
    utility: [
        ['calc', 'Calculate math'],
        ['sticker', 'Make sticker'],
        ['toimg', 'Sticker to image'],
        ['qr', 'Generate QR'],
        ['weather', 'Weather lookup'],
        ['translate', 'Translate text'],
        ['tr', 'Translate replied msg'],
        ['mylang', 'Set language'],
        ['shorten', 'Shorten URL'],
        ['ip', 'IP lookup'],
        ['whois', 'Domain lookup'],
        ['walink', 'WA chat link'],
        ['vcard', 'Contact file'],
        ['afk', 'Mark away'],
        ['back', 'Mark back'],
        ['profile', 'User profile']
    ],
    ai: [
        ['ai', 'Ask Groq AI']
    ],
    games: [
        ['games', 'Game menu'],
        ['snake', 'Snake'],
        ['dino', 'Dino Runner'],
        ['flappy', 'Flappy Bird'],
        ['fishing', 'Fishing Master'],
        ['blockblast', 'Block Blast'],
        ['ttt', 'Tic-Tac-Toe'],
        ['minesweeper', 'Minesweeper'],
        ['slots', 'Slots'],
        ['piano', 'Piano'],
        ['drum', 'Drum Hero'],
        ['guitar', 'Guitar'],
        ['subway', 'Subway Surf'],
        ['arena', 'M.K. Arena'],
        ['overdrive', 'M.K. Overdrive']
    ],
    dl: [
        ['tt', 'TikTok download'],
        ['backup', 'Bot backup']
    ],
    owner: [
        ['typing', 'Typing toggle'],
        ['delay', 'Delay toggle'],
        ['delaytime', 'Delay seconds'],
        ['read', 'Read toggle'],
        ['online', 'Online toggle'],
        ['statusview', 'View statuses'],
        ['autoreact', 'Auto react'],
        ['statusreact', 'React to statuses'],
        ['broadcast1', 'DM one number'],
        ['bg', 'Broadcast to group'],
        ['newgc', 'Create a group'],
        ['clearcache', 'Clear caches'],
        ['grouplist', 'List all groups'],
        ['getlink', 'Group link by name']
    ]
}

async function sendMain(sock, from) {
    const head = String.fromCodePoint(0x2726)
    const bar = String.fromCharCode(0x2500)
    const title = head + bar + bar + bar + ' ' + mono('SUKUNA REALM') + ' ' + bar + bar + bar + head
    const body = mono('The realm awaits.') + '\n' + mono('Pick a path.')
    const footer = mono('A TRUE KING NEEDS NO CROWN.')
    const buttonText = mono('Summon Menu')
    const rows = CATS.map(c => ({
        title: c[1].split(' ')[0] + ' ' + mono(c[1].split(' ').slice(1).join(' ')),
        description: mono(c[2]),
        rowId: 'menu2:cat:' + c[0]
    }))
    await sock.sendMessage(from, {
        text: body,
        title: title,
        footer: footer,
        buttonText: buttonText,
        sections: [{ title: mono('MAIN MENU'), rows: rows }]
    })
}

function mono(text) {
    const OFFSET = 0x1D670
    return String(text).replace(/[A-Za-z]/g, (ch) => {
        const u = ch.charCodeAt(0)
        if (u >= 65 && u <= 90) return String.fromCodePoint(OFFSET + (u - 65))
        if (u >= 97 && u <= 122) return String.fromCodePoint(OFFSET + 26 + (u - 97))
        return ch
    })
}

async function sendCategory(sock, from, cat, prefix) {
    const cmds = CMDS[cat]
    if (!cmds) return
    const meta = CATS.find(c => c[0] === cat)
    const p = prefix || '.'

    let out = '𖥔 ── ' + mono('SUKUNA REALM') + ' ── 𖥔\n\n'
    out += (meta ? meta[1] : 'MENU') + ' ' + mono('COMMANDS') + '\n\n'
    for (const c of cmds) {
        out += '» ' + p + mono(c[0]) + '  •  ' + mono(c[1]) + '\n'
    }
    out += '\n𖥔 ' + mono('A TRUE KING NEEDS NO CROWN.') + ' 𖥔'

    await sock.sendMessage(from, { text: out })
}

function getResponse(content) {
    if (!content) return null
    if (content.listResponseMessage?.singleSelectReply?.selectedRowId)
        return content.listResponseMessage.singleSelectReply.selectedRowId
    if (content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        try {
            const p = JSON.parse(content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)
            return p.id || p.selectedId || null
        } catch (e) { return null }
    }
    if (content.templateButtonReplyMessage?.selectedId)
        return content.templateButtonReplyMessage.selectedId
    return null
}

module.exports = { sendMain, sendCategory, getResponse }
