#!/usr/bin/env python3
"""Build a private YouTube playlist "Top 60 Salsa" from the most-listed salsa songs.

1. Search playlists for several salsa queries (up to 200 unique).
2. Read every playlist's videos (private/deleted/blocked playlists are skipped and logged).
3. Rank songs by number of playlists they appear in, views as tie-breaker.
   Versions of the same song (same normalized artist + title) are merged.
4. Create a private playlist with the top 60 and write the full ranking to CSV.

Usage:  python top_salsa.py [--dry-run]
"""
import argparse
import csv
import logging
import re
import time
import unicodedata
from collections import defaultdict
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

QUERIES = ["salsa", "salsa cubana", "salsa clásica", "salsa romántica"]
MAX_PLAYLISTS = 200
TOP_N = 60
MIN_SECONDS, MAX_SECONDS = 120, 720  # drop clips and hour-long mixes
PLAYLIST_TITLE = "Top 60 Salsa"
SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]
HERE = Path(__file__).parent
CLIENT_SECRET = HERE / "client_secret.json"
TOKEN = HERE / "token.json"
CSV_OUT = HERE / "salsa_ranking.csv"

log = logging.getLogger("salsa")


def get_service():
    creds = Credentials.from_authorized_user_file(TOKEN, SCOPES) if TOKEN.exists() else None
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            creds = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET, SCOPES).run_local_server(port=0)
        TOKEN.write_text(creds.to_json())
    return build("youtube", "v3", credentials=creds)


def search_playlists(yt):
    found = {}  # playlist id -> title
    for q in QUERIES:
        token = None
        while len(found) < MAX_PLAYLISTS:
            resp = yt.search().list(part="snippet", q=q, type="playlist", maxResults=50, pageToken=token).execute()
            for it in resp["items"]:
                found.setdefault(it["id"]["playlistId"], it["snippet"]["title"])
            token = resp.get("nextPageToken")
            if not token:
                break
        log.info("after %r: %d unique playlists", q, len(found))
    return dict(list(found.items())[:MAX_PLAYLISTS])


def read_playlist(yt, pid):
    """Return list of (video_id, title, channel) or None if the playlist can't be read."""
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
                return out
    except HttpError as e:
        log.warning("skip playlist %s: HTTP %s", pid, e.resp.status)
        return None


def video_details(yt, ids):
    """video id -> (seconds, views)."""
    info = {}
    ids = list(ids)
    for i in range(0, len(ids), 50):
        resp = yt.videos().list(part="contentDetails,statistics", id=",".join(ids[i:i + 50])).execute()
        for v in resp["items"]:
            m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", v["contentDetails"]["duration"])
            h, mi, s = (int(x or 0) for x in m.groups()) if m else (0, 0, 0)
            info[v["id"]] = (h * 3600 + mi * 60 + s, int(v["statistics"].get("viewCount", 0)))
    return info


def norm(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"[\(\[].*?[\)\]]", " ", text)  # (Official Video), [Remastered] ...
    text = re.sub(r"\b(feat|ft|featuring)\b.*", " ", text)
    text = re.sub(r"\b(official|video|audio|lyrics|letra|remaster(ed)?|hd|live|en vivo)\b", " ", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def split_title(title, channel):
    """Best-effort (artist, song). 'Artist - Song' in the title, else the channel name."""
    if " - " in title:
        artist, song = title.split(" - ", 1)
    else:
        artist, song = re.sub(r"\s*-\s*Topic$|VEVO$|Official$", "", channel, flags=re.I), title
    return artist.strip(), song.strip()


def rank(yt, playlists):
    in_lists = defaultdict(set)  # (artist, song) key -> playlist ids
    versions = defaultdict(dict)  # key -> video id -> (artist, song)
    for n, pid in enumerate(playlists, 1):
        items = read_playlist(yt, pid)
        if items is None:
            continue
        log.info("[%d/%d] %s: %d videos", n, len(playlists), pid, len(items))
        for vid, title, channel in items:
            artist, song = split_title(title, channel)
            key = (norm(artist), norm(song))
            if not key[1]:
                continue
            in_lists[key].add(pid)
            versions[key][vid] = (artist, song)

    details = video_details(yt, {v for d in versions.values() for v in d})
    rows = []
    for key, vids in versions.items():
        valid = {v: details[v] for v in vids if v in details and MIN_SECONDS <= details[v][0] <= MAX_SECONDS}
        if not valid:
            continue
        best = max(valid, key=lambda v: valid[v][1])  # most-viewed version represents the song
        artist, song = vids[best]
        rows.append({"video_id": best, "title": song, "artist": artist,
                     "playlists": len(in_lists[key]), "views": valid[best][1]})
    rows.sort(key=lambda r: (r["playlists"], r["views"]), reverse=True)
    return rows


def write_csv(rows):
    with CSV_OUT.open("w", newline="", encoding="utf-8-sig") as f:  # utf-8-sig: opens cleanly in Excel
        w = csv.writer(f)
        w.writerow(["rank", "title", "artist", "playlist_count", "views", "url"])
        for i, r in enumerate(rows, 1):
            w.writerow([i, r["title"], r["artist"], r["playlists"], r["views"],
                        f"https://www.youtube.com/watch?v={r['video_id']}"])
    log.info("wrote %s (%d rows)", CSV_OUT, len(rows))


def create_playlist(yt, rows):
    pl = yt.playlists().insert(part="snippet,status", body={
        "snippet": {"title": PLAYLIST_TITLE, "description": "Most-listed salsa songs across YouTube playlists."},
        "status": {"privacyStatus": "private"}}).execute()
    for r in rows:
        yt.playlistItems().insert(part="snippet", body={"snippet": {
            "playlistId": pl["id"], "resourceId": {"kind": "youtube#video", "videoId": r["video_id"]}}}).execute()
        time.sleep(0.3)
    log.info("playlist: https://www.youtube.com/playlist?list=%s", pl["id"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="rank and write CSV, but do not create the playlist")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(), logging.FileHandler(HERE / "run.log", encoding="utf-8")])
    yt = get_service()
    rows = rank(yt, search_playlists(yt))
    write_csv(rows)
    if not args.dry_run:
        create_playlist(yt, rows[:TOP_N])


if __name__ == "__main__":
    main()
