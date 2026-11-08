/* Captures the images used in the README and release notes.
   Usage: node scripts/shots.js   (requires playwright-core + chromium) */
const path = require('path');
const fs = require('fs');
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  console.error('playwright-core is not installed. Run: npm install --no-save playwright-core');
  console.error('Then download a browser once with: npx playwright install chromium');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const site = 'file://' + path.join(root, 'site');
const outDir = path.join(root, 'docs', 'images');

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();

  /* ---------------------------------------------------------------- desktop */
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 940 },
    deviceScaleFactor: 2
  });
  const page = await desktop.newPage();
  await page.goto(site + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, 'hero.png') });

  // the simulation mid-flight, just before it sends
  await page.click('#runDemo');
  await page.waitForTimeout(2350);
  await page.screenshot({ path: path.join(outDir, 'simulation.png') });

  await page.screenshot({ path: path.join(outDir, 'page-full.png'), fullPage: true });

  // settings section only
  const settings = await page.$('#safety');
  if (settings) await settings.screenshot({ path: path.join(outDir, 'settings.png') });

  /* ----------------------------------------------------------------- mobile */
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  });
  const m = await mobile.newPage();
  await m.goto(site + '/index.html', { waitUntil: 'load' });
  await m.waitForTimeout(400);
  await m.screenshot({ path: path.join(outDir, 'mobile.png') });
  await m.screenshot({ path: path.join(outDir, 'mobile-full.png'), fullPage: true });

  /* ------------------------------------------------------- settings in the pill
     The settings UI lives inside the on-page pill now, so this is the shot that
     replaces the old popup capture. Photographed on a stand-in page, with the
     plate's own shadow kept and the surrounding page left transparent. */
  const pillCtx = await browser.newContext({
    viewport: { width: 660, height: 780 },
    deviceScaleFactor: 2
  });
  const pill = await pillCtx.newPage();
  // the plate carries its own dark surface, so the surround stays transparent and
  // the figure can place it on the stone background without a rectangle around it
  await pill.setContent(`<!doctype html><html><body style="margin:0;height:780px;background:transparent">
    <div style="font:13px/1.6 ui-monospace,monospace;color:#4c5a60;padding:26px 24px;max-width:300px">
      The agent reached the tool-call limit for this turn. Send a message to continue where it left off.
    </div>
  </body></html>`);
  await pill.addScriptTag({
    content: `window.chrome = {
      storage: { local: { get: (k, cb) => cb({ settings: {} }), set: (o, cb) => cb && cb() },
                 onChanged: { addListener: () => {} } },
      runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {},
                 getManifest: () => ({ version: '1.2.0' }) }
    };`
  });
  await pill.addScriptTag({ content: fs.readFileSync(path.join(root, 'ui', 'settings.js'), 'utf8') });
  await pill.addScriptTag({ content: fs.readFileSync(path.join(root, 'ui', 'panel.js'), 'utf8') });
  await pill.addScriptTag({ content: fs.readFileSync(path.join(root, 'content.js'), 'utf8') });
  await pill.waitForTimeout(700);

  // over a transparent page the plate's glass and its 0.86 idle opacity read as a
  // pale rectangle, so for the capture it is drawn at full opacity with no blur
  await pill.evaluate(() => {
    const sr = document.querySelector('div[style*="2147483000"]').shadowRoot;
    const s = document.createElement('style');
    s.textContent = '.plate, .root:hover .plate { opacity: 1 !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }';
    sr.appendChild(s);
    // pull the plate off the viewport edge so its shadow is fully inside the clip
    const host = document.querySelector('div[style*="2147483000"]');
    host.style.right = '56px';
    host.style.bottom = '56px';
  });

  // the host element is given padding so the plate's shadow and its expansion
  // both sit inside the capture; screenshotting the host also avoids guessing at
  // a clip box from a rect that changes while the view opens
  const hostBox = await pill.evaluate(() => {
    const host = document.querySelector('div[style*="2147483000"]');
    host.style.padding = '34px';
    host.style.right = '24px';
    host.style.bottom = '24px';
    return true;
  });
  void hostBox;

  const plateCentre = async () => pill.evaluate(() => {
    const r = document.querySelector('div[style*="2147483000"]').shadowRoot
      .querySelector('.plate').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  // the host element's own box, which is the plate plus the padding given above
  const hostRect = () => pill.evaluate(() => {
    const r = document.querySelector('div[style*="2147483000"]').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });

  const centre = await plateCentre();
  await pill.mouse.move(centre.x, centre.y);
  await pill.waitForTimeout(500);
  await pill.screenshot({
    path: path.join(outDir, 'pill.png'), omitBackground: true, clip: await hostRect()
  });

  await pill.evaluate(() => {
    document.querySelector('div[style*="2147483000"]').shadowRoot.querySelector('.gear').click();
  });
  await pill.mouse.move(20, 20);
  await pill.waitForTimeout(700);
  await pill.screenshot({
    path: path.join(outDir, 'pill-settings.png'), omitBackground: true, clip: await hostRect()
  });
  console.log('  pill shots:', JSON.stringify(await hostRect()));

  /* ------------------------------------------------------------ settings page
     The full page, reachable from the toolbar button and from All settings. */
  const pageCtx = await browser.newContext({ viewport: { width: 620, height: 900 }, deviceScaleFactor: 2 });
  const sp = await pageCtx.newPage();
  await sp.addInitScript(() => {
    const settings = {
      enabled: true, onlyVisibleTab: true, delayMs: 1200, cooldownMs: 2500,
      maxConsecutive: 30, message: 'continue', skipIfDraft: true, useKeepWorking: true,
      requireFreshNotice: true, showIndicator: true,
      notifyOnPause: true,
      override: { selector: 'button.text-start', x: 0.62, y: 0.734, text: 'Keep working' }
    };
    window.chrome = {
      runtime: { getManifest: () => ({ version: '1.2.0' }), lastError: null, sendMessage: (m, cb) => cb && cb({ ok: true }) },
      storage: { local: {
        get: (k, cb) => cb({ settings, updateCheck: { at: Date.now(), latest: null } }),
        set: (o, cb) => cb && cb() } },
      permissions: {
        contains: (q, cb) => cb(false),
        request: (q, cb) => cb(false)
      }
    };
  });
  await sp.goto('file://' + path.join(root, 'settings.html'), { waitUntil: 'load' });
  await sp.waitForTimeout(500);
  await sp.screenshot({ path: path.join(outDir, 'settings-page.png'), fullPage: true });

  /* -------------------------------------------------------------- social card
     Rendered in the browser rather than drawn in an image editor, so the card
     uses the same type stack and stone palette as the page it points at. */
  const ogCtx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const og = await ogCtx.newPage();
  const iconData = fs.readFileSync(path.join(root, 'site', 'icon-512.png')).toString('base64');
  await og.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; margin: 0; }
    body {
      width: 1200px; height: 630px; background: #e9e6df; color: #22211e;
      font: 400 22px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center; padding: 0 90px; gap: 60px;
    }
    img { width: 168px; height: 168px; border-radius: 38px;
          box-shadow: 6px 8px 22px rgba(120,112,96,.28); flex: 0 0 auto; }
    h1 { font: 600 70px/1.05 ui-serif, "Iowan Old Style", Palatino, Georgia, serif; letter-spacing: -.02em; }
    p { margin-top: 18px; color: #46433c; max-width: 640px; }
    .foot { margin-top: 26px; font-size: 18px; color: #6b675f; }
  </style></head><body>
    <img src="data:image/png;base64,${iconData}" alt="" />
    <div>
      <h1>Baton</h1>
      <p>Sends continue when the arena.ai agent reaches its tool-call limit,
         then waits for the next one.</p>
      <p class="foot">A Chrome extension for long agent runs</p>
    </div>
  </body></html>`);
  await og.waitForTimeout(250);
  await og.screenshot({ path: path.join(root, 'site', 'og.png') });

  await browser.close();
  console.log('wrote screenshots to', outDir);
  for (const f of fs.readdirSync(outDir)) {
    const s = fs.statSync(path.join(outDir, f));
    console.log(' ', f, Math.round(s.size / 1024) + 'KB');
  }
})().catch((e) => { console.error(e); process.exit(1); });
