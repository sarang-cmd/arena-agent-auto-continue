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
  let tickCount = 0;

  // If the identical notice text shows up again this quickly after a send, it
  // is the same occurrence re-rendering, not a new limit — the agent cannot
  // burn a whole tool budget in a few seconds.
  const SAME_NOTICE_GUARD_MS = 6000;
  let lastStatus = 'idle';
  let lastStatusAt = 0;
  let indicator = null;
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
    renderIndicator();
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

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  /**
   * Walk text nodes in reverse document order and call visit(node) on each.
   * Stops (and returns true) as soon as visit returns true.
   * The notice is always the newest thing on the page, so starting from the
   * end means we usually find it in a handful of steps even in long chats.
   */
  function scanTextReverse(root, visit, maxNodes = 800) {
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < maxNodes) {
      const node = stack.pop();
      if (node.nodeType === Node.TEXT_NODE) {
        visited++;
        if (visit(node) === true) return true;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) continue;
      if (SKIP_TAGS.has(node.nodeName)) continue;
      const kids = node.childNodes;
      // push in document order so pop() returns the LAST child first
      for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    return false;
  }

  /** Is the "tool-call limit" notice present in the DOM right now? */
  function findLimitNotice(deep = false) {
    if (!document.body) return null;
    let exact = null;
    let continuationOnly = null;
    scanTextReverse(document.body, (node) => {
      const text = node.nodeValue;
      if (!text || text.length < 12) return false;
      if (RE_LIMIT.test(text)) { exact = node.parentElement; return true; }
      if (!continuationOnly && RE_CONTINUE.test(text)) {
        // "Send a message to continue…" alone is too generic — only accept it
        // when the surrounding block really is the limit notice.
        const around = (node.parentElement && node.parentElement.textContent) || '';
        if (RE_LIMIT.test(around)) continuationOnly = node.parentElement;
      }
      return false;
    }, deep ? 6000 : 800);
    return exact || continuationOnly;
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
      if (Date.now() - lastSendAt < settings.cooldownMs) return;
      await doSend();
    }, Math.max(0, settings.delayMs));
  }

  /* ------------------------------------------------------------------ tick */

  function tick() {
    if (!settings.enabled || stopped) { renderIndicator(); return; }
    if (!onAgentPage()) return;

    tickCount += 1;
    // Cheap tail scan every tick; a full scan now and then for very long chats.
    const notice = findLimitNotice(tickCount % 12 === 0);
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

  /* ------------------------------------------------------------- indicator */

  function renderIndicator() {
    if (!settings.showIndicator || !document.body) {
      if (indicator && indicator.host && indicator.host.isConnected) indicator.host.remove();
      indicator = null;
      return;
    }
    if (!indicator) {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;z-index:2147483000;right:14px;bottom:14px;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          .pill{font:500 11px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
            background:rgba(17,17,24,.86);color:#e8e8f0;border:1px solid rgba(255,255,255,.14);
            border-radius:999px;padding:6px 11px;display:flex;gap:7px;align-items:center;
            box-shadow:0 4px 18px rgba(0,0,0,.32);backdrop-filter:blur(8px);opacity:.72;
            transition:opacity .15s;max-width:260px;pointer-events:none}
          .pill:hover{opacity:1}
          .dot{width:6px;height:6px;border-radius:50%;background:#7c6cff;flex:0 0 auto}
          .dot.off{background:#6b7280}
          .dot.bad{background:#f87171}
          .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        </style>
        <div class="pill" part="pill">
          <span class="dot"></span><span class="txt"></span>
        </div>`;
      document.documentElement.appendChild(host);
      indicator = { host, root };
    }
    const dot = indicator.root.querySelector('.dot');
    const txt = indicator.root.querySelector('.txt');
    const off = !settings.enabled || stopped;
    dot.className = 'dot' + (stopped ? ' bad' : off ? ' off' : '');
    const label = !settings.enabled ? 'auto-continue off'
      : stopped ? `paused · ${consecutive} sent`
      : `auto-continue on · ${consecutive} sent`;
    txt.textContent = label;
    indicator.host.title = `Arena Agent Auto-Continue — ${lastStatus}`;
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
    setInterval(() => queueTick(0), 700);

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
        renderIndicator();
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

    renderIndicator();
    tick();
  }

  loadSettings(() => {
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
})();
