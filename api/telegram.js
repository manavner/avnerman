// Telegram Webhook Handler for AvnerFirstBot
// Commands:
//   "היי" / "hi"      → daily briefing
//   "פגישה"           → interactive calendar event creation (multi-step)

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ICAL_URL = process.env.ICAL_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CHAT_ID = "1532243300";
const TRIGGER_WORDS = ["היי", "הי", "hi", "hey", "hello", "שלום", "briefing", "סיכום"];

// ─── Telegram helpers ────────────────────────────────────────────────────────

async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function askWithForceReply(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    }),
  });
}

// ─── State encoded inside the question message itself ────────────────────────
// Format: "...question...\n〔date|time|title〕"  (hidden in last line)

function encodeState(state) {
  return `〔${state.date || ""}|${state.time || ""}|${state.title || ""}〕`;
}

function decodeState(text) {
  const m = text.match(/〔([^|]*)\|([^|]*)\|([^〕]*)〕/);
  if (!m) return {};
  return { date: m[1] || null, time: m[2] || null, title: m[3] || null };
}

function getStep(text) {
  if (text.includes("מה התאריך?")) return "awaiting_date";
  if (text.includes("מה השעה?")) return "awaiting_time";
  if (text.includes("מה הנושא?")) return "awaiting_title";
  if (text.includes("הערות?")) return "awaiting_notes";
  return null;
}

// ─── Google Calendar ─────────────────────────────────────────────────────────

async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  return data.access_token;
}

async function createCalendarEvent(date, time, title, notes) {
  const accessToken = await getAccessToken();

  // Parse date DD/MM or DD/MM/YYYY
  const parts = date.split("/").map(Number);
  const day = parts[0], month = parts[1], year = parts[2] || new Date().getFullYear();

  // Parse time HH:MM
  const [hour, minute] = time.split(":").map(Number);

  // Build start/end (1 hour duration)
  const pad = n => String(n).padStart(2, "0");
  const startStr = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
  const endHour = hour + 1 >= 24 ? 23 : hour + 1;
  const endStr = `${year}-${pad(month)}-${pad(day)}T${pad(endHour)}:${pad(minute)}:00`;

  const event = {
    summary: title,
    description: notes && notes !== "לא" && notes !== "אין" ? notes : "",
    start: { dateTime: startStr, timeZone: "Asia/Jerusalem" },
    end: { dateTime: endStr, timeZone: "Asia/Jerusalem" },
  };

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );
  return res.json();
}

async function verifyEvent(eventId) {
  const accessToken = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.json();
}

// ─── Briefing helpers ────────────────────────────────────────────────────────

async function getWeather() {
  try {
    const res = await fetch("https://wttr.in/Karmiel?format=j1&lang=he");
    const data = await res.json();
    const c = data.current_condition[0];
    const t = data.weather[0];
    return `🌤️ <b>מזג אוויר כרמיאל</b>\n${c.temp_C}°C (מרגיש ${c.FeelsLikeC}°C) • ${c.weatherDesc[0].value}\nמינ': ${t.mintempC}° / מקס': ${t.maxtempC}°`;
  } catch { return "🌤️ <b>מזג אוויר כרמיאל</b>\nלא זמין"; }
}

async function getNews() {
  try {
    const res = await fetch("https://www.ynet.co.il/Integration/StoryRss2.xml", { headers: { "User-Agent": "Mozilla/5.0" } });
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)].slice(1, 11).map(m => `• ${m[1]}`);
    return `📰 <b>חדשות ישראל</b>\n${titles.join("\n")}`;
  } catch { return "📰 <b>חדשות ישראל</b>\nלא זמין"; }
}

async function translateToHebrew(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=he&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(s => s[0]).join("");
  } catch { return text; }
}

async function getAINews() {
  try {
    const res = await fetch("https://techcrunch.com/category/artificial-intelligence/feed/", { headers: { "User-Agent": "Mozilla/5.0" } });
    const xml = await res.text();
    const cdataTitles = [...xml.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)].map(m => m[1]);
    const plainTitles = [...xml.matchAll(/<title>([^<]{10,})<\/title>/g)].map(m => m[1]);
    const raw = (cdataTitles.length > 0 ? cdataTitles : plainTitles)
      .filter(t => !t.includes("TechCrunch")).slice(0, 10)
      .map(t => t.replace(/&amp;/g, "&").replace(/&#8217;/g, "'").replace(/&#8220;/g, '"').replace(/&#8221;/g, '"'));
    const translated = await Promise.all(raw.map(translateToHebrew));
    return `🤖 <b>חדשות AI בעולם</b>\n${translated.map(t => `• ${t}`).join("\n")}`;
  } catch { return "🤖 <b>חדשות AI בעולם</b>\nלא זמין"; }
}

async function getTodayEvents() {
  try {
    const res = await fetch(ICAL_URL);
    const ical = await res.text();
    const israelOffset = 3 * 60;
    const israelNow = new Date(Date.now() + israelOffset * 60000);
    const todayStr = israelNow.toISOString().slice(0, 10).replace(/-/g, "");
    const events = [];
    for (const block of ical.split("BEGIN:VEVENT").slice(1)) {
      const get = name => { const m = block.match(new RegExp(`${name}[^:]*:(.+)`)); return m ? m[1].trim() : null; };
      const summary = get("SUMMARY");
      const dtstart = get("DTSTART");
      if (!summary || !dtstart) continue;
      const dateOnly = dtstart.replace(/T.*/, "").replace(/-/g, "");
      if (dateOnly === todayStr) {
        let timeStr = "";
        if (dtstart.includes("T")) {
          const tp = dtstart.match(/T(\d{2})(\d{2})/);
          if (tp) { let h = parseInt(tp[1]) + 3; if (h >= 24) h -= 24; timeStr = ` 🕐 ${String(h).padStart(2, "0")}:${tp[2]}`; }
        }
        events.push(`• ${summary}${timeStr}`);
      }
    }
    return events.length ? `📅 <b>לוח שנה היום</b>\n${events.join("\n")}` : "📅 <b>לוח שנה היום</b>\nאין אירועים מתוכננים היום";
  } catch { return "📅 <b>לוח שנה היום</b>\nלא זמין"; }
}

// ─── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true, status: "bot running" });

  try {
    const message = req.body?.message;
    if (!message) return res.status(200).json({ ok: true });

    const chatId = message.chat?.id?.toString();
    if (chatId !== CHAT_ID) return res.status(200).json({ ok: true });

    const text = (message.text || "").trim();
    const textLower = text.toLowerCase();
    const replyTo = message.reply_to_message?.text || "";

    // ── Step: handle reply in multi-step flow ──
    const step = getStep(replyTo);
    if (step) {
      const state = decodeState(replyTo);

      if (step === "awaiting_date") {
        await askWithForceReply(chatId,
          `🕐 <b>מה השעה?</b>\n(פורמט: HH:MM, למשל 14:30)\n${encodeState({ ...state, date: text })}`);
        return res.status(200).json({ ok: true });
      }

      if (step === "awaiting_time") {
        await askWithForceReply(chatId,
          `📝 <b>מה הנושא?</b>\n${encodeState({ ...state, time: text })}`);
        return res.status(200).json({ ok: true });
      }

      if (step === "awaiting_title") {
        await askWithForceReply(chatId,
          `✏️ <b>הערות?</b> (או כתוב "אין")\n${encodeState({ ...state, title: text })}`);
        return res.status(200).json({ ok: true });
      }

      if (step === "awaiting_notes") {
        const notes = text;
        const { date, time, title } = state;
        await sendTelegram(chatId, `⏳ יוצר פגישה...\n📅 ${date} 🕐 ${time}\n📝 ${title}`);

        const event = await createCalendarEvent(date, time, title, notes);

        if (event.id) {
          const verified = await verifyEvent(event.id);
          if (verified.id) {
            await sendTelegram(chatId,
              `✅ <b>הפגישה נוצרה ואומתה ביומן!</b>\n\n📝 ${verified.summary}\n📅 ${date} 🕐 ${time}\n${notes !== "אין" && notes !== "לא" ? `✏️ ${notes}` : ""}`);
          } else {
            await sendTelegram(chatId, "⚠️ הפגישה נוצרה אך לא ניתן לאמת — בדוק ביומן.");
          }
        } else {
          await sendTelegram(chatId, `❌ שגיאה ביצירת הפגישה: ${JSON.stringify(event.error || event)}`);
        }
        return res.status(200).json({ ok: true });
      }
    }

    // ── Command: start meeting flow ──
    if (textLower.includes("פגישה") || textLower.includes("meeting")) {
      await askWithForceReply(chatId,
        `📅 <b>מה התאריך?</b>\n(פורמט: DD/MM, למשל 15/05)\n${encodeState({})}`);
      return res.status(200).json({ ok: true });
    }

    // ── Command: daily briefing ──
    const isTrigger = TRIGGER_WORDS.some(w => textLower.includes(w));
    if (isTrigger) {
      await sendTelegram(chatId, "⏳ רגע, אוסף מידע...");
      const [weather, news, aiNews, calendar] = await Promise.all([getWeather(), getNews(), getAINews(), getTodayEvents()]);
      const now = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long", day: "numeric", month: "long" });
      await sendTelegram(chatId, `🌅 <b>בוקר טוב אבנר!</b>\n${now}\n\n${weather}\n\n${calendar}\n\n${news}`);
      await sendTelegram(chatId, aiNews);
    }

  } catch (err) {
    console.error(err);
  }
  return res.status(200).json({ ok: true });
}
