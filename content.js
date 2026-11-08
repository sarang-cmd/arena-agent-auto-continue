/**
 * Baton
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
 *  - hard cap on consecutive auto-sends (configurable, reset from settings)
 *  - optional: only act while the tab is visible
 */
(() => {
  if (window.__batonLoaded) return;
  window.__batonLoaded = true;

  const DEFAULTS = {
    enabled: true,
    onlyVisibleTab: true,
    delayMs: 1200,
    cooldownMs: 2500,
    maxConsecutive: 30,
    message: 'continue',
    skipIfDraft: true,
    useKeepWorking: true,
    requireFreshNotice: true,
    showIndicator: true,
    // User override for the Keep working control: { selector, text, x, y }.
    // x and y are fractions of the viewport, so they survive a resize.
    override: null
  };

  // The exact notice Arena prints when the per-turn tool budget runs out.
  const RE_LIMIT = /reached the tool[-\s]?call limit/i;
  const RE_CONTINUE = /send (?:a )?message to continue/i;
  // After the limit banner, Arena asks whether the task was successful. That
  // prompt sits on top of the message box, so it has to be dismissed first.
  const RE_TASK_PROMPT = /was this task successful/i;
  const RE_KEEP_WORKING = /keep working/i;

  // Shape of the control seen in the wild. Kept as CSS so it survives a re-render
  // even when its position on screen moves, with the text check as a backstop.
  const KEEP_WORKING_SELECTORS = [
    'button[type="button"][class*="text-start"][class*="px-4"]',
    'button[type="button"][class*="hover:bg-surface-tertiary"]',
    'button[class*="text-start"][class*="py-3"]'
  ];

  let settings = { ...DEFAULTS };
  let armed = true;          // may fire for the current notice
  let lastSendAt = 0;
  let consecutive = 0;
  let stopped = false;       // hard cap / stuck guard tripped
  let pendingTimer = null;
  let absentStreak = 0;
  let absentSince = 0;
  let lastSentSignature = '';
  let lastSendFingerprint = '';
  let suppressUntil = 0;
  let sending = false;
  let currentSignature = '';
  let tickCount = 0;

  // If the identical notice text shows up again this quickly after a send, it
  // is the same occurrence re-rendering, not a new limit, since the agent cannot
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
        // "Send a message to continue" alone is too generic, so only accept it
        // when the surrounding block really is the limit notice.
        const around = (node.parentElement && node.parentElement.textContent) || '';
        if (RE_LIMIT.test(around)) continuationOnly = node.parentElement;
      }
      return false;
    }, deep ? 6000 : 800);
    return exact || continuationOnly;
  }

  /** The "Was this task successful?" prompt, which covers the composer. */
  function findTaskPrompt() {
    if (!document.body) return null;
    let found = null;
    scanTextReverse(document.body, (node) => {
      const text = node.nodeValue;
      if (!text || text.length < 8 || !RE_TASK_PROMPT.test(text)) return false;
      // Climb to the block that actually holds the choices, so proximity
      // scoring has a meaningful box to work from.
      let el = node.parentElement;
      for (let i = 0; i < 6 && el && el.parentElement; i++) {
        const hasKeep = [...el.querySelectorAll('button, [role="button"], a')]
          .some((b) => RE_KEEP_WORKING.test((b.textContent || '').trim()));
        if (hasKeep) break;
        el = el.parentElement;
      }
      found = el;
      return true;
    });
    return found;
  }

  /* ------------------------------------------------------------ transcript */

  /** Nearest scrollable ancestor, which is the conversation pane. */
  function transcriptContainer(el) {
    let node = el && el.parentElement;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      const scrolls = /(auto|scroll)/.test(cs.overflowY);
      if (scrolls && node.scrollHeight > node.clientHeight + 20) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Page furniture that is not conversation content: the composer bar, toolbars,
   * dialogs and anything pinned to the viewport. These sit after the messages in
   * the DOM even when nothing new has been said.
   */
  function isChrome(el) {
    if (!el || !el.matches) return false;
    if (el.matches('form, nav, header, footer, [role="dialog"], [role="toolbar"], [role="search"]')) return true;
    if (el.querySelector && el.querySelector(
      'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')) return true;
    const cs = getComputedStyle(el);
    return cs.position === 'fixed' || cs.position === 'sticky';
  }

  function meaningful(el) {
    if (!el || isChrome(el)) return false;
    if (el.nodeType === Node.TEXT_NODE) return (el.nodeValue || '').trim().length > 3;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 3) return true;
    return !!el.querySelector && !!el.querySelector('button, [role="button"], svg, img, textarea, [contenteditable="true"]');
  }

  /**
   * True when nothing in the conversation follows this element.
   *
   * This is the fix for the false positive: a limit banner from an earlier turn
   * stays in the transcript. It is still "the message on the website", but it is
   * history, not a request. Only a notice at the live end of the conversation
   * counts.
   */
  function isAtEndOfTranscript(el) {
    const container = transcriptContainer(el);
    let node = el;
    while (node && node !== container && node.parentElement) {
      let sib = node.nextElementSibling;
      while (sib) {
        if (meaningful(sib)) return false;
        sib = sib.nextElementSibling;
      }
      node = node.parentElement;
    }
    return true;
  }

  /** Is the agent visibly still working, so the turn is not really over? */
  function isAgentBusy() {
    if (document.querySelector('[aria-busy="true"]')) return true;
    const tail = transcriptFingerprintText();
    if (/\b(thinking|working|generating|streaming)\b/i.test(tail)) return true;
    // Tailwind spinners and typing dots inside the conversation pane
    const spinner = document.querySelector('.animate-spin, .animate-pulse, [class*="animate-bounce"]');
    return !!spinner;
  }

  /** Text at the very end of the conversation, used for fingerprints. */
  function transcriptFingerprintText() {
    const containers = [...document.querySelectorAll('main, [role="log"], [class*="overflow-y"]')];
    const box = containers.map((c) => c.textContent || '').sort((a, b) => b.length - a.length)[0] || document.body.textContent || '';
    // Strip the banner wording. Adding or removing the notice must not look like
    // the agent produced something, or the guard against repeat sends breaks.
    return box
      .replace(/(The agent )?reached the tool[-\s]?call limit[^.!?]*[.!?]?/gi, ' ')
      .replace(/Send (a )?message to continue[^.!?]*[.!?]?/gi, ' ')
      .replace(/\s+/g, ' ')
      .slice(-400);
  }

  /** A cheap value that changes whenever the agent produces something new. */
  function transcriptFingerprint() {
    const text = transcriptFingerprintText();
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return text.length + ':' + hash;
  }

  /* ------------------------------------------------------------- override */

  function overrideCandidates(override) {
    const out = [];
    if (!override) return out;
    if (override.selector) {
      try {
        for (const el of document.querySelectorAll(override.selector)) out.push(el);
      } catch (_) { /* stored selector became invalid */ }
    }
    if (override.x != null && override.y != null) {
      const el = document.elementFromPoint(
        override.x * window.innerWidth,
        override.y * window.innerHeight
      );
      if (el) out.push((el.closest && el.closest('button, [role="button"], a')) || el);
    }
    return out.filter((el) => el && el.isConnected);
  }

  /** Click the user's chosen target, if they set one. */
  function clickOverride() {
    const override = settings.override;
    for (const el of overrideCandidates(override)) {
      if (!isVisible(el)) continue;
      el.click();
      return override.selector ? 'override selector' : 'override position';
    }
    return null;
  }

  /**
   * The "Keep working" control inside that prompt. Chosen by proximity to the
   * prompt, so a "Keep working" button elsewhere on the page is not clicked.
   */
  function findKeepWorkingButton(prompt) {
    const usable = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && isVisible(el);
    const labelled = (el) => RE_KEEP_WORKING.test((el.textContent || '').replace(/\s+/g, ' ').trim());

    // 1. the known markup, which is stable across re-renders
    for (const sel of KEEP_WORKING_SELECTORS) {
      const el = [...document.querySelectorAll(sel)].find((c) => usable(c) && labelled(c));
      if (el) return el;
    }

    // 2. anything labelled Keep working, nearest to the prompt first
    const buttons = [...document.querySelectorAll('button, [role="button"], a')].filter(
      (el) => usable(el) && labelled(el)
    );
    if (!buttons.length) return null;
    if (!prompt) return buttons[0];

    const box = prompt.getBoundingClientRect();
    const mid = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    return buttons
      .map((el) => {
        const r = el.getBoundingClientRect();
        const d = Math.hypot(r.left + r.width / 2 - mid.x, r.top + r.height / 2 - mid.y);
        return { el, d };
      })
      .sort((a, b) => a.d - b.d)[0].el;
  }

  /** Click "Keep working" and wait for the prompt to clear. */
  async function dismissTaskPrompt() {
    const prompt = findTaskPrompt();
    if (!prompt) return false;
    // A target the user set themselves wins, because it exists precisely for the
    // case where the built-in selector no longer finds anything.
    const how = clickOverride();
    if (how) {
      status(`clicked ${how}`);
    } else {
      const button = findKeepWorkingButton(prompt);
      if (!button) {
        status('task prompt found, no Keep working button');
        return false;
      }
      button.click();
      status('clicked Keep working');
    }

    const started = Date.now();
    while (Date.now() - started < 5000) {
      if (!findTaskPrompt()) break;
      await sleep(120);
    }
    await sleep(250); // let the composer re-render before typing into it
    return !findTaskPrompt();
  }

  /**
   * After sending, check that something actually happened. If the notice and the
   * conversation are both unchanged, the click landed on a finished task, so the
   * notice is treated as history and left alone.
   */
  async function confirmEffect(signature, maxMs = 6000) {
    const before = transcriptFingerprint();
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      await sleep(250);
      const still = findLimitNotice();
      if (!still) return 'cleared';
      if (transcriptFingerprint() !== before) return 'new content';
    }
    suppressUntil = Date.now() + 20000;
    lastSentSignature = signature;
    status('no change after sending, holding');
    return null;
  }

  /** Poll for a usable composer, since it appears after the prompt closes. */
  async function waitForComposer(maxMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const composer = findComposer();
      if (composer) return composer;
      await sleep(120);
    }
    return null;
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

  /* ---------------------------------------------------------------- picker */

  /** A CSS path that resolves to one element, preferring the shortest form. */
  function selectorFor(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const unique = (sel) => {
      try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; }
    };
    const classes = [...(el.classList || [])]
      .filter((c) => c.length < 40 && !/^[0-9]/.test(c))
      .slice(0, 2)
      .map((c) => '.' + CSS.escape(c))
      .join('');
    const tag = el.tagName.toLowerCase();

    let sel = tag + classes;
    if (unique(sel)) return sel;

    // add the parent chain until it resolves to exactly one element
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const cls = [...(node.classList || [])].filter((c) => c.length < 40).slice(0, 1).map((c) => '.' + CSS.escape(c)).join('');
      part += cls;
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter((s) => s.tagName === node.tagName)
        : [node];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      const attempt = parts.join(' > ');
      if (unique(attempt) && attempt.split('>').length >= 2) return attempt;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  let picker = null;

  function stopPicker() {
    if (!picker) return;
    picker.box.remove();
    picker.label.remove();
    document.removeEventListener('mousemove', picker.onMove, true);
    document.removeEventListener('click', picker.onClick, true);
    document.removeEventListener('keydown', picker.onKey, true);
    picker = null;
    status('picker closed');
  }

  function startPicker() {
    if (picker) return true;
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2a5f63;' +
      'background:rgba(42,95,99,.12);border-radius:6px;transition:all .06s linear;';
    const label = document.createElement('div');
    label.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;background:#22211e;color:#f4f1ea;' +
      'font:11px/1.5 ui-monospace,monospace;padding:3px 7px;border-radius:5px;max-width:60ch;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    document.documentElement.append(box, label);

    const target = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === label) return null;
      return (el.closest && el.closest('button, [role="button"], a')) || el;
    };

    const onMove = (e) => {
      const el = target(e);
      if (!el) return;
      const r = el.getBoundingClientRect();
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      label.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
      label.style.top = Math.max(4, r.top - 22) + 'px';
      label.textContent = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) || el.tagName.toLowerCase();
    };

    const onClick = (e) => {
      const el = target(e);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const override = {
        selector: selectorFor(el),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        x: +(e.clientX / window.innerWidth).toFixed(4),
        y: +(e.clientY / window.innerHeight).toFixed(4),
        pickedAt: Date.now()
      };
      try {
        chrome.storage.local.set({ settings: { ...settings, override } }, () => {
          settings.override = override;
          status('target saved');
        });
      } catch (_) {}
      stopPicker();
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); stopPicker(); }
    };

    picker = { box, label, onMove, onClick, onKey };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    status('pick the Keep working button');
    return true;
  }

  /* ------------------------------------------------------------------ send */

  async function doSend() {
    // Single flight. Sending awaits the page, and ticks keep arriving while it
    // does; without this guard two attempts could click the same control.
    if (sending) return false;
    sending = true;
    armed = false; // one shot per notice, taken up front

    try {
      return await attemptSend();
    } finally {
      sending = false;
    }
  }

  async function attemptSend() {
    // Never act unless the conversation has moved on since the last send. This
    // is what stops a banner from an earlier turn being answered twice.
    if (settings.requireFreshNotice && lastSendFingerprint &&
        transcriptFingerprint() === lastSendFingerprint) {
      status('notice is from an earlier turn, waiting');
      armed = false;
      return false;
    }

    if (settings.useKeepWorking && findTaskPrompt()) {
      const closed = await dismissTaskPrompt();
      if (!closed) {
        // Do not keep clicking the same control: one attempt per banner.
        armed = false;
        suppressUntil = Date.now() + 15000;
        status('task prompt would not close, holding');
        return false;
      }
    }

    const composer = await waitForComposer(findTaskPrompt() ? 8000 : 3000);
    if (!composer) {
      armed = false;
      suppressUntil = Date.now() + 15000;
      status(findTaskPrompt() ? 'task prompt would not close' : 'no composer found');
      return false;
    }
    if (settings.skipIfDraft && hasDraft(composer)) {
      status('draft in composer, skipped');
      return false;
    }

    insertText(composer, settings.message);
    await sleep(150);

    const clicked = clickSendButton(composer);
    if (!clicked) pressEnter(composer);

    consecutive += 1;
    lastSendAt = Date.now();
    lastSendFingerprint = transcriptFingerprint();
    // Capture the signature of the notice we acted on (it may already be gone
    // by now, so it cannot be re-read after the click).
    lastSentSignature = currentSignature;
    setStatus(`sent "${settings.message}" (${consecutive})`);

    if (consecutive >= settings.maxConsecutive) {
      stopped = true;
      setStatus(`paused at the safety cap of ${consecutive}`);
      return true;
    }

    const effect = await confirmEffect(lastSentSignature);
    if (effect) setStatus(`sent "${settings.message}", ${effect}`);
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
    if (Date.now() < suppressUntil) return;

    if (settings.requireFreshNotice) {
      // A banner that is not at the live end of the conversation is history.
      if (!isAtEndOfTranscript(notice)) {
        status('older banner in history, ignored');
        return;
      }
      if (isAgentBusy()) {
        status('agent still working, waiting');
        return;
      }
    }
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

  /**
   * The on-page plate.
   *
   * Collapsed it shows the count and the state. Hover or keyboard focus expands
   * it to the last action; the gear pins it open and swaps to the settings view,
   * so settings live here rather than in a separate popup window.
   */
  const INDICATOR_CSS = `
    :host { all: initial; }

    .root {
      font: 400 11px/1.4 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      color: #ece9e2;
      pointer-events: auto;
      animation: arrive .3s cubic-bezier(.32, .72, 0, 1) both;
      transform-origin: bottom right;
      scrollbar-width: none;
    }
    .root ::-webkit-scrollbar { width: 0; height: 0; display: none; }

    .plate {
      width: 124px;
      padding: 8px 12px;
      border-radius: 10px;
      background: rgba(26, 25, 23, .94);
      border: 1px solid rgba(255, 255, 255, .09);
      box-shadow: 0 1px 0 rgba(255, 255, 255, .05) inset, 0 8px 24px rgba(0, 0, 0, .4);
      -webkit-backdrop-filter: blur(10px) saturate(120%);
      backdrop-filter: blur(10px) saturate(120%);
      opacity: .86;
      overflow: hidden;
      transition:
        width .22s cubic-bezier(.32, .72, 0, 1),
        opacity .16s ease,
        border-color .16s ease;
    }

    .root:hover .plate,
    .plate:focus-within,
    .root[data-pinned="true"] .plate {
      width: 276px;
      opacity: 1;
      border-color: rgba(255, 255, 255, .16);
    }

    .summary {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 18px;
      margin: 0;
      padding: 0;
      width: 100%;
      background: none;
      border: 0;
      font: inherit;
      color: inherit;
      text-align: left;
      cursor: default;
    }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: #6f8f92;
      box-shadow: 0 0 0 3px rgba(127, 179, 183, .13);
    }
    .root[data-state="sent"]   .dot { background: #79c3a1; box-shadow: 0 0 0 3px rgba(121, 195, 161, .16); }
    .root[data-state="paused"] .dot { background: #d3a05c; box-shadow: 0 0 0 3px rgba(211, 160, 92, .16); }
    .root[data-state="off"]    .dot { background: #7a766e; box-shadow: none; }

    .count {
      font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      color: #f2efe8;
      flex: 0 0 auto;
      min-width: 8px;
    }

    .state {
      flex: 1 1 auto;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #a8a49b;
      letter-spacing: .01em;
    }

    .gear {
      flex: 0 0 auto;
      width: 20px;
      height: 20px;
      margin: -3px -5px -3px 0;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 5px;
      background: none;
      color: #8b877e;
      cursor: pointer;
      opacity: 0;
      transition: opacity .14s ease, background-color .14s ease, color .14s ease;
    }
    .root:hover .gear,
    .plate:focus-within .gear,
    .root[data-pinned="true"] .gear { opacity: 1; }
    .gear:hover { background: rgba(255, 255, 255, .09); color: #e7e3da; }
    .gear:focus-visible { outline: 2px solid #7fb3b7; outline-offset: 0; }

    /* the expanding part */
    .more {
      max-height: 0;
      opacity: 0;
      overflow: hidden;
      transition:
        max-height .24s cubic-bezier(.32, .72, 0, 1),
        opacity .14s ease;
    }
    .root:hover .more,
    .plate:focus-within .more,
    .root[data-pinned="true"] .more {
      max-height: 420px;
      opacity: 1;
      transition-delay: .03s;
    }

    .name {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, .09);
      font: 600 12px/1.2 ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
      color: #f6f3ec;
    }
    .detail {
      margin-top: 5px;
      color: #a8a49b;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session { margin-top: 4px; color: #8b877e; font-variant-numeric: tabular-nums; }

    .view[hidden] { display: none; }
    .settingsView { padding-bottom: 2px; }
    .settingsHead {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px 0 10px;
      padding-top: 9px;
      border-top: 1px solid rgba(255, 255, 255, .09);
    }
    .back {
      width: 20px;
      height: 20px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 5px;
      background: none;
      color: #8b877e;
      cursor: pointer;
      margin-left: -4px;
    }
    .back:hover { background: rgba(255, 255, 255, .09); color: #e7e3da; }
    .back:focus-visible { outline: 2px solid #7fb3b7; outline-offset: 0; }
    .settingsTitle {
      font: 600 12px/1.2 ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
      color: #f6f3ec;
    }
    .settingsBody { scrollbar-width: none; }
    .settingsBody::-webkit-scrollbar { width: 0; height: 0; display: none; }

    @keyframes arrive {
      from { opacity: 0; transform: translateY(6px) scale(.96); }
      to   { opacity: 1; transform: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      .plate, .more, .gear { transition: none; }
      .root { animation: none; }
    }
  `;

  const STATE_LABEL = {
    watching: 'watching',
    sent: 'sent',
    busy: 'working',
    paused: 'paused',
    off: 'off'
  };

  function indicatorState() {
    if (!settings.enabled) return 'off';
    if (stopped) return 'paused';
    if (/sent .*(cleared|new content)/.test(lastStatus)) return 'sent';
    if (/working|waiting|typing/.test(lastStatus)) return 'busy';
    return 'watching';
  }

  let panelMounted = false;

  function openSettingsView() {
    if (!indicator) return;
    const root = indicator.root;
    root.querySelector('.root').dataset.pinned = 'true';
    root.querySelector('.statusView').hidden = true;
    root.querySelector('.settingsView').hidden = false;
    root.querySelector('.gear').setAttribute('aria-expanded', 'true');
    if (!panelMounted && window.BatonPanel) {
      const host = root.querySelector('.settingsBody');
      host.innerHTML = '';
      window.BatonPanel.mount(host, { compact: true, onClose: closeIndicator }).then(() => {
        panelMounted = true;
      });
    }
    // move focus into the view so Escape and Tab behave, but mark it
    // programmatic so the pointer path does not paint a focus ring
    const view = root.querySelector('.settingsView');
    view.setAttribute('tabindex', '-1');
    view.style.outline = 'none';
    view.focus({ preventScroll: true });
  }

  function closeSettingsView() {
    if (!indicator) return;
    const root = indicator.root;
    root.querySelector('.root').dataset.pinned = 'false';
    root.querySelector('.settingsView').hidden = true;
    root.querySelector('.statusView').hidden = false;
    root.querySelector('.gear').setAttribute('aria-expanded', 'false');
  }

  function closeIndicator() {
    closeSettingsView();
  }

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
        <style>${INDICATOR_CSS}</style>
        <div class="root" data-state="watching" data-pinned="false">
          <div class="plate">
            <div class="summary">
              <span class="dot" aria-hidden="true"></span>
              <span class="count">0</span>
              <span class="state"></span>
              <button class="gear" type="button" aria-label="Baton settings" aria-expanded="false">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"
                     stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="8" cy="8" r="3"/>
                  <circle cx="8" cy="8" r="5"/>
                  <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.3 3.3l1.15 1.15M11.55 11.55l1.15 1.15M12.7 3.3l-1.15 1.15M4.45 11.55l-1.15 1.15"/>
                </svg>
              </button>
            </div>
            <div class="more">
              <div class="view statusView">
                <div class="name">Baton</div>
                <div class="detail"></div>
                <div class="session"></div>
              </div>
              <div class="view settingsView" hidden>
                <div class="settingsHead">
                  <button class="back" type="button" aria-label="Back to status">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"
                         stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M9.5 3.5 5 8l4.5 4.5"/>
                    </svg>
                  </button>
                  <span class="settingsTitle">Settings</span>
                </div>
                <div class="settingsBody"></div>
              </div>
            </div>
          </div>
        </div>`;

      const gh = root.querySelector('.gear');
      gh.addEventListener('click', (e) => {
        e.stopPropagation();
        if (root.querySelector('.settingsView').hidden) openSettingsView();
        else closeSettingsView();
      });
      root.querySelector('.back').addEventListener('click', closeSettingsView);

      // Escape backs out, the way it would in a panel
      host.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!root.querySelector('.settingsView').hidden) {
          e.stopPropagation();
          closeSettingsView();
        }
      });

      document.documentElement.appendChild(host);
      indicator = { host, root };
    }

    const state = indicatorState();
    const wrap = indicator.root.querySelector('.root');
    wrap.dataset.state = state;

    indicator.root.querySelector('.count').textContent = String(consecutive);
    indicator.root.querySelector('.state').textContent =
      settings.enabled ? STATE_LABEL[state] : 'off';

    const detail = indicator.root.querySelector('.detail');
    const session = indicator.root.querySelector('.session');
    detail.textContent = lastStatus || 'waiting for the limit banner';
    session.textContent = consecutive === 1
      ? '1 message sent this session'
      : `${consecutive} messages sent this session`;

    const gear = indicator.root.querySelector('.gear');
    gear.setAttribute('aria-expanded', String(!indicator.root.querySelector('.settingsView').hidden));
    gear.setAttribute(
      'aria-label',
      `Baton settings. Currently ${settings.enabled ? STATE_LABEL[state] : 'off'}, ${consecutive} sent.`
    );
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
        renderIndicator();
        queueTick(0);
      });
    } catch (_) {}

    try {
      chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
        if (!msg) return;
        if (msg.type === 'baton-pick') { reply({ ok: startPicker() }); return; }
        if (msg.type === 'baton-reset') { consecutive = 0; stopped = false; suppressUntil = 0; reply({ ok: true }); return; }
        if (msg.type === 'baton-pick-cancel') { stopPicker(); reply({ ok: true }); return; }
        if (msg.type !== 'baton-status') return;
        reply({
          settings, consecutive, stopped, lastStatus,
          hasNotice: !!findLimitNotice(),
          onAgentPage: onAgentPage(),
          picking: !!picker
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
