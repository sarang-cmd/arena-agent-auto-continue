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
    override: null
  };

  const FIELDS = [
    ['enabled', 'Auto-send', 'Answers the limit banner', 'switch'],
    ['requireFreshNotice', 'Only act on a fresh limit', 'Ignores banners left in the history', 'switch'],
    ['useKeepWorking', 'Click Keep working first', 'Clears the task prompt over the message box', 'switch'],
    ['skipIfDraft', 'Skip if you have typed something', 'Your draft always wins', 'switch'],
    ['onlyVisibleTab', 'Only when tab is visible', 'Stops two tabs answering at once', 'switch'],
    ['showIndicator', 'Show this pill on the page', 'Turn off when it gets in the way', 'switch'],
    ['message', 'Message', null, 'text'],
    ['delayMs', 'Delay', 'Milliseconds before sending', 'number'],
    ['maxConsecutive', 'Safety cap', 'Pauses after this many sends', 'number']
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

  function markup(compact = false) {
    const shown = compact ? FIELDS.filter(([, , , kind]) => kind === 'switch') : FIELDS;
    const rows = shown.map(([key, label, hint, kind]) => {
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
    }).join('');

    return `
      <div class="panel" data-compact="${compact}">
        <div class="update" id="baton-update" hidden>
          <span id="baton-update-text"></span>
          <a id="baton-update-link" href="#" target="_blank" rel="noopener">Download</a>
        </div>

        ${compact ? '' : '<h3>Behaviour</h3>'}
        <div class="rows">${rows}</div>

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

  function load() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['settings'], (res) => {
          resolve({ ...DEFAULTS, ...((res && res.settings) || {}) });
        });
      } catch (_) {
        resolve({ ...DEFAULTS });
      }
    });
  }

  function save(settings) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ settings }, resolve);
      } catch (_) {
        resolve();
      }
    });
  }

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
      const next = { ...(await load()), ...patch };
      await save(next);
      renderTarget(next);
      flash();
    };

    fill(settings);

    for (const [key] of FIELDS) {
      const el = panel.querySelector(`[data-key="${key}"]`);
      if (!el) continue;
      el.addEventListener('change', () => commit({ [key]: readValue(el) }));
    }

    panel.querySelector('#baton-reset').addEventListener('click', async () => {
      const next = { ...(await load()), enabled: true };
      await save(next);
      // clearing a paused state needs the live page to know
      try {
        chrome.runtime.sendMessage({ type: 'baton-reset' }, () => void chrome.runtime.lastError);
      } catch (_) {}
      fill(next);
      flash();
    });

    const defaultsBtn = panel.querySelector('#baton-defaults');
    if (defaultsBtn) defaultsBtn.addEventListener('click', async () => {
      const next = { ...DEFAULTS };
      await save(next);
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
