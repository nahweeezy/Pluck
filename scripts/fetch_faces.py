#!/usr/bin/env python3
"""
Pluck - one-time player-portrait cache (your slow-download approach).

SofaScore now 403-blocks hotlinked/runtime image requests, so instead of the
game calling their API live, we download each player's portrait ONCE and serve
it locally from faces/{id}.png.

    python scripts/fetch_faces.py

* Reads every sofascore_id in data/soccer.json (deduped).
* Downloads one image at a time with a delay (default 1.5s) so you stay under
  the rate limit -- tune with the DELAY env var:  DELAY=2.5 python scripts/fetch_faces.py
* Resumable: a player whose faces/{id}.png already exists is skipped.
* Saves the RAW image; the game does the white-background flood-fill in the
  browser (works because the file is now same-origin, so the canvas isn't
  CORS-tainted).

IMPORTANT: run this from a NORMAL/RESIDENTIAL connection. SofaScore blocks
datacenter/cloud IPs (and aggressively rate-limits). If you get a wall of 403s
on request #1, your IP itself is blocked -- try a different network (e.g. a
phone hotspot or VPN); it's resumable, so you can stop/restart freely.

Stdlib only -- no `pip install` needed. (Mirrors the requests+sleep approach.)
"""

import json
import os
import time
import urllib.request
import urllib.error

ROOT      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(ROOT, "data", "soccer.json")
FACES_DIR = os.path.join(ROOT, "faces")
DELAY     = float(os.environ.get("DELAY", "1.5"))   # seconds between requests
URL       = "https://api.sofascore.com/api/v1/player/{}/image"
HEADERS   = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.sofascore.com/",
    "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
}

db = json.load(open(DATA_FILE, encoding="utf-8"))
ids = sorted({p["sofascore_id"] for c in db for p in c.get("lineup", []) if p.get("sofascore_id")})
os.makedirs(FACES_DIR, exist_ok=True)

fetched = skipped = 0
failed = []
print(f"{len(ids)} unique player IDs - {DELAY}s between requests\n")

for i, sid in enumerate(ids, 1):
    out = os.path.join(FACES_DIR, f"{sid}.png")
    if os.path.exists(out) and os.path.getsize(out) > 0:
        skipped += 1
        continue
    try:
        req = urllib.request.Request(URL.format(sid), headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = r.headers.get("Content-Type", "")
            data = r.read()
        if not ctype.startswith("image/") or len(data) < 200:
            failed.append(f"{sid} (got {ctype or '?'} {len(data)}b)")
            print(f"[{i:>3}/{len(ids)}] x {sid}  not-an-image")
        else:
            with open(out, "wb") as f:
                f.write(data)
            fetched += 1
            print(f"[{i:>3}/{len(ids)}] ok {sid}.png  ({len(data)/1024:.1f} KB)")
    except urllib.error.HTTPError as e:
        failed.append(f"{sid} (HTTP {e.code})")
        print(f"[{i:>3}/{len(ids)}] x {sid}  HTTP {e.code}")
    except Exception as e:
        failed.append(f"{sid} ({e})")
        print(f"[{i:>3}/{len(ids)}] x {sid}  {e}")
    time.sleep(DELAY)

print(f"\nDone. fetched={fetched} skipped={skipped} failed={len(failed)}")
if failed:
    print("\nFailed (these keep the monogram fallback in-game):")
    for f in failed:
        print("  " + f)
    print("\nIf MOST failed with HTTP 403, this connection is blocked. Try a")
    print("different network and rerun (it resumes), or use the browser route:")
    print("  scripts/fetch_faces_browser.js")
