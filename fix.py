import re, os, shutil, subprocess, tempfile

BOT, DASH = 'bot.js', 'dashboard.html'
if not (os.path.exists(BOT) and os.path.exists(DASH)):
    print('[!] Run this inside ~/apiBaileysWA (bot.js and dashboard.html must be here)'); raise SystemExit(1)
for f, b in ((BOT, 'bot.before-v2.js'), (DASH, 'dashboard.before-v2.html')):
    if not os.path.exists(b): shutil.copy(f, b)
bot = open(BOT, encoding='utf-8').read()
dash = open(DASH, encoding='utf-8').read()
warns = 0

def ok(m): print('[OK]   ' + m)
def warn(m):
    global warns; warns += 1; print('[WARN] ' + m)

def rep(src, old, new, label, every=False):
    n = src.count(old)
    if n == 0:
        if new in src: ok(label + ' (already done)')
        else: warn(label + ' (text not found)')
        return src
    ok(label + (' x%d' % n if every and n > 1 else ''))
    return src.replace(old, new) if every else src.replace(old, new, 1)

def block(src, start, end, new, label):
    if new in src:
        ok(label + ' (already done)'); return src
    i = src.find(start)
    if i < 0: warn(label + ' (start not found)'); return src
    j = src.find(end, i + len(start))
    if j < 0: warn(label + ' (end not found)'); return src
    ok(label)
    return src[:i] + new + src[j:]

# =====================================================================
# bot.js
# =====================================================================

AI_LAYER = r"""/* ===== SR MULTI-AI: parallel race of two providers, automatic replacement, merged answer ===== */
const SR_AI = [
    { id: 'groq', rank: 1, tools: true, key: () => global.__GROQ__, url: () => 'https://api.groq.com/openai/v1/chat/completions' },
    { id: 'gemini', rank: 2, tools: true, key: () => getKey('GEMINI_API_KEY'), url: () => 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', models: ['gemini-2.5-flash', 'gemini-2.0-flash'] },
    { id: 'cerebras', rank: 3, tools: true, key: () => getKey('CEREBRAS_API_KEY'), url: () => 'https://api.cerebras.ai/v1/chat/completions', models: ['gpt-oss-120b', 'llama-3.3-70b', 'llama3.1-8b'] },
    { id: 'mistral', rank: 4, tools: true, key: () => getKey('MISTRAL_API_KEY'), url: () => 'https://api.mistral.ai/v1/chat/completions', models: ['mistral-large-latest', 'mistral-small-latest'] },
    { id: 'openrouter', rank: 5, tools: true, key: () => getKey('OPENROUTER_API_KEY'), url: () => 'https://openrouter.ai/api/v1/chat/completions', headers: { 'HTTP-Referer': 'https://apibaileyswa.skyhost.tech', 'X-Title': 'Sukuna Realm' }, models: ['meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-120b:free', 'google/gemma-3-27b-it:free'] },
    { id: 'nvidia', rank: 6, tools: false, key: () => getKey('NVIDIA_API_KEY'), url: () => 'https://integrate.api.nvidia.com/v1/chat/completions', models: ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-70b-instruct'] },
    { id: 'cloudflare', rank: 7, tools: false, key: () => (getKey('CLOUDFLARE_API_TOKEN') && getKey('CLOUDFLARE_ACCOUNT_ID')) ? getKey('CLOUDFLARE_API_TOKEN') : '', url: () => 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(getKey('CLOUDFLARE_ACCOUNT_ID')) + '/ai/v1/chat/completions', models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-120b'] },
    { id: 'huggingface', rank: 8, tools: false, key: () => getKey('HF_TOKEN'), url: () => 'https://router.huggingface.co/v1/chat/completions', models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'] }
]
function srAvail(needTools) {
    const st = global.__srAiState = global.__srAiState || {}
    const has = SR_AI.filter(p => { try { return !!p.key() } catch (e) { return false } })
    let ok = has.filter(p => !(st[p.id] && st[p.id].until > Date.now()))
    if (!ok.length) ok = has
    ok = ok.slice().sort((a, b) => a.rank - b.rank)
    if (needTools) ok = ok.filter(p => p.tools).concat(ok.filter(p => !p.tools))
    return ok
}
function srMark(p, e, good) {
    const st = global.__srAiState = global.__srAiState || {}
    const s = st[p.id] = st[p.id] || { until: 0 }
    if (good) { s.until = 0; return }
    const m = String(e && e.message || e)
    let ms = 20000
    if (/HTTP (401|403)/.test(m)) ms = 600000
    else if (/HTTP 429/.test(m)) ms = 60000
    else if (/HTTP 5\d\d|timeout/i.test(m)) ms = 30000
    s.until = Date.now() + ms
    console.log('[AI] ' + p.id + ' failed, skipped for ' + Math.round(ms / 1000) + 's: ' + m.slice(0, 140))
}
async function srCall(p, o) {
    const key = String(p.key() || '')
    const headers = Object.assign({ 'Authorization': 'Bearer ' + key }, p.headers || {})
    const body = { temperature: o.temperature == null ? 0.3 : o.temperature, max_tokens: o.maxTokens || 1200, messages: o.messages }
    if (o.tools && p.tools) { body.tools = o.tools; body.tool_choice = 'auto' }
    const timeout = o.timeout || 28000
    let out
    if (p.id === 'groq') out = await groqPost(p.url(), Object.assign({ model: 'auto' }, body), headers, timeout)
    else {
        const forced = getKey(p.id.toUpperCase() + '_MODEL')
        const list = (forced ? [forced] : []).concat(p.models || []).slice(0, 3)
        let last
        for (const m of list) {
            try { out = await httpPostJson(p.url(), Object.assign({}, body, { model: m }), headers, timeout); last = null; break }
            catch (e) { last = e; if (!/HTTP (400|404|422)/.test(String(e.message))) break }
        }
        if (!out) throw last || new Error('no model')
    }
    const msg = out && out.choices && out.choices[0] && out.choices[0].message
    let content = msg ? String(msg.content || '') : String(out && out.result && out.result.response || '')
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    const calls = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    if (!content && !calls.length) throw new Error('empty reply')
    return { content, tool_calls: calls }
}
function srRace(o, want, budget) {
    const order = srAvail(!!o.tools)
    return new Promise(resolve => {
        const got = []
        let idx = 0, active = 0, done = false, grace = null
        const timer = setTimeout(end, budget || 32000)
        function end() { if (done) return; done = true; clearTimeout(timer); clearTimeout(grace); resolve(got) }
        function fill() {
            while (!done && active + got.length < want && idx < order.length) {
                const p = order[idx++]
                active++
                srCall(p, o)
                    .then(r => { srMark(p, null, true); got.push({ id: p.id, msg: r }); if (got.length >= want) end(); else if (!grace) grace = setTimeout(end, 5000) })
                    .catch(e => srMark(p, e))
                    .finally(() => { active--; if (!done) { fill(); if (active === 0 && (idx >= order.length || got.length >= want)) end() } })
            }
            if (!done && active === 0 && idx >= order.length) end()
        }
        fill()
    })
}
async function srSeq(o) {
    let last
    for (const p of srAvail(!!o.tools)) {
        try { const r = await srCall(p, o); srMark(p, null, true); return r }
        catch (e) { srMark(p, e); last = e }
    }
    throw last || new Error('No AI key is set. Add one in API Keys.')
}
function srBestText(list) {
    const score = t => Math.min(t.length, 2200) - (/^(i can(no|')t|i am sorry|sorry|as an ai)/i.test(t.trim()) ? 1500 : 0)
    return list.slice().sort((a, b) => score(b) - score(a))[0]
}
async function srMerge(o, a, b) {
    const q = o.messages.slice().reverse().find(m => m.role === 'user')
    const sys = 'You are the final editor of the Realm Assistant. Two drafts answer the same question. Write ONE final answer that keeps the strongest, accurate and most useful points of both, removes repetition, drops any point the drafts contradict each other on, and keeps a precise, premium and elegant tone. Plain text only: no markdown, no asterisks. Never mention drafts, editors or merging. Never claim an action happened. Output only the final answer.'
    const user = 'Question:\n' + String(q && q.content || '').slice(0, 4000) + '\n\nDraft A:\n' + a + '\n\nDraft B:\n' + b
    const r = await srSeq({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens: o.maxTokens || 1200, temperature: 0.2, timeout: 18000 })
    return r.content
}
async function srAsk(o) {
    const got = await srRace(o, 2, 32000)
    if (!got.length) throw new Error('All AI providers failed')
    const act = got.find(g => g.msg.tool_calls.length)
    if (act) return act.msg
    const texts = got.map(g => g.msg.content).filter(Boolean)
    if (texts.length < 2 || texts[0].length < 160 || texts[1].length < 160) return { content: srBestText(texts), tool_calls: [] }
    try {
        const merged = await srMerge(o, texts[0], texts[1])
        const longest = Math.max(texts[0].length, texts[1].length)
        if (merged && merged.length > Math.min(120, longest * 0.35)) return { content: merged, tool_calls: [] }
    } catch (e) { console.log('[AI] merge failed: ' + String(e.message).slice(0, 120)) }
    return { content: srBestText(texts), tool_calls: [] }
}
async function srModel(messages, maxTokens) {
    const r = await srSeq({ messages, maxTokens: maxTokens || 3000, temperature: 0.2, timeout: 60000 })
    return String(r.content || '')
}
"""

bot = block(bot, "async function srModel(messages, maxTokens) {", "const SR_CODE_RULES", AI_LAYER, 'AI providers: race, replacement, merge')

THEME_NAMES = ["Royal Obsidian", "Midnight Emperor", "Sukuna Bloodline", "Shadow Monarch", "Cyber Dominion", "Emerald Executive", "Aurora Luxe", "Sapphire Elite", "Neon Overdrive", "Omega Dominion", "Crimson Eclipse", "Frosted Majesty", "Inferno King", "Mystic Void", "Dreamer's Realm", "Toxic Aura", "Galaxy King", "Royal Nebula", "Abyss Walker", "Divine Chaos", "Dragon's Breath", "Phantom Frost", "Blood Moon", "Celestial Sage", "Thunder Lord", "Urban Mystic", "Infinity Edge", "Void Emperor", "Flame Sovereign", "Zenith Force"]
TC_NAMES = ["Theme default", "Ivory Cream", "Pure White", "Champagne Gold", "Rose Gold", "Mint", "Sky Ice", "Lavender", "Peach", "Silver", "Amber", "Royal Gold", "Ocean Blue", "Crimson Flame", "Purple Aura", "Sunset Glow", "Emerald Shine", "Ice Crystal", "Rose Magic", "Galaxy", "Cyber Neon", "Silver Frost", "Toxic Glow", "Royal Sunset", "Blood Moon", "Divine Light"]
js_list = lambda a: '[' + ', '.join('"' + x + '"' for x in a) + ']'
n1 = len(re.findall(r"^const SR_THEMES = \[.*\]$", bot, flags=re.M))
if n1:
    bot = re.sub(r"^const SR_THEMES = \[.*\]$", lambda m: 'const SR_THEMES = ' + js_list(THEME_NAMES), bot, flags=re.M); ok('30 theme names (SR_THEMES)')
else: warn('SR_THEMES line not found')
n2 = len(re.findall(r"^const SR_TCOLORS = \[.*\]$", bot, flags=re.M))
if n2:
    bot = re.sub(r"^const SR_TCOLORS = \[.*\]$", lambda m: 'const SR_TCOLORS = ' + js_list(TC_NAMES), bot, flags=re.M); ok('26 text colour names (SR_TCOLORS)')
else: warn('SR_TCOLORS line not found')
bot = rep(bot, "description: 'Change the dashboard text colour.'", "description: 'Change the dashboard text colour (solid or gradient). It applies in dark mode; light mode always uses black text.'", 'tool text: text colour')

PROMPTS = r"""const SR_PUBLIC_PROMPT = () =>
    'You are the Realm Assistant of the SUKUNA REALM WhatsApp bot dashboard: a precise, composed and elegant concierge that helps ONLY with this bot and this dashboard (commands, settings, connecting a number, themes, groups, the Wishes page and fixing problems with them). '
    + 'Style: lead with the answer in the first sentence, then add only what is needed, usually 2 to 6 short lines. Refined plain language; no filler, no apologies, no emojis, no greetings unless greeted. Plain text only: no markdown, no asterisks, no backticks, no headings. For steps write one per line as 1) 2) 3). '
    + 'Agentic behaviour: when the request is clear and a tool can do it, call the tool immediately instead of explaining how (several tools in one turn if several things are asked), then confirm in one line what changed and offer the single most useful next step. If the request is ambiguous, ask exactly one short question. Harmless actions (theme, text colour, mode, open a page) need no permission; risky ones are confirmed by the system. '
    + 'Do NOT write code and do NOT explain how to build WhatsApp bots or anything unrelated; say in one sentence that you only help with this bot and dashboard. '
    + 'The dashboard menu has ONLY these pages: Home, Connect, Sessions, Commands, Settings, Groups, Logs, Media, API Keys, Analytics, Templates, Themes, Wishes, Contact owner. Never invent buttons, tabs or settings outside that list. '
    + 'The Themes page has a separate Light and Dark switch, 30 gradient themes and text colours (solid and gradient, used in dark mode; light mode always uses black text). '
    + 'If you are not sure about a command detail, say so plainly instead of guessing. '
    + 'You can NOT turn owner mode or any mode on or off, and you must never say that you did. Never claim an action happened unless a tool result says so. '
    + 'Commands of this bot:\n' + srCatalogText()
const SR_OWNER_PROMPT = () =>
    'You are the Realm Assistant in OWNER MODE for the SUKUNA REALM WhatsApp bot (Node.js, Baileys, one bot.js file plus dashboard.html). The person talking to you is the verified owner. '
    + 'Style: precise, professional and elegant. Lead with the answer, then only what is needed. Plain text in chat, no markdown. You may write code snippets when asked. '
    + 'Agentic behaviour: when the request is clear and a tool can do it, call the tool immediately, then confirm in one line what changed and offer the single most useful next step. If the request is ambiguous, ask exactly one short question. '
    + 'You can NOT turn owner mode or any mode on or off, and you must never say that you did: the owner does that by typing "owner mode" or "exit owner mode". Never claim an action happened unless a tool result says so. '
    + 'You can use tools for dashboard actions and owner actions (block, unblock, kill session, maintenance, owner-only, free memory) but ONLY when the owner clearly asks. '
    + 'If the owner wants a new command, tell them to say: create a command. If they want to change bot.js or the dashboard, tell them to say what to change, starting with: edit. '
    + 'Commands of this bot:\n' + srCatalogText()

"""
bot = block(bot, "const SR_PUBLIC_PROMPT = () =>", "const SR_TOOLS_PUBLIC = [", PROMPTS, 'assistant prompts: premium, precise, agentic')

bot = rep(bot, "try { p = JSON.parse(await body(4000)) } catch (e) {}\n    const question = String(p.question || '').slice(0, 1200)",
          "try { p = JSON.parse(await body(120000)) } catch (e) {}\n    const question = String(p.question || '').slice(0, 20000)", 'AI input limit 20000 characters')
bot = rep(bot, "content: String(h.content).slice(0, 1500) }))", "content: String(h.content).slice(0, 3000) }))", 'AI history size')
bot = rep(bot, "if (!global.__GROQ__) return J(503, { error: 'The assistant is not set up yet (no Groq key).' })",
          "if (!srAvail().length) return J(503, { error: 'The assistant is not set up yet (no AI key added).' })", 'no-key check uses all providers')
pat = re.compile(r"const data = await groqPost\('https://api\.groq\.com/openai/v1/chat/completions', \{\n\s+model: 'auto', temperature: 0\.3, max_tokens: owner \? 1800 : 600,.*?\}, 30000\)\n\s+const msg = data && data\.choices && data\.choices\[0\] && data\.choices\[0\]\.message \|\| \{\}", re.S)
NEWCALL = ("const msg = await srAsk({\n"
           "            messages: [{ role: 'system', content: owner ? SR_OWNER_PROMPT() : SR_PUBLIC_PROMPT() }, ...history, { role: 'user', content: question }],\n"
           "            tools: owner ? SR_TOOLS_OWNER : SR_TOOLS_PUBLIC, temperature: 0.3, maxTokens: owner ? 2500 : 1100, timeout: 28000\n"
           "        })")
if pat.search(bot):
    bot = pat.sub(lambda m: NEWCALL, bot, count=1); ok('assistant route uses the two-provider race')
elif 'await srAsk({' in bot: ok('assistant route (already done)')
else: warn('assistant route call block not found')
bot = rep(bot, "const answer = __plainText(msg.content || 'No response.').slice(0, 2500)", "const answer = __plainText(msg.content || 'No response.').slice(0, 8000)", 'answer length')
bot = rep(bot, "const NAMES = ['GROQ_API_KEY', 'TMDB_API_KEY', 'YOUTUBE_API_KEY', 'PEXELS_API_KEY']",
          "const NAMES = ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'MISTRAL_API_KEY', 'HF_TOKEN', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'TMDB_API_KEY', 'YOUTUBE_API_KEY', 'PEXELS_API_KEY']", 'API Keys page lists all providers')
bot = rep(bot, "for (const k of ['GROQ_API_KEY', 'TMDB_API_KEY', 'YOUTUBE_API_KEY', 'PEXELS_API_KEY', 'DASHBOARD_PASSWORD'",
          "for (const k of ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'MISTRAL_API_KEY', 'HF_TOKEN', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'TMDB_API_KEY', 'YOUTUBE_API_KEY', 'PEXELS_API_KEY', 'DASHBOARD_PASSWORD'", 'status check lists all providers')
open(BOT, 'w', encoding='utf-8').write(bot)

# =====================================================================
# dashboard.html
# =====================================================================

ENGINE = r"""<script id="sr-theme-engine">
(function(){
var V=['--bg','--surface','--surface-raised','--violet','--crimson','--crimson-dim','--gold','--gold-dim','--line','--ink','--ink-dim','--ink-faint','--g1','--g2','--g3','--on-acc'];
var N={black:'#0A0A10',gold:'#F2B705',bronze:'#CD7F32',navy:'#0B1A44',blue:'#2F6BFF',silver:'#C3CAD6',red:'#F0283C',crimson:'#D61048',purple:'#8B3DFF',violet:'#B66BFF',cyan:'#19D3EE',dgreen:'#0A3B2B',emerald:'#10B981',teal:'#14B8A6',sapphire:'#1D5BE0',platinum:'#E3E6EB',pink:'#FF4FA3',dpurple:'#4A1B8C',maroon:'#7D1228',rose:'#FF6C93',dblue:'#0B2A66',ice:'#A9DBFF',white:'#F4F7FB',orange:'#FF8A1E',indigo:'#3A2EB5',sky:'#4DB5FF',neon:'#39FF6A',yellow:'#FFE53A',magenta:'#E31BC9',electric:'#0AA3FF',deepblue:'#0A3CA6'};
var LBL={black:'Black',gold:'Gold',bronze:'Bronze',navy:'Navy',blue:'Blue',silver:'Silver',red:'Red',crimson:'Crimson',purple:'Purple',violet:'Violet',cyan:'Cyan',dgreen:'Dark Green',emerald:'Emerald',teal:'Teal',sapphire:'Sapphire',platinum:'Platinum',pink:'Pink',dpurple:'Deep Purple',maroon:'Maroon',rose:'Rose',dblue:'Dark Blue',ice:'Ice Blue',white:'White',orange:'Orange',indigo:'Indigo',sky:'Sky Blue',neon:'Neon Green',yellow:'Yellow',magenta:'Magenta',electric:'Electric Blue',deepblue:'Deep Blue'};
var RAW=[
["Royal Obsidian","black","gold","bronze"],["Midnight Emperor","navy","blue","silver"],["Sukuna Bloodline","black","red","crimson"],["Shadow Monarch","black","purple","violet"],["Cyber Dominion","black","purple","cyan"],
["Emerald Executive","dgreen","emerald","gold"],["Aurora Luxe","navy","teal","purple"],["Sapphire Elite","black","sapphire","platinum"],["Neon Overdrive","navy","pink","blue"],["Omega Dominion","black","gold","dpurple"],
["Crimson Eclipse","black","maroon","rose"],["Frosted Majesty","dblue","ice","white"],["Inferno King","black","orange","red"],["Mystic Void","black","purple","cyan"],["Dreamer's Realm","indigo","sky","pink"],
["Toxic Aura","black","neon","yellow"],["Galaxy King","black","blue","purple"],["Royal Nebula","black","gold","violet"],["Abyss Walker","black","deepblue","cyan"],["Divine Chaos","black","magenta","gold"],
["Dragon's Breath","black","red","gold"],["Phantom Frost","black","ice","purple"],["Blood Moon","black","crimson","pink"],["Celestial Sage","dblue","teal","gold"],["Thunder Lord","black","electric","violet"],
["Urban Mystic","black","cyan","pink"],["Infinity Edge","black","gold","blue"],["Void Emperor","black","purple","cyan"],["Flame Sovereign","black","orange","purple"],["Zenith Force","black","blue","gold"]];
var TH=RAW.map(function(r,i){var id=r[0].toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');return [id,r[0],[r[1],r[2],r[3]],(i*5)%6,110+((i*47)%140)]});
var TC=[
['theme','Theme default','t'],
['cream','Ivory Cream','s',['#F7F1E1','#CFC6AE','#8D8470']],
['white','Pure White','s',['#FFFFFF','#D4D8DE','#8C929C']],
['champagne','Champagne Gold','s',['#F3E2B3','#CDB886','#8E7D55']],
['rose','Rose Gold','s',['#FFD9D2','#D9A9A0','#9A6F68']],
['mint','Mint','s',['#D3F8E7','#9FD9BF','#5F9C82']],
['sky','Sky Ice','s',['#D6EEFF','#9CC6E6','#5F8AAA']],
['lavender','Lavender','s',['#E6DAFF','#B9A4E8','#7C68AD']],
['peach','Peach','s',['#FFE0C7','#E0B08A','#9C7656']],
['silver','Silver','s',['#E4E7EC','#B3B9C4','#727A88']],
['amber','Amber','s',['#FFE0A3','#E3B75E','#9E7B2C']],
['royalgold','Royal Gold','g',['#F6C453','#D98B3A']],
['oceanblue','Ocean Blue','g',['#4C9BFF','#22D3EE']],
['crimsonflame','Crimson Flame','g',['#FF4D5E','#FF9A3D']],
['purpleaura','Purple Aura','g',['#A77BFF','#D08CFF']],
['sunsetglow','Sunset Glow','g',['#FF9F43','#FF5FA2']],
['emeraldshine','Emerald Shine','g',['#34D399','#F6C453']],
['icecrystal','Ice Crystal','g',['#7CC8FF','#FFFFFF']],
['rosemagic','Rose Magic','g',['#FF7EB6','#B77BFF']],
['galaxy','Galaxy','g',['#5B8CFF','#A77BFF','#FF7EC8']],
['cyberneon','Cyber Neon','g',['#22E3F5','#B25CFF']],
['silverfrost','Silver Frost','g',['#D5DBE5','#9FD3FF']],
['toxicglow','Toxic Glow','g',['#C8FF3D','#39FF8A']],
['royalsunset','Royal Sunset','g',['#F6C453','#B77BFF']],
['bloodmoon','Blood Moon','g',['#FF3B5C','#FF8DA8']],
['divinelight','Divine Light','g',['#FFFFFF','#F6C453','#7CC8FF']]
];
function g(k){try{return localStorage.getItem(k)}catch(e){return null}}
function s(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function h2(h){h=h.replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]}
function mix(a,b,t){var x=h2(a),y=h2(b),o=[0,1,2].map(function(i){return Math.round(x[i]*(1-t)+y[i]*t)});return '#'+o.map(function(v){return ('0'+v.toString(16)).slice(-2)}).join('')}
function lin(v){v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)}
function L(h){var x=h2(h);return .2126*lin(x[0])+.7152*lin(x[1])+.0722*lin(x[2])}
function cr(a,b){var x=L(a),y=L(b),hi=Math.max(x,y),lo=Math.min(x,y);return (hi+.05)/(lo+.05)}
function lift(c,bg,min){var t=0,o=c;while(cr(o,bg)<min&&t<1){t+=.06;o=mix(c,'#ffffff',t)}return o}
function sink(c,bg,min){var t=0,o=c;while(cr(o,bg)<min&&t<1){t+=.06;o=mix(c,'#000000',t)}return o}
function cols(t){return t[2].map(function(k){return N[k]})}
function comp(look,ang,a,b,c){
    var m=mix(b,c,.5);
    if(look===0)return 'linear-gradient('+ang+'deg,'+a+' 0%,'+b+' 52%,'+c+' 100%)';
    if(look===1)return 'radial-gradient(70% 55% at 12% 8%,'+b+' 0%,transparent 62%),radial-gradient(65% 55% at 92% 96%,'+c+' 0%,transparent 60%),linear-gradient(180deg,'+a+','+a+')';
    if(look===2)return 'conic-gradient(from '+ang+'deg at 50% 35%,'+a+','+b+','+c+','+a+')';
    if(look===3)return 'radial-gradient(90% 60% at 50% 0%,'+b+','+'transparent 70%),linear-gradient('+ang+'deg,'+a+' 0%,'+c+' 100%)';
    if(look===4)return 'radial-gradient(60% 45% at 0% 0%,'+b+',transparent 65%),radial-gradient(55% 45% at 100% 30%,'+c+',transparent 65%),radial-gradient(70% 50% at 50% 100%,'+m+',transparent 65%),linear-gradient(180deg,'+a+','+a+')';
    return 'linear-gradient(180deg,'+b+' 0%,'+a+' 48%,'+c+' 100%)';
}
function build(t,mode){
    var c=cols(t),c1=c[0],c2=c[1],c3=c[2],K='#000000',W='#ffffff',v,cp;
    if(mode==='light'){
        var bg=mix(mix(c2,c3,.4),W,.93),sf=W,rs=mix(c2,W,.9),vi=mix(c3,W,.82),ln=mix(c2,W,.78);
        var ac=sink(c2,W,4.5),ac2=sink(c3,W,5);
        v=[bg,sf,rs,vi,ac,mix(ac,K,.2),ac2,mix(ac2,W,.3),ln,'#0E0E14','#3D3D4B','#6C6C7A',mix(ac,K,.12),ac,ac2,'#FFFFFF'];
        var l1=L(c1)>.03?mix(c1,W,.84):mix(c2,W,.9),l2=mix(c2,W,.78),l3=mix(c3,W,.72);
        cp=comp(t[3],t[4],l1,l2,l3);
    }else{
        var b0=L(c1)>.03?mix(c1,K,.7):c1,bg2=mix(b0,c2,.05),sf2=mix(bg2,c2,.09),rs2=mix(bg2,c2,.16),vi2=mix(bg2,c3,.2),ln2=mix(bg2,c3,.28);
        var a1=lift(c2,sf2,4.6),a2=lift(c3,sf2,6),ink='#F6F6FA';
        var g1=L(c1)<.06?mix(c2,K,.4):c1,mid=mix(c2,c3,.5);
        v=[bg2,sf2,rs2,vi2,a1,mix(c2,K,.35),a2,mix(c3,K,.35),ln2,ink,mix(ink,bg2,.28),mix(ink,bg2,.52),g1,c2,c3,L(mid)>.38?'#0B0B12':'#FFFFFF'];
        var base='#06060b',s1=mix(base,c1,L(c1)>.03?.5:1),s2=mix(base,c2,.34),s3=mix(base,c3,.3);
        cp=comp(t[3],t[4],s1,s2,s3);
    }
    return {v:v,comp:cp};
}
function pal(t,mode){return build(t,mode).v}
function pick(list,q){
    var n=String(q||'').toLowerCase().replace(/[^a-z0-9]/g,'');if(!n)return null;
    var f=function(x){return x[1].toLowerCase().replace(/[^a-z0-9]/g,'')};
    return list.find(function(x){return x[0]===n||f(x)===n})||list.find(function(x){return f(x).indexOf(n)>-1})||list.find(function(x){return n.indexOf(f(x))>-1})||null;
}
function state(){
    var t=g('sr_theme')||TH[0][0],m=g('sr_mode')==='light'?'light':'dark',c=g('sr_tcolor')||'theme';
    if(!TH.some(function(x){return x[0]===t}))t=TH[0][0];
    if(!TC.some(function(x){return x[0]===c}))c='theme';
    return {theme:t,mode:m,tcolor:c};
}
function apply(){
    var r=document.documentElement,st=state();
    var t=TH.find(function(x){return x[0]===st.theme}),b=build(t,st.mode);
    V.forEach(function(k,i){r.style.setProperty(k,b.v[i])});
    r.style.setProperty('--comp',b.comp);
    r.removeAttribute('data-theme');r.removeAttribute('data-tx');r.removeAttribute('data-tg');
    r.style.removeProperty('--tx');r.style.removeProperty('--tg');
    if(st.mode==='light')r.setAttribute('data-mode','light');else r.removeAttribute('data-mode');
    r.setAttribute('data-sr',t[0]);
    var tc=TC.find(function(x){return x[0]===st.tcolor});
    if(st.mode==='dark'&&tc&&tc[2]!=='t'){
        var ink,dim,faint,bg=b.v[0];
        if(tc[2]==='s'){ink=tc[3][0];dim=tc[3][1];faint=tc[3][2]}
        else{var gg=tc[3].map(function(c){return lift(c,bg,5)}),mid=gg.length===3?gg[1]:mix(gg[0],gg[1],.5);ink=mid;dim=mix(mid,bg,.3);faint=mix(mid,bg,.55);r.style.setProperty('--tg','linear-gradient(90deg,'+gg.join(',')+')');r.setAttribute('data-tg','1')}
        r.style.setProperty('--ink',ink);r.style.setProperty('--ink-dim',dim);r.style.setProperty('--ink-faint',faint);r.style.setProperty('--tx',ink);r.setAttribute('data-tx','1');
    }
    try{window.dispatchEvent(new Event('sr-theme'))}catch(e){}
}
function set(o){
    if(o.theme!==undefined){var t=pick(TH,o.theme);if(t)s('sr_theme',t[0])}
    if(o.mode!==undefined)s('sr_mode',o.mode==='light'?'light':'dark');
    if(o.tcolor!==undefined){var c=pick(TC,o.tcolor);if(c)s('sr_tcolor',c[0])}
    apply();
}
window.SRT={themes:TH,tcolors:TC,state:state,set:set,apply:apply,pal:pal,pick:pick,cols:cols,labels:LBL};
apply();
})();
</script>"""

dash = block(dash, '<script id="sr-theme-engine">', '\n\n<meta charset="UTF-8">', ENGINE, 'theme engine: 30 gradient themes, separate light/dark, gradient text colours')

CSS = r'''<style id="sr-v2">
/* ---- theme foundation: gradient background, gradient buttons ---- */
:root:root:root body{background:var(--bg)!important}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:var(--comp,transparent)}
:root:root:root .btn.primary{background:linear-gradient(135deg,var(--g1),var(--g2),var(--g3))!important;color:var(--on-acc)!important;border-color:transparent!important;text-shadow:none!important}
:root:root:root .panel,:root:root:root .auth-card{border-color:var(--line)}
:root:root:root header{border-bottom-color:var(--line)}
/* ---- text colour: reaches every piece of text ---- */
html[data-tx] body :not(svg):not(svg *):not(img):not(.keep):not(.keep *):not(.btn.primary):not(.btn.primary *):not(.err-text):not(.pill.live):not(.up-tag.on):not(.ai-fab *):not(.ai-send):not(.ai-msg.user):not(.thm-seg-b.on):not(.thm-seg-b.on *){color:var(--tx)!important}
html[data-tx] input::placeholder,html[data-tx] textarea::placeholder{color:var(--ink-faint)!important;opacity:1}
html[data-tg] :is(.hdr-word,.auth-word,.page-title,.subhead,.hgreet,.btxt h1,.ai-head b,.drawer-head .hdr-word,label,h1,h2,h3){background-image:var(--tg)!important;-webkit-background-clip:text!important;background-clip:text!important;-webkit-text-fill-color:transparent!important}
/* ---- hidden-code fields look like passwords but are not password fields ---- */
.sr-secret{-webkit-text-security:disc;text-security:disc}
/* ---- themes page ---- */
.thm-seg{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:5px;border-radius:16px;background:var(--surface);border:1px solid var(--line);margin-bottom:10px}
.thm-seg-b{display:flex;align-items:center;justify-content:center;gap:8px;min-height:50px;border-radius:12px;border:none;background:transparent;color:var(--ink-dim);font:inherit;font-size:15px;font-weight:600;cursor:pointer}
.thm-seg-b svg{width:18px;height:18px}
.thm-seg-b.on{background:linear-gradient(135deg,var(--g1),var(--g2),var(--g3));color:var(--on-acc);box-shadow:0 6px 18px rgba(0,0,0,.25)}
.thm-note{font-size:13px;color:var(--ink-faint);margin:2px 2px 14px;line-height:1.5}
.thm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:8px}
@media(min-width:640px){.thm-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(min-width:960px){.thm-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.thm-card{position:relative;display:flex;flex-direction:column;padding:0;border-radius:16px;border:2px solid var(--line);background:var(--surface);overflow:hidden;text-align:left;cursor:pointer;font:inherit;color:inherit}
.thm-card.sel{border-color:var(--gold);box-shadow:0 0 0 3px rgba(255,255,255,.08)}
.thm-prev{height:84px;position:relative}
.thm-chk{position:absolute;top:8px;right:8px;width:24px;height:24px;border-radius:50%;background:#fff;color:#111;display:none;place-items:center;font-size:14px;font-weight:700}
.thm-card.sel .thm-chk{display:grid}
.thm-meta{padding:10px 11px 12px;display:flex;flex-direction:column;gap:3px}
.thm-meta b{font-size:14px;font-weight:600;line-height:1.25}
.thm-meta span{font-size:11.5px;color:var(--ink-faint);line-height:1.3}
.tcx-title{font-size:13px;font-weight:600;color:var(--ink-dim);margin:14px 2px 8px}
.tcx-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media(min-width:560px){.tcx-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.tcx-card{display:flex;align-items:center;gap:12px;min-height:70px;padding:10px 12px;border-radius:14px;border:2px solid var(--line);background:var(--surface);font:inherit;color:inherit;text-align:left;cursor:pointer}
.tcx-card.sel{border-color:var(--gold)}
.tcx-s{font-size:28px;font-weight:700;line-height:1;flex:none;min-width:44px;text-align:center}
.tcx-n{font-size:13.5px;font-weight:600;line-height:1.25}
#tcBox.dis .tcx-card{opacity:.4;pointer-events:none}
/* ---- AI page: full screen, real chat ---- */
body.ai-open{position:fixed;width:100%;overflow:hidden}
#aiSheet{position:fixed!important;left:0;top:0;width:100%;height:100dvh;z-index:70;display:none;background:var(--bg)!important}
#aiSheet::before{content:"";position:absolute;inset:0;pointer-events:none;background:var(--comp,transparent)}
#aiSheet.open{display:block}
#aiSheet .ai-panel{position:absolute!important;inset:0!important;width:100%!important;max-width:none!important;height:100%!important;max-height:none!important;border:none!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;display:flex;flex-direction:column;padding-top:var(--safe-top,0px);animation:none!important}
#aiSheet .ai-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--bg)}
#aiSheet .ai-head img{width:30px;height:30px;border-radius:9px}
#aiSheet .ai-head b{flex:1;font-family:var(--font-display);font-size:15px;min-width:0}
#aiSheet .ai-head button{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;border:1px solid var(--line);background:var(--surface-raised);color:var(--ink-dim);padding:0;cursor:pointer}
#aiSheet .ai-head button svg{width:18px;height:18px}
#aiSheet .ai-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
#aiSheet .ai-log{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:18px 14px 12px;display:flex;flex-direction:column;gap:14px;width:100%;max-width:780px;margin:0 auto}
#aiSheet .ai-row{display:flex;flex-direction:column;max-width:92%}
#aiSheet .ai-row.user{align-self:flex-end;align-items:flex-end}
#aiSheet .ai-row.bot{align-self:flex-start;align-items:flex-start}
#aiSheet .ai-msg{max-width:100%;padding:11px 14px;border-radius:18px;font-size:15px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
#aiSheet .ai-msg.bot{background:var(--surface-raised);border:1px solid var(--line);border-top-left-radius:6px}
#aiSheet .ai-msg.user{background:linear-gradient(135deg,var(--g1),var(--g2));color:var(--on-acc);border:none;border-top-right-radius:6px}
#aiSheet .ai-acts{display:flex;gap:2px;margin-top:3px}
#aiSheet .ai-acts button{display:grid;place-items:center;width:30px;height:30px;border:none;background:none;color:var(--ink-faint);border-radius:8px;padding:0;cursor:pointer}
#aiSheet .ai-acts button svg{width:16px;height:16px}
#aiSheet .ai-acts button.on{color:var(--gold)}
#aiSheet .ai-empty{margin:auto;text-align:center;padding:20px;max-width:420px}
#aiSheet .ai-empty img{width:68px;height:68px;border-radius:20px}
#aiSheet .ai-empty h2{font-family:var(--font-display);font-size:20px;margin:14px 0 6px}
#aiSheet .ai-empty p{font-size:14px;color:var(--ink-dim);line-height:1.55;margin:0 0 16px}
#aiSheet .ai-sugs{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
#aiSheet .ai-sugs button,#aiSheet .ai-chips button{border:1px solid var(--line);background:var(--surface);color:var(--ink);font:inherit;font-size:13.5px;padding:9px 14px;border-radius:999px;cursor:pointer}
#aiSheet .ai-chips{display:flex;gap:8px;margin-top:2px}
#aiSheet .ai-td{display:inline-flex;gap:5px;padding:3px 2px}
#aiSheet .ai-td i{width:7px;height:7px;border-radius:50%;background:var(--ink-faint);animation:srdot 1s infinite ease-in-out}
#aiSheet .ai-td i:nth-child(2){animation-delay:.15s}#aiSheet .ai-td i:nth-child(3){animation-delay:.3s}
@keyframes srdot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
@keyframes srspin{to{transform:rotate(360deg)}}
#aiSheet .ai-spin{display:block;width:18px;height:18px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:srspin .7s linear infinite}
#aiSheet .ai-input-row{display:flex;align-items:flex-end;gap:10px;padding:10px 12px calc(10px + var(--safe-bottom,0px));border-top:1px solid var(--line);background:var(--bg);width:100%;max-width:780px;margin:0 auto}
#aiSheet .ai-box{flex:1;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:3px 8px 3px 16px;display:flex;align-items:flex-end}
#aiSheet #aiInput{flex:1;width:100%;min-height:24px;max-height:150px;border:none!important;outline:none!important;box-shadow:none!important;background:transparent!important;color:var(--ink);font:inherit;font-size:16px;line-height:1.45;resize:none;padding:10px 4px;margin:0!important;border-radius:0!important;overflow-y:auto}
#aiSheet #aiInput.ai-mask{-webkit-text-security:disc}
#aiSheet .ai-send{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;border:none;padding:0;flex:none;cursor:pointer;background:linear-gradient(135deg,var(--g1),var(--g2),var(--g3));color:var(--on-acc)}
#aiSheet .ai-send svg{width:20px;height:20px}
#aiSheet .ai-send:disabled{opacity:.6}
#aiSheet .ai-hist{position:absolute;inset:0;z-index:3;background:var(--bg);transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column}
#aiSheet .ai-hist.open{transform:none}
#aiSheet .ai-hist-top{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}
#aiSheet .ai-hist-top b{flex:1;font-size:15px}
#aiSheet .ai-hist-top button{border:1px solid var(--line);background:var(--surface-raised);color:var(--ink-dim);font:inherit;font-size:13px;border-radius:999px;padding:7px 12px;cursor:pointer}
#aiSheet .ai-hist-list{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;width:100%;max-width:780px;margin:0 auto}
#aiSheet .ai-hi{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:14px;border:1px solid var(--line);background:var(--surface);cursor:pointer}
#aiSheet .ai-hi .t{flex:1;min-width:0}
#aiSheet .ai-hi .t b{display:block;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#aiSheet .ai-hi .t span{font-size:12px;color:var(--ink-faint)}
#aiSheet .ai-hi button{border:none;background:none;color:var(--ink-faint);width:32px;height:32px;display:grid;place-items:center;padding:0;cursor:pointer}
#aiSheet .ai-hi button svg{width:16px;height:16px}
#aiSheet .ai-none{text-align:center;color:var(--ink-faint);font-size:14px;padding:40px 10px}
</style>
</head>'''
if 'id="sr-v2"' in dash: ok('v2 styles (already added)')
elif '</head>' in dash: dash = dash.replace('</head>', CSS, 1); ok('v2 styles added')
else: warn('</head> not found')

THEMES_PAGE = r'''<div class="page" id="page-themes">
    <div class="page-title">Themes</div>
    <div class="thm-seg" role="group" aria-label="Appearance">
        <button type="button" class="thm-seg-b" id="thSegL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><span>Light</span></button>
        <button type="button" class="thm-seg-b" id="thSegD"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg><span>Dark</span></button>
    </div>
    <div class="thm-note" id="thNote"></div>
    <div class="subhead">Colour theme</div>
    <div class="thm-grid" id="themeGrid"></div>
    <div id="tcBox">
        <div class="subhead">Text colour</div>
        <div class="thm-note" id="tcNote"></div>
        <div class="tcx-title">Solid</div>
        <div class="tcx-grid" id="tcSolid"></div>
        <div class="tcx-title">Gradient</div>
        <div class="tcx-grid" id="tcGrad"></div>
    </div>
</div>

<div class="sr-modal" id="numModal">'''
m = re.search(r'<div class="page" id="page-themes">.*?\n</div>\n\n<div class="sr-modal" id="numModal">', dash, flags=re.S)
if m: dash = dash[:m.start()] + THEMES_PAGE + dash[m.end():]; ok('themes page redesigned')
elif 'id="thSegL"' in dash: ok('themes page (already done)')
else: warn('themes page markup not found')

THEMES_JS = r"""window.thInit=function(){
    var st=SRT.state(),light=st.mode==='light';
    $('thSegL').classList.toggle('on',light);$('thSegD').classList.toggle('on',!light);
    $('thNote').textContent=light?'Light mode keeps your theme with black text.':'Dark mode keeps your theme with white text, or any text colour you pick.';
    $('tcNote').textContent=light?'Text colours work in Dark mode. Light mode always uses black text.':'Applies to all text on every page.';
    $('tcBox').classList.toggle('dis',light);
    var LB=SRT.labels;
    $('themeGrid').innerHTML=SRT.themes.map(function(t){
        var c=SRT.cols(t),ang=t[4]||135;
        return '<button type="button" class="thm-card'+(t[0]===st.theme?' sel':'')+'" data-th="'+t[0]+'"><div class="thm-prev keep" style="background:linear-gradient('+ang+'deg,'+c[0]+' 0%,'+c[1]+' 50%,'+c[2]+' 100%)"><i class="thm-chk keep">\u2713</i></div><div class="thm-meta"><b>'+escHtml(t[1])+'</b><span>'+t[2].map(function(k){return LB[k]}).join(' \u2192 ')+'</span></div></button>'}).join('');
    function card(c){
        var sel=c[0]===st.tcolor?' sel':'',smp,nm;
        if(c[2]==='g'){var gr='linear-gradient(90deg,'+c[3].join(',')+')',sty='background-image:'+gr+';-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent';smp='<span class="tcx-s keep" style="'+sty+'">Aa</span>';nm='<span class="tcx-n keep" style="'+sty+'">'+escHtml(c[1])+'</span>'}
        else if(c[2]==='s'){smp='<span class="tcx-s keep" style="color:'+c[3][0]+'">Aa</span>';nm='<span class="tcx-n keep" style="color:'+c[3][0]+'">'+escHtml(c[1])+'</span>'}
        else{smp='<span class="tcx-s keep" style="color:#F6F6FA">Aa</span>';nm='<span class="tcx-n keep" style="color:#F6F6FA">'+escHtml(c[1])+'</span>'}
        return '<button type="button" class="tcx-card'+sel+'" data-tc="'+c[0]+'">'+smp+nm+'</button>';
    }
    $('tcSolid').innerHTML=SRT.tcolors.filter(function(c){return c[2]!=='g'}).map(card).join('');
    $('tcGrad').innerHTML=SRT.tcolors.filter(function(c){return c[2]==='g'}).map(card).join('');
    $('themeGrid').querySelectorAll('[data-th]').forEach(function(b){b.addEventListener('click',function(){SRT.set({theme:b.dataset.th});window.thInit();toastName(SRT.pick(SRT.themes,b.dataset.th)[1])})});
    document.querySelectorAll('#tcBox [data-tc]').forEach(function(b){b.addEventListener('click',function(){SRT.set({tcolor:b.dataset.tc});window.thInit();toastName(SRT.pick(SRT.tcolors,b.dataset.tc)[1])})});
};
$('thSegL').addEventListener('click',function(){SRT.set({mode:'light'});window.thInit();toastName('Light mode')});
$('thSegD').addEventListener('click',function(){SRT.set({mode:'dark'});window.thInit();toastName('Dark mode')});

"""
dash = block(dash, "window.thInit=function(){", "/* ===== number popup ===== */", THEMES_JS, 'themes page script')

AI_HTML = r'''<div class="ai-sheet" id="aiSheet" aria-hidden="true">
    <div class="ai-panel" role="dialog" aria-label="Realm Assistant">
        <div class="ai-head">__LOGO__<b>Realm Assistant</b>
            <button type="button" id="aiHistBtn" title="Recent chats" aria-label="Recent chats"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg></button>
            <button type="button" id="aiNew" title="New chat" aria-label="New chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
            <button type="button" id="aiClose" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
        <div class="ai-body">
            <div class="ai-log" id="aiLog"></div>
            <div class="ai-hist" id="aiHist">
                <div class="ai-hist-top"><b>Recent chats</b><button type="button" id="aiHistClear">Clear all</button><button type="button" id="aiHistBack">Back</button></div>
                <div class="ai-hist-list" id="aiHistList"></div>
            </div>
        </div>
        <div class="ai-input-row">
            <div class="ai-box"><textarea id="aiInput" rows="1" maxlength="20000" placeholder="Ask me anything" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-form-type="other" name="sr-ask"></textarea></div>
            <button type="button" class="ai-send keep" id="aiSend" aria-label="Send"></button>
        </div>
    </div>
</div>

<div class="page" id="page-connect">'''
m = re.search(r'<div class="ai-sheet" id="aiSheet">\s*<div class="ai-panel">\s*<div class="ai-head">(<img[^>]*>)', dash)
if m and 'id="aiHistBtn"' not in dash:
    logo = m.group(1)
    a = dash.find('<div class="ai-sheet" id="aiSheet">'); b = dash.find('<div class="page" id="page-connect">', a)
    if b > a:
        dash = dash[:a] + AI_HTML.replace('__LOGO__', logo) + dash[b + len('<div class="page" id="page-connect">'):]; ok('AI page markup: full page, history, copy-ready')
    else: warn('AI page end marker not found')
elif 'id="aiHistBtn"' in dash: ok('AI page markup (already done)')
else: warn('AI page markup not found')

AI_JS = r"""var hist=[],busy=false,pwMode=false,cur=null,lockY=0,KEYC='sr_ai_chats';
var GREET='Hi, welcome to Realm Assistant. How can I help you today?';
var SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
var IC={
    copy:SVG+'<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>',
    check:SVG+'<path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    share:SVG+'<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>',
    up:SVG+'<path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3z"/><path d="M7 11l4-8a2.5 2.5 0 0 1 2.5 2.5V9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/></svg>',
    down:SVG+'<g transform="rotate(180 12 12)"><path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3z"/><path d="M7 11l4-8a2.5 2.5 0 0 1 2.5 2.5V9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/></g></svg>',
    send:SVG+'<path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    del:SVG+'<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>'
};
function clean(s){return String(s||'').replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g,'$1').replace(/`([^`\n]+)`/g,'$1').replace(/\*\*([^*\n]+)\*\*/g,'$1').replace(/__([^_\n]+)__/g,'$1').replace(/(^|[\s(])\*(?=\S)([^*\n]*\S)\*(?=[\s).,!?:;]|$)/g,'$1$2').replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm,'').replace(/^[ \t]*[-*][ \t]+/gm,'\u2022 ').replace(/\n{3,}/g,'\n\n').trim()}
function stored(){try{var a=JSON.parse(localStorage.getItem(KEYC)||'[]');return Array.isArray(a)?a:[]}catch(e){return []}}
function store(a){a=a.slice(0,30);for(var k=0;k<4;k++){try{localStorage.setItem(KEYC,JSON.stringify(a));return}catch(e){a=a.slice(0,Math.max(1,Math.floor(a.length/2)))}}}
function persist(q,ans){
    if(!cur)newChat();
    cur.m.push({r:'user',x:q},{r:'bot',x:ans});cur.u=Date.now();
    if(!cur.t)cur.t=q.replace(/\s+/g,' ').slice(0,44);
    var a=stored().filter(function(c){return c.id!==cur.id});a.unshift(cur);store(a);
}
function showEmpty(){
    var logo=document.querySelector('#aiSheet .ai-head img'),src=logo?logo.src:'';
    var d=document.createElement('div');d.id='aiEmpty';d.className='ai-empty';
    d.innerHTML=(src?'<img src="'+src+'" alt="">':'')+'<h2>Realm Assistant</h2><p>'+GREET+'</p><div class="ai-sugs"><button type="button">What can you do?</button><button type="button">Change my theme</button><button type="button">Connect my number</button><button type="button">Popular commands</button></div>';
    d.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){ask(b.textContent)})});
    $('aiLog').appendChild(d);
}
function newChat(){cur={id:'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),t:'',u:Date.now(),m:[]};hist=[];$('aiLog').innerHTML='';showEmpty();closeHist()}
function openChat(id){
    var c=stored().filter(function(x){return x.id===id})[0];if(!c)return;
    cur=c;hist=[];$('aiLog').innerHTML='';
    c.m.forEach(function(m){add(m.r,m.x)});
    hist=c.m.slice(-8).map(function(m){return {role:m.r==='user'?'user':'assistant',content:m.x}});
    closeHist();
}
function openHist(){
    var list=stored(),box=$('aiHistList');
    if(!list.length)box.innerHTML='<div class="ai-none">No recent chats yet.</div>';
    else{
        box.innerHTML=list.map(function(c){return '<div class="ai-hi" data-id="'+c.id+'"><div class="t"><b>'+escHtml(c.t||'New chat')+'</b><span>'+new Date(c.u).toLocaleString([], {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+'</span></div><button type="button" data-del="'+c.id+'" aria-label="Delete">'+IC.del+'</button></div>'}).join('');
        box.querySelectorAll('.ai-hi').forEach(function(r){r.addEventListener('click',function(e){
            var d=e.target.closest('[data-del]');
            if(d){e.stopPropagation();store(stored().filter(function(x){return x.id!==d.dataset.del}));if(cur&&cur.id===d.dataset.del)newChat();openHist();return}
            openChat(r.dataset.id)})});
    }
    $('aiHist').classList.add('open');
}
function closeHist(){$('aiHist').classList.remove('open')}
function fit(){
    var s=$('aiSheet'),v=window.visualViewport;if(!s)return;
    if(v){s.style.height=v.height+'px';s.style.top=v.offsetTop+'px'}else{s.style.height='';s.style.top=''}
    var l=$('aiLog');l.scrollTop=l.scrollHeight;
}
function grow(){var t=$('aiInput');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,150)+'px'}
function aiOpen(){
    if(!cur)newChat();
    lockY=window.pageYOffset||0;document.body.style.top=(-lockY)+'px';document.body.classList.add('ai-open');
    $('aiSheet').classList.add('open');$('aiSheet').setAttribute('aria-hidden','false');
    fit();setTimeout(fit,120);if(window.innerWidth>=760)setTimeout(function(){$('aiInput').focus()},120);
}
function aiClose(){
    $('aiSheet').classList.remove('open');$('aiSheet').setAttribute('aria-hidden','true');closeHist();
    document.body.classList.remove('ai-open');document.body.style.top='';window.scrollTo(0,lockY);
}
function fb(t){try{var a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;opacity:0;top:0;left:0';document.body.appendChild(a);a.select();var r=document.execCommand('copy');a.remove();return r}catch(e){return false}}
function copyText(t){
    if(navigator.clipboard&&window.isSecureContext)return navigator.clipboard.writeText(t).then(function(){return true},function(){return fb(t)});
    return Promise.resolve(fb(t));
}
function btn(a,t){return '<button type="button" data-a="'+a+'" title="'+t+'" aria-label="'+t+'">'+IC[a]+'</button>'}
function act(a,b,text){
    if(a==='copy'){copyText(text).then(function(ok){if(ok){b.innerHTML=IC.check;b.classList.add('on');setTimeout(function(){b.innerHTML=IC.copy;b.classList.remove('on')},1300)}})}
    else if(a==='share'){try{navigator.share({text:text})}catch(e){}}
    else if(a==='up'||a==='down'){var o=b.parentNode.querySelector('[data-a="'+(a==='up'?'down':'up')+'"]');if(o)o.classList.remove('on');b.classList.toggle('on')}
}
function add(who,text){
    var log=$('aiLog'),emp=$('aiEmpty');if(emp)emp.remove();
    var row=document.createElement('div');row.className='ai-row '+who;
    var m=document.createElement('div');m.className='ai-msg '+who+(who==='user'?' keep':'');m.textContent=text;row.appendChild(m);
    var acts=document.createElement('div');acts.className='ai-acts';
    acts.innerHTML=btn('copy','Copy')+(who==='bot'?(navigator.share?btn('share','Share'):'')+btn('up','Good reply')+btn('down','Bad reply'):'');
    acts.addEventListener('click',function(e){var b=e.target.closest('button');if(b)act(b.dataset.a,b,text)});
    row.appendChild(acts);
    if(who==='bot'&&/reply yes/i.test(text)){
        var c=document.createElement('div');c.className='ai-chips';c.innerHTML='<button type="button" data-a="yes">Yes</button><button type="button" data-a="no">No</button>';row.appendChild(c);
        c.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){c.remove();ask(b.dataset.a)})});
    }
    log.appendChild(row);log.scrollTop=log.scrollHeight;return row;
}
function setBusy(b){
    busy=b;var s=$('aiSend'),i=$('aiInput');
    s.disabled=b;s.innerHTML=b?'<span class="ai-spin"></span>':IC.send;
    i.placeholder=b?'Waiting for the reply...':(pwMode?'Password':'Ask me anything');
}
function dots(on){
    var d=$('aiDots'),log=$('aiLog');
    if(on&&!d){d=document.createElement('div');d.id='aiDots';d.className='ai-row bot';d.innerHTML='<div class="ai-msg bot"><span class="ai-td"><i></i><i></i><i></i></span></div>';log.appendChild(d);log.scrollTop=log.scrollHeight}
    if(!on&&d)d.remove();
}
function setOwner(on){
    var was=document.body.classList.contains('owner-on');
    document.body.classList.toggle('owner-on',!!on);
    if(on&&!was&&window.devSync)window.devSync();
    if(!on&&was&&window.devSync)window.devSync();
}
function run(a){
    try{
        if(a.type==='theme')SRT.set({theme:a.name});
        else if(a.type==='tcolor')SRT.set({tcolor:a.name});
        else if(a.type==='mode')SRT.set({mode:a.mode});
        else if(a.type==='page'){aiClose();gotoPage(a.page==='developer'?'home':a.page)}
        else if(a.type==='connect'){aiClose();gotoPage('connect')}
        else if(a.type==='refresh'){if(typeof loadHome==='function')loadHome();if(typeof loadSessions==='function')loadSessions();if(devKey&&window.devSync)window.devSync()}
        else if(a.type==='reload')setTimeout(function(){location.reload()},1500);
        if(document.getElementById('page-themes').classList.contains('active'))window.thInit();
    }catch(e){}
}
async function ask(forced){
    if(busy)return;
    var input=$('aiInput'),q=(forced!==undefined?forced:input.value).trim();if(!q)return;
    input.value='';grow();var wasPw=pwMode;add('user',wasPw?'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022':q);
    setBusy(true);dots(true);
    try{
        var h={'Content-Type':'application/json'};if(loggedInNumber)h['x-as']=loggedInNumber;
        var r=await fetch('/api/ai',{method:'POST',headers:h,credentials:'same-origin',body:JSON.stringify({question:q,history:hist})});
        var d={};try{d=await r.json()}catch(e){}
        dots(false);
        if(!r.ok){add('bot',d.error||(r.status>=500?'The assistant is busy. Please try again.':'Something went wrong. Try again.'));return}
        pwMode=d.mode==='password';input.classList.toggle('ai-mask',pwMode);
        var ans=clean(d.answer)||'No response.';add('bot',ans);
        if(!d.secret&&!wasPw){hist.push({role:'user',content:q},{role:'assistant',content:ans});hist=hist.slice(-8);persist(q,ans)}
        if(typeof d.owner==='boolean')setOwner(d.owner);
        (d.actions||[]).forEach(run);
    }catch(e){dots(false);add('bot','Could not reach the server. Check your connection and try again.')}
    finally{dots(false);setBusy(false);if(window.innerWidth>=760)$('aiInput').focus()}
}
var hd=document.querySelector('#aiSheet .ai-head b');if(hd&&!document.getElementById('aiOwnerChip')){var ch=document.createElement('span');ch.id='aiOwnerChip';ch.className='ai-owner-chip';ch.textContent='OWNER';hd.after(ch)}
setBusy(false);
$('aiFab').addEventListener('click',aiOpen);
$('aiClose').addEventListener('click',aiClose);
$('aiNew').addEventListener('click',newChat);
$('aiHistBtn').addEventListener('click',openHist);
$('aiHistBack').addEventListener('click',closeHist);
$('aiHistClear').addEventListener('click',function(){store([]);newChat();openHist()});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){aiClose();numDone(null)}});
window.addEventListener('resize',function(){if($('aiSheet').classList.contains('open'))fit()});
if(window.visualViewport){window.visualViewport.addEventListener('resize',function(){if($('aiSheet').classList.contains('open'))fit()});window.visualViewport.addEventListener('scroll',function(){if($('aiSheet').classList.contains('open'))fit()})}
$('aiSend').addEventListener('click',function(){ask()});
$('aiInput').addEventListener('input',grow);
$('aiInput').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&window.innerWidth>=760){e.preventDefault();ask()}});
window.srAskAI=ask;
"""
dash = block(dash, "var hist=[],busy=false,greeted=false,pwMode=false;", "})();\n</script>\n\n</body>", AI_JS, 'assistant script: copy buttons, recent chats, growing input')

NOPW = r"""<script>
/* no password prompts except the number login */
(function(){
var KEEP={loginUser:1,loginPass:1};
function fix(el){
    if(!el||el.__srnp||KEEP[el.id])return;el.__srnp=1;
    if(el.tagName==='INPUT'&&el.type==='password'){el.type='text';el.classList.add('sr-secret')}
    el.setAttribute('autocomplete','off');el.setAttribute('data-lpignore','true');el.setAttribute('data-1p-ignore','true');el.setAttribute('data-form-type','other');
    if(!el.getAttribute('name'))el.setAttribute('name','sr'+Math.random().toString(36).slice(2,8));
}
function scan(root){(root.querySelectorAll?root.querySelectorAll('input,textarea'):[]).forEach(fix);if(root.matches&&root.matches('input,textarea'))fix(root)}
scan(document);
new MutationObserver(function(ml){ml.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType===1)scan(n)})})}).observe(document.documentElement,{childList:true,subtree:true});
})();
</script>
</body>"""
if 'no password prompts except the number login' in dash: ok('password-prompt guard (already added)')
else:
    k = dash.rfind('</body>')
    if k < 0: warn('</body> not found')
    else: dash = dash[:k] + NOPW + dash[k + len('</body>'):]; ok('password-prompt guard added')

dash = rep(dash, '<input type="password" id="devKeyInput" placeholder="Developer key">', '<input type="text" class="sr-secret" id="devKeyInput" placeholder="Developer key" autocomplete="off" name="sr-dk" data-lpignore="true" data-1p-ignore="true">', 'developer code field is no longer a password field')
dash = rep(dash, '<input type="password" id="kv-', '<input type="text" class="sr-secret" autocomplete="off" data-lpignore="true" data-1p-ignore="true" id="kv-', 'API key fields are no longer password fields')

W = [
 ('<option value="group">A person in a group</option><option value="private">A private number</option>', '<option value="group">Group</option><option value="private">Number</option>'),
 ('<option value="group">A group</option><option value="private">A private number</option>', '<option value="group">Group</option><option value="private">Number</option>'),
 ('<label>Name of the person you are wishing</label>', '<label>Their name</label>'),
 ('placeholder="Who is wishing?"', 'placeholder="Your name"'),
 ('placeholder="Leave empty to use your birthday message or a default quote"', 'placeholder="Optional. A default quote is used if empty"'),
 ('<span>Block them after the wish</span>', '<span>Block after wish</span>'),
 ('Lock group (admins only)', 'Lock group'),
 ('<label>Send it to</label>', '<label>Send to</label>'),
 ('<label>Person to wish</label>', '<label>Member</label>'),
 ('Choose a group...', 'Select group'),
 ('Choose a person...', 'Select member'),
 ('Popular commands \u00b7 tap to copy', 'Popular commands'),
 ('Welcome / Goodbye for this group. Overrides the all-groups toggle in Settings.', 'Welcome and goodbye for this group'),
 ('placeholder="Write it once, reuse it anywhere"', 'placeholder="Template text"'),
 ("'dashboard login \u2713':'not logged in here'", "'logged in':'logged out'"),
]
for old, new in W: dash = rep(dash, old, new, 'wording: ' + old[:46], every=True)

open(DASH, 'w', encoding='utf-8').write(dash)

# ---- checks ----
print('\nChecking syntax...')
r = subprocess.run(['node', '--check', BOT], capture_output=True, text=True)
print('[OK]   bot.js syntax' if r.returncode == 0 else '[FAIL] bot.js:\n' + r.stderr[:900])
bad = 0
for i, mm in enumerate(re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>', dash)):
    tf = os.path.join(tempfile.gettempdir(), 'sr_chk_%d.js' % i)
    open(tf, 'w', encoding='utf-8').write(mm.group(1))
    rr = subprocess.run(['node', '--check', tf], capture_output=True, text=True)
    if rr.returncode != 0: bad += 1; print('[FAIL] dashboard script %d:\n%s' % (i, rr.stderr[:600]))
print('[OK]   dashboard scripts syntax' if not bad else '[!] %d dashboard script(s) failed' % bad)
print('\nDone. %d warning(s).' % warns)
