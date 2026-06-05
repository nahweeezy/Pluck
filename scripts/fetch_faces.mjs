#!/usr/bin/env node
/* ============================================================
   Pluck · one-time player-portrait cache
   ------------------------------------------------------------
   SofaScore now 403-blocks hotlinked image requests at runtime,
   so instead of the game calling their API live, we download each
   player's portrait ONCE and serve it locally from /faces/{id}.png.

   Run this on a normal (residential) connection — datacenter / cloud
   IPs are the ones SofaScore blocks:

       node scripts/fetch_faces.mjs

   • Reads every sofascore_id in data/soccer.json (deduped).
   • Fetches one image at a time with a delay, so it never trips
     the rate-limiter. Tune with DELAY_MS, e.g.:
         DELAY_MS=700 node scripts/fetch_faces.mjs
   • Resumable: a player whose faces/{id}.png already exists is
     skipped, so you can stop/rerun freely.
   • Saves the RAW image; the game does the white-background
     flood-fill in the browser (works because the file is now
     same-origin, so the canvas isn't CORS-tainted).

   After it finishes:  git add faces && git commit && git push
   ============================================================ */

import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT      = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'data', 'soccer.json');
const FACES_DIR = join(ROOT, 'faces');
const DELAY_MS  = Number(process.env.DELAY_MS || 450);

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.sofascore.com/',
    'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileReady = async (p) => { try { return (await stat(p)).size > 0; } catch { return false; } };

const teams = JSON.parse(await readFile(DATA_FILE, 'utf8'));
const ids = [...new Set(
    teams.flatMap((t) => (t.lineup || []).map((p) => p.sofascore_id).filter(Boolean))
)];

await mkdir(FACES_DIR, { recursive: true });

let fetched = 0, skipped = 0;
const failed = [];

console.log(`Pluck face cache · ${ids.length} unique player IDs · ${DELAY_MS}ms between requests\n`);

for (let i = 0; i < ids.length; i++) {
    const id  = ids[i];
    const out = join(FACES_DIR, `${id}.png`);
    const tag = `[${String(i + 1).padStart(3)}/${ids.length}]`;

    if (await fileReady(out)) { skipped++; continue; }

    const url = `https://api.sofascore.com/api/v1/player/${id}/image`;
    try {
        const res = await fetch(url, { headers: HEADERS });
        const ct  = res.headers.get('content-type') || '';
        if (!res.ok || !ct.startsWith('image/')) {
            failed.push(`${id} — HTTP ${res.status} (${ct || 'no content-type'})`);
            console.log(`${tag} ✗ ${id}  HTTP ${res.status}`);
        } else {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 200) {
                failed.push(`${id} — suspiciously small (${buf.length}b)`);
                console.log(`${tag} ✗ ${id}  tiny (${buf.length}b)`);
            } else {
                await writeFile(out, buf);
                fetched++;
                console.log(`${tag} ✓ ${id}.png  (${(buf.length / 1024).toFixed(1)} KB)`);
            }
        }
    } catch (e) {
        failed.push(`${id} — ${e.message}`);
        console.log(`${tag} ✗ ${id}  ${e.message}`);
    }

    await sleep(DELAY_MS);
}

console.log(`\nDone.  fetched=${fetched}  skipped=${skipped}  failed=${failed.length}`);
if (failed.length) {
    console.log('\nFailures (these players keep the monogram fallback in-game):');
    for (const f of failed) console.log('  ' + f);
    console.log('\nIf MANY failed with HTTP 403, your IP is being rate-limited — rerun');
    console.log('later with a bigger delay, e.g.  DELAY_MS=1200 node scripts/fetch_faces.mjs');
    console.log('(it resumes where it left off).');
}
