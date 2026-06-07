#!/usr/bin/env python3
"""
Pluck - install FM-facepack portraits into faces/.

Workflow per squad you want to populate:
  1. In data/soccer.json, replace each player's `sofascore_id` with `id`
     and set it to that player's FM facepack UID.
  2. Drop the matching files into  faces/rename/<squad-id>/<player-id>.{png,webp}
     where <squad-id> is the squad's "id" field in soccer.json
     (e.g. faces/rename/2005-ucl-final-liverpool/44897.webp).
     Files dropped flat in  faces/rename/  (no subfolder) are treated as
     shared defaults — used for any squad that doesn't have a specific
     override for that player.
  3. Run:  python scripts/install_faces.py
     → moves them into  faces/<squad-id>/  (or flat for shared defaults),
       normalizes filenames, and prints a per-squad checklist of every
       player still missing a portrait.

Engine lookup order, per (squad, player):
  1. faces/<squad-id>/<player-id>.png   ← squad-specific portrait (preferred)
  2. faces/<squad-id>/<player-id>.webp
  3. faces/<player-id>.png              ← shared default (any squad)
  4. faces/<player-id>.webp
  5. ink monogram
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
KEEP_EXT  = {".png", ".webp"}  # native formats the engine probes directly

db = json.load(open(DATA_FILE, encoding="utf-8"))
known_squad_ids = {s["id"] for s in db}


def install_one(src_path, rel_path):
    """Move a single file from rename/ to faces/, preserving subfolder.
       rel_path is the path relative to faces/rename/  (e.g.
       '2005-ucl-final-liverpool/44897.webp' or just '44897.png')."""
    parts = rel_path.split(os.sep)
    fn    = parts[-1]
    sub   = os.sep.join(parts[:-1]) if len(parts) > 1 else ""
    stem, ext = os.path.splitext(fn)
    ext = ext.lower()
    if not stem.isdigit():
        return ("skip", f"{rel_path} (filename isn't a numeric ID)")
    if sub and sub not in known_squad_ids:
        return ("skip", f"{rel_path} (subfolder '{sub}' isn't a known squad id)")
    dst_ext = ext if ext in KEEP_EXT else ".png"
    renamed = (dst_ext != ext)
    dst_dir = os.path.join(FACES_DIR, sub) if sub else FACES_DIR
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, f"{stem}{dst_ext}")
    if os.path.exists(dst):
        return ("skip", f"{rel_path} → {os.path.relpath(dst, FACES_DIR)} exists")
    shutil.move(src_path, dst)
    return ("ok", f"{rel_path}  →  {os.path.relpath(dst, FACES_DIR)}", renamed)


# ──────────────────────────────────────────────────────────────────────
# 1. Walk faces/rename/ recursively, install each file
# ──────────────────────────────────────────────────────────────────────
moved, renamed_exts, skipped = 0, 0, 0
if os.path.isdir(SRC_DIR):
    for dirpath, _, filenames in os.walk(SRC_DIR):
        for fn in filenames:
            src = os.path.join(dirpath, fn)
            rel = os.path.relpath(src, SRC_DIR)
            result = install_one(src, rel)
            if result[0] == "ok":
                moved += 1
                if result[2]: renamed_exts += 1
                print(f"  mv  {result[1]}")
            else:
                skipped += 1
                print(f"  skip {result[1]}")
    # remove now-empty subdirectories in rename/ (deepest first)
    for dirpath, dirnames, _ in os.walk(SRC_DIR, topdown=False):
        try: os.rmdir(dirpath)
        except OSError: pass

print(f"\nmoved={moved}  renamed-ext={renamed_exts}  skipped={skipped}\n")

# ──────────────────────────────────────────────────────────────────────
# 2. Report which portraits soccer.json references but doesn't have
#    (per the 4-tier lookup order)
# ──────────────────────────────────────────────────────────────────────
def have_portrait(squad_id, face_id):
    """Mirror the engine's probe order."""
    for sub in (squad_id, None):
        base = os.path.join(FACES_DIR, sub) if sub else FACES_DIR
        for ext in (".png", ".webp"):
            if os.path.exists(os.path.join(base, f"{face_id}{ext}")):
                return True
    return False

missing_by_squad = {}
total_needed     = 0
for squad in db:
    sq_id = squad["id"]
    for p in squad.get("lineup", []):
        fid = p.get("id") or p.get("sofascore_id")
        if not fid:
            continue
        if not have_portrait(sq_id, fid):
            missing_by_squad.setdefault(sq_id, []).append({
                "team": squad["team"],
                "season": squad["season"],
                "name": p["name"],
                "fid": fid,
                "field": "id" if "id" in p else "sofascore_id",
            })
            total_needed += 1

if not missing_by_squad:
    print("Every player has a portrait.  🎉")
else:
    print(f"Still missing ({total_needed} portraits — shown as ink monograms in-game):")
    for sq_id, items in missing_by_squad.items():
        head = items[0]
        print(f"\n  {head['team']} {head['season']}  ({sq_id}):")
        for it in items:
            flag = "" if it["field"] == "id" else "  (still sofascore_id — pre-migration)"
            print(f"    {it['name']:30s} {it['field']}={it['fid']}{flag}")
