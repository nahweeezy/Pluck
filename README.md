# Pluck · Nahweeezy Squads

A daily squad-builder game. Each round you see a real starting XI from a real match — date, opponent, competition, result — and you pick **one player** to add to your squad. Round by round you fill an 11 + 7-bench formation and end up with a shareable lineup of legends from across two decades of football history.

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

**Portraits are served locally from [`faces/`](faces/), not hotlinked.** SofaScore's image API now returns `403 Forbidden` to hotlinked/runtime/scripted requests (it bot-blocks non-browser clients and datacenter IPs), so the game no longer calls it live. Instead you cache the images once and serve them as static files.

Two ways to populate `faces/` — both download to `faces/{id}.png`, both resumable, both must run from a **normal/residential connection** (cloud/datacenter IPs are blocked):

```
# A) CLI (slow + polite; works if your IP isn't bot-blocked for scripts)
python scripts/fetch_faces.py            # DELAY=2.5 python scripts/fetch_faces.py to go slower

# B) Browser (highest success rate — runs in your real SofaScore session)
#    Open https://www.sofascore.com, DevTools → Console, paste scripts/fetch_faces_browser.js.
#    It zips every portrait → pluck-faces.zip → unzip its contents into faces/.
```

Both read every `sofascore_id` in `soccer.json`. SofaScore aggressively bot-blocks scripted clients, so if the CLI returns a wall of 403s, use route (B) (a real browser session passes their check). Then commit the `faces/` folder. The game loads `faces/{id}.png` same-origin, so there's no CORS taint and the background-removal works on them directly. Missing file → ink-monogram fallback.

> Note: this caches copyrighted SofaScore portraits into the repo — a deliberate choice for this project. If you'd rather not redistribute them, keep `faces/` out of version control and the game simply shows monograms.

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
