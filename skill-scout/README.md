# Skill Scout 🔭

<div dir="rtl">

כלי שמוצא, בודק מבחינת אבטחה ומתקין את ה-**Skills**, ה-**Plugins** ושרתי ה-**MCP** המומלצים ביותר עבור **Claude Code** ו-**Codex**.

## מה הכלי עושה

| יכולת | איך |
|---|---|
| 🏆 **הכי מומלצים** | קטלוג נבחר של כ-35 פריטים מספקים רשמיים ומהקהילה, עם דירוג המלצה. עם `--live` מתווספים כוכבי GitHub והורדות npm בזמן אמת |
| 🎯 **המלצה לפרויקט** | סורק את תיקיית הפרויקט (package.json, requirements.txt, vercel.json ועוד) או תיאור חופשי **גם בעברית**, וממליץ מה מתאים ולמה |
| 🛡️ **בטיחות** | לכל פריט: למה יש לו גישה, מה הסיכונים, איך להשתמש בו בבטחה, ואירועי אבטחה ידועים (CVE) |
| ⚠️ **אזהרות משתמשים** | עם `--live`: בודק issues ב-GitHub שמזכירים בעיות אבטחה, advisories שפורסמו, ופגיעויות ידועות מ-OSV.dev |
| 🔍 **סורק Skills** | לפני כל התקנה של Skill הקבצים נסרקים: prompt injection, טקסט נסתר, `curl \| bash`, גישה למפתחות SSH, שליחת מידע החוצה ועוד |
| 🚫 **רשימה שחורה** | חבילות זדוניות ידועות (למשל `postmark-mcp`) נחסמות. פריטים שהוצאו משימוש (deprecated) מסומנים AVOID |
| ⚡ **התקנה קלה** | פקודה אחת מתקינה ל-Claude Code, ל-Codex או לשניהם. הכלי מציג את הסיכונים ומבקש אישור. **סודות (API keys) לא נשמרים בקבצים**: הקונפיגורציה רק מפנה למשתני סביבה |
| 🖥️ **ממשק ויזואלי** | לוח בקרה בדפדפן (`skill-scout ui`) |
| 🤖 **שאלה ישירה לסוכן** | אחרי `skill-scout setup`, בכל פרויקט עתידי אפשר לשאול את Claude Code או את Codex: *"אילו skills כדאי להתקין לפרויקט הזה?"* |

## התקנה (פעם אחת)

צריך Node.js 18 ומעלה ו-git.

</div>

```bash
cd skill-scout
npm link            # makes the `skill-scout` command available everywhere
skill-scout setup   # installs the "skill-advisor" skill into Claude Code + Codex
```

<div dir="rtl">

רשות: להגדלת מכסת הבקשות ל-GitHub, מגדירים טוקן (קריאה בלבד מספיקה): `export GITHUB_TOKEN=...`

## שימוש יומיומי

</div>

```bash
skill-scout recommend                      # what should I install for the project in this folder?
skill-scout recommend --describe "אתר חנות עם תשלומים"   # for a project that doesn't exist yet
skill-scout top --live                     # best-rated overall, with live stars/downloads
skill-scout top --type skill --for codex   # only skills, only for Codex
skill-scout search database                # catalog + official MCP registry
skill-scout info github                    # risks, warnings, user reports for one item
skill-scout check npm:some-mcp-package     # audit ANY npm package
skill-scout check github:owner/repo/skills/x   # download + scan a skill without installing it
skill-scout install playwright --dry-run   # show exactly what would change
skill-scout install playwright             # install for Claude Code + Codex (asks first)
skill-scout install context7 --for claude --scope project   # only this project, only Claude Code
skill-scout installed                      # what's already installed
skill-scout ui                             # web dashboard
```

<div dir="rtl">

## 🧹 ניהול מה שמותקן: הסרה והסגר (Quarantine)

</div>

```bash
skill-scout installed                  # everything installed + its risk level, riskiest first
skill-scout audit --fix                # go over HIGH-risk items one by one: [q]uarantine / [d]elete / [s]kip
skill-scout remove last30days          # quarantine one item (asks first)
skill-scout remove last30days --delete # delete permanently
skill-scout remove github --for codex  # only the Codex copy
skill-scout trust graphify --note "defensive code"   # reviewed → stop warning (until it changes)
skill-scout trusted                    # list trusted items
skill-scout untrust graphify           # warn about it again
skill-scout quarantine                 # what is in quarantine
skill-scout restore last30days         # put it back
```

<div dir="rtl">

* **אמון (Trust):** אחרי שבדקת פריט והחלטת שהוא בסדר (למשל graphify, שההתראות עליו הן קוד הגנה), סמן אותו כ"נבדק". מאותו רגע הוא לא יופיע כ-HIGH ולא יתריע בסריקה השבועית. **האמון קשור לתוכן המדויק:** אם הקבצים של ה-Skill או ההגדרות של השרת ישתנו, למשל בעדכון זדוני, ההתראה תחזור מיד עם ההערה "CHANGED since you trusted it".
* **הסגר (ברירת המחדל):** הפריט עובר לתיקייה `%USERPROFILE%\.skill-scout\quarantine\`, ואפשר להחזיר אותו בפקודה אחת. זו הדרך הבטוחה.
* **מחיקה (`--delete`):** מחיקה לצמיתות.
* **מה נתמך:** Skills ושרתי MCP ב-Claude Code (ברמת המשתמש, הפרויקט וה-local) וב-Codex (ברמת המשתמש והפרויקט). שאר ההגדרות בקבצי הקונפיגורציה לא משתנות, ולפני כל שינוי נשמר גיבוי.
* **Plugins של Claude Code** מוסרים מתוך Claude Code עם `/plugin`.
* **תווית "official – powerful by design":** פריט רשמי שמסומן HIGH בגלל ההרשאות הרחבות שלו, לא כי הוא זדוני. השאר אותו אם אתה משתמש בו.
* גם בדשבורד, בלשונית **Installed**, יש כפתורים **Quarantine**, **Delete** ו-**Restore**.
* אחרי הסרה צריך להפעיל מחדש את Claude Code או את Codex.

## 🗓️ סריקה שבועית אוטומטית (Windows)

</div>

```bash
skill-scout scan                           # run once now (creates the baseline, 1-2 minutes)
skill-scout schedule                       # every Sunday 10:00 (Windows Task Scheduler)
skill-scout schedule --day FRI --time 19:00   # or choose day/time
skill-scout schedule --status              # is it scheduled?
skill-scout schedule --remove              # stop it
skill-scout news                           # show the latest report
```

<div dir="rtl">

**מה הסריקה בודקת** (בכל פעם, לעומת הסריקה הקודמת):

1. ⚠️ **אבטחה של מה שכבר מותקן אצלך:** פגיעויות חדשות, התראות אבטחה ודיווחי משתמשים חדשים. בנוסף, כל Skill מותקן נסרק מחדש, והכלי מתריע אם הקבצים שלו השתנו.
2. 🆕 **חדשים במאגר ה-MCP הרשמי:** מוצגים רק שרתים עם ריפוזיטורי ב-GitHub ולפחות 20 כוכבים, כי רוב הרשומות במאגר הן "רעש".
3. 🌱 **ריפוזיטוריז חדשים ב-GitHub** של Skills ושל MCP.
4. 📈 **במגמת עלייה:** פרויקטים שצברו הרבה כוכבים מאז הסריקה הקודמת.

**התוצאה:**
* התראה של Windows בפינת המסך. אם יש התראת אבטחה והתראה לא מוצגת, הדוח נפתח ב-Notepad.
* דוח שנשמר ב-`%USERPROFILE%\.skill-scout\reports\`.
* לשונית **"What's new"** בדשבורד, עם כפתור "Scan now".

**כדאי לדעת:**
* המשימה רצה רק כשאתה מחובר למחשב. אם המחשב היה כבוי בזמן המתוכנן, היא תרוץ ברגע שהוא יידלק.
* מומלץ להגדיר `GITHUB_TOKEN` כמשתנה סביבה קבוע של Windows (לחיצה על Win, חיפוש "environment variables"). בלי טוקן, GitHub מאט את הבקשות והסריקה איטית יותר.
* אם תזיז את התיקייה `skill-scout` למקום אחר, הרץ שוב `skill-scout schedule`.

### מה המשמעות של רמות הסיכון

- **LOW**: הוראות בלבד, או כלי לקריאה בלבד מספק אמין.
- **MEDIUM**: גישה לדפדפן, לקבצים או לחשבון ענן. סביר לשימוש אם עובדים לפי ההמלצות.
- **HIGH**: גישה לכסף (Stripe), למסדי נתונים, לכל הריפוזיטוריז או ל-shell. להתקין רק עם הרשאות מצומצמות, ועדיף בסביבת פיתוח.
- **BLOCKED / AVOID**: זדוני או לא מתוחזק. הכלי מסרב להתקין.

### איפה דברים נשמרים

| | Claude Code | Codex |
|---|---|---|
| MCP לכל הפרויקטים | `claude mcp add -s user` (בקובץ `~/.claude.json`) | `~/.codex/config.toml` |
| MCP לפרויקט אחד | `.mcp.json` | `.codex/config.toml` |
| Skills לכל הפרויקטים | `~/.claude/skills/` | `~/.codex/skills/` |
| Skills לפרויקט אחד | `.claude/skills/` | `.agents/skills/` |
| Plugins | מודפסות פקודות `/plugin ...` להרצה בתוך Claude Code | מותקנים ה-skills המקבילים |

לפני כל שינוי בקובץ קונפיגורציה נשמר גיבוי בשם `*.bak-skill-scout`.

### עדכון הקטלוג

הקטלוג נמצא ב-`data/catalog.json`. לכל פריט יש תגיות, הוראות התקנה ופרק `security` (הרשאות, סיכונים, דרכי הגנה ואזהרות). אפשר להוסיף פריטים ידנית, או לבקש מ-Claude: *"הוסף את X לקטלוג של skill-scout עם בדיקת אבטחה"*.

### מגבלות, ביושר

- הסריקה הסטטית מזהה תבניות מוכרות ולא כל התקפה אפשרית. כדאי לקרוא את `SKILL.md` לפני שסומכים על Skill מהקהילה.
- "הכי מומלץ" מבוסס על דירוג הקטלוג ועל כוכבים והורדות. אלה סימנים טובים, אבל לא ערובה.
- נתונים חיים (`--live`) דורשים אינטרנט. תוצאות נשמרות במטמון ל-24 שעות בתיקייה `~/.skill-scout/`.

## בדיקות

</div>

```bash
npm test
```
