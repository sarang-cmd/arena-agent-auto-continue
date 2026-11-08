/**
 * jsdom smoke test for content.js: simulates an arena.ai/agent page that
 * shows the tool-call-limit notice, then checks that "continue" gets typed
 * and submitted exactly once.
 *
 *   node test/test.js
 */
const fs = require('fs');
const path = require('path');
let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (_) {
  console.error('jsdom is not installed. Run: npm install');
  process.exit(1);
}

const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

const LIMIT_LINE =
  'The agent reached the tool-call limit for this turn. Send a message to continue where it left off.';

function makePage({ withNotice = true, draft = '', richComposer = false, taskPrompt = false, afterNotice = '', scrollable = false } = {}) {
  const html = `<!doctype html><html><body>
    <main id="chat" ${scrollable ? 'class="scroll" style="overflow-y:auto"' : ''}>
      <div class="msg user">build me a thing</div>
      ${withNotice ? `<div class="notice" id="notice"><span>${LIMIT_LINE}</span></div>` : ''}
      ${afterNotice}
    </main>
    ${taskPrompt ? `<div id="prompt" role="dialog">
      <p>Was this task successful?</p>
      <button type="button" id="yes">Yes</button>
      <button type="button" id="no">No</button>
      <button type="button" id="keep">Keep working</button>
    </div>` : ''}
    <form id="composer">
      ${richComposer
        ? `<div id="input" contenteditable="true" role="textbox" data-placeholder="Send a message">${draft}</div>`
        : `<textarea id="input" placeholder="Send a message">${draft}</textarea>`}
      <button id="send" aria-label="Send" type="button"><svg width="16" height="16"></svg></button>
    </form>
  </body></html>`;

  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.error('jsdom error:', e.message));

  const dom = new JSDOM(html, {
    url: 'https://arena.ai/agent',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const { window } = dom;

  // jsdom has no layout: fake rects so visibility/scoring works, and a scrollable
  // conversation pane so the transcript-end check has a container to look in.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const id = this.id;
    if (id === 'input') return { width: 520, height: 48, top: 820, bottom: 868, left: 20, right: 540, x: 20, y: 820 };
    if (id === 'send') return { width: 32, height: 32, top: 828, bottom: 860, left: 560, right: 592, x: 560, y: 828 };
    if (id === 'prompt') return { width: 900, height: 220, top: 700, bottom: 920, left: 40, right: 940, x: 40, y: 700 };
    if (id === 'keep') return { width: 120, height: 34, top: 800, bottom: 834, left: 60, right: 180, x: 60, y: 800 };
    if (id === 'yes' || id === 'no') return { width: 120, height: 34, top: 760, bottom: 794, left: 60, right: 180, x: 60, y: 760 };
    if (this.closest && this.closest('#prompt')) {
      return { width: 860, height: 200, top: 720, bottom: 920, left: 50, right: 910, x: 50, y: 720 };
    }
    if (this.id === 'chat') return { width: 900, height: 600, top: 0, bottom: 600, left: 0, right: 900, x: 0, y: 0 };
    const inChat = this.closest && this.closest('#chat');
    if (inChat) {
      const top = 100 + (this.parentElement ? [...this.parentElement.children].indexOf(this) : 0) * 60;
      return { width: 600, height: 40, top, bottom: top + 40, left: 20, right: 620, x: 20, y: top };
    }
    if (this === window.document.body || this === window.document.documentElement) {
      return { width: 1200, height: 900, top: 0, bottom: 900, left: 0, right: 1200, x: 0, y: 0 };
    }
    if (this === window.document.body) return { width: 1200, height: 900, top: 0, bottom: 900, left: 0, right: 1200, x: 0, y: 0 };
    return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0 };
  };

  // Minimal chrome.storage stub (in-memory, synchronous-ish).
  const store = {};
  window.chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb({ settings: store.settings }),
        set: (obj, cb) => { Object.assign(store, obj); cb && cb(); }
      },
      onChanged: { addListener: () => {} }
    },
    runtime: { onMessage: { addListener: () => {} }, lastError: null }
  };

  // Record what happens in the composer.
  window.__log = { submits: [], values: [] };
  const input = window.document.getElementById('input');
  const readText = () =>
    input.tagName === 'TEXTAREA' ? input.value : (input.textContent || '').trim();
  const clearInput = () => {
    if (input.tagName === 'TEXTAREA') input.value = '';
    else input.textContent = '';
  };
  window.document.getElementById('send').addEventListener('click', () => {
    window.__log.submits.push({ via: 'click', text: readText() });
    // Simulate the app accepting the message: notice disappears.
    const n = window.document.getElementById('notice');
    if (n) n.remove();
    clearInput();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      window.__log.submits.push({ via: 'enter', text: readText() });
      const n = window.document.getElementById('notice');
      if (n) n.remove();
      clearInput();
    }
  });

  // jsdom reports 0 for scrollHeight/clientHeight, which the transcript check uses
  const chat = window.document.getElementById('chat');
  if (scrollable) {
    Object.defineProperty(chat, 'scrollHeight', { value: 1600, configurable: true });
    Object.defineProperty(chat, 'clientHeight', { value: 600, configurable: true });
  }

  if (taskPrompt) {
    const prompt = window.document.getElementById('prompt');
    const composer = window.document.getElementById('composer');
    // The prompt covers the composer until it is dismissed.
    composer.style.display = 'none';
    window.__log.keepClicks = 0;
    window.document.getElementById('keep').addEventListener('click', () => {
      window.__log.keepClicks += 1;
      prompt.remove();
      composer.style.display = '';
    });
    window.document.getElementById('yes').addEventListener('click', () => {
      window.__log.keepClicks += 1; // a wrong click registers the same way
    });
  }

  return { dom, window, store, input };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const results = [];
  const check = (name, pass, extra = '') => {
    results.push({ name, pass, extra });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  - ' + extra : ''}`);
  };

  /* 1. Fires once when the exact notice appears ------------------------- */
  {
    const { window, input } = makePage();
    window.eval(CONTENT);
    await wait(2600); // loadSettings → start → tick → delay(1200)
    const sends = window.__log.submits;
    check('detects notice and sends exactly once', sends.length === 1, `sends=${sends.length}`);
    check('sends the word "continue"', sends[0] && sends[0].text === 'continue', JSON.stringify(sends[0] && sends[0].text));
    window.close();
  }

  /* 2. Does not fire when there is no notice ---------------------------- */
  {
    const { window } = makePage({ withNotice: false });
    window.eval(CONTENT);
    await wait(2600);
    check('silent when no notice is present', window.__log.submits.length === 0,
      `sends=${window.__log.submits.length}`);
    window.close();
  }

  /* 3. Never overwrites a draft ----------------------------------------- */
  {
    const { window } = makePage({ draft: 'my half-written prompt' });
    window.eval(CONTENT);
    await wait(2600);
    check('skips when composer already has text', window.__log.submits.length === 0,
      `sends=${window.__log.submits.length}`);
    window.close();
  }

  /* 4. Notice that stays put does not cause a send storm ---------------- */
  {
    const { window, input } = makePage();
    // Reproduce the notice right after each send so it never clears.
    const obs = new window.MutationObserver(() => {
      if (!window.document.getElementById('notice')) {
        const d = window.document.createElement('div');
        d.id = 'notice';
        d.innerHTML = `<span>${LIMIT_LINE}</span>`;
        window.document.getElementById('chat').appendChild(d);
      }
    });
    window.eval(CONTENT);
    obs.observe(window.document.body, { childList: true, subtree: true });
    await wait(9000);
    const n = window.__log.submits.length;
    check('no repeat fires for a notice that never clears', n <= 1, `sends=${n} in 9s`);
    obs.disconnect();
    window.close();
  }

  /* 5. Re-arms after the conversation moves on -------------------------- */
  {
    const { window } = makePage();
    window.eval(CONTENT);
    await wait(2600);
    const first = window.__log.submits.length;
    // give the page a clear "turn moved on" window before the next limit
    await wait(2400);
    // the agent answers, which is what makes the next banner a new request
    const answer = window.document.createElement('div');
    answer.className = 'msg agent';
    answer.textContent = 'Step 15 finished. Starting step 16.';
    window.document.getElementById('chat').appendChild(answer);
    await wait(400);
    // second limit later in the same conversation
    const d = window.document.createElement('div');
    d.id = 'notice';
    d.innerHTML = `<span>${LIMIT_LINE}</span>`;
    window.document.getElementById('chat').appendChild(d);
    await wait(9000);
    check('fires again on a later, separate limit notice',
      window.__log.submits.length === first + 1,
      `sends=${window.__log.submits.length} (first=${first})`);
    window.close();
  }

  /* 6. Partial / similar text must not trigger -------------------------- */
  {
    const { window } = makePage({ withNotice: false });
    const d = window.document.createElement('div');
    d.innerHTML = '<span>Send a message to continue where it left off.</span>';
    window.document.getElementById('chat').appendChild(d);
    window.eval(CONTENT);
    await wait(2600);
    check('ignores the continue line without the tool-call limit line',
      window.__log.submits.length === 0, `sends=${window.__log.submits.length}`);
    window.close();
  }

  /* 7. Contenteditable composer (ProseMirror-style) without send button */
  {
    const { window, input } = makePage({ richComposer: true });
    window.document.getElementById('send').remove();
    window.eval(CONTENT);
    await wait(2600);
    const sends = window.__log.submits;
    check('works with a contenteditable composer (Enter path)',
      sends.length === 1 && sends[0].via === 'enter' && sends[0].text === 'continue',
      JSON.stringify(sends));
    check('contenteditable cleaned up after send',
      (input.textContent || '').trim() === '', JSON.stringify(input.textContent));
    window.close();
  }

  /* 8. Notice flapping (detach/re-attach without a real turn change) ---- */
  {
    const { window } = makePage();
    window.eval(CONTENT);
    await wait(2600); // first send happens here
    const first = window.__log.submits.length;
    const chat = window.document.getElementById('chat');
    for (let i = 0; i < 6; i++) {
      const n = window.document.getElementById('notice');
      if (n) n.remove();
      await wait(120);
      if (!window.document.getElementById('notice')) {
        const d = window.document.createElement('div');
        d.id = 'notice';
        d.innerHTML = `<span>${LIMIT_LINE}</span>`;
        chat.appendChild(d);
      }
      await wait(120);
    }
    await wait(1500);
    check('re-render flapping does not cause a second send',
      window.__log.submits.length === first,
      `sends=${window.__log.submits.length} (first=${first})`);
    window.close();
  }

  /* 9. The task prompt covers the composer: click Keep working, then send */
  {
    const { window } = makePage({ taskPrompt: true });
    window.eval(CONTENT);
    await wait(4000);
    const keeps = window.__log.keepClicks || 0;
    const sends = window.__log.submits;
    check('clicks Keep working when the task prompt is showing', keeps === 1, `keepClicks=${keeps}`);
    check('sends continue after the prompt is dismissed',
      sends.length === 1 && sends[0].text === 'continue', JSON.stringify(sends));
    window.close();
  }

  /* 10. No task prompt: nothing else gets clicked */
  {
    const { window } = makePage();
    window.eval(CONTENT);
    await wait(3000);
    check('does not click anything when there is no task prompt',
      (window.__log.keepClicks || 0) === 0 && window.__log.submits.length === 1,
      `keepClicks=${window.__log.keepClicks || 0} sends=${window.__log.submits.length}`);
    window.close();
  }

  /* 11. A Keep working button elsewhere on the page is not clicked */
  {
    const { window } = makePage();
    const stray = window.document.createElement('div');
    stray.innerHTML = '<button id="strayKeep">Keep working</button>';
    // outside the transcript, so it must not disturb the fresh-notice rule
    window.document.getElementById('composer').appendChild(stray);
    window.__log.strayClicks = 0;
    window.document.getElementById('strayKeep').addEventListener('click', () => {
      window.__log.strayClicks += 1;
    });
    window.eval(CONTENT);
    await wait(3000);
    check('ignores a Keep working button outside the prompt',
      (window.__log.strayClicks || 0) === 0 && window.__log.submits.length === 1,
      `stray=${window.__log.strayClicks} sends=${window.__log.submits.length}`);
    window.close();
  }

  /* 12. A banner from an earlier turn must be ignored */
  {
    const later = '<div class="msg agent">Done. The build passed.</div><div class="msg agent">Anything else?</div>';
    const { window } = makePage({ afterNotice: later, scrollable: true });
    window.eval(CONTENT);
    await wait(3000);
    check('ignores a limit banner that is not the latest message',
      window.__log.submits.length === 0, `sends=${window.__log.submits.length}`);
    window.close();
  }

  /* 13. Same, but the banner is the newest thing: it should fire */
  {
    const { window } = makePage({ scrollable: true });
    window.eval(CONTENT);
    await wait(3000);
    check('still acts when the banner is the latest message',
      window.__log.submits.length === 1, `sends=${window.__log.submits.length}`);
    window.close();
  }

  /* 14. Nothing new since the last send: do not send again */
  {
    const { window } = makePage({ scrollable: true });
    window.eval(CONTENT);
    await wait(3000);
    const first = window.__log.submits.length;
    // banner never clears and the transcript never changes
    const chat = window.document.getElementById('chat');
    const d = window.document.createElement('div');
    d.id = 'notice';
    d.innerHTML = `<span>${LIMIT_LINE}</span>`;
    chat.appendChild(d);
    await wait(9000);
    check('does not resend when no new agent output has appeared',
      window.__log.submits.length === first, `sends=${window.__log.submits.length} (first=${first})`);
    window.close();
  }

  /* 15. A user picked override is clicked instead of the built-in selector */
  {
    const { window } = makePage({ taskPrompt: true });
    // point the override at the Yes button to prove the override wins
    window.__log.overrideClicks = 0;
    window.document.getElementById('yes').addEventListener('click', () => {
      window.__log.overrideClicks += 1;
    });
    window.chrome.storage.local.get = (keys, cb) => cb({
      settings: { useKeepWorking: true, override: { selector: '#yes', x: null, y: null, text: 'Yes' } }
    });
    window.eval(CONTENT);
    await wait(4000);
    check('uses the saved override selector when one exists',
      (window.__log.overrideClicks || 0) === 1, `overrideClicks=${window.__log.overrideClicks}`);
    window.close();
  }

  /* 16. Coordinate fallback clicks whatever is at that share of the window */
  {
    const { window } = makePage({ taskPrompt: true });
    window.__log.coordClicks = 0;
    const keep = window.document.getElementById('keep');
    keep.addEventListener('click', () => { window.__log.coordClicks += 1; });
    // elementFromPoint is not implemented in jsdom, so provide the mapping the
    // content script uses: a share of the window resolves to the Keep button.
    window.document.elementFromPoint = (x, y) => {
      return x > 0 && y > 0 ? keep : null;
    };
    window.chrome.storage.local.get = (keys, cb) => cb({
      settings: { useKeepWorking: true, override: { selector: '', x: 0.5, y: 0.55, text: '' } }
    });
    window.eval(CONTENT);
    await wait(4000);
    check('falls back to the stored position when no selector matches',
      (window.__log.coordClicks || 0) >= 1, `coordClicks=${window.__log.coordClicks}`);
    window.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
