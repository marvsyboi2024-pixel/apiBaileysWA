import re, os, shutil, sys

FILE = 'bot.js'
BAK = FILE + '.bak'

if os.path.exists(BAK):
    src = BAK
    print('[i] Found bot.js.bak, patching from that original copy.')
else:
    shutil.copy(FILE, BAK)
    src = BAK
    print('[i] Saved backup as bot.js.bak')
content = open(src, encoding='utf-8').read()
failed = []

def ok(msg):   print('[OK]   ' + msg)
def warn(msg): print('[WARN] ' + msg); failed.append(msg)

def line_start(text, idx):
    return text.rfind('\n', 0, idx) + 1

# STEP 1: Move nested routes to the main block
a = content.find("if (url === '/api/templates')")
b = content.find("if (url === '/api/sessions') {", a) if a != -1 else -1
c = content.find("if (url === '/api/image') return J(403")
if a == -1 or b == -1 or c == -1 or not (c < a < b):
    warn('Step 1: could not find the route blocks to move (already moved?). Skipped.')
else:
    a_ls, b_ls, c_ls = line_start(content, a), line_start(content, b), line_start(content, c)
    chunk = content[a_ls:b_ls]
    content = content[:a_ls] + content[b_ls:]
    content = content[:c_ls] + chunk + '\n' + content[c_ls:]
    ok('Step 1: moved routes to where they can run')

# STEP 2: Localhost helper
helper = (
"const __isLocalReq = req => /localhost|127\\.0\\.0\\.1/.test(String(req.headers.host || '')) "
"&& !req.headers['x-forwarded-for'] "
"&& /^(::1|127\\.0\\.0\\.1|::ffff:127\\.0\\.0\\.1)$/.test(String(req.socket.remoteAddress || ''))\n\n")
m = re.search(r'^const server = http\.createServer\(', content, re.M)
if m and '__isLocalReq' not in content:
    content = content[:m.start()] + helper + content[m.start():]
    ok('Step 2: added localhost helper')
else:
    warn('Step 2: could not add localhost helper')

# STEP 3: Bypass Dev Key
n1 = re.subn(r"if\s*\(\s*!key\s*\)\s*return J\(403,", "if (!key && !__isLocalReq(req)) return J(403,", content)
content = n1[0]
n2 = re.subn(r"if\s*\(\s*req\.headers\['x-dev-key'\]\s*!==\s*key\s*\)\s*return J\(403,", "if (!__isLocalReq(req) && req.headers['x-dev-key'] !== key) return J(403,", content)
content = n2[0]
if n1[1] and n2[1]: ok('Step 3a: /api/dev accepts any key on localhost')
else: warn('Step 3a: /api/dev key check not found')

n3 = re.subn(r"if\s*\(\s*String\(req\.headers\['x-dev-key'\]\s*\|\|\s*''\)\s*!==\s*\(process\.env\.DEV_KEY\s*\|\|\s*''\)\s*\)\s*return J\(403,",
             "if (!user) return J(401, { error: 'Log in first.' })\n            if (!__isLocalReq(req) && String(req.headers['x-dev-key'] || '') !== (process.env.DEV_KEY || '')) return J(403,", content)
content = n3[0]
if n3[1]: ok('Step 3b: /api/dev-keys accepts any key on localhost')
else: warn('Step 3b: /api/dev-keys key check not found')

# STEP 4: Model Change
n4 = re.subn(r"model\s*:\s*'openai/gpt-oss-[^']*'", "model: 'llama-3.3-70b-versatile'", content)
content = n4[0]
if n4[1]: ok('Step 4: model set to llama-3.3-70b-versatile (%d places)' % n4[1])
else: warn('Step 4: no gpt-oss model string found')

# STEP 5: Error Logging
n5 = re.subn(r"catch\s*\(e\)\s*\{\s*return J\(502,\s*\{\s*error:\s*'The assistant could not respond", "catch (e) { console.log('[REAL AI ERROR]:', e.message); return J(502, { error: 'The assistant could not respond", content)
content = n5[0]
n6 = re.subn(r"console\.log\('\.ai error:',\s*e\?\.message\s*\|\|\s*e\)", "console.log('[REAL AI ERROR]:', e.message)", content)
content = n6[0]
if n5[1] and n6[1]: ok('Step 5: [REAL AI ERROR] logging added')
else: warn('Step 5: logging patch partly missing')

# STEP 6: Clean Chat History
n7 = re.subn(r"const history = Array\.isArray\(p\.history\) \? p\.history\.slice\(-10\) : \[\]",
 "const history = (Array.isArray(p.history) ? p.history.slice(-10) : [])\n"
 "                .filter(h => h && (h.role === 'user' || h.role === 'assistant') && h.content)\n"
 "                .map(h => ({ role: h.role, content: String(h.content).slice(0, 2000) }))", content)
content = n7[0]
if n7[1]: ok('Step 6: chat history cleaned')
else: warn('Step 6: history line not found')

open(FILE, 'w', encoding='utf-8').write(content)
print('\nDone. %d warning(s). Now run:  node --check bot.js && node bot.js' % len(failed))
