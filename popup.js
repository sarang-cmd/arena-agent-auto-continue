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
  override: null,
  showIndicator: true
};

const FIELDS = ['enabled', 'onlyVisibleTab', 'useKeepWorking', 'skipIfDraft', 'requireFreshNotice', 'showIndicator', 'message', 'delayMs', 'maxConsecutive'];
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

/* ------------------------------------------------------------- target UI */

const MANIFEST_VERSION = chrome.runtime.getManifest().version;
const REPO = 'sarang-cmd/baton';
const RELEASES = `https://github.com/${REPO}/releases`;

function describeTarget(override) {
  if (!override) return 'Using the built-in selector.';
  const bits = [];
  if (override.selector) bits.push('selector <b>' + escapeHtml(override.selector) + '</b>');
  if (override.x != null && override.y != null) {
    bits.push('position <b>' + Math.round(override.x * 100) + '%, ' + Math.round(override.y * 100) + '%</b>');
  }
  if (override.text) bits.push('“' + escapeHtml(override.text.slice(0, 40)) + '”');
  return bits.length ? 'Custom target: ' + bits.join(' · ') : 'Using the built-in selector.';
}

function renderTarget(settings) {
  const box = $('targetCurrent');
  if (!box) return;
  const override = settings && settings.override;
  box.innerHTML = describeTarget(override);
  const sel = $('overrideSelector');
  const x = $('overrideX');
  const y = $('overrideY');
  if (sel) sel.value = (override && override.selector) || '';
  if (x) x.value = override && override.x != null ? Math.round(override.x * 100) : '';
  if (y) y.value = override && override.y != null ? Math.round(override.y * 100) : '';
}

function activeTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => cb(tabs && tabs[0]));
}

function sendToTab(type, cb) {
  activeTab((tab) => {
    if (!tab || !/^https:\/\/([a-z0-9-]+\.)?arena\.ai\//i.test(tab.url || '')) return cb && cb(null);
    chrome.tabs.sendMessage(tab.id, { type }, (res) => cb && cb(chrome.runtime.lastError ? null : res));
  });
}

function setOverride(override, done) {
  load((settings) => {
    const next = { ...settings, override };
    chrome.storage.local.set({ settings: next }, () => {
      renderTarget(next);
      if (done) done();
    });
  });
}

/* --------------------------------------------------------- update checker */

function versionParts(v) {
  return String(v || '0').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewer(remote, local) {
  const a = versionParts(remote);
  const b = versionParts(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

function showUpdate(info) {
  if (!info) return;
  const box = $('update');
  const title = $('updateTitle');
  const body = $('updateBody');
  const dl = $('updateDownload');
  const notes = $('updateNotes');
  if (!box) return;
  title.textContent = `Version ${info.version} is available`;
  body.textContent = `You are running ${MANIFEST_VERSION}. Download the new zip, then load it unpacked over the old folder.`;
  const asset = (info.assets || []).find((a) => /\.zip$/i.test(a.name || ''));
  dl.href = asset ? asset.browser_download_url : (info.html_url || RELEASES);
  notes.href = info.html_url || RELEASES;
  box.classList.add('show');
}

function checkForUpdate() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  chrome.storage.local.get(['updateCheck'], (res) => {
    const cached = (res && res.updateCheck) || null;
    if (cached && Date.now() - cached.at < SIX_HOURS) {
      if (cached.latest && isNewer(cached.latest.version, MANIFEST_VERSION)) showUpdate(cached.latest);
      return;
    }
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((release) => {
        if (!release || !release.tag_name) return;
        const latest = {
          version: release.tag_name.replace(/^v/, ''),
          html_url: release.html_url,
          assets: (release.assets || []).map((a) => ({ name: a.name, browser_download_url: a.browser_download_url }))
        };
        chrome.storage.local.set({ updateCheck: { at: Date.now(), latest } });
        if (isNewer(latest.version, MANIFEST_VERSION)) showUpdate(latest);
      })
      .catch(() => { /* offline is fine, the banner just stays hidden */ });
  });
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

  renderTarget(settings);
  checkForUpdate();

  const pick = $('pickTarget');
  if (pick) {
    pick.addEventListener('click', () => {
      sendToTab('baton-pick', (res) => {
        if (!res || !res.ok) {
          pick.textContent = 'Open arena.ai first';
          setTimeout(() => { pick.textContent = 'Pick on page'; }, 1800);
          return;
        }
        pick.textContent = 'Click the button on the page…';
        setTimeout(() => { pick.textContent = 'Pick on page'; }, 4000);
        window.close();
      });
    });
  }

  const clear = $('clearTarget');
  if (clear) clear.addEventListener('click', () => setOverride(null));

  const apply = $('applyTarget');
  if (apply) {
    apply.addEventListener('click', () => {
      const selector = ($('overrideSelector').value || '').trim();
      const xRaw = parseFloat($('overrideX').value);
      const yRaw = parseFloat($('overrideY').value);
      const hasPoint = Number.isFinite(xRaw) && Number.isFinite(yRaw);
      if (!selector && !hasPoint) {
        const box = $('targetCurrent');
        box.innerHTML = 'Enter a selector or a position, or use Pick on page.';
        return;
      }
      setOverride({
        selector: selector || '',
        x: hasPoint ? Math.min(1, Math.max(0, xRaw / 100)) : null,
        y: hasPoint ? Math.min(1, Math.max(0, yRaw / 100)) : null,
        pickedAt: Date.now()
      });
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
