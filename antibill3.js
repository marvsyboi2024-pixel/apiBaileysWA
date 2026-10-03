const fs = require('fs');
let s = fs.readFileSync('bot.js', 'utf-8');

const oldCall = '        const handled = await enforceProtection(sock, ctx, msg, content, from, sender, senderNumber, text)\n        if (handled) return';
const newCall = '        const billingHandled = await enforceAntiBilling(sock, ctx, msg, content, from, sender, senderNumber, text)\n        if (billingHandled) return\n        const handled = await enforceProtection(sock, ctx, msg, content, from, sender, senderNumber, text)\n        if (handled) return';

if (!s.includes(oldCall)) { console.log('ERR: call anchor missing'); process.exit(1); }
s = s.replace(oldCall, newCall);
fs.writeFileSync('bot.js', s);
console.log('WIRED');
