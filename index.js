const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());

// Supabase Connection (Render Environment Variables မှ ချိတ်ဆက်မည်)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 1. Bot အသစ် စာရင်းသွင်းမည့် API (Sketchware မှ လှမ်းခေါ်မည်)
app.post('/api/add-bot', async (req, res) => {
  try {
    const { user_id, bot_name, bot_token } = req.body;

    if (!user_id || !bot_token) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const { data, error } = await supabase
      .from('bots')
      .insert([{ user_id, bot_name, bot_token }]);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, message: 'Bot registered successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Command နှင့် Inline Button အသစ် သိမ်းဆည်းမည့် API
app.post('/api/add-command', async (req, res) => {
  try {
    const { bot_token, command, reply_text, button_text, button_url } = req.body;

    if (!bot_token || !command || !reply_text) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const { data, error } = await supabase
      .from('bot_commands')
      .insert([{ bot_token, command, reply_text, button_text, button_url }]);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, message: 'Command and Button saved successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Bot တစ်ခုချင်းစီ၏ Command စာရင်းများကို ထုတ်ယူမည့် API (GET)
app.get('/api/get-commands', async (req, res) => {
  try {
    const { bot_token } = req.query;

    const { data, error } = await supabase
      .from('bot_commands')
      .select('*')
      .eq('bot_token', bot_token);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, commands: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. User ရဲ့ Bot စာရင်းများ ထုတ်ယူမည့် API (GET)
app.get('/api/get-bots', async (req, res) => {
  try {
    const { user_id } = req.query;

    const { data, error } = await supabase
      .from('bots')
      .select('*')
      .eq('user_id', user_id);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, bots: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Telegram Webhook (Telegram ထဲမှ User စာပို့လာပါက ဤနေရာသို့ ဝင်ရောက်မည်)
app.post('/api/webhook/:bot_token', async (req, res) => {
  try {
    const botToken = req.params.bot_token;
    const update = req.body;

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const userText = update.message.text.trim();

      // Supabase တွင် အဆိုပါ Bot Token နှင့် User ပို့လိုက်သော Command တိုက်ဆိုင်မှုရှိမရှိ ရှာမည်
      const { data: commands, error } = await supabase
        .from('bot_commands')
        .select('*')
        .eq('bot_token', botToken)
        .eq('command', userText);

      if (!error && commands && commands.length > 0) {
        const cmdData = commands[0];

        // Telegram သို့ ပြန်မည့် Payload တည်ဆောက်ခြင်း
        const payload = {
          chat_id: chatId,
          text: cmdData.reply_text
        };

        // အကယ်၍ Inline Button ထည့်ထားခဲ့လျှင် တွဲ၍ ပို့မည်
        if (cmdData.button_text && cmdData.button_url) {
          payload.reply_markup = {
            inline_keyboard: [
              [
                { text: cmdData.button_text, url: cmdData.button_url }
              ]
            ]
          };
        }

        // Telegram API သို့ Message လှမ်းပို့ခြင်း
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, payload);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook Error:", err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Telegram Bot Builder Server running on port ${PORT}`);
});
