/* Interactive simulation for the landing page.
   It reproduces the notice and the send, using the same copy the extension
   looks for. Nothing here talks to arena.ai. */

(() => {
  const limitLine =
    'The agent reached the tool-call limit for this turn. Send a message to continue where it left off.';

  const well = document.getElementById('console');
  const notice = document.getElementById('notice');
  const field = document.getElementById('field');
  const send = document.getElementById('send');
  const toggle = document.getElementById('autoToggle');
  const run = document.getElementById('runDemo');
  const state = document.getElementById('consoleState');
  const status = document.getElementById('switchStatus');

  if (!well || !notice || !field) return;

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const timers = new Set();
  let running = false;

  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const clearAll = () => { for (const id of timers) clearTimeout(id); timers.clear(); };
  const dur = (ms) => (prefersReduced.matches ? Math.min(ms, 60) : ms);

  function addLine(text, cls) {
    const el = document.createElement('div');
    el.className = 'line ' + (cls || '');
    el.textContent = text;
    well.insertBefore(el, notice);
    return el;
  }

  function setStatus(text) {
    if (state) state.textContent = text;
  }

  function reset() {
    clearAll();
    running = false;
    notice.classList.remove('shown');
    field.classList.add('empty');
    field.textContent = '';
    const c = document.createElement('span');
    c.className = 'caret';
    field.appendChild(c);
    well.querySelectorAll('.line:not(:first-child)').forEach((n) => n.remove());
    if (send) send.disabled = false;
    setStatus('waiting');
    if (run) run.disabled = false;
  }

  function typeMessage(text) {
    if (prefersReduced.matches) {
      field.classList.remove('empty');
      field.textContent = text;
      return dur(120);
    }
    return new Promise((resolve) => {
      let i = 0;
      field.classList.remove('empty');
      const caret = document.createElement('span');
      caret.className = 'caret';
      field.textContent = '';
      field.appendChild(caret);
      const step = () => {
        if (i >= text.length) { resolve(); return; }
        caret.before(document.createTextNode(text[i++]));
        later(step, 45);
      };
      later(step, 60);
    });
  }

  async function runSequence() {
    if (running) { reset(); return; }
    running = true;
    if (run) run.disabled = true;
    setStatus('agent working');

    if (!toggle || !toggle.checked) {
      later(() => { notice.classList.add('shown'); setStatus('limit reached, auto-continue off'); if (run) run.disabled = false; running = false; }, dur(700));
      return;
    }

    later(() => {
      notice.classList.add('shown');
      addLine('build step 14 of 22 finished', 'agent');
      setStatus('limit reached');
    }, dur(600));

    later(async () => {
      setStatus('typing');
      await typeMessage('continue');
      later(() => {
        const el = addLine('you: continue', 'sent');
        notice.classList.remove('shown');
        field.classList.add('empty');
        field.textContent = '';
        setStatus('sent, agent resumed');
        later(() => {
          el.remove();
          running = false;
          if (run) run.disabled = false;
        }, dur(2600));
      }, dur(420));
    }, dur(1800));
  }

  if (run) run.addEventListener('click', () => { reset(); runSequence(); });

  if (toggle) {
    toggle.addEventListener('change', () => {
      if (status) {
        status.textContent = toggle.checked
          ? 'On. One message per banner, then it waits.'
          : 'Off. You press send yourself.';
      }
      reset();
    });
  }

  // Pressing send in the simulation behaves like the extension: one message,
  // then the console goes quiet.
  if (send) {
    send.addEventListener('click', (e) => {
      e.preventDefault();
      if (running) return;
      reset();
      running = true;
      notice.classList.add('shown');
      setStatus('limit reached');
      later(async () => {
        await typeMessage('continue');
        later(() => {
          addLine('you: continue', 'sent');
          notice.classList.remove('shown');
          field.classList.add('empty');
          field.textContent = '';
          setStatus('sent, agent resumed');
          running = false;
        }, dur(320));
      }, dur(500));
    });
  }

  // Start in the resting state.
  setStatus('waiting');
})();
