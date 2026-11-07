/**
 * Arena Agent Auto-Continue
 * ------------------------------------------------------------------
 * Watches the arena.ai/agent page for the message:
 *   "The agent reached the tool-call limit for this turn.
 *    Send a message to continue where it left off."
 * and automatically types + submits "continue" so the agent keeps going.
 *
 * Safety rails:
 *  - only one auto-send per occurrence of the notice (never double-fires)
 *  - if the notice survives a send, it stops instead of spamming
 *  - cooldown between sends
 *  - never overwrites text you already typed
 *  - hard cap on consecutive auto-sends (configurable, reset from popup)
 *  - optional: only act while the tab is visible
 */
(() => {
  if (window.__arenaAutoContinueLoaded) return;
  window.__arenaAutoContinueLoaded = true;

  const DEFAULTS = {
    enabled: true,
    onlyVisibleTab: true,
    delayMs: 1200,
    cooldownMs: 2500,
    maxConsecutive: 30,
    message: 'continue',
    skipIfDraft: true,
    showIndicator: true
  };

  // The exact notice Arena prints when the per-turn tool budget runs out.
  const RE_LIMIT = /reached the tool[-\s]?call limit/i;
  const RE_CONTINUE = /send (?:a )?message to continue/i;

  let settings = { ...DEFAULTS };
  let armed = true;          // may fire for the current notice
  let lastSendAt = 0;
  let consecutive = 0;
  let stopped = false;       // hard cap / stuck guard tripped
  let pendingTimer = null;
  let absentStreak = 0;
  let absentSince = 0;
  let lastSentSignature = '';
  let currentSignature = '';

  // If the identical notice text shows up again this quickly after a send, it
  // is the same occurrence re-rendering, not a new limit — the agent cannot
  // burn a whole tool budget in a few seconds.
  const SAME_NOTICE_GUARD_MS = 6000;
  let lastStatus = 'idle';
  let lastStatusAt = 0;
  let observer = null;
  let debounceTimer = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------------------------------------------------------- utils */

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (cs.opacity === '0') return false;
    return true;
  }

  function onAgentPage() {
    return /(^|\/)agent(\/|$)/i.test(location.pathname) || location.pathname === '/';
  }

  function status(text) {
    lastStatus = text;
    lastStatusAt = Date.now();
    persistStats();
  }

  let statsTimer = null;
  function persistStats() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      try {
        chrome.storage.local.set({
          stats: { status: lastStatus, consecutive, stopped, at: lastStatusAt }
        });
      } catch (_) { /* extension context gone */ }
    }, 250);
  }

  /* ------------------------------------------------------------- detection */

  function findLimitNotice() {
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.nodeValue;
        if (!t || t.length < 12) return NodeFilter.FILTER_REJECT;
        if (RE_LIMIT.test(t) || RE_CONTINUE.test(t)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    });

    let node;
    let continuationOnly = null;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      if (RE_LIMIT.test(text)) return node.parentElement;
      if (!continuationOnly && RE_CONTINUE.test(text)) {
        const around = (node.parentElement && node.parentElement.textContent) || '';
        if (RE_LIMIT.test(around)) continuationOnly = node.parentElement;
      }
    }
    return continuationOnly;
  }

  /** Notice text signature, so one occurrence can only trigger once. */
  function signatureOf(el) {
    const t = (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 400);
  }

  /* -------------------------------------------------------------- composer */

  function looksLikeSearch(el) {
    const hint = [
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('data-placeholder'),
      el.getAttribute('role'),
      el.id,
      el.className
    ].filter((v) => typeof v === 'string').join(' ');
    return /search|filter/i.test(hint);
  }

  function findComposer() {
    const selectors = [
      'textarea',
      'div[contenteditable="true"]',
      '[contenteditable="true"]',
      '[role="textbox"]',
      'input[type="text"]'
    ];
    const seen = new Set();
    const candidates = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el) || el.disabled || el.readOnly) continue;
        seen.add(el);
        if (!isVisible(el) || looksLikeSearch(el)) continue;
        candidates.push(el);
      }
    }
    if (!candidates.length) return null;

    const active = document.activeElement;
    if (active && candidates.includes(active)) return active;

    const vh = window.innerHeight || 800;
    const scored = candidates
      .map((el) => {
        const r = el.getBoundingClientRect();
        const nearBottom = r.top > vh * 0.35 ? 1.5 : 0.6;
        return { el, score: r.width * nearBottom + r.top * 0.25 };
      })
      .sort((a, b) => b.score - a.score);
    return scored[0].el;
  }

  function hasDraft(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value.trim() !== '';
    return (el.textContent || '').replace(/\u200b/g, '').trim() !== '';
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function insertText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      setNativeValue(el, text);
      return true;
    }
    // contenteditable (ProseMirror / TipTap / Lexical all handle insertText)
    const sel = window.getSelection && window.getSelection();
    if (sel && document.createRange) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) { ok = false; }
    if (!ok || !hasDraft(el)) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    // move caret to end
    try {
      const r2 = document.createRange();
      r2.selectNodeContents(el);
      r2.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r2);
    } catch (_) {}
    return true;
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const down = new KeyboardEvent('keydown', opts);
    for (const [k, v] of [['keyCode', 13], ['which', 13]]) {
      try { Object.defineProperty(down, k, { get: () => v }); } catch (_) {}
    }
    el.dispatchEvent(down);
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** Try to find and click the composer's send button. Returns true if clicked. */
  function clickSendButton(composer) {
    let scope = composer.closest('form') || composer.parentElement;
    for (let i = 0; i < 5 && scope && scope !== document.body; i++) {
      const buttons = [...scope.querySelectorAll('button, [role="button"]')];
      const match = buttons.find((b) => {
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
        const label = [
          b.getAttribute('aria-label'),
          b.getAttribute('title'),
          b.getAttribute('data-testid'),
          b.textContent
        ].filter(Boolean).join(' ').trim();
        if (!/send|submit|arrow|^\s*$/i.test(label)) return false;
        // must look like an icon/send control, and be visible
        return isVisible(b) && (b.querySelector('svg') || /send|submit/i.test(label));
      });
      if (match) { match.click(); return true; }
      scope = scope.parentElement;
    }
    return false;
  }

  /* ------------------------------------------------------------------ send */

  async function doSend() {
    const composer = findComposer();
    if (!composer) {
      status('no composer found');
      return false;
    }
    if (settings.skipIfDraft && hasDraft(composer)) {
      status('draft in composer — skipped');
      return false;
    }

    insertText(composer, settings.message);
    await sleep(150);

    const clicked = clickSendButton(composer);
    if (!clicked) pressEnter(composer);

    consecutive += 1;
    lastSendAt = Date.now();
    // Capture the signature of the notice we acted on (it may already be gone
    // by now, so it cannot be re-read after the click).
    lastSentSignature = currentSignature;
    armed = false; // one shot per notice
    setStatus(`sent "${settings.message}" (${consecutive})`);

    if (consecutive >= settings.maxConsecutive) {
      stopped = true;
      setStatus(`hit safety cap (${consecutive}) — paused`);
    }
    return true;
  }

  function setStatus(t) { status(t); }

  function scheduleSend(notice) {
    if (pendingTimer) return;
    const sig = signatureOf(notice);
    pendingTimer = setTimeout(async () => {
      pendingTimer = null;
      if (!settings.enabled || stopped) return;
      const still = findLimitNotice();
      if (!still || signatureOf(still) !== sig) return; // notice vanished → nothing to do
      if (sig === lastSentSignature && Date.now() - lastSendAt < SAME_NOTICE_GUARD_MS) return;
      if (settings.onlyVisibleTab && document.visibilityState === 'hidden') return;
      await doSend();
    }, Math.max(0, settings.delayMs));
  }

  /* ------------------------------------------------------------------ tick */

  function tick() {
    if (!settings.enabled || stopped) return;
    if (!onAgentPage()) return;

    const notice = findLimitNotice();
    if (!notice) {
      // Notice is gone → the turn moved on; re-arm for a future limit.
      // Re-arming is based on *observations* rather than wall-clock time:
      // SPA re-renders can briefly detach and re-attach the very same notice,
      // and a gap we never looked at must not count as "it cleared".
      if (armed) return;
      if (absentStreak === 0) absentSince = Date.now();
      absentStreak += 1;
      if (absentStreak >= 5 && Date.now() - absentSince >= 1200) {
        armed = true;
        absentStreak = 0;
        absentSince = 0;
        if (lastStatus.startsWith('sent')) status('waiting');
      }
      return;
    }
    absentStreak = 0;
    absentSince = 0;
    currentSignature = signatureOf(notice);
    if (!armed) return; // already fired for this occurrence
    if (settings.onlyVisibleTab && document.visibilityState === 'hidden') {
      status('paused (tab hidden)');
      return;
    }
    scheduleSend(notice);
  }

  function queueTick(delay = 250) {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      tick();
    }, delay);
  }

  /* ---------------------------------------------------------------- wiring */

  function loadSettings(cb) {
    try {
      chrome.storage.local.get(['settings'], (res) => {
        settings = { ...DEFAULTS, ...((res && res.settings) || {}) };
        cb();
      });
    } catch (_) {
      cb();
    }
  }

  function start() {
    observer = new MutationObserver(() => queueTick(200));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Fallback poll: some frameworks update text without mutations we catch.
    setInterval(() => queueTick(0), 200);

    // Anything the user does manually resets the safety cap.
    const userReset = (e) => {
      if (!e.isTrusted) return;
      if (stopped) { stopped = false; }
      if (e.type === 'keydown' && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
        // typing in the composer clears the "already fired" latch on next tick
      }
    };
    document.addEventListener('keydown', userReset, true);
    document.addEventListener('click', userReset, true);

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.settings) return;
        settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
        if (settings.enabled) stopped = false;
        consecutive = 0;
        queueTick(0);
      });
    } catch (_) {}

    try {
      chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
        if (!msg || msg.type !== 'arena-ac-status') return;
        reply({
          settings, consecutive, stopped, lastStatus,
          hasNotice: !!findLimitNotice(),
          onAgentPage: onAgentPage()
        });
      });
    } catch (_) {}

    tick();
  }

  loadSettings(() => {
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
})();
