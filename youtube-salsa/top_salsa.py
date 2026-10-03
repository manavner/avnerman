#!/usr/bin/env python3
"""Build a private YouTube playlist "AVNER <Topic> <creation date>" from the 60 most-listed songs of a genre.

1. Search playlists for the topic's queries (up to 200 unique), optionally only those created
   in the last N years.
2. Read every playlist's videos (private/deleted/blocked playlists are skipped and logged).
3. Rank songs by number of playlists they appear in, views as tie-breaker.
   Versions of the same song (same normalized artist + title) are merged.
4. Write the full ranking to CSV and sync the private playlist with the top 60
   (created on the first run, then only changed songs are added/removed/moved).

Usage:  python top_salsa.py [--dry-run] [--topic tango | --topic "rueda de casino, casino timba"] [--years 3]
Runs on GitHub Actions too (.github/workflows/top-salsa.yml), started from /salsa.html on the site.
"""
import argparse
import csv
import html
import json
import logging
import os
import random
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

MAX_PLAYLISTS = 200
TOP_N = 60
FIXED_TOP = 20  # always in the playlist; the other TOP_N - FIXED_TOP are drawn from the pool
POOL = 200  # songs ranked 1..POOL can be drawn
REPEAT_WEIGHT = 0.3  # a song already in the playlist is this much less likely to be drawn again
# draw weight = playlist_count ** (VARIETY_K * (10 - variety)). Measured on the salsa ranking:
# variety 1 ≈ 9 new songs per run, 3 ≈ 13, 5 ≈ 20, 8 ≈ 33, 10 ≈ 38 (100 quota units per new song)
VARIETY_K = 1.5
MIN_SECONDS, MAX_SECONDS = 120, 720  # drop clips and hour-long mixes
# a topic word alone gets a few query variations; a preset (or a comma list from the user) is used as-is
PRESETS = {"salsa": ["salsa", "salsa cubana", "salsa clásica", "salsa romántica"],
           "rueda": ["rueda de casino", "rueda de casino salsa", "casino rueda music"]}
# playlists mixing in another genre are dropped (genres named in the queries themselves are kept)
GENRES = ["salsa", "bachata", "merengue", "cumbia", "vallenato", "kizomba", "reggae", "reggaeton", "tango",
          "zouk", "kompa", "dembow", "champeta"]
LESSON_WORDS = (r"learn|tutorial|lesson|clase|curso|cours|course|kurs|dersleri|aulas|beginner|principiante|"
                r"d[eé]butant|intermedi|advanced|footwork|how to|pasos|paso b[aá]sico|aprend|steps|moves|"
                r"patterns|partnerwork|styling|shines?\b|isolation|tricks|hand toss|musicality|dance tips|"
                r"perder peso|cardio|zumba|guitar|lipsync|serie|diaries|niveau|lezioni|tutorials|challenge")
BAD_VIDEO = re.compile(LESSON_WORDS + r"|\bmix\b|full album|[aá]lbum completo|enganchados|medley", re.I)
JUNK_WORDS = (r"official|oficial|video|videoclip|audio|lyrics?|letra|con letra|remaster(ed)?|hd|hq|4k|"
              r"live|en vivo|wmv|mp4|mp3|avi|flv|karaoke|musical|clip|salsa version|version salsa")
SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]
HERE = Path(__file__).parent
CLIENT_SECRET = HERE / "client_secret.json"
TOKEN = HERE / "token.json"
CACHE_FILE = HERE / "cache.json"  # API responses; delete it to fetch fresh data

log = logging.getLogger("salsa")
cache = {"search": {}, "playlist": {}, "video": {}}

# Hebrew genre names; anything else in Hebrew goes through Google Translate
HEBREW = {"סלסה": "salsa", "טנגו": "tango", "רגאטון": "reggaeton", "רגטון": "reggaeton", "בצ'אטה": "bachata",
          "באצ'טה": "bachata", "בצאטה": "bachata", "קיזומבה": "kizomba", "מרנגה": "merengue", "קומביה": "cumbia",
          "רואדה": "rueda", "זוק": "zouk", "רגאיי": "reggae", "וואלס": "waltz", "בולרו": "bolero"}

# set by configure() from --topic / --years
QUERIES, PLAYLIST_NAME, CSV_OUT, PUBLISHED_AFTER, BAD_PLAYLIST = [], "", None, None, None


def to_english(text):
    """Hebrew topic -> English ('טנגו' -> 'tango'); Latin-script text is kept ('rueda' must not become 'wheel')."""
    if not re.search(r"[֐-׿]", text):
        return text
    if text in HEBREW:
        return HEBREW[text]
    url = ("https://translate.googleapis.com/translate_a/single?client=gtx&sl=iw&tl=en&dt=t&q="
           + urllib.parse.quote(text))
    with urllib.request.urlopen(url, timeout=15) as r:
        return "".join(part[0] for part in json.load(r)[0]).strip().lower()


def configure(topic, years):
    """'tango' -> queries, playlist 'AVNER Tango <date>', tango_ranking.csv; years -> only playlists created since."""
    global QUERIES, PLAYLIST_NAME, CSV_OUT, PUBLISHED_AFTER, BAD_PLAYLIST
    topic = ",".join(to_english(re.sub(r"\s+", " ", q).strip().lower()) for q in topic.split(","))
    if "," in topic:
        QUERIES = [q.strip() for q in topic.split(",") if q.strip()]
    else:
        variants = [topic, f"best {topic} songs"] if "music" in topic else \
            [topic, f"{topic} music", f"best {topic} songs"]
        QUERIES = PRESETS.get(topic, variants)
    name = QUERIES[0]
    PLAYLIST_NAME = name.title()
    CSV_OUT = HERE / f"{norm(name).replace(' ', '_') or 'topic'}_ranking.csv"
    if years:
        # first day of the month, so the search cache stays valid for the whole month
        start = time.gmtime(time.time() - years * 365.25 * 86400)
        PUBLISHED_AFTER = f"{start.tm_year:04d}-{start.tm_mon:02d}-01T00:00:00Z"
    else:
        PUBLISHED_AFTER = None
    wanted = " ".join(norm(q) for q in QUERIES)
    others = [g for g in GENRES if not re.search(rf"\b{norm(g)}\b", wanted)]
    BAD_PLAYLIST = re.compile(LESSON_WORDS + "".join(rf"|\b{g}\b" for g in others), re.I)
    log.info("topic %r: queries %s, playlists created after %s", name, QUERIES, PUBLISHED_AFTER or "any time")


def load_cache():
    if CACHE_FILE.exists():
        cache.update(json.loads(CACHE_FILE.read_text(encoding="utf-8")))
        log.info("cache: %d searches, %d playlists, %d videos",
                 len(cache["search"]), len(cache["playlist"]), len(cache["video"]))


def save_cache():
    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")


def is_quota_error(e):
    return e.resp.status == 403 and b"quotaExceeded" in (e.content or b"")


def get_service():
    creds = Credentials.from_authorized_user_file(TOKEN, SCOPES) if TOKEN.exists() else None
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        elif os.environ.get("CI"):  # no browser on a server: the token secret must be renewed by hand
            raise SystemExit("token.json is missing or revoked; run the script once locally and update the secret")
        else:
            creds = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET, SCOPES).run_local_server(port=0)
        TOKEN.write_text(creds.to_json())
    return build("youtube", "v3", credentials=creds)


def search_playlists(yt):
    """Up to MAX_PLAYLISTS unique playlists, split evenly between QUERIES; dance lessons and
    mixed-genre playlists are dropped by title."""
    found = {}  # playlist id -> title
    for qi, q in enumerate(QUERIES, 1):
        target = MAX_PLAYLISTS * qi // len(QUERIES)
        token, pages, dropped = None, 0, 0
        while len(found) < target and pages < 10:
            ck = f"{q}|{token or ''}" + (f"|{PUBLISHED_AFTER}" if PUBLISHED_AFTER else "")
            if ck not in cache["search"]:
                extra = {"publishedAfter": PUBLISHED_AFTER} if PUBLISHED_AFTER else {}
                cache["search"][ck] = yt.search().list(
                    part="snippet", q=q, type="playlist", maxResults=50, pageToken=token, **extra).execute()
                save_cache()
            resp = cache["search"][ck]
            pages += 1
            for it in resp["items"]:
                title = html.unescape(it["snippet"]["title"])
                if BAD_PLAYLIST.search(title):
                    dropped += 1
                elif len(found) < target:
                    found.setdefault(it["id"]["playlistId"], title)
            token = resp.get("nextPageToken")
            if not token:
                break
        log.info("after %r: %d unique playlists (%d dropped by title)", q, len(found), dropped)
    return found


def read_playlist(yt, pid):
    """Return list of (video_id, title, channel) or None if the playlist can't be read."""
    if pid in cache["playlist"]:
        return cache["playlist"][pid]
    out, token = [], None
    try:
        while True:
            resp = yt.playlistItems().list(part="snippet", playlistId=pid, maxResults=50, pageToken=token).execute()
            for it in resp["items"]:
                s = it["snippet"]
                if s["title"] in ("Deleted video", "Private video"):
                    continue
                out.append((s["resourceId"]["videoId"], s["title"], s.get("videoOwnerChannelTitle", "")))
            token = resp.get("nextPageToken")
            if not token:
                cache["playlist"][pid] = out
                return out
    except HttpError as e:
        if is_quota_error(e):
            raise
        log.warning("skip playlist %s: HTTP %s", pid, e.resp.status)
        return None


def video_details(yt, ids):
    """video id -> (seconds, views)."""
    missing = [v for v in ids if v not in cache["video"]]
    for i in range(0, len(missing), 50):
        batch = missing[i:i + 50]
        resp = yt.videos().list(part="contentDetails,statistics", id=",".join(batch)).execute()
        for v in batch:
            cache["video"][v] = None  # unavailable videos are not returned; remember that too
        for v in resp["items"]:
            m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", v["contentDetails"]["duration"])
            h, mi, s = (int(x or 0) for x in m.groups()) if m else (0, 0, 0)
            cache["video"][v["id"]] = (h * 3600 + mi * 60 + s, int(v["statistics"].get("viewCount", 0)))
        if i % 1000 == 0:
            save_cache()
    return {v: tuple(cache["video"][v]) for v in ids if cache["video"].get(v)}


KNOWN = 3  # artist score from which a name is trusted as an artist
OFFICIAL_CHANNEL = re.compile(r"\s*-\s*Topic$|\s*VEVO$|\s*Official$", re.I)
SEP = re.compile(r"\s+[-–—~|]+\s*|\s*[-–—~|]+\s+|\s*[–—|]\s*")  # dash with a space on at least one side


def norm(text):
    text = unicodedata.normalize("NFKD", html.unescape(text)).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"[\(\[].*?[\)\]]", " ", text)  # (Official Video), [Remastered] ...
    text = re.sub(r"\b(feat|ft|featuring)\b.*", " ", text)
    text = re.sub(rf"\b({JUNK_WORDS})\b", " ", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def artist_key(name):
    """'Gilberto Santarosa' == 'Gilberto Santa Rosa', 'Willie Colón' == 'Willie Colon'."""
    return norm(name).replace(" ", "")


def channel_artist(channel):
    return OFFICIAL_CHANNEL.sub("", channel).strip()


def display(text):
    """Readable name: drop '(Official Video)'-style brackets and file extensions, fix ALL CAPS."""
    text = html.unescape(text)
    text = re.sub(rf"\s*[\(\[][^\)\]]*\b({JUNK_WORDS})\b[^\)\]]*[\)\]]", "", text, flags=re.I)
    text = re.sub(r"\.(wmv|mp4|mp3|avi|flv)$", "", text, flags=re.I)
    text = re.sub(r"\s+(con letra|letra|lyrics|video oficial|official video|videoclip|audio oficial|hd)\s*$",
                  "", text, flags=re.I)
    text = re.sub(r"[^\w\s'&,.!?¿¡()/-]", "", text)  # emoji, '+', '♪' ...
    text = re.sub(r"\s+", " ", text).strip(" -,")
    return text.title() if text.isupper() or text.islower() else text


def title_parts(title):
    """Meaningful pieces of a title split on ' - ', '|', '–' (junk-only pieces like 'Video Oficial' dropped)."""
    title = re.sub(r"\.(wmv|mp4|mp3|avi|flv)$", "", html.unescape(title), flags=re.I)
    return [p.strip() for p in SEP.split(title) if norm(p)]


def artist_scores(items):
    """How much more each name looks like an artist than a song title.
    Artist evidence: official channels, the left side of 'X - Y'. Song evidence: titles on
    official channels, the right side of 'X - Y'."""
    score, seen = defaultdict(int), set()
    partners = defaultdict(set)  # an artist pairs with many different songs, a song with one or two artists
    for vid, title, channel in items:
        if vid in seen:
            continue
        seen.add(vid)
        parts = title_parts(title)
        if OFFICIAL_CHANNEL.search(channel):
            a = artist_key(channel_artist(channel))
            score[a] += 3
            if len(parts) == 1:
                score[artist_key(parts[0])] -= 3
                partners[a].add(artist_key(parts[0]))
        if len(parts) >= 2:
            x, y = artist_key(parts[0]), artist_key(parts[1])
            score[x] += 1
            score[y] -= 1
            partners[x].add(y)
            partners[y].add(x)
    for name, p in partners.items():
        score[name] += 2 * (len(p) - 1)
    return score


def split_title(title, channel, score, known_names):
    """Best-effort (artist, song); artist is None when it can't be told (merged by song title later)."""
    parts = title_parts(title)
    if not parts:
        return None
    def s(name):  # 'Roberto Roena con Piro Mantilla' also counts as 'Roberto Roena'
        lead = re.split(r"\s+(?:con|feat\.?|ft\.?|&|y su|y sus)\s+", name, maxsplit=1, flags=re.I)[0]
        return max(score.get(artist_key(name), 0), score.get(artist_key(lead), 0) if lead != name else -99)
    if len(parts) >= 2:  # 'Artist - Song' or 'Song - Artist': the better-known side is the artist
        a = max(range(len(parts)), key=lambda i: (s(parts[i]), -i))
        song = next(p for i, p in enumerate(parts) if i != a)
        return parts[a], song
    text = parts[0]
    for sep in ("-", ","):  # 'pequeñas cosas-willie gonzales', 'Cali Pachanguero, Grupo Niche'
        if sep in text:
            x, y = (p.strip() for p in text.split(sep, 1))
            if norm(x) and norm(y) and max(s(x), s(y)) >= KNOWN:
                return (x, y) if s(x) >= s(y) else (y, x)
    ch = channel_artist(channel)
    if OFFICIAL_CHANNEL.search(channel) or s(ch) >= KNOWN:
        return ch, text
    words, n = text.split(), norm(text)
    for name in known_names:  # 'Grupo Niche Gotas De Lluvia'
        k = len(name.split())
        if n.startswith(name + " ") and len(words) > k:
            return " ".join(words[:k]), " ".join(words[k:])
        if n.endswith(" " + name) and len(words) > k:
            return " ".join(words[-k:]), " ".join(words[:-k])
    if "-" in text:  # 'pequeñas cosas-willie gonzales': song title lookup happens with each side later
        return None, text.split("-", 1)[0].strip()
    return None, text


def rank(yt, playlists):
    lists = {}
    for n, pid in enumerate(playlists, 1):
        items = read_playlist(yt, pid)
        if n % 20 == 0:
            save_cache()
        if items is None:
            continue
        log.info("[%d/%d] %s: %d videos", n, len(playlists), pid, len(items))
        lists[pid] = [it for it in items if not BAD_VIDEO.search(it[1])]
    log.info("playlists read: %d, skipped: %d", len(lists), len(playlists) - len(lists))

    score = artist_scores(it for items in lists.values() for it in items)
    known_names = sorted({norm(channel_artist(ch)) for items in lists.values() for _, _, ch in items
                          if score.get(artist_key(channel_artist(ch)), 0) >= KNOWN and len(artist_key(ch)) >= 5},
                         key=len, reverse=True)
    in_lists = defaultdict(set)  # (artist, song) key -> playlist ids
    versions = defaultdict(dict)  # key -> video id -> (artist or None, song)
    orphans = []
    for pid, items in lists.items():
        for vid, title, channel in items:
            parsed = split_title(title, channel, score, known_names)
            if not parsed or not norm(parsed[1]):
                continue
            artist, song = parsed
            if artist is None:
                orphans.append((pid, vid, channel, song))
                continue
            key = (artist_key(artist), norm(song))
            in_lists[key].add(pid)
            versions[key][vid] = (artist, song)

    # Uploads with no artist in the title (e.g. a fan channel posting "Que Locura Enamorarme De Ti")
    # join the best-listed song of the same title; otherwise fall back to the channel name.
    by_song = defaultdict(list)
    for key in versions:
        by_song[key[1]].append(key)
    for pid, vid, channel, song in orphans:
        cands = by_song.get(norm(song))
        if cands:
            key, artist = max(cands, key=lambda k: len(in_lists[k])), None
        else:
            artist = channel_artist(channel) or None
            key = (artist_key(artist or ""), norm(song))
            by_song[key[1]].append(key)
        in_lists[key].add(pid)
        versions[key][vid] = (artist, song)

    details = video_details(yt, {v for d in versions.values() for v in d})
    rows = []
    for key, vids in versions.items():
        valid = {v: details[v] for v in vids if v in details and MIN_SECONDS <= details[v][0] <= MAX_SECONDS}
        if not valid:
            continue
        best = max(valid, key=lambda v: valid[v][1])  # most-viewed version represents the song
        # display the spelling backed by the most views across versions
        a_views, s_views = defaultdict(int), defaultdict(int)
        for v, (a, s) in vids.items():
            views = details.get(v, (0, 0))[1]
            if a:
                a_views[display(re.split(r"\s+(?:feat\.?|ft\.?)\s+", a, flags=re.I)[0])] += views + 1
            s_views[display(s)] += views + 1
        rows.append({"video_id": best, "title": max(s_views, key=s_views.get),
                     "artist": max(a_views, key=a_views.get) if a_views else "",
                     "playlists": len(in_lists[key]), "views": valid[best][1]})
    rows.sort(key=lambda r: (r["playlists"], r["views"]), reverse=True)
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


def write_csv(rows):
    with CSV_OUT.open("w", newline="", encoding="utf-8-sig") as f:  # utf-8-sig: opens cleanly in Excel
        w = csv.writer(f)
        w.writerow(["rank", "title", "artist", "playlist_count", "views", "url"])
        for i, r in enumerate(rows, 1):
            w.writerow([i, r["title"], r["artist"], r["playlists"], r["views"],
                        f"https://www.youtube.com/watch?v={r['video_id']}"])
    log.info("wrote %s (%d rows)", CSV_OUT, len(rows))


def playlist_body(title, pid=None):
    body = {"snippet": {"title": title, "description":
                        f"Most-listed songs across YouTube playlists for: {', '.join(QUERIES)}."
                        + (f" Playlists created after {PUBLISHED_AFTER[:10]}." if PUBLISHED_AFTER else "")},
            "status": {"privacyStatus": "private"}}
    if pid:
        body["id"] = pid
    return body


def find_playlist(yt, write=True):
    """(id, title) of my private playlist for this topic: 'AVNER <Topic> <yyyy-mm-dd>', or the older
    'Top 60 <Topic>' name (renamed here to the new format, keeping its creation date). None if missing."""
    current = re.compile(rf"AVNER {re.escape(PLAYLIST_NAME)} \d{{4}}-\d{{2}}-\d{{2}}")
    token = None
    while True:
        resp = yt.playlists().list(part="snippet,status", mine=True, maxResults=50, pageToken=token).execute()
        for pl in resp["items"]:
            title, private = pl["snippet"]["title"], pl["status"]["privacyStatus"] == "private"
            if private and current.fullmatch(title):
                return pl["id"], title
            if private and title == f"Top {TOP_N} {PLAYLIST_NAME}":
                new = f"AVNER {PLAYLIST_NAME} {pl['snippet']['publishedAt'][:10]}"
                if write:
                    yt.playlists().update(part="snippet,status", body=playlist_body(new, pl["id"])).execute()
                    log.info("renamed %r -> %r", title, new)
                return pl["id"], new
        token = resp.get("nextPageToken")
        if not token:
            return None


def open_playlist(yt, write=True):
    """(id, title, [(item id, video id)] in order) of this topic's playlist, or None if there is none yet."""
    found = find_playlist(yt, write)
    if not found:
        return None
    pid, title = found
    items, token = [], None
    while True:
        resp = yt.playlistItems().list(part="snippet", playlistId=pid, maxResults=50, pageToken=token).execute()
        items += [(it["id"], it["snippet"]["resourceId"]["videoId"]) for it in resp["items"]]
        token = resp.get("nextPageToken")
        if not token:
            return pid, title, items


def choose(rows, variety, current_vids, rng):
    """The TOP_N songs for this run.
    - The FIXED_TOP best-ranked songs are always in, at the top.
    - The rest are drawn from ranks FIXED_TOP+1..POOL, weighted by playlist count: variety 0 = exactly the
      top TOP_N, 10 = almost uniform. Songs already in the playlist weigh REPEAT_WEIGHT as much, so every
      run brings new songs.
    - Songs kept from the current playlist stay in their current order and new ones follow by rank,
      so the sync needs no moves (moves cost quota)."""
    if variety <= 0:
        return rows[:TOP_N]
    fixed, pool = rows[:FIXED_TOP], rows[FIXED_TOP:POOL]
    alpha = VARIETY_K * (10 - min(variety, 10))
    current = {v: i for i, v in enumerate(current_vids)}

    def key(r):  # Efraimidis-Spirakis weighted sampling without replacement
        w = r["playlists"] ** alpha * (REPEAT_WEIGHT if r["video_id"] in current else 1)
        return rng.random() ** (1 / w)

    picks = sorted(pool, key=key, reverse=True)[:TOP_N - FIXED_TOP]
    kept = sorted((r for r in picks if r["video_id"] in current), key=lambda r: current[r["video_id"]])
    new = sorted((r for r in picks if r["video_id"] not in current), key=lambda r: r["rank"])
    log.info("variety %s: %d fixed, %d kept, %d new", variety, len(fixed), len(kept), len(new))
    return fixed + kept + new


def sync_playlist(yt, rows, current):
    """Make the playlist hold exactly rows, in order. Only changed songs cost quota (50 units each)."""
    if current:
        pid, title, items = current
    else:
        title = f"AVNER {PLAYLIST_NAME} {time.strftime('%Y-%m-%d')}"
        pid = yt.playlists().insert(part="snippet,status", body=playlist_body(title)).execute()["id"]
        items = []
        log.info("created playlist %r (%s)", title, pid)
    items = list(items)  # [(item id, video id)] in playlist order

    target = [r["video_id"] for r in rows]
    removed = added = moved = 0
    seen = set()
    for item_id, vid in list(items):  # drop songs that left the top, and duplicates
        if vid not in target or vid in seen:
            yt.playlistItems().delete(id=item_id).execute()
            items.remove((item_id, vid))
            removed += 1
        seen.add(vid)
    for pos, vid in enumerate(target):
        if pos < len(items) and items[pos][1] == vid:
            continue
        body = {"snippet": {"playlistId": pid, "position": pos,
                            "resourceId": {"kind": "youtube#video", "videoId": vid}}}
        existing = next((it for it in items if it[1] == vid), None)
        if existing:
            body["id"] = existing[0]
            yt.playlistItems().update(part="snippet", body=body).execute()
            items.remove(existing)
            moved += 1
        else:
            existing = (yt.playlistItems().insert(part="snippet", body=body).execute()["id"], vid)
            added += 1
        items.insert(pos, existing)
        time.sleep(0.3)
    log.info("playlist synced: %d added, %d removed, %d moved", added, removed, moved)
    log.info("playlist: https://www.youtube.com/playlist?list=%s", pid)
    return pid, title, added, removed, moved


def write_summary(rows, sync=None):
    """Markdown report for the GitHub Actions run page (only when running there)."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = [f"# {sync[1] if sync else 'AVNER ' + PLAYLIST_NAME}", "",
             f"Searches: {', '.join(QUERIES)}. Playlists created "
             + (f"after {PUBLISHED_AFTER[:10]}." if PUBLISHED_AFTER else "at any time."), ""]
    if sync:
        pid, _, added, removed, moved = sync
        lines += [f"Playlist: https://www.youtube.com/playlist?list={pid}",
                  f"Changes: {added} added, {removed} removed, {moved} moved", ""]
    else:
        lines += ["Dry run: the YouTube playlist was not changed.", ""]
    lines += ["| # | Rank | Artist | Song | Playlists |", "|---|---|---|---|---|"]
    lines += [f"| {i} | {r['rank']} | {r['artist']} | [{r['title']}](https://www.youtube.com/watch?v={r['video_id']}) "
              f"| {r['playlists']} |" for i, r in enumerate(rows, 1)]
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="rank and write CSV, but do not touch the playlist")
    ap.add_argument("--topic", default="salsa",
                    help="genre to rank, e.g. 'tango', or several searches separated by commas")
    ap.add_argument("--years", type=float, default=0,
                    help="only use playlists created in the last N years (0 = any time)")
    ap.add_argument("--variety", type=float, default=5,
                    help=f"0 = exactly the top {TOP_N}; up to 10 = more songs drawn from ranks "
                         f"{FIXED_TOP + 1}-{POOL} (the top {FIXED_TOP} always stay)")
    ap.add_argument("--seed", type=int, help="random seed, to repeat a run's draw")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(), logging.FileHandler(HERE / "run.log", encoding="utf-8")])
    configure(args.topic, args.years)
    load_cache()
    yt = get_service()
    try:
        rows = rank(yt, search_playlists(yt))
    finally:
        save_cache()  # keep progress even if quota runs out mid-run
    write_csv(rows)
    current = open_playlist(yt, write=not args.dry_run)
    seed = args.seed if args.seed is not None else random.randrange(1_000_000)
    log.info("random seed %d", seed)
    picked = choose(rows, args.variety, [v for _, v in current[2]] if current else [], random.Random(seed))
    sync = None if args.dry_run else sync_playlist(yt, picked, current)
    write_summary(picked, sync)


if __name__ == "__main__":
    main()
