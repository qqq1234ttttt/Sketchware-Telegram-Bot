const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Supabase ချိတ်ဆက်ရန် (Environment Variables သို့မဟုတ် ကိန်းရှင်များမှတစ်ဆင့် ချိတ်ဆက်ရန်)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bngayqhncmsahbmwrdfr.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'YOUR_SERVICE_ROLE_KEY'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Server စတင်လည်ပတ်ခြင်း
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server is running on port ${PORT}`);
});

app.get('/', (req, res) => {
  res.send('Telegram Bot Builder Backend is running!');
});
