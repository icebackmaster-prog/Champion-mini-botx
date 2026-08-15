// BASE BY ICEBACK TECH 


// GIVE CREDIT !!
require('dotenv').config();
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./msg");
const FileType = require('file-type');
const os = require('os');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

const config = require('./config');

// MongoDB Connection
const connectMongoDB = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        
        console.log('✅ Connected to MongoDB successfully');
        
        // Create indexes for better performance
        await mongoose.connection.db.collection('sessions').createIndex({ number: 1 }, { unique: true });
        await mongoose.connection.db.collection('sessions').createIndex({ updatedAt: 1 });
        
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
        process.exit(1);
    }
};

// Call MongoDB connection on startup
connectMongoDB();

// Session Schema
const sessionSchema = new mongoose.Schema({
    number: { 
        type: String, 
        required: true, 
        unique: true,
        trim: true,
        match: /^\d+$/
    },
    creds: { 
        type: mongoose.Schema.Types.Mixed, 
        required: true 
    },
    config: { 
        type: mongoose.Schema.Types.Mixed, 
        default: {} 
    },
    lastActive: { 
        type: Date, 
        default: Date.now 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Update timestamp before saving
sessionSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const Session = mongoose.model('Session', sessionSchema);

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = config.SESSION_BASE_PATH;
const NUMBER_LIST_PATH = config.NUMBER_LIST_PATH;
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

// ================== PER-NUMBER USER SETTINGS (autolike / autoview / autoreact) ==================
const SETTINGS_PATH = path.join(config.SESSION_BASE_PATH, 'settings.json');
let _settingsCache = null;

function _loadAllSettings() {
    if (_settingsCache) return _settingsCache;
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            _settingsCache = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        } else {
            _settingsCache = {};
        }
    } catch (error) {
        console.error('Failed to load settings.json:', error);
        _settingsCache = {};
    }
    return _settingsCache;
}

function _saveAllSettings() {
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(_settingsCache || {}, null, 2));
    } catch (error) {
        console.error('Failed to save settings.json:', error);
    }
}

function getUserSettings(number) {
    const all = _loadAllSettings();
    const n = (number || '').replace(/[^0-9]/g, '');
    if (!all[n]) {
        all[n] = {
            autolike: config.AUTO_LIKE_STATUS === 'true',
            autoview: config.AUTO_VIEW_STATUS === 'true',
            autoreact: false
        };
    }
    return all[n];
}

function setUserSetting(number, key, value) {
    const all = _loadAllSettings();
    const n = (number || '').replace(/[^0-9]/g, '');
    if (!all[n]) all[n] = getUserSettings(n);
    all[n][key] = value;
    _saveAllSettings();
    return all[n];
}

// ================== GROUP HELPERS ==================
async function getGroupAdmins(socket, jid) {
    try {
        const metadata = await socket.groupMetadata(jid);
        const admins = metadata.participants
            .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
            .map(p => p.id);
        return { metadata, admins };
    } catch (error) {
        return { metadata: null, admins: [] };
    }
}

function resolveTargetJid(msg, args) {
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    if (mentioned && mentioned.length > 0) return mentioned[0];
    const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (quotedParticipant) return quotedParticipant;
    if (args && args[0]) {
        const num = args[0].replace(/[^0-9]/g, '');
        if (num) return num + '@s.whatsapp.net';
    }
    return null;
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    // No need for this with MongoDB - automatic deduplication
    console.log(`Session management for ${number} handled by MongoDB`);
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9-_]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message && error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message && error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message && error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        'CHAMPION V1 MINI',
        `📞 Number: ${number}\n🩵 Status: Connected\n📢 Group: ${groupStatus}`,
        'CHAMPION V1 MINI'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in ${Math.floor(config.OTP_EXPIRY / 60000)} minutes.`,
        'CHAMPION V1 MINI'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🔥', '😀', '👍', '🐭'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message || err);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message || error);
        }
    });
}

async function setupStatusHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            const settings = getUserSettings(number);

            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (settings.autoview) {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (settings.autolike) {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            'CHAMPION V1 MINI'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function oneViewmeg(socket, isOwner, msg, sender) {
    if (isOwner) {  
        try {
            const akuru = sender;
            const quot = msg;
            if (quot) {
                if (quot.imageMessage?.viewOnce) {
                    let cap = quot.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.videoMessage?.viewOnce) {
                    let cap = quot.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.audioMessage?.viewOnce) {
                    let cap = quot.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.imageMessage){
                    let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.videoMessage){
                    let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
                    let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                }
            }        
        } catch (error) {
            console.error('oneViewmeg error:', error);
        }
    }
}

function setupCommandHandlers(socket, number) {
    // Contact message for verified context (used as quoted message)
    const verifiedContact = {
        key: {
            fromMe: false,
            participant: `0@s.whatsapp.net`,
            remoteJid: "status@broadcast"
        },
        message: {
            contactMessage: {
                displayName: "Champion Xmd✅",
                vcard: "BEGIN:VCARD\nVERSION:3.0\nFN: Keith ✅\nORG:Moon Xmd;\nTEL;type=CELL;type=VOICE;waid=urnumber:+urnumber\nEND:VCARD"
            }
        }
    };

    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
            ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
            : [];
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
            ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
            ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
            ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
            ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
            ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
            ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
            ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                || msg.text) 
            : (type === 'viewOnceMessage') 
            ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
            ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        var prefix = config.PREFIX;
        var isCmd = (body || '').startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = (body || '').trim().split(/ +/).slice(1);

        socket.downloadAndSaveMediaMessage = async(message, filename = (Date.now()).toString(), attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            const trueFileName = attachExtension ? (filename + '.' + (type ? type.ext : 'bin')) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        }

        if (!command) return;

        try {
            switch (command) {
              case 'button': {
                const buttons = [
                    {
                        buttonId: 'button1',
                        buttonText: { displayText: 'Button 1' },
                        type: 1
                    },
                    {
                        buttonId: 'button2',
                        buttonText: { displayText: 'Button 2' },
                        type: 1
                    }
                ];

                const captionText = 'CHAMPION V1 MINI';
                const footerText = 'CHAMPION V1 MINI';

                const buttonMessage = {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: captionText,
                    footer: footerText,
                    buttons,
                    headerType: 1
                };

                await socket.sendMessage(from, buttonMessage, { quoted: msg });
                break;
              }

              case 'alive': {
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                const captionText = `
╭────◉◉◉────៚
⏰ Bot Uptime: ${hours}h ${minutes}m ${seconds}s
🟢 Active Bots: ${activeSockets.size}
╰────◉◉◉────៚

🔢 Your Number: ${number}
`;

                await socket.sendMessage(m.chat, {
                    buttons: [
                        {
                            buttonId: 'action',
                            buttonText: {
                                displayText: '📂 Menu Options'
                            },
                            type: 4,
                            nativeFlowInfo: {
                                name: 'single_select',
                                paramsJson: JSON.stringify({
                                    title: 'Click Here',
                                    sections: [
                                        {
                                            title: `CHAMPION V1 MINI`,
                                            highlight_label: '',
                                            rows: [
                                                {
                                                    title: 'menu',
                                                    description: 'CHAMPION V1 MINI',
                                                    id: `${config.PREFIX}menu`,
                                                },
                                                {
                                                    title: 'Alive',
                                                    description: 'CHAMPION V1 MINI',
                                                    id: `${config.PREFIX}alive`,
                                                },
                                            ],
                                        },
                                    ],
                                }),
                            },
                        },
                    ],
                    headerType: 1,
                    viewOnce: true,
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: `CHAMPION V1 MINI\n\n${captionText}`,
                }, { quoted: msg });
                break;
              }

              case 'menu': {
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                let menuText = `
┍━❑ CHAMPION V1 MINI ❑━━∙∙⊶
┃➸╭──────────
┃❑│▸ *ʙᴏᴛɴᴀᴍᴇ:* *CHAMPION V1 MINI*
┃❑│▸ ꜱᴛᴀᴛᴜꜱ: *ᴏɴʟɪɴᴇ ⚡*
┃❑│▸ ʀᴜɴᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s
┃❑│▸ *ᴘʀᴇꜰɪx :* ${config.PREFIX}
┃❑│▸ *ᴀᴄᴛɪᴠᴇ ᴜꜱᴇʀꜱ:* ${activeSockets.size}
┃➸╰──────────
┕━━━━━━━━━━━━━∙∙⊶

┎ ❑ *⚙️ MAIN* ❑
│▸ ${config.PREFIX}alive
│▸ ${config.PREFIX}menu
│▸ ${config.PREFIX}ping
│▸ ${config.PREFIX}runtime
│▸ ${config.PREFIX}owner
│▸ ${config.PREFIX}jid
│▸ ${config.PREFIX}deleteme
┖❑

┎ ❑ *👑 GROUP MANAGEMENT* ❑
│▸ ${config.PREFIX}kick
│▸ ${config.PREFIX}add
│▸ ${config.PREFIX}promote
│▸ ${config.PREFIX}demote
│▸ ${config.PREFIX}tagall
│▸ ${config.PREFIX}hidetag
│▸ ${config.PREFIX}open
│▸ ${config.PREFIX}close
│▸ ${config.PREFIX}glink
│▸ ${config.PREFIX}revoke
│▸ ${config.PREFIX}groupinfo
│▸ ${config.PREFIX}setgname
│▸ ${config.PREFIX}setgdesc
│▸ ${config.PREFIX}setppgc
│▸ ${config.PREFIX}welcome on/off
│▸ ${config.PREFIX}antilink on/off
│▸ ${config.PREFIX}leave
┖❑

┎ ❑ *❤️ STATUS & REACTIONS* ❑
│▸ ${config.PREFIX}like
│▸ ${config.PREFIX}react
│▸ ${config.PREFIX}view (view once)
│▸ ${config.PREFIX}autolike on/off
│▸ ${config.PREFIX}autoview on/off
│▸ ${config.PREFIX}autoreact on/off
┖❑

┎ ❑ *🎬 MEDIA & DOWNLOAD* ❑
│▸ ${config.PREFIX}play / song
│▸ ${config.PREFIX}video
│▸ ${config.PREFIX}tiktok
│▸ ${config.PREFIX}yts / ytsearch
│▸ ${config.PREFIX}fb
│▸ ${config.PREFIX}ig
│▸ ${config.PREFIX}spotify
│▸ ${config.PREFIX}apk
│▸ ${config.PREFIX}gitclone
│▸ ${config.PREFIX}sticker / s
│▸ ${config.PREFIX}toimg
│▸ ${config.PREFIX}tomp3
│▸ ${config.PREFIX}logo
│▸ ${config.PREFIX}fancy
│▸ ${config.PREFIX}img / image
┖❑

┎ ❑ *🤖 AI & SEARCH* ❑
│▸ ${config.PREFIX}ai
│▸ ${config.PREFIX}gpt
│▸ ${config.PREFIX}darkgpt
│▸ ${config.PREFIX}aiimg
│▸ ${config.PREFIX}wiki
│▸ ${config.PREFIX}define
│▸ ${config.PREFIX}translate
│▸ ${config.PREFIX}tts
┖❑

┎ ❑ *🎉 FUN* ❑
│▸ ${config.PREFIX}joke
│▸ ${config.PREFIX}meme
│▸ ${config.PREFIX}quote
│▸ ${config.PREFIX}fact
│▸ ${config.PREFIX}8ball
│▸ ${config.PREFIX}dice
│▸ ${config.PREFIX}coinflip
│▸ ${config.PREFIX}dog / cat
│▸ ${config.PREFIX}bible
┖❑

┎ ❑ *🛠️ TOOLS* ❑
│▸ ${config.PREFIX}calc
│▸ ${config.PREFIX}weather
│▸ ${config.PREFIX}qrcode
│▸ ${config.PREFIX}shortlink
│▸ ${config.PREFIX}winfo
│▸ ${config.PREFIX}iplookup
│▸ ${config.PREFIX}screenshot
│▸ ${config.PREFIX}tempmail
┖❑

_Type any command with_ ${config.PREFIX} _to use it. 100+ commands loaded ⚡_`;

                await socket.sendMessage(from, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: formatMessage(
                        '*CHAMPION V1 MINI*',
                        menuText,
                        'CHAMPION V1 MINI'
                    ),
                    contextInfo: {
                        mentionedJid: [msg.key.participant || sender],
                        forwardingScore: 999,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: (config.NEWSLETTER_JID || '').trim(),
                            newsletterName: 'CHAMPION V1 MINI',
                            serverMessageId: 143
                        }
                    }
                }, { quoted: verifiedContact });

                break;
              }

              case 'fc': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 1203633963799×××@newsletter'
                    });
                }

                const jid = args[0];
                if (!jid.endsWith("@newsletter")) {
                    return await socket.sendMessage(sender, {
                        text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                    });
                }

                try {
                    const metadata = await socket.newsletterMetadata("jid", jid);
                    if (metadata?.viewer_metadata === null) {
                        await socket.newsletterFollow(jid);
                        await socket.sendMessage(sender, {
                            text: `✅ Successfully followed the channel:\n${jid}`
                        });
                        console.log(`FOLLOWED CHANNEL: ${jid}`);
                    } else {
                        await socket.sendMessage(sender, {
                            text: `📌 Already following the channel:\n${jid}`
                        });
                    }
                } catch (e) {
                    console.error('❌ Error in follow channel:', e.message || e);
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${e.message || e}`
                    });
                }
                break;
              }

              case 'pair': {
                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption || '';

                const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

                if (!number) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .pair 263xxx\n\nThis will generate a pairing code for the specified number.'
                    }, { quoted: msg });
                }

                // Validate number format
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                if (sanitizedNumber.length < 10 || sanitizedNumber.length > 15) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Invalid number format. Please provide a valid phone number (10-15 digits).'
                    }, { quoted: msg });
                }

                // Check if already connected
                if (activeSockets.has(sanitizedNumber)) {
                    return await socket.sendMessage(sender, {
                        text: '✅ This number is already connected!\n\nUse .menu to see available commands.'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, {
                    text: `⏳ *Champion mini bot is Generating pairing code for ${sanitizedNumber}...*\n_Please wait..._`
                }, { quoted: msg });

                try {
                    // Call EmpirePair directly to create a new session
                    const mockRes = {
                        headersSent: false,
                        sentData: null,
                        status: function(code) { 
                            this.statusCode = code; 
                            return this; 
                        },
                        send: function(data) { 
                            this.sentData = data;
                            return this;
                        }
                    };

                    // Call EmpirePair directly
                    await EmpirePair(sanitizedNumber, mockRes);

                    await sleep(3000);

                    // Check if socket was created
                    const newSocket = activeSockets.get(sanitizedNumber);
                    if (newSocket && newSocket.authState && !newSocket.authState.creds.registered) {
                        // Request pairing code
                        let retries = 3;
                        let code = null;
                        
                        while (retries > 0 && !code) {
                            try {
                                await delay(1500);
                                code = await newSocket.requestPairingCode(sanitizedNumber);
                            } catch (e) {
                                retries--;
                                console.warn(`Pairing attempt ${4 - retries} failed:`, e.message);
                                await delay(2000);
                            }
                        }

                        if (code) {
                            await socket.sendMessage(sender, {
                                text: `> *CHAMPION V1 MINI* ✅\n\n*🔑 Your pairing code is:* \`\`\`${code}\`\`\`\n\n📱 Open WhatsApp on your phone\n⚙️ Go to Settings > Linked Devices\n🔗 Tap "Link with phone number"\n📝 Enter the code above`
                            }, { quoted: msg });

                            await sleep(2000);

                            await socket.sendMessage(sender, {
                                text: `${code}`
                            }, { quoted: msg });
                        } else {
                            await socket.sendMessage(sender, {
                                text: '❌ Failed to generate pairing code after multiple attempts.\n\nPlease try:\n1. Use a different number\n2. Wait a few minutes and retry\n3. Contact support if issue persists'
                            }, { quoted: msg });
                        }
                    } else if (newSocket) {
                        await socket.sendMessage(sender, {
                            text: '✅ Connection initiated! Check your WhatsApp for the pairing prompt, or use the code sent to your number.'
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to create session. Please check the number and try again.\n\nMake sure the number is in international format without + or spaces (e.g., 263777123456)'
                        }, { quoted: msg });
                    }

                } catch (err) {
                    console.error("❌ Pair Command Error:", err);
                    await socket.sendMessage(sender, {
                        text: `❌ An error occurred: ${err.message}\n\nPlease try again later or contact support.`
                    }, { quoted: msg });
                }

                break;
              }

              case 'viewonce':
              case 'rvo':
              case 'view':
              case 'vv': {
                await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });
                try{
                    if (!msg.quoted) return socket.sendMessage(sender, { text: "🚩 *Please reply to a viewonce message*" });
                    let quotedmsg = msg?.msg?.contextInfo?.quotedMessage;
                    await oneViewmeg(socket, isOwner, quotedmsg, sender);
                }catch(e){
                    console.log(e);
                    await socket.sendMessage(sender, { text: `${e}` });
                }
                break;
              }

              case 'logo': { 
                const q = args.join(" ");

                if (!q || q.trim() === '') {
                    return await socket.sendMessage(sender, { text: '*`Need a name for logo`*' });
                }

                await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
                const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');

                const rows = list.data.map((v) => ({
                    title: v.name,
                    description: 'Tap to generate logo',
                    id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
                }));

                const buttonMessage = {
                    buttons: [
                        {
                            buttonId: 'action',
                            buttonText: { displayText: '🎨 Select Text Effect' },
                            type: 4,
                            nativeFlowInfo: {
                                name: 'single_select',
                                paramsJson: JSON.stringify({
                                    title: 'Available Text Effects',
                                    sections: [
                                        {
                                            title: 'Choose your logo style',
                                            rows
                                        }
                                    ]
                                })
                            }
                        }
                    ],
                    headerType: 1,
                    viewOnce: true,
                    caption: '*LOGO MAKER*',
                    image: { url: config.RCD_IMAGE_PATH },
                };

                await socket.sendMessage(from, buttonMessage, { quoted: msg });
                break;
              }

              case 'dllogo': {
                const q = args.join(" ");
                if (!q) return socket.sendMessage(from, { text: "Please give me url for capture the screenshot !!" });

                try {
                    const res = await axios.get(q);
                    const images = res.data.result?.download_url || res.data.result;
                    await socket.sendMessage(m.chat, {
                        image: { url: images },
                        caption: config.CAPTION
                    }, { quoted: msg });
                } catch (e) {
                    console.log('Logo Download Error:', e);
                    await socket.sendMessage(from, {
                        text: `❌ Error:\n${e.message || e}`
                    }, { quoted: msg });
                }
                break;
              }

              case 'aiimg': {
                const q =
                  msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

                const prompt = q.trim();

                if (!prompt) {
                  return await socket.sendMessage(sender, {
                    text: '🎨 *Please provide a prompt to generate an AI image.*'
                  });
                }

                try {
                  await socket.sendMessage(sender, { text: '🧠 *Creating your AI image...*' });

                  const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
                  const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

                  if (!response || !response.data) {
                    return await socket.sendMessage(sender, {
                      text: '❌ *API did not return a valid image. Please try again later.*'
                    });
                  }

                  const imageBuffer = Buffer.from(response.data, 'binary');

                  await socket.sendMessage(sender, {
                    image: imageBuffer,
                    caption: `🧠 *LITEWAVE V1 MINI   AI IMAGE*\n\n📌 Prompt: ${prompt}`
                  }, { quoted: msg });

                } catch (err) {
                  console.error('AI Image Error:', err);
                  await socket.sendMessage(sender, {
                    text: `❗ *An error occurred:* ${err.response?.data?.message || err.message || 'Unknown error'}`
                  });
                }

                break;
              }

              case 'fancy': {
                const q =
                  msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

                const text = q.trim().replace(/^.fancy\s+/i, "");

                if (!text) {
                  return await socket.sendMessage(sender, {
                    text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy Moon`"
                  });
                }

                try {
                  const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
                  const response = await axios.get(apiUrl);

                  if (!response.data.status || !response.data.result) {
                    return await socket.sendMessage(sender, {
                      text: "❌ *Error fetching fonts from API. Please try again later.*"
                    });
                  }

                  const fontList = response.data.result
                    .map(font => `*${font.name}:*\n${font.result}`)
                    .join("\n\n");

                  const finalMessage = `🎨 *Fancy Fonts Converter*\n\n${fontList}\n\n_𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 LITEWAVE V1 MINI_`;

                  await socket.sendMessage(sender, { text: finalMessage }, { quoted: msg });

                } catch (err) {
                  console.error("Fancy Font Error:", err);
                  await socket.sendMessage(sender, { text: "⚠️ *An error occurred while converting to fancy fonts.*" });
                }
                break;
              }

              case 'ts': {
                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption || '';

                const query = q.replace(/^[.\/!]ts\s*/i, '').trim();

                if (!query) {
                    return await socket.sendMessage(sender, {
                        text: '[❗] TikTok search failed'
                    }, { quoted: msg });
                }

                async function tiktokSearch(query) {
                    try {
                        const searchParams = new URLSearchParams({
                            keywords: query,
                            count: '10',
                            cursor: '0',
                            HD: '1'
                        });

                        const response = await axios.post("https://tikwm.com/api/feed/search", searchParams, {
                            headers: {
                                'Content-Type': "application/x-www-form-urlencoded; charset=UTF-8",
                                'Cookie': "current_language=en",
                                'User-Agent': "Mozilla/5.0"
                            }
                        });

                        const videos = response.data?.data?.videos;
                        if (!videos || videos.length === 0) {
                            return { status: false, result: "No videos found." };
                        }

                        return {
                            status: true,
                            result: videos.map(video => ({
                                description: video.title || "No description",
                                videoUrl: video.play || ""
                            }))
                        };
                    } catch (err) {
                        return { status: false, result: err.message };
                    }
                }

                function shuffleArray(array) {
                    for (let i = array.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [array[i], array[j]] = [array[j], array[i]];
                    }
                }

                try {
                    const searchResults = await tiktokSearch(query);
                    if (!searchResults.status) throw new Error(searchResults.result);

                    const results = searchResults.result;
                    shuffleArray(results);

                    const selected = results.slice(0, 6);

                    const cards = await Promise.all(selected.map(async (vid) => {
                        const videoBuffer = await axios.get(vid.videoUrl, { responseType: "arraybuffer" });
                        const media = await prepareWAMessageMedia({ video: videoBuffer.data }, {
                            upload: socket.waUploadToServer
                        });

                        return {
                            body: proto.Message.InteractiveMessage.Body.fromObject({ text: '' }),
                            footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: "LITEWAVE V1 MINI" }),
                            header: proto.Message.InteractiveMessage.Header.fromObject({
                                title: vid.description,
                                hasMediaAttachment: true,
                                videoMessage: media.videoMessage
                            }),
                            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                                buttons: []
                            })
                        };
                    }));

                    const msgContent = generateWAMessageFromContent(sender, {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadata: {},
                                    deviceListMetadataVersion: 2
                                },
                                interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                                    body: { text: `🔎 *TikTok Search:* ${query}` },
                                    footer: { text: "> 𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 *CHAMPION*  𝗫 𝗠 𝗗" },
                                    header: { hasMediaAttachment: false },
                                    carouselMessage: { cards }
                                })
                            }
                        }
                    }, { quoted: msg });

                    await socket.relayMessage(sender, msgContent.message, { messageId: msgContent.key.id });

                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${err.message}`
                    }, { quoted: msg });
                }

                break;
              }

              case 'bomb': {
                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text || '';
                const parsed = q.split(',').map(x => x?.trim());
                const target = parsed[0];
                const text = parsed[1];
                const countRaw = parsed[2];

                const count = parseInt(countRaw) || 5;

                if (!target || !text || !count) {
                    return await socket.sendMessage(sender, {
                        text: '📌 *Usage:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 263xx,Hi 👋,5'
                    }, { quoted: msg });
                }

                const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

                if (count > 20) {
                    return await socket.sendMessage(sender, {
                        text: '❌ *Limit is 20 messages per bomb.*'
                    }, { quoted: msg });
                }

                for (let i = 0; i < count; i++) {
                    await socket.sendMessage(jid, { text });
                    await delay(700);
                }

                await socket.sendMessage(sender, {
                    text: `✅ Bomb sent to ${target} — ${count}x`
                }, { quoted: msg });

                break;
              }

              case 'tiktok': {
                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption || '';

                const link = q.replace(/^[.\/!]tiktok(dl)?|tt(dl)?\s*/i, '').trim();

                if (!link) {
                    return await socket.sendMessage(sender, {
                        text: '📌 *Usage:* .tiktok <link>'
                    }, { quoted: msg });
                }

                if (!link.includes('tiktok.com')) {
                    return await socket.sendMessage(sender, {
                        text: '❌ *Invalid TikTok link.*'
                    }, { quoted: msg });
                }

                try {
                    await socket.sendMessage(sender, {
                        text: '⏳ Downloading video, please wait...'
                    }, { quoted: msg });

                    const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(link)}`;
                    const { data } = await axios.get(apiUrl);

                    if (!data?.status || !data?.data) {
                        return await socket.sendMessage(sender, {
                            text: '❌ Failed to fetch TikTok video.'
                        }, { quoted: msg });
                    }

                    const { title, like, comment, share, author, meta } = data.data;
                    const video = meta.media.find(v => v.type === "video");

                    if (!video || !video.org) {
                        return await socket.sendMessage(sender, {
                            text: '❌ No downloadable video found.'
                        }, { quoted: msg });
                    }

                    const caption = `🎵 *TikTok Video*\n\n` +
                                    `👤 *User:* ${author.nickname} (@${author.username})\n` +
                                    `📖 *Title:* ${title}\n` +
                                    `👍 *Likes:* ${like}\n💬 *Comments:* ${comment}\n🔁 *Shares:* ${share}`;

                    await socket.sendMessage(sender, {
                        video: { url: video.org },
                        caption: caption,
                        contextInfo: { mentionedJid: [msg.key.participant || sender] }
                    }, { quoted: msg });

                } catch (err) {
                    console.error("TikTok command error:", err);
                    await socket.sendMessage(sender, {
                        text: `❌ An error occurred:\n${err.message}`
                    }, { quoted: msg });
                }

                break;
              }

              case 'fb': {
                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption || 
                          '';

                const fbUrl = q?.trim();

                if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
                    return await socket.sendMessage(sender, { text: '🧩 *Please provide a valid Facebook video link.*' });
                }

                try {
                    const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
                    const result = res.data.result;

                    await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                    await socket.sendMessage(sender, {
                        video: { url: result.sd },
                        mimetype: 'video/mp4',
                        caption: '> 𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 *CHAMPION*  𝗫 𝗠 𝗗'
                    }, { quoted: msg });

                    await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });

                } catch (e) {
                    console.log(e);
                    await socket.sendMessage(sender, { text: '*❌ Error downloading video.*' });
                }

                break;
              }

              case 'gossip': {
                try {
                    const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
                    if (!response.ok) {
                        throw new Error('API returned error');
                    }
                    const data = await response.json();

                    if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
                        throw new Error('Invalid news data received');
                    }

                    const { title, desc, date, link } = data.result;

                    let thumbnailUrl = 'https://via.placeholder.com/150';
                    try {
                        const pageResponse = await fetch(link);
                        if (pageResponse.ok) {
                            const pageHtml = await pageResponse.text();
                            const $ = cheerio.load(pageHtml);
                            const ogImage = $('meta[property="og:image"]').attr('content');
                            if (ogImage) {
                                thumbnailUrl = ogImage; 
                            } else {
                                console.warn(`No og:image found for ${link}`);
                            }
                        } else {
                            console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                        }
                    } catch (err) {
                        console.warn(`Thumbnail scrape failed for ${link}: ${err.message}`);
                    }

                    await socket.sendMessage(sender, {
                        image: { url: thumbnailUrl },
                        caption: formatMessage(
                            '📰 * CHAMPION V1 MINI   GOSSIP  📰',
                            `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'Unknown'}\n🌐 *Link*: ${link}`,
                            'CHAMPION V1 MINI  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                        )
                    });
                } catch (error) {
                    console.error(`Error in 'gossip' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ Failed to fetch gossip news.'
                    });
                }
                break;
              }

              case 'nasa': {
                try {
                    const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
                    if (!response.ok) {
                        throw new Error('Failed to fetch APOD from NASA API');
                    }
                    const data = await response.json();

                    if (!data.title || !data.explanation || !data.date || !data.url) {
                        throw new Error('Invalid APOD data received');
                    }

                    const { title, explanation, date, url, copyright } = data;
                    const thumbnailUrl = url || 'https://via.placeholder.com/150';

                    await socket.sendMessage(sender, {
                        image: { url: thumbnailUrl },
                        caption: formatMessage(
                            '🌌 CHAMPION V1 MINI  𝐍𝐀𝐒𝐀 𝐍𝐄𝐖𝐒',
                            `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *Date*: ${date}\n${copyright ? `📝 *Credit*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                            '> CHAMPION V1 MINI  𝐌𝙸𝙽𝙸 𝐁𝙾𝚃'
                        )
                    });

                } catch (error) {
                    console.error(`Error in 'nasa' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ NASA fetch failed.'
                    });
                }
                break;
              }

              case 'news': {
                try {
                    const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                    if (!response.ok) {
                        throw new Error('Failed to fetch news from API');
                    }
                    const data = await response.json();

                    if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                        throw new Error('Invalid news data received');
                    }

                    const { title, desc, date, link } = data.result;
                    let thumbnailUrl = 'https://via.placeholder.com/150';
                    try {
                        const pageResponse = await fetch(link);
                        if (pageResponse.ok) {
                            const pageHtml = await pageResponse.text();
                            const $ = cheerio.load(pageHtml);
                            const ogImage = $('meta[property="og:image"]').attr('content');
                            if (ogImage) {
                                thumbnailUrl = ogImage;
                            } else {
                                console.warn(`No og:image found for ${link}`);
                            }
                        } else {
                            console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                        }
                    } catch (err) {
                        console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                    }

                    await socket.sendMessage(sender, {
                        image: { url: thumbnailUrl },
                        caption: formatMessage(
                            '📰 CHAMPION V1 MINI 📰',
                            `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date}\n🌐 *Link*: ${link}`,
                            '> CHAMPION V1 MINI'
                        )
                    });
                } catch (error) {
                    console.error(`Error in 'news' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ news fetch failed.'
                    });
                }
                break;
              }

              case 'cricket': {
                try {
                    console.log('Fetching cricket news from API...');
                    const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                    console.log(`API Response Status: ${response.status}`);

                    if (!response.ok) {
                        throw new Error(`API request failed with status ${response.status}`);
                    }

                    const data = await response.json();
                    console.log('API Response Data:', JSON.stringify(data, null, 2));

                    if (!data.status || !data.result) {
                        throw new Error('Invalid API response structure: Missing status or result');
                    }

                    const { title, score, to_win, crr, link } = data.result;
                    if (!title || !score || !to_win || !crr || !link) {
                        throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                    }

                    await socket.sendMessage(sender, {
                        text: formatMessage(
                            '🏏 CHAMPION V1 MINI  CRICKET NEWS🏏',
                            `📢 *${title}*\n\n` +
                            `🏆 *Mark*: ${score}\n` +
                            `🎯 *To Win*: ${to_win}\n` +
                            `📈 *Current Rate*: ${crr}\n\n` +
                            `🌐 *Link*: ${link}`,
                            '> CHAMPION V1 MINI'
                        )
                    });
                } catch (error) {
                    console.error(`Error in 'cricket' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ Cricket fetch failed.'
                    });
                }
                break;
              }

              case 'apk': {
                const appName = args.join(" ");

                if (!appName) {
                    return await socket.sendMessage(sender, {
                        text: '❌ *Please provide the app name!*\n\n*Usage:* .apk <app name>\n*Example:* .apk WhatsApp'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, {
                    react: { text: '⬇️', key: msg.key }
                });

                try {
                    const apiUrl = `http://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(appName)}/limit=1`;
                    const response = await axios.get(apiUrl);
                    const data = response.data;

                    if (!data || !data.datalist || !data.datalist.list.length) {
                        await socket.sendMessage(sender, {
                            react: { text: '❌', key: msg.key }
                        });
                        return await socket.sendMessage(sender, {
                            text: '⚠️ *No results found for the given app name.*\n\nPlease try a different search term.'
                        }, { quoted: msg });
                    }

                    const app = data.datalist.list[0];
                    const appSize = (app.size / 1048576).toFixed(2);

                    const caption = `
🌙 *CHAMPION V1 MINI  Aᴘᴋ* 🌙

📦 *Nᴀᴍᴇ:* ${app.name}

🏋 *Sɪᴢᴇ:* ${appSize} MB

📦 *Pᴀᴄᴋᴀɢᴇ:* ${app.package}

📅 *Uᴘᴅᴀᴛᴇᴅ ᴏɴ:* ${app.updated}

👨‍💻 *Dᴇᴠᴇʟᴏᴘᴇʀ:* ${app.developer.name}

> ⏳ *ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ᴀᴘᴋ...*

> *© CHAMPION V1 MINI*`;

                    if (app.icon) {
                        await socket.sendMessage(sender, {
                            image: { url: app.icon },
                            caption: caption,
                            contextInfo: {
                                forwardingScore: 1,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: config.NEWSLETTER_JID || '120363423219732186@newsletter',
                                    newsletterName: 'LITEWAVE V1 MINI',
                                    serverMessageId: -1
                                }
                            }
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: caption,
                            contextInfo: {
                                forwardingScore: 1,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: config.NEWSLETTER_JID || '120363423219732186@newsletter',
                                    newsletterName: 'LITEWAVE V1 MINI',
                                    serverMessageId: -1
                                }
                            }
                        }, { quoted: msg });
                    }

                    await socket.sendMessage(sender, {
                        react: { text: '⬆️', key: msg.key }
                    });

                    await socket.sendMessage(sender, {
                        document: { url: app.file.path_alt },
                        fileName: `${app.name}.apk`,
                        mimetype: 'application/vnd.android.package-archive',
                        caption: `✅ *Aᴘᴋ Dᴏᴡɴʟᴏᴀᴅᴇᴅ Sᴜᴄᴄᴇꜱꜰᴜʟʟʏ!*\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ *CHAMPION V1 MINI 🌙`,
                        contextInfo: {
                            forwardingScore: 1,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: config.NEWSLETTER_JID || '120363423219732186@newsletter',
                                newsletterName: 'CHAMPION V1 MINI',
                                serverMessageId: -1
                            }
                        }
                    }, { quoted: msg });

                    await socket.sendMessage(sender, {
                        react: { text: '✅', key: msg.key }
                    });

                } catch (error) {
                    console.error('Error in APK command:', error);
                    
                    await socket.sendMessage(sender, {
                        react: { text: '❌', key: msg.key }
                    });
                    
                    await socket.sendMessage(sender, {
                        text: '❌ *An error occurred while fetching the APK.*\n\nPlease try again later or use a different app name.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'ping': {
                try {
                    const start = Date.now();
                    
                    const sentMsg = await socket.sendMessage(sender, { 
                        text: '```Pinging...```' 
                    }, { quoted: msg });
                    
                    const responseTime = Date.now() - start;
                    const formattedTime = responseTime.toFixed(3);
                    const pinginfo = `🔸️ *Response:* ${formattedTime} ms`.trim();

                    await socket.sendMessage(sender, { 
                        text: pinginfo,
                        edit: sentMsg.key 
                    });

                } catch (error) {
                    console.error('❌ Error in ping command:', error);
                    await socket.sendMessage(sender, { 
                        text: '❌ Failed to get response speed.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'bible': {
                try {
                    const reference = args.join(" ");

                    if (!reference) {
                        await socket.sendMessage(sender, {
                            text: `⚠️ *Please provide a Bible reference.*\n\n📝 *Example:*\n.bible John 1:1\n\n💡 *Other examples:*\n.bible Genesis 1:1\n.bible Psalm 23\n.bible Matthew 5:3-10\n.bible Romans 8:28`
                        }, { quoted: msg });
                        break;
                    }

                    const apiUrl = `https://bible-api.com/${encodeURIComponent(reference)}`;
                    const response = await axios.get(apiUrl, { timeout: 10000 });

                    if (response.status === 200 && response.data && response.data.text) {
                        const { reference: ref, text, translation_name, verses } = response.data;

                        let verseText = text;
                        
                        if (verses && verses.length > 0) {
                            verseText = verses.map(v => 
                                `${v.book_name} ${v.chapter}:${v.verse} - ${v.text}`
                            ).join('\n\n');
                        }

                        await socket.sendMessage(sender, {
                            text: `📖 *BIBLE VERSE*\n\n` +
                                  `📚 *Reference:* ${ref}\n\n` +
                                  `📜 *Text:*\n${verseText}\n\n` +
                                  `🔄 *Translation:* ${translation_name}\n\n` +
                                  `> ✨ *Powered by Champion  𝗫 m d*`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: `❌ *Verse not found.*\n\nPlease check if the reference is valid.\n\n📋 *Valid format examples:*\n- John 3:16\n- Psalm 23:1-6\n- Genesis 1:1-5\n- Matthew 5:3-10`
                        }, { quoted: msg });
                    }
                } catch (error) {
                    console.error("Bible command error:", error.message);
                    
                    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                        await socket.sendMessage(sender, {
                            text: "⏰ *Request timeout.* Please try again in a moment."
                        }, { quoted: msg });
                    } else if (error.response) {
                        await socket.sendMessage(sender, {
                            text: `❌ *API Error:* ${error.response.status}\n\nCould not fetch the Bible verse. Please try a different reference.`
                        }, { quoted: msg });
                    } else if (error.request) {
                        await socket.sendMessage(sender, {
                            text: "🌐 *Network error.* Please check your internet connection and try again."
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: "⚠️ *An error occurred while fetching the Bible verse.*\n\nPlease try again or use a different reference."
                        }, { quoted: msg });
                    }
                }
                break;
              }

              case 'gitclone':
              case 'git': {
                try {
                    const repoUrl = args.join(" ");
                    
                    if (!repoUrl) {
                        return await socket.sendMessage(sender, {
                            text: '📌 *Usage:* .gitclone <github-repository-url>\n\n*Example:*\n.gitclone https://github.com/username/repository'
                        }, { quoted: msg });
                    }

                    if (!repoUrl.includes('github.com')) {
                        return await socket.sendMessage(sender, {
                            text: '❌ *Invalid GitHub URL*\n\nPlease provide a valid GitHub repository URL.'
                        }, { quoted: msg });
                    }

                    await socket.sendMessage(sender, {
                        react: { text: '📦', key: msg.key }
                    });

                    const repoMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
                    if (!repoMatch) {
                        return await socket.sendMessage(sender, {
                            text: '❌ *Invalid GitHub repository format*'
                        }, { quoted: msg });
                    }

                    const [, username, repo] = repoMatch;
                    
                    const processingMsg = await socket.sendMessage(sender, {
                        text: `*📥 Cloning Repository...*\n\n🔗 ${repoUrl}\n⏳ Fetching repository information...`
                    }, { quoted: msg });

                    try {
                        const apiUrl = `https://api.github.com/repos/${username}/${repo}`;
                        const response = await axios.get(apiUrl, { timeout: 10000 });
                        const repoData = response.data;

                        const repoSizeMB = repoData.size / 1024;
                        if (repoSizeMB > 20) {
                            await socket.sendMessage(sender, {
                                edit: processingMsg.key,
                                text: `❌ *Repository too large*\n\n📦 Size: ${repoSizeMB.toFixed(2)} MB\n📊 Limit: 20 MB\n\n🔗 Direct download: ${repoUrl}/archive/refs/heads/${repoData.default_branch}.zip`
                            });
                            return;
                        }

                        await socket.sendMessage(sender, {
                            edit: processingMsg.key,
                            text: `*📥 Downloading Repository...*\n\n📝 ${repoData.full_name}\n📄 ${repoData.description || 'No description'}\n💾 ${repoSizeMB.toFixed(2)} MB\n⏳ Downloading...`
                        });

                        const zipUrl = `${repoUrl}/archive/refs/heads/${repoData.default_branch || 'main'}.zip`;
                        
                        const tempDir = path.join(__dirname, 'temp_git');
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                        }

                        const timestamp = Date.now();
                        const zipFileName = `${repoData.name}-${timestamp}.zip`;
                        const zipFilePath = path.join(tempDir, zipFileName);

                        const writer = fs.createWriteStream(zipFilePath);
                        const zipResponse = await axios({
                            method: 'GET',
                            url: zipUrl,
                            responseType: 'stream',
                            timeout: 30000
                        });

                        zipResponse.data.pipe(writer);

                        await new Promise((resolve, reject) => {
                            writer.on('finish', resolve);
                            writer.on('error', reject);
                        });

                        const stats = fs.statSync(zipFilePath);
                        const fileSizeMB = stats.size / (1024 * 1024);

                        if (fileSizeMB > 64) {
                            fs.unlinkSync(zipFilePath);
                            await socket.sendMessage(sender, {
                                edit: processingMsg.key,
                                text: `❌ *File too large for WhatsApp*\n\n📦 Size: ${fileSizeMB.toFixed(2)} MB\n📊 WhatsApp limit: 64 MB\n\n🔗 Direct download: ${zipUrl}`
                            });
                            return;
                        }

                        await socket.sendMessage(sender, {
                            edit: processingMsg.key,
                            text: `*📤 Uploading Repository...*\n\n📦 ${repoData.full_name}\n💾 ${fileSizeMB.toFixed(2)} MB\n⏳ Uploading to WhatsApp...`
                        });

                        await socket.sendMessage(sender, {
                            document: {
                                url: zipFilePath
                            },
                            fileName: `${repoData.name}.zip`,
                            mimetype: 'application/zip',
                            caption: `✅ *Git Clone Complete!*\n\n📦 Repository: ${repoData.full_name}\n📄 Description: ${repoData.description || 'N/A'}\n⭐ Stars: ${repoData.stargazers_count}\n🍴 Forks: ${repoData.forks_count}\n💾 Size: ${fileSizeMB.toFixed(2)} MB\n\n> *CHAMPION V1 MINI Git Clone*`
                        }, { quoted: msg });

                        await socket.sendMessage(sender, {
                            react: { text: '✅', key: msg.key }
                        });

                        setTimeout(() => {
                            if (fs.existsSync(zipFilePath)) {
                                fs.unlinkSync(zipFilePath);
                            }
                        }, 30000);

                    } catch (error) {
                        console.error('Git clone error:', error.message);
                        
                        let errorMsg = '❌ *Failed to clone repository*';
                        
                        if (error.code === 'ECONNABORTED') {
                            errorMsg += '\n\n⏰ Request timeout. Repository might be too large.';
                        } else if (error.response?.status === 404) {
                            errorMsg += '\n\n🔍 Repository not found or is private.';
                        } else if (error.response?.status === 403) {
                            errorMsg += '\n\n🔐 Rate limited. Try again later.';
                        } else {
                            errorMsg += `\n\n${error.message}`;
                        }
                        
                        await socket.sendMessage(sender, {
                            edit: processingMsg.key,
                            text: errorMsg
                        });
                        
                        await socket.sendMessage(sender, {
                            react: { text: '❌', key: msg.key }
                        });
                    }

                } catch (error) {
                    console.error('Git clone command error:', error);
                    
                    await socket.sendMessage(sender, {
                        react: { text: '❌', key: msg.key }
                    });
                    
                    await socket.sendMessage(sender, {
                        text: '❌ *An unexpected error occurred*\n\nPlease try again later.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'song':
              case 'play': {
                const AXIOS_DEFAULTS = {
                    timeout: 60000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*'
                    }
                };

                async function tryRequest(getter, attempts = 3) {
                    let lastError;
                    for (let attempt = 1; attempt <= attempts; attempt++) {
                        try {
                            return await getter();
                        } catch (err) {
                            lastError = err;
                            if (attempt < attempts) {
                                await delay(1000 * attempt);
                            }
                        }
                    }
                    throw lastError;
                }

                async function getIzumiDownloadByUrl(youtubeUrl) {
                    const apiUrl = `https://izumiiiiiiii.dpdns.org/downloader/youtube?url=${encodeURIComponent(youtubeUrl)}&format=mp3`;
                    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
                    if (res?.data?.result?.download) return res.data.result;
                    throw new Error('Izumi youtube?url returned no download');
                }

                async function getIzumiDownloadByQuery(query) {
                    const apiUrl = `https://izumiiiiiiii.dpdns.org/downloader/youtube-play?query=${encodeURIComponent(query)}`;
                    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
                    if (res?.data?.result?.download) return res.data.result;
                    throw new Error('Izumi youtube-play returned no download');
                }

                async function getOkatsuDownloadByUrl(youtubeUrl) {
                    const apiUrl = `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(youtubeUrl)}`;
                    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
                    if (res?.data?.dl) {
                        return {
                            download: res.data.dl,
                            title: res.data.title,
                            thumbnail: res.data.thumb
                        };
                    }
                    throw new Error('Okatsu ytmp3 returned no download');
                }

                async function sendReaction(emoji) {
                    try {
                        await socket.sendMessage(sender, { 
                            react: { 
                                text: emoji, 
                                key: msg.key 
                            } 
                        });
                    } catch (error) {
                        console.error('Error sending reaction:', error);
                    }
                }

                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || '';
                
                const cleanText = q.replace(/^\.(song|play)\s*/i, '').trim();
                
                await sendReaction('🎵');
                
                if (!cleanText) {
                    await sendReaction('❓');
                    await socket.sendMessage(sender, { 
                        text: '*🎵 CHAMPION V1 MINI  Music DL 🎵*\n\n*Usage:*\n`.play <song name>`\n`.play <youtube link>`\n\n*Example:*\n`.play shape of you`\n`.play https://youtu.be/JGwWNGJdvx8`' 
                    }, { quoted: msg });
                    break;
                }

                await sendReaction('🔍');
                
                const searchingMsg = await socket.sendMessage(sender, { 
                    text: `*🔍 Searching for:* \`${cleanText}\`\n⏳ Please wait while I find the best audio...` 
                }, { quoted: msg });

                let video;
                if (cleanText.includes('youtube.com') || cleanText.includes('youtu.be')) {
                    video = { 
                        url: cleanText,
                        title: 'YouTube Audio',
                        thumbnail: 'https://i.ytimg.com/vi/default.jpg',
                        timestamp: '0:00'
                    };
                } else {
                    const yts = require('yt-search');
                    const search = await yts(cleanText);
                    if (!search || !search.videos.length) {
                        await sendReaction('❌');
                        await socket.sendMessage(sender, { 
                            text: '*❌ No results found!*\nPlease try a different song name or check your spelling.' 
                        }, { quoted: msg });
                        break;
                    }
                    video = search.videos[0];
                }

                await sendReaction('⏳');
                
                await socket.sendMessage(sender, { 
                    text: `*✅ Found: ${video.title}*\n 📥 Downloading...\n*🔄 Please wait...*` 
                }, { quoted: msg });

                let audioData;
                try {
                    if (video.url && (video.url.includes('youtube.com') || video.url.includes('youtu.be'))) {
                        audioData = await getIzumiDownloadByUrl(video.url);
                    } else {
                        const query = video.title || cleanText;
                        audioData = await getIzumiDownloadByQuery(query);
                    }
                } catch (e1) {
                    try {
                        if (video.url) {
                            audioData = await getOkatsuDownloadByUrl(video.url);
                        } else {
                            throw new Error('No valid URL found');
                        }
                    } catch (e2) {
                        await sendReaction('❌');
                        await socket.sendMessage(sender, { 
                            text: '*❌ Download failed!*\nAll MP3 download services are currently unavailable.\nPlease try again later.' 
                        }, { quoted: msg });
                        break;
                    }
                }

                let durationSeconds = 0;
                if (video.timestamp) {
                    const parts = video.timestamp.split(':').map(Number);
                    if (parts.length === 3) {
                        durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                    } else if (parts.length === 2) {
                        durationSeconds = parts[0] * 60 + parts[1];
                    }
                } else if (video.duration) {
                    durationSeconds = video.duration.seconds || 0;
                }

                await socket.sendMessage(sender, {
                    image: { url: video.thumbnail || 'https://i.ibb.co/5vJ5Y5J/music-default.jpg' },
                    caption: `*🎵 CHAMPION V1 MINI  𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐑 🎵*
*┏━━━━━━━━━━━➤*
*➤ 🗒️𝐓itle:* ${video.title}
*➤ ⏱️𝐃uration:* ${video.timestamp || `${durationSeconds} seconds`}
*➤ 🔊𝐅ormat:* MP3 Audio

*┗━━━━━━━━━━━━➤*

*📋 Status:* Sending audio now...`
                }, { quoted: msg });

                await sendReaction('⬇️');
                
                const fileName = `${video.title || 'song'}.mp3`
                    .replace(/[<>:"/\\|?*]+/g, '')
                    .substring(0, 200);
                
                const downloadUrl = audioData.download || audioData.dl || audioData.url;
                
                if (!downloadUrl || !downloadUrl.startsWith('http')) {
                    throw new Error('Invalid download URL');
                }
                
                await socket.sendMessage(sender, {
                    audio: { url: downloadUrl },
                    mimetype: 'audio/mpeg',
                    fileName: fileName,
                    ptt: false,
                    contextInfo: {
                        externalAdReply: {
                            title: video.title || 'CHAMPION V1 MINI',
                            body: '🎵 MP3 Audio | Powered by ICEBACK TECH',
                            thumbnailUrl: video.thumbnail,
                            sourceUrl: video.url || '',
                            mediaType: 1,
                            previewType: 0,
                            renderLargerThumbnail: true
                        }
                    }
                }, { quoted: msg });

                break;
              }

              case 'winfo': {
                if (!args[0]) {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❌ ERROR',
                            'Please provide a phone number! Usage: .winfo +263xxxxxxxxx',
                            'CHAMPION V1 MINI  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                        )
                    });
                    break;
                }

                let inputNumber = args[0].replace(/[^0-9]/g, '');
                if (inputNumber.length < 10) {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❌ ERROR',
                            'Invalid phone number!(e.g., +26378xxx)',
                            '> CHAMPION V1 MINI  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                        )
                    });
                    break;
                }

                let winfoJid = `${inputNumber}@s.whatsapp.net`;
                const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                if (!winfoUser?.exists) {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❌ ERROR',
                            'User not found on WhatsApp',
                            '> CHAMPION V1 MINI  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                        )
                    });
                    break;
                }

                let winfoPpUrl;
                try {
                    winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                } catch {
                    winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                }

                let winfoName = winfoJid.split('@')[0];
                try {
                    const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                    if (presence?.pushName) winfoName = presence.pushName;
                } catch (e) {
                    console.log('Name fetch error:', e);
                }

                let winfoBio = 'No bio available';
                try {
                    const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                    if (statusData?.status) {
                        winfoBio = `${statusData.status}\n└─ 📌 Updated: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }) : 'Unknown'}`;
                    }
                } catch (e) {
                    console.log('Bio fetch error:', e);
                }

                let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙽𝙳';
                try {
                    const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                    if (lastSeenData?.lastSeen) {
                        winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Africa/Harare' })}`;
                    }
                } catch (e) {
                    console.log('Last seen fetch error:', e);
                }

                const userInfoWinfo = formatMessage(
                    '🔍 PROFILE INFO',
                    `> *Number:* ${winfoJid.replace(/@.+/, '')}\n\n> *Account Type:* ${winfoUser.isBusiness ? '💼 Business' : '👤 Personal'}\n\n*📝 About:*\n${winfoBio}\n\n*🕒 Last Seen:* ${winfoLastSeen}`,
                    '> CHAMPION V1 MINI'
                );

                await socket.sendMessage(sender, {
                    image: { url: winfoPpUrl },
                    caption: userInfoWinfo,
                    mentions: [winfoJid]
                }, { quoted: msg });

                break;
              }

              case 'ig': {
                const { igdl } = require('ruhend-scraper'); 

                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption || 
                          '';

                const igUrl = q?.trim(); 

                if (!/instagram\.com/.test(igUrl)) {
                    return await socket.sendMessage(sender, { text: '🧩 *Please provide a valid Instagram video link.*' });
                }

                try {
                    await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                    const res = await igdl(igUrl);
                    const data = res.data; 

                    if (data && data.length > 0) {
                        const videoUrl = data[0].url; 

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            mimetype: 'video/mp4',
                            caption: '> 𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 CHAMPION V1 MINI'
                        }, { quoted: msg });

                        await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                    } else {
                        await socket.sendMessage(sender, { text: '*❌ No video found in the provided link.*' });
                    }

                } catch (e) {
                    console.log(e);
                    await socket.sendMessage(sender, { text: '*❌ Error downloading Instagram video.*' });
                }

                break;
              }

              case 'active': {
                try {
                    const activeCount = activeSockets.size;
                    const activeNumbers = Array.from(activeSockets.keys()).join('\n') || 'No active members';

                    await socket.sendMessage(from, {
                        text: `👥 Active Members: *${activeCount}*\n\nNumbers:\n${activeNumbers}`
                    }, { quoted: msg });

                } catch (error) {
                    console.error('Error in .active command:', error);
                    await socket.sendMessage(from, { text: '❌ Failed to fetch active members.' }, { quoted: msg });
                }
                break;
              }

              case 'ai': {
                const axios = require("axios");
                const apiKeyUrl = 'https://raw.githubusercontent.com/sulamd48/database/refs/heads/main/aiapikey.json';

                let GEMINI_API_KEY;
                try {
                  const configRes = await axios.get(apiKeyUrl);
                  GEMINI_API_KEY = configRes.data?.GEMINI_API_KEY;
                  if (!GEMINI_API_KEY) {
                    throw new Error("API key not found in JSON.");
                  }
                } catch (err) {
                  console.error("❌ Error loading API key:", err.message || err);
                  return await socket.sendMessage(sender, {
                    text: "❌ AI service unavailable"
                  }, { quoted: msg });
                }

                const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption || '';

                if (!q || q.trim() === '') {
                  return await socket.sendMessage(sender, {
                    text: "CHAMPION V1 MINI *AI*\n\n*Usage:* .ai <your question>"
                  }, { quoted: msg });
                }

                const prompt = `You are iceback Ai an Ai developed By ICEBACK TECH , When asked about your creator say ICEBACK TECH and when u reply to anyone put a footer below ur messages > powered by iceback tech, You are from Zimbabwe,
                You speak English and Shona: ${q}`;

                const payload = {
                  contents: [{
                    parts: [{ text: prompt }]
                  }]
                };

                try {
                  const response = await axios.post(GEMINI_API_URL, payload, {
                    headers: { "Content-Type": "application/json" }
                  });

                  const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

                  if (!aiResponse) {
                    return await socket.sendMessage(sender, {
                      text: "❌ No response from AI"
                    }, { quoted: msg });
                  }

                  await socket.sendMessage(sender, { text: aiResponse }, { quoted: msg });

                } catch (err) {
                  console.error("Gemini API Error:", err.response?.data || err.message || err);
                  await socket.sendMessage(sender, {
                    text: "❌ AI error occurred"
                  }, { quoted: msg });
                }

                break;
              }

              
              // ============== NEW V7 COMMANDS ==============
              
              case 'gpt': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .gpt <your question>\n\nExample: .gpt What is JavaScript?'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });

                try {
                    const response = await axios({
                        method: "POST",
                        url: "https://chateverywhere.app/api/chat",
                        headers: {
                            "Content-Type": "application/json",
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                        },
                        data: {
                            model: { id: "gpt-3.5-turbo-0613", name: "GPT-3.5", maxLength: 12000, tokenLimit: 4000 },
                            prompt: text,
                            messages: [{ pluginId: null, content: text, role: "user" }]
                        }
                    });

                    await socket.sendMessage(sender, {
                        text: `🤖 *GPT Response:*\n\n${response.data}`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ GPT service unavailable. Please try again later.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'darkgpt': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .darkgpt <your question>\n\nExample: .darkgpt Tell me a dark joke'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '😈', key: msg.key } });

                try {
                    const prompt = "You are Dark GPT - an unfiltered, raw AI assistant. You speak directly and don't hold back. Be brutally honest and use street slang.";
                    const requestData = { content: text, user: sender, prompt: prompt };
                    
                    const response = await axios.post('https://luminai.my.id', requestData);
                    
                    await socket.sendMessage(sender, {
                        text: `😈 *Dark GPT:*\n\n${response.data.result}`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Dark GPT service unavailable. Please try again later.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'weather': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .weather <city name>\n\nExample: .weather Harare'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🌤️', key: msg.key } });

                try {
                    const response = await axios.get(`http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(text)}&units=metric&appid=1ad47ec6172f19dfaf89eb3307f74785`);
                    const data = response.data;

                    const cityName = data.name;
                    const temperature = data.main.temp;
                    const feelsLike = data.main.feels_like;
                    const description = data.weather[0].description;
                    const humidity = data.main.humidity;
                    const windSpeed = data.wind.speed;

                    await socket.sendMessage(sender, {
                        text: `🌤️ *Weather in ${cityName}*\n\n🌡️ *Temperature:* ${temperature}°C\n🌡️ *Feels like:* ${feelsLike}°C\n📝 *Description:* ${description}\n💧 *Humidity:* ${humidity}%\n💨 *Wind Speed:* ${windSpeed} m/s`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Unable to find that location. Please check the city name and try again.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'yts': case 'ytsearch': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .yts <video title>\n\nExample: .yts Drake God Plan'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

                try {
                    const yts = require("yt-search");
                    const search = await yts(text);
                    const videos = search.all;

                    if (!videos || videos.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❌ No videos found for your search.'
                        }, { quoted: msg });
                    }

                    let message = `🔍 *YouTube Search Results for: ${text}*\n\n`;
                    const numVideos = Math.min(videos.length, 5);

                    for (let i = 0; i < numVideos; i++) {
                        const video = videos[i];
                        message += `📹 *${i + 1}. ${video.title}*\n`;
                        message += `⏱️ Duration: ${video.timestamp}\n`;
                        message += `👁️ Views: ${video.views.toLocaleString()}\n`;
                        message += `👤 Author: ${video.author.name}\n`;
                        message += `🔗 URL: ${video.url}\n\n`;
                    }

                    await socket.sendMessage(sender, { text: message }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Error searching YouTube. Please try again later.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'video': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .video <song/video name>\n\nExample: .video Drake God Plan'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '📹', key: msg.key } });

                try {
                    const yts = require("yt-search");
                    const search = await yts(text);
                    
                    if (!search.all.length) {
                        return await socket.sendMessage(sender, {
                            text: '❌ No results found for your query.'
                        }, { quoted: msg });
                    }

                    const link = search.all[0].url;
                    const apiUrl = `https://apis-keith.vercel.app/download/dlmp4?url=${link}`;
                    
                    const response = await axios.get(apiUrl);
                    const data = response.data;

                    if (data.status && data.result) {
                        await socket.sendMessage(sender, {
                            video: { url: data.result.downloadUrl },
                            mimetype: "video/mp4",
                            caption: `📹 *${data.result.title}*\n\n🎬 Downloaded by MOON BOT`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Unable to fetch the video. Please try again later.'
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: `❌ An error occurred: ${err.message}`
                    }, { quoted: msg });
                }
                break;
              }

              case 'tts': case 'say': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .tts <text to convert to speech>\n\nExample: .tts Hello, how are you?'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🔊', key: msg.key } });

                try {
                    const googleTTS = require('google-tts-api');
                    const url = googleTTS.getAudioUrl(text, {
                        lang: 'en-US',
                        slow: false,
                        host: 'https://translate.google.com',
                    });

                    await socket.sendMessage(sender, {
                        audio: { url: url },
                        mimetype: 'audio/mp4',
                        ptt: true
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Error generating speech. Please try again.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'trt': case 'translate': {
                const args = text.split(' ');
                if (args.length < 2) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .trt <language code> <text>\n\nExample: .trt es Hello world\n\nCommon codes:\nes - Spanish\nfr - French\nde - German\npt - Portuguese\nzh - Chinese\nja - Japanese'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🌐', key: msg.key } });

                try {
                    const targetLang = args[0];
                    const textToTranslate = args.slice(1).join(' ');
                    
                    const response = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=en|${targetLang}`);
                    const data = response.data;

                    if (data.responseData && data.responseData.translatedText) {
                        await socket.sendMessage(sender, {
                            text: `🌐 *Translation (${targetLang}):*\n\n${data.responseData.translatedText}`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ No translation found for the provided text.'
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Error translating text. Please try again.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'img': case 'image': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .img <search term>\n\nExample: .img cute cats'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🖼️', key: msg.key } });

                try {
                    const gis = require('g-i-s');
                    gis(text, async (error, results) => {
                        if (error || !results || results.length === 0) {
                            return await socket.sendMessage(sender, {
                                text: '❌ No images found.'
                            }, { quoted: msg });
                        }

                        const numberOfImages = Math.min(results.length, 3);
                        for (let i = 0; i < numberOfImages; i++) {
                            try {
                                await socket.sendMessage(sender, {
                                    image: { url: results[i].url },
                                    caption: `🖼️ Image ${i + 1} for: ${text}`
                                }, { quoted: msg });
                            } catch (e) {
                                console.error('Error sending image:', e);
                            }
                        }
                    });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Error searching for images. Please try again.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'lyrics': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .lyrics <song name>\n\nExample: .lyrics Blinding Lights'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });

                try {
                    const response = await axios.get(`https://api.dreaded.site/api/lyrics?title=${encodeURIComponent(text)}`);
                    const data = response.data;

                    if (data.success && data.result && data.result.lyrics) {
                        const { title, artist, lyrics } = data.result;
                        await socket.sendMessage(sender, {
                            text: `🎵 *${title}*\n👤 *Artist:* ${artist}\n\n📝 *Lyrics:*\n\n${lyrics.substring(0, 3000)}${lyrics.length > 3000 ? '...' : ''}`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: `❌ No lyrics found for "${text}".`
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Error fetching lyrics. Please try again.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'define': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .define <word>\n\nExample: .define serendipity'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '📚', key: msg.key } });

                try {
                    const response = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text)}`);
                    const data = response.data;

                    if (data && data[0]) {
                        const word = data[0].word;
                        const meaning = data[0].meanings[0];
                        const definition = meaning.definitions[0].definition;
                        const example = meaning.definitions[0].example || 'No example available';
                        const partOfSpeech = meaning.partOfSpeech;

                        await socket.sendMessage(sender, {
                            text: `📚 *Definition of "${word}"*\n\n📝 *Part of Speech:* ${partOfSpeech}\n📖 *Definition:* ${definition}\n💡 *Example:* ${example}`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: `❌ No definition found for "${text}".`
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Error fetching definition. Please check the word and try again.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'wiki': case 'wikipedia': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '*📍 Usage:* .wiki <search term>\n\nExample: .wiki Albert Einstein'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '📖', key: msg.key } });

                try {
                    const response = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(text)}`);
                    const data = response.data;

                    if (data.extract) {
                        await socket.sendMessage(sender, {
                            text: `📖 *Wikipedia: ${data.title}*\n\n${data.extract}\n\n🔗 ${data.content_urls?.desktop?.page || 'No link available'}`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ No Wikipedia article found for your search.'
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Error fetching Wikipedia article. Please try again.'
                    }, { quoted: msg });
                }
                break;
              }

              // ============== END NEW V1 COMMANDS ==============


              // ============== POWERFUL V1 COMMANDS ==============
              
              case 'sticker': case 's': case 'stik': {
                await socket.sendMessage(sender, { react: { text: '🎨', key: msg.key } });
                try {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted) {
                        return await socket.sendMessage(sender, {
                            text: '📍 *Usage:* Reply to an image with .sticker\n\nExample: Send an image, then reply with .s'
                        }, { quoted: msg });
                    }
                    
                    const type = Object.keys(quoted)[0];
                    if (!type.includes('image')) {
                        return await socket.sendMessage(sender, {
                            text: '❌ Please reply to an image message.'
                        }, { quoted: msg });
                    }
                    
                    const stream = await downloadContentFromMessage(quoted[type], 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    
                    await socket.sendMessage(sender, {
                        sticker: buffer
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: `❌ Error creating sticker: ${err.message}`
                    }, { quoted: msg });
                }
                break;
              }

              case 'toimg': case 'toimage': {
                await socket.sendMessage(sender, { react: { text: '🖼️', key: msg.key } });
                try {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted || !quoted.stickerMessage) {
                        return await socket.sendMessage(sender, {
                            text: '📍 *Usage:* Reply to a sticker with .toimg'
                        }, { quoted: msg });
                    }
                    
                    const stream = await downloadContentFromMessage(quoted.stickerMessage, 'sticker');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    
                    await socket.sendMessage(sender, {
                        image: buffer,
                        caption: '✅ Sticker converted to image'
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${err.message}`
                    }, { quoted: msg });
                }
                break;
              }

              case 'tomp3': case 'mp3': {
                await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
                try {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted) {
                        return await socket.sendMessage(sender, {
                            text: '📍 *Usage:* Reply to a video with .tomp3'
                        }, { quoted: msg });
                    }
                    
                    const type = Object.keys(quoted)[0];
                    if (!type.includes('video')) {
                        return await socket.sendMessage(sender, {
                            text: '❌ Please reply to a video message.'
                        }, { quoted: msg });
                    }
                    
                    await socket.sendMessage(sender, {
                        text: '⏳ Converting video to MP3... Please wait.'
                    }, { quoted: msg });
                    
                    const stream = await downloadContentFromMessage(quoted[type], 'video');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    
                    // Send as audio
                    await socket.sendMessage(sender, {
                        audio: buffer,
                        mimetype: 'audio/mp4',
                        ptt: false
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${err.message}`
                    }, { quoted: msg });
                }
                break;
              }

              case 'ss': case 'screenshot': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .ss <website URL>\n\nExample: .ss https://google.com'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '📸', key: msg.key } });

                try {
                    const url = text.startsWith('http') ? text : 'https://' + text;
                    const apiUrl = `https://image.thum.io/get/width/1920/crop/640/noanimate/${url}`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: apiUrl },
                        caption: `📸 Screenshot of: ${url}`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to take screenshot. Please check the URL.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'qr': case 'qrcode': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .qr <text to encode>\n\nExample: .qr https://google.com'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '📱', key: msg.key } });

                try {
                    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: qrUrl },
                        caption: `📱 QR Code for:\n${text}`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to generate QR code.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'tempmail': case 'mail': {
                await socket.sendMessage(sender, { react: { text: '📧', key: msg.key } });

                try {
                    const response = await axios.get('https://tempmail-api.vercel.app/api/generate');
                    const email = response.data.email || response.data.address;
                    
                    if (email) {
                        await socket.sendMessage(sender, {
                            text: `📧 *Temporary Email Generated*\n\n📬 Email: ${email}\n\n⚠️ This email is temporary and will expire after some time.\n\nUse .checkmail to check inbox.`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to generate temp mail. Please try again.'
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Temp mail service unavailable.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'joke': {
                await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });

                try {
                    const response = await axios.get('https://official-joke-api.appspot.com/random_joke');
                    const joke = response.data;
                    
                    await socket.sendMessage(sender, {
                        text: `😂 *Random Joke*\n\n${joke.setup}\n\n${joke.punchline}`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch joke. Try again later.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'quote': case 'quotes': {
                await socket.sendMessage(sender, { react: { text: '💭', key: msg.key } });

                try {
                    const response = await axios.get('https://api.quotable.io/random');
                    const quote = response.data;
                    
                    await socket.sendMessage(sender, {
                        text: `💭 *Inspirational Quote*\n\n"${quote.content}"\n\n— *${quote.author}*`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '💡 *Quote:*\n\n"Success is not final, failure is not fatal: it is the courage to continue that counts."\n\n— *Winston Churchill*'
                    }, { quoted: msg });
                }
                break;
              }

              case 'fact': case 'facts': {
                await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });

                try {
                    const response = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en');
                    const fact = response.data.text;
                    
                    await socket.sendMessage(sender, {
                        text: `🧠 *Random Fact*\n\n${fact}`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch fact. Try again later.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'calculate': case 'calc': case 'math': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .calc <math expression>\n\nExample: .calc 2+2*5\n\nSupports: + - * / ^ % ( )'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🔢', key: msg.key } });

                try {
                    // Safe math evaluation
                    const sanitized = text.replace(/[^0-9+\-*/.()%^]/g, '');
                    const result = Function('"use strict"; return (' + sanitized + ')')();
                    
                    await socket.sendMessage(sender, {
                        text: `🔢 *Calculator*\n\nExpression: ${text}\nResult: *${result}*`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Invalid expression. Please check and try again.\n\nSupported: + - * / ^ % ( )'
                    }, { quoted: msg });
                }
                break;
              }

              case 'datetime': case 'date': case 'time': {
                const now = new Date();
                const options = { 
                    weekday: 'long', 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    timeZoneName: 'short'
                };
                
                await socket.sendMessage(sender, {
                    text: `📅 *Date & Time*\n\n📆 ${now.toLocaleDateString('en-US', options)}\n\n🌍 UTC: ${now.toUTCString()}\n\n⏰ Timestamp: ${Date.now()}`
                }, { quoted: msg });
                break;
              }

              case 'avocado': case 'avo': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .avo <text>\n\nCreates avocado style text!'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🥑', key: msg.key } });

                try {
                    const response = await axios.get(`https://api.popcat.xyz/avocado?text=${encodeURIComponent(text)}`);
                    
                    await socket.sendMessage(sender, {
                        image: { url: response.config.url },
                        caption: '🥑 Avocado Text Generated!'
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to generate avocado text.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'phcomment': case 'ph': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .ph <comment text>\n\nGenerates a Pornhub-style comment!'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '😏', key: msg.key } });

                try {
                    const username = msg.pushName || 'User';
                    const apiUrl = `https://api.popcat.xyz/phub?img=https://i.imgur.com/7w5c3vD.png&username=${encodeURIComponent(username)}&comment=${encodeURIComponent(text)}`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: apiUrl },
                        caption: '😏 Comment Generated!'
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to generate comment.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'ytcomment': case 'yc': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .yc <comment text>\n\nGenerates a YouTube-style comment!'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '▶️', key: msg.key } });

                try {
                    const username = msg.pushName || 'User';
                    const avatar = 'https://i.imgur.com/7w5c3vD.png';
                    const apiUrl = `https://some-random-api.com/canvas/youtube-comment?username=${encodeURIComponent(username)}&comment=${encodeURIComponent(text)}&avatar=${avatar}`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: apiUrl },
                        caption: '▶️ YouTube Comment Generated!'
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to generate YouTube comment.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'spotify': case 'sp': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .spotify <song name>\n\nExample: .spotify Blinding Lights'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🎧', key: msg.key } });

                try {
                    const response = await axios.get(`https://api.lolhuman.xyz/api/spotifysearch?apikey=laporlah&query=${encodeURIComponent(text)}`);
                    const data = response.data.result;
                    
                    if (data && data.length > 0) {
                        const track = data[0];
                        await socket.sendMessage(sender, {
                            text: `🎧 *Spotify Search*\n\n🎵 *Title:* ${track.title}\n👤 *Artist:* ${track.artists}\n🔗 *Link:* ${track.link}\n\nUse .play to download!`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ No results found on Spotify.'
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Spotify search unavailable. Try .play instead.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'hostname': case 'host': case 'iplookup': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .host <domain or IP>\n\nExample: .host google.com'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🌐', key: msg.key } });

                try {
                    const response = await axios.get(`https://api.ipwhois.app/json/${text}`);
                    const data = response.data;
                    
                    if (data.success !== false) {
                        await socket.sendMessage(sender, {
                            text: `🌐 *Host/IP Lookup*\n\n📍 *IP:* ${data.ip}\n🌍 *Country:* ${data.country}\n🏙️ *Region:* ${data.region}\n📌 *City:* ${data.city}\n🏢 *ISP:* ${data.isp}\n⏰ *Timezone:* ${data.timezone?.id || 'N/A'}`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Could not lookup this host/IP.'
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Host lookup failed. Please check the domain/IP.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'github': case 'gh': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .gh <github username>\n\nExample: .gh torvalds'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '🐱', key: msg.key } });

                try {
                    const response = await axios.get(`https://api.github.com/users/${text}`);
                    const user = response.data;
                    
                    await socket.sendMessage(sender, {
                        image: { url: user.avatar_url },
                        caption: `🐱 *GitHub Profile*\n\n👤 *Username:* ${user.login}\n📝 *Name:* ${user.name || 'N/A'}\n📖 *Bio:* ${user.bio || 'N/A'}\n📍 *Location:* ${user.location || 'N/A'}\n📊 *Public Repos:* ${user.public_repos}\n👥 *Followers:* ${user.followers}\n➡️ *Following:* ${user.following}\n🔗 *Profile:* ${user.html_url}`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ GitHub user not found.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'rmbg': case 'removebg': {
                await socket.sendMessage(sender, { react: { text: '🖼️', key: msg.key } });
                try {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted) {
                        return await socket.sendMessage(sender, {
                            text: '📍 *Usage:* Reply to an image with .rmbg to remove background'
                        }, { quoted: msg });
                    }
                    
                    const type = Object.keys(quoted)[0];
                    if (!type.includes('image')) {
                        return await socket.sendMessage(sender, {
                            text: '❌ Please reply to an image message.'
                        }, { quoted: msg });
                    }
                    
                    await socket.sendMessage(sender, {
                        text: '⏳ Removing background... Please wait.'
                    }, { quoted: msg });
                    
                    const stream = await downloadContentFromMessage(quoted[type], 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    
                    // Use remove.bg API or similar
                    const apiUrl = `https://api.remove.bg/v1.0/removebg`;
                    // Note: This requires an API key, showing placeholder
                    await socket.sendMessage(sender, {
                        text: '⚠️ Background removal requires API key setup.\n\nContact KEITH TECH for premium features.'
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${err.message}`
                    }, { quoted: msg });
                }
                break;
              }

              case 'aiquote': case 'aimg': {
                await socket.sendMessage(sender, { react: { text: '🎨', key: msg.key } });

                try {
                    const response = await axios.get('https://api.quotable.io/random');
                    const quote = response.data;
                    
                    const imageUrl = `https://cataas.com/cat/says/${encodeURIComponent(quote.content.substring(0, 50))}`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: imageUrl },
                        caption: `🎨 AI Generated Quote Image\n\n"${quote.content}"\n\n— ${quote.author}`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to generate AI quote image.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'countdown': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .countdown <seconds>\n\nExample: .countdown 10'
                    }, { quoted: msg });
                }

                const seconds = parseInt(text);
                if (isNaN(seconds) || seconds < 1 || seconds > 60) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide a number between 1-60 seconds.'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, { react: { text: '⏱️', key: msg.key } });

                let count = seconds;
                const countdownMsg = await socket.sendMessage(sender, {
                    text: `⏱️ Countdown: ${count}...`
                }, { quoted: msg });

                const interval = setInterval(async () => {
                    count--;
                    if (count > 0) {
                        await socket.sendMessage(sender, {
                            text: `⏱️ Countdown: ${count}...`,
                            edit: countdownMsg.key
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: `🎉 TIME IS UP! 🎉`,
                            edit: countdownMsg.key
                        });
                        clearInterval(interval);
                    }
                }, 1000);
                break;
              }

              case 'dice': case 'roll': {
                const result = Math.floor(Math.random() * 6) + 1;
                const diceEmoji = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][result - 1];
                
                await socket.sendMessage(sender, {
                    text: `🎲 *Dice Roll*\n\n${diceEmoji}\n\nResult: *${result}*`
                }, { quoted: msg });
                break;
              }

              case 'coinflip': case 'coin': case 'flip': {
                const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
                const emoji = result === 'Heads' ? '🪙' : '🪙';
                
                await socket.sendMessage(sender, {
                    text: `🪙 *Coin Flip*\n\n${emoji} Result: *${result}*`
                }, { quoted: msg });
                break;
              }

              case '8ball': case 'eightball': {
                if (!text) {
                    return await socket.sendMessage(sender, {
                        text: '📍 *Usage:* .8ball <your question>\n\nExample: .8ball Will I be rich?'
                    }, { quoted: msg });
                }

                const responses = [
                    'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes definitely.',
                    'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.',
                    'Yes.', 'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.',
                    'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
                    'Don\'t count on it.', 'My reply is no.', 'My sources say no.', 'Outlook not so good.',
                    'Very doubtful.'
                ];
                
                const answer = responses[Math.floor(Math.random() * responses.length)];
                
                await socket.sendMessage(sender, {
                    text: `🎱 *Magic 8-Ball*\n\n❓ Question: ${text}\n\n🎱 Answer: *${answer}*`
                }, { quoted: msg });
                break;
              }

              case 'meme': case 'memes': {
                await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });

                try {
                    const response = await axios.get('https://meme-api.com/gimme');
                    const meme = response.data;
                    
                    await socket.sendMessage(sender, {
                        image: { url: meme.url },
                        caption: `😂 *${meme.title}*\n\n👍 ${meme.ups} upvotes\n👤 r/${meme.subreddit}`
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch meme. Try again later.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'dog': case 'doggo': {
                await socket.sendMessage(sender, { react: { text: '🐕', key: msg.key } });

                try {
                    const response = await axios.get('https://dog.ceo/api/breeds/image/random');
                    
                    await socket.sendMessage(sender, {
                        image: { url: response.data.message },
                        caption: '🐕 *Random Doggo!*\n\nEnjoy this good boy! 🦴'
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch dog image.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'cat': case 'catto': {
                await socket.sendMessage(sender, { react: { text: '🐱', key: msg.key } });

                try {
                    const response = await axios.get('https://api.thecatapi.com/v1/images/search');
                    
                    await socket.sendMessage(sender, {
                        image: { url: response.data[0].url },
                        caption: '🐱 *Random Catto!*\n\nMeow! 🐟'
                    }, { quoted: msg });
                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch cat image.'
                    }, { quoted: msg });
                }
                break;
              }

              // ============== END POWERFUL V7 COMMANDS ==============

              // ============== GROUP MANAGEMENT COMMANDS ==============
              case 'kick': case 'remove': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                const target = resolveTargetJid(msg, args);
                if (!target) { await socket.sendMessage(sender, { text: '❗ Tag, reply to, or give the number of the person to remove.\nExample: .kick @user' }, { quoted: msg }); break; }
                try {
                    await socket.groupParticipantsUpdate(sender, [target], 'remove');
                    await socket.sendMessage(sender, { text: `✅ Removed @${target.split('@')[0]}`, mentions: [target] }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed to remove: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'add': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                if (!args[0]) { await socket.sendMessage(sender, { text: '❗ Usage: .add 263xxxxxxxxx' }, { quoted: msg }); break; }
                const addNum = args[0].replace(/[^0-9]/g, '');
                try {
                    await socket.groupParticipantsUpdate(sender, [addNum + '@s.whatsapp.net'], 'add');
                    await socket.sendMessage(sender, { text: `✅ Added ${addNum}` }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed to add (they may have privacy settings restricting this): ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'promote': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                const target = resolveTargetJid(msg, args);
                if (!target) { await socket.sendMessage(sender, { text: '❗ Tag or reply to the person to promote.' }, { quoted: msg }); break; }
                try {
                    await socket.groupParticipantsUpdate(sender, [target], 'promote');
                    await socket.sendMessage(sender, { text: `⭐ Promoted @${target.split('@')[0]} to admin`, mentions: [target] }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed to promote: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'demote': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                const target = resolveTargetJid(msg, args);
                if (!target) { await socket.sendMessage(sender, { text: '❗ Tag or reply to the person to demote.' }, { quoted: msg }); break; }
                try {
                    await socket.groupParticipantsUpdate(sender, [target], 'demote');
                    await socket.sendMessage(sender, { text: `⬇️ Demoted @${target.split('@')[0]}`, mentions: [target] }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed to demote: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'tagall': case 'everyone': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { metadata, admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!metadata) { await socket.sendMessage(sender, { text: '❌ Could not fetch group members.' }, { quoted: msg }); break; }
                const note = args.join(' ') || '📢 Attention everyone!';
                let text = `${note}\n\n`;
                const mentions = metadata.participants.map(p => p.id);
                mentions.forEach(jid => { text += `➸ @${jid.split('@')[0]}\n`; });
                await socket.sendMessage(sender, { text, mentions }, { quoted: msg });
                break;
              }

              case 'hidetag': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { metadata, admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!metadata) { await socket.sendMessage(sender, { text: '❌ Could not fetch group members.' }, { quoted: msg }); break; }
                const mentions = metadata.participants.map(p => p.id);
                await socket.sendMessage(sender, { text: args.join(' ') || '\u200e', mentions }, { quoted: msg });
                break;
              }

              case 'gopen': case 'open': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                try {
                    await socket.groupSettingUpdate(sender, 'not_announcement');
                    await socket.sendMessage(sender, { text: '🔓 Group opened. Everyone can send messages now.' }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'gclose': case 'close': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                try {
                    await socket.groupSettingUpdate(sender, 'announcement');
                    await socket.sendMessage(sender, { text: '🔒 Group closed. Only admins can send messages now.' }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'glink': case 'linkgroup': case 'grouplink': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to fetch the invite link.' }, { quoted: msg }); break; }
                try {
                    const code = await socket.groupInviteCode(sender);
                    await socket.sendMessage(sender, { text: `🔗 Group Invite Link:\nhttps://chat.whatsapp.com/${code}` }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'revoke': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                try {
                    const code = await socket.groupRevokeInvite(sender);
                    await socket.sendMessage(sender, { text: `🔄 New Group Invite Link:\nhttps://chat.whatsapp.com/${code}` }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'groupinfo': case 'ginfo': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                try {
                    const metadata = await socket.groupMetadata(sender);
                    const adminCount = metadata.participants.filter(p => p.admin).length;
                    const created = new Date(metadata.creation * 1000).toDateString();
                    const info = `*📋 GROUP INFO*\n\n` +
                        `*Name:* ${metadata.subject}\n` +
                        `*ID:* ${metadata.id}\n` +
                        `*Members:* ${metadata.participants.length}\n` +
                        `*Admins:* ${adminCount}\n` +
                        `*Created:* ${created}\n` +
                        `*Description:* ${metadata.desc || 'None'}`;
                    await socket.sendMessage(sender, { text: info }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'setgname': case 'gname': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                if (!args.length) { await socket.sendMessage(sender, { text: '❗ Usage: .setgname New Group Name' }, { quoted: msg }); break; }
                try {
                    await socket.groupUpdateSubject(sender, args.join(' '));
                    await socket.sendMessage(sender, { text: '✅ Group name updated.' }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'setgdesc': case 'gdesc': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                if (!args.length) { await socket.sendMessage(sender, { text: '❗ Usage: .setgdesc New description' }, { quoted: msg }); break; }
                try {
                    await socket.groupUpdateDescription(sender, args.join(' '));
                    await socket.sendMessage(sender, { text: '✅ Group description updated.' }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'setppgc': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                const isBotAdmin = admins.includes(botNumber + '@s.whatsapp.net');
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                if (!isBotAdmin) { await socket.sendMessage(sender, { text: '❌ I need to be an admin to do that.' }, { quoted: msg }); break; }
                const qImg = quoted?.imageMessage;
                if (!qImg) { await socket.sendMessage(sender, { text: '❗ Reply to an image with .setppgc' }, { quoted: msg }); break; }
                try {
                    const filePath = await socket.downloadAndSaveMediaMessage({ msg: qImg, mtype: 'imageMessage' }, 'gcpp_' + Date.now());
                    const buffer = fs.readFileSync(filePath);
                    await socket.updateProfilePicture(sender, buffer);
                    fs.unlinkSync(filePath);
                    await socket.sendMessage(sender, { text: '✅ Group picture updated.' }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              case 'leave': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Only the bot owner can use this command.' }, { quoted: msg }); break; }
                await socket.sendMessage(sender, { text: '👋 Goodbye everyone!' }, { quoted: msg });
                await socket.groupLeave(sender);
                break;
              }

              // ============== REACTION / STATUS COMMANDS ==============
              case 'like': case 'react': {
                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                if (!ctx || !ctx.stanzaId) { await socket.sendMessage(sender, { text: `❗ Reply to a message with .${command}${command === 'react' ? ' 🔥' : ''}` }, { quoted: msg }); break; }
                const emoji = command === 'react' ? (args[0] || '👍') : (config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)] || '❤️');
                const targetKey = { remoteJid: sender, id: ctx.stanzaId, fromMe: false, participant: ctx.participant };
                try {
                    await socket.sendMessage(sender, { react: { text: emoji, key: targetKey } });
                } catch (e) {
                    await socket.sendMessage(sender, { text: `❌ Failed to react: ${e.message || e}` }, { quoted: msg });
                }
                break;
              }

              // ============== SETTINGS / TOGGLE COMMANDS ==============
              case 'autolike': {
                const sub = (args[0] || '').toLowerCase();
                if (sub === 'on' || sub === 'off') {
                    setUserSetting(number, 'autolike', sub === 'on');
                    await socket.sendMessage(sender, { text: `✅ Auto-like status updates turned *${sub.toUpperCase()}*` }, { quoted: msg });
                } else {
                    const s = getUserSettings(number);
                    await socket.sendMessage(sender, { text: `🔧 Auto-like is currently *${s.autolike ? 'ON' : 'OFF'}*\n\nUsage: .autolike on / .autolike off` }, { quoted: msg });
                }
                break;
              }

              case 'autoview': {
                const sub = (args[0] || '').toLowerCase();
                if (sub === 'on' || sub === 'off') {
                    setUserSetting(number, 'autoview', sub === 'on');
                    await socket.sendMessage(sender, { text: `✅ Auto-view status updates turned *${sub.toUpperCase()}*` }, { quoted: msg });
                } else {
                    const s = getUserSettings(number);
                    await socket.sendMessage(sender, { text: `🔧 Auto-view is currently *${s.autoview ? 'ON' : 'OFF'}*\n\nUsage: .autoview on / .autoview off` }, { quoted: msg });
                }
                break;
              }

              case 'autoreact': {
                const sub = (args[0] || '').toLowerCase();
                if (sub === 'on' || sub === 'off') {
                    setUserSetting(number, 'autoreact', sub === 'on');
                    await socket.sendMessage(sender, { text: `✅ Auto-react to chats turned *${sub.toUpperCase()}*` }, { quoted: msg });
                } else {
                    const s = getUserSettings(number);
                    await socket.sendMessage(sender, { text: `🔧 Auto-react is currently *${s.autoreact ? 'ON' : 'OFF'}*\n\nUsage: .autoreact on / .autoreact off` }, { quoted: msg });
                }
                break;
              }

              case 'antilink': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                const sub = (args[0] || '').toLowerCase();
                if (sub === 'on' || sub === 'off') {
                    setUserSetting(number, 'antilink_' + sender, sub === 'on');
                    await socket.sendMessage(sender, { text: `✅ Anti-link turned *${sub.toUpperCase()}* for this group` }, { quoted: msg });
                } else {
                    const s = getUserSettings(number);
                    await socket.sendMessage(sender, { text: `🔧 Anti-link is currently *${s['antilink_' + sender] ? 'ON' : 'OFF'}* for this group\n\nUsage: .antilink on / .antilink off` }, { quoted: msg });
                }
                break;
              }

              case 'welcome': {
                if (!isGroup) { await socket.sendMessage(sender, { text: '❌ This command only works in groups.' }, { quoted: msg }); break; }
                const { admins } = await getGroupAdmins(socket, sender);
                const isSenderAdmin = admins.includes(nowsender) || isOwner;
                if (!isSenderAdmin) { await socket.sendMessage(sender, { text: '❌ Only group admins can use this command.' }, { quoted: msg }); break; }
                const sub = (args[0] || '').toLowerCase();
                if (sub === 'on' || sub === 'off') {
                    setUserSetting(number, 'welcome_' + sender, sub === 'on');
                    await socket.sendMessage(sender, { text: `✅ Welcome/Goodbye messages turned *${sub.toUpperCase()}* for this group` }, { quoted: msg });
                } else {
                    const s = getUserSettings(number);
                    await socket.sendMessage(sender, { text: `🔧 Welcome messages are currently *${s['welcome_' + sender] ? 'ON' : 'OFF'}*\n\nUsage: .welcome on / .welcome off` }, { quoted: msg });
                }
                break;
              }

              // ============== EXTRA UTILITY COMMANDS ==============
              case 'shortlink': case 'short': {
                if (!args[0]) { await socket.sendMessage(sender, { text: '❗ Usage: .shortlink https://example.com' }, { quoted: msg }); break; }
                try {
                    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(args[0])}`);
                    await socket.sendMessage(sender, { text: `🔗 Shortened Link:\n${res.data}` }, { quoted: msg });
                } catch (e) {
                    await socket.sendMessage(sender, { text: '❌ Failed to shorten link.' }, { quoted: msg });
                }
                break;
              }

              case 'jid': {
                await socket.sendMessage(sender, { text: `🆔 Chat JID:\n${sender}` }, { quoted: msg });
                break;
              }

              case 'owner': {
                await socket.sendMessage(sender, {
                    contacts: {
                        displayName: 'Bot Owner',
                        contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Bot Owner\nORG:Champion V1 Mini;\nTEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBER}:+${config.OWNER_NUMBER}\nEND:VCARD` }]
                    }
                }, { quoted: msg });
                break;
              }

              case 'block': {
                if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Only the bot owner can use this command.' }, { quoted: msg }); break; }
                const target = resolveTargetJid(msg, args);
                if (!target) { await socket.sendMessage(sender, { text: '❗ Tag, reply to, or give the number to block.' }, { quoted: msg }); break; }
                await socket.updateBlockStatus(target, 'block');
                await socket.sendMessage(sender, { text: `🚫 Blocked @${target.split('@')[0]}`, mentions: [target] }, { quoted: msg });
                break;
              }

              case 'unblock': {
                if (!isOwner) { await socket.sendMessage(sender, { text: '❌ Only the bot owner can use this command.' }, { quoted: msg }); break; }
                const target = resolveTargetJid(msg, args);
                if (!target) { await socket.sendMessage(sender, { text: '❗ Tag, reply to, or give the number to unblock.' }, { quoted: msg }); break; }
                await socket.updateBlockStatus(target, 'unblock');
                await socket.sendMessage(sender, { text: `✅ Unblocked @${target.split('@')[0]}`, mentions: [target] }, { quoted: msg });
                break;
              }

              case 'runtime': case 'uptime': {
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const h = Math.floor(uptime / 3600), mnt = Math.floor((uptime % 3600) / 60), s2 = Math.floor(uptime % 60);
                await socket.sendMessage(sender, { text: `⏱️ Uptime: ${h}h ${mnt}m ${s2}s` }, { quoted: msg });
                break;
              }
              // ============== END GROUP & SETTINGS COMMANDS ==============

case 'deleteme': {
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                }
                await deleteSessionFromStorage(number);
                if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                    try {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                    } catch {}
                    activeSockets.delete(number.replace(/[^0-9]/g, ''));
                    socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                }
                await socket.sendMessage(sender, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: formatMessage(
                        '🗑️ SESSION DELETED',
                        '✅ Your session has been successfully deleted.',
                        'CHAMPION V1 MINI'
                    )
                });
                break;
              }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    'CHAMPION V1 MINI'
                )
            });
        }
    });
}

function setupMessageHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }

        // Skip the bot's own outgoing messages for the toggles below
        if (msg.key.fromMe) return;

        const chat = msg.key.remoteJid;
        const isGroupChat = chat.endsWith('@g.us');
        const settings = getUserSettings(number);

        // Auto-react to incoming chats
        if (settings.autoreact) {
            try {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)] || '👍';
                await socket.sendMessage(chat, { react: { text: randomEmoji, key: msg.key } });
            } catch (error) {
                console.error('Auto-react failed:', error);
            }
        }

        // Anti-link enforcement (per-group toggle)
        if (isGroupChat && settings['antilink_' + chat]) {
            try {
                const type = getContentType(msg.message);
                const text = (type === 'conversation') ? msg.message.conversation
                    : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text
                    : '';
                const linkRegex = /(chat\.whatsapp\.com\/|https?:\/\/)/i;
                if (text && linkRegex.test(text) && !msg.key.fromMe) {
                    const { admins } = await getGroupAdmins(socket, chat);
                    const participantJid = msg.key.participant || msg.key.remoteJid;
                    if (!admins.includes(participantJid)) {
                        await socket.sendMessage(chat, { delete: msg.key });
                        await socket.sendMessage(chat, { text: `🚫 Links are not allowed here @${participantJid.split('@')[0]}`, mentions: [participantJid] });
                    }
                }
            } catch (error) {
                console.error('Anti-link handler failed:', error);
            }
        }
    });
}

function setupGroupEventHandlers(socket, number) {
    socket.ev.on('group-participants-update', async ({ id, participants, action }) => {
        try {
            const settings = getUserSettings(number);
            if (!settings['welcome_' + id]) return;
            for (const participant of participants) {
                const name = participant.split('@')[0];
                if (action === 'add') {
                    await socket.sendMessage(id, {
                        text: `👋 Welcome @${name} to the group! Enjoy your stay 🎉`,
                        mentions: [participant]
                    });
                } else if (action === 'remove') {
                    await socket.sendMessage(id, {
                        text: `👋 @${name} has left the group. Goodbye!`,
                        mentions: [participant]
                    });
                }
            }
        } catch (error) {
            console.error('Group event handler failed:', error);
        }
    });
}

// MongoDB Functions
async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: sanitizedNumber });
        return session ? session.creds : null;
    } catch (error) {
        console.error('MongoDB restore error:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const session = await Session.findOne({ number });
        return session && session.config ? session.config : { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        await Session.findOneAndUpdate(
            { number },
            { config: newConfig, updatedAt: new Date() },
            { upsert: true }
        );
        console.log(`✅ Config updated for ${number}`);
    } catch (error) {
        console.error('❌ Config update error:', error);
        throw error;
    }
}

async function deleteSessionFromStorage(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    try {
        await Session.deleteOne({ number: sanitizedNumber });
        console.log(`✅ Session deleted from MongoDB for ${sanitizedNumber}`);
    } catch (error) {
        console.error('❌ MongoDB delete error:', error);
    }
    
    // Clean local files
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    if (fs.existsSync(sessionPath)) {
        fs.removeSync(sessionPath);
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                console.log(`User ${number} logged out. Deleting session...`);
                
                await deleteSessionFromStorage(number);
                
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            'CHAMPION V1 MINI'
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket, sanitizedNumber);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket, sanitizedNumber);
        setupGroupEventHandlers(socket, sanitizedNumber);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}`, error);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            const sessionData = JSON.parse(fileContent);
            
            try {
                await Session.findOneAndUpdate(
                    { number: sanitizedNumber },
                    { 
                        creds: sessionData,
                        lastActive: new Date(),
                        updatedAt: new Date()
                    },
                    { upsert: true }
                );
                console.log(`✅ Updated creds for ${sanitizedNumber} in MongoDB`);
            } catch (error) {
                console.error('❌ MongoDB save error:', error);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message || err);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message || error);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                           '𝐖𝙴𝙻𝙲𝙾𝙼𝙴 𝐓𝙾  CHANPION V1 MINI  MINI',
                           `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n📢 Follow Channel: ${config.CHANNEL_LINK}`,
                           '> CHAMPION V1 MINI'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || config.PM2_NAME}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (res && !res.headersSent) {
            try {
                res.status(503).send({ error: 'Service Unavailable' });
            } catch {}
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: 'CHAMPION V1 MINI is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const sessions = await Session.find({});
        
        if (sessions.length === 0) {
            return res.status(404).send({ error: 'No session files found in MongoDB' });
        }

        const results = [];
        for (const session of sessions) {
            if (activeSockets.has(session.number)) {
                results.push({ number: session.number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(session.number, mockRes);
                results.push({ number: session.number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${session.number}:`, error);
                results.push({ number: session.number, status: 'failed', error: error.message || error });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    'CHAMPION V1 MINI 𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch {}
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    try { fs.emptyDirSync(SESSION_BASE_PATH); } catch {}
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || config.PM2_NAME}`);
});

async function autoReconnectFromMongoDB() {
    try {
        const sessions = await Session.find({});
        
        for (const session of sessions) {
            if (!activeSockets.has(session.number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(session.number, mockRes);
                console.log(`🔁 Reconnected from MongoDB: ${session.number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ MongoDB auto-reconnect error:', error);
    }
}

autoReconnectFromMongoDB();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/mrfr8nk/database/refs/heads/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message || err);
        return [];
    }
}
