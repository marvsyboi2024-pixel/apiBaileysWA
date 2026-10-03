const fs = require('fs');
let s = fs.readFileSync('bot.js', 'utf-8');

const helper = `function detectBilling(text) {
    if (!text) return false
    const lower = String(text).toLowerCase()
    for (const w of BILLING_WORDS) {
        if (lower.includes(w)) return w
    }
    return false
}

async function enforceAntiBilling(sock, ctx, msg, content, from, sender, senderNumber, text) {
    const settings = ctx.groupSettings[from]
    if (!settings || !settings.antibilling) return false
    const hit = detectBilling(text)
    if (!hit) return false
    if (await checkAdmin(ctx, sock, from, [sender])) return false
    const realNum = await resolveNumber(ctx, sock, from, sender)
    const botAdmin = await checkAdmin(ctx, sock, from, [...botIds(sock)])
    try { await sock.sendMessage(from, { delete: msg.key }) } catch (e) {}
    if (!ctx.billingCounts) ctx.billingCounts = {}
    if (!ctx.billingCounts[from]) ctx.billingCounts[from] = {}
    const k = cleanJid(sender)
    ctx.billingCounts[from][k] = (ctx.billingCounts[from][k] || 0) + 1
    const limit = (ctx.billingLimit && ctx.billingLimit[from]) ? ctx.billingLimit[from] : 3
    const count = ctx.billingCounts[from][k]
    const lines = ['Oga, no dey bill for here. Go hustle.','Chill. This one no be begging group.','Ah ah, na so poverty dey talk?','You come this group come beg? Nawa for you o.','Billing no dey work here. Take your hustle serious.','Oga, na only you dey hungry? Waka pass.','See begging. Go find work jor.','No be here o. This one no be MTN foundation.','You don bill us. Respect yourself.','Billing? Not today.']
    const kickLines = ['WAHALA DON LAND. HIM DON COMMOT.','WE DON SHOW AM GATE.','NA SO BEGGING TAKE END FOR HERE.','HUSTLE OR LEAVE. HIM DON LEAVE.','BILLING NA CRIME. HIM DON SERVE HIM SENTENCE.','THE REALM NO DEY CARRY BEGGAR. HIM DON GO.','GO BEG FOR ANOTHER GROUP.','NA ME SEND AM COMOT. MAKE E GO HUSTLE.','REJECTED AND DEPORTED.','A TRUE BEGGAR NEVER WIN. HIM DON GO.']
    if (count >= limit && botAdmin) {
        const sent = await sock.sendMessage(from, {
            text: skInfo('\\u{1F6E1}\\uFE0F', 'ANTI-BILLING', [['USER', '@' + realNum],['COUNT', count + ' / ' + limit]]) + '\\n\\n👢 ' + mono('COMMOT AM...'),
            mentions: mentionJids(sock, [sender], [realNum])
        })
        await sleep(1200)
        try { await participantsUpdate(sock, from, [sender], 'remove') } catch (e) {}
        if (sent && sent.key) {
            try {
                await sock.sendMessage(from, {
                    text: skInfo('\\u{1F6E1}\\uFE0F', 'ANTI-BILLING', [['USER', '@' + realNum],['COUNT', count + ' / ' + limit]]) + '\\n\\n🚪 ' + kickLines[Math.floor(Math.random() * kickLines.length)],
                    edit: sent.key,
                    mentions: mentionJids(sock, [sender], [realNum])
                })
            } catch (e) {}
        }
        delete ctx.billingCounts[from][k]
    } else {
        await sock.sendMessage(from, {
            text: skInfo('\\u{1F6E1}\\uFE0F', 'ANTI-BILLING', [['USER', '@' + realNum],['REASON', 'Billing detected'],['COUNT', count + ' / ' + limit]]) + '\\n\\n» ' + mono(lines[Math.floor(Math.random() * lines.length)]),
            mentions: mentionJids(sock, [sender], [realNum])
        })
    }
    return true
}

function detectViolation(ctx, settings, msg, content, ci, text, from, sender) {`;

const anchor = 'function detectViolation(ctx, settings, msg, content, ci, text, from, sender) {';
if (!s.includes(anchor)) { console.log('ERR: anchor missing'); process.exit(1); }
s = s.replace(anchor, helper);
fs.writeFileSync('bot.js', s);
console.log('HELPERS ADDED');
