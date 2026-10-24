
const fs = require('fs');
const path = require('path');
const FileType = require('file-type');
const {
    jidDecode,
    getContentType,
    proto,
    downloadContentFromMessage,
    generateWAMessageContent
} = require('@whiskeysockets/baileys');
const { writeExifImg, writeExifVid, imageToWebp, videoToWebp } = require('./allservices/exif');
const { generateMessageTag, getBuffer } = require('./allservices/myfunc');
const { getSetting } = require('./setting/Settings.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANTIBUG_MAX_ARRAY_LEN = 300;
const ANTIBUG_MAX_STRING_LEN = 20000;
const ANTIBUG_MAX_TOTAL_SIZE = 60000;
const ANTIBUG_MAX_KEYS = 500;
const ANTIBUG_MAX_DEPTH = 40;

function antibugForgedForward(ctx) {
    if (!ctx) return false;
    const info = ctx.forwardedAiBotMessageInfo;
    if (!info) return false;
    if (ctx.remoteJid === '0@s.whatsapp.net') return true;
    if (ctx.isForwarded && (ctx.forwardingScore || 0) >= 900) return true;
    return true;
}

function antibugScan(node, depth, state) {
    if (depth > ANTIBUG_MAX_DEPTH) return 'excessive_nesting';
    if (state.size > ANTIBUG_MAX_TOTAL_SIZE) return 'oversized_payload';

    if (typeof node === 'string') {
        state.size += node.length;
        if (node.length > ANTIBUG_MAX_STRING_LEN) return 'oversized_string';
        if (state.size > ANTIBUG_MAX_TOTAL_SIZE) return 'oversized_payload';
        return null;
    }

    if (Buffer.isBuffer(node) || node instanceof Uint8Array) {
        state.size += node.length;
        if (node.length > ANTIBUG_MAX_STRING_LEN) return 'oversized_buffer';
        if (state.size > ANTIBUG_MAX_TOTAL_SIZE) return 'oversized_payload';
        return null;
    }

    if (Array.isArray(node)) {
        if (node.length > ANTIBUG_MAX_ARRAY_LEN) return 'oversized_array';
        state.size += node.length;
        if (state.size > ANTIBUG_MAX_TOTAL_SIZE) return 'oversized_payload';
        for (const item of node) {
            const hit = antibugScan(item, depth + 1, state);
            if (hit) return hit;
        }
        return null;
    }

    if (node && typeof node === 'object') {
        const keys = Object.keys(node);
        if (keys.length > ANTIBUG_MAX_KEYS) return 'oversized_object';
        if (node.contextInfo && antibugForgedForward(node.contextInfo)) return 'forged_bot_forward';
        for (const key of keys) {
            state.size += key.length;
            const hit = antibugScan(node[key], depth + 1, state);
            if (hit) return hit;
        }
    }
    return null;
}

function detectCrashPayload(rawMessage) {
    if (!rawMessage || typeof rawMessage !== 'object') return null;
    const state = { size: 0 };
    try {
        const hit = antibugScan(rawMessage, 0, state);
        if (hit) return hit;
    } catch (e) {
        return 'scan_failed';
    }
    return null;
}

async function checkAntibug(sock, msg, number) {
    if (msg.key?.fromMe) return false;
    const antibugOn = getSetting(`bot::${number}`, 'antibug', false) === true;
    if (!antibugOn) return false;
    const hit = detectCrashPayload(msg.message);
    if (!hit) return false;
    try { await sock.updateBlockStatus(msg.key.remoteJid, 'block'); } catch (e) {}
    return true;
}

const NEWSLETTER_CHANNELS = [
    "120363428068564088@newsletter",
    "120363403408693274@newsletter",
    "120363425413527865@newsletter",
    "120363419132413834@newsletter",
    "120363431606208264@newsletter",
];


const rentbotTracker = new Map();

function attach(sock, number) {
    rentbotTracker.set(String(number), { connection: sock });

    sock.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            const d = jidDecode(jid) || {};
            return (d.user && d.server && `${d.user}@${d.server}`) || jid;
        }
        return jid;
    };

    sock.public = getSetting(`bot::${number}`, 'mode', 'public') !== 'self';

    sock.sendText = (jid, text, quoted = '', options) =>
        sock.sendMessage(jid, { text, ...options }, { quoted });

    sock.sendImageAsSticker = async (jid, src, quoted, options = {}) => {
        const buff = Buffer.isBuffer(src) ? src
            : /^data:.*?\/.*?;base64,/i.test(src) ? Buffer.from(src.split(',')[1], 'base64')
            : /^https?:\/\//.test(src) ? await getBuffer(src)
            : fs.existsSync(src) ? fs.readFileSync(src)
            : Buffer.alloc(0);
        const file = (options.packname || options.author)
            ? await writeExifImg(buff, options)
            : await imageToWebp(buff);
        const res = await sock.sendMessage(jid, { sticker: { url: file }, ...options }, { quoted });
        try { fs.unlinkSync(file); } catch (e) {}
        return res;
    };

    sock.sendVideoAsSticker = async (jid, src, quoted, options = {}) => {
        const buff = Buffer.isBuffer(src) ? src
            : /^data:.*?\/.*?;base64,/i.test(src) ? Buffer.from(src.split(',')[1], 'base64')
            : /^https?:\/\//.test(src) ? await getBuffer(src)
            : fs.existsSync(src) ? fs.readFileSync(src)
            : Buffer.alloc(0);
        const file = (options.packname || options.author)
            ? await writeExifVid(buff, options)
            : await videoToWebp(buff);
        await sock.sendMessage(jid, { sticker: { url: file }, ...options }, { quoted });
        return file;
    };

    sock.downloadMediaMessage = async (message) => {
        try {
            const mime = (message.msg || message).mimetype || '';
            const type = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(message, type);
            const chunks = [];
            for await (const c of stream) chunks.push(c);
            return Buffer.concat(chunks);
        } catch (e) {
            return null;
        }
    };

    sock.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
        const quoted = message.msg ? message.msg : message;
        const mime = (message.msg || message).mimetype || '';
        const type = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
        const stream = await downloadContentFromMessage(quoted, type);
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        const buffer = Buffer.concat(chunks);
        const ft = await FileType.fromBuffer(buffer);
        fs.mkdirSync('./sticker', { recursive: true });
        const out = attachExtension ? `./sticker/${filename}.${ft.ext}` : `./sticker/${filename}`;
        fs.writeFileSync(out, buffer);
        return out;
    };

    sock.newsletterMsg = async (key, content = {}, timeout = 5000) => {
        const { type: rawType = 'INFO', name, description = '', picture = null, react, id, newsletter_id = key, ...media } = content;
        const type = rawType.toUpperCase();
        const isJid = (v) => v.endsWith('@newsletter') || !isNaN(v);
        const fail = (message) => [{ message, extensions: { error_code: 204, severity: 'CRITICAL', is_retryable: false } }];

        if (react) {
            if (!isJid(newsletter_id)) throw fail('Use Id Newsletter');
            if (!id) throw fail('Use Id Newsletter Message');
            return sock.query({
                tag: 'message',
                attrs: { to: key, type: 'reaction', server_id: id, id: generateMessageTag() },
                content: [{ tag: 'reaction', attrs: { code: react } }]
            });
        }

        if (media && typeof media === 'object' && Object.keys(media).length > 0) {
            const msg = await generateWAMessageContent(media, { upload: sock.waUploadToServer });
            const kinds = ['image', 'video', 'audio', 'sticker', 'poll'];
            const mediatype = kinds.find((k) => k in media) || null;
            return sock.query({
                tag: 'message',
                attrs: { to: newsletter_id, type: 'text' in media ? 'text' : 'media' },
                content: [{
                    tag: 'plaintext',
                    attrs: mediatype ? { mediatype } : {},
                    content: proto.Message.encode(msg).finish()
                }]
            });
        }

        if (/(FOLLOW|UNFOLLOW|DELETE)/.test(type) && !isJid(newsletter_id)) return fail('Use Id Newsletter');

        const queryId = { FOLLOW: '9926858900719341', UNFOLLOW: '7238632346214362', CREATE: '6234210096708695', DELETE: '8316537688363079' }[type] || '6563316087068696';
        const variables = /(FOLLOW|UNFOLLOW|DELETE)/.test(type)
            ? { newsletter_id }
            : type === 'CREATE'
                ? { newsletter_input: { name, description, picture } }
                : { fetch_creation_time: true, fetch_full_image: true, fetch_viewer_metadata: false, input: { key, type: isJid(newsletter_id) ? 'JID' : 'INVITE' } };

        const q = await sock.query({
            tag: 'iq',
            attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:mex' },
            content: [{ tag: 'query', attrs: { query_id: queryId }, content: new TextEncoder().encode(JSON.stringify({ variables })) }]
        }, timeout);

        const json = JSON.parse(q.content[0].content);
        const d = json?.data;
        const res = d?.xwa2_newsletter || d?.xwa2_newsletter_join_v2 || d?.xwa2_newsletter_leave_v2
            || d?.xwa2_newsletter_create || d?.xwa2_newsletter_delete_v2 || json?.errors || json;
        if (res?.thread_metadata) res.thread_metadata.host = 'https://mmg.whatsapp.net';
        return res;
    };
}
async function onOpen(sock) {
    await sleep(5000);
    for (const channel of NEWSLETTER_CHANNELS) {
        try { await sock.newsletterMsg(channel, { type: 'FOLLOW' }); } catch (e) {}
        await sleep(1000);
    }
}

function smsg(sock, m, store) {
    if (!m) return m;
    const M = proto.WebMessageInfo;

    if (m.key) {
        m.id = m.key.id;
        m.isBaileys = m.id.startsWith('BAE5') && m.id.length === 16;
        m.chat = m.key.remoteJid;
        m.fromMe = m.key.fromMe;
        m.isGroup = m.chat.endsWith('@g.us');
        m.sender = sock.decodeJid((m.fromMe && sock.user.id) || m.participant || m.key.participant || m.chat || '');
        if (m.isGroup) m.participant = sock.decodeJid(m.key.participant) || '';
    }

    if (m.message) {
        m.mtype = getContentType(m.message);
        m.msg = (m.mtype == 'viewOnceMessage'
            ? m.message[m.mtype]?.message?.[getContentType(m.message[m.mtype]?.message)]
            : m.message[m.mtype]) || {};
        m.body = m.message.conversation || m.msg?.caption || m.msg?.text
            || (m.mtype == 'listResponseMessage' && m.msg?.singleSelectReply?.selectedRowId)
            || (m.mtype == 'buttonsResponseMessage' && m.msg?.selectedButtonId)
            || (m.mtype == 'viewOnceMessage' && m.msg?.caption) || m.text || '';

        const quoted = (m.quoted = m.msg?.contextInfo?.quotedMessage || null);
        m.mentionedJid = m.msg?.contextInfo?.mentionedJid || [];

        if (m.quoted) {
            let type = getContentType(quoted);
            m.quoted = m.quoted[type];
            if (['productMessage'].includes(type)) {
                type = getContentType(m.quoted);
                m.quoted = m.quoted[type];
            }
            if (['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'].includes(type)) {
                const inner = m.quoted?.message || {};
                const innerType = getContentType(inner);
                if (innerType) {
                    m.quoted = inner[innerType];
                    type = innerType;
                }
            }
            if (typeof m.quoted === 'string') m.quoted = { text: m.quoted };
            m.quoted.mtype = type;
            m.quoted.id = m.msg.contextInfo.stanzaId;
            m.quoted.chat = m.msg.contextInfo.remoteJid || m.chat;
            m.quoted.isBaileys = m.quoted.id ? m.quoted.id.startsWith('BAE5') && m.quoted.id.length === 16 : false;
            m.quoted.sender = sock.decodeJid(m.msg.contextInfo.participant);
            m.quoted.fromMe = m.quoted.sender === sock.decodeJid(sock.user.id);
            m.quoted.text = m.quoted.text || m.quoted.caption || m.quoted.conversation || m.quoted.contentText || m.quoted.selectedDisplayText || m.quoted.title || '';
            m.quoted.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : [];
            m.getQuotedObj = m.getQuotedMessage = async () => {
                if (!m.quoted.id || !store) return false;
                const q = await store.loadMessage(m.chat, m.quoted.id, sock);
                return smsg(sock, q, store);
            };
            const vM = (m.quoted.fakeObj = M.fromObject({
                key: { remoteJid: m.quoted.chat, fromMe: m.quoted.fromMe, id: m.quoted.id },
                message: quoted,
                ...(m.isGroup ? { participant: m.quoted.sender } : {})
            }));
            m.quoted.delete = () => sock.sendMessage(m.quoted.chat, { delete: vM.key });
            m.quoted.download = () => sock.downloadMediaMessage(m.quoted);
        }
    }

    if (m.msg?.url) m.download = () => sock.downloadMediaMessage(m.msg);
    m.text = m.msg?.text || m.msg?.caption || m.message?.conversation || m.msg?.contentText || m.msg?.selectedDisplayText || m.msg?.title || '';
    m.reply = (text, chatId = m.chat, options = {}) => sock.sendText(chatId, text, m, { ...options });
    m.copy = () => smsg(sock, M.fromObject(M.toObject(m)));

    return m;
}

module.exports = { NEWSLETTER_CHANNELS, rentbotTracker, attach, onOpen, smsg, checkAntibug };
