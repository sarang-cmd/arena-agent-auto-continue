/**
 * Baton panel
 * ------------------------------------------------------------------
 * One settings UI, used in two places:
 *   - inside the on-page pill, opened with the gear
 *   - on settings.html, opened from the toolbar icon
 *
 * Both mount the same markup and talk to chrome.storage directly, so a toggle
 * in either place is the same change. Nothing here needs a background page.
 */
(() => {
  // one store, shared with the content script and any other open surface
  const store = window.BatonSettings;
  if (!store) {
    console.error('Baton: ui/settings.js has to load before ui/panel.js');
    return;
  }
  const DEFAULTS = store.DEFAULTS;

  // [key, label, hint, kind, group]. The pill only carries the first group, so
  // it stays six rows instead of scrolling.
  const FIELDS = [
    ['enabled', 'Auto-send', 'Answers the limit banner', 'switch', 'behaviour'],
    ['requireFreshNotice', 'Only act on a fresh limit', 'Ignores banners left in the history', 'switch', 'behaviour'],
    ['useKeepWorking', 'Click Keep working first', 'Clears the task prompt over the message box', 'switch', 'behaviour'],
    ['skipIfDraft', 'Skip if you have typed something', 'Your draft always wins', 'switch', 'behaviour'],
    ['onlyVisibleTab', 'Only when tab is visible', 'Stops two tabs answering at once', 'switch', 'behaviour'],
    ['showIndicator', 'Show this pill on the page', 'Turn off when it gets in the way', 'switch', 'behaviour'],
    ['message', 'Message', 'What it types', 'text', 'behaviour'],
    ['delayMs', 'Delay', 'Milliseconds before sending', 'number', 'behaviour'],
    ['maxConsecutive', 'Safety cap', 'Pauses after this many sends', 'number', 'behaviour'],
    ['notifyResponseDone', 'Response complete', 'When the agent finishes a response', 'switch', 'events'],
    ['notifyQuestionAsked', 'Agent asks a question', 'When it stops and waits for your answer', 'switch', 'events'],
    ['notifyToolLimit', 'Tool-call limit', 'When the run stops at the limit', 'switch', 'events'],
    ['includeNotificationText', 'Include text in notification', 'Off: the body is never model output', 'switch', 'events'],
    ['notifyOnPause', 'Notify when Baton pauses', 'At the safety cap, or after a send that changed nothing', 'switch', 'alerts']
  ];

  const CSS = `
    * { box-sizing: border-box; }

    .panel {
      font: 400 12px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      color: #e7e3da;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .panel ::-webkit-scrollbar { width: 0; height: 0; display: none; }

    .panel h3 {
      margin: 0 0 7px;
      font: 600 10.5px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .04em;
      color: #8b877e;
    }

    .rows { border-top: 1px solid rgba(255,255,255,.08); }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,.06);
    }
    .row > label { cursor: pointer; min-width: 0; flex: 1 1 auto; }
    .row > .switch, .row > .field { flex: 0 0 auto; }
    .label-text { display: block; color: #ece8df; }
    .hint { display: block; font-size: 10.5px; color: #8b877e; margin-top: 1px; }

    /* switch */
    .switch { position: relative; width: 38px; height: 21px; flex: 0 0 auto; }
    .switch input {
      position: absolute; inset: 0; width: 100%; height: 100%;
      margin: 0; opacity: 0; cursor: pointer; z-index: 2;
    }
    .track {
      position: absolute; inset: 0; border-radius: 999px;
      background: #2a2a29;
      box-shadow: inset 0 1px 2px rgba(0,0,0,.5);
      transition: background-color .16s ease;
      pointer-events: none;
    }
    .track::after {
      content: ""; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px;
      border-radius: 50%; background: #6e6a63;
      transition: transform .16s cubic-bezier(.32,.72,0,1), background-color .16s ease;
    }
    .switch input:checked + .track { background: #2a5f63; }
    .switch input:checked + .track::after { transform: translateX(17px); background: #eef1ea; }
    .switch input:focus-visible + .track { outline: 2px solid #7fb3b7; outline-offset: 2px; }

    /* inputs: no native steppers, no scrollbars */
    .field {
      width: 84px; flex: 0 0 auto;
      background: #232322;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 7px;
      color: #f0ece4;
      font: 500 11.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      padding: 6px 8px;
      text-align: right;
      appearance: textfield;
      -moz-appearance: textfield;
      -webkit-appearance: none;
    }
    /* the free-text row takes the remaining width instead of overhanging it */
    .field.wide {
      flex: 1 1 auto;
      width: auto;
      min-width: 0;
      text-align: left;
    }
    .field::-webkit-outer-spin-button,
    .field::-webkit-inner-spin-button { -webkit-appearance: none; appearance: none; margin: 0; }
    .field::-ms-clear, .field::-ms-reveal { display: none; }
    .field:focus-visible { outline: 2px solid #7fb3b7; outline-offset: 1px; border-color: transparent; }

    .section { margin-top: 14px; }

    .search {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 0 0 10px;
      padding: 0 9px;
      border-radius: 8px;
      background: #232322;
      border: 1px solid rgba(255, 255, 255, .08);
      color: #8b877e;
    }
    .search:focus-within { border-color: #4d7f83; }
    .search input {
      flex: 1 1 auto;
      min-width: 0;
      border: 0;
      background: none;
      color: #ece8df;
      font: 400 12px/1 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 8px 0;
      appearance: none;
    }
    .search input:focus { outline: none; }
    .search input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
    .search input::placeholder { color: #7e7a72; }

    .row[hidden] { display: none; }
    .noresults { margin: 8px 0 0; font-size: 11px; color: #8b877e; }
    .panel[data-compact="true"] .row { padding: 5px 0; }
    .panel[data-compact="true"] .rows { border-top: 0; }
    .panel[data-compact="true"] .label-text { font-size: 11.5px; }
    .panel[data-compact="true"] .actions { margin-top: 10px; }

    .actions { display: flex; gap: 6px; margin-top: 12px; }
    .btn {
      flex: 1 1 auto;
      font: 600 11px/1 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 8px 9px;
      border: 0;
      border-radius: 7px;
      background: #2a2a29;
      color: #e7e3da;
      cursor: pointer;
      transition: background-color .14s ease;
    }
    .btn:hover { background: #33332f; }
    .btn:active { background: #1f1f1e; }
    .btn:focus-visible { outline: 2px solid #7fb3b7; outline-offset: 2px; }
    .btn.primary { background: #2a5f63; color: #f2f6f1; }
    .btn.primary:hover { background: #357074; }

    .saved {
      flex: 0 0 auto;
      align-self: center;
      padding: 0 2px;
      font-size: 10.5px;
      color: #79c3a1;
      opacity: 0;
      transition: opacity .16s;
    }
    .saved.show { opacity: 1; }

    /* target override */
    .current {
      font: 400 10.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #a8a49b;
      background: #1e1e1d;
      border-radius: 6px;
      padding: 7px 8px;
      overflow-wrap: anywhere;
      margin-bottom: 7px;
    }
    .current b { color: #9fc6c9; font-weight: 600; }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr auto; gap: 5px; margin-top: 5px; }
    .grid3 .field { width: 100%; text-align: center; }
    #baton-diag-note { white-space: pre-line; }
  #baton-diag-raw pre { white-space: pre-wrap; word-break: break-word; font-size: 11px;
    line-height: 1.45; margin: 0.6rem 0 0; color: var(--ink-2, #55595c); }
  #baton-diag-raw summary { cursor: pointer; font-size: 12px; margin-top: 0.7rem; }
  .note { margin-top: 8px; font-size: 10.5px; color: #7e7a72; line-height: 1.45; }
    .update {
      background: rgba(211,160,92,.12);
      border-left: 2px solid #d3a05c;
      border-radius: 5px;
      padding: 7px 8px;
      margin-bottom: 10px;
      font-size: 10.5px;
      color: #dcc39b;
    }
    .update a { color: #e8cf9f; }
  `;

  const svg = (paths, extra = '') =>
    `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

  const ICONS = {
    gear: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"
      stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="8" cy="8" r="3"/>
      <circle cx="8" cy="8" r="5"/>
      <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.3 3.3l1.15 1.15M11.55 11.55l1.15 1.15M12.7 3.3l-1.15 1.15M4.45 11.55l-1.15 1.15"/>
    </svg>`,
    back: svg('<path d="M9.5 3.5 5 8l4.5 4.5"/>')
  };

  const rowFor = (key, label, hint, kind, compact) => {
    {
      if (kind === 'switch') {
        return `<div class="row">
          <label for="baton-${key}">
            <span class="label-text">${label}</span>
            ${hint && !compact ? `<span class="hint">${hint}</span>` : ''}
          </label>
          <span class="switch"><input type="checkbox" id="baton-${key}" data-key="${key}"><span class="track"></span></span>
        </div>`;
      }
      return `<div class="row">
        <label for="baton-${key}">
          <span class="label-text">${label}</span>
          ${hint ? `<span class="hint">${hint}</span>` : ''}
        </label>
        <input class="field${kind === 'text' ? ' wide' : ''}" id="baton-${key}" data-key="${key}"
          type="${kind}" ${kind === 'number' ? 'min="0" step="100" inputmode="numeric"' : 'spellcheck="false" autocomplete="off"'}>
      </div>`;
    }
  };

  function markup(compact = false) {
    const shown = compact
      ? FIELDS.filter(([, , , kind, group]) => kind === 'switch' && group === 'behaviour')
      : FIELDS.filter(([, , , , group]) => group === 'behaviour');
    const alerts = FIELDS.filter(([, , , , group]) => group === 'alerts');
    const notifications = FIELDS.filter(([, , , , group]) => group === 'events');
    const rows = shown.map((f) => rowFor(...f, compact)).join('');
    const alertRows = alerts.map((f) => rowFor(...f, compact)).join('');
    const notifyRows = notifications.map((f) => rowFor(...f, compact)).join('');

    return `
      <div class="panel" data-compact="${compact}">
        <div class="update" id="baton-update" hidden>
          <span id="baton-update-text"></span>
          <a id="baton-update-link" href="#" target="_blank" rel="noopener">Download</a>
        </div>

        ${compact ? '' : `
        <div class="search">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"
               stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/>
          </svg>
          <input id="baton-search" type="search" placeholder="Search settings" aria-label="Search settings"
                 autocomplete="off" spellcheck="false" />
        </div>`}
        <h3>Behaviour</h3>
        <div class="rows" data-group="behaviour">${rows}</div>
        <p class="noresults" id="baton-noresults" hidden>No setting matches that.</p>

        ${compact ? '' : `
        <div class="section">
          <h3>Notifications</h3>
          <div class="rows" data-group="events">${notifyRows}</div>
          <div class="actions">
            <button class="btn" type="button" id="baton-test-notify">Send a test notification</button>
          </div>
          <p class="note" id="baton-events-note">
            These arrive in your operating system. The body names the event and the thread, never the
            answer, unless you switch text on above.
          </p>
        </div>


        <div class="section">
          <h3>Diagnostics</h3>
          <div class="rows">
            <div class="row">
              <div class="label">
                <span>Last report from a page</span>
                <small id="baton-diag-head">No report yet</small>
              </div>
            </div>
          </div>
          <div class="actions">
            <button class="btn" type="button" id="baton-diag-refresh">Refresh</button>
            <button class="btn" type="button" id="baton-diag-test">Send a test completion event</button>
          </div>
          <p class="note" id="baton-diag-note">
            This is what Baton sees, not what it thinks. It holds key names, part types and lengths,
            never your text. If a run finishes and this still says nothing, the button above proves
            which half is broken.
          </p>
          <details id="baton-diag-raw" hidden>
            <summary>Raw report, for a bug report</summary>
            <pre id="baton-diag-json"></pre>
          </details>
        </div>

        <div class="section">
          <h3>Alerts</h3>
          <div class="rows" data-group="alerts">${alertRows}</div>
          <p class="note" id="baton-notify-note">Baton's own status messages, separate from the three events above.</p>
        </div>`}

        ${compact ? `
        <div class="actions">
          <button class="btn" type="button" id="baton-reset">Reset counter</button>
          <button class="btn primary" type="button" id="baton-all">All settings</button>
        </div>` : `
        <div class="section">
          <h3>Keep working button</h3>
          <div class="current" id="baton-target">Using the built-in selector.</div>
          <div class="actions">
            <button class="btn" type="button" id="baton-pick">Pick on page</button>
            <button class="btn" type="button" id="baton-clear">Use built-in</button>
          </div>
          <div class="grid3">
            <input class="field" id="baton-x" type="number" placeholder="X %" min="0" max="100" step="0.5" inputmode="numeric">
            <input class="field" id="baton-y" type="number" placeholder="Y %" min="0" max="100" step="0.5" inputmode="numeric">
            <button class="btn" type="button" id="baton-set" style="flex:0 0 auto">Set</button>
          </div>
          <p class="note">
            If Arena moves the button, pick it once. The position is stored as a share of the window,
            so a resize does not throw it off.
          </p>
        </div>

        <div class="actions">
          <button class="btn primary" type="button" id="baton-reset">Reset counter</button>
          <button class="btn" type="button" id="baton-defaults">Restore defaults</button>
          <span class="saved" id="baton-saved">saved</span>
        </div>`}
      </div>`;
  }

  const REPO = 'sarang-cmd/baton';

  const load = () => store.ready();
  const save = (patch) => store.save(patch);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function readValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') {
      const n = Number(el.value);
      return Number.isFinite(n) ? n : DEFAULTS[el.dataset.key];
    }
    return el.value.trim() || DEFAULTS[el.dataset.key];
  }

  /**
   * Mount the settings UI inside root. Works in a shadow root and in a normal
   * document, because it only relies on scoped ids and its own CSS.
   */
  async function mount(root, options = {}) {
    const { onClose = null, compact = false } = options;

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const holder = document.createElement('div');
    holder.innerHTML = markup(compact).trim();
    root.appendChild(holder);

    const panel = holder.querySelector('.panel');
    // fill() and renderTarget() are defined below; the first paint happens after them
    const settings = await load();

    const fill = (s) => {
      for (const [key] of FIELDS) {
        const el = panel.querySelector(`[data-key="${key}"]`);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!s[key];
        else el.value = s[key];
      }
      renderTarget(s);
    };

    const renderTarget = (s) => {
      const box = panel.querySelector('#baton-target');
      if (!box) return;
      const o = s.override;
      if (!o) {
        box.textContent = 'Using the built-in selector.';
      } else {
        const bits = [];
        if (o.selector) bits.push('selector <b>' + escapeHtml(o.selector) + '</b>');
        if (o.x != null && o.y != null) {
          bits.push('position <b>' + Math.round(o.x * 100) + '%, ' + Math.round(o.y * 100) + '%</b>');
        }
        box.innerHTML = bits.length ? 'Custom target: ' + bits.join(' · ') : 'Using the built-in selector.';
      }
      const x = panel.querySelector('#baton-x');
      const y = panel.querySelector('#baton-y');
      if (x) x.value = o && o.x != null ? Math.round(o.x * 100) : '';
      if (y) y.value = o && o.y != null ? Math.round(o.y * 100) : '';
    };

    const flash = () => {
      const s = panel.querySelector('#baton-saved');
      if (!s) return;
      s.classList.add('show');
      setTimeout(() => s.classList.remove('show'), 1000);
    };

    const commit = async (patch) => {
      const next = await save(patch);
      renderTarget(next);
      flash();
    };

    fill(settings);

    // a change made anywhere else (the page, another tab, the pill) lands here too
    const unsubscribe = store.subscribe((next) => {
      const active = panel.ownerDocument.activeElement;
      for (const [key] of FIELDS) {
        const el = panel.querySelector(`[data-key="${key}"]`);
        if (!el || el === active) continue;
        if (el.type === 'checkbox') {
          if (el.checked !== !!next[key]) el.checked = !!next[key];
        } else if (el !== active) {
          if (String(el.value) !== String(next[key])) el.value = next[key];
        }
      }
      renderTarget(next);
    });

    for (const [key] of FIELDS) {
      const el = panel.querySelector(`[data-key="${key}"]`);
      if (!el) continue;
      el.addEventListener('change', () => commit({ [key]: readValue(el) }));
    }

    /* ------------------------------------------------------------- search */
    const search = panel.querySelector('#baton-search');
    if (search) {
      const allRows = [...panel.querySelectorAll('.row')];
      const empty = panel.querySelector('#baton-noresults');
      const apply = () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        for (const row of allRows) {
          const text = row.textContent.toLowerCase();
          const hit = !q || text.includes(q);
          row.hidden = !hit;
          if (hit) shown += 1;
        }
        if (empty) empty.hidden = shown > 0;
        // a group with every row filtered out should not leave its heading behind
        for (const group of panel.querySelectorAll('.rows')) {
          const heading = group.previousElementSibling;
          const visible = [...group.querySelectorAll('.row')].some((r) => !r.hidden);
          if (heading && heading.tagName === 'H3') heading.hidden = !visible;
          group.hidden = !visible;
        }
      };
      search.addEventListener('input', apply);
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && search.value) {
          e.stopPropagation();
          search.value = '';
          apply();
        }
      });
      apply();
    }

    /* ------------------------------------------------------- notifications */
    // the notifications permission is granted at install, so this reports state
    // rather than asking: if it is missing, the user turned it off in Chrome
    const note = panel.querySelector('#baton-events-note');
    const testBtnNote = () => note && note.dataset.default;
    if (note) note.dataset.default = note.textContent.trim();

    const refreshNotify = async () => {
      if (!note) return;
      let granted = true;
      try {
        granted = await new Promise((r) =>
          chrome.permissions.contains({ permissions: ['notifications'] },
            (yes) => r(!!yes && !(chrome.runtime && chrome.runtime.lastError))));
      } catch (_) {}
      if (!granted) {
        note.textContent = 'Notifications are blocked for this extension. Re-enable them in Chrome, then reload the extension.';
      } else if (testBtnNote()) {
        note.textContent = testBtnNote();
      }
      note.dataset.granted = String(granted);
    };
    refreshNotify();


    /* ------------------------------------------------------- diagnostics */

    const diagHead = panel.querySelector('#baton-diag-head');
    const diagRaw = panel.querySelector('#baton-diag-raw');
    const diagJson = panel.querySelector('#baton-diag-json');
    const diagNote = panel.querySelector('#baton-diag-note');

    function describeDiag(d) {
      if (!d) return ['No report yet', 'Open an arena.ai tab and let it poll for a few seconds.'];
      const when = new Date(d.at || Date.now());
      const lines = [];
      lines.push('Reported ' + when.toLocaleTimeString() + ' from ' + (d.page || 'a page'));
      if (!d.route || !d.route.chatId) {
        lines.push('No chat id in the address bar or in the page traffic.');
      } else {
        lines.push('Chat ' + d.route.chatId + ', mode ' + d.route.mode + ', found in the ' + d.route.from);
      }
      if (d.poll) {
        lines.push('Poll ' + d.poll.endpoint + ' answered ' + (d.poll.status || 'no response') +
          (d.poll.error ? ' (' + d.poll.error + ')' : ''));
      } else {
        lines.push('Nothing has been polled yet.');
      }
      if (typeof d.messages === 'number') lines.push(d.messages + ' messages in the state');
      if (d.shape && d.shape.assistant) {
        const a = d.shape.assistant;
        lines.push('Last assistant: pending ' + (a.pending === undefined ? 'absent' : a.pending) +
          ', parts ' + (a.partTypes || []).join(', ') +
          ', states ' + (a.partStates || []).map((s) => s || 'none').join(', '));
      }
      if (d.dom) {
        lines.push('The page itself: ' + (d.dom.stopControls ? 'a Stop control is showing (a run is active)'
          : 'no Stop control') + ', ' + d.dom.streamingMarks + ' streaming marks');
      }
      if (d.decision) {
        if (d.decision.error) {
          lines.push('Decision: ' + d.decision.error);
        } else {
          lines.push('Decision: finished ' + (d.decision.finished ? 'yes' : 'no') +
            ', signal ' + (d.decision.signal || 'none') +
            ', unchanged for ' + Math.round((d.decision.unchangedMs || 0) / 1000) + 's' +
            (d.decision.baseline ? ', first poll is the baseline' : ''));
        }
      }
      if (d.events && d.events.length) {
        lines.push('Events sent: ' + d.events.map((e) => e.type).join(', '));
      } else {
        lines.push('Events sent: none yet');
      }
      if (d.intake) {
        const what = {
          created: 'a notification was created',
          'already-notified': 'refused: this turn was already notified',
          'switched-off': 'refused: that event switch is off',
          'modules-missing': 'refused: the notification modules did not load',
          'create-failed': 'Chrome refused to create it'
        }[d.intake.stage] || d.intake.stage;
        lines.push('Worker: ' + what + (d.intake.error ? ' (' + d.intake.error + ')' : ''));
      }
      if (d.history && d.history.length) {
        lines.push('Last ' + d.history.length + ' polls, newest last:');
        for (const h of d.history.slice(-6)) {
          lines.push('  ' + h.t + '  ' + h.n + ' messages, last ' + (h.lastRole || 'none') +
            (h.assistant ? ', assistant pending ' + h.pending + ', ' + h.parts + ' parts' : ', no assistant message') +
            (h.settled ? ', settled' : '') +
            (h.out && h.out.length ? '  -> ' + h.out.join(', ') : ''));
        }
      }
      return lines;
    }

    function renderDiag(d) {
      if (!diagHead) return;
      const lines = describeDiag(d);
      diagHead.textContent = lines[0];
      if (diagNote) diagNote.textContent = lines.slice(1).join('\n');
      if (diagRaw && diagJson) {
        diagRaw.hidden = !d;
        diagJson.textContent = d ? JSON.stringify(d, null, 1) : '';
      }
    }

    async function loadDiag() {
      try {
        const res = await new Promise((r) => chrome.storage.session.get(['batonDiag'], (v) => r(v || {})));
        renderDiag(res.batonDiag || null);
      } catch (_) {
        renderDiag(null);
      }
    }

    const diagRefresh = panel.querySelector('#baton-diag-refresh');
    if (diagRefresh) diagRefresh.addEventListener('click', loadDiag);
    const diagTest = panel.querySelector('#baton-diag-test');
    if (diagTest) {
      diagTest.addEventListener('click', () => {
        try {
          chrome.runtime.sendMessage({ type: 'baton-test-event' }, (res) => {
            void (chrome.runtime && chrome.runtime.lastError);
            if (diagNote) {
              diagNote.textContent = res && res.ok
                ? 'Test event accepted by the worker, so the notification path works. If real runs do not notify, the problem is detection, and the report above says what Baton saw.'
                : 'The worker refused the test event. Reload the extension and try again.';
            }
          });
        } catch (_) {
          if (diagNote) diagNote.textContent = 'The extension is not answering. Reload it at chrome://extensions.';
        }
      });
    }
    if (!compact) {
      loadDiag();
      setInterval(loadDiag, 4000);
    }

    const testBtn = panel.querySelector('#baton-test-notify');
    if (testBtn) {
      testBtn.addEventListener('click', () => {
        if (note) note.textContent = 'Test sent. If nothing appeared, notifications are blocked for this extension in Chrome.';
        try {
          chrome.runtime.sendMessage({ type: 'baton-test-notification' }, () => {
            void (chrome.runtime && chrome.runtime.lastError);
          });
        } catch (_) {}
      });
    }


    if (typeof unsubscribe === 'function' && compact) {
      // the pill is rebuilt on every page load; there is nothing to tear down
    }

    panel.querySelector('#baton-reset').addEventListener('click', async () => {
      const next = await save({ enabled: true });
      // clearing a paused state needs the live page to know
      try {
        chrome.runtime.sendMessage({ type: 'baton-reset' }, () => void chrome.runtime.lastError);
      } catch (_) {}
      fill(next);
      flash();
    });

    const defaultsBtn = panel.querySelector('#baton-defaults');
    if (defaultsBtn) defaultsBtn.addEventListener('click', async () => {
      const next = await store.save({ ...DEFAULTS });
      fill(next);
      flash();
    });

    const allBtn = panel.querySelector('#baton-all');
    if (allBtn) allBtn.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'baton-open-settings' }, () => void chrome.runtime.lastError);
      } catch (_) {}
    });

    const clearBtn = panel.querySelector('#baton-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => commit({ override: null }));

    const setBtn = panel.querySelector('#baton-set');
    if (setBtn) setBtn.addEventListener('click', () => {
      const xRaw = parseFloat(panel.querySelector('#baton-x').value);
      const yRaw = parseFloat(panel.querySelector('#baton-y').value);
      const hasPoint = Number.isFinite(xRaw) && Number.isFinite(yRaw);
      if (!hasPoint) {
        panel.querySelector('#baton-target').textContent = 'Enter an X and Y percentage, or use Pick on page.';
        return;
      }
      commit({
        override: {
          selector: '',
          x: Math.min(1, Math.max(0, xRaw / 100)),
          y: Math.min(1, Math.max(0, yRaw / 100)),
          pickedAt: Date.now()
        }
      });
    });

    const pickBtn = panel.querySelector('#baton-pick');
    if (pickBtn) pickBtn.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'baton-pick' }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) {
            panel.querySelector('#baton-target').textContent =
              'Open arena.ai/agent first, then pick.';
            return;
          }
          if (onClose) onClose();
        });
      } catch (_) {}
    });

    // update notice, filled by the caller when it knows about one
    const showUpdate = (info) => {
      const box = panel.querySelector('#baton-update');
      if (!box || !info) return;
      panel.querySelector('#baton-update-text').textContent =
        `Version ${info.version} is available. You have ${chrome.runtime.getManifest().version}.`;
      panel.querySelector('#baton-update-link').href = info.downloadUrl || info.htmlUrl || `https://github.com/${REPO}/releases`;
      box.hidden = false;
    };

    return { element: panel, fill, showUpdate, compact };
  }

  window.BatonPanel = { DEFAULTS, CSS, markup, mount, load, save };
})();
