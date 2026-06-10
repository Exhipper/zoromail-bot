const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express'); // Added Express for Render compliance

// 1. CONFIGURATION
const BOT_TOKEN = '6836222721:AAGFzMP28SUNLbRAZRSplbxlpgBfIryiqAE'; 
const BASE_URL = 'https://zoromail.com/public_api.php/v1';

const bot = new Telegraf(BOT_TOKEN);

// Global registries (Replacing volatile middleware sessions with structured runtime maps)
const seenMessages = new Set(); 
const activeSessions = new Map(); // Key: chatId, Value: { email, username, domain, createdAt }

const getSession = (chatId) => {
    if (!activeSessions.has(chatId)) {
        activeSessions.set(chatId, { email: null, username: null, domain: null, createdAt: null });
    }
    return activeSessions.get(chatId);
};

const generateRandomUsername = (length = 8) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'zm'; 
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

// EXTREME HTML STRIPPER
const stripAllHtmlAndCleanText = (rawHtml) => {
    if (!rawHtml) return '';
    let clean = rawHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    clean = clean.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
    clean = clean.replace(/<[^>]+>/g, '');
    clean = clean.replace(/&nbsp;/gi, ' ')
                 .replace(/&amp;/g, '&')
                 .replace(/&lt;/g, '<')
                 .replace(/&gt;/g, '>')
                 .replace(/&quot;/g, '"');
    clean = clean.replace(/\r\n|\r|\n/g, '\n');
    clean = clean.replace(/\n{3,}/g, '\n\n');
    return clean.trim();
};

// SIX-DIGIT CODE EXTRACTOR
const extractVerificationCode = (text) => {
    const match = text.match(/\b\d{6}\b/);
    return match ? match[0] : null;
};

// REGISTER TELEGRAM INTERFACE SIDE COMMANDS
bot.telegram.setMyCommands([
    { command: 'start', description: 'Open the main dashboard interface' },
    { command: 'menu', description: 'Show your current active address details' },
    { command: 'reset', description: 'Manually delete current email & get a new one' }
]).then(() => {
    console.log('✅ Sidebar command menu registered successfully with Telegram clients!');
});

// 2. MAIN UI MENU LAYOUT
const sendMainMenu = async (ctx, text = '📬 <b>ZoroMail Web Dashboard</b>') => {
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    
    let currentEmail = '<i>None (Click New Address below!)</i>';
    if (session.email) {
        currentEmail = `<code>${session.email}</code> 📋 <i>(Tap to Copy)</i>`;
        
        const elapsed = Date.now() - session.createdAt;
        const remainingMinutes = Math.max(0, Math.ceil((1 * 60 * 60 * 1000 - elapsed) / (1000 * 60)));
        currentEmail += `\n⏳ <i>Auto-destructs in ~${remainingMinutes} minutes</i>`;
    }

    const messageText = `${text}\n\n<b>📧 Your Current Email:</b>\n${currentEmail}\n\n⚡ <i>Messages auto-open. Complete mailbox resets automatically every 1 hour!</i>`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '🌐 List Domains', callback_data: 'menu_domains' },
                { text: '🎲 New Address (Random)', callback_data: 'menu_create_random' }
            ],
            [
                { text: '🔄 Refresh Inbox Manually', callback_data: 'menu_fetch' }
            ]
        ]
    };

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(messageText, { parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            await ctx.replyWithHTML(messageText, { reply_markup: keyboard });
        }
    } catch (err) {
        await ctx.replyWithHTML(messageText, { reply_markup: keyboard });
    }
};

// 3. BASE BOT ROUTING
bot.start((ctx) => sendMainMenu(ctx, '👋 Welcome to the ZoroMail Bot!'));
bot.command('menu', (ctx) => sendMainMenu(ctx));

// Manual Reset Command
bot.command('reset', async (ctx) => {
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    const email = session.email;

    if (email) {
        try {
            const checkInbox = await axios.get(`${BASE_URL}/emails/${email}/messages`);
            if (checkInbox.data && checkInbox.data.success && Array.isArray(checkInbox.data.data)) {
                for (const msg of checkInbox.data.data) {
                    await axios.delete(`${BASE_URL}/messages/${msg.id}`).catch(() => {});
                }
            }
        } catch(e) {}
    }
    
    activeSessions.delete(chatId);
    
    await ctx.reply('🗑️ Current email profile reset. Your workspace is clean!');
    await sendMainMenu(ctx);
});

// Domain List Fetcher
bot.action('menu_domains', async (ctx) => {
    try {
        await ctx.answerCbQuery('Fetching domains...');
        const response = await axios.get(`${BASE_URL}/domains`);
        if (response.data && response.data.success) {
            const domains = response.data.data.map(d => `• <code>${d}</code>`).join('\n');
            await ctx.replyWithHTML(`🌐 <b>Available Domains:</b>\n\n${domains}`);
        } else {
            await ctx.reply('❌ Failed to retrieve available domains.');
        }
    } catch (error) {
        await ctx.reply('⚠️ Error connecting to ZoroMail API.');
    }
});

// Create Random Address
bot.action('menu_create_random', async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.answerCbQuery('Generating random email...');

    const randomUsername = generateRandomUsername(8);
    let statusMsg = await ctx.reply(`⏳ Contacting domain cluster...`, { parse_mode: 'HTML' });

    try {
        const domainResponse = await axios.get(`${BASE_URL}/domains`);
        if (!domainResponse.data || !domainResponse.data.success || domainResponse.data.data.length === 0) {
            await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
            return await ctx.reply('❌ Failed to retrieve domain variants.');
        }

        const domainsList = domainResponse.data.data;
        const targetDomain = domainsList[Math.floor(Math.random() * domainsList.length)];

        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, null, `⏳ Allocating <code>${randomUsername}@${targetDomain}</code>...`, { parse_mode: 'HTML' }).catch(() => {});

        const endpointsToTest = [
            `${BASE_URL}/emails`,
            `${BASE_URL}/addresses`,
            `${BASE_URL}/email`
        ];

        let success = false;
        let responseData = null;

        for (const endpoint of endpointsToTest) {
            try {
                const response = await axios.post(endpoint, { 
                    username: randomUsername,
                    domain: targetDomain
                });
                if (response.data && response.data.success) {
                    success = true;
                    responseData = response.data;
                    break;
                }
            } catch (err) {}
        }

        if (success && responseData) {
            const finalEmail = responseData.data.email || `${randomUsername}@${targetDomain}`;
            const timestamp = Date.now();
            
            activeSessions.set(chatId, {
                email: finalEmail,
                username: randomUsername,
                domain: targetDomain,
                createdAt: timestamp
            });

            await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
            await sendMainMenu(ctx, `🎲 <b>Generated Random Email!</b>`);
        } else {
            await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
            await ctx.reply('❌ ZoroMail refused allocation requests.');
        }
    } catch (error) {
        if (statusMsg) await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        await ctx.reply('⚠️ Error automatically creating your disposable email.');
    }
});

// Manual Fetch Button
bot.action('menu_fetch', async (ctx) => {
    const chatId = ctx.chat.id;
    const session = getSession(chatId);
    const { email } = session;

    if (!email) {
        await ctx.answerCbQuery('Generate an email address first!', { show_alert: true });
        return;
    }

    try {
        await ctx.answerCbQuery('Checking inbox...');
        const response = await axios.get(`${BASE_URL}/emails/${email}/messages`);

        if (response.data && response.data.success) {
            const messages = response.data.data;
            if (!messages || messages.length === 0) {
                await ctx.replyWithHTML(`🟢 Inbox is clean for <code>${email}</code>\n<i>(No incoming messages yet)</i>`);
                return;
            }

            await ctx.replyWithHTML(`📬 <b>Inbox for ${email}:</b>\nProcessing layout content...`);

            for (const msg of messages) {
                seenMessages.add(msg.id);
                try {
                    const bodyRes = await axios.get(`${BASE_URL}/messages/${msg.id}`);
                    if (bodyRes.data && bodyRes.data.success) {
                        const emailData = bodyRes.data.data;
                        
                        const ultraCleanBody = stripAllHtmlAndCleanText(emailData.body || '');
                        const foundCode = extractVerificationCode(ultraCleanBody);
                        
                        let codeHeader = '';
                        if (foundCode) {
                            codeHeader = `🔑 <b>EXTRACTED VERIFICATION CODE:</b>\n<code>${foundCode}</code> 📋 <i>(Tap to Copy)</i>\n\n────────────────\n`;
                        }

                        const fullEmailText = `✉️ <b>Message Received (ID: <code>${msg.id}</code>)</b>\n👤 <b>From:</b> ${msg.from.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n📝 <b>Subject:</b> ${msg.subject.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\n${codeHeader}${ultraCleanBody}\n\n🗑/delete ${msg.id}`;
                        await ctx.replyWithHTML(fullEmailText);
                    }
                } catch (e) {}
            }
        }
    } catch (error) {
        if (error.response && error.response.status === 404) {
            await ctx.replyWithHTML(`🟢 Inbox is clean for <code>${email}</code>\n<i>(No messages received yet)</i>`);
        } else {
            await ctx.reply('⚠️ Connection issue contacting ZoroMail platform servers.');
        }
    }
});

// 4. AUTOMATED REAL-TIME POLLING ENGINE WITH STRICT 1-HOUR AUTO-RESET
setInterval(async () => {
    if (activeSessions.size === 0) return;

    const currentTimestamp = Date.now();
    const EXACT_ONE_HOUR = 1 * 60 * 60 * 1000; 

    for (const [chatId, sessionData] of activeSessions.entries()) {
        const { email, username, domain, createdAt } = sessionData;
        if (!email) continue; 

        if (currentTimestamp - createdAt >= EXACT_ONE_HOUR) {
            console.log(`🧹 1-Hour Lifespan Reached. Cleaning resources for address: ${email}`);
            
            try {
                const checkInbox = await axios.get(`${BASE_URL}/emails/${email}/messages`).catch(() => null);
                if (checkInbox && checkInbox.data && checkInbox.data.success && Array.isArray(checkInbox.data.data)) {
                    for (const msg of checkInbox.data.data) {
                        await axios.delete(`${BASE_URL}/messages/${msg.id}`).catch(() => {});
                    }
                }
            } catch (cleanError) {}

            await bot.telegram.sendMessage(chatId, `⏳ <b>Your Email Has Expired (1 Hour Limit):</b>\nAddress <code>${email}</code> and its received contents have been completely wiped from the servers.\n\nTap /start or click below to generate a new address!`, { parse_mode: 'HTML' }).catch(() => {});
            activeSessions.delete(chatId);
            continue;
        }

        try {
            const response = await axios.get(`${BASE_URL}/emails/${email}/messages`);
            if (response.data && response.data.success && Array.isArray(response.data.data)) {
                for (const msg of response.data.data) {
                    
                    if (!seenMessages.has(msg.id)) {
                        seenMessages.add(msg.id); 

                        try {
                            const contentResponse = await axios.get(`${BASE_URL}/messages/${msg.id}`);
                            if (contentResponse.data && contentResponse.data.success) {
                                const emailData = contentResponse.data.data;
                                
                                const ultraCleanBody = stripAllHtmlAndCleanText(emailData.body || '');
                                const foundCode = extractVerificationCode(ultraCleanBody);
                                
                                let codeHeader = '';
                                if (foundCode) {
                                    codeHeader = `🔑 <b>EXTRACTED VERIFICATION CODE:</b>\n<code>${foundCode}</code> 📋 <i>(Tap to Copy)</i>\n\n────────────────\n`;
                                }

                                const alertText = `🔔 <b>New Email Automatically Opened!</b>\n\n📧 <b>To:</b> <code>${email}</code>\n👤 <b>From:</b> ${msg.from.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n📝 <b>Subject:</b> ${msg.subject.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\n${codeHeader}${ultraCleanBody}\n\n🗑️ To delete, click: /delete ${msg.id}`;
                                
                                await bot.telegram.sendMessage(chatId, alertText, { parse_mode: 'HTML' }).catch(() => {});
                            }
                        } catch (contentErr) {}
                    }
                }
            }
        } catch (err) {}
    }
}, 5000);

// Delete Message Manual Command
bot.command('delete', async (ctx) => {
    const msgId = ctx.message.text.replace('/delete', '').trim();
    if (!msgId) {
        return ctx.reply('⚠️ Please provide a message ID. Example: /delete 12345');
    }

    try {
        const response = await axios.delete(`${BASE_URL}/messages/${msgId}`);
        if (response.data && response.data.success) {
            ctx.replyWithHTML(`🗑️ Message <code>${msgId}</code> was successfully deleted.`);
        } else {
            ctx.reply('❌ Failed to delete the requested message.');
        }
    } catch (error) {
        ctx.reply('❌ Error executing delete command.');
    }
});

// 5. EXPRESS APP FOR RENDER FREE-TIER COMPLIANCE & KEEP-ALIVE PINGS
const app = express();
const PORT = process.env.PORT || 8080;

// Render will ping this endpoint to keep your bot from sleeping
app.get('/', (req, res) => {
    res.status(200).send('🚀 ZoroMail Engine is Live and Active.');
});

app.listen(PORT, () => {
    console.log(`🌐 Express configuration server linked on web port ${PORT}`);
});

bot.launch().then(() => console.log('🚀 ZoroMail Core with Sidebar Menu Commands and 1-Hour Lifespan reset online!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
