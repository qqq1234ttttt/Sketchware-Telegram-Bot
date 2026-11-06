// 6. Telegram Webhook (Menu Bar အောက်ခြေမှာ မဖြစ်မနေ ပေါ်စေရန် အသေအချာ ပြင်ဆင်ထားသော Webhook)
app.post('/api/webhook/:bot_token', async (req, res) => {
  try {
    const botToken = req.params.bot_token;
    const update = req.body;

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const userText = update.message.text.trim();

      // Supabase မှ ဤ Bot Token နှင့်ဆိုင်သော Commands အားလုံးကို ဆွဲထုတ်မည်
      const { data: allCommands, error: fetchError } = await supabase
        .from('bot_commands')
        .select('*')
        .eq('bot_token', botToken);

      if (!fetchError && allCommands && allCommands.length > 0) {
        // User ပို့လိုက်သော စာသားနှင့် ကိုက်ညီသော Command ကို ရှာမည်
        const matchedCmd = allCommands.find(c => c.command && c.command.trim().toLowerCase() === userText.toLowerCase());

        let replyText = "ရွေးချယ်စရာ Menu များ။";
        if (matchedCmd && matchedCmd.reply_text) {
          replyText = matchedCmd.reply_text;
        } else if (userText.toLowerCase() === "/start") {
          // အကယ်၍ /start ပို့ပြီး database ထဲတွင် သီးသန့်မတွေ့ပါက ပထမဆုံး reply ကို ယူမည်
          const startCmd = allCommands.find(c => c.command && c.command.trim() === "/start");
          replyText = startCmd ? startCmd.reply_text : "မင်္ဂလာပါ! ကျေးဇူးပြု၍ အောက်ပါ Menuများကို ရွေးချယ်ပါ။";
        } else {
          replyText = "သင့်တောင်းဆိုချက်ကို လက်ခံရရှိပါပြီ။";
        }

        let replyPayload = {
          chat_id: chatId,
          text: replyText
        };

        // Database ထဲတွင်ရှိသော /start မဟုတ်သည့် အခြား Menu အားလုံးကို အောက်ခြေ Keyboard ခလုတ်များအဖြစ် ဖန်တီးမည်
        const menuButtons = [];
        let currentRow = [];

        allCommands.forEach(c => {
          if (c.command && c.command.trim() !== "/start") {
            currentRow.push({ text: c.command.trim() });
            if (currentRow.length === 2) { // တစ်တန်းလျှင် ခလုတ် ၂ ခုစီပြမည်
              menuButtons.push(currentRow);
              currentRow = [];
            }
          }
        });

        if (currentRow.length > 0) {
          menuButtons.push(currentRow);
        }

        // Menu ခလုတ်များ ရှိနေပါက မည်သည့်စာာသား ပို့သည်ဖြစ်စေ အောက်ခြေတွင် Menu Bar အမြဲပေါ်နေစေရန် ထည့်မည်
        if (menuButtons.length > 0) {
          replyPayload.reply_markup = {
            keyboard: menuButtons,
            resize_keyboard: true,
            is_persistent: true
          };
        }

        // Telegram သို့ API ဖြင့် မက်ဆေ့ခ်ျနှင့် Keyboard ပို့မည်
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, replyPayload);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook Error:", err.message);
    res.sendStatus(500);
  }
});
