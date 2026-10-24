'use strict';

const GATE_URL = 'https://squichy-gate.vercel.app'; 
const FILES = ['pair.js', 'case.js'];
const CHECK_EVERY_MS = 5 * 60 * 1000;
const BOT_NAME = 'SQUICHY BOT';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');
const readline = require('readline');
const chalk = require('chalk');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');

const ROOT = __dirname;
const SESSION_DIR = path.join(ROOT, 'session');
const NUMBER_FILE = path.join(SESSION_DIR, 'number.txt');
const ETAG_FILE = path.join(ROOT, '.gh-etags.json');
const KEY_FILE = path.join(ROOT, '.squichy-key');
function styled(text) {
    return String(text).replace(/[A-Za-z0-9]/g, (ch) => {
        const c = ch.codePointAt(0);
        if (ch >= 'A' && ch <= 'Z') return String.fromCodePoint(0x1D670 + (c - 65));
        if (ch >= 'a' && ch <= 'z') return String.fromCodePoint(0x1D68A + (c - 97));
        return String.fromCodePoint(0x1D7F6 + (c - 48));
    });
}
const W = 46;
const len = (s) => Array.from(s).length;
const center = (s, w = W) => {
    const pad = Math.max(0, w - len(s));
    return ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(Math.ceil(pad / 2));
};
const line = (c = '─') => chalk.cyan(c.repeat(W));
function box(rows, color = chalk.cyan) {
    console.log(color('╭' + '─'.repeat(W) + '╮'));
    for (const r of rows) console.log(color('│') + center(r) + color('│'));
    console.log(color('╰' + '─'.repeat(W) + '╯'));
}
const log = {
    step: (t) => console.log(chalk.cyan(' ✦ ') + chalk.white.bold(styled(t))),
    ok:   (t) => console.log(chalk.green(' ✔ ') + chalk.green(styled(t))),
    warn: (t) => console.log(chalk.yellow(' ⚠ ') + chalk.yellow(styled(t))),
    err:  (t) => console.log(chalk.red(' ✖ ') + chalk.red(styled(t))),
    info: (t) => console.log(chalk.gray(' ➜ ') + chalk.gray(styled(t))),
    raw:  (t) => console.log(t)
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function banner() {
    console.clear();
    box(['', chalk.bold.magenta(styled(BOT_NAME)), chalk.gray(styled('WhatsApp Bot  •  Pairing Code')), ''], chalk.magenta);
    console.log('');
}

class Fatal extends Error {}

const readEtags = () => { try { return JSON.parse(fs.readFileSync(ETAG_FILE, 'utf8')); } catch (e) { return {}; } };
const writeEtags = (o) => { try { fs.writeFileSync(ETAG_FILE, JSON.stringify(o)); } catch (e) {} };

function gateRequest(query, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const base = new URL(GATE_URL);
        const lib = base.protocol === 'http:' ? require('http') : https;
        const req = lib.request({
            hostname: base.hostname,
            port: base.port || undefined,
            path: '/api/gate?' + query,
            method,
            headers: { 'User-Agent': 'squichy-loader', ...headers },
            timeout: 30000
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

let gateKey = (() => { try { return fs.readFileSync(KEY_FILE, 'utf8').trim() || null; } catch (e) { return null; } })();

const jsonOf = (r) => { try { return JSON.parse(r.body); } catch (e) { return {}; } };

async function registerKey() {
    let r;
    try { r = await gateRequest('a=register&n=' + encodeURIComponent(number || ''), { method: 'POST' }); }
    catch (e) { throw new Error('update server unreachable (' + e.message + ')'); }
    const j = jsonOf(r);
    if (r.status === 403) throw new Fatal(j.error === 'revoked' ? 'Access revoked by the owner' : 'New installations are closed');
    if (r.status === 429) throw new Error('too many attempts, try again later');
    if (r.status !== 200 || !j.key) throw new Error('registration failed (HTTP ' + r.status + ')');
    gateKey = j.key;
    fs.writeFileSync(KEY_FILE, gateKey, { mode: 0o600 });
    log.ok('Access key created');
}

function fetchFile(file, etag) {
    const headers = { authorization: 'Bearer ' + gateKey, 'x-bot-number': number || '' };
    if (etag) headers['x-etag'] = etag;
    return gateRequest('a=file&f=' + file, { headers });
}

function syntaxOk(code) {
    try { new vm.Script('(function(exports,require,module,__filename,__dirname){' + code + '\n})'); return true; }
    catch (e) { return e.message; }
}

function explainHttp(file, r) {
    const j = jsonOf(r);
    if (r.status === 502) return `GitHub error ${j.status || ''} on the server side`;
    if (r.status === 500) return 'update server not configured';
    if (r.status === 404) return 'update server address is wrong';
    if (r.status === 401 && /login|authentication/i.test(r.body)) return 'Vercel protection is enabled on the server';
    return `HTTP ${r.status}`;
}
async function syncFiles({ verbose }) {
    if (!gateKey) await registerKey();
    const etags = readEtags();
    const updated = [];
    for (const file of FILES) {
        const local = path.join(ROOT, file);
        const has = fs.existsSync(local);
        try {
            let r = await fetchFile(file, has ? etags[file] : null);
            if (r.status === 401 && jsonOf(r).error === 'invalid key') {
                gateKey = null;
                try { fs.unlinkSync(KEY_FILE); } catch (e) {}
                await registerKey();
                r = await fetchFile(file, has ? etags[file] : null);
            }
            if (r.status === 403 && jsonOf(r).error === 'revoked') throw new Fatal('Access revoked by the owner');
            if (r.status === 304) { if (verbose) log.ok(`${file}  up to date`); continue; }
            if (r.status !== 200) throw new Error(explainHttp(file, r));
            if (!r.body || r.body.length < 20) throw new Error('empty file received');
            const etag = r.headers['x-file-etag'];
            const check = syntaxOk(r.body);
            if (check !== true) {
                if (has && etag) etags[file] = etag;
                throw new Error('syntax error in remote file: ' + check);
            }
            if (has) fs.copyFileSync(local, local + '.prev');
            fs.writeFileSync(local + '.tmp', r.body);
            fs.renameSync(local + '.tmp', local);
            if (etag) etags[file] = etag;
            updated.push(file);
            log.ok(`${file}  ${has ? 'updated' : 'downloaded'}`);
        } catch (e) {
            if (e instanceof Fatal) { writeEtags(etags); throw e; }
            if (has) log.warn(`${file}  ${e.message} — using local copy`);
            else { writeEtags(etags); throw new Error(`${file}: ${e.message}`); }
        }
    }
    writeEtags(etags);
    return updated;
}

let Pair = null;
let Case = null;

function loadModules() {
    for (const f of FILES) delete require.cache[require.resolve(path.join(ROOT, f))];
    Pair = require(path.join(ROOT, 'pair.js'));
    Case = require(path.join(ROOT, 'case.js'));
    if (typeof Case !== 'function') throw new Error('case.js must export a function');
}

function restorePrevious(files) {
    for (const f of files) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p + '.prev')) fs.copyFileSync(p + '.prev', p);
    }
}

async function checkUpdates() {
    try {
        const updated = await syncFiles({ verbose: false });
        if (!updated.length) return;
        try {
            loadModules();
            if (sock && number) Pair.attach(sock, number);
            log.ok('New version loaded (no restart needed)');
        } catch (e) {
            log.err('New version failed to load: ' + e.message);
            restorePrevious(updated);
            try { loadModules(); if (sock && number) Pair.attach(sock, number); log.warn('Previous version restored'); } catch (e2) {}
        }
    } catch (e) {
        if (e instanceof Fatal) { log.err(e.message); process.exit(1); }
        log.warn('Update check failed: ' + e.message);
    }
}

const digits = (s) => String(s || '').replace(/[^0-9]/g, '');

function ask(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (a) => { rl.close(); resolve(a); });
    });
}

function numberFromCreds() {
    try {
        const c = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'creds.json'), 'utf8'));
        return c.registered && c.me?.id ? digits(String(c.me.id).split(':')[0]) : null;
    } catch (e) { return null; }
}

async function getNumber() {
    const fromCreds = numberFromCreds();
    if (fromCreds && fromCreds.length >= 8) return fromCreds;
    if (process.env.BOT_NUMBER && digits(process.env.BOT_NUMBER).length >= 8) return digits(process.env.BOT_NUMBER);
    try { const n = digits(fs.readFileSync(NUMBER_FILE, 'utf8')); if (n.length >= 8) return n; } catch (e) {}

    log.step('Link your WhatsApp');
    log.info('Type your number with country code, no + or spaces');
    log.info('Example: 509XXXXXXXX');
    console.log('');
    for (;;) {
        const n = digits(await ask(chalk.magenta(' ❯ ') + chalk.white(styled('Number: '))));
        if (n.length >= 8 && n.length <= 15 && !n.startsWith('0')) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
            fs.writeFileSync(NUMBER_FILE, n);
            return n;
        }
        log.err('Invalid number — country code first, no leading 0');
    }
}

function showCode(code) {
    const c = code?.match(/.{1,4}/g)?.join('-') || code; 
    console.log('');
    box(['', chalk.bold.yellow(c), ''], chalk.yellow);
    log.info('WhatsApp  ➜  Linked devices  ➜  Link a device');
    log.info('Choose "Link with phone number instead" and enter the code');
    console.log('');
}

function wipeSession() {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
    number = null;
}

let sock = null;
let store = null;
let number = null;
let busy = false;
let retry = 0;
let pairTries = 0;
let reconnectTimer = null;
let healthTimer = null;
let storeTimer = null;

function teardown() {
    clearInterval(healthTimer);
    clearInterval(storeTimer);
    if (!sock) return;
    try { if (sock._autoOnlineIntervalId) clearInterval(sock._autoOnlineIntervalId); } catch (e) {}
    try { sock.ev.removeAllListeners(); } catch (e) {}
    try { sock.end(); } catch (e) {}
    try { sock.ws?.close(); } catch (e) {}
    sock = null;
}

function scheduleReconnect(ms) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, ms);
}

function wrapSendQueue(s) {
    let queue = Promise.resolve();
    let last = 0;
    const orig = s.sendMessage.bind(s);
    s.sendMessage = (...args) => {
        const run = async () => {
            const wait = Math.max(0, 250 - (Date.now() - last));
            if (wait) await sleep(wait);
            last = Date.now();
            try { return await orig(...args); }
            catch (err) {
                const msg = String(err?.message || err);
                if (msg.includes('rate-overlimit')) {
                    await sleep(3000); last = Date.now();
                    try { return await orig(...args); } catch (e) { return null; }
                }
                if (/Connection Closed|forbidden|Invalid group metadata|All encryptions failed/.test(msg)) return null;
                throw err;
            }
        };
        const res = queue.then(run, run);
        queue = res.catch(() => {});
        return res;
    };
}

async function connect() {
    if (busy) return;
    busy = true;
    try {
        teardown();
        for (const d of ['session', 'database', 'tmp', 'temp', 'sticker', 'src']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        const registered = !!state.creds.registered;

        if (registered) number = digits(state.creds.me?.id?.split(':')[0]) || number || digits(fs.existsSync(NUMBER_FILE) && fs.readFileSync(NUMBER_FILE, 'utf8'));
        else number = await getNumber();

        let version;
        try { version = (await fetchLatestBaileysVersion()).version; } catch (e) {}

        store = makeInMemoryStore ? makeInMemoryStore({ logger: pino({ level: 'silent' }) }) : null;
        if (store) {
            storeTimer = setInterval(() => {
                try {
                    store.messages = {}; store.chats = store.chats?.clear ? (store.chats.clear(), store.chats) : {};
                    store.contacts = {}; store.groupMetadata = {}; store.presences = {};
                } catch (e) {}
            }, 10 * 60 * 1000);
        }

        sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            version,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            getMessage: async (key) => (store ? (await store.loadMessage(key.remoteJid, key.id))?.message || '' : { conversation: '' }),
            shouldSyncHistoryMessage: (m) => !!m.syncType,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: true,
            fireInitQueries: true,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            markOnlineOnConnect: false
        });
        const me = sock;
        if (store) store.bind(me.ev);
        wrapSendQueue(me);
        Pair.attach(me, number);

        me.ev.on('creds.update', saveCreds);

        if (!registered) {
            log.step('Requesting pairing code');
            setTimeout(async () => {
                if (sock !== me) return;
                try { showCode(await me.requestPairingCode(number)); }
                catch (e) { log.err('Could not get a pairing code: ' + (e?.message || e)); }
            }, 3000);
        }

        me.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                for (const msg of chatUpdate.messages) {
                    if (!msg.message || !Object.keys(msg.message).length) continue;
                    if (Object.keys(msg.message)[0] === 'ephemeralMessage') msg.message = msg.message.ephemeralMessage.message;
                    if (!me.public && !msg.key.fromMe && !msg.key.remoteJid.endsWith('@g.us') && chatUpdate.type === 'notify') continue;
                    if (msg.key.id.startsWith('BAE5') && msg.key.id.length === 16) continue;
                    const mek = Pair.smsg(me, msg, store);
                    Promise.resolve(Case(me, mek, chatUpdate, store)).catch(() => {});
                }
            } catch (e) {}
        });

        me.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
            if (sock !== me) return;

            if (connection === 'open') {
                retry = 0; pairTries = 0;
                global.livePrim = { [number]: me };
                console.log('');
                box(['', chalk.bold.green(styled('Connected')), chalk.gray(styled('+' + number)), ''], chalk.green);
                console.log('');
                startHealthCheck(me);
                Promise.resolve(Pair.onOpen(me)).catch(() => {});
                return;
            }

            if (connection !== 'close') return;

            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            teardown();

            if (!registered && !state.creds.registered) {
                if (++pairTries > 5) { log.err('Pairing failed too many times'); wipeSession(); pairTries = 0; }
                else log.warn('Pairing not completed — requesting a new code');
                return scheduleReconnect(3000);
            }
            if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.badSession) {
                log.err(reason === DisconnectReason.loggedOut ? 'Logged out from WhatsApp' : 'Bad session');
                log.info('Session cleared — link again');
                wipeSession();
                return scheduleReconnect(2000);
            }
            if (reason === DisconnectReason.restartRequired) return scheduleReconnect(1000);
            if (reason === DisconnectReason.forbidden) return log.err('Account restricted by WhatsApp (403) — stopped');
            if (reason === DisconnectReason.connectionReplaced || reason === 405) {
                if (++retry > 3) return log.err('Session opened somewhere else — stopped');
                return scheduleReconnect(3000);
            }
            retry++;
            const wait = Math.min(2000 * Math.pow(1.5, retry), 60000);
            log.warn(`Connection lost (${reason || '?'}) — retry in ${Math.round(wait / 1000)}s`);
            scheduleReconnect(wait);
        });
    } catch (e) {
        log.err('Connection error: ' + (e?.message || e));
        scheduleReconnect(10000);
    } finally {
        busy = false;
    }
}

function startHealthCheck(me) {
    clearInterval(healthTimer);
    let fails = 0;
    healthTimer = setInterval(async () => {
        if (sock !== me || me.ws?.readyState !== 1) return;
        try { await me.sendPresenceUpdate('unavailable'); fails = 0; }
        catch (e) { if (++fails >= 3) { fails = 0; log.warn('Health check failed — reconnecting'); teardown(); scheduleReconnect(2000); } }
    }, 60000);
}

const IGNORED = ['Socket connection timeout', 'EKEYTYPE', 'item-not-found', 'rate-overlimit', 'Connection Closed', 'Timed Out',
    'Value not found', 'forbidden', 'Invalid group metadata', 'missing <group> node', 'not-acceptable', 'newsletterfollow',
    'unexpected response structure', 'is not valid JSON', 'All encryptions failed', 'Cannot derive from empty media key', 'terminated'];
const ignored = (e) => IGNORED.some((x) => String(e).includes(x));
process.on('unhandledRejection', (r) => { if (!ignored(r)) log.err('Unhandled: ' + (r?.message || r)); });
process.on('uncaughtException', (e) => { if (!ignored(e)) log.err('Exception: ' + (e?.message || e)); });
process.on('SIGINT', () => { log.warn('Shutting down'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));

(async () => {
    banner();

    if (/TON-PROJET/.test(GATE_URL)) {
        log.err('GATE_URL is not filled in index.js');
        process.exit(1);
    }

    number = await getNumber();

    log.step('Syncing files');
    try { await syncFiles({ verbose: true }); }
    catch (e) { log.err(e.message); process.exit(1); }

    try { loadModules(); }
    catch (e) {
        log.err('Could not load files: ' + e.message);
        restorePrevious(FILES);
        try { loadModules(); log.warn('Previous version restored'); } catch (e2) { process.exit(1); }
    }
    console.log('');

    await connect();
    setInterval(checkUpdates, CHECK_EVERY_MS);
})();
