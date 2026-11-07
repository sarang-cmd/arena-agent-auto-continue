/**
 * Arena DOM inspector
 * --------------------
 * Read-only diagnostic. Paste this whole file into the DevTools console while
 * you are on https://arena.ai/agent with a conversation open, press Enter,
 * then paste the output back. It changes nothing on the page.
 *
 * What it tells us:
 *   - which element the extension would pick as the message box, and why
 *   - every other candidate it rejected, so we can see what we are missing
 *   - the send button candidates next to the composer
 *   - whether the limit banner text is currently in the page, and its parent
 *     element structure (class names) so detection can be tightened
 */
(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 160) || null,
      role: el.getAttribute('role'),
      contenteditable: el.getAttribute('contenteditable'),
      placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      dataTestId: el.getAttribute('data-testid'),
      disabled: !!el.disabled,
      visible: visible(el),
      rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }
    };
  };

  // ---- 1. composer candidates -------------------------------------------
  const selectors = ['textarea', '[contenteditable="true"]', '[role="textbox"]', 'input[type="text"]'];
  const seen = new Set();
  const composers = [];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      composers.push(describe(el));
    }
  }

  // Reproduce the extension's choice so we can compare.
  const isSearch = (el) =>
    /search|filter/i.test([
      el.getAttribute('placeholder'), el.getAttribute('aria-label'),
      el.getAttribute('role'), el.id, el.className
    ].filter((v) => typeof v === 'string').join(' '));

  const viable = [...seen].filter((el) => visible(el) && !el.disabled && !isSearch(el));
  const vh = window.innerHeight || 800;
  const ranked = viable
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, score: r.width * (r.top > vh * 0.35 ? 1.5 : 0.6) + r.top * 0.25 };
    })
    .sort((a, b) => b.score - a.score);

  const picked = ranked[0] ? describe(ranked[0].el) : null;

  // ---- 2. send buttons near the picked composer --------------------------
  const buttons = [];
  if (ranked[0]) {
    let scope = ranked[0].el.closest('form') || ranked[0].el.parentElement;
    for (let i = 0; i < 5 && scope; i++) {
      for (const b of scope.querySelectorAll('button, [role="button"]')) {
        buttons.push(describe(b));
      }
      scope = scope.parentElement;
      if (scope === document.body) break;
    }
  }

  // ---- 3. the banner ----------------------------------------------------
  const banner = [];
  const needle = /tool[-\s]?call limit|send a message to continue/i;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode()) && banner.length < 5) {
    const t = node.nodeValue;
    if (!t || !needle.test(t)) continue;
    const p = node.parentElement;
    banner.push({
      text: t.trim().slice(0, 220),
      parent: describe(p),
      // two levels up helps spot the wrapper that carries the styling hooks
      grandparent: p && p.parentElement ? describe(p.parentElement) : null,
      visible: visible(p)
    });
  }

  const report = {
    url: location.href,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    composerPicked: picked,
    composerCandidates: composers,
    sendButtonCandidates: buttons.slice(0, 12),
    bannerMatches: banner
  };

  // Print it, and try to copy it so it is easy to send back.
  console.log('%cArena inspector', 'font-weight:bold', report);
  try {
    copy(JSON.stringify(report, null, 2));
    console.log('Copied the report to your clipboard.');
  } catch (_) {
    console.log('Copy failed. Right-click the logged object and choose "Copy object".');
  }
  return 'Report above. Paste the JSON back to me.';
})();
