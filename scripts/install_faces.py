#!/usr/bin/env python3
"""
Pluck - install FM-facepack portraits into faces/.

Workflow per squad you want to add:
  1. In data/soccer.json, replace each player's `sofascore_id` with `id`
     and set it to that player's FM facepack UID.
  2. Drop the matching files into faces/rename/ (any mix of .png / .webp / .jpg).
  3. Run:  python scripts/install_faces.py
     → moves them up to faces/, normalizes filenames, reports anything
       referenced by soccer.json that's still missing.

The engine looks at  faces/{id}.png  first and  faces/{id}.webp  second,
so both native extensions work. Anything else (.jpg, etc.) is renamed to
.png on the way in (it's still the same image bytes — browsers don't care
about the extension when decoding).
"""
import json
import os
import shutil
import sys

# Windows console defaults to cp1252; force UTF-8 so accented player names
# (Vidić, Hyypiä, Tchouaméni, etc.) print without crashing.
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR   = os.path.join(ROOT, "faces", "rename")
FACES_DIR = os.path.join(ROOT, "faces")
DATA_FILE = os.path.join(ROOT, "data", "soccer.json")
KEEP_EXT  = {".png", ".webp"}  # what the engine knows how to probe directly

# 1. Move whatever's in faces/rename/ → faces/  (preserving native ext if .png|.webp)
moved, renamed, skipped = 0, 0, 0
if os.path.isdir(SRC_DIR):
    for fn in os.listdir(SRC_DIR):
        src = os.path.join(SRC_DIR, fn)
        if not os.path.isfile(src):
            continue
        stem, ext = os.path.splitext(fn)
        ext = ext.lower()
        if not stem.isdigit():
            print(f"  skip {fn} (filename isn't a numeric ID)")
            skipped += 1
            continue
        dst_ext = ext if ext in KEEP_EXT else ".png"
        if dst_ext != ext:
            renamed += 1
        dst = os.path.join(FACES_DIR, f"{stem}{dst_ext}")
        if os.path.exists(dst):
            print(f"  skip {fn} → {os.path.basename(dst)} already exists")
            skipped += 1
            continue
        shutil.move(src, dst)
        moved += 1
        print(f"  mv  {fn}  →  {os.path.basename(dst)}")
    # remove the source dir if empty
    try:
        os.rmdir(SRC_DIR)
    except OSError:
        pass

print(f"\nmoved={moved}  renamed-ext={renamed}  skipped={skipped}\n")

# 2. Report which faces soccer.json references but doesn't have yet
db = json.load(open(DATA_FILE, encoding="utf-8"))
needed = []
for squad in db:
    for p in squad.get("lineup", []):
        fid = p.get("id") or p.get("sofascore_id")
        if not fid:
            continue
        png  = os.path.join(FACES_DIR, f"{fid}.png")
        webp = os.path.join(FACES_DIR, f"{fid}.webp")
        if not (os.path.exists(png) or os.path.exists(webp)):
            needed.append((squad["team"], squad["season"], p["name"], fid,
                           "id" if "id" in p else "sofascore_id"))

if not needed:
    print("Every player referenced in soccer.json has a portrait.  🎉")
else:
    print(f"Still missing ({len(needed)} files — shown as ink monograms in-game):")
    last_squad = None
    for team, season, name, fid, field in needed:
        squad_key = (team, season)
        if squad_key != last_squad:
            print(f"\n  {team} {season}:")
            last_squad = squad_key
        flag = "" if field == "id" else "  (still sofascore_id — pre-migration)"
        print(f"    {name:30s} {field}={fid}{flag}")
