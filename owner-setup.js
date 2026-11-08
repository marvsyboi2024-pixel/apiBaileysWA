#!/usr/bin/env node
// owner-setup.js: run this in Termux. It asks for your secret phrase and password,
// then prints the values to paste into your host's environment variables.
// Nothing is saved to disk and nothing is sent anywhere.
const crypto = require('crypto')
const readline = require('readline')
const lines = process.stdin.isTTY ? null : readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]()
async function ask(prompt) {
    process.stdout.write(prompt)
    if (lines) { const r = await lines.next(); process.stdout.write('\n'); return r.done ? '' : r.value }
    return new Promise(resolve => {
        let buf = ''
        process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8')
        const onData = chunk => {
            for (const c of chunk) {
                if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', onData); process.stdout.write('\n'); return resolve(buf) }
                if (c === '\u0003') { process.stdout.write('\n'); process.exit(1) }
                if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue }
                if (c >= ' ') buf += c
            }
        }
        process.stdin.on('data', onData)
    })
}
;(async () => {
    console.log('\nOwner mode setup (what you type is hidden)\n')
    const phrase = (await ask('Secret phrase (you say this in the assistant to start): ')).toLowerCase().replace(/\s+/g, ' ').trim()
    if (phrase.length < 8) { console.log('\nUse a phrase of at least 8 characters, ideally several words.'); process.exit(1) }
    const p1 = await ask('Password (12+ characters): ')
    const p2 = await ask('Password again: ')
    if (p1 !== p2) { console.log('\nPasswords do not match. Run it again.'); process.exit(1) }
    if (p1.length < 12) { console.log('\nUse a password of at least 12 characters.'); process.exit(1) }
    const salt = crypto.randomBytes(16)
    console.log('\nAdd these 3 variables to your host (keep them private):\n')
    console.log('OWNER_PHRASE_HASH=' + crypto.createHash('sha256').update(phrase).digest('hex'))
    console.log('OWNER_PASS_HASH=' + salt.toString('hex') + ':' + crypto.scryptSync(p1, salt, 64).toString('hex'))
    console.log('OWNER_SECRET=' + crypto.randomBytes(32).toString('hex'))
    console.log('\nAlso add, for pushing code:')
    console.log('GITHUB_TOKEN=   a fine-grained token for ONLY your bot repo, Contents: read and write')
    console.log('GITHUB_REPO=    yourname/apiBaileysWA')
    console.log('GITHUB_BRANCH=main')
    console.log('\nThe phrase and password are not stored anywhere. Do not paste them in any chat.\n')
})()
