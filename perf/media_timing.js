// Media start and seek timing (see perf/README.md). Needs a Public interview with a playback
// copy and the preinstalled Playwright Chromium. Each run uses a fresh browser context (cold cache).
//
//   node media_timing.js <interview id> <label> <runs> <throttle: 0 or 1 (1.5 Mbit/s, 300 ms)>
const { chromium } = require('playwright');
const [id, label, runs, throttle] = [process.argv[2], process.argv[3], +process.argv[4], process.argv[5] === '1'];
const API = process.env.API_URL || 'http://localhost:8000';
(async () => {
  const browser = await chromium.launch();
  const out = [];
  for (let r = 0; r < runs; r++) {
    const ctx = await browser.newContext();  // cold cache each run
    const page = await ctx.newPage();
    if (throttle) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300,
        downloadThroughput: 1.5e6 / 8, uploadThroughput: 0.75e6 / 8 });
    }
    await page.goto(`${API}/api/health`);
    const res = await page.evaluate(async ({ API, id }) => {
      const t0 = performance.now();
      const detail = await (await fetch(`${API}/api/interviews/${id}`)).json();
      const tDetail = performance.now() - t0;
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; document.body.appendChild(v);
      const once = (ev) => new Promise((ok) => v.addEventListener(ev, ok, { once: true }));
      const t1 = performance.now();
      v.src = detail.media.url.startsWith('http') ? detail.media.url : API + detail.media.url;
      const playing = once('playing'); v.play(); await playing;
      const tStart = performance.now() - t1;
      const t2 = performance.now();
      const seeked = once('seeked'); v.currentTime = 1800; await seeked;
      if (v.paused || v.readyState < 3) await once('playing').catch(() => {});
      await new Promise((ok) => (v.readyState >= 3 ? ok() : v.addEventListener('canplay', ok, { once: true })));
      const tSeek = performance.now() - t2;
      return { tDetail, tStart, tSeek };
    }, { API, id });
    out.push(res); await ctx.close();
  }
  await browser.close();
  const med = (k) => { const s = out.map((o) => o[k]).sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  const max = (k) => Math.max(...out.map((o) => o[k]));
  console.log(JSON.stringify({ label, throttle, runs, detail_med: med('tDetail'), start_med: med('tStart'), start_max: max('tStart'),
    seek_med: med('tSeek'), seek_max: max('tSeek'), all: out }));
})();
