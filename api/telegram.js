// Telegram Webhook Handler for AvnerFirstBot
// Deployed on Vercel as serverless function
// Commands:
//   "היי" / "hi"          → daily briefing (weather + news + AI + calendar)
//   "הוסף פגישה ..."      → add calendar event (requires Google API credentials)

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ICAL_URL = process.env.ICAL_URL;
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

async function translateToHebrew(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=he&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(s => s[0]).join("");
  } catch {
    return text;
  }
}

async function getAINews() {
  try {
    const res = await fetch(
      "https://techcrunch.com/category/artificial-intelligence/feed/",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const xml = await res.text();
    const cdataTitles = [...xml.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)].map(m => m[1]);
    const plainTitles = [...xml.matchAll(/<title>([^<]{10,})<\/title>/g)].map(m => m[1]);
    const raw = cdataTitles.length > 0 ? cdataTitles : plainTitles;
    const englishTitles = raw
      .filter(t => !t.includes("TechCrunch"))
      .slice(0, 3)
      .map(t => t.replace(/&amp;/g, "&").replace(/&#8217;/g, "'").replace(/&#8220;/g, '"').replace(/&#8221;/g, '"'));
    const hebrewTitles = await Promise.all(englishTitles.map(translateToHebrew));
    return `🤖 <b>חדשות AI בעולם</b>\n${hebrewTitles.map(t => `• ${t}`).join("\n")}`;
  } catch {
    return "🤖 <b>חדשות AI בעולם</b>\nלא זמין כרגע";
  }
}

// Parse iCal format and return today's events (Israel timezone)
async function getTodayEvents() {
  try {
    const res = await fetch(ICAL_URL);
    const ical = await res.text();

    // Get today's date range in Israel timezone
    const now = new Date();
    const israelOffset = 3 * 60; // UTC+3 (IDT)
    const israelNow = new Date(now.getTime() + israelOffset * 60000);
    const todayStr = israelNow.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD

    const events = [];
    const blocks = ical.split("BEGIN:VEVENT");
    blocks.shift(); // remove header

    for (const block of blocks) {
      const getField = (name) => {
        const match = block.match(new RegExp(`${name}[^:]*:(.+)`));
        return match ? match[1].trim().replace(/\\n/g, "\n").replace(/\\,/g, ",") : null;
      };

      const summary = getField("SUMMARY");
      const dtstart = getField("DTSTART");
      if (!summary || !dtstart) continue;

      // Extract date part (handles both DATE and DATETIME formats)
      const dateOnly = dtstart.replace(/T.*/, "").replace(/-/g, "");

      if (dateOnly === todayStr) {
        // Format time if available
        let timeStr = "";
        if (dtstart.includes("T")) {
          const timePart = dtstart.match(/T(\d{2})(\d{2})/);
          if (timePart) {
            // Convert UTC to Israel time (+3)
            let hour = parseInt(timePart[1]) + 3;
            const min = timePart[2];
            if (hour >= 24) hour -= 24;
            timeStr = ` 🕐 ${String(hour).padStart(2, "0")}:${min}`;
          }
        }
        events.push(`• ${summary}${timeStr}`);
      }
    }

    if (events.length === 0) return "📅 <b>לוח שנה היום</b>\nאין אירועים מתוכננים היום";
    return `📅 <b>לוח שנה היום</b>\n${events.join("\n")}`;
  } catch (e) {
    return "📅 <b>לוח שנה היום</b>\nלא זמין כרגע";
  }
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
    const text = (message.text || "").trim();
    const textLower = text.toLowerCase();

    // Security: only respond to Avner's chat
    if (chatId !== CHAT_ID) return res.status(200).json({ ok: true });

    // --- Command: daily briefing ---
    const isTrigger = TRIGGER_WORDS.some((w) => textLower.includes(w.toLowerCase()));

    if (isTrigger) {
      await sendTelegram(chatId, "⏳ רגע, אוסף מידע...");

      const [weather, news, aiNews, calendar] = await Promise.all([
        getWeather(),
        getNews(),
        getAINews(),
        getTodayEvents(),
      ]);

      const now = new Date().toLocaleString("he-IL", {
        timeZone: "Asia/Jerusalem",
        weekday: "long",
        day: "numeric",
        month: "long",
      });

      // Message 1: header + weather + calendar + news
      await sendTelegram(chatId, `🌅 <b>בוקר טוב אבנר!</b>\n${now}\n\n${weather}\n\n${calendar}\n\n${news}`);

      // Message 2: AI news
      await sendTelegram(chatId, aiNews);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: true });
  }
}
