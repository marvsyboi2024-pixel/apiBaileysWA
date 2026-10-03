const fs = require('fs');
let s = fs.readFileSync('bot.js', 'utf-8');

const cmds = `    // ── ANTI-BILLING ──
    if (cmd === 'antibilling') {
        if (!(await needManage())) return
        if (!ctx.groupSettings[from]) ctx.groupSettings[from] = {}
        if (args[0] === 'on' || args[0] === 'off') {
            ctx.groupSettings[from].antibilling = args[0] === 'on'
            saveCtx(ctx)
            return reply(skInfo('\\u{1F6E1}\\uFE0F', 'ANTI-BILLING', [
                ['STATUS', args[0] === 'on' ? '\\u{1F7E2} ON' : '\\u{1F534} OFF'],
                ['USAGE', '3 bills = kick (if bot admin)']
            ]))
        }
        const cur = ctx.groupSettings[from].antibilling ? '\\u{1F7E2} ON' : '\\u{1F534} OFF'
        return reply(skInfo('\\u{1F6E1}\\uFE0F', 'ANTI-BILLING', [
            ['STATUS', cur],
            ['LIMIT', '3 bills'],
            ['ACTION', 'Kick if bot admin, warn if not']
        ]))
    }
    if (cmd === 'billingwarn') {
        if (!(await needManage())) return
        const target = getTarget(content)
        if (!target) return reply(skError('Mention or reply to a user.'))
        const realNum = await resolveNumber(ctx, sock, from, target)
        if (!ctx.billingCounts) ctx.billingCounts = {}
        if (!ctx.billingCounts[from]) ctx.billingCounts[from] = {}
        const k = cleanJid(target)
        ctx.billingCounts[from][k] = (ctx.billingCounts[from][k] || 0) + 1
        const limit = (ctx.billingLimit && ctx.billingLimit[from]) ? ctx.billingLimit[from] : 3
        return sock.sendMessage(from, {
            text: skInfo('\\u26A0\\uFE0F', 'BILLING WARN', [
                ['USER', '@' + realNum],
                ['COUNT', ctx.billingCounts[from][k] + ' / ' + limit]
            ]),
            mentions: mentionJids(sock, [target], [realNum])
        }, { quoted: msg })
    }
    if (cmd === 'resetbilling') {
        if (!(await needManage())) return
        const target = getTarget(content)
        if (!target) return reply(skError('Mention or reply to a user.'))
        const realNum = await resolveNumber(ctx, sock, from, target)
        if (ctx.billingCounts && ctx.billingCounts[from]) delete ctx.billingCounts[from][cleanJid(target)]
        return sock.sendMessage(from, {
            text: skInfo('\\u2705', 'RESET BILLING', [
                ['USER', '@' + realNum],
                ['COUNT', '0 / 3']
            ]),
            mentions: mentionJids(sock, [target], [realNum])
        }, { quoted: msg })
    }

`;

const anchor = '    // Ritual reply handling';
if (!s.includes(anchor)) { console.log('ERR: anchor missing'); process.exit(1); }
s = s.replace(anchor, cmds + anchor);
fs.writeFileSync('bot.js', s);
console.log('COMMANDS ADDED');
