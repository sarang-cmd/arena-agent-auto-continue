/**
 * The background worker, loaded the way Chrome loads it.
 *
 * This exists because of a real bug: notifications/worker.js read
 * `window.BatonEvents` at its top level. A service worker has no `window`, so
 * importScripts threw, background.js died before it registered
 * chrome.action.onClicked, and the toolbar button did nothing when clicked.
 * Nothing in the page tests could see that, because they all run inside jsdom
 * where `window` exists.
 *
 * So this file builds a context that looks like a service worker and nothing
 * like a page: `self` and `chrome`, no `window`, no `document`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

/** A service worker global: self, chrome, no window, no document. */
function workerContext() {
  const calls = { created: [], notificationCreated: [] };
  const listeners = { clicked: [], message: [], webRequest: [], storageChanged: [] };

  const chrome = {
    action: { onClicked: { addListener: (fn) => listeners.clicked.push(fn) } },
    runtime: {
      getURL: (p) => 'chrome-extension://baton/' + p,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      lastError: null
    },
    tabs: {
      create: (opts) => calls.created.push(opts),
      query: (_q, cb) => cb([]),
      update: (_id, _o, cb) => cb && cb(),
      sendMessage: (_id, _m, cb) => cb && cb()
    },
    windows: { update: (_id, _o, cb) => cb && cb() },
    storage: {
      local: { get: (_k, cb) => cb({ settings: {} }), set: (_o, cb) => cb && cb() },
      session: {
        get: (_k, cb) => cb({}),
        set: (_o, cb) => cb && cb(),
        remove: (_k, cb) => cb && cb()
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) }
    },
    notifications: {
      create: (id, opts, cb) => {
        calls.notificationCreated.push({ id, opts });
        if (cb) cb();
        return 'n1';
      },
      clear: (_id, cb) => cb && cb(),
      onClicked: { addListener: () => {} }
    },
    webRequest: {
      onBeforeRequest: { addListener: (...args) => listeners.webRequest.push(args) }
    },
    permissions: { contains: (_q, cb) => cb(true) }
  };

  const sandbox = { chrome, console, setTimeout, clearTimeout, URL, Map, Set, Promise };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  // importScripts loads into the same global, as it does in a worker
  sandbox.importScripts = (...files) => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(root, f), 'utf8');
      vm.runInContext(code, context, { filename: f });
    }
  };
  return { context, calls, listeners, sandbox };
}

test('background.js loads in a service worker, with no window in scope', () => {
  const { context, sandbox } = workerContext();
  const code = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.doesNotThrow(() => vm.runInContext(code, context, { filename: 'background.js' }));
  assert.equal(typeof sandbox.BatonWorker, 'object', 'the worker did not register itself');
  assert.ok(sandbox.BatonWorker && typeof sandbox.BatonWorker.intake === 'function');
  assert.ok(sandbox.BatonWorker && typeof sandbox.BatonWorker.installWebRequest === 'function');
});

test('clicking the toolbar button opens the settings page', () => {
  const { context, calls, listeners } = workerContext();
  const code = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'background.js' });

  assert.equal(listeners.clicked.length, 1, 'chrome.action.onClicked was never registered');
  listeners.clicked[0]();
  assert.deepEqual(calls.created, [{ url: 'chrome-extension://baton/settings.html' }]);
});

test('the event layer hands its exports across the worker boundary', () => {
  const { context, sandbox } = workerContext();
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context,
    { filename: 'background.js' });
  // the four modules have to find each other without a window object
  assert.ok(sandbox.BatonEvents, 'events did not export');
  assert.ok(sandbox.BatonDedupe, 'dedupe did not export');
  assert.ok(sandbox.BatonNotifier, 'notifier did not export');
  assert.equal(typeof sandbox.BatonEvents.fromChatState, 'function');
  assert.ok(sandbox.BatonWorker.targets, 'the worker never reached the evaluation intake');
});

test('a broken notification module cannot take the toolbar button down with it', () => {
  const { context, calls, listeners } = workerContext();
  // simulate a module that throws while loading, the way worker.js did
  context.__bad = true;
  const original = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const poisoned = original.replace(
    "importScripts(\n  'notifications/events.js',",
    "importScripts(\n  'notifications/missing-on-purpose.js',");
  vm.runInContext(poisoned, context, { filename: 'background.js' });
  assert.equal(listeners.clicked.length, 1, 'the click handler depends on the notification stack');
  listeners.clicked[0]();
  assert.equal(calls.created.length, 1);
});
