// One-off: read players_filled.txt, parse name → SofaScore ID, write IDs into soccer.json.
// Preserves the original compact one-line-per-player JSON style.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TXT  = resolve(ROOT, 'data/players_filled.txt');
const JSON_PATH = resolve(ROOT, 'data/soccer.json');

// Strip diacritics for fuzzy slug-vs-name comparison
const norm = (s) =>
    s.toLowerCase()
     .normalize('NFD').replace(/[̀-ͯ]/g, '')
     .replace(/[^a-z0-9]+/g, '');

// 1. Parse players_filled.txt
const text = readFileSync(TXT, 'utf8');
const nameToInfo = new Map();
for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('#')) continue;
    const barIdx = line.indexOf('|');
    if (barIdx < 0) continue;
    const left  = line.slice(0, barIdx).trim();
    const right = line.slice(barIdx + 1).trim();

    // Strip the [TEAM YEAR] bracket from the left side to get the name
    const bracketIdx = left.indexOf('[');
    const name = (bracketIdx >= 0 ? left.slice(0, bracketIdx) : left).trim();

    if (!right) {
        nameToInfo.set(name, { id: null, blank: true });
        continue;
    }
    // Extract slug + ID from URL, or raw numeric ID
    let id = null, slug = null;
    const urlMatch = right.match(/\/player\/([^/]+)\/(\d+)/);
    if (urlMatch) { slug = urlMatch[1]; id = parseInt(urlMatch[2], 10); }
    else if (/^\d+$/.test(right)) { id = parseInt(right, 10); }
    if (name && id) nameToInfo.set(name, { id, slug });
}

// 2. Load soccer.json and apply IDs
const data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

let applied = 0;
const suspicious = [];
const blanksApplied = [];
const skipped = [];

for (const team of data) {
    for (const p of team.lineup) {
        const info = nameToInfo.get(p.name);
        if (!info) { skipped.push(`${p.name} (${team.team_short} ${team.season}) — not in list`); continue; }
        if (info.blank) { blanksApplied.push(`${p.name} (${team.team_short} ${team.season})`); continue; }
        if (info.id) {
            const prev = p.sofascore_id;
            p.sofascore_id = info.id;
            if (prev !== info.id) applied += 1;
            // Slug check — flag if the URL slug doesn't contain the player's first or last name
            if (info.slug) {
                const slugN = norm(info.slug);
                const parts = p.name.split(/\s+/).filter(w => w.length > 2);
                const first = parts[0] ? norm(parts[0]) : '';
                const last  = parts.length > 1 ? norm(parts[parts.length - 1]) : '';
                const looksOk = (last && slugN.includes(last)) || (first && slugN.includes(first));
                if (!looksOk) {
                    suspicious.push({ name: p.name, slug: info.slug, id: info.id });
                }
            }
        }
    }
}

// 3. Serialize back in compact-player style.
//    Standard JSON.stringify expands each player onto multiple lines; we re-flatten just the
//    player-shaped objects (have "name" + "position" keys) onto one line.
function serializeCompact(obj) {
    const expanded = JSON.stringify(obj, null, 2);
    return expanded.replace(
        /\{\s*\n\s*"name":[\s\S]*?\n\s*\}/g,
        (match) => match.replace(/\s+/g, ' ').replace(/\{ /, '{ ').replace(/ \}$/, ' }')
    );
}

writeFileSync(JSON_PATH, serializeCompact(data) + '\n');

// 4. Dedupe sets and report
const uniqueSuspicious = Array.from(new Map(suspicious.map(s => [s.name, s])).values());
const uniqueBlanks     = Array.from(new Set(blanksApplied));

console.log(JSON.stringify({
    namesInList: nameToInfo.size,
    appliedEntries: applied,
    suspiciousByName: uniqueSuspicious,
    blankByName: uniqueBlanks,
    skippedEntries: skipped,
}, null, 2));
