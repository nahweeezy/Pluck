/* ============================================================
   Pluck · browser-console face downloader  (SofaScore work-around)
   ------------------------------------------------------------
   SofaScore now bot-blocks non-browser clients (curl / Node / fetch
   from other origins all get 403). The reliable way to grab the
   portraits is from a REAL browser session on their own site.

   HOW TO USE
   1. Open  https://www.sofascore.com  in your normal browser.
   2. Open DevTools → Console  (F12, then the "Console" tab).
   3. Paste this ENTIRE file and press Enter.
   4. Wait — it downloads each portrait one-by-one (a progress line
      prints every 10), then saves a single  pluck-faces.zip.
   5. Unzip its contents into the repo's  faces/  folder so you have
      faces/696.png, faces/750.png, …  then:
          git add faces && git commit -m "Cache player portraits" && git push

   If LOTS fail with 403, you're being rate-limited: bump DELAY below
   to ~1000 and run it again (only the missing ones matter — re-running
   just rebuilds the full zip).
   ============================================================ */
(async () => {
  const DELAY = 350; // ms between requests — raise if you get rate-limited
  const IDS = [696,697,723,698,719,708,701,514,700,699,2676,1757,1756,2961,1761,1765,1764,1767,1769,661,749,748,11184,3063,1422211,938,761,750,11384,751,11684,3565,14468,770,39433,3595,12994,11688,11,4715,1790,2052,2049,1934,2695,1422749,4419,11378,3289,5121,1185,6255,25233,9628,2,7311,1216,10086,28367,20756,1222,8959,14920,19382,66492,17100,326,30037,35166,5712,18886,88,24829,16632,16180,26760,15802,45853,18379,37092,18680,41789,88625,35199,7635,16943,56113,138572,10710,26502,15466,15354,3306,138310,243609,795064,51501,151545,1393342,42694,22126,159665,143697,217704,9048,69256,44575,16921,16586,27014,545780,111505,198028,105734,108579,259117,843665,53825,184661,187433,280441,70988,822519,792073,831808,868812,383560,318941,152077,149663,70996,331209,839956,189061,254491,44614,876214,149734,139225,11781,158213,794839,138534,824509,318607,21535,788255,788027,359226,823733,901891,135700,835485,851284,1941,238,1890,1422536,12800,2495,10172,2221,1,19314,43215,27622,559,45956,27009,161717,11601,10668,360938,847030,877102,187729,814594,359272,991421,801211,257205,846470,249437,18122,67507,145188,137774,20752,49805,5942,20993,267621,115441,19633,329175,342915,40699,46347,9329,24685,49647,33102,103045,123399,1076,30502,20375,1203,1262,54330,234148,47737,19303,173827,13274,146393,782502,13303,13321,318963,138452,128033,13309,24601,42208,604258,128376,580550,17803,80008,51652,215246,119242,107398,88859,119192,849114,579576,827243,904827,845170,944164,945062,859025,788170,117373,521,1053,1954,520,532,12987,10906,3544,1006,108,14049,50539,254713,9729,21164,43443,9127,330099,220315,37240,27035];

  if (!window.JSZip) {
    console.log('Loading JSZip…');
    await new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = ok; s.onerror = () => no(new Error('Could not load JSZip'));
      document.head.appendChild(s);
    });
  }

  const zip = new JSZip();
  let ok = 0, fail = 0; const failed = [];
  console.log(`Fetching ${IDS.length} portraits (~${Math.round(IDS.length * DELAY / 1000)}s)…`);

  for (let i = 0; i < IDS.length; i++) {
    const id = IDS[i];
    try {
      const r = await fetch(`https://api.sofascore.com/api/v1/player/${id}/image`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.blob();
      if (b.size < 200 || !b.type.startsWith('image')) throw new Error(`not-image (${b.type || '?'} ${b.size}b)`);
      zip.file(id + '.png', b);
      ok++;
    } catch (e) { fail++; failed.push(id + ' — ' + e.message); }
    if (i % 10 === 0 || i === IDS.length - 1) console.log(`  ${i + 1}/${IDS.length}   ok=${ok} fail=${fail}`);
    await new Promise((r) => setTimeout(r, DELAY));
  }

  console.log(`\nDone. ok=${ok} fail=${fail}`);
  if (failed.length) console.log('Failed (stay as monograms in-game):\n  ' + failed.join('\n  '));
  if (ok === 0) { console.warn('Nothing downloaded — likely rate-limited/blocked. Raise DELAY and retry.'); return; }

  console.log('Zipping…');
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pluck-faces.zip';
  a.click();
  console.log('Saved pluck-faces.zip → unzip its contents into the repo\'s  faces/  folder.');
})();
