const fs = require('fs');
let s = fs.readFileSync('bot.js', 'utf-8');

const anchor = "» ${p}${mono('rules')}          •  ${mono('Show group rules')}\\n` +\n        `\\n` +\n        `🎭 ${mono('FUN 2')}\\n` +";

const replace = "» ${p}${mono('rules')}          •  ${mono('Show group rules')}\\n` +\n        `» ${p}${mono('antibilling')}     •  ${mono('Anti-billing toggle')}\\n` +\n        `» ${p}${mono('billingwarn')}     •  ${mono('Warn a biller')}\\n` +\n        `» ${p}${mono('resetbilling')}    •  ${mono('Reset billing count')}\\n` +\n        `\\n` +\n        `🎭 ${mono('FUN 2')}\\n` +";

if (!s.includes(anchor)) { console.log('ERR: menu anchor missing'); process.exit(1); }
s = s.replace(anchor, replace);
fs.writeFileSync('bot.js', s);
console.log('MENU UPDATED');
