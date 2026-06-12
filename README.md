# Pluck · Nahweeezy Squads

a daily squad-builder game. each round you see a real starting XI from a real match and you pick **one player** to add to your squad. Round by round you fill an 11 + 7-bench formation and end up with a shareable lineup of legends from across two decades of football history.

It's a ball-knowledge test in game form.

## Stack

Pure static — no build step, no framework. Three files do everything:

- `index.html` — markup
- `squads.css` — dark Opta-style theme, FIFA-card-shaped player tiles, animations
- `squads.js` — game engine: deterministic daily seed, formation layouts, position-picker modal, canvas-based background removal for face images, share-to-X / save-image / copy-summary, local-storage streak

CDN dependencies (no install required): Inter & JetBrains Mono via Google Fonts, Font Awesome 6, `html-to-image` for the shareable PNG export.

## Run locally

It's a static site, so any HTTP server works. Easiest options:

```
# Python
python -m http.server 5173

# Node
npx serve .
```

Then open <http://localhost:5173>.

Opening `index.html` via `file://` doesn't work because the page `fetch()`es JSON from `/data/`, which browsers block on `file://`.

## Data

All match lineups live in [`data/soccer.json`](data/soccer.json). Each entry is a single specific match:

```json
{
  "id": "2019-ucl-final-liverpool",
  "team": "Liverpool",
  "team_short": "LIV",
  "season": "2018-19",
  "formation": "4-3-3",
  "accent": "#c8102e",
  "match": {
    "date": "2019-06-01",
    "competition": "UEFA Champions League Final",
    "opponent": "Tottenham Hotspur",
    "opponent_short": "TOT",
    "venue": "Wanda Metropolitano, Madrid",
    "result": "W 2-0"
  },
  "lineup": [
    { "name": "Alisson", "position": "GK", "number": 1, "sofascore_id": 243609 },
    { "name": "Trent Alexander-Arnold", "position": "RB", "number": 66, "sofascore_id": 795064 }
  ]
}
```

It ships **18 verified UCL Final starting XIs from 2005–2023**, including both sides of the 2013 Bayern–Dortmund and 2019 Liverpool–Tottenham finals. NFL and NBA are scaffolded in [`data/nfl.json`](data/nfl.json) and [`data/nba.json`](data/nba.json) but the gameplay isn't wired up yet — those modes show as "Coming Soon" on the landing page.

### Player faces

When a player has an optional `sofascore_id` field, the game shows that player's portrait inside the card, run through a **canvas flood-fill** from the corners that knocks the white background out to alpha 0 (interior whites — teeth, eye whites, shirts — survive because the flood only spreads through pixels connected to the edges). No `sofascore_id`, or no cached image → the card falls back to a stylized ink monogram of the player's initials.

**Portraits are served locally from [`faces/`](faces/) as static files** — no live API calls (SofaScore's image API now 403s every hotlinked request, including from a real browser on their own site, so it's not usable anymore).

The current pipeline uses **Football Manager facepacks** as the portrait source, organized so that a player who appears in multiple squads can have a **different portrait per match** (a 2005 Riise card and a hypothetical 2017 Riise card can show his face from each era).

### Layout

```
faces/
├── 2005-ucl-final-liverpool/    ← squad-specific portraits for this match
│   ├── 44897.webp               ← Dudek as he was in 2005
│   ├── 108658.png               ← Gerrard 2005
│   └── …
├── 2019-ucl-final-liverpool/
│   └── …                        ← e.g. Henderson, Salah — distinct from any defaults
├── 108658.png                   ← shared default for Gerrard (any squad without an override)
└── …
```

### Engine lookup order, per (squad, player)

1. `faces/{squad-id}/{player-id}.png`  ← squad-specific portrait (preferred)
2. `faces/{squad-id}/{player-id}.webp`
3. `faces/{player-id}.png`             ← shared default (any squad)
4. `faces/{player-id}.webp`
5. Ink monogram

**You only duplicate when you actually have era-specific photos.** If you only ever source one Gerrard photo, drop it at `faces/108658.png` and it'll serve every Gerrard card. The day you find a different photo for a specific season, drop it at `faces/{squad-id}/108658.png` and just that squad uses it.

### Fast workflow: `scripts/source_faces.py`  (recommended)

Picks the era-matching face on [sortitoutsi.net](https://sortitoutsi.net/graphics/) manually (irreducible — the year-correct choice needs human judgment) and lets the script handle everything else.

```
python scripts/source_faces.py                       # list squads (✓ = fully populated)
python scripts/source_faces.py 2008-ucl-final-man-united
```

For each missing player in that squad, the script:

1. Opens `sortitoutsi.net/graphics/?q=<name>` in your default browser.
2. Watches your `~/Downloads` folder for a new PNG/webp.
3. When you save a face from sortitoutsi (their filenames are already `{id}.png`), it parses the ID, asks for a one-key confirmation, then **moves the file into `faces/<squad-id>/<id>.{ext}` and patches `soccer.json` with `"id": <id>`** for that player.
4. Continues to the next missing player.

Per-player cost: ~25 seconds (your judgment on which face is era-correct + one Enter). Resumable, skippable (`s` to skip, `q` to quit), and never touches players who already have a portrait.

The Downloads folder defaults to `~/Downloads` but you can override with `DOWNLOADS=/some/path python scripts/source_faces.py …`.

### Manual workflow (also supported)

If you already have a stash of files you'd rather drop in by hand:

1. In [`data/soccer.json`](data/soccer.json), set `"id": <FM UID>` on each player you're populating.
2. Drop the files into either:
   - **`faces/rename/<squad-id>/<player-id>.png`** for squad-specific portraits, *or*
   - **`faces/rename/<player-id>.png`** (no subfolder) for shared defaults.
3. Run `python scripts/install_faces.py` — moves files into `faces/` and prints a per-squad checklist of who's still missing.

The engine probes `.png` then `.webp` at each level — FM facepacks ship both formats, both work, no conversion needed. Missing file → ink-monogram fallback. The game never breaks for absent portraits.

> Note: portraits are off by default. The cover has a `Portraits Off / On` toggle (the OFF default ships consistent monogram cards regardless of how populated `faces/` is); flip it on once the dataset has full coverage. The preference persists in `localStorage`.

> Note: FM facepack images are user-redistributable but copyrighted. If you'd rather not commit them, gitignore `faces/` and the game cleanly shows monograms.

To find a player's SofaScore ID, open their page on <https://www.sofascore.com> — the URL ends with the numeric ID, e.g. `/football/player/cristiano-ronaldo/750` → `750`.

### Bulk-applying IDs from a list

[`scripts/apply_sofascore_ids.mjs`](scripts/apply_sofascore_ids.mjs) reads [`data/players_filled.txt`](data/players_filled.txt) (one player per line, with a SofaScore URL after `|`) and writes the IDs back into `soccer.json` while preserving the compact one-line-per-player formatting:

```
node scripts/apply_sofascore_ids.mjs
```

## Daily seed

The same 18 matches are shown to everyone on a given day. The seed is `mulberry32(hash("soccer:YYYY-MM-DD"))` and the reset boundary is approximately midnight EST. "Unlimited" mode uses a non-deterministic seed for free play after you've finished the daily.

## Game flow

1. Pick your formation up front (4-3-3, 4-2-3-1, 4-4-2, 3-5-2, etc. — 8 options).
2. Each round shows one team's real starting XI plus the match metadata. Tap any player.
3. A modal opens with **your squad in progress** — empty formation slots plus the 7 bench cells. The slot matching the player's natural position pulses; you can drop them anywhere though.
4. After 18 rounds (11 starters + 7 bench) the final screen shows your full squad, era/league/streak stats, and three share options: save as image, share to X, or copy a text summary.

## Roadmap

- More starting XIs — domestic title-clinchers, World Cup finals, classic semi-finals, deep cuts beyond CL finals
- More SofaScore IDs filled in (see `data/players.txt` for the deduplicated player list — designed for adding URLs in bulk)
- NFL and NBA gameplay wired up against the existing data scaffolds
- Profiles / shareable public squad URLs (would need a small backend)

## Credits

Player portraits fetched live from the SofaScore image API. Players' SofaScore IDs are stored in `data/soccer.json`; the images themselves are not redistributed in this repo.
