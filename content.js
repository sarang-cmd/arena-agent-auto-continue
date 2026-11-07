/**
 * Arena Agent Auto-Continue
 * Detects the tool-call limit banner on arena.ai/agent and sends one message
 * so the agent can keep working.
 */
(() => {
  if (window.__arenaAutoContinueLoaded) return;
  window.__arenaAutoContinueLoaded = true;

  const MESSAGE = 'continue';
  const RE_LIMIT = /reached the tool[-\s]?call limit/i;
  const RE_CONTINUE = /send (?:a )?message to continue/i;

  let fired = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

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
    while ((node = walker.nextNode())) {
      if (RE_LIMIT.test(node.nodeValue)) return node.parentElement;
    }
    return null;
  }

  function looksLikeSearch(el) {
    const hint = [
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('role'),
      el.id,
      el.className
    ].filter((v) => typeof v === 'string').join(' ');
    return /search|filter/i.test(hint);
  }

  function findComposer() {
    const selectors = ['textarea', 'div[contenteditable="true"]', '[contenteditable="true"]', '[role="textbox"]'];
    const candidates = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.disabled || el.readOnly) continue;
        if (!isVisible(el) || looksLikeSearch(el)) continue;
        candidates.push(el);
      }
    }
    if (!candidates.length) return null;
    const vh = window.innerHeight || 800;
    return candidates
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, score: r.width * (r.top > vh * 0.35 ? 1.5 : 0.6) + r.top * 0.25 };
      })
      .sort((a, b) => b.score - a.score)[0].el;
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
      return;
    }
    // contenteditable editors (ProseMirror, TipTap, Lexical) handle insertText
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
    try {
      const r2 = document.createRange();
      r2.selectNodeContents(el);
      r2.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r2);
    } catch (_) {}
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
  }

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
        return isVisible(b) && (b.querySelector('svg') || /send|submit/i.test(label));
      });
      if (match) { match.click(); return true; }
      scope = scope.parentElement;
    }
    return false;
  }

  async function doSend() {
    const composer = findComposer();
    if (!composer) return false;
    if (hasDraft(composer)) return false;
    insertText(composer, MESSAGE);
    await sleep(150);
    if (!clickSendButton(composer)) pressEnter(composer);
    return true;
  }

  function tick() {
    if (fired) return;
    if (!findLimitNotice()) return;
    fired = true;
    doSend();
  }

  const start = () => {
    new MutationObserver(() => tick()).observe(document.body, { childList: true, subtree: true, characterData: true });
    tick();
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
