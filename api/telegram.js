// Telegram Webhook Handler for AvnerFirstBot
// Deployed on Vercel as serverless function
// Responds to "היי" / "hi" / "hey" with daily briefing

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = "1532243300";
const TRIGGER_WORDS = ["היי", "הי", "hi", "hey", "hello", "שלום", "briefing", "סיכום"];

async function sendTelegram(chatId, text) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    }
  );
  return res.json();
}

async function getWeather() {
  try {
    const res = await fetch("https://wttr.in/Karmiel?format=j1&lang=he");
    const data = await res.json();
    const current = data.current_condition[0];
    const temp = current.temp_C;
    const feels = current.FeelsLikeC;
    const desc = current.weatherDesc[0].value;
    const today = data.weather[0];
    const maxT = today.maxtempC;
    const minT = today.mintempC;
    return `🌤️ <b>מזג אוויר כרמיאל</b>\n${temp}°C (מרגיש ${feels}°C) • ${desc}\nמינ': ${minT}° / מקס': ${maxT}°`;
  } catch {
    return "🌤️ <b>מזג אוויר כרמיאל</b>\nלא זמין כרגע";
  }
}

async function getNews() {
  try {
    // Ynet RSS - Israeli news
    const res = await fetch(
      "https://www.ynet.co.il/Integration/StoryRss2.xml",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)]
      .slice(1, 5)
      .map((m) => `• ${m[1]}`);
    return `📰 <b>חדשות ישראל</b>\n${titles.join("\n")}`;
  } catch {
    return "📰 <b>חדשות ישראל</b>\nלא זמין כרגע";
  }
}

async function getAINews() {
  try {
    // TechCrunch AI RSS
    const res = await fetch(
      "https://techcrunch.com/category/artificial-intelligence/feed/",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)]
      .slice(1, 4)
      .map((m) => `• ${m[1]}`);
    return `🤖 <b>חדשות AI בעולם</b>\n${titles.join("\n")}`;
  } catch {
    return "🤖 <b>חדשות AI בעולם</b>\nלא זמין כרגע";
  }
}

async function buildBriefing() {
  const [weather, news, aiNews] = await Promise.all([
    getWeather(),
    getNews(),
    getAINews(),
  ]);

  const now = new Date().toLocaleString("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return `🌅 <b>בוקר טוב אבנר!</b>\n${now}\n\n${weather}\n\n${news}\n\n${aiNews}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, status: "bot running" });
  }

  try {
    const body = req.body;
    const message = body?.message;

    if (!message) return res.status(200).json({ ok: true });

    const chatId = message.chat?.id?.toString();
    const text = (message.text || "").toLowerCase().trim();

    // Security: only respond to Avner's chat
    if (chatId !== CHAT_ID) {
      return res.status(200).json({ ok: true });
    }

    const isTrigger = TRIGGER_WORDS.some((w) =>
      text.includes(w.toLowerCase())
    );

    if (isTrigger) {
      // Send "loading" message immediately
      await sendTelegram(chatId, "⏳ רגע, אוסף מידע...");

      // Build and send briefing
      const briefing = await buildBriefing();
      await sendTelegram(chatId, briefing);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: true });
  }
}
