import re, os, shutil, subprocess

DEVSTATE = "/* ===== SR DEV STATE v2: the database is the single source of truth, nothing gets brought back ===== */\nconst __devOps = []\nlet __devPump = false, __devRetry = 0, __devFull = false, __devQ = Promise.resolve()\nconst srSleep = ms => new Promise(r => setTimeout(r, ms))\nfunction srDevSnapshot(full) {\n    const s = { disabled: DEV.disabled, maintenance: DEV.maintenance, ownerOnly: DEV.ownerOnly, maxSlots: DEV.maxSlots, rev: DEV.rev || 0 }\n    if (DEV.ui) s.ui = DEV.ui\n    if (DEV.aiOff) s.aiOff = DEV.aiOff\n    if (full) { s.blocked = DEV.blocked; s.blockedInfo = DEV.blockedInfo }\n    return s\n}\nasync function srDevWrite() {\n    if (!settingsCollection) throw new Error('database not connected')\n    while (__devOps.length) {\n        const op = __devOps[0]\n        if (op.t === 'add') await settingsCollection.updateOne({ _id: 'dev_state' }, { $addToSet: { blocked: op.n }, $set: { ['blockedInfo.' + op.n]: op.info } }, { upsert: true })\n        else await settingsCollection.updateOne({ _id: 'dev_state' }, { $pull: { blocked: op.n }, $unset: { ['blockedInfo.' + op.n]: '' } }, { upsert: true })\n        __devOps.shift()\n    }\n    const snap = srDevSnapshot(__devFull)\n    __devFull = false\n    DEV.pending = false\n    try { await settingsCollection.updateOne({ _id: 'dev_state' }, { $set: snap }, { upsert: true }) }\n    catch (e) { DEV.pending = true; if (snap.blocked) __devFull = true; throw e }\n    try { fs.writeFileSync(DEV_FILE, JSON.stringify(DEV)) } catch (e) {}\n}\nfunction srDevRun() { const p = __devQ.then(srDevWrite); __devQ = p.catch(() => {}); return p }\nasync function srDevPump() {\n    if (__devPump) return\n    __devPump = true\n    try {\n        while (DEV.pending || __devOps.length) {\n            if (!MONGO_URI) { DEV.pending = false; __devOps.length = 0; break }\n            try { await srDevRun(); __devRetry = 0 }\n            catch (e) {\n                __devRetry++\n                if (__devRetry === 1 || __devRetry % 10 === 0) console.log('[DEV] database save failed, will retry: ' + String(e.message).slice(0, 100))\n                await srSleep(Math.min(60000, 1500 * __devRetry))\n            }\n        }\n    } finally { __devPump = false }\n}\nfunction srSaveDevMongo() { DEV.pending = true; srDevPump() }\nasync function srDevFlush() {\n    if (!MONGO_URI) return true\n    try { await srDevRun(); return true } catch (e) { srDevPump(); return false }\n}\nfunction srAdoptDev(v) {\n    DEV.blocked = Array.isArray(v.blocked) ? v.blocked.map(String) : []\n    DEV.blockedInfo = Object.assign({}, srInfoFromLog(v.blockLog), v.blockedInfo && typeof v.blockedInfo === 'object' ? v.blockedInfo : {})\n    DEV.disabled = Array.isArray(v.disabled) ? v.disabled : []\n    if (typeof v.maintenance === 'boolean') DEV.maintenance = v.maintenance\n    if (typeof v.ownerOnly === 'boolean') DEV.ownerOnly = v.ownerOnly\n    if (v.maxSlots !== undefined) DEV.maxSlots = Math.max(0, parseInt(v.maxSlots) || 0)\n    if (v.ui && typeof v.ui === 'object') DEV.ui = v.ui\n    if (Array.isArray(v.aiOff)) DEV.aiOff = v.aiOff\n    DEV.rev = v.rev || 0\n}\nasync function srLoadDevMongo() {\n    try {\n        if (!settingsCollection) return\n        const d = await settingsCollection.findOne({ _id: 'dev_state' })\n        if (!d) { DEV.rev = DEV.rev || Date.now(); DEV.pending = true; __devFull = true; srDevPump(); return }\n        const v = (d.value && typeof d.value === 'object') ? d.value : d\n        if (__devOps.length || (DEV.pending && (DEV.rev || 0) > (v.rev || 0))) { console.log('[DEV] pushing local changes that were not saved yet'); __devFull = true; srDevPump(); return }\n        srAdoptDev(v)\n        try { fs.writeFileSync(DEV_FILE, JSON.stringify(DEV)) } catch (e) {}\n        console.log('[DEV] state loaded from the database (' + DEV.blocked.length + ' blocked)')\n    } catch (e) { console.log('[DEV] could not load from the database: ' + String(e.message).slice(0, 100)) }\n}\nsetInterval(async () => {\n    try {\n        if (!settingsCollection || DEV.pending || __devOps.length) return\n        const d = await settingsCollection.findOne({ _id: 'dev_state' }); if (!d) return\n        const v = (d.value && typeof d.value === 'object') ? d.value : d\n        if ((v.rev || 0) > (DEV.rev || 0)) { srAdoptDev(v); console.log('[DEV] picked up a newer state from the database') }\n    } catch (e) {}\n}, 45000).unref()\nprocess.on('SIGTERM', async () => { try { await Promise.race([srDevFlush(), srSleep(3000)]) } catch (e) {} process.exit(0) })\n"

BOT = 'bot.js'
if not os.path.exists(BOT):
    print('[!] Run this inside ~/apiBaileysWA'); raise SystemExit(1)
if not os.path.exists('bot.before-blockfix.js'): shutil.copy(BOT, 'bot.before-blockfix.js')
bot = open(BOT, encoding='utf-8').read()
warns = 0
def ok(m): print('[OK]   ' + m)
def warn(m):
    global warns; warns += 1; print('[WARN] ' + m)

if 'SR DEV STATE v2' in bot: ok('blocked-list fix (already done)')
else:
    # 1) saveDev: stamp every change so the newest state always wins
    m = re.search(r"^function saveDev\(\) \{.*\}$", bot, flags=re.M)
    if m:
        bot = bot[:m.start()] + "function saveDev() { DEV.rev = Date.now(); DEV.pending = true; try { fs.writeFileSync(DEV_FILE, JSON.stringify(DEV)) } catch (e) {}; try { srSaveDevMongo() } catch (e) {} }" + bot[m.end():]; ok('saveDev stamps every change')
    else: warn('saveDev not found')
    # 2) save/load: replace the whole block
    i = bot.find('function srSaveDevMongo() {'); j = bot.find('function srBlockedList() {', i) if i >= 0 else -1
    if i < 0 or j < 0: warn('save/load block not found')
    else: bot = bot[:i] + DEVSTATE + '\n' + bot[j:]; ok('database save/load rewritten: no union, retries, restores maintenance and slots')
    # 3) block / unblock become safe one-step database operations
    b = re.search(r"^function srBlock\(n, via\) \{.*\}$", bot, flags=re.M)
    u = re.search(r"^function srUnblock\(n\) \{.*\}$", bot, flags=re.M)
    if b and u:
        nb = "function srBlock(n, via) { if (!DEV.blocked.includes(n)) DEV.blocked.push(n); const info = { at: Date.now(), via: via || 'block' }; DEV.blockedInfo[n] = info; __devOps.push({ t: 'add', n, info }) }"
        nu = "function srUnblock(n) { DEV.blocked = DEV.blocked.filter(x => x !== n); delete DEV.blockedInfo[n]; __devOps.push({ t: 'del', n }) }"
        bot = bot.replace(b.group(0), nb, 1).replace(u.group(0), nu, 1); ok('block and unblock are saved as single database steps')
    else: warn('srBlock/srUnblock not found')
    # 4) the dashboard waits for the database before it says "done"
    old = "saveDev(); J(200, { ok: true, blocked: srBlockedList() })"
    new = "saveDev(); const __saved = await srDevFlush(); J(200, { ok: true, blocked: srBlockedList(), saved: __saved })"
    if old in bot: bot = bot.replace(old, new, 1); ok('developer actions report whether the database saved')
    else: warn('developer action end not found')
    old = "else if (p.action === 'restart') { J(200, { ok: true }); setTimeout(() => process.exit(0), 600); return }"
    new = "else if (p.action === 'restart') { await srDevFlush(); J(200, { ok: true }); setTimeout(() => process.exit(0), 600); return }"
    if old in bot: bot = bot.replace(old, new, 1); ok('restart saves first')
    elif new in bot: pass
    else: warn('restart action not found')
open(BOT, 'w', encoding='utf-8').write(bot)

# keep the local state file out of GitHub (a copy of it in the repo can bring old blocks back after a redeploy)
gi = open('.gitignore', encoding='utf-8').read() if os.path.exists('.gitignore') else ''
if 'dev_state.json' not in gi.split('\n'):
    open('.gitignore', 'a', encoding='utf-8').write(('' if gi.endswith('\n') or not gi else '\n') + 'dev_state.json\n'); ok('.gitignore: dev_state.json')
try:
    tracked = subprocess.run(['git', 'ls-files', '--error-unmatch', 'dev_state.json'], capture_output=True, text=True).returncode == 0
    if tracked:
        subprocess.run(['git', 'rm', '--cached', '-q', 'dev_state.json'], capture_output=True, text=True); ok('dev_state.json was in your GitHub copy: it will be removed from GitHub on your next push')
except Exception: pass

r = subprocess.run(['node', '--check', BOT], capture_output=True, text=True)
print('[OK]   bot.js syntax' if r.returncode == 0 else '[FAIL] bot.js:\n' + r.stderr[:900])
print('\nDone. %d warning(s).' % warns)
