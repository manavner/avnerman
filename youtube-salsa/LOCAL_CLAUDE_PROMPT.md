# Prompt for local Claude Code

Paste everything below the line into Claude Code, run from the `youtube-salsa/` folder
(after `git checkout claude/awesome-mccarthy-tpf9q3`).

---

You are taking over a script that was written and syntax-checked in a cloud sandbox with no
access to Google. It has **never been run against the real YouTube API**. Your job is to run it
on this machine, verify it, and fix what breaks. Reply to me (Avner) in Hebrew; keep code and
comments in English.

## What the script does (`top_salsa.py`)
1. Searches YouTube playlists for: "salsa", "salsa cubana", "salsa clásica", "salsa romántica"
   (up to 200 unique playlists).
2. Reads every video in each playlist; unreadable (private/deleted/blocked) playlists are skipped
   and logged to `run.log`.
3. Ranks songs by number of playlists they appear in, total views as tie-breaker. Versions of
   the same song are merged by normalized (artist, title). Only videos of 2–12 minutes count.
4. Writes the full ranking to `salsa_ranking.csv`.
5. Creates a **private** playlist "Top 60 Salsa" with the top 60 (skipped with `--dry-run`).

## Setup
- Python 3.10+. Create a venv, then `pip install -r requirements.txt`.
- `client_secret.json` (OAuth client, type **Desktop app**) must be in this folder. If it is
  missing, stop and tell me exactly how to create it; do not invent one.
- The Google Cloud project may be shared with my SALSA FLOW DJ project. Do not modify that
  project's key, consent screen or scopes.

## Quota rules (important)
- 10,000 units/day per project, plus roughly 100 `search.list` calls/day in a separate bucket.
- Costs: `playlistItems.list` 1, `videos.list` 1, `playlists.insert` 50, `playlistItems.insert` 50.
- A dry run costs about 2,000 units; creating the playlist costs about 3,050 more.
- Do not run the full script repeatedly. If you need several iterations, first add a small
  on-disk cache (JSON, in `.gitignore`) for search results and playlist contents so reruns
  cost nothing. That change is allowed.

## Steps
1. Run `python top_salsa.py --dry-run`. Watch for API errors (403 quotaExceeded, accessNotConfigured,
   invalid scope, consent-screen problems) and fix them or tell me what to change in the console.
2. Open `salsa_ranking.csv` and review the top ~80 rows for quality problems:
   wrong artist (channel name used instead of artist), non-music or dance-lesson videos,
   the same song split in two rows, or a compilation that slipped through the length filter.
   Improve the heuristics in `norm`, `split_title` and the filters. Show me before/after examples.
3. **Stop and show me the top 60 as a table. Ask for my approval before creating the playlist.**
   Only after I approve, run `python top_salsa.py` for real (creates the private playlist).
4. Report the playlist URL, how many playlists were read vs. skipped, and the quota spent.

## Hard rules
- Never commit or print `client_secret.json`, `token.json`, API keys or `run.log` contents
  containing tokens. They are in `.gitignore`; check `git status` before any commit.
- The playlist must be created as private.
- Do not create more than one playlist per approval.
- Commit code changes to the current branch only when I ask.
