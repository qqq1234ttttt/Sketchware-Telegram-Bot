const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

app.use(express.json({ limit: '1mb' }));

/* ========================================
   1. CONFIG
======================================== */

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const PUBLIC_BASE_URL = (
    process.env.PUBLIC_BASE_URL ||
    'https://sketchware-telegram-bot.onrender.com'
).replace(/\/+$/, '');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase environment variables are missing');
}

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
);

/* ========================================
   2. HELPER FUNCTIONS
======================================== */

function hashCredential(value) {
    return crypto
        .createHash('sha256')
        .update(value)
        .digest('hex');
}

function createCredential() {
    return crypto.randomBytes(32).toString('hex');
}

function isValidCommand(command) {
    return (
        typeof command === 'string' &&
        command.length > 0 &&
        Buffer.byteLength(command, 'utf8') <= 64
    );
}

function sendError(res, status, message) {
    return res.status(status).json({
        success: false,
        message
    });
}

/* ========================================
   3. DEVICE AUTHENTICATION
======================================== */

async function authMiddleware(req, res, next) {
    try {
        const authorization = req.headers.authorization || '';

        if (!authorization.startsWith('Bearer ')) {
            return sendError(res, 401, 'Unauthorized');
        }

        const credential = authorization.slice(7).trim();

        if (!credential) {
            return sendError(res, 401, 'Invalid credential');
        }

        const credentialHash = hashCredential(credential);

        const { data, error } = await supabase
            .from('app_installations')
            .select('installation_id')
            .eq('credential_hash', credentialHash)
            .maybeSingle();

        if (error) {
            console.error('Auth database error:', error.message);
            return sendError(res, 500, 'Authentication failed');
        }

        if (!data) {
            return sendError(res, 401, 'Invalid credential');
        }

        req.installationId = data.installation_id;

        next();

    } catch (error) {
        console.error('Auth error:', error.message);
        return sendError(res, 500, 'Authentication error');
    }
}

/* ========================================
   4. REGISTER DEVICE
======================================== */

app.post('/api/register-device', async (req, res) => {
    try {
        const installationId = crypto.randomUUID();
        const credential = createCredential();
        const credentialHash = hashCredential(credential);

        const { error } = await supabase
            .from('app_installations')
            .insert({
                installation_id: installationId,
                credential_hash: credentialHash
            });

        if (error) {
            console.error('Register error:', error.message);
            return sendError(res, 500, 'Device registration failed');
        }

        return res.json({
            success: true,
            installation_id: installationId,
            credential: credential
        });

    } catch (error) {
        console.error('Register error:', error.message);
        return sendError(res, 500, 'Server error');
    }
});

/* ========================================
   5. TELEGRAM BOT HELPER
======================================== */

async function telegramRequest(botToken, method, data = {}) {
    const url =
        `https://api.telegram.org/bot${botToken}/${method}`;

    const response = await axios.post(url, data, {
        timeout: 15000
    });

    if (!response.data || !response.data.ok) {
        throw new Error(
            response.data?.description || 'Telegram API request failed'
        );
    }

    return response.data.result;
}

/* ========================================
   6. SET WEBHOOK AUTOMATICALLY
======================================== */

async function setBotWebhook(botToken) {
    const webhookUrl =
        `${PUBLIC_BASE_URL}/api/webhook/${botToken}`;

    const result = await telegramRequest(
        botToken,
        'setWebhook',
        {
            url: webhookUrl
        }
    );

    return result;
}

/* ========================================
   7. CHECK BOT OWNERSHIP
======================================== */

async function getOwnedBot(botToken, installationId) {
    const { data, error } = await supabase
        .from('bots')
        .select('id, bot_name, bot_token, user_id')
        .eq('bot_token', botToken)
        .eq('user_id', installationId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data;
}

/* ========================================
   8. ADD BOT / RECONNECT BOT
   AUTO WEBHOOK INCLUDED
======================================== */

app.post(
    '/api/add-bot',
    authMiddleware,
    async (req, res) => {
        try {
            const botName = String(req.body.bot_name || '').trim();
            const botToken = String(req.body.bot_token || '').trim();

            if (!botToken) {
                return sendError(res, 400, 'Bot token required');
            }

            // Verify token with Telegram
            const telegramBot = await telegramRequest(
                botToken,
                'getMe'
            );

            const finalBotName =
                botName ||
                telegramBot.username ||
                telegramBot.first_name ||
                'Telegram Bot';

            // Check existing bot
            const { data: existingBot, error: findError } =
                await supabase
                    .from('bots')
                    .select('id, user_id')
                    .eq('bot_token', botToken)
                    .maybeSingle();

            if (findError) {
                console.error('Bot lookup error:', findError.message);
                return sendError(res, 500, 'Database error');
            }

            let savedBot = false;

            if (existingBot) {

                // Reassign existing bot to this installation
                const { error: updateError } = await supabase
                    .from('bots')
                    .update({
                        user_id: req.installationId,
                        bot_name: finalBotName
                    })
                    .eq('id', existingBot.id);

                if (updateError) {
                    console.error('Bot update error:', updateError.message);
                    return sendError(res, 500, 'Bot reconnect failed');
                }

                savedBot = true;

            } else {

                // Insert new bot
                const { error: insertError } = await supabase
                    .from('bots')
                    .insert({
                        user_id: req.installationId,
                        bot_name: finalBotName,
                        bot_token: botToken
                    });

                if (insertError) {
                    console.error('Bot insert error:', insertError.message);
                    return sendError(res, 500, 'Bot add failed');
                }

                savedBot = true;
            }

            // Automatically connect Telegram webhook
            if (savedBot) {
                try {
                    await setBotWebhook(botToken);

                    console.log(
                        'Webhook connected for bot:',
                        telegramBot.username || 'Bot'
                    );

                } catch (webhookError) {
                    console.error(
                        'Webhook setup error:',
                        webhookError.message
                    );

                    return res.status(502).json({
                        success: false,
                        bot_saved: true,
                        webhook_connected: false,
                        message: 'Bot saved but webhook connection failed'
                    });
                }
            }

            return res.json({
                success: true,
                bot_saved: true,
                webhook_connected: true,
                message: existingBot
                    ? 'Existing bot reconnected and webhook connected'
                    : 'Bot added and webhook connected',
                bot_name: finalBotName
            });

        } catch (error) {
            console.error('Add bot error:', error.message);

            return sendError(
                res,
                400,
                'Invalid bot token or Telegram error'
            );
        }
    }
);

/* ========================================
   9. GET MY BOTS
======================================== */

app.get(
    '/api/get-bots',
    authMiddleware,
    async (req, res) => {
        try {
            const { data, error } = await supabase
                .from('bots')
                .select('id, bot_name, bot_token')
                .eq('user_id', req.installationId)
                .order('id', { ascending: false });

            if (error) {
                console.error('Get bots error:', error.message);
                return sendError(res, 500, 'Could not load bots');
            }

            return res.json({
                success: true,
                bots: data || []
            });

        } catch (error) {
            console.error('Get bots error:', error.message);
            return sendError(res, 500, 'Server error');
        }
    }
);

/* ========================================
   10. SAVE ONE COMMAND
======================================== */

async function saveCommand(botToken, command, replyText) {
    if (!isValidCommand(command)) {
        throw new Error('Invalid command');
    }

    if (typeof replyText !== 'string') {
        throw new Error('Invalid reply text');
    }

    const { data: existing, error: findError } = await supabase
        .from('bot_commands')
        .select('id')
        .eq('bot_token', botToken)
        .eq('command', command)
        .limit(1)
        .maybeSingle();

    if (findError) {
        throw findError;
    }

    if (existing) {
        const { error: updateError } = await supabase
            .from('bot_commands')
            .update({
                reply_text: replyText
            })
            .eq('id', existing.id);

        if (updateError) {
            throw updateError;
        }

        return existing.id;
    }

    const { data, error: insertError } = await supabase
        .from('bot_commands')
        .insert({
            bot_token: botToken,
            command: command,
            reply_text: replyText
        })
        .select('id')
        .single();

    if (insertError) {
        throw insertError;
    }

    return data.id;
}

/* ========================================
   11. ADD COMMAND
======================================== */

app.post(
    '/api/add-command',
    authMiddleware,
    async (req, res) => {
        try {
            const botToken = String(req.body.bot_token || '').trim();

            if (!botToken) {
                return sendError(res, 400, 'Bot token required');
            }

            const bot = await getOwnedBot(
                botToken,
                req.installationId
            );

            if (!bot) {
                return sendError(res, 403, 'Bot not found or not owned');
            }

            // Current Android format
            // { bot_token, command, reply_text }

            if (
                typeof req.body.command === 'string' &&
                typeof req.body.reply_text === 'string'
            ) {
                await saveCommand(
                    botToken,
                    req.body.command,
                    req.body.reply_text
                );

                return res.json({
                    success: true,
                    message: 'Command saved'
                });
            }

            // Legacy format
            // { start_welcome, menu_name, menu_reply }

            const startWelcome = req.body.start_welcome;
            const menuName = req.body.menu_name;
            const menuReply = req.body.menu_reply;

            if (
                typeof startWelcome !== 'string' ||
                typeof menuName !== 'string' ||
                typeof menuReply !== 'string'
            ) {
                return sendError(res, 400, 'Invalid command data');
            }

            await saveCommand(
                botToken,
                '/start',
                startWelcome
            );

            await saveCommand(
                botToken,
                menuName,
                menuReply
            );

            return res.json({
                success: true,
                message: 'Commands saved'
            });

        } catch (error) {
            console.error('Add command error:', error.message);
            return sendError(res, 500, 'Command save failed');
        }
    }
);

/* ========================================
   12. GET COMMANDS
======================================== */

app.get(
    '/api/get-commands',
    authMiddleware,
    async (req, res) => {
        try {
            const botToken = String(req.query.bot_token || '').trim();

            if (!botToken) {
                return sendError(res, 400, 'Bot token required');
            }

            const bot = await getOwnedBot(
                botToken,
                req.installationId
            );

            if (!bot) {
                return sendError(res, 403, 'Bot not found or not owned');
            }

            const { data, error } = await supabase
                .from('bot_commands')
                .select('id, bot_token, command, reply_text')
                .eq('bot_token', botToken)
                .order('id', { ascending: true });

            if (error) {
                console.error('Get commands error:', error.message);
                return sendError(res, 500, 'Could not load commands');
            }

            return res.json({
                success: true,
                commands: data || []
            });

        } catch (error) {
            console.error('Get commands error:', error.message);
            return sendError(res, 500, 'Server error');
        }
    }
);

/* ========================================
   13. DELETE COMMAND
======================================== */

app.delete(
    '/api/delete-command',
    authMiddleware,
    async (req, res) => {
        try {
            const id = req.query.id;
            const botToken = String(req.query.bot_token || '').trim();

            if (!id || !botToken) {
                return sendError(res, 400, 'ID and bot token required');
            }

            const bot = await getOwnedBot(
                botToken,
                req.installationId
            );

            if (!bot) {
                return sendError(res, 403, 'Bot not found or not owned');
            }

            const { data, error } = await supabase
                .from('bot_commands')
                .delete()
                .eq('id', id)
                .eq('bot_token', botToken)
                .select('id');

            if (error) {
                console.error('Delete command error:', error.message);
                return sendError(res, 500, 'Delete failed');
            }

            if (!data || data.length === 0) {
                return sendError(res, 404, 'Command not found');
            }

            return res.json({
                success: true,
                message: 'Command deleted'
            });

        } catch (error) {
            console.error('Delete command error:', error.message);
            return sendError(res, 500, 'Server error');
        }
    }
);

/* ========================================
   14. UPDATE COMMAND
======================================== */

app.put(
    '/api/update-command',
    authMiddleware,
    async (req, res) => {
        try {
            const id = req.body.id;
            const botToken = String(req.body.bot_token || '').trim();
            const command = req.body.command;
            const replyText = req.body.reply_text;

            if (!id || !botToken) {
                return sendError(res, 400, 'ID and bot token required');
            }

            if (!isValidCommand(command)) {
                return sendError(res, 400, 'Invalid command');
            }

            if (typeof replyText !== 'string') {
                return sendError(res, 400, 'Invalid reply text');
            }

            const bot = await getOwnedBot(
                botToken,
                req.installationId
            );

            if (!bot) {
                return sendError(res, 403, 'Bot not found or not owned');
            }

            const { data, error } = await supabase
                .from('bot_commands')
                .update({
                    command: command,
                    reply_text: replyText
                })
                .eq('id', id)
                .eq('bot_token', botToken)
                .select('id');

            if (error) {
                console.error('Update command error:', error.message);
                return sendError(res, 500, 'Update failed');
            }

            if (!data || data.length === 0) {
                return sendError(res, 404, 'Command not found');
            }

            return res.json({
                success: true,
                message: 'Command updated'
            });

        } catch (error) {
            console.error('Update command error:', error.message);
            return sendError(res, 500, 'Server error');
        }
    }
);

/* ========================================
   15. TELEGRAM WEBHOOK
======================================== */

app.post(
    '/api/webhook/:bot_token',
    async (req, res) => {

        // Respond quickly to Telegram
        res.sendStatus(200);

        try {
            const botToken = req.params.bot_token;
            const update = req.body;

            if (!botToken || !update) {
                return;
            }

            /* ========================================
               15A. CALLBACK QUERY
            ======================================== */

            if (update.callback_query) {
                const callback = update.callback_query;

                const callbackData = callback.data;
                const chatId =
                    callback.message &&
                    callback.message.chat &&
                    callback.message.chat.id;

                if (callback.id) {
                    try {
                        await telegramRequest(
                            botToken,
                            'answerCallbackQuery',
                            {
                                callback_query_id: callback.id
                            }
                        );
                    } catch (error) {
                        console.error(
                            'Answer callback error:',
                            error.message
                        );
                    }
                }

                if (!chatId || typeof callbackData !== 'string') {
                    return;
                }

                const { data: commandData, error } = await supabase
                    .from('bot_commands')
                    .select('command, reply_text')
                    .eq('bot_token', botToken)
                    .eq('command', callbackData)
                    .limit(1)
                    .maybeSingle();

                if (error) {
                    console.error(
                        'Callback command lookup error:',
                        error.message
                    );
                    return;
                }

                if (!commandData) {
                    return;
                }

                await telegramRequest(
                    botToken,
                    'sendMessage',
                    {
                        chat_id: chatId,
                        text: commandData.reply_text
                    }
                );

                return;
            }

            /* ========================================
               15B. NORMAL MESSAGE
            ======================================== */

            if (!update.message || !update.message.text) {
                return;
            }

            const message = update.message;
            const chatId = message.chat.id;
            const incomingText = message.text.trim();

            if (!incomingText) {
                return;
            }

            const isStart =
                incomingText === '/start' ||
                incomingText.startsWith('/start ');

            if (isStart) {

                const { data: commands, error } = await supabase
                    .from('bot_commands')
                    .select('command, reply_text')
                    .eq('bot_token', botToken)
                    .order('id', { ascending: true });

                if (error) {
                    console.error(
                        'Start commands error:',
                        error.message
                    );
                    return;
                }

                const allCommands = commands || [];

                const startCommand = allCommands.find(
                    item => item.command === '/start'
                );

                const menuCommands = allCommands.filter(
                    item =>
                        typeof item.command === 'string' &&
                        item.command !== '/start'
                );

                const keyboard = [];

                for (let i = 0; i < menuCommands.length; i += 2) {
                    const row = [
                        {
                            text: menuCommands[i].command
                        }
                    ];

                    if (menuCommands[i + 1]) {
                        row.push({
                            text: menuCommands[i + 1].command
                        });
                    }

                    keyboard.push(row);
                }

                const replyText = startCommand
                    ? startCommand.reply_text
                    : 'Welcome!';

                const sendData = {
                    chat_id: chatId,
                    text: replyText
                };

                if (keyboard.length > 0) {
                    sendData.reply_markup = {
                        keyboard: keyboard,
                        resize_keyboard: true
                    };
                }

                await telegramRequest(
                    botToken,
                    'sendMessage',
                    sendData
                );

                return;
            }
            /* ========================================
               15C. NORMAL COMMAND MATCH
            ======================================== */

            const { data: matchedCommand, error } = await supabase
                .from('bot_commands')
                .select('command, reply_text')
                .eq('bot_token', botToken)
                .eq('command', incomingText)
                .limit(1)
                .maybeSingle();

            if (error) {
                console.error(
                    'Message command lookup error:',
                    error.message
                );
                return;
            }

            if (matchedCommand) {
                await telegramRequest(
                    botToken,
                    'sendMessage',
                    {
                        chat_id: chatId,
                        text: matchedCommand.reply_text
                    }
                );
            }

        } catch (error) {
            console.error('Webhook processing error:', error.message);
        }
    }
);

/* ========================================
   16. HEALTH CHECK
======================================== */

app.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'online'
    });
});

app.get('/', (req, res) => {
    res.send('Telegram Bot API is running');
});

/* ========================================
   17. GLOBAL ERROR HANDLER
======================================== */

app.use((error, req, res, next) => {
    console.error('Server error:', error.message);

    if (res.headersSent) {
        return next(error);
    }

    return res.status(500).json({
        success: false,
        message: 'Internal server error'
    });
});

/* ========================================
   18. START SERVER
======================================== */

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
