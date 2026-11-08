const DEFAULTS = {
  enabled: true,
  onlyVisibleTab: true,
  delayMs: 1200,
  cooldownMs: 2500,
  maxConsecutive: 30,
  message: 'continue',
  skipIfDraft: true,
  useKeepWorking: true,
  showIndicator: true
};

const FIELDS = ['enabled', 'onlyVisibleTab', 'useKeepWorking', 'skipIfDraft', 'showIndicator', 'message', 'delayMs', 'maxConsecutive'];
const $ = (id) => document.getElementById(id);

function load(cb) {
  chrome.storage.local.get(['settings'], (res) => {
    cb({ ...DEFAULTS, ...((res && res.settings) || {}) });
  });
}

function save(settings) {
  chrome.storage.local.set({ settings }, () => {
    const s = $('saved');
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 1000);
  });
}

function fillForm(settings) {
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!settings[f];
    else el.value = settings[f];
  }
}

function readForm() {
  const out = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    if (el.type === 'checkbox') out[f] = el.checked;
    else if (el.type === 'number') out[f] = Math.max(0, Number(el.value) || 0);
    else out[f] = el.value.trim() || DEFAULTS[f];
  }
  if (!out.maxConsecutive) out.maxConsecutive = DEFAULTS.maxConsecutive;
  return out;
}

function renderStatus(settings, stats) {
  const dot = $('dot');
  const txt = $('statusText');
  const count = $('count');
  dot.className = 'dot';

  const sent = (stats && stats.consecutive) || 0;
  if (count) count.textContent = String(sent);

  if (!settings.enabled) {
    dot.classList.add('bad');
    txt.innerHTML = 'Paused. Auto-send is <b>off</b>.';
    return;
  }
  if (stats && stats.stopped) {
    dot.classList.add('bad');
    txt.innerHTML = `Paused after <b>${sent}</b> sends. Reset the counter to start again.`;
    return;
  }
  if (!stats) {
    dot.classList.add('bad');
    txt.innerHTML = 'Not active here. Open <b>arena.ai/agent</b> to start.';
    return;
  }
  dot.classList.add('on');
  if (stats.hasNotice) {
    txt.innerHTML = 'Limit banner on screen. <b>Sending now</b>.';
  } else if (stats.lastStatus && /Keep working/i.test(stats.lastStatus)) {
    txt.innerHTML = `Cleared the task prompt. <b>Sending</b>.`;
  } else if (stats.lastStatus && /no composer|draft/i.test(stats.lastStatus)) {
    txt.innerHTML = `Watching. Last check: <b>${escapeHtml(stats.lastStatus)}</b>.`;
  } else {
    txt.innerHTML = 'Watching for the limit banner on this tab.';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function pingActiveTab(cb) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !/^https:\/\/([a-z0-9-]+\.)?arena\.ai\//i.test(tab.url || '')) return cb(null);
      chrome.tabs.sendMessage(tab.id, { type: 'baton-status' }, (res) => {
        if (chrome.runtime.lastError || !res) return cb(null);
        cb(res);
      });
    });
  } catch (_) {
    cb(null);
  }
}

load((settings) => {
  fillForm(settings);
  pingActiveTab((res) => renderStatus(settings, res));

  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    const evt = el.type === 'checkbox' ? 'change' : 'change';
    el.addEventListener(evt, () => {
      const next = readForm();
      save(next);
      pingActiveTab((res) => renderStatus(next, res));
    });
  }

  $('reset').addEventListener('click', () => {
    const next = readForm();
    next.enabled = true;
    save(next);
    fillForm(next);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) return;
      chrome.tabs.sendMessage(tab.id, { type: 'baton-status' }, () => {});
    });
    pingActiveTab((res) => renderStatus(next, res));
  });

  $('defaults').addEventListener('click', () => {
    save({ ...DEFAULTS });
    fillForm({ ...DEFAULTS });
    renderStatus({ ...DEFAULTS }, null);
  });
});
