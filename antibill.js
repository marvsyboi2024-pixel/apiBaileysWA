const fs = require('fs');
let s = fs.readFileSync('bot.js', 'utf-8');

const W = ["send aza","send your aza","paste aza","abeg help me","abeg help","help me with","help a brother","help a sister","assist me","send me money","send me small","send small","send something","send me something","gift me","dash me","shout me","bless me","do me small","give me small","give me something","drop something","drop small","spray me","settle me","wire me","credit me","sapa","gbese","i no get money","i dey broke","i dey hustle","my billing","who can help","any amount","anything at all","borrow me small","loan me","abeg no stress","begi-begi","beg too much","dey owe","i go pay you back","i go refund","rent don due","school fees","transport money"];

const decl = "\n\nconst BILLING_WORDS = " + JSON.stringify(W) + ";\n";
const anchor = "const BAD_WORDS = [";
if (!s.includes(anchor)) { console.log('ERR: anchor missing'); process.exit(1); }
const endIdx = s.indexOf(']', s.indexOf(anchor)) + 1;
s = s.slice(0, endIdx) + decl + s.slice(endIdx);
fs.writeFileSync('bot.js', s);
console.log('WORDS ADDED');
