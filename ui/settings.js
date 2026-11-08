/**
 * Settings store
 * ------------------------------------------------------------------
 * One owner of the stored settings object, shared by every surface:
 * the pill on the page, the settings page, and the content script's view.
 *
 * The reason it exists: two settings surfaces used to read the object on mount
 * and write it back wholesale. A write from one would silently undo a change
 * made in the other a moment earlier. Here the last known value lives in
 * memory, is refreshed by storage events, and a write only ever sends the keys
 * that actually changed.
 *
 * No chrome.* here beyond storage, so it runs under jsdom in the tests.
 */
(() => {
  const KEY = 'settings';

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
    notifyOnPause: true,
    override: null
  };

  let cache = { ...DEFAULTS };
  let loaded = false;
  const waiting = [];
  const listeners = [];

  function normalise(raw) {
    return { ...DEFAULTS, ...(raw || {}) };
  }

  function announce() {
    while (waiting.length) waiting.shift()(cache);
    listeners.slice().forEach((fn) => {
      try { fn(cache); } catch (_) {}
    });
  }

  function read() {
    try {
      chrome.storage.local.get([KEY], (res) => {
        cache = normalise(res && res[KEY]);
        loaded = true;
        announce();
      });
    } catch (_) {
      loaded = true;
      announce();
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      cache = normalise(changes[KEY].newValue);
      loaded = true;
      announce();
    });
  } catch (_) {}

  read();

  const BatonSettings = {
    DEFAULTS,

    /** Last known values. Before the first read resolves this is the defaults. */
    get() {
      return { ...cache };
    },

    get loaded() {
      return loaded;
    },

    /** Resolves once the first read has come back. */
    ready() {
      return loaded ? Promise.resolve({ ...cache }) : new Promise((r) => waiting.push(r));
    },

    /** Call fn(settings) whenever anything changes, from any surface. */
    subscribe(fn) {
      listeners.push(fn);
      if (loaded) fn({ ...cache });
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    /**
     * Write only the keys that changed. Returns the merged result so callers can
     * re-render from the same value instead of re-reading storage.
     */
    save(patch) {
      const next = { ...cache, ...patch };
      const diff = {};
      for (const k of Object.keys(patch)) {
        if (JSON.stringify(patch[k]) !== JSON.stringify(cache[k])) diff[k] = patch[k];
      }
      cache = next;
      if (!Object.keys(diff).length) return Promise.resolve({ ...next });
      announce();
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set({ [KEY]: next }, () => {
            void (chrome.runtime && chrome.runtime.lastError);
            resolve({ ...next });
          });
        } catch (_) {
          resolve({ ...next });
        }
      });
    },

    reset() {
      return BatonSettings.save({ ...DEFAULTS });
    }
  };

  window.BatonSettings = BatonSettings;
  if (typeof module !== 'undefined' && module.exports) module.exports = BatonSettings;
})();
