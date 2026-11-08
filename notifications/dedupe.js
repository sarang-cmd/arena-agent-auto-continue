/**
 * Dedupe store
 * ------------------------------------------------------------------
 * Every notification is keyed by thread + turn + event type (+ model), and the
 * key is written to chrome.storage.session so a service-worker restart, a page
 * reload or an SPA route change cannot produce the same event twice.
 *
 * The list is capped and pruned oldest first. Session storage is deliberately
 * chosen over local: it is cleared when the browser closes, which matches "once
 * per turn" rather than "once ever".
 */
(() => {
  // The same four files are loaded twice: into a page as content scripts, and
  // into the service worker through importScripts. A service worker has no
  // `window`, so the shared global is resolved rather than assumed. Without
  // this, importScripts threw and the toolbar button was dead.
  const root = typeof self !== 'undefined' ? self : globalThis;

  const KEY = 'notifiedKeys';
  const CAP = 400;

  function read(cb) {
    try {
      chrome.storage.session.get([KEY], (res) => {
        cb((res && res[KEY]) || {});
      });
    } catch (_) {
      cb({});
    }
  }

  function write(map, cb) {
    try {
      chrome.storage.session.set({ [KEY]: map }, () => {
        void (chrome.runtime && chrome.runtime.lastError);
        if (cb) cb();
      });
    } catch (_) {
      if (cb) cb();
    }
  }

  /**
   * Take a key. Calls back with true when this is the first time it has been
   * seen, in which case the caller may notify.
   */
  function claim(key, cb) {
    read((map) => {
      if (map[key]) {
        cb(false);
        return;
      }
      map[key] = Date.now();
      const keys = Object.keys(map);
      if (keys.length > CAP) {
        keys.sort((a, b) => map[a] - map[b]);
        for (const stale of keys.slice(0, keys.length - CAP)) delete map[stale];
      }
      write(map, () => cb(true));
    });
  }

  /** Forget everything, so the manual test matrix can be re-run from the top. */
  function reset(cb) {
    write({}, cb);
  }

  function size(cb) {
    read((map) => cb(Object.keys(map).length));
  }

  const api = { claim, reset, size, KEY, CAP };
  root.BatonDedupe = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
