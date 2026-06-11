#!/usr/bin/env python3
"""
Pluck - fast portrait sourcing for one squad at a time.

For a given squad ID, walks the lineup, opens the sortitoutsi.net search
page for each player who's still missing a portrait, watches your
Downloads folder for a newly-saved PNG/webp, prompts a one-key confirm,
moves it into  faces/<squad>/<id>.<ext>  and patches data/soccer.json
with  "id": <id>  for that player.

Workflow per player:
   - your job:  pick the era-matching face on sortitoutsi + hit Download
                (one click + a confirm keystroke — that's it)
   - tool's job: detect the new file, parse its sortitoutsi id from the
                 filename, move + rename to the right spot, patch JSON

Run:
    python scripts/source_faces.py <squad-id>
    python scripts/source_faces.py 2008-ucl-final-man-united

Options at the prompt:
    Enter / y   accept the latest-downloaded file for this player
    n           reject, wait for a different file
    s           skip this player (you can come back to them later)
    q           quit (everything done so far is saved)

Resumable: rerun on the same squad and it picks up where you left off
(it only touches players who don't have a faces/<squad>/<id>.{png,webp}
already).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import webbrowser
from urllib.parse import quote_plus

# Windows console likes UTF-8 for accented player names.
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE  = os.path.join(ROOT, "data", "soccer.json")
FACES_DIR  = os.path.join(ROOT, "faces")
DOWNLOADS  = os.environ.get("DOWNLOADS") or os.path.join(os.path.expanduser("~"), "Downloads")
SEARCH_URL = "https://sortitoutsi.net/graphics/?q={}"
IMAGE_EXTS = {".png", ".webp", ".jpg", ".jpeg"}


def have_portrait(squad_id, face_id):
    """Mirror the engine's probe — squad folder PNG/webp first, then root."""
    for sub in (squad_id, None):
        base = os.path.join(FACES_DIR, sub) if sub else FACES_DIR
        for ext in (".png", ".webp"):
            if os.path.exists(os.path.join(base, f"{face_id}{ext}")):
                return True
    return False


def newest_image(folder, since_ts):
    """Return the (path, ext, ctime) of the most-recently-modified image
       file in `folder` whose mtime > since_ts. None if nothing newer."""
    best = None
    try:
        names = os.listdir(folder)
    except FileNotFoundError:
        return None
    for name in names:
        path = os.path.join(folder, name)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in IMAGE_EXTS:
            continue
        try: mtime = os.path.getmtime(path)
        except OSError: continue
        if mtime <= since_ts:
            continue
        if best is None or mtime > best[2]:
            best = (path, ext, mtime)
    return best


def wait_for_download(player_name, since_ts, poll_sec=0.4):
    """Block until a NEW image lands in Downloads (mtime > since_ts).
       Prints a single status line that updates in place."""
    print(f"  watching {DOWNLOADS} … (Ctrl-C to bail)", end="", flush=True)
    while True:
        cand = newest_image(DOWNLOADS, since_ts)
        if cand:
            print()  # finish the watching line
            return cand
        time.sleep(poll_sec)


def parse_sortitoutsi_id(path):
    """Extract the numeric ID from a sortitoutsi-style filename.
       Their downloads come as `12345.png` — the stem IS the id.
       If the user's browser added a suffix (e.g. `12345 (1).png`)
       strip it and use the digits."""
    stem = os.path.splitext(os.path.basename(path))[0]
    m = re.search(r"(\d+)", stem)
    return m.group(1) if m else None


def prompt_choice(prompt, default="y"):
    """One-key prompt with sane defaults. Returns y/n/s/q."""
    raw = input(prompt).strip().lower()
    if raw == "": raw = default
    return raw[0] if raw else default


def patch_json(squad_id, player_name, face_id):
    """Set player.id in soccer.json. Atomic write."""
    db = json.load(open(DATA_FILE, encoding="utf-8"))
    patched = False
    for s in db:
        if s["id"] != squad_id: continue
        for p in s.get("lineup", []):
            if p["name"] == player_name:
                p["id"] = int(face_id)
                # If they previously had sofascore_id, drop it now that they
                # have a proper id.
                if "sofascore_id" in p:
                    del p["sofascore_id"]
                patched = True
                break
    if not patched:
        return False
    # Atomic write with a tmp file.
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, DATA_FILE)
    return True


def open_search(name):
    """Open the sortitoutsi search URL in the default browser."""
    url = SEARCH_URL.format(quote_plus(name))
    try: webbrowser.open(url, new=2)
    except Exception as e: print(f"  (couldn't open browser: {e})")
    return url


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/source_faces.py <squad-id>")
        print("\nAvailable squad IDs:")
        for s in json.load(open(DATA_FILE, encoding="utf-8")):
            mark = "✓" if all(have_portrait(s["id"], p.get("id") or p.get("sofascore_id"))
                              for p in s.get("lineup", [])
                              if (p.get("id") or p.get("sofascore_id"))) else " "
            print(f"  [{mark}] {s['id']:42s} {s['team']} {s['season']}")
        sys.exit(1)

    squad_id = sys.argv[1]
    db = json.load(open(DATA_FILE, encoding="utf-8"))
    squad = next((s for s in db if s["id"] == squad_id), None)
    if not squad:
        sys.exit(f"squad-id '{squad_id}' not found in soccer.json")

    os.makedirs(os.path.join(FACES_DIR, squad_id), exist_ok=True)

    todo = []
    for p in squad.get("lineup", []):
        fid = p.get("id") or p.get("sofascore_id")
        if fid and have_portrait(squad_id, fid):
            continue
        todo.append(p)

    if not todo:
        print(f"{squad['team']} {squad['season']} is already fully populated. 🎉")
        return

    print(f"\n{squad['team']} {squad['season']}  ({squad_id})")
    print(f"  Downloads folder: {DOWNLOADS}")
    print(f"  Missing {len(todo)} portrait(s). Skip with 's', quit with 'q'.\n")

    for i, p in enumerate(todo, 1):
        name = p["name"]
        print(f"[{i}/{len(todo)}] {name}")
        url = open_search(name)
        print(f"  opened  {url}")

        baseline = time.time()  # only accept downloads newer than this moment
        while True:
            cand = wait_for_download(name, baseline)
            cand_path, cand_ext, _ = cand
            cand_name = os.path.basename(cand_path)
            sid = parse_sortitoutsi_id(cand_path)
            sid_str = sid if sid else "?"
            choice = prompt_choice(
                f"  saw '{cand_name}' (id={sid_str}) — accept for {name}? [Y/n/s/q]: ")

            if choice == "y":
                if not sid:
                    print("  filename has no numeric id — skip and pick a clean filename.")
                    baseline = time.time()
                    continue
                dst_ext = cand_ext if cand_ext in (".png", ".webp") else ".png"
                dst = os.path.join(FACES_DIR, squad_id, f"{sid}{dst_ext}")
                shutil.move(cand_path, dst)
                if patch_json(squad_id, name, sid):
                    print(f"  ✓ saved  faces/{squad_id}/{sid}{dst_ext}  +  patched soccer.json id={sid}\n")
                else:
                    print(f"  ✓ saved file but couldn't patch JSON — check player name match\n")
                break
            elif choice == "n":
                print("  rejected — waiting for a different download…")
                baseline = time.time()   # don't re-suggest the same file
                continue
            elif choice == "s":
                print(f"  ⏭  skipped {name}\n")
                break
            elif choice == "q":
                print("  quitting (everything saved so far is committed).")
                return
            else:
                print("  unknown choice; type y, n, s, or q.")

    print("Done.")


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("\ninterrupted — anything already moved is saved.")
