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

  // One send per page load is enough for this first version.

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

  function findComposer() {
    const selectors = ['textarea', 'div[contenteditable="true"]', '[contenteditable="true"]', '[role="textbox"]'];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.disabled || el.readOnly) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 4) return el;
      }
    }
    return null;
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function send(el) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = MESSAGE;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.textContent = MESSAGE;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: MESSAGE }));
    }
    pressEnter(el);
  }

  function tick() {
    if (fired) return;
    const notice = findLimitNotice();
    if (!notice) return;
    const composer = findComposer();
    if (!composer) return;
    fired = true;
    send(composer);
  }

  const start = () => {
    new MutationObserver(() => tick()).observe(document.body, { childList: true, subtree: true, characterData: true });
    tick();
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
