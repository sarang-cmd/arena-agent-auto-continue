/**
 * Baton background worker.
 *
 * Two jobs:
 *   - the toolbar button opens the full settings page in a tab, since the
 *     settings now live in the on-page panel rather than a popup
 *   - the settings UI runs in a shadow root inside the page, so its messages
 *     have to be relayed to the arena.ai tab
 */
const ARENA = /^https:\/\/([a-z0-9-]+\.)?arena\.ai\//i;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
});

function activeArenaTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    cb(tab && ARENA.test(tab.url || '') ? tab : null);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'baton-notify') {
    // the content script cannot raise notifications itself, and should not be
    // allowed to raise them without the user having switched this on
    chrome.storage.local.get(['settings'], (res) => {
      const on = !res || !res.settings || res.settings.notifyOnPause !== false;
      if (on) {
        chrome.notifications.create('', {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: String(msg.title || 'Baton'),
          message: String(msg.message || ''),
          priority: 1
        }, () => void chrome.runtime.lastError);
      }
      reply({ ok: on });
    });
    return true;
  }

  if (msg.type === 'baton-open-settings') {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'baton-pick') {
    activeArenaTab((tab) => {
      if (!tab) { reply({ ok: false, reason: 'no-arena-tab' }); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'baton-pick' }, (res) => {
        reply(res && res.ok ? { ok: true } : { ok: false, reason: 'no-content-script' });
      });
    });
    return true; // async reply
  }

  if (msg.type === 'baton-reset') {
    activeArenaTab((tab) => {
      if (!tab) { reply({ ok: false }); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'baton-reset' }, () => reply({ ok: true }));
    });
    return true;
  }
});
