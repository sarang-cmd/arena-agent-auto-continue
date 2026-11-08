/**
 * Notification worker
 * ------------------------------------------------------------------
 * Loaded by background.js. Owns three things the page cannot:
 *
 *   1. intake   every event, from any tab, funnelled through one dedupe
 *   2. the evaluation family (Direct, Battle, Side by side), whose message ids
 *      are only visible in the create-evaluation request, so they are learned
 *      with chrome.webRequest and then polled for their status
 *   3. manual stops, which only exist as a request to /nextjs-api/stream/stop
 *
 * No new network destination: the polls are same-origin Arena endpoints, and
 * nothing is sent anywhere else.
 */
(() => {
  // The same four files are loaded twice: into a page as content scripts, and
  // into the service worker through importScripts. A service worker has no
  // `window`, so the shared global is resolved rather than assumed. Without
  // this, importScripts threw and the toolbar button was dead.
  const root = typeof self !== 'undefined' ? self : globalThis;

  const Events = root.BatonEvents;
  const Dedupe = root.BatonDedupe;
  const Notifier = root.BatonNotifier;

  const EVAL_PREFIX = '/nextjs-api/stream/create-evaluation';
  const STOP_PREFIX = '/nextjs-api/stream/stop/';
  const ARENA_HOST = /^https:\/\/([a-z0-9-]+\.)?arena\.ai\//i;

  // evaluation turns we are watching: turnId -> { request, statuses, tabId, seen }
  const watching = new Map();
  const stoppedByChat = new Map();

  /* ------------------------------------------------------------- settings */

  let settings = null;
  function currentSettings(cb) {
    if (settings) { cb(settings); return; }
    try {
      chrome.storage.local.get(['settings'], (res) => {
        settings = (res && res.settings) || {};
        cb(settings);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) settings = changes.settings.newValue || {};
      });
    } catch (_) {
      cb({});
    }
  }

  const eventEnabled = (s, type) => {
    if (type === Events.EVENTS.RESPONSE_DONE) return s.notifyResponseDone !== false;
    if (type === Events.EVENTS.QUESTION_ASKED) return s.notifyQuestionAsked !== false;
    if (type === Events.EVENTS.TOOL_LIMIT) return s.notifyToolLimit !== false;
    return false;
  };

  /* ---------------------------------------------------------------- intake */

  /**
   * One event in, at most one notification out.
   * `context` carries what the notification needs but the event should not:
   * the thread title, whether auto-continue answered, the text (only when the
   * user opted in).
   */
  function intake(event, context, cb) {
    if (!event || !Dedupe || !Notifier) {
      lastIntake = { at: Date.now(), type: event && event.type, stage: 'modules-missing' };
      if (cb) cb(false); return;
    }
    currentSettings((s) => {
      if (!eventEnabled(s, event.type)) {
        lastIntake = { at: Date.now(), type: event.type, stage: 'switched-off' };
        if (cb) cb(false); return;
      }
      Dedupe.claim(Events.keyFor(event), (first) => {
        if (!first) {
          lastIntake = { at: Date.now(), type: event.type, stage: 'already-notified' };
          if (cb) cb(false); return;
        }
        if (context.threadTitle) noteTitle(event.threadId, context.threadTitle);
        const continued = context.continued !== undefined
          ? context.continued
          : limitOutcome.get((event.threadId || '-') + '|' + (event.turnId || '-'));
        const includeText = s.includeNotificationText === true;
        const options = {
          title: context.threadTitle || threadTitles.get(event.threadId),
          continued,
          includeText,
          text: includeText ? context.text : null
        };
        const composed = Notifier.compose(event, options);
        const id = 'baton:' + Events.keyFor(event);
        Notifier.create(id, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: composed.title,
          message: composed.message,
          priority: event.type === Events.EVENTS.TOOL_LIMIT ? 2 : 1,
          isClickable: true
        }, () => {
          const err = chrome.runtime.lastError;
          lastIntake = {
            at: Date.now(), type: event.type, stage: err ? 'create-failed' : 'created',
            error: err ? String(err.message || err).slice(0, 120) : null,
            title: composed.title
          };
          noteTarget(id, context);
          if (err) { if (cb) cb(false); return; }
          if (cb) cb(true);
        });
      });
    });
  }

  /* ------------------------------------------------------ click to the thread */

  // notification id -> where a click should land
  const targets = new Map();
  function noteTarget(id, context) {
    if (!context || !context.url) return;
    targets.set(id, context.url);
    if (targets.size > 50) targets.delete(targets.keys().next().value);
  }

  function focusThread(url) {
    // prefer the tab already showing that thread, otherwise open one
    try {
      chrome.tabs.query({}, (tabs) => {
        const match = (tabs || []).find((t) => t.url && t.url.split('?')[0] === url.split('?')[0]);
        if (match) {
          chrome.tabs.update(match.id, { active: true }, () => {
            chrome.windows.update(match.windowId, { focused: true }, () => void chrome.runtime.lastError);
          });
        } else {
          chrome.tabs.create({ url });
        }
      });
    } catch (_) {}
  }

  if (chrome.notifications && chrome.notifications.onClicked) {
    chrome.notifications.onClicked.addListener((id) => {
      const url = targets.get(id);
      if (url) focusThread(url);
      try { chrome.notifications.clear(id); } catch (_) {}
    });
  }

  /* ----------------------------------------------------- webRequest intake */

  /**
   * Evaluation turns. The request body carries the message ids and the mode;
   * without it there is nothing to poll. This is the one permission the feature
   * needs beyond notifications, and it is documented in CHANGES.md.
   */
  function onEvaluationRequest(details, tabId) {
    let body = null;
    try {
      const raw = details.requestBody && details.requestBody.raw;
      if (raw && raw.length && raw[0].bytes) {
        body = JSON.parse(new TextDecoder().decode(raw[0].bytes));
      } else if (details.requestBody && details.requestBody.formData) {
        return; // not the shape Arena sends
      }
    } catch (_) {
      return;
    }
    if (!body || !body.id) return;
    const mode = String(body.mode || '').toLowerCase();
    if (!Events || !Events.isSupported(mode)) return;

    if (!watching.has(body.id)) {
      watching.set(body.id, {
        request: body,
        statuses: {},
        seen: {},
        tabId,
        title: null,
        createdAt: Date.now()
      });
      resolveTitle(body.id);
      pollEvaluation(body.id);
    }
  }

  /** The history endpoint is the only place a thread title appears. */
  function resolveTitle(turnId) {
    const entry = watching.get(turnId);
    if (!entry) return;
    fetch('/api/history/unified?limit=20&includeArchived=false', { credentials: 'same-origin' })
      .catch(() => null)
      .then((res) => (res && res.ok ? res.json() : null))
      .then((json) => {
        if (!json || !Array.isArray(json.entries)) return;
        const hit = json.entries.find((e) => e.id === turnId);
        if (hit && hit.title) entry.title = hit.title;
      })
      .catch(() => {});
  }

  function evaluationUrl(entry) {
    const modality = entry.request.modality || 'webdev';
    return modelKey => '/api/evaluation/' + encodeURIComponent(modality) + '/' +
      encodeURIComponent(modelIdOf(entry.request, modelKey));
  }

  const modelIdOf = (request, key) =>
    key === 'a' ? request.modelAMessageId : request.modelBMessageId;

  async function pollEvaluation(turnId) {
    const entry = watching.get(turnId);
    if (!entry) return;
    const models = ['a', 'b'].filter((k) => modelIdOf(entry.request, k));
    const deadline = Date.now() + 10 * 60 * 1000;

    const tick = async () => {
      const live = watching.get(turnId);
      if (!live) return;
      for (const key of models) {
        if (live.statuses[key] === 'ready') continue;
        try {
          const url = evaluationUrl(live)(key);
          const res = await fetch(url, { credentials: 'same-origin' });
          if (!res.ok) continue;
          const json = await res.json();
          if (json && json.status) live.statuses[key] = json.status;
        } catch (_) {}
      }
      const events = Events.fromEvaluation(live.request, live.statuses, live.seen, {});
      for (const event of events) live.seen[event.model] = 'ready';
      if (events.length) {
        for (const event of events) {
          intake(event, { threadTitle: live.title, url: threadUrlFor(live.request) });
        }
      }
      const done = models.every((k) => live.statuses[k] === 'ready');
      if (done || Date.now() > deadline) {
        watching.delete(turnId);
        return;
      }
      setTimeout(tick, 2500);
    };
    tick();
  }

  function threadUrlFor(request) {
    // the evaluation turn lives under the mode's route
    const mode = String(request.mode || '').toLowerCase();
    if (mode === 'side-by-side') return 'https://arena.ai/code/direct';
    if (mode === 'direct-battle') return 'https://arena.ai/code/direct';
    return 'https://arena.ai/';
  }

  /** Manual stops: the only place the stopped message ids are visible. */
  function onStopRequest(details) {
    const match = details.url.match(/\/nextjs-api\/stream\/stop\/([0-9a-f-]{8,})\/messages\/([0-9a-f-]{8,})/i);
    if (!match) return;
    const [, chatId, messageId] = match;
    if (!stoppedByChat.has(chatId)) stoppedByChat.set(chatId, new Set());
    stoppedByChat.get(chatId).add(messageId);
    // tell the tab so its next chat-state diff does not call this a completion
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs || []) {
        if (!tab.url || !tab.url.includes(chatId)) continue;
        chrome.tabs.sendMessage(tab.id, { type: 'baton-stopped', chatId, ids: [...stoppedByChat.get(chatId)] },
          () => void chrome.runtime.lastError);
      }
    });
  }

  function installWebRequest() {
    if (!chrome.webRequest || !chrome.webRequest.onBeforeRequest) return;
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.method !== 'POST') return;
        if (details.url.includes(EVAL_PREFIX)) onEvaluationRequest(details, details.tabId);
        else if (details.url.includes(STOP_PREFIX)) onStopRequest(details);
      },
      { urls: ['https://arena.ai/*', 'https://*.arena.ai/*'] },
      ['requestBody']
    );
  }

  /* ------------------------------------------------- limit outcome + context */

  /**
   * The page sends the events and, separately, whether auto-continue answered.
   * Arriving in either order is fine: the notification is composed from whatever
   * is known when it is claimed, and the "waiting for you" wording is the honest
   * default rather than a guess.
   */
  const limitOutcome = new Map();   // threadId|turnId -> boolean
  const threadTitles = new Map();   // threadId -> title

  function noteLimitOutcome(threadId, turnId, continued) {
    limitOutcome.set(threadId + '|' + turnId, !!continued);
    if (limitOutcome.size > 100) limitOutcome.delete(limitOutcome.keys().next().value);
  }

  function noteTitle(threadId, title) {
    if (!threadId || !title) return;
    threadTitles.set(threadId, title);
    if (threadTitles.size > 100) threadTitles.delete(threadTitles.keys().next().value);
  }

  /* ------------------------------------------------------------ diagnostics */

  /**
   * The latest structural report from a page, kept where the settings page can
   * read it. Storage, not a variable: the worker is torn down between events,
   * and the report has to survive long enough to be looked at.
   */
  // what happened to the most recent event, kept alongside the page report so
  // one paste shows both halves: what was seen, and what was delivered
  let lastIntake = null;

  function noteDiag(report) {
    if (!report) return;
    try {
      chrome.storage.session.set({
        batonDiag: lastIntake ? { ...report, intake: lastIntake } : report
      });
    } catch (_) {}
  }

  /**
   * A synthetic completion, pushed through the same intake as a real one. It is
   * how a user can tell "the notification path is broken" apart from "Arena's
   * shape is not what Baton expects", which are very different problems.
   */
  function testEvent(cb) {
    const event = {
      type: Events.EVENTS.RESPONSE_DONE,
      threadId: 'test',
      turnId: 'test-' + Date.now(),
      mode: 'agent',
      timestamp: Date.now(),
      signal: 'test'
    };
    intake(event, { threadTitle: 'Test notification' }, (ok) => { if (cb) cb(ok); });
  }

  const api = { intake, installWebRequest, focusThread, targets, watching, stoppedByChat,
                noteLimitOutcome, noteTitle, limitOutcome, threadTitles, noteDiag, testEvent };
  root.BatonWorker = api;

  // the evaluation intake is an extra: if Chrome refuses the webRequest
  // listener, notifications for chat turns must still work
  try {
    installWebRequest();
  } catch (_) {}
})();
