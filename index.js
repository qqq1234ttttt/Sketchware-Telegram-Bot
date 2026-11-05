const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 1. Bot အသစ် စာရင်းသွင်းမည့် API
app.post('/api/add-bot', async (req, res) => {
  try {
    const { user_id, bot_name, bot_token } = req.body;
    if (!user_id || !bot_token) return res.status(400).json({ success: false, error: 'Missing fields' });

    const { error } = await supabase.from('bots').insert([{ user_id, bot_name, bot_token }]);
    if (error) throw error;

    res.json({ success: true, message: 'Bot registered successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Command နှင့် Button များကို သိမ်းဆည်းမည့် API
app.post('/api/add-command', async (req, res) => {
  try {
    const { bot_token, command, reply_text, button_text, button_url } = req.body;
    if (!bot_token || !command || !reply_text) return res.status(400).json({ success: false, error: 'Missing fields' });

    const { error } = await supabase.from('bot_commands').insert([{ bot_token, command, reply_text, button_text, button_url }]);
    if (error) throw error;

    res.json({ success: true, message: 'Command saved successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Command စာရင်းများ ထုတ်ယူမည့် API (GET)
app.get('/api/get-commands', async (req, res) => {
  try {
    const { bot_token } = req.query;
    const { data, error } = await supabase.from('bot_commands').select('*').eq('bot_token', bot_token);
    if (error) throw error;
    res.json({ success: true, commands: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Bot စာရင်းများ ထုတ်ယူမည့် API (GET)
app.get('/api/get-bots', async (req, res) => {
  try {
    const { user_id } = req.query;
    const { data, error } = await supabase.from('bots').select('*').eq('user_id', user_id);
    if (error) throw error;
    res.json({ success: true, bots: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Delete Command API
app.delete('/api/delete-command', async (req, res) => {
    try {
        const commandId = req.query.id;
        const { error } = await supabase.from('bot_commands').delete().eq('id', commandId);
        if (error) throw error;
        res.status(200).json({ success: true, message: "Deleted successfully" });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// 6. Telegram Webhook (User ထည့်ထားသည့် ခလုတ်များအတိုင်း Telegram တွင် ပေါ်စေရန်)
app.post('/api/webhook/:bot_token', async (req, res) => {
  try {
    const botToken = req.params.bot_token;
    const update = req.body;

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const userText = update.message.text.trim();

      const { data: commands, error } = await supabase
        .from('bot_commands')
        .select('*')
        .eq('bot_token', botToken)
        .eq('command', userText);

      if (!error && commands && commands.length > 0) {
        const cmdData = commands[0];

        const payload = {
          chat_id: chatId,
          text: cmdData.reply_text
        };

        // App ထဲတွင် User ထည့်ခဲ့သော button_text ကို ယူ၍ Telegram တွင် ခလုတ်အဖြစ် ဖန်တီးခြင်း
        if (cmdData.button_text && cmdData.button_text.trim() !== "") {
          // (","); ဖြင့် ခွဲ၍ ခလုတ်မျိုးစုံ (ဥပမာ - App Unlock, App Lock) ကို အကွက်လိုက် ဖန်တီးပေးခြင်း
          const btnTexts = cmdData.button_text.split(',');
          let keyboardRows = [];
          
          for (let i = 0; i < btnTexts.length; i += 2) {
            let row = [{ text: btnTexts[i].trim(), callback_data: "btn_" + i }];
            if (i + 1 < btnTexts.length) {
              row.push({ text: btnTexts[i + 1].trim(), callback_data: "btn_" + (i + 1) });
            }
            keyboardRows.push(row);
          }

          payload.reply_markup = {
            inline_keyboard: keyboardRows
          };
        }

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
  console.log(`Server running on port ${PORT}`);
});
