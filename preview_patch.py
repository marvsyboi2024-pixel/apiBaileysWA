import re, sys

PATH = 'bot.js'  # change if your file lives elsewhere
with open(PATH, 'r', encoding='utf-8') as f:
    content = f.read()

changes = []

def must_replace(old, new, label, count=1):
    global content
    n = content.count(old)
    if n == 0:
        print(f"[SKIP] anchor not found for: {label}")
        return
    if n > count:
        print(f"[WARN] anchor for '{label}' appears {n} times, expected {count} - applying to first {count} only")
    content = content.replace(old, new, count)
    changes.append(label)

# A. new logo2 path constant
must_replace(
    "const LOGO_PATH = path.join('.', 'logo.png')",
    "const LOGO_PATH = path.join('.', 'logo.png')\nconst MENU2_LOGO_PATH = path.join('.', 'logo2.png')",
    "MENU2_LOGO_PATH const"
)

# B. new mongo helpers for menu2 logo
must_replace(
    "    } catch (e) { console.log('[MONGO] Logo load error:', e.message) }\n    return false\n}",
    "    } catch (e) { console.log('[MONGO] Logo load error:', e.message) }\n    return false\n}\n\n"
    "async function saveMenu2LogoToMongo(buffer) {\n"
    "    if (!logoCollection) return\n"
    "    try {\n"
    "        await logoCollection.updateOne(\n"
    "            { _id: 'menu2logo' },\n"
    "            { $set: { data: buffer.toString('base64'), updatedAt: new Date() } },\n"
    "            { upsert: true }\n"
    "        )\n"
    "    } catch (e) { console.log('[MONGO] Menu2 logo save error:', e.message) }\n"
    "}\n\n"
    "async function loadMenu2LogoFromMongo() {\n"
    "    if (!logoCollection) return false\n"
    "    try {\n"
    "        const doc = await logoCollection.findOne({ _id: 'menu2logo' })\n"
    "        if (doc && doc.data) {\n"
    "            fs.writeFileSync(MENU2_LOGO_PATH, Buffer.from(doc.data, 'base64'))\n"
    "            return true\n"
    "        }\n"
    "    } catch (e) { console.log('[MONGO] Menu2 logo load error:', e.message) }\n"
    "    return false\n"
    "}",
    "saveMenu2LogoToMongo/loadMenu2LogoFromMongo functions"
)

# C. load menu2 logo at startup, right after the main logo loads
must_replace(
    "    await loadLogoFromMongo()",
    "    await loadLogoFromMongo()\n    await loadMenu2LogoFromMongo()",
    "startup load call"
)

# D. route allow-list
must_replace(
    "if (url === '/' || url === '/dashboard' || url === '/logo.png' || url === '/upload-logo' || url === '/api/sessions') {",
    "if (url === '/' || url === '/dashboard' || url === '/logo.png' || url === '/logo2.png' || url === '/upload-logo' || url === '/upload-logo2' || url === '/api/sessions') {",
    "route allow-list"
)

# E. new HTTP handlers for logo2, inserted right after the existing /logo.png block
must_replace(
    "        if (url === '/logo.png') {\n"
    "            if (fs.existsSync(LOGO_PATH)) {\n"
    "                const buf = fs.readFileSync(LOGO_PATH)\n"
    "                res.writeHead(200, { 'Content-Type': sniffImageType(buf) || 'image/png' })\n"
    "                res.end(buf)\n"
    "            } else { res.writeHead(404); res.end('No logo') }\n"
    "            return\n"
    "        }",
    "        if (url === '/logo.png') {\n"
    "            if (fs.existsSync(LOGO_PATH)) {\n"
    "                const buf = fs.readFileSync(LOGO_PATH)\n"
    "                res.writeHead(200, { 'Content-Type': sniffImageType(buf) || 'image/png' })\n"
    "                res.end(buf)\n"
    "            } else { res.writeHead(404); res.end('No logo') }\n"
    "            return\n"
    "        }\n\n"
    "        if (url === '/upload-logo2' && req.method === 'POST') {\n"
    "            const chunks = []\n"
    "            let size = 0\n"
    "            let aborted = false\n"
    "            req.on('data', c => {\n"
    "                size += c.length\n"
    "                if (size > 5 * 1024 * 1024) { aborted = true; res.writeHead(413); res.end('Too large'); req.destroy(); return }\n"
    "                chunks.push(c)\n"
    "            })\n"
    "            req.on('end', async () => {\n"
    "                if (aborted) return\n"
    "                try {\n"
    "                    const buffer = Buffer.concat(chunks)\n"
    "                    const ct = req.headers['content-type'] || ''\n"
    "                    const boundary = ct.split('boundary=')[1]\n"
    "                    if (boundary) {\n"
    "                        const parts = buffer.toString('binary').split('--' + boundary)\n"
    "                        for (const part of parts) {\n"
    "                            if (part.includes('filename=') && /Content-Type: image/i.test(part)) {\n"
    "                                const headerEnd = part.indexOf('\\r\\n\\r\\n')\n"
    "                                let imgData = part.slice(headerEnd + 4).replace(/\\r\\n$/, '')\n"
    "                                const imgBuffer = Buffer.from(imgData, 'binary')\n"
    "                                if (sniffImageType(imgBuffer)) {\n"
    "                                    fs.writeFileSync(MENU2_LOGO_PATH, imgBuffer)\n"
    "                                    await saveMenu2LogoToMongo(imgBuffer)\n"
    "                                }\n"
    "                                break\n"
    "                            }\n"
    "                        }\n"
    "                    }\n"
    "                } catch (e) { console.log('Menu2 logo upload error:', e?.message || e) }\n"
    "                res.writeHead(302, { Location: '/dashboard' })\n"
    "                res.end()\n"
    "            })\n"
    "            return\n"
    "        }\n\n"
    "        if (url === '/logo2.png') {\n"
    "            if (fs.existsSync(MENU2_LOGO_PATH)) {\n"
    "                const buf = fs.readFileSync(MENU2_LOGO_PATH)\n"
    "                res.writeHead(200, { 'Content-Type': sniffImageType(buf) || 'image/png' })\n"
    "                res.end(buf)\n"
    "            } else { res.writeHead(404); res.end('No logo') }\n"
    "            return\n"
    "        }",
    "/upload-logo2 and /logo2.png handlers"
)

# F. dashboard upload form for menu2 logo
must_replace(
    '<div class="card">\n<h3>CONNECT WHATSAPP</h3>',
    '<div class="card">\n<h3>UPLOAD MENU2 LOGO</h3>\n'
    '<form method="POST" action="/upload-logo2" enctype="multipart/form-data">\n'
    '<input type="file" name="logo" accept="image/*" required>\n'
    '<button type="submit">Upload Menu2 Logo</button>\n'
    '</form>\n</div>\n\n'
    '<div class="card">\n<h3>CONNECT WHATSAPP</h3>',
    "menu2 upload form in dashboard HTML"
)

# --- G & H: edits that exist in BOTH the dead and live copies of handleCommand ---
# Find the live copy by locating the SECOND occurrence of its signature, and only
# edit within the text from that point onward, so the dead copy is never touched.
sig = "async function handleCommand(sock, ctx, msg, content, from, isGroup, sender, senderNumber, owner, cmd, args) {"
first = content.find(sig)
second = content.find(sig, first + 1)
if first == -1 or second == -1:
    print("[ERROR] could not locate both handleCommand copies - skipping G/H, check manually")
else:
    head, tail = content[:second], content[second:]

    # G. ping + alive now attach the logo image if one's been uploaded
    old_g = (
        "    if (cmd === 'ping') {\n"
        "        const latency = Math.max(1, Date.now() - ((msg.messageTimestamp || 0) * 1000))\n"
        "        return reply(withFooter(`${SK_HEADER}\\n\\n✅ ${mono('PONG')}\\n\\n» ${mono('STATUS')}  •  🟢 ${mono('ONLINE')}\\n» ${mono('LATENCY')}  •  ${mono(String(latency) + ' ms')}`))\n"
        "    }\n"
        "    if (cmd === 'alive') return reply(skSuccess('ALIVE', 'READY'))"
    )
    new_g = (
        "    if (cmd === 'ping') {\n"
        "        const latency = Math.max(1, Date.now() - ((msg.messageTimestamp || 0) * 1000))\n"
        "        const pingText = withFooter(`${SK_HEADER}\\n\\n✅ ${mono('PONG')}\\n\\n» ${mono('STATUS')}  •  🟢 ${mono('ONLINE')}\\n» ${mono('LATENCY')}  •  ${mono(String(latency) + ' ms')}`)\n"
        "        if (fs.existsSync(LOGO_PATH)) {\n"
        "            try {\n"
        "                const buffer = fs.readFileSync(LOGO_PATH)\n"
        "                await sock.sendMessage(from, { image: buffer, caption: pingText }, { quoted: msg })\n"
        "                return\n"
        "            } catch (e) { console.log('Ping image failed:', e?.message || e) }\n"
        "        }\n"
        "        return reply(pingText)\n"
        "    }\n"
        "    if (cmd === 'alive') {\n"
        "        const aliveText = skSuccess('ALIVE', 'READY')\n"
        "        if (fs.existsSync(LOGO_PATH)) {\n"
        "            try {\n"
        "                const buffer = fs.readFileSync(LOGO_PATH)\n"
        "                await sock.sendMessage(from, { image: buffer, caption: aliveText }, { quoted: msg })\n"
        "                return\n"
        "            } catch (e) { console.log('Alive image failed:', e?.message || e) }\n"
        "        }\n"
        "        return reply(aliveText)\n"
        "    }"
    )
    if old_g in tail:
        tail = tail.replace(old_g, new_g, 1)
        changes.append("ping/alive logo attach (live copy)")
    else:
        print("[SKIP] ping/alive anchor not found in live section - check manually, wording may differ")

    # H. menu2 sends its own logo first, if one's been uploaded
    old_h = "            await MENU2.sendMain(sock, from)"
    new_h = (
        "            if (fs.existsSync(MENU2_LOGO_PATH)) {\n"
        "                try { await sock.sendMessage(from, { image: fs.readFileSync(MENU2_LOGO_PATH) }, { quoted: msg }) }\n"
        "                catch (e) { console.log('Menu2 image failed:', e?.message || e) }\n"
        "            }\n"
        "            await MENU2.sendMain(sock, from)"
    )
    if old_h in tail:
        tail = tail.replace(old_h, new_h, 1)
        changes.append("menu2 logo attach (live copy)")
    else:
        print("[SKIP] menu2 anchor not found in live section - check manually, wording may differ")

    content = head + tail

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(content)

print("\nApplied:", len(changes), "changes")
for c in changes:
    print(" -", c)
