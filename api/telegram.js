// Telegram Webhook Handler for AvnerFirstBot
// Commands:
//   "היי" / "hi"      → daily briefing
//   "פגישה"           → interactive calendar event creation (multi-step)
//   "אושו: [שאלה]"   → Osho wisdom via Gemini AI
//   "מתכון: [מאכל]"  → recipe for a specific dish
//   "גימטריה: [מילה/שם]" → calculate gematria and provide interpretation
//   "שבוע"            → upcoming 7 days calendar events

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ICAL_URL = process.env.ICAL_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = "manavner/avnerman";
const GITHUB_FILE = "api/telegram.js";
const CHAT_ID = "1532243300";
const TRIGGER_WORDS = ["היי", "הי", "hi", "hey", "hello", "שלום", "briefing", "סיכום"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Telegram helpers ────────────────────────────────────────────────────────

async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function sendLongTelegram(chatId, text) {
  const MAX = 4000;
  if (text.length <= MAX) { await sendTelegram(chatId, text); return; }
  // Split on paragraph breaks where possible
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf("\n\n", MAX);
    if (cut < 1000) cut = remaining.lastIndexOf("\n", MAX);
    if (cut < 1000) cut = MAX;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  for (const chunk of chunks) await sendTelegram(chatId, chunk);
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

async function getUpcomingWeekEvents() {
  try {
    const res = await fetch(ICAL_URL);
    const ical = await res.text();
    const israelOffset = 3 * 60; // UTC+3 for Israel
    const now = new Date(Date.now() + israelOffset * 60000);
    now.setHours(0, 0, 0, 0); // Start of today

    const sevenDaysLater = new Date(now);
    sevenDaysLater.setDate(now.getDate() + 7);

    const eventsByDay = {};

    for (const block of ical.split("BEGIN:VEVENT").slice(1)) {
      const get = name => { const m = block.match(new RegExp(`${name}[^:]*:(.+)`)); return m ? m[1].trim() : null; };
      const summary = get("SUMMARY");
      const dtstart = get("DTSTART");
      if (!summary || !dtstart) continue;

      let eventDate;
      let timeStr = "";

      if (dtstart.includes("T")) {
        // Date-time event
        const year = parseInt(dtstart.substring(0, 4));
        const month = parseInt(dtstart.substring(4, 6)) - 1;
        const day = parseInt(dtstart.substring(6, 8));
        const hour = parseInt(dtstart.substring(9, 11));
        const minute = parseInt(dtstart.substring(11, 13));

        eventDate = new Date(year, month, day, hour, minute);
        eventDate = new Date(eventDate.getTime() + israelOffset * 60000); // Adjust to Israel time

        const displayHour = String(eventDate.getHours()).padStart(2, "0");
        const displayMinute = String(eventDate.getMinutes()).padStart(2, "0");
        timeStr = ` 🕐 ${displayHour}:${displayMinute}`;
      } else {
        // All-day event
        const year = parseInt(dtstart.substring(0, 4));
        const month = parseInt(dtstart.substring(4, 6)) - 1;
        const day = parseInt(dtstart.substring(6, 8));
        eventDate = new Date(year, month, day);
        eventDate = new Date(eventDate.getTime() + israelOffset * 60000); // Adjust to Israel time
        eventDate.setHours(0, 0, 0, 0); // Normalize for comparison
      }

      // Check if event is within the next 7 days (inclusive of today)
      if (eventDate >= now && eventDate < sevenDaysLater) {
        const dateKey = eventDate.toISOString().slice(0, 10);
        if (!eventsByDay[dateKey]) {
          eventsByDay[dateKey] = [];
        }
        eventsByDay[dateKey].push(`• ${summary}${timeStr}`);
      }
    }

    let result = "📅 <b>אירועים לשבוע הקרוב</b>\n\n";
    const sortedDates = Object.keys(eventsByDay).sort();

    if (sortedDates.length === 0) {
      return "📅 <b>אירועים לשבוע הקרוב</b>\nאין אירועים מתוכננים לשבוע הקרוב.";
    }

    for (const dateKey of sortedDates) {
      const date = new Date(dateKey);
      const options = { weekday: "long", day: "numeric", month: "long" };
      const formattedDate = date.toLocaleString("he-IL", options);
      result += `<b>${formattedDate}:</b>\n${eventsByDay[dateKey].join("\n")}\n\n`;
    }
    return result.trim();
  } catch (e) {
    console.error("getUpcomingWeekEvents error:", e);
    return "📅 <b>אירועים לשבוע הקרוב</b>\nלא זמין";
  }
}


async function getDailyJokes() {
  try {
    const res = await fetch(
      "https://v2.jokeapi.dev/joke/Any?blacklistFlags=nsfw,religious,political,racist,sexist,explicit&type=twopart&amount=2",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const data = await res.json();
    const jokes = data.jokes || [data];
    const translated = await Promise.all(
      jokes.map(async j => {
        const setup = await translateToHebrew(j.setup);
        const delivery = await translateToHebrew(j.delivery);
        return `😄 ${setup}\n🤣 ${delivery}\n\n🔤 <i>${j.setup}\n${j.delivery}</i>`;
      })
    );
    return `😂 <b>בדיחות היום</b>\n\n${translated.join("\n\n───────────\n\n")}`;
  } catch { return ""; }
}

async function getDailyQuote() {
  try {
    const res = await fetch("https://zenquotes.io/api/random", { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    const quote = data[0].q;
    const author = data[0].a;
    const translated = await translateToHebrew(quote);
    return `💡 <b>ציטוט יומי</b>\n<i>"${translated}"</i>\n— ${author}`;
  } catch { return ""; }
}

async function getOshoQuote() {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "תן לי ציטוט אחד קצר ומעורר השראה של אושו (Osho). הציטוט בעברית בלבד. רק הציטוט עצמו, ללא הסבר, ללא מקור, ללא גרשיים." }] }],
          generationConfig: { temperature: 1.0, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const data = await res.json();
    const quote = extractGeminiText(data);
    if (!quote) return "";
    return `🕉️ <b>אושו</b>\n<i>"${quote}"</i>`;
  } catch { return ""; }
}

async function getGmailSummary() {
  try {
    const accessToken = await getAccessToken();
    const query = encodeURIComponent("newer_than:1d -category:promotions -category:social -category:updates -category:forums");
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=10`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const listData = await listRes.json();
    if (!listData.messages || listData.messages.length === 0) {
      return "📧 <b>דואר נכנס (24 שעות)</b>\nאין מיילים חדשים";
    }
    const emails = await Promise.all(
      listData.messages.slice(0, 10).map(async (msg) => {
        const msgRes = await fetch(
          `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const msgData = await msgRes.json();
        const headers = msgData.payload?.headers || [];
        const subject = headers.find(h => h.name === "Subject")?.value || "(ללא נושא)";
        const from = headers.find(h => h.name === "From")?.value || "";
        const fromName = from.replace(/<[^>]+>/, "").trim() || from;
        return `• ${subject} <i>(${fromName})</i>`;
      })
    );
    return `📧 <b>דואר נכנס (24 שעות)</b>\n${emails.join("\n")}`;
  } catch (e) {
    console.error("Gmail error:", e);
    return "📧 <b>דואר נכנס</b>\nלא זמין";
  }
}

// ─── Osho / Gemini ───────────────────────────────────────────────────────────

function extractGeminiText(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => !p.thought).map(p => p.text).join("").trim();
}

async function askOsho(question) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: `אתה מומחה בתורתו של אושו (Osho / Bhagwan Shree Rajneesh).
ענה על שאלות מנקודת מבטו של אושו, בסגנונו — עמוק, פואטי, לעיתים פרדוקסלי, תמיד מעורר מחשבה.
השתמש בתובנות מספריו ושיחותיו. ענה תמיד בעברית, בצורה קולחת ויפה.` }]
        },
        contents: [{ parts: [{ text: question }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
  const data = await res.json();
  const answer = extractGeminiText(data);
  if (!answer) throw new Error("No answer from Gemini");
  return answer;
}

// ─── Gematria ────────────────────────────────────────────────────────────────

const HEBREW_GEMATRIA = {
  'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6, 'ז': 7, 'ח': 8, 'ט': 9,
  'י': 10, 'כ': 20, 'ל': 30, 'מ': 40, 'נ': 50, 'ס': 60, 'ע': 70, 'פ': 80, 'צ': 90,
  'ק': 100, 'ר': 200, 'ש': 300, 'ת': 400,
  'ך': 20, 'ם': 40, 'ן': 50, 'ף': 80, 'ץ': 90
};

function calculateGematria(word) {
  let sum = 0;
  for (const char of word) {
    sum += HEBREW_GEMATRIA[char] || 0;
  }
  return sum;
}

async function getGematriaInterpretation(word, value) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `תן פרשנות קצרה ורוחנית/מיסטית למילה/שם "${word}" שערכה הגימטרי הוא ${value}. התייחס למשמעות המספר ביהדות או בקבלה, וקשר זאת למילה. ענה בעברית בלבד. מקסימום 100 מילים.` }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const data = await res.json();
    const interpretation = extractGeminiText(data);
    if (!interpretation) return "לא נמצאה פרשנות.";
    return interpretation;
  } catch (e) {
    console.error("Gematria interpretation error:", e);
    return "לא נמצאה פרשנות.";
  }
}

// ─── Self-modify via Gemini + GitHub ─────────────────────────────────────────

async function addFeature(description) {
  // 1. Get current code from GitHub
  const fileRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "AvnerBot" } }
  );
  const fileData = await fileRes.json();
  const currentCode = Buffer.from(fileData.content, "base64").toString("utf-8");
  const sha = fileData.sha;

  // 2. Ask Gemini to add the feature
  const gemRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: `אתה מפתח Node.js מומחה. הנה קוד של Telegram bot (Vercel serverless function בעברית):\n\n${currentCode}\n\n---\nהוסף את היכולת הבאה לבוט: ${description}\n\nחשוב:\n- החזר את הקוד המלא המעודכן בלבד\n- אל תוסיף markdown, backticks, או הסברים\n- שמור על כל הפונקציות הקיימות\n- הוסף את הפקודה החדשה לפונקציית עזרה\n- הקוד חייב להתחיל ב: // Telegram Webhook Handler` }]
        }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
  const gemData = await gemRes.json();
  let newCode = extractGeminiText(gemData);

  // Clean up in case Gemini wrapped in markdown
  newCode = newCode.replace(/^```(?:javascript|js)?\n?/i, "").replace(/\n?```$/i, "").trim();

  if (!newCode || !newCode.includes("BOT_TOKEN")) throw new Error("Gemini returned invalid code");

  // 3. Commit to GitHub
  const encoded = Buffer.from(newCode).toString("base64");
  const commitRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "AvnerBot",
      },
      body: JSON.stringify({
        message: `feat: ${description}`,
        content: encoded,
        sha,
      }),
    }
  );
  if (!commitRes.ok) {
    const err = await commitRes.json();
    throw new Error(`GitHub commit failed: ${JSON.stringify(err)}`);
  }
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

    // ── Command: add feature via Gemini ──
    if (/^claude\s*[:\-]\s*/i.test(text)) {
      const description = text.replace(/^claude\s*[:\-]\s*/i, "").trim();
      if (!description) {
        await sendTelegram(chatId, "⚙️ כתוב תיאור היכולת אחרי claude:\nדוגמה: <i>claude: הוסף פקודה שמחזירה בדיחה בספרדית</i>");
        return res.status(200).json({ ok: true });
      }
      await sendTelegram(chatId, `⚙️ <b>מעבד בקשה...</b>\n\n📋 יכולת: ${escapeHtml(description)}\n\n🤖 שולח ל-Gemini לכתיבת הקוד...`);
      try {
        await addFeature(description);
        await sendTelegram(chatId, `✅ <b>הקוד עודכן ב-GitHub!</b>\n\n⏳ Vercel מפרסם עכשיו (כ-30 שניות)...\n\nהיכולת תהיה זמינה בעוד רגע.`);
      } catch (e) {
        console.error("addFeature error:", e);
        await sendTelegram(chatId, `❌ שגיאה: ${escapeHtml(e.message)}`);
      }
      return res.status(200).json({ ok: true });
    }

    // ── Command: help ──
    if (textLower === "עזרה" || textLower === "help" || textLower === "?") {
      await sendTelegram(chatId,
        `🤖 <b>רשימת פקודות הבוט</b>\n\n` +
        `🌅 <b>היי / hi / שלום</b>\nסקירת בוקר מלאה — ציטוטים, מזג אוויר, לוח שנה, מיילים, חדשות ישראל וחדשות AI\n\n` +
        `📅 <b>פגישה</b>\nיצירת אירוע חדש ביומן Google בשלבים\n\n` +
        `🗓️ <b>שבוע</b>\nהצגת כל הפגישות לשבעת הימים הקרובים\n\n` +
        `🕉️ <b>אושו - [שאלה]</b>\nתשובה מעמיקה בסגנון אושו\nדוגמה: <i>אושו - מהי אהבה?</i>\n\n` +
        `🍳 <b>מתכון - [מאכל]</b>\nקבל מתכון למאכל ספציפי\nדוגמה: <i>מתכון - עוגת תפוחים</i>\n\n` +
        `🔢 <b>גימטריה - [מילה/שם]</b>\nחישוב גימטריה ופרשנות למילה או שם בעברית\nדוגמה: <i>גימטריה - אבנר</i>\n\n` +
        `😄 <b>בדיחה</b>\n2 בדיחות אקראיות (עברית + אנגלית)\n\n` +
        `😄 <b>בדיחה - [נושא]</b>\n2 בדיחות על נושא ספציפי\nדוגמה: <i>בדיחה - רופאים</i>\n\n` +
        `⚙️ <b>claude - [תיאור]</b>\nהוספת יכולת חדשה לבוט אוטומטית\nדוגמה: <i>claude - הוסף פקודה שמחזירה מתכון</i>\n\n` +
        `❓ <b>עזרה / help</b>\nהצגת רשימה זו`
      );
      return res.status(200).json({ ok: true });
    }

    // ── Command: Osho question ──
    if (/^אושו\s*[:\-]/u.test(text)) {
      const question = text.replace(/^אושו\s*[:\-]\s*/u, "").trim();
      if (!question) {
        await sendTelegram(chatId, "🙏 כתוב את שאלתך אחרי \"אושו:\"");
        return res.status(200).json({ ok: true });
      }
      await sendTelegram(chatId, "🙏 רגע, מתחבר לחוכמת אושו...");
      try {
        const answer = await askOsho(question);
        await sendLongTelegram(chatId, `🕉️ <b>אושו:</b>\n\n${escapeHtml(answer)}`);
      } catch (e) {
        await sendTelegram(chatId, "❌ שגיאה בחיבור ל-Gemini");
        console.error("Osho error:", e);
      }
      return res.status(200).json({ ok: true });
    }

    // ── Command: Recipe ──
    if (/^מתכון\s*[:\-]/u.test(text)) {
      const dish = text.replace(/^מתכון\s*[:\-]\s*/u, "").trim();
      if (!dish) {
        await sendTelegram(chatId, "🍳 כתוב את המאכל שאתה רוצה מתכון עבורו אחרי \"מתכון:\", לדוגמה: <i>מתכון - עוגת תפוחים</i>");
        return res.status(200).json({ ok: true });
      }
      await sendTelegram(chatId, `⏳ מחפש מתכון ל${escapeHtml(dish)}...`);
      try {
        const gemRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `תן לי מתכון מפורט בעברית עבור ${dish}. המתכון צריך לכלול רשימת מרכיבים והוראות הכנה מפורטות. השתמש בפורמט קריא וברור.` }] }],
              generationConfig: { temperature: 0.7, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
            }),
          }
        );
        const gemData = await gemRes.json();
        const recipe = extractGeminiText(gemData);
        if (!recipe) throw new Error("No recipe from Gemini");
        await sendLongTelegram(chatId, `🍳 <b>מתכון ל${escapeHtml(dish)}:</b>\n\n${escapeHtml(recipe)}`);
      } catch (e) {
        await sendTelegram(chatId, "❌ שגיאה בקבלת המתכון. נסה שוב מאוחר יותר.");
        console.error("Recipe error:", e);
      }
      return res.status(200).json({ ok: true });
    }

    // ── Command: Gematria ──
    if (/^גימטריה\s*[:\-]/u.test(text)) {
      const word = text.replace(/^גימטריה\s*[:\-]\s*/u, "").trim();
      if (!word) {
        await sendTelegram(chatId, "🔢 כתוב מילה או שם אחרי \"גימטריה:\", לדוגמה: <i>גימטריה - שלום</i>");
        return res.status(200).json({ ok: true });
      }
      await sendTelegram(chatId, `⏳ מחשב גימטריה עבור "${escapeHtml(word)}"...`);
      try {
        const gematriaValue = calculateGematria(word);
        if (gematriaValue === 0) {
          await sendTelegram(chatId, `❌ המילה "${escapeHtml(word)}" אינה מכילה אותיות עבריות לחישוב גימטריה.`);
          return res.status(200).json({ ok: true });
        }
        const interpretation = await getGematriaInterpretation(word, gematriaValue);
        await sendLongTelegram(chatId,
          `🔢 <b>גימטריה עבור "${escapeHtml(word)}"</b>\n\n` +
          `הערך הגימטרי הוא: <b>${gematriaValue}</b>\n\n` +
          `<b>פרשנות:</b>\n${escapeHtml(interpretation)}`
        );
      } catch (e) {
        await sendTelegram(chatId, "❌ שגיאה בחישוב גימטריה או בקבלת פרשנות.");
        console.error("Gematria error:", e);
      }
      return res.status(200).json({ ok: true });
    }

    // ── Command: jokes ──
    if (textLower.includes("בדיחה") || textLower.includes("joke")) {
      const topic = text.match(/^בדיחה\s*[:\-]\s*(.+)/u)?.[1]?.trim() || text.match(/^joke\s*[:\-]\s*(.+)/i)?.[1]?.trim();
      try {
        if (topic) {
          // Topic-specific joke via Gemini
          const gemRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `ספר לי 2 בדיחות מצחיקות בעברית על הנושא: ${topic}. עבור כל בדיחה: שורה ראשונה היא ההקדמה, שורה שנייה היא הפאנץ' ליין. הפרד בין הבדיחות בשורה ריקה. רק הבדיחות, ללא כותרות או הסברים.` }] }],
                generationConfig: { temperature: 1.0, maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } },
              }),
            }
          );
          const gemData = await gemRes.json();
          const jokeText = escapeHtml(extractGeminiText(gemData));
          await sendLongTelegram(chatId, `😄 <b>בדיחות על ${escapeHtml(topic)}:</b>\n\n${jokeText}`);
        } else {
          // 2 random jokes via JokeAPI
          const jokeRes = await fetch(
            "https://v2.jokeapi.dev/joke/Any?blacklistFlags=nsfw,religious,political,racist,sexist,explicit&type=twopart&amount=2",
            { headers: { "User-Agent": "Mozilla/5.0" } }
          );
          const jokeData = await jokeRes.json();
          const jokes = jokeData.jokes || [jokeData];
          const translated = await Promise.all(
            jokes.map(async j => {
              const setup = await translateToHebrew(j.setup);
              const delivery = await translateToHebrew(j.delivery);
              return `😄 ${setup}\n🤣 ${delivery}\n\n🔤 <i>${j.setup}\n${j.delivery}</i>`;
            })
          );
          await sendTelegram(chatId, translated.join("\n\n───────────\n\n"));
        }
      } catch {
        await sendTelegram(chatId, "😅 לא הצלחתי למצוא בדיחה כרגע...");
      }
      return res.status(200).json({ ok: true });
    }

    // ── Command: start meeting flow ──
    if (textLower.includes("פגישה") || textLower.includes("meeting")) {
      await askWithForceReply(chatId,
        `📅 <b>מה התאריך?</b>\n(פורמט: DD/MM, למשל 15/05)\n${encodeState({})}`);
      return res.status(200).json({ ok: true });
    }

    // ── Command: upcoming week events ──
    if (textLower === "שבוע") {
      await sendTelegram(chatId, "⏳ אוסף את הפגישות לשבוע הקרוב...");
      const weekEvents = await getUpcomingWeekEvents();
      await sendLongTelegram(chatId, weekEvents);
      return res.status(200).json({ ok: true });
    }

    // ── Command: daily briefing ──
    const isTrigger = TRIGGER_WORDS.some(w => textLower.includes(w));
    if (isTrigger) {
      await sendTelegram(chatId, "⏳ רגע, אוסף מידע...");
      const [weather, news, aiNews, calendar, gmail, quote, oshoQuote, jokes] = await Promise.all([getWeather(), getNews(), getAINews(), getTodayEvents(), getGmailSummary(), getDailyQuote(), getOshoQuote(), getDailyJokes()]);
      const now = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long", day: "numeric", month: "long" });
      await sendTelegram(chatId, `🌅 <b>בוקר טוב אבנר!</b>\n${now}\n\n${quote}\n\n${oshoQuote}\n\n${jokes}\n\n${weather}\n\n${calendar}\n\n${gmail}`);
      await sendTelegram(chatId, news);
      await sendTelegram(chatId, aiNews);
    } else {
      await sendTelegram(chatId, `❓ הנחיה לא מובנת\n\nכתוב <b>עזרה</b> לרשימת הפקודות`);
    }

  } catch (err) {
    console.error(err);
  }
  return res.status(200).json({ ok: true });
}