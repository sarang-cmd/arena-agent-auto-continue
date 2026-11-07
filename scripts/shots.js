/* Captures the images used in the README and release notes.
   Usage: node scripts/shots.js   (requires playwright-core + chromium) */
const path = require('path');
const fs = require('fs');
const { chromium } = require('/home/user/.tmp/node_modules/playwright-core');

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

  /* ------------------------------------------------------------------ popup */
  const popupCtx = await browser.newContext({
    viewport: { width: 340, height: 700 },
    deviceScaleFactor: 3
  });
  const p = await popupCtx.newPage();
  // stub the extension APIs so popup.js can run outside the browser extension host
  await p.addInitScript(() => {
    const settings = {
      enabled: true, onlyVisibleTab: true, delayMs: 1200, cooldownMs: 2500,
      maxConsecutive: 30, message: 'continue', skipIfDraft: true, showIndicator: true
    };
    window.chrome = {
      storage: { local: { get: (k, cb) => cb({ settings }), set: (o, cb) => cb && cb() } },
      runtime: { lastError: null },
      tabs: {
        query: (q, cb) => cb([{ id: 1, url: 'https://arena.ai/agent' }]),
        sendMessage: (id, msg, cb) =>
          cb({ settings, consecutive: 7, stopped: false, lastStatus: "sent \"continue\" (7)", hasNotice: false, onAgentPage: true })
      }
    };
  });
  await p.goto('file://' + path.join(root, 'popup.html'), { waitUntil: 'load' });
  await p.waitForTimeout(300);
  const box = await p.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return { width: Math.ceil(b.width), height: Math.ceil(b.height) };
  });
  await p.setViewportSize({ width: box.width, height: box.height });
  await p.screenshot({ path: path.join(outDir, 'popup.png') });

  await browser.close();
  console.log('wrote screenshots to', outDir);
  for (const f of fs.readdirSync(outDir)) {
    const s = fs.statSync(path.join(outDir, f));
    console.log(' ', f, Math.round(s.size / 1024) + 'KB');
  }
})().catch((e) => { console.error(e); process.exit(1); });
