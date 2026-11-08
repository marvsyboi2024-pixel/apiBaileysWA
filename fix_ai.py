import re, os, shutil

FILE = 'bot.js'
if not os.path.exists(FILE):
    print('[!] bot.js not found in this folder'); raise SystemExit(1)
if not os.path.exists('bot.before-aifix.js'):
    shutil.copy(FILE, 'bot.before-aifix.js')
src = open(FILE, encoding='utf-8').read()
warns = 0
BLOCKS = [
(r"""function srOwnerKeywords(C, text) {""", r"""/* ---------- AI knowledge helpers ---------- */""", r"""function srOwnerKeywords(C, text) {
    if (!SR_OWN.configured()) return null
    const ck = C.ck, ip = C.ip, st = SR_OWN.state(ck), t = SR_OWN.norm(text)
    const grant = (id, newTrust) => {
        const cs = [SR_OWN.cookie('sr_om', SR_OWN.mk('o:' + id, 1), 1), SR_OWN.cookie('sr_op', '', 0)]
        if (newTrust) cs.push(SR_OWN.cookie('sr_ot', SR_OWN.mk('t:' + id, 720), 720))
        return cs
    }
    if (st.pw) {
        if (srLocked(ip)) return { answer: 'Too many attempts. Try again in 15 minutes.', cookies: [SR_OWN.cookie('sr_op', '', 0)], owner: false }
        if (SR_OWN.check(text, process.env.OWNER_PASS_HASH)) {
            global.__ownFail && delete global.__ownFail[ip]
            const id = st.trusted || crypto.randomBytes(8).toString('hex')
            return { answer: 'Owner mode is on. This browser is remembered, so next time just say: owner mode.', cookies: grant(id, true), owner: true }
        }
        srFail(ip)
        return { answer: 'That is not right.', cookies: [SR_OWN.cookie('sr_op', '', 0)], owner: false }
    }
    const isOn = /^(owner|developer|dev)( mode)?$/.test(t)
    const isOff = /^(exit|leave|quit|stop|end|disable|close|turn off)( the)? (owner|developer|dev)( mode)?$/.test(t) || /^(owner|developer|dev)( mode)? (off|exit)$/.test(t)
    if (isOn && st.trusted) {
        if (srLocked(ip)) return { answer: 'Too many attempts. Try again in 15 minutes.', cookies: [], owner: false }
        return { answer: st.on ? 'Owner mode is already on.' : 'Owner mode is on.', cookies: grant(st.trusted, false), owner: true }
    }
    if (isOff && (st.on || st.trusted)) return { answer: st.on ? 'Owner mode is off.' : 'Owner mode is already off.', cookies: [SR_OWN.cookie('sr_om', '', 0)], owner: false }
    if (t === 'forget this device' && (st.on || st.trusted)) return { answer: 'This browser is forgotten. Owner mode is off.', cookies: [SR_OWN.cookie('sr_om', '', 0), SR_OWN.cookie('sr_ot', '', 0)], owner: false }
    if (SR_OWN.check(t, process.env.OWNER_PHRASE_HASH)) {
        if (srLocked(ip)) return { answer: 'Too many attempts. Try again in 15 minutes.', cookies: [], owner: false }
        return { answer: 'Password?', cookies: [SR_OWN.cookie('sr_op', SR_OWN.mk('pw', 0.1), 0.1)], mode: 'password', owner: false }
    }
    return null
}

"""),
(r"""const SR_PUBLIC_PROMPT = () =>""", r"""const SR_TOOLS_PUBLIC = [""", r"""const SR_PUBLIC_PROMPT = () =>
    'You are the Realm Assistant inside the SUKUNA REALM WhatsApp bot dashboard. You ONLY help with this bot and this dashboard: what commands do, how to use settings, how to connect a number, themes, groups, the Wishes page, and fixing problems with them. '
    + 'Be precise and short: usually 2 to 5 sentences, no filler, no greetings unless greeted. Plain text only: no markdown, no asterisks, no backticks, no headings. For steps, write lines like 1) 2) 3). '
    + 'Do NOT write code and do NOT explain how to build WhatsApp bots or anything unrelated; for that, say in one sentence that you can only help with this bot and dashboard. '
    + 'The dashboard menu has ONLY these pages: Home, Connect, Sessions, Commands, Settings, Groups, Logs, Media, API Keys, Analytics, Templates, Themes, Wishes, Contact owner. Never invent buttons, tabs or settings outside that list. '
    + 'If you are not sure about a command detail, say so plainly instead of guessing. '
    + 'You can NOT turn owner mode or any mode on or off, and you must never say that you did. Never claim an action happened unless a tool result says so. '
    + 'You can act on the dashboard when the user explicitly asks (change theme, text colour, light or dark mode, open a page, connect or disconnect their number, change a setting): use the tools for that. Never use a tool unless the user clearly asked. '
    + 'Commands of this bot:\n' + srCatalogText()
const SR_OWNER_PROMPT = () =>
    'You are the Realm Assistant in OWNER MODE for the SUKUNA REALM WhatsApp bot (Node.js, Baileys, one bot.js file plus dashboard.html). The person talking to you is the verified owner. '
    + 'Answer precisely. Plain text only in chat, no markdown. You may write code snippets when asked. '
    + 'You can NOT turn owner mode on or off, and you must never say that you did: the owner does that by typing "owner mode" or "exit owner mode". Never claim an action happened unless a tool result says so. '
    + 'You can use tools for dashboard actions and owner actions (block, unblock, kill session, maintenance, owner-only, free memory) but ONLY when the owner clearly asks. '
    + 'If the owner wants a new command, tell them to say: create a command. If they want to change bot.js or the dashboard, tell them to say what to change, starting with: edit. '
    + 'Commands of this bot:\n' + srCatalogText()

"""),
(r"""function srApplyOps(files, ops) {""", r"""function srRunNodeCheck(""", r"""function srApplyOps(files, ops) {
    const out = Object.assign({}, files), ranges = {}
    for (const op of ops) {
        let f = String(op.file || '')
        if (!SR_FILES[f] || out[f] === undefined) throw new Error('Unknown file: ' + f)
        let src = out[f]
        let anchor = op.find !== undefined ? op.find : (op.after !== undefined ? op.after : op.before)
        if (typeof anchor !== 'string' || !anchor) throw new Error('An edit has no anchor text.')
        let first = src.indexOf(anchor)
        if (first < 0 && anchor.trim() !== anchor && anchor.trim() && src.indexOf(anchor.trim()) >= 0) { anchor = anchor.trim(); first = src.indexOf(anchor); if (op.find !== undefined) op.find = anchor; else if (op.after !== undefined) op.after = anchor; else op.before = anchor }
        if (first < 0) {
            const alts = Object.keys(out).filter(k => k !== f && out[k] !== undefined && out[k].indexOf(anchor) >= 0)
            if (alts.length === 1) { f = alts[0]; src = out[f]; first = src.indexOf(anchor); op.file = f }
        }
        if (first < 0) throw new Error('Anchor text not found in ' + f + ': ' + anchor.slice(0, 60))
        if (src.indexOf(anchor, first + 1) >= 0) throw new Error('Anchor text is not unique in ' + f + ': ' + anchor.slice(0, 60))
        const text = String(op.replace !== undefined ? op.replace : op.text || '')
        if (f === 'bot.js' && first < srProtectedEnd(src)) throw new Error('That edit touches the protected start of bot.js.')
        let at, len
        if (op.find !== undefined) { src = src.slice(0, first) + text + src.slice(first + anchor.length); at = first; len = text.length }
        else if (op.after !== undefined) { const p = first + anchor.length; src = src.slice(0, p) + text + src.slice(p); at = p; len = text.length }
        else { src = src.slice(0, first) + text + src.slice(first); at = first; len = text.length }
        out[f] = src
        ;(ranges[f] = ranges[f] || []).push([at, at + len])
    }
    return { files: out, ranges }
}
"""),
(r"""function srCheckDashboard(html) {""", r"""async function srValidate(""", r"""function srCheckDashboard(html) {
    const problems = []
    const scripts = []
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
    let m; while ((m = re.exec(html))) scripts.push(m[1])
    const ids = new Set(); const ire = /\bid="([^"]+)"/g; while ((m = ire.exec(html))) ids.add(m[1])
    const missing = new Set(); const gre = /(?:getElementById|\$)\('([^']+)'\)/g
    for (const s of scripts) while ((m = gre.exec(s))) if (!ids.has(m[1])) missing.add(m[1])
    return { scripts, missing: [...missing] }
}
"""),
(r"""async function srPlanEdit(request, files) {""", r"""async function srStageAndCheck(""", r"""async function srPlanEdit(request, files) {
    const outline = {
        'bot.js': (files['bot.js'].match(/^(?:async )?function [A-Za-z0-9_]+|^const [A-Z_]{3,}\b|^        if \(url === '[^']+'/gm) || []).slice(0, 220).join('\n'),
        'dashboard.html': (files['dashboard.html'].match(/id="page-[a-z]+"|^function [A-Za-z0-9_]+|^async function [A-Za-z0-9_]+/gm) || []).slice(0, 220).join('\n')
    }
    const a = await srModel([{ role: 'system', content: 'You help edit a Node.js WhatsApp bot (bot.js) and its dashboard (dashboard.html). Given an edit request and an outline of both files, return ONLY JSON: {"search":[{"file":"bot.js","text":"exact text to look for"}]} with up to 4 short exact strings (function names, ids, route names) whose surrounding code you need to see.' }, { role: 'user', content: 'Request: ' + request + '\n\nOUTLINE bot.js:\n' + outline['bot.js'] + '\n\nOUTLINE dashboard.html:\n' + outline['dashboard.html'] }], 700)
    const wants = (srJsonFrom(a).search || []).slice(0, 4), ctxText = []
    const qre = /["\u201c\u201d]([^"\u201c\u201d\n]{6,200})["\u201c\u201d]/g
    let qm
    while ((qm = qre.exec(request))) {
        for (const fk of ['dashboard.html', 'bot.js']) {
            const f = files[fk]; if (!f) continue
            const i = f.indexOf(qm[1]); if (i < 0) continue
            const s0 = f.lastIndexOf('\n', Math.max(0, i - 800)), e0 = f.indexOf('\n', Math.min(f.length - 1, i + 1200))
            ctxText.unshift('--- ' + fk + ' (this file contains the quoted text "' + qm[1].slice(0, 50) + '"; edit THIS file) ---\n' + f.slice(s0 < 0 ? 0 : s0, e0 < 0 ? f.length : e0))
        }
    }
    for (const w of wants) {
        const f = files[w.file]; if (!f || !w.text) continue
        const i = f.indexOf(String(w.text)); if (i < 0) continue
        const s = f.lastIndexOf('\n', Math.max(0, i - 1200)), e = f.indexOf('\n', Math.min(f.length - 1, i + 2200))
        ctxText.push('--- ' + w.file + ' (around "' + w.text + '") ---\n' + f.slice(s < 0 ? 0 : s, e < 0 ? f.length : e))
    }
    const sys = 'You edit a Node.js WhatsApp bot (bot.js) and its dashboard (dashboard.html). ' + SR_CODE_RULES + ' Return ONLY JSON: {"title":"short title","ops":[{"file":"bot.js","find":"EXACT existing text, unique in the file","replace":"new text"}, {"file":"dashboard.html","after":"EXACT anchor text","text":"text to insert"}]}. Use "find"+"replace" to change text, "after"+"text" or "before"+"text" to insert. Anchors must be copied exactly from the provided code and occur once. Never touch the first lines of bot.js (DNS block). Keep edits small.'
    const out = await srModel([{ role: 'system', content: sys }, { role: 'user', content: 'Request: ' + request + '\n\nCODE:\n' + ctxText.join('\n\n') }], 3500)
    const j = srJsonFrom(out)
    if (!Array.isArray(j.ops) || !j.ops.length) throw new Error('The model returned no edits.')
    return j
}
""")
]
LABELS = ['owner on/off phrases (Exit owner, Developer mode ...)', 'assistant rules: never claim to switch modes', 'edits: fixes a wrongly named file and sloppy spaces', 'dashboard check also reads $(\'id\') calls', 'edits: finds quoted text in the real files first']
for (a, b, new), label in zip(BLOCKS, LABELS):
    i = src.find(a)
    j = src.find(b, i) if i >= 0 else -1
    if i < 0 or j < 0:
        print('[WARN] ' + label + ' (not found - this file is not the expected version)'); warns += 1; continue
    if src[i:j] == new:
        print('[OK]   ' + label + ' (already updated)'); continue
    src = src[:i] + new + src[j:]
    print('[OK]   ' + label)
open(FILE, 'w', encoding='utf-8').write(src)
print('\nDone. %d warning(s).' % warns)
