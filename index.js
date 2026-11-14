
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ========================================
// 1. SUPABASE INITIALIZE
// ========================================

if (!process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORT = process.env.PORT || 3000;

// ========================================
// 2. HELPER FUNCTIONS
// ========================================

function hashCredential(value) {
    return crypto
        .createHash('sha256')
        .update(value)
        .digest('hex');
}

function getBearerToken(req) {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
        return null;
    }

    return header.substring(7).trim();
}

function sendError(res, status, message) {
    return res.status(status).json({
        success: false,
        error: message
    });
}

// ========================================
// 3. AUTHENTICATION MIDDLEWARE
// ========================================

async function authenticate(req, res, next) {
    try {
        const credential = getBearerToken(req);

        if (!credential) {
            return sendError(res, 401, 'Missing authorization');
        }

        const credentialHash = hashCredential(credential);

        const { data, error } = await supabase
            .from('app_installations')
            .select('installation_id')
            .eq('credential_hash', credentialHash)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            return sendError(res, 401, 'Invalid credential');
        }

        req.installationId = data.installation_id;

        next();

    } catch (err) {
        console.error('Authentication Error:', err.message);
        return sendError(res, 500, 'Authentication failed');
    }
}

// ========================================
// 4. REGISTER NEW APP INSTALLATION
// ========================================

app.post('/api/register-device', async (req, res) => {
    try {
        const installationId = crypto.randomUUID();

        // Credential ကို တစ်ကြိမ်သာ ထုတ်ပေးမည်
        const credential = crypto.randomBytes(32).toString('hex');

        const credentialHash = hashCredential(credential);

        const { error } = await supabase
            .from('app_installations')
            .insert([{
                installation_id: installationId,
                credential_hash: credentialHash
            }]);

        if (error) throw error;

        res.json({
            success: true,
            installation_id: installationId,
            credential: credential
        });

    } catch (err) {
        console.error('Register Error:', err.message);
        return sendError(res, 500, 'Device registration failed');
    }
});

// ========================================
// 5. ADD OR RECOVER BOT
// ========================================

app.post('/api/add-bot', authenticate, async (req, res) => {
    try {
        const botToken = String(req.body.bot_token || '').trim();

        if (!botToken) {
            return sendError(res, 400, 'Bot token is missing');
        }

        // Telegram Token မှန်မမှန် စစ်မည်
        const telegramResponse = await axios.get(
            `https://api.telegram.org/bot${botToken}/getMe`,
            { timeout: 15000 }
        );

        if (!telegramResponse.data.ok) {
            return sendError(res, 400, 'Invalid Telegram bot token');
        }

        const botName =
            String(req.body.bot_name || '').trim() ||
            telegramResponse.data.result.username ||
            'Telegram Bot';

        // Token ရှိပြီးသားလား စစ်မည်
        const { data: existingBot, error: findError } = await supabase
            .from('bots')
            .select('bot_token')
            .eq('bot_token', botToken)
            .maybeSingle();

        if (findError) throw findError;

        if (existingBot) {

            // Token ကို ပိုင်ဆိုင်ကြောင်း သက်သေပြနိုင်သူက
            // သူ့ Installation နဲ့ ပြန်ချိတ်ဆက်နိုင်မည်
            const { error: updateError } = await supabase
                .from('bots')
                .update({
                    user_id: req.installationId,
                    bot_name: botName
                })
                .eq('bot_token', botToken);

            if (updateError) throw updateError;

            return res.json({
                success: true,
                recovered: true,
                message: 'Existing bot connected successfully'
            });
        }

        // Bot အသစ်
        const { error: insertError } = await supabase
            .from('bots')
            .insert([{
                user_id: req.installationId,
                bot_name: botName,
                bot_token: botToken
            }]);

        if (insertError) throw insertError;

        res.json({
            success: true,
            recovered: false,
            message: 'New bot registered successfully'
        });

    } catch (err) {
        console.error('Add Bot Error:', err.message);
        return sendError(res, 500, 'Unable to register bot');
    }
});

// ========================================
// 6. GET BOTS - OWNER ONLY
// ========================================

app.get('/api/get-bots', authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('bots')
            .select('bot_name, bot_token')
            .eq('user_id', req.installationId);

        if (error) throw error;

        res.json({
            success: true,
            bots: data || []
        });

    } catch (err) {
        console.error('Get Bots Error:', err.message);
        return sendError(res, 500, 'Unable to get bots');
    }
});

// ========================================
// 7. CHECK BOT OWNERSHIP
// ========================================

async function checkBotOwnership(installationId, botToken) {
    const { data, error } = await supabase
        .from('bots')
        .select('bot_token')
        .eq('user_id', installationId)
        .eq('bot_token', botToken)
        .maybeSingle();

    if (error) throw error;

    return !!data;
}

// ========================================
// 8. ADD COMMAND / MENU
// ========================================

app.post('/api/add-command', authenticate, async (req, res) => {
    try {
        const botToken = String(req.body.bot_token || '').trim();

        const startWelcome =
            String(req.body.start_welcome || '').trim();

        const menuName =
            String(req.body.menu_name || '').trim();

        const menuReply =
            String(req.body.menu_reply || '').trim();

        if (!botToken) {
            return sendError(res, 400, 'Bot token is missing');
        }

        const isOwner = await checkBotOwnership(
            req.installationId,
            botToken
        );

        if (!isOwner) {
            return sendError(res, 403, 'Bot ownership verification failed');
        }

        async function saveCommand(command, replyText) {
            const { data: existing, error: findError } = await supabase
                .from('bot_commands')
                .select('id')
                .eq('bot_token', botToken)
                .eq('command', command)
                .maybeSingle();

            if (findError) throw findError;

            if (existing) {
                const { error } = await supabase
                    .from('bot_commands')
                    .update({ reply_text: replyText })
                    .eq('id', existing.id)
                    .eq('bot_token', botToken);

                if (error) throw error;

            } else {
                const { error } = await supabase
                    .from('bot_commands')
                    .insert([{
                        bot_token: botToken,
                        command: command,
                        reply_text: replyText,
                        button_text: '',
                        button_url: '',
                        menu_keyboard: ''
                    }]);

                if (error) throw error;
            }
        }

        if (startWelcome) {
            await saveCommand('/start', startWelcome);
        }

        if (menuName && menuReply) {
            await saveCommand(menuName, menuReply);
        }

        res.json({
            success: true,
            message: 'Saved successfully'
        });

    } catch (err) {
        console.error('Add Command Error:', err.message);
        return sendError(res, 500, 'Unable to save command');
    }
});

// ========================================
// 9. GET COMMANDS - OWNER ONLY
// ========================================

app.get('/api/get-commands', authenticate, async (req, res) => {
    try {
        const botToken = String(req.query.bot_token || '').trim();

        if (!botToken) {
            return sendError(res, 400, 'Bot token is missing');
        }

        const isOwner = await checkBotOwnership(
            req.installationId,
            botToken
        );

        if (!isOwner) {
            return sendError(res, 403, 'Access denied');
        }

        const { data, error } = await supabase
            .from('bot_commands')
            .select('*')
            .eq('bot_token', botToken);

        if (error) throw error;

        res.json({
            success: true,
            commands: data || []
        });

    } catch (err) {
        console.error('Get Commands Error:', err.message);
        return sendError(res, 500, 'Unable to get commands');
    }
});

// ========================================
// 10. DELETE COMMAND - OWNER ONLY
// ========================================

app.delete('/api/delete-command', authenticate, async (req, res) => {
    try {
        const commandId = req.query.id;
        const botToken = String(req.query.bot_token || '').trim();

        if (!commandId || !botToken) {
            return sendError(res, 400, 'Missing command ID or bot token');
        }

        const isOwner = await checkBotOwnership(
            req.installationId,
            botToken
        );

        if (!isOwner) {
            return sendError(res, 403, 'Access denied');
        }

        const { error, count } = await supabase
            .from('bot_commands')
            .delete({ count: 'exact' })
            .eq('id', commandId)
            .eq('bot_token', botToken);

        if (error) throw error;

        res.json({
            success: true,
            deleted: count
        });

    } catch (err) {
        console.error('Delete Command Error:', err.message);
        return sendError(res, 500, 'Unable to delete command');
    }
});

// ========================================
// 11. UPDATE COMMAND - OWNER ONLY
// ========================================

app.put('/api/update-command', authenticate, async (req, res) => {
    try {
        const id = req.body.id;
        const botToken = String(req.body.bot_token || '').trim();
        const command = String(req.body.command || '').trim();
        const replyText = String(req.body.reply_text || '').trim();

        if (!id || !botToken || !command || !replyText) {
            return sendError(res, 400, 'Missing required fields');
        }

        const isOwner = await checkBotOwnership(
            req.installationId,
            botToken
        );

        if (!isOwner) {
            return sendError(res, 403, 'Access denied');
        }

        const { error } = await supabase
            .from('bot_commands')
            .update({
                command: command,
                reply_text: replyText
            })
            .eq('id', id)
            .eq('bot_token', botToken);

        if (error) throw error;

        res.json({
            success: true,
            message: 'Command updated successfully'
        });

    } catch (err) {
        console.error('Update Command Error:', err.message);
        return sendError(res, 500, 'Unable to update command');
    }
});

// ========================================
// 12. TELEGRAM WEBHOOK
// ========================================

app.post('/api/webhook/:bot_token', async (req, res) => {
    try {
        const botToken = req.params.bot_token;
        const update = req.body;

        if (!update.message || !update.message.text) {
            return res.sendStatus(200);
        }

        const chatId = update.message.chat.id;
        const userText = update.message.text.trim();

        const { data: allCommands, error } = await supabase
            .from('bot_commands')
            .select('*')
            .eq('bot_token', botToken);

        if (error) throw error;

        if (!allCommands || allCommands.length === 0) {
            return res.sendStatus(200);
        }

        const matchedCmd = allCommands.find(c =>
            c.command &&
            c.command.trim().toLowerCase() === userText.toLowerCase()
        );

        let replyText =
            'မင်္ဂလာပါ! ကျေးဇူးပြု၍ အောက်ပါ Menu များကို ရွေးချယ်ပါ။';

        if (matchedCmd && matchedCmd.reply_text) {
            replyText = matchedCmd.reply_text;

        } else {
            const startCmd = allCommands.find(c =>
                c.command && c.command.trim() === '/start'
            );

            if (startCmd && startCmd.reply_text) {
                replyText = startCmd.reply_text;
            }
        }

        const replyPayload = {
            chat_id: chatId,
            text: replyText
        };

        const menuButtons = [];
        let currentRow = [];

        allCommands.forEach(c => {
            if (c.command && c.command.trim() !== '/start') {
                const btnName = c.command.trim();

                const exists = menuButtons.some(row =>
                    row.some(b => b.text === btnName)
                );

                if (!exists) {
                    currentRow.push({ text: btnName });

                    if (currentRow.length === 2) {
                        menuButtons.push(currentRow);
                        currentRow = [];
                    }
                }
            }
        });

        if (currentRow.length > 0) {
            menuButtons.push(currentRow);
        }

        if (menuButtons.length > 0) {
            replyPayload.reply_markup = {
                keyboard: menuButtons,
                resize_keyboard: true,
                is_persistent: true
            };
        }

        await axios.post(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            replyPayload,
            { timeout: 15000 }
        );

        return res.sendStatus(200);

    } catch (err) {
        console.error('Webhook Error:', err.message);
        return res.sendStatus(500);
    }
});

// ========================================
// 13. HEALTH CHECK
// ========================================

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Telegram Bot Backend is running'
    });
});

// ========================================
// 14. START SERVER
// ========================================

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
