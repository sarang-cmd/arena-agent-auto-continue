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

  const plate = () => pill.evaluate(() => {
    const r = document.querySelector('div[style*="2147483000"]').shadowRoot
      .querySelector('.plate').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  const centre = await plate();
  await pill.mouse.move(centre.x, centre.y);
  await pill.waitForTimeout(420);
  await pill.screenshot({ path: path.join(outDir, 'pill.png'), omitBackground: true,
    clip: await pill.evaluate(() => {
      const r = document.querySelector('div[style*="2147483000"]').shadowRoot
        .querySelector('.plate').getBoundingClientRect();
      return { x: r.x - 40, y: r.y - 40, width: r.width + 80, height: r.height + 80 };
    }) });

  await pill.evaluate(() => {
    document.querySelector('div[style*="2147483000"]').shadowRoot.querySelector('.gear').click();
  });
  await pill.mouse.move(30, 30);
  await pill.waitForTimeout(700);
  await pill.screenshot({ path: path.join(outDir, 'pill-settings.png'), omitBackground: true,
    clip: await pill.evaluate(() => {
      const r = document.querySelector('div[style*="2147483000"]').shadowRoot
        .querySelector('.plate').getBoundingClientRect();
      return { x: r.x - 40, y: r.y - 40, width: r.width + 80, height: r.height + 80 };
    }) });

  /* ------------------------------------------------------------ settings page
     The full page, reachable from the toolbar button and from All settings. */
  const pageCtx = await browser.newContext({ viewport: { width: 620, height: 900 }, deviceScaleFactor: 2 });
  const sp = await pageCtx.newPage();
  await sp.addInitScript(() => {
    const settings = {
      enabled: true, onlyVisibleTab: true, delayMs: 1200, cooldownMs: 2500,
      maxConsecutive: 30, message: 'continue', skipIfDraft: true, useKeepWorking: true,
      requireFreshNotice: true, showIndicator: true,
      override: { selector: 'button.text-start', x: 0.62, y: 0.734, text: 'Keep working' }
    };
    window.chrome = {
      runtime: { getManifest: () => ({ version: '1.2.0' }), lastError: null, sendMessage: (m, cb) => cb && cb({ ok: true }) },
      storage: { local: {
        get: (k, cb) => cb({ settings, updateCheck: { at: Date.now(), latest: null } }),
        set: (o, cb) => cb && cb() } }
    };
  });
  await sp.goto('file://' + path.join(root, 'settings.html'), { waitUntil: 'load' });
  await sp.waitForTimeout(500);
  await sp.screenshot({ path: path.join(outDir, 'settings-page.png'), fullPage: true });

  await browser.close();
  console.log('wrote screenshots to', outDir);
  for (const f of fs.readdirSync(outDir)) {
    const s = fs.statSync(path.join(outDir, f));
    console.log(' ', f, Math.round(s.size / 1024) + 'KB');
  }
})().catch((e) => { console.error(e); process.exit(1); });
