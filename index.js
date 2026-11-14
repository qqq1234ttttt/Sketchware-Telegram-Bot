
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.json({ limit: "1mb" }));

// ========================================
// 1. CONFIG
// ========================================

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing Supabase environment variables");
    process.exit(1);
}

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

// ========================================
// 2. COMMON FUNCTIONS
// ========================================

function hashCredential(value) {
    return crypto
        .createHash("sha256")
        .update(value)
        .digest("hex");
}

function getBearerToken(req) {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
        return null;
    }

    return header.substring(7).trim();
}

function sendError(res, status, message) {
    return res.status(status).json({
        success: false,
        message
    });
}

function isValidString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

// ========================================
// 3. AUTHENTICATION
// ========================================

async function authenticate(req, res, next) {
    try {
        const credential = getBearerToken(req);

        if (!credential) {
            return sendError(
                res,
                401,
                "Missing authentication credential"
            );
        }

        const credentialHash = hashCredential(credential);

        const { data, error } = await supabase
            .from("app_installations")
            .select("installation_id")
            .eq("credential_hash", credentialHash)
            .limit(1);

        if (error) {
            console.error("Authentication error:", error.message);

            return sendError(
                res,
                500,
                "Authentication service error"
            );
        }

        if (!data || data.length === 0) {
            return sendError(
                res,
                401,
                "Invalid installation credential"
            );
        }

        req.installationId = data[0].installation_id;

        next();

    } catch (error) {
        console.error("Auth exception:", error);

        return sendError(
            res,
            500,
            "Authentication failed"
        );
    }
}

// ========================================
// 4. REGISTER DEVICE
// ========================================

app.post("/api/register-device", async (req, res) => {
    try {
        const installationId = crypto.randomUUID();

        const credential = crypto
            .randomBytes(32)
            .toString("hex");

        const credentialHash = hashCredential(credential);

        const { error } = await supabase
            .from("app_installations")
            .insert({
                installation_id: installationId,
                credential_hash: credentialHash
            });

        if (error) {
            console.error("Register error:", error.message);

            return sendError(
                res,
                500,
                "Could not register device"
            );
        }

        return res.json({
            success: true,
            installation_id: installationId,
            credential: credential
        });

    } catch (error) {
        console.error("Register exception:", error);

        return sendError(
            res,
            500,
            "Device registration failed"
        );
    }
});

// ========================================
// 5. CHECK BOT OWNERSHIP
// ========================================

async function checkBotOwnership(botToken, installationId) {
    if (!isValidString(botToken)) {
        return {
            owned: false,
            error: "Invalid bot token"
        };
    }

    const { data, error } = await supabase
        .from("bots")
        .select("id")
        .eq("bot_token", botToken)
        .eq("user_id", installationId)
        .limit(1);

    if (error) {
        console.error("Ownership error:", error.message);

        return {
            owned: false,
            error: "Database error"
        };
    }

    return {
        owned: !!(data && data.length > 0),
        error: null
    };
}

// ========================================
// 6. ADD / RECONNECT BOT
// ========================================

app.post("/api/add-bot", authenticate, async (req, res) => {
    try {
        const botToken = String(req.body.bot_token || "").trim();

        if (!isValidString(botToken)) {
            return sendError(res, 400, "Bot token is required");
        }

        // Verify token with Telegram
        const telegramResponse = await axios.get(
            `https://api.telegram.org/bot${botToken}/getMe`,
            { timeout: 15000 }
        );

        if (
            !telegramResponse.data ||
            !telegramResponse.data.ok
        ) {
            return sendError(
                res,
                400,
                "Invalid Telegram bot token"
            );
        }

        const botInfo = telegramResponse.data.result;

        const botName =
            botInfo.username || botInfo.first_name || "Telegram Bot";

        // Find existing bot
        const { data: existingBots, error: findError } =
            await supabase
                .from("bots")
                .select("id")
                .eq("bot_token", botToken)
                .limit(1);

        if (findError) {
            console.error("Find bot error:", findError.message);

            return sendError(
                res,
                500,
                "Could not check existing bot"
            );
        }

        if (existingBots && existingBots.length > 0) {
            // Reconnect bot to current installation
            const { error: updateError } = await supabase
                .from("bots")
                .update({
                    user_id: req.installationId,
                    bot_name: botName
                })
                .eq("id", existingBots[0].id);

            if (updateError) {
                console.error("Reconnect error:", updateError.message);

                return sendError(
                    res,
                    500,
                    "Could not reconnect bot"
                );
            }

            return res.json({
                success: true,
                message: "Bot reconnected successfully",
                bot_name: botName,
                bot_username: botInfo.username || ""
            });
        }

        // Insert new bot
        const { error: insertError } = await supabase
            .from("bots")
            .insert({
                user_id: req.installationId,
                bot_name: botName,
                bot_token: botToken
            });

        if (insertError) {
            console.error("Insert bot error:", insertError.message);

            return sendError(
                res,
                500,
                "Could not save bot"
            );
        }

        return res.json({
            success: true,
            message: "Bot added successfully",
            bot_name: botName,
            bot_username: botInfo.username || ""
        });

    } catch (error) {
        console.error("Add bot exception:", error.message);

        if (error.response) {
            return sendError(
                res,
                400,
                "Telegram rejected this bot token"
            );
        }

        return sendError(
            res,
            500,
            "Could not add bot"
        );
    }
});

// ========================================
// 7. GET BOTS
// ========================================

app.get("/api/get-bots", authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("bots")
            .select("id, bot_name, bot_token")
            .eq("user_id", req.installationId)
            .order("id", { ascending: false });

        if (error) {
            console.error("Get bots error:", error.message);

            return sendError(
                res,
                500,
                "Could not load bots"
            );
        }

        return res.json({
            success: true,
            bots: data || []
        });

    } catch (error) {
        console.error("Get bots exception:", error);

        return sendError(
            res,
            500,
            "Could not load bots"
        );
    }
});

// ========================================
// 8. ADD COMMAND
// Supports both formats:
// A. { bot_token, command, reply_text }
// B. { bot_token, start_welcome, menu_name, menu_reply }
// ========================================

app.post("/api/add-command", authenticate, async (req, res) => {
    try {
        const botToken = String(req.body.bot_token || "").trim();

        if (!isValidString(botToken)) {
            return sendError(res, 400, "Bot token is required");
        }

        const ownership = await checkBotOwnership(
            botToken,
            req.installationId
        );

        if (!ownership.owned) {
            return sendError(
                res,
                403,
                ownership.error || "You do not own this bot"
            );
        }

        async function saveCommand(command, replyText) {
            command = String(command || "").trim();
            replyText = String(replyText || "").trim();

            if (!command || !replyText) {
                throw new Error(
                    "Command and reply text are required"
                );
            }

            // Find existing command
            const { data: existing, error: findError } =
                await supabase
                    .from("bot_commands")
                    .select("id")
                    .eq("bot_token", botToken)
                    .eq("command", command)
                    .limit(1);

            if (findError) {
                throw findError;
            }

            if (existing && existing.length > 0) {
                // Update existing command
                const { error: updateError } = await supabase
                    .from("bot_commands")
                    .update({
                        reply_text: replyText
                    })
                    .eq("id", existing[0].id)
                    .eq("bot_token", botToken);

                if (updateError) {
                    throw updateError;
                }

            } else {
                // Insert new command
                const { error: insertError } = await supabase
                    .from("bot_commands")
                    .insert({
                        bot_token: botToken,
                        command: command,
                        reply_text: replyText
                    });

                if (insertError) {
                    throw insertError;
                }
            }
        }

        // New Android format
        if (
            req.body.command !== undefined ||
            req.body.reply_text !== undefined
        ) {
            const command = req.body.command;
            const replyText = req.body.reply_text;

            if (
                !isValidString(command) ||
                !isValidString(replyText)
            ) {
                return sendError(
                    res,
                    400,
                    "Command and reply_text are required"
                );
            }

            await saveCommand(command, replyText);

            return res.json({
                success: true,
                message: "Command saved successfully"
            });
        }

        // Legacy format
        const startWelcome = req.body.start_welcome;
        const menuName = req.body.menu_name;
        const menuReply = req.body.menu_reply;

        let savedCount = 0;

        if (isValidString(startWelcome)) {
            await saveCommand("/start", startWelcome);
            savedCount++;
        }

        if (
            isValidString(menuName) &&
            isValidString(menuReply)
        ) {
            await saveCommand(menuName, menuReply);
            savedCount++;
        }

        if (savedCount === 0) {
            return sendError(
                res,
                400,
                "No valid command was provided"
            );
        }

        return res.json({
            success: true,
            message: "Commands saved successfully",
            saved_count: savedCount
        });

    } catch (error) {
        console.error("Add command error:", error.message);

        return sendError(
            res,
            500,
            "Could not save command"
        );
    }
});

// ========================================
// 9. GET COMMANDS
// ========================================

app.get("/api/get-commands", authenticate, async (req, res) => {
    try {
        const botToken = String(req.query.bot_token || "").trim();

        if (!isValidString(botToken)) {
            return sendError(res, 400, "Bot token is required");
        }

        const ownership = await checkBotOwnership(
            botToken,
            req.installationId
        );

        if (!ownership.owned) {
            return sendError(
                res,
                403,
                ownership.error || "You do not own this bot"
            );
        }

        const { data, error } = await supabase
            .from("bot_commands")
            .select("id, bot_token, command, reply_text")
            .eq("bot_token", botToken)
            .order("id", { ascending: true });

        if (error) {
            console.error("Get commands error:", error.message);

            return sendError(
                res,
                500,
                "Could not load commands"
            );
        }

        return res.json({
            success: true,
            commands: data || []
        });

    } catch (error) {
        console.error("Get commands exception:", error);

        return sendError(
            res,
            500,
            "Could not load commands"
        );
    }
});

// ========================================
// 10. DELETE COMMAND
// ========================================

app.delete("/api/delete-command", authenticate, async (req, res) => {
    try {
        const id = req.query.id;
        const botToken = String(req.query.bot_token || "").trim();

        if (!id || !isValidString(botToken)) {
            return sendError(
                res,
                400,
                "Command ID and bot token are required"
            );
        }

        const ownership = await checkBotOwnership(
            botToken,
            req.installationId
        );

        if (!ownership.owned) {
            return sendError(
                res,
                403,
                ownership.error || "You do not own this bot"
            );
        }

        const { data, error } = await supabase
            .from("bot_commands")
            .delete()
            .eq("id", id)
            .eq("bot_token", botToken)
            .select("id");

        if (error) {
            console.error("Delete command error:", error.message);

            return sendError(
                res,
                500,
                "Could not delete command"
            );
        }

        if (!data || data.length === 0) {
            return sendError(
                res,
                404,
                "Command not found"
            );
        }

        return res.json({
            success: true,
            message: "Command deleted successfully"
        });

    } catch (error) {
        console.error("Delete command exception:", error);

        return sendError(
            res,
            500,
            "Could not delete command"
        );
    }
});

// ========================================
// 11. UPDATE COMMAND
// ========================================

app.put("/api/update-command", authenticate, async (req, res) => {
    try {
        const id = req.body.id;
        const botToken = String(req.body.bot_token || "").trim();
        const command = String(req.body.command || "").trim();
        const replyText = String(req.body.reply_text || "").trim();

        if (
            !id ||
            !isValidString(botToken) ||
            !isValidString(command) ||
            !isValidString(replyText)
        ) {
            return sendError(
                res,
                400,
                "ID, bot token, command and reply text are required"
            );
        }

        const ownership = await checkBotOwnership(
            botToken,
            req.installationId
        );

        if (!ownership.owned) {
            return sendError(
                res,
                403,
                ownership.error || "You do not own this bot"
            );
        }

        const { data, error } = await supabase
            .from("bot_commands")
            .update({
                command: command,
                reply_text: replyText
            })
            .eq("id", id)
            .eq("bot_token", botToken)
            .select("id");

        if (error) {
            console.error("Update command error:", error.message);

            return sendError(
                res,
                500,
                "Could not update command"
            );
        }

        if (!data || data.length === 0) {
            return sendError(
                res,
                404,
                "Command not found"
            );
        }

        return res.json({
            success: true,
            message: "Command updated successfully"
        });

    } catch (error) {
        console.error("Update command exception:", error);

        return sendError(
            res,
            500,
            "Could not update command"
        );
    }
});

// ========================================
// 12. TELEGRAM WEBHOOK
// ========================================

app.post("/api/webhook/:bot_token", async (req, res) => {
    try {
        const botToken = String(req.params.bot_token || "").trim();

        if (!isValidString(botToken)) {
            return res.sendStatus(400);
        }

        // Telegram message only
        const message = req.body && req.body.message;

        if (!message || !message.chat || !message.text) {
            return res.sendStatus(200);
        }

        const chatId = message.chat.id;
        const incomingText = String(message.text).trim();

        // Find matching command
        const { data: commands, error } = await supabase
            .from("bot_commands")
            .select("command, reply_text")
            .eq("bot_token", botToken);

        if (error) {
            console.error("Webhook command error:", error.message);

            return res.sendStatus(200);
        }

        if (!commands || commands.length === 0) {
            return res.sendStatus(200);
        }

        const foundCommand = commands.find(item => {
            return String(item.command || "").trim() === incomingText;
        });

        if (!foundCommand) {
            return res.sendStatus(200);
        }

        const replyText = String(
            foundCommand.reply_text || ""
        ).trim();

        if (!replyText) {
            return res.sendStatus(200);
        }

        // Send Telegram reply
        await axios.post(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
                chat_id: chatId,
                text: replyText
            },
            {
                timeout: 15000
            }
        );

        return res.sendStatus(200);

    } catch (error) {
        console.error("Webhook error:", error.message);

        // Return 200 to avoid repeated webhook deliveries
        return res.sendStatus(200);
    }
});

// ========================================
// 13. HEALTH CHECK
// ========================================

app.get("/", (req, res) => {
    return res.json({
        success: true,
        message: "Telegram Bot Backend is running"
    });
});

app.get("/health", (req, res) => {
    return res.json({
        success: true,
        status: "OK"
    });
});

// ========================================
// 14. GLOBAL ERROR HANDLER
// ========================================

app.use((err, req, res, next) => {
    console.error("Unhandled server error:", err);

    if (res.headersSent) {
        return next(err);
    }

    return sendError(
        res,
        500,
        "Internal server error"
    );
});

// ========================================
// 15. START SERVER
// ========================================

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
