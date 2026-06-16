/* ════════════════════════════════════════════════════════════════
   PLUCK · Nahweeezy Squads — client engine (v3, editorial).
   Pure browser JS, no build step. Loads /data/<sport>.json and runs
   the teamsheet-draft: each round you pluck one name from a real XI
   and drop it onto your squad pitch. No duplicate picks; rearrange
   before the final reveal.
   ════════════════════════════════════════════════════════════════ */

(() => {
    'use strict';

    // ── Config ────────────────────────────────────────────────────

    const SPORT_CONFIG = {
        soccer: {
            label: 'World Soccer',
            file: 'data/soccer.json',
            totalRounds: 18,
            startersCount: 11,
            benchCount: 7,
            leagueLabels: {
                premier_league:  'Premier League',
                la_liga:         'La Liga',
                bundesliga:      'Bundesliga',
                serie_a:         'Serie A',
                ligue_1:         'Ligue 1',
                world_cup:       'World Cup',
                championship:    'Championship',
                coupe_de_france: 'Coupe de France',
                champions_league:'Champions League',
                fa_cup:          'FA Cup',
            },
        },
    };

    const STORAGE_KEY = 'nahweeezy-squads-v2';
    const RESET_TZ = 'America/New_York';

    // ── DOM helpers ──────────────────────────────────────────────

    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, txt) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (txt !== undefined) n.textContent = txt;
        return n;
    };

    function initialsOf(name) {
        if (!name) return '';
        const parts = name.split(/\s+/).filter(Boolean);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    function lastNameOf(name) {
        const parts = (name || '').replace(/[’]/g, "'").split(/\s+/).filter(Boolean);
        return parts.length ? parts[parts.length - 1] : (name || '');
    }
    // Normalised identity for dedup: lowercase, strip accents/punctuation.
    function normName(name) {
        return (name || '')
            .toLowerCase()
            .normalize('NFKD').replace(/[̀-ͯ]/g, '')
            .replace(/['’.\-]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Position synonyms — common alternate codes that resolve to the engine's
    // canonical position for matching, display, and scoring. Add aliases here
    // as data conventions grow (e.g. CF -> ST if you ever use CF in source data).
    const POS_ALIASES = {
        CDM: 'DM',
        RCB: 'CB',
        LCB: 'CB',
        RAM: 'CAM',
        LAM: 'CAM',
    };
    function normalizePos(pos) {
        if (!pos) return pos;
        return POS_ALIASES[pos] || pos;
    }

    // ── Background removal for SofaScore headshots ───────────────
    // Flood-fill from the four edges, knocking near-white pixels to alpha 0.
    // Interior whites (teeth, shirts) survive because they aren't connected
    // to the border. Then soften the boundary so it isn't jaggy.

    const FACE_CACHE = new Map(); // url -> Promise<dataUrl|null>

    function loadImageCors(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.referrerPolicy = 'no-referrer';
            img.onload  = () => resolve(img);
            img.onerror = (e) => reject(e);
            img.src = url;
        });
    }

    function removeBackground(imgData, {
        seedThreshold   = 232,
        spreadThreshold = 215,
        edgeFadeFrom    = 180,
    } = {}) {
        const { data, width, height } = imgData;
        const N = width * height;
        const flagged = new Uint8Array(N);

        const luma = (i) => (data[i] + data[i + 1] + data[i + 2]) / 3;

        const stack = [];
        const seed = (x, y) => {
            const p = y * width + x;
            if (flagged[p]) return;
            if (luma(p << 2) < seedThreshold) return;
            stack.push(x, y);
        };
        for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
        for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }

        while (stack.length) {
            const y = stack.pop();
            const x = stack.pop();
            const p = y * width + x;
            if (flagged[p]) continue;
            const i = p << 2;
            if (luma(i) < spreadThreshold) continue;
            flagged[p] = 1;
            if (x > 0)          stack.push(x - 1, y);
            if (x < width - 1)  stack.push(x + 1, y);
            if (y > 0)          stack.push(x, y - 1);
            if (y < height - 1) stack.push(x, y + 1);
        }

        for (let p = 0; p < N; p++) {
            if (flagged[p]) data[(p << 2) + 3] = 0;
        }

        const range = 255 - edgeFadeFrom;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = y * width + x;
                if (flagged[p]) continue;
                const left  = x > 0          && flagged[p - 1];
                const right = x < width - 1  && flagged[p + 1];
                const up    = y > 0          && flagged[p - width];
                const down  = y < height - 1 && flagged[p + width];
                if (!(left || right || up || down)) continue;
                const i = p << 2;
                const L = luma(i);
                if (L <= edgeFadeFrom) continue;
                const keep = 1 - (L - edgeFadeFrom) / range;
                data[i + 3] = Math.round(data[i + 3] * Math.max(0, keep));
            }
        }
    }

    // Probe a list of candidate URLs for an image; first one that loads wins.
    // Returns the loaded HTMLImageElement, or null if none did.
    async function loadFirstAvailable(urls) {
        for (const u of urls) {
            try {
                const img = await loadImageCors(u);
                if (img && img.naturalWidth) return img;
            } catch (_) { /* try next */ }
        }
        return null;
    }

    // Look up a player's portrait, optionally squad-specific.
    //
    // Probes (in order):
    //   1. faces/{squadId}/{playerId}.png    — squad-specific override
    //   2. faces/{squadId}/{playerId}.webp
    //   3. faces/{playerId}.png              — shared default
    //   4. faces/{playerId}.webp
    //
    // Cache key includes squadId so the same playerId rendered for two
    // different squads gets two distinct cached portraits — no accidental
    // cross-pollination when a player appears in multiple matches.
    async function prepareTransparentFace(playerId, squadId) {
        const key = `${squadId || ''}|${playerId}`;
        if (FACE_CACHE.has(key)) return FACE_CACHE.get(key);
        const id = String(playerId);
        const candidates = [];
        if (squadId) {
            candidates.push(`faces/${squadId}/${id}.png`);
            candidates.push(`faces/${squadId}/${id}.webp`);
        }
        candidates.push(`faces/${id}.png`);
        candidates.push(`faces/${id}.webp`);
        const promise = (async () => {
            const img = await loadFirstAvailable(candidates);
            if (!img) return null;
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) return null;
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: false });
            ctx.drawImage(img, 0, 0);
            let pixels;
            try { pixels = ctx.getImageData(0, 0, w, h); }
            catch (e) { return null; }
            removeBackground(pixels);
            ctx.putImageData(pixels, 0, 0);
            return canvas.toDataURL('image/png');
        })();
        FACE_CACHE.set(key, promise);
        return promise;
    }

    // Chalk-on-paper pitch markings (vertical, attack toward the top).
    // Stroke colour is hard-coded (not a CSS var) so the html-to-image
    // export of the reveal card renders the lines reliably.
    const PITCH_LINES_SVG =
        '<svg class="pitch-lines" viewBox="0 0 68 100" preserveAspectRatio="none" aria-hidden="true">' +
          '<g fill="none" stroke="rgba(24,20,16,0.22)" stroke-width="0.4" stroke-linejoin="round">' +
            '<rect x="1.5" y="1.5" width="65" height="97"/>' +
            '<line x1="1.5" y1="50" x2="66.5" y2="50"/>' +
            '<circle cx="34" cy="50" r="9"/>' +
            '<rect x="20" y="1.5" width="28" height="14"/>' +
            '<rect x="27" y="1.5" width="14" height="5"/>' +
            '<path d="M 25 15.5 A 9 9 0 0 0 43 15.5"/>' +
            '<rect x="20" y="84.5" width="28" height="14"/>' +
            '<rect x="27" y="93.5" width="14" height="5"/>' +
            '<path d="M 25 84.5 A 9 9 0 0 1 43 84.5"/>' +
          '</g>' +
          '<g fill="rgba(24,20,16,0.30)" stroke="none">' +
            '<circle cx="34" cy="50" r="0.7"/>' +
            '<circle cx="34" cy="11" r="0.7"/>' +
            '<circle cx="34" cy="89" r="0.7"/>' +
          '</g>' +
        '</svg>';
    function pitchLines() {
        const t = document.createElement('template');
        t.innerHTML = PITCH_LINES_SVG;
        return t.content.firstElementChild;
    }

    // Editorial player card: paper tile, accent bar, number/pos, a crest
    // (SofaScore face cutout when available, monogram initials otherwise),
    // and the surname. Always a non-interactive <div> — placement happens
    // by clicking the slot, not the card.
    function buildPlayerCard(player, team) {
        const card = el('div', 'pcard');
        card.title = player.name;
        // Club colour drives the cursor-tracking specular spotlight + hover glow.
        if (team && team.accent) card.style.setProperty('--club', team.accent);

        const accent = el('div', 'pc-accent');
        accent.style.background = (team && team.accent) || 'var(--ink)';
        card.appendChild(accent);

        const top = el('div', 'pc-top');
        top.appendChild(el('span', 'pc-num num', player.number != null ? String(player.number) : '–'));

        // Source-match context: which team this card "is" + its season.
        // Stacked compact in the middle of the top bar so the user can tell
        // their City Mahrez (2019-20) from their Leicester Mahrez (2015-16).
        if (team && (team.team_short || team.season)) {
            const meta = el('div', 'pc-meta');
            if (team.team_short) meta.appendChild(el('span', 'pc-team', team.team_short));
            if (team.season)     meta.appendChild(el('span', 'pc-year', team.season));
            top.appendChild(meta);
        }

        top.appendChild(el('span', 'pc-pos', player.position || ''));
        card.appendChild(top);

        const crest = el('div', 'pc-crest');
        const ini = el('span', 'mono-initials', initialsOf(player.name));
        crest.appendChild(ini);
        // Portraits live in faces/[{squad-id}/]{id}.{png|webp} as same-origin
        // static files. Engine looks at player.id (FM facepack UID), tries the
        // squad-specific portrait first (faces/{squad-id}/{id}.{ext}) so a
        // player who shows up in multiple matches can have a different face
        // per-era, and falls back to the shared default (faces/{id}.{ext}) or
        // ink monogram. player.sofascore_id is the legacy field for entries
        // not yet migrated.
        const faceId = player.id || player.sofascore_id;
        if (faceId) {
            const img = document.createElement('img');
            img.className = 'pc-face';
            img.alt = player.name;
            img.decoding = 'async';
            img.referrerPolicy = 'no-referrer';
            img.addEventListener('load', () => crest.classList.add('has-face'));
            img.addEventListener('error', () => img.remove());
            crest.appendChild(img);
            prepareTransparentFace(faceId, team && team.id).then((processed) => {
                if (processed) img.src = processed;
                else           img.remove();
            }).catch(() => img.remove());
        }
        card.appendChild(crest);

        card.appendChild(el('div', 'pc-name', lastNameOf(player.name)));
        attachCardFx(card);
        return card;
    }

    // Cursor-reactive foil: writes --mx/--my (specular + sheen position) and
    // --tx/--ty (3D tilt) as the pointer moves over a card. rAF-throttled so
    // pointermove never thrashes layout. Consumed by the .pcard hover CSS.
    function attachCardFx(card) {
        const MAX_TILT = 11; // degrees
        let raf = 0, mx = 50, my = 50, tx = 0, ty = 0;
        const apply = () => {
            raf = 0;
            card.style.setProperty('--mx', mx.toFixed(1) + '%');
            card.style.setProperty('--my', my.toFixed(1) + '%');
            card.style.setProperty('--tx', tx.toFixed(2) + 'deg');
            card.style.setProperty('--ty', ty.toFixed(2) + 'deg');
        };
        card.addEventListener('pointermove', (e) => {
            const r = card.getBoundingClientRect();
            if (!r.width || !r.height) return;
            const px = (e.clientX - r.left) / r.width;   // 0..1 across
            const py = (e.clientY - r.top) / r.height;   // 0..1 down
            mx = Math.max(0, Math.min(100, px * 100));
            my = Math.max(0, Math.min(100, py * 100));
            ty = (px - 0.5) * 2 * MAX_TILT;   // cursor right → tilt right
            tx = (0.5 - py) * 2 * MAX_TILT;   // cursor up → tilt back
            if (!raf) raf = requestAnimationFrame(apply);
        });
        card.addEventListener('pointerleave', () => {
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            card.style.setProperty('--mx', '50%');
            card.style.setProperty('--my', '50%');
            card.style.setProperty('--tx', '0deg');
            card.style.setProperty('--ty', '0deg');
        });
    }

    // ── Deterministic RNG (mulberry32) seeded by daily key ───────

    function hashString(s) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function shuffleWithRng(arr, rng) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // ── Daily key & timer (DST-aware, no hard-coded offset) ──────

    function zonedParts(now = new Date()) {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: RESET_TZ, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        const p = {};
        for (const { type, value } of dtf.formatToParts(now)) p[type] = value;
        const hh = p.hour === '24' ? 0 : parseInt(p.hour, 10);
        return { y: +p.year, m: +p.month, d: +p.day, hh, mm: +p.minute, ss: +p.second };
    }
    function getDailyKey(now = new Date()) {
        const { y, m, d } = zonedParts(now);
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    function msUntilNextReset(now = new Date()) {
        const { hh, mm, ss } = zonedParts(now);
        const secsLeft = 86400 - (hh * 3600 + mm * 60 + ss);
        return secsLeft * 1000 - now.getMilliseconds();
    }
    function formatHMS(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        const h = String(Math.floor(s / 3600)).padStart(2, '0');
        const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const sec = String(s % 60).padStart(2, '0');
        return `${h}:${m}:${sec}`;
    }
    // All three formatters build the Date from Date.UTC() so we treat the
    // YYYY-MM-DD as a pure calendar date (no time-of-day). We MUST also pin
    // toLocaleDateString to UTC, otherwise a viewer in a negative offset
    // (the Americas) sees the date shift back a day.
    function formatHumanDate(key) {
        const [y, m, d] = key.split('-').map(Number);
        const date = new Date(Date.UTC(y, m - 1, d));
        return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    function formatCoverDate(key) {
        const [y, m, d] = key.split('-').map(Number);
        const date = new Date(Date.UTC(y, m - 1, d));
        return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
    }
    function formatMatchDate(iso) {
        if (!iso) return '';
        const [y, m, d] = iso.split('-').map(Number);
        const date = new Date(Date.UTC(y, m - 1, d));
        return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
    }
    function editionNumber(key) {
        const [y, m, d] = key.split('-').map(Number);
        const days = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(2024, 11, 1)) / 86400000);
        return 200 + days;
    }

    // ── Persistent state ─────────────────────────────────────────

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return defaultState();
            return Object.assign(defaultState(), JSON.parse(raw));
        } catch (e) { return defaultState(); }
    }
    function defaultState() {
        return { streak: 0, lastPlayedKey: null, completed: {} };
    }
    function saveState(s) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) {}
    }
    function updateStreakOnCompletion(s, todayKey) {
        if (s.lastPlayedKey === todayKey) return s;
        const [y, m, d] = todayKey.split('-').map(Number);
        const t = new Date(Date.UTC(y, m - 1, d));
        t.setUTCDate(t.getUTCDate() - 1);
        const yesterday = `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}`;
        s.streak = s.lastPlayedKey === yesterday ? (s.streak + 1) : 1;
        s.lastPlayedKey = todayKey;
        return s;
    }

    // ── Soccer formation layouts (% top, left from top-left) ─────

    const FORMATIONS = {
        '4-3-3': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 12, pos: ['LB','LWB'] },
            { top: 75, left: 36, pos: ['CB'] },
            { top: 75, left: 64, pos: ['CB'] },
            { top: 75, left: 88, pos: ['RB','RWB'] },
            { top: 52, left: 25, pos: ['CM','DM'] },
            { top: 52, left: 50, pos: ['DM','CM'] },
            { top: 52, left: 75, pos: ['CM','CAM'] },
            { top: 25, left: 18, pos: ['LW','LM'] },
            { top: 18, left: 50, pos: ['ST','CF'] },
            { top: 25, left: 82, pos: ['RW','RM'] },
        ],
        '4-4-2': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 12, pos: ['LB','LWB'] },
            { top: 75, left: 36, pos: ['CB'] },
            { top: 75, left: 64, pos: ['CB'] },
            { top: 75, left: 88, pos: ['RB','RWB'] },
            { top: 50, left: 12, pos: ['LM','LW'] },
            { top: 50, left: 36, pos: ['CM','DM'] },
            { top: 50, left: 64, pos: ['CM','CAM'] },
            { top: 50, left: 88, pos: ['RM','RW'] },
            { top: 22, left: 36, pos: ['ST','CF'] },
            { top: 22, left: 64, pos: ['ST','CF'] },
        ],
        '4-2-3-1': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 12, pos: ['LB','LWB'] },
            { top: 75, left: 36, pos: ['CB'] },
            { top: 75, left: 64, pos: ['CB'] },
            { top: 75, left: 88, pos: ['RB','RWB'] },
            { top: 56, left: 36, pos: ['DM','CM'] },
            { top: 56, left: 64, pos: ['DM','CM'] },
            { top: 34, left: 15, pos: ['LW','LM'] },
            { top: 34, left: 50, pos: ['CAM','CM'] },
            { top: 34, left: 85, pos: ['RW','RM'] },
            { top: 14, left: 50, pos: ['ST','CF'] },
        ],
        '4-3-2-1': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 12, pos: ['LB','LWB'] },
            { top: 75, left: 36, pos: ['CB'] },
            { top: 75, left: 64, pos: ['CB'] },
            { top: 75, left: 88, pos: ['RB','RWB'] },
            { top: 56, left: 25, pos: ['CM'] },
            { top: 56, left: 50, pos: ['DM','CM'] },
            { top: 56, left: 75, pos: ['CM'] },
            { top: 32, left: 32, pos: ['CAM'] },
            { top: 32, left: 68, pos: ['CAM'] },
            { top: 14, left: 50, pos: ['ST','CF'] },
        ],
        '3-5-2': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 25, pos: ['CB'] },
            { top: 75, left: 50, pos: ['CB'] },
            { top: 75, left: 75, pos: ['CB'] },
            { top: 52, left: 8,  pos: ['LWB','LB','LM'] },
            { top: 52, left: 32, pos: ['CM'] },
            { top: 52, left: 50, pos: ['DM','CM'] },
            { top: 52, left: 68, pos: ['CM'] },
            { top: 52, left: 92, pos: ['RWB','RB','RM'] },
            { top: 22, left: 36, pos: ['ST','CF'] },
            { top: 22, left: 64, pos: ['ST','CF'] },
        ],
        '3-4-3': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 25, pos: ['CB'] },
            { top: 75, left: 50, pos: ['CB'] },
            { top: 75, left: 75, pos: ['CB'] },
            { top: 52, left: 12, pos: ['LWB','LB','LM'] },
            { top: 52, left: 38, pos: ['CM'] },
            { top: 52, left: 62, pos: ['CM','DM'] },
            { top: 52, left: 88, pos: ['RWB','RB','RM'] },
            { top: 22, left: 18, pos: ['LW','LM'] },
            { top: 14, left: 50, pos: ['ST','CF'] },
            { top: 22, left: 82, pos: ['RW','RM'] },
        ],
        '3-4-2-1': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 25, pos: ['CB'] },
            { top: 75, left: 50, pos: ['CB'] },
            { top: 75, left: 75, pos: ['CB'] },
            { top: 54, left: 10, pos: ['LWB','LB','LM'] },
            { top: 54, left: 38, pos: ['CM','DM'] },
            { top: 54, left: 62, pos: ['CM','DM'] },
            { top: 54, left: 90, pos: ['RWB','RB','RM'] },
            { top: 30, left: 32, pos: ['CAM'] },
            { top: 30, left: 68, pos: ['CAM'] },
            { top: 14, left: 50, pos: ['ST','CF'] },
        ],
        '4-4-1-1': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 12, pos: ['LB','LWB'] },
            { top: 75, left: 36, pos: ['CB'] },
            { top: 75, left: 64, pos: ['CB'] },
            { top: 75, left: 88, pos: ['RB','RWB'] },
            { top: 52, left: 12, pos: ['LM','LW'] },
            { top: 52, left: 36, pos: ['CM','DM'] },
            { top: 52, left: 64, pos: ['CM','CAM'] },
            { top: 52, left: 88, pos: ['RM','RW'] },
            { top: 30, left: 50, pos: ['CAM','SS'] },
            { top: 14, left: 50, pos: ['ST','CF'] },
        ],
        '4-1-4-1': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 12, pos: ['LB','LWB'] },
            { top: 75, left: 36, pos: ['CB'] },
            { top: 75, left: 64, pos: ['CB'] },
            { top: 75, left: 88, pos: ['RB','RWB'] },
            { top: 56, left: 50, pos: ['DM','CM'] },
            { top: 36, left: 12, pos: ['LM','LW'] },
            { top: 36, left: 38, pos: ['CM','CAM'] },
            { top: 36, left: 62, pos: ['CM','CAM'] },
            { top: 36, left: 88, pos: ['RM','RW'] },
            { top: 16, left: 50, pos: ['ST','CF'] },
        ],
        '5-4-1': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 70, left: 10, pos: ['LWB','LB'] },
            { top: 75, left: 30, pos: ['CB'] },
            { top: 75, left: 50, pos: ['CB'] },
            { top: 75, left: 70, pos: ['CB'] },
            { top: 70, left: 90, pos: ['RWB','RB'] },
            { top: 42, left: 14, pos: ['LM','LW'] },
            { top: 42, left: 38, pos: ['CM','DM'] },
            { top: 42, left: 62, pos: ['CM','DM'] },
            { top: 42, left: 86, pos: ['RM','RW'] },
            { top: 16, left: 50, pos: ['ST','CF'] },
        ],
        '3-1-4-2': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 25, pos: ['CB'] },
            { top: 75, left: 50, pos: ['CB'] },
            { top: 75, left: 75, pos: ['CB'] },
            { top: 58, left: 50, pos: ['DM','CM'] },
            { top: 38, left: 12, pos: ['LM','LW','LWB','LB'] },
            { top: 38, left: 38, pos: ['CM','CAM'] },
            { top: 38, left: 62, pos: ['CM','CAM'] },
            { top: 38, left: 88, pos: ['RM','RW','RWB','RB'] },
            { top: 16, left: 36, pos: ['ST','CF'] },
            { top: 16, left: 64, pos: ['ST','CF'] },
        ],
        '4-2-2-2': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 12, pos: ['LB','LWB'] },
            { top: 75, left: 36, pos: ['CB'] },
            { top: 75, left: 64, pos: ['CB'] },
            { top: 75, left: 88, pos: ['RB','RWB'] },
            { top: 54, left: 36, pos: ['DM','CM'] },
            { top: 54, left: 64, pos: ['DM','CM'] },
            { top: 34, left: 30, pos: ['CAM','LM','LW'] },
            { top: 34, left: 70, pos: ['CAM','RM','RW'] },
            { top: 16, left: 36, pos: ['ST','CF'] },
            { top: 16, left: 64, pos: ['ST','CF'] },
        ],
        '4-5-1': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 12, pos: ['LB','LWB'] },
            { top: 75, left: 36, pos: ['CB'] },
            { top: 75, left: 64, pos: ['CB'] },
            { top: 75, left: 88, pos: ['RB','RWB'] },
            { top: 50, left: 12, pos: ['LM','LW'] },
            { top: 50, left: 33, pos: ['CM','DM'] },
            { top: 42, left: 50, pos: ['CAM','SS','CM'] },
            { top: 50, left: 67, pos: ['CM','CAM'] },
            { top: 50, left: 88, pos: ['RM','RW'] },
            { top: 18, left: 50, pos: ['ST','CF'] },
        ],
        '3-5-1-1': [
            { top: 92, left: 50, pos: ['GK'] },
            { top: 75, left: 25, pos: ['CB'] },
            { top: 75, left: 50, pos: ['CB'] },
            { top: 75, left: 75, pos: ['CB'] },
            { top: 54, left: 10, pos: ['LWB','LB','LM'] },
            { top: 54, left: 33, pos: ['CM','DM'] },
            { top: 54, left: 50, pos: ['CM','DM','CAM'] },
            { top: 54, left: 67, pos: ['CM','CAM'] },
            { top: 54, left: 90, pos: ['RWB','RB','RM'] },
            { top: 32, left: 50, pos: ['SS','CAM','CM'] },
            { top: 14, left: 50, pos: ['ST','CF'] },
        ],
    };
    const FORMATION_ORDER = ['4-3-3','4-2-3-1','4-4-2','4-3-2-1','4-1-4-1','4-4-1-1','4-2-2-2','4-5-1','3-5-2','3-5-1-1','3-4-3','3-4-2-1','3-1-4-2','5-4-1'];
    const FALLBACK_FORMATION = '4-3-3';
    const layoutForFormation = (f) => FORMATIONS[f] || FORMATIONS[FALLBACK_FORMATION];
    const slotFits = (playerPos, slotPosArr) => !!playerPos && slotPosArr.includes(playerPos);

    // ── Game state ───────────────────────────────────────────────

    const game = {
        sport: 'soccer',
        mode: 'daily',
        formation: '4-3-3',
        teams: null,
        sequence: [],
        roundIdx: 0,
        squad: { starters: [], bench: [] }, // arrays of { pick, team } | null
        finished: false,
        pendingPick: null,                  // { pick, team } awaiting placement
        config: SPORT_CONFIG.soccer,
    };

    let state = loadState();
    let soccerData = null;       // cached dataset
    let selectedFormation = null; // formation-select screen tentative pick
    let lastDrop = null;          // { where, idx } for drop animation
    let editSrc = null;           // finalize: { where, idx } selected to move
    let resetTimerInterval = null;

    function freshSquad(starters = 11, bench = 7) {
        return { starters: new Array(starters).fill(null), bench: new Array(bench).fill(null) };
    }
    function squadCount(s = game.squad) {
        return s.starters.filter(Boolean).length + s.bench.filter(Boolean).length;
    }
    function allPicks(s = game.squad) {
        const a = [];
        s.starters.forEach((v, i) => { if (v) a.push({ slot: 'starter', idx: i, ...v }); });
        s.bench.forEach((v, i)    => { if (v) a.push({ slot: 'bench',   idx: i, ...v }); });
        return a;
    }
    function draftedNameSet() {
        return new Set(allPicks().map(p => normName(p.pick.name)));
    }

    // ── Data loading ─────────────────────────────────────────────

    async function loadSport(sport) {
        const cfg = SPORT_CONFIG[sport];
        if (!cfg) throw new Error(`Unknown sport: ${sport}`);
        const res = await fetch(cfg.file, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`Failed to load ${cfg.file}`);
        const data = await res.json();
        // Resolve position synonyms once at the boundary so the rest of the
        // engine (slot fit, source XI assignment, scoring, display) sees only
        // canonical codes. CDM -> DM today; more aliases can be added above.
        (data || []).forEach(team => {
            (team.lineup || []).forEach(p => {
                if (p && p.position) p.position = normalizePos(p.position);
            });
        });
        return data;
    }

    function buildSequence(teams, sport, mode, totalRounds) {
        const seed = mode === 'daily'
            ? `${sport}:${getDailyKey()}`
            : `${sport}:unlimited:${Date.now()}:${Math.random()}`;
        const rng = mulberry32(hashString(seed));
        return shuffleWithRng(teams, rng).slice(0, Math.min(totalRounds, teams.length));
    }

    // ── Screen switching ─────────────────────────────────────────

    const SCREENS = {
        Cover: 'screenCover', Formation: 'screenFormation',
        Game: 'screenGame', Finalize: 'screenFinalize', Result: 'screenResult',
    };
    function showScreen(name) {
        const targetId = SCREENS[name];
        Object.values(SCREENS).forEach(id => { const n = $(id); if (n) n.hidden = (id !== targetId); });
        const stage = $(targetId)?.querySelector('.stage');
        if (stage) stage.scrollTop = 0;
    }

    function toast(msg) {
        const t = $('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove('show'), 2200);
    }

    // ── Cover ────────────────────────────────────────────────────

    function renderCover() {
        const key = getDailyKey();
        $('coverEdition').textContent = editionNumber(key);
        $('coverDate').textContent = formatCoverDate(key);
        $('coverStreak').textContent = `${state.streak || 0} ${(state.streak || 0) === 1 ? 'Day' : 'Days'}`;
        if (soccerData) {
            $('coverSquadCount').textContent = soccerData.length;
            // Unique players across every team's lineup, name-normalised so the
            // same player appearing in multiple matches counts once.
            const players = new Set();
            soccerData.forEach(t => (t.lineup || []).forEach(p => {
                if (p && p.name) players.add(normName(p.name));
            }));
            $('coverPlayerCount').textContent = players.size;
            $('coverLeagueCount').textContent = new Set(soccerData.map(t => t.league).filter(Boolean)).size;
        }
        const playedToday = !!state.completed[`soccer:${key}`];
        const playBtn = $('playBtn');
        if (game.mode === 'unlimited') {
            playBtn.firstChild.textContent = 'Play Unlimited ';
        } else {
            playBtn.firstChild.textContent = playedToday ? "Replay Today's XI " : "Play Today's XI ";
        }
        updateResetTimer();
    }

    function updateResetTimer() {
        const node = $('coverReset');
        if (!node) return;
        node.textContent = game.mode === 'daily'
            ? `RESETS IN ${formatHMS(msUntilNextReset())}`
            : 'FREE PLAY · UNLIMITED';
    }

    // ── Formation select ─────────────────────────────────────────

    function formationDiagram(formation) {
        const wrap = el('div', 'fc-pitch');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'pitch-lines');
        svg.setAttribute('viewBox', '0 0 68 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.innerHTML = '<g fill="none" stroke="rgba(24,20,16,0.22)" stroke-width="0.6">' +
            '<line x1="1.5" y1="50" x2="66.5" y2="50"/><circle cx="34" cy="50" r="8"/></g>';
        wrap.appendChild(svg);
        layoutForFormation(formation).forEach(slot => {
            const dot = el('div', 'fc-dot');
            dot.style.left = slot.left + '%';
            dot.style.top  = slot.top + '%';
            wrap.appendChild(dot);
        });
        return wrap;
    }

    function renderFormationSelect() {
        const grid = $('formationGrid');
        grid.innerHTML = '';
        selectedFormation = null;
        $('formationBegin').disabled = true;
        $('formationBeginLabel').textContent = 'Select a shape';
        FORMATION_ORDER.forEach(f => {
            const card = el('div', 'formation-card');
            card.appendChild(formationDiagram(f));
            card.appendChild(el('div', 'fc-name', f));
            card.addEventListener('click', () => {
                selectedFormation = f;
                grid.querySelectorAll('.formation-card').forEach(c => c.classList.remove('sel'));
                card.classList.add('sel');
                $('formationBegin').disabled = false;
                $('formationBeginLabel').textContent = `Begin with ${f}`;
            });
            grid.appendChild(card);
        });
    }

    // ── Squad pitch renderer (draft / edit / reveal) ─────────────

    function renderSquadPitch(wrap, opts = {}) {
        const { mode = 'reveal', pendingPos = null, onSlot, onBench, stagger = false } = opts;
        const slots = layoutForFormation(game.formation);
        wrap.innerHTML = '';

        const col = el('div', 'col gap16');
        col.style.width = '100%';

        const pitch = el('div', 'pitch' + (mode === 'edit' ? ' editmode' : ''));
        pitch.appendChild(pitchLines());

        slots.forEach((slot, i) => {
            const filled = game.squad.starters[i];
            const cell = el('div', 'slot');
            cell.style.left = slot.left + '%';
            cell.style.top  = slot.top + '%';
            if (filled) {
                const c = buildPlayerCard(filled.pick, filled.team);
                if (stagger) { c.classList.add('slot-filled'); c.style.animationDelay = (i * 0.06) + 's'; }
                else if (lastDrop && lastDrop.where === 'starter' && lastDrop.idx === i) c.classList.add('slot-filled');
                cell.appendChild(c);
                if (mode === 'edit' && editSrc && editSrc.where === 'starter' && editSrc.idx === i) cell.classList.add('move-src');
            } else {
                const e = el('div', 'slot-empty');
                e.appendChild(el('span', 'pos', slot.pos[0]));
                cell.appendChild(e);
                if (mode === 'draft' && pendingPos && slotFits(pendingPos, slot.pos)) cell.classList.add('pulse');
            }
            if (mode === 'draft' || mode === 'edit') cell.addEventListener('click', () => onSlot && onSlot(i));
            pitch.appendChild(cell);
        });
        col.appendChild(pitch);

        const benchCol = el('div', 'col gap8');
        const placed = game.squad.bench.filter(Boolean).length;
        benchCol.appendChild(el('div', 'bench-label', `Substitutes · ${placed}/${game.config.benchCount}`));
        const bench = el('div', 'bench' + (mode === 'edit' ? ' editmode' : ''));
        for (let i = 0; i < game.config.benchCount; i++) {
            const filled = game.squad.bench[i];
            const cell = el('div', 'bench-cell');
            if (filled) {
                const c = buildPlayerCard(filled.pick, filled.team);
                if (stagger) { c.classList.add('slot-filled'); c.style.animationDelay = (0.7 + i * 0.05) + 's'; }
                else if (lastDrop && lastDrop.where === 'bench' && lastDrop.idx === i) c.classList.add('slot-filled');
                cell.appendChild(c);
                if (mode === 'edit' && editSrc && editSrc.where === 'bench' && editSrc.idx === i) cell.classList.add('move-src');
            } else {
                const e = el('div', 'bench-empty');
                e.appendChild(el('span', null, 'SUB'));
                cell.appendChild(e);
                if (mode === 'draft' && pendingPos) cell.classList.add('pulse');
            }
            if (mode === 'draft' || mode === 'edit') cell.addEventListener('click', () => onBench && onBench(i));
            bench.appendChild(cell);
        }
        benchCol.appendChild(bench);
        col.appendChild(benchCol);
        wrap.appendChild(col);
    }

    // ── Round / draft ────────────────────────────────────────────

    function startGame() {
        if (!soccerData || !soccerData.length) {
            alert('No matches loaded yet — try again in a moment.');
            return;
        }
        game.formation = selectedFormation || game.formation || FALLBACK_FORMATION;
        game.config = SPORT_CONFIG.soccer;
        game.sequence = buildSequence(soccerData, 'soccer', game.mode, game.config.totalRounds);
        game.squad = freshSquad(game.config.startersCount, game.config.benchCount);
        game.roundIdx = 0;
        game.finished = false;
        game.pendingPick = null;
        lastDrop = null;
        showScreen('Game');
        renderRound();
    }

    function renderRound() {
        const team = game.sequence[game.roundIdx];
        if (!team) { enterFinalize(); return; }
        const cfg = game.config;
        const m = team.match || {};
        const pending = game.pendingPick;

        // topbar
        $('roundNum').textContent = String(game.roundIdx + 1).padStart(2, '0');
        $('roundTotal').textContent = cfg.totalRounds;
        $('gameFormation').textContent = game.formation;
        const pips = $('progressPips');
        pips.innerHTML = '';
        const count = squadCount();
        for (let i = 0; i < cfg.totalRounds; i++) {
            pips.appendChild(el('div', 'pip' + (i < count ? ' done' : (i === count ? ' cur' : ''))));
        }

        // teamsheet head
        $('tsSwatch').style.background = team.accent || 'var(--ink)';
        $('tsComp').textContent = `${m.competition || (cfg.leagueLabels[team.league] || team.league || 'MATCH')} · ${formatMatchDate(m.date)}`;
        $('tsTeam').textContent = team.team || '';
        $('tsOpp').textContent = m.opponent || '';
        $('tsSeason').textContent = team.season || '';
        $('tsVenue').textContent = m.venue || '';
        const res = $('tsResult');
        res.textContent = m.result || 'vs';
        res.style.background = team.accent || 'var(--ink)';

        $('tsHint').innerHTML = '<span class="tick"></span> ' +
            (pending ? 'Now place them on your pitch →' : 'Pluck one name for your squad');

        renderTeamsheet(team);
        renderSquad();
    }

    function renderTeamsheet(team) {
        const list = $('tsList');
        list.innerHTML = '';
        const drafted = draftedNameSet();
        const pending = game.pendingPick;
        const lineup = team.lineup || [];
        let selectable = 0;

        lineup.forEach(p => {
            const taken = drafted.has(normName(p.name));
            const isSel = pending && pending.pick.name === p.name;
            if (!taken) selectable++;

            const row = el('button', 'ts-row' + (taken ? ' taken' : '') + (isSel ? ' sel-row' : ''));
            row.type = 'button';
            row.appendChild(el('span', 'ts-num num', p.number != null ? String(p.number) : '–'));

            // Circular face avatar — same locally-cached portrait as the pitch
            // cards (faces/{id}.{png|webp}, warm-cached); monogram fallback otherwise.
            const face = el('div', 'ts-face');
            const tsFaceId = p.id || p.sofascore_id;
            if (tsFaceId) {
                const img = document.createElement('img');
                img.alt = '';
                img.decoding = 'async';
                img.referrerPolicy = 'no-referrer';
                const setMono = () => {
                    face.classList.add('is-mono');
                    face.innerHTML = '';
                    face.appendChild(el('span', null, initialsOf(p.name)));
                };
                img.addEventListener('error', setMono);
                face.appendChild(img);
                prepareTransparentFace(tsFaceId, team && team.id)
                    .then(processed => { if (processed) img.src = processed; else setMono(); })
                    .catch(setMono);
            } else {
                face.classList.add('is-mono');
                face.appendChild(el('span', null, initialsOf(p.name)));
            }
            row.appendChild(face);

            const nameEl = el('span', 'ts-name');
            const parts = (p.name || '').split(/\s+/).filter(Boolean);
            const last = parts.pop() || '';
            if (parts.length) nameEl.appendChild(document.createTextNode(parts.join(' ') + ' '));
            nameEl.appendChild(el('span', 'last', last));
            row.appendChild(nameEl);

            row.appendChild(el('span', 'ts-pos', p.position || ''));

            if (!taken) row.addEventListener('click', () => selectPlayer(p, team));
            list.appendChild(row);
        });

        if (selectable === 0) {
            const note = el('div', 'ts-alltaken');
            note.appendChild(el('span', null, 'Every name here is already in your squad.'));
            const skip = el('button', 'btn btn-ghost');
            skip.style.fontSize = '12px';
            skip.style.padding = '8px 14px';
            skip.textContent = 'Skip round →';
            skip.addEventListener('click', () => { game.pendingPick = null; game.roundIdx += 1; renderRound(); });
            note.appendChild(skip);
            list.appendChild(note);
        }
    }

    function renderSquad() {
        const cfg = game.config;
        const pending = game.pendingPick;
        $('squadCount').textContent = `${squadCount()}/${cfg.totalRounds} plucked`;

        const hintWrap = $('placeHintWrap');
        hintWrap.innerHTML = '';
        if (pending) {
            const hint = el('div', 'place-hint fade-in');
            const who = el('span', 'who');
            const b = el('b', null, lastNameOf(pending.pick.name));
            who.appendChild(b);
            who.appendChild(document.createTextNode(` · ${pending.pick.position || ''} — drop on a glowing slot`));
            hint.appendChild(who);
            const cancel = el('button', 'act', '✕ Cancel');
            cancel.addEventListener('click', cancelPending);
            hint.appendChild(cancel);
            hintWrap.appendChild(hint);
        }

        renderSquadPitch($('squadPitchWrap'), {
            mode: 'draft',
            pendingPos: pending ? pending.pick.position : null,
            onSlot: (i) => placePending('starter', i),
            onBench: (i) => placePending('bench', i),
        });
    }

    function selectPlayer(player, team) {
        if (draftedNameSet().has(normName(player.name))) return; // already drafted
        game.pendingPick = { pick: player, team };
        // light re-render: teamsheet (sel/taken), squad (pulse + hint), hint text
        $('tsHint').innerHTML = '<span class="tick"></span> Now place them on your pitch →';
        renderTeamsheet(team);
        renderSquad();
    }

    function cancelPending() {
        game.pendingPick = null;
        renderRound();
    }

    function placePending(where, idx) {
        const pending = game.pendingPick;
        if (!pending) return;
        const arr = where === 'starter' ? game.squad.starters : game.squad.bench;
        if (arr[idx]) return; // occupied
        arr[idx] = pending;
        game.pendingPick = null;
        lastDrop = { where, idx };
        game.roundIdx += 1;
        if (squadCount() >= game.config.totalRounds) {
            setTimeout(enterFinalize, 360);
            renderSquad(); // show the final drop animating
        } else {
            renderRound();
        }
    }

    // ── Finalize / rearrange ─────────────────────────────────────

    function enterFinalize() {
        editSrc = null;
        lastDrop = null;
        showScreen('Finalize');
        renderFinalize();
    }

    function renderFinalize() {
        const hint = $('finalizeHint');
        hint.textContent = editSrc
            ? 'Now tap where it should go — another player to swap, or an empty slot to move into.'
            : "Tap a player, then tap any other slot or bench cell to swap them. Promote a sub into the eleven, switch positions — arrange it exactly how you'd line them up.";
        renderSquadPitch($('finalizePitchWrap'), {
            mode: 'edit',
            onSlot: (i) => onEditCell('starter', i),
            onBench: (i) => onEditCell('bench', i),
        });
    }

    function onEditCell(where, idx) {
        const arr = where === 'starter' ? game.squad.starters : game.squad.bench;
        if (!editSrc) {
            if (!arr[idx]) return;        // nothing to pick up from an empty cell
            editSrc = { where, idx };
            renderFinalize();
            return;
        }
        // second tap: swap source <-> target (target may be empty)
        if (editSrc.where === where && editSrc.idx === idx) { editSrc = null; renderFinalize(); return; }
        const srcArr = editSrc.where === 'starter' ? game.squad.starters : game.squad.bench;
        const tmp = srcArr[editSrc.idx];
        srcArr[editSrc.idx] = arr[idx];
        arr[idx] = tmp;
        editSrc = null;
        renderFinalize();
    }

    // ── Final reveal ─────────────────────────────────────────────

    function computeStats() {
        const picks = allPicks();
        const clubs = new Set(picks.map(p => p.team.team)).size;
        const years = picks.map(p => parseInt((p.team.season || '0').slice(0, 4), 10)).filter(Boolean);
        const eraSpan = years.length ? (Math.max(...years) - Math.min(...years)) : 0;
        const minY = years.length ? Math.min(...years) : null;
        const maxY = years.length ? Math.max(...years) : null;
        const slots = layoutForFormation(game.formation);
        let fit = 0, starters = 0;
        game.squad.starters.forEach((s, i) => {
            if (!s) return; starters++;
            if (slotFits(s.pick.position, slots[i].pos)) fit++;
        });
        const score = starters ? Math.round(55 + 45 * (fit / starters)) : 0;
        return { clubs, eraSpan, minY, maxY, score, streak: state.streak || 0 };
    }

    function finalizeAndReveal() {
        game.finished = true;
        if (game.mode === 'daily') {
            const key = getDailyKey();
            state = updateStreakOnCompletion(state, key);
            state.completed[`${game.sport}:${key}`] = { formation: game.formation, at: Date.now() };
            saveState(state);
        }
        renderReveal();
        showScreen('Result');
        playRevealIntro();
    }

    function renderReveal() {
        const key = getDailyKey();
        const stats = computeStats();
        $('revealEdition').textContent = editionNumber(key);
        $('revealTag').textContent = `The Final XI · ${game.formation}`;
        $('revealCaptionDate').textContent = formatCoverDate(key);
        $('statEraInline').textContent = stats.eraSpan;
        $('statClubsInline').textContent = stats.clubs;
        $('statStreakUnit').textContent = stats.streak === 1 ? 'day' : 'days';

        renderSquadPitch($('revealPitchWrap'), { mode: 'reveal', stagger: true });

        animateCountUp($('statEra'), 0, stats.eraSpan, 1000);
        animateCountUp($('statClubs'), 0, stats.clubs, 1100);
        animateCountUp($('statChem'), 0, stats.score, 1200);
        animateCountUp($('statStreak'), 0, stats.streak, 900);
    }

    function playRevealIntro() {
        const curtain = el('div', 'reveal-curtain');
        const flash = el('div', 'reveal-flash');
        document.body.appendChild(curtain);
        document.body.appendChild(flash);
        requestAnimationFrame(() => { curtain.style.opacity = '0'; });
        setTimeout(() => { flash.classList.add('go'); }, 320);
        setTimeout(() => { curtain.remove(); flash.remove(); }, 1000);
    }

    function animateCountUp(node, from, to, duration) {
        if (!node) return;
        node.textContent = String(from);
        const start = performance.now();
        let done = false;
        const finish = () => { if (done) return; done = true; node.textContent = String(to); };
        const tick = (now) => {
            if (done) return;
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            node.textContent = String(Math.round(from + (to - from) * eased));
            if (t < 1) requestAnimationFrame(tick);
            else finish();
        };
        requestAnimationFrame(tick);
        // Safety net: rAF is throttled/paused in a backgrounded or off-screen
        // tab, which would otherwise freeze the counter at its start value.
        setTimeout(finish, duration + 200);
    }

    // ── Sharing ──────────────────────────────────────────────────

    function pageUrl() {
        return window.location.href.replace(/[?#].*$/, '');
    }

    function buildShareSummary() {
        const key = getDailyKey();
        const lines = [
            `PLUCK · The Daily XI · ${game.mode === 'daily' ? formatCoverDate(key) : 'Unlimited'}`,
            `Formation: ${game.formation}`,
            '',
        ];
        const slots = layoutForFormation(game.formation);
        slots.forEach((slot, i) => {
            const filled = game.squad.starters[i];
            const label = filled
                ? `${filled.pick.name} (${filled.team.team_short || filled.team.team} ${filled.team.season})`
                : '—';
            lines.push(`${(slot.pos[0] || '').padEnd(4)} ${label}`);
        });
        const bench = game.squad.bench.filter(Boolean);
        if (bench.length) {
            lines.push('', 'Bench:');
            bench.forEach((p, i) => lines.push(`  ${i + 1}. ${p.pick.name} (${p.team.team_short || p.team.team} ${p.team.season})`));
        }
        lines.push('', 'Play: ' + pageUrl());
        return lines.join('\n');
    }

    async function shareImage() {
        const node = $('shareCard');
        if (!window.htmlToImage) { toast('Image library not loaded — try again'); return; }
        try {
            // skipFonts: don't try to inline @font-face CSS (the page already
            // has the web fonts loaded). html-to-image still logs benign,
            // internally-caught SecurityErrors when it clones the cross-origin
            // Google-Fonts <link>; the PNG is produced regardless. Self-host the
            // fonts if a perfectly silent console / guaranteed export fidelity
            // is needed.
            const dataUrl = await window.htmlToImage.toPng(node, { backgroundColor: '#f3efe6', pixelRatio: 2, skipFonts: true });
            const link = document.createElement('a');
            link.download = `pluck-xi-${getDailyKey()}.png`;
            link.href = dataUrl;
            link.click();
            toast('Squad image saved — ready to post');
        } catch (e) {
            console.error('shareImage failed', e);
            toast('Could not generate image — try Copy Summary');
        }
    }
    function shareToTwitter() {
        const text = `My ${game.config.label} XI on Pluck — ${formatCoverDate(getDailyKey())}`;
        const url = pageUrl();
        window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener');
        toast('Opening X…');
    }
    async function copySummary() {
        const text = buildShareSummary();
        try {
            await navigator.clipboard.writeText(text);
            const label = $('copyLabel');
            const original = label.textContent;
            label.textContent = 'Copied!';
            setTimeout(() => { label.textContent = original; }, 1600);
            toast('Summary copied to clipboard');
        } catch (e) {
            alert('Clipboard blocked. Here is your squad:\n\n' + text);
        }
    }

    // ── Bindings ─────────────────────────────────────────────────

    function bindAll() {
        // Daily / Unlimited mode toggle — scope to the buttons in THIS row only.
        document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mode-btn[data-mode]').forEach(b => {
                    b.classList.remove('active'); b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
                game.mode = btn.dataset.mode;
                renderCover();
            });
        });

        $('playBtn').addEventListener('click', () => { showScreen('Formation'); renderFormationSelect(); });
        $('formationBack').addEventListener('click', () => { showScreen('Cover'); renderCover(); });
        $('formationBegin').addEventListener('click', () => { if (selectedFormation) startGame(); });

        $('gameBack').addEventListener('click', () => {
            if (squadCount() > 0 && !confirm('Abandon this squad? Your picks will be lost.')) return;
            showScreen('Cover'); renderCover();
        });

        $('finalizeBack').addEventListener('click', () => {
            if (!confirm('Leave without revealing? Your squad will be lost.')) return;
            showScreen('Cover'); renderCover();
        });
        $('revealBtn').addEventListener('click', finalizeAndReveal);

        $('resultBack').addEventListener('click', () => { showScreen('Cover'); renderCover(); });
        $('replayBtn').addEventListener('click', () => {
            game.mode = 'unlimited';
            document.querySelectorAll('.mode-btn').forEach(b => {
                const on = b.dataset.mode === 'unlimited';
                b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            showScreen('Formation'); renderFormationSelect();
        });

        $('shareImageBtn').addEventListener('click', shareImage);
        $('shareTwitterBtn').addEventListener('click', shareToTwitter);
        $('shareCopyBtn').addEventListener('click', copySummary);
    }

    // ── Init ─────────────────────────────────────────────────────

    async function init() {
        bindAll();
        try {
            soccerData = await loadSport('soccer');
        } catch (e) {
            soccerData = [];
            console.error('Failed to load soccer data', e);
        }
        renderCover();
        showScreen('Cover');
        resetTimerInterval = setInterval(updateResetTimer, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
