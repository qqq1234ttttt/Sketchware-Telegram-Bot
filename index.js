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
    if (!user_id || !bot_token) {
      return res.status(400).json({ success: false, error: 'Missing fields: user_id or bot_token' });
    }

    const { error } = await supabase.from('bots').insert([{ user_id, bot_name, bot_token }]);
    if (error) throw error;

    res.json({ success: true, message: 'Bot registered successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Bot စာရင်းများ ထုတ်ယူမည့် API (MainActivity အတွက် အရေးကြီးသည် - မူလက မပါဝင်ပါ)
app.get('/api/get-bots', async (req, res) => {
  try {
    const { user_id } = req.query;
    
    let query = supabase.from('bots').select('*');
    if (user_id && user_id !== "default_user") {
      query = query.eq('user_id', user_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, bots: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Command / Menu / Start များကို သိမ်းဆည်းမည့် API (Error 400 ကာကွယ်ရန်)
app.post('/api/add-command', async (req, res) => {
  try {
    const { bot_token, start_welcome, menu_name, menu_reply, command, reply_text } = req.body;
    
    if (!bot_token) {
      return res.status(400).json({ success: false, error: 'Bot token is missing' });
    }

    let finalCommand = "";
    let finalReply = "";

    // /start သီးသန့် (သို့) Menu သီးသန့် ခွဲခြားလက်ခံခြင်း
    if (start_welcome && start_welcome.trim() !== "") {
      finalCommand = "/start";
      finalReply = start_welcome;
    } else if (menu_name && menu_reply) {
      finalCommand = menu_name;
      finalReply = menu_reply;
    } else if (command && reply_text) {
      finalCommand = command;
      finalReply = reply_text;
    } else {
      return res.status(400).json({ success: false, error: 'Invalid data fields provided' });
    }

    // Supabase table ('bot_commands') ထဲသို့ ထည့်သွင်းခြင်း
    const { error } = await supabase.from('bot_commands').insert([{ 
      bot_token: bot_token, 
      command: finalCommand, 
      reply_text: finalReply,
      button_text: "", 
      button_url: "",
      menu_keyboard: "" 
    }]);

    if (error) throw error;

    res.json({ success: true, message: 'Saved successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Command စာရင်းများ ထုတ်ယူမည့် API (GET)
app.get('/api/get-commands', async (req, res) => {
  try {
    const { bot_token } = req.query;
    if (!bot_token) {
      return res.status(400).json({ success: false, error: 'Bot token is missing' });
    }

    const { data, error } = await supabase.from('bot_commands').select('*').eq('bot_token', bot_token);
    if (error) throw error;
    
    res.json({ success: true, commands: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Telegram Webhook (Persistent Menu / Start စနစ်အတွက်)
app.post('/api/webhook/:bot_token', async (req, res) => {
  try {
    const botToken = req.params.bot_token;
    const update = req.body;

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const userText = update.message.text.trim();

      // User ရိုက်လိုက်သော (သို့) နှိပ်လိုက်သော စာသားနှင့် တိုက်ဆိုင်သော command/menu ကို ရှာမည်
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
