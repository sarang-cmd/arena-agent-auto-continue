/**
 * Page observer
 * ------------------------------------------------------------------
 * The only place that talks to Arena. It polls the same state endpoint the page
 * itself polls, and hands raw snapshots to the pure event layer. It never reads
 * the answer stream, so it cannot see or log answer text.
 *
 * Runs in the content script. Everything it learns goes to the background worker
 * as one message, which is where dedupe and notifications live.
 *
 * It also reports a structural summary of what it saw, and what it decided, to
 * the worker, which the settings page shows. That report carries key names, part
 * types and states, and lengths. Never text, never a title, never an id beyond a
 * short prefix, so a wrong assumption can be found without reading anyone's
 * conversation.
 */
(() => {
  const root = typeof self !== 'undefined' ? self : globalThis;
  const Events = root.BatonEvents;
  const POLL_MS = 2500;
  const POLL_BUSY_MS = 1000;   // a run is in flight: watch it closely
  const POLL_HIDDEN_MS = 15000;
  // an unmarked shape has to look the same for this long before it counts as
  // finished, so a slow token does not notify mid-answer
  const SETTLE_MS = 6000;
  const DIAG_MIN_MS = 2000;

  let timer = null;
  let previous = null;
  let chatId = null;
  let mode = null;
  let inFlight = false;
  let stoppedIds = new Set();
  let lastEventDebug = [];

  // settling: same fingerprint for SETTLE_MS means nothing is happening
  let fingerprint = null;
  let unchangedSince = 0;

  // diagnostics
  let diag = null;
  let lastDiagSent = 0;
  const HISTORY = 12;
  let history = [];
  let lastBusy = false;

  const MODE_BY_SEGMENT = { agent: 'agent', code: 'coding', c: 'agent', chat: 'agent' };
  const UUID = /^[0-9a-f]{8,}(-[0-9a-f]{4,})*$/i;

  /**
   * The chat id for the current page.
   *
   * The route is tried first, because it is instant and needs no traffic. Arena
   * has used several shapes over time, so any single path segment that looks
   * like an id is accepted, and the segment before it names the mode when it is
   * one we know. When the path carries nothing, the id is read back out of the
   * requests the page itself has already made, which covers routes that do not
   * put the id in the address bar.
   */
  function readRoute() {
    const segments = location.pathname.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.length >= 8 && UUID.test(seg)) {
        const before = i > 0 ? segments[i - 1].toLowerCase() : '';
        return { chatId: seg, mode: MODE_BY_SEGMENT[before] || 'agent', from: 'path' };
      }
    }
    const id = idFromTraffic();
    if (id) return { chatId: id, mode: 'agent', from: 'traffic' };
    return { chatId: null, mode: null, from: null };
  }

  /** The most recent chat id the page asked Arena about. */
  function idFromTraffic() {
    try {
      const entries = typeof performance !== 'undefined' && performance.getEntriesByType
        ? performance.getEntriesByType('resource')
        : [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const m = /\/api\/chat\/([0-9a-f-]{8,})(?:[/?]|$)/i.exec(entries[i].name || '');
        if (m) return m[1];
      }
    } catch (_) {}
    return null;
  }

  /**
   * Is the page visibly busy? Two structural checks, no prose: a control whose
   * accessible name is Stop, and any element marked as streaming. Reported in
   * the diagnostics only, never used to decide an event, so a wrong guess here
   * cannot raise a notification.
   */
  function domActivity() {
    try {
      const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
      const stop = controls.filter((el) => {
        const name = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim();
        return name.length <= 24 && /^stop\b/i.test(name);
      }).length;
      const streaming = document.querySelectorAll(
        '[data-streaming="true"], [aria-busy="true"], [data-state="streaming"]').length;
      return { stopControls: stop, streamingMarks: streaming };
    } catch (_) {
      return { stopControls: 0, streamingMarks: 0 };
    }
  }

  function debug(entry) {
    // event types and decisions only: no text, no ids beyond a short prefix
    lastEventDebug.push(entry);
    if (lastEventDebug.length > 20) lastEventDebug.shift();
  }

  function emit(events) {
    const kept = (events || []).filter((e) => e && e.type && e.type !== 'suppressed');
    if (!kept.length) return;
    for (const event of kept) {
      debug({ at: Date.now(), type: event.type, mode: event.mode, turn: String(event.turnId).slice(0, 8) });
    }
    try {
      chrome.runtime.sendMessage({ type: 'baton-event', events: kept, context: { threadTitle: threadTitle() } },
        () => void (chrome.runtime && chrome.runtime.lastError));
    } catch (_) {}
    if (diag) diag.events = kept.map((e) => ({ type: e.type, at: Date.now(), signal: e.signal || null }));
    reportDiag(true);
  }

  /** The tab title without the Arena suffix, used as a thread name. */
  function threadTitle() {
    const t = (document.title || '').replace(/\s*[|\u2013\u2014-]\s*(Arena|arena\.ai).*$/i, '').trim();
    return t ? t.slice(0, 120) : null;
  }

  /** A structural fingerprint: ids, roles, part types and states, text lengths. */
  function fingerprintOf(state) {
    const messages = (state && state.messages) || [];
    return messages.map((m) => {
      const meta = m && m.metadata ? m.metadata : {};
      const parts = (m && m.parts) || [];
      return [
        m && m.id ? m.id : '',
        m && m.role ? m.role : '',
        meta.pending === true ? 1 : 0,
        parts.map((p) => [p.type || '', p.state || '',
          typeof p.text === 'string' ? p.text.length : 0].join(':')).join(',')
      ].join('|');
    }).join(';');
  }

  async function fetchState(id) {
    const attempts = [
      '/api/chat/' + encodeURIComponent(id) + '?includeStreamToken=false&recoverRun=false',
      '/api/chat/' + encodeURIComponent(id)
    ];
    for (const url of attempts) {
      const shown = url.split('?')[0];
      try {
        const res = await fetch(url, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' }
        });
        if (res.ok) {
          const body = await res.json();
          if (diag) diag.poll = { endpoint: shown, status: res.status, ok: true };
          return body;
        }
        if (diag) diag.poll = { endpoint: shown, status: res.status, ok: false };
        // 401 or 403 will not improve by trying the other spelling
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          if (res.status === 401 || res.status === 403) return null;
        }
      } catch (err) {
        if (diag) {
          diag.poll = {
            endpoint: shown, status: 0, ok: false,
            error: String((err && err.message) || err).slice(0, 80)
          };
        }
        return null; // offline: the next tick will try again
      }
    }
    return null;
  }

  async function pollOnce() {
    if (inFlight) return;
    const route = readRoute();

    if (!route.chatId) {
      chatId = null;
      previous = null;
      history = [];
      diag = {
        at: Date.now(), page: location.pathname.slice(0, 80), route: { chatId: null, mode: null, from: null },
        poll: null, decision: null, events: []
      };
      reportDiag(true);
      return;
    }

    // a new thread in the same tab starts a fresh baseline
    if (route.chatId !== chatId) {
      chatId = route.chatId;
      mode = route.mode;
      previous = null;
      stoppedIds = new Set();
      fingerprint = null;
      unchangedSince = 0;
      diag = null;
    }

    diag = diag || { at: Date.now(), events: [] };
    diag.at = Date.now();
    diag.page = location.pathname.slice(0, 80);
    diag.route = { chatId: chatId.slice(0, 8), mode, from: route.from };

    if (!Events) {
      diag.decision = { error: 'event layer did not load' };
      reportDiag(true);
      return;
    }
    if (!Events.isSupported(mode)) {
      diag.decision = { error: 'mode not supported: ' + String(mode) };
      reportDiag(true);
      return;
    }

    inFlight = true;
    try {
      const state = await fetchState(chatId);
      if (!state) {
        diag.decision = { error: 'no chat state', poll: diag.poll };
        reportDiag(true);
        return;
      }

      const fp = fingerprintOf(state);
      const now = Date.now();
      if (fp !== fingerprint) {
        fingerprint = fp;
        unchangedSince = now;
      }
      const settled = unchangedSince > 0 && now - unchangedSince >= SETTLE_MS;

      const events = Events.fromChatState(previous, state, { mode, stoppedIds, settled });
      const doneEvent = events.find((e) => e.type === 'response_done');
      diag.messages = ((state && state.messages) || []).length;
      diag.shape = Events.shapeOf(state);
      diag.dom = domActivity();
      diag.decision = {
        settled,
        unchangedMs: unchangedSince ? now - unchangedSince : 0,
        baseline: previous === null,
        finished: !!doneEvent,
        signal: doneEvent ? doneEvent.signal : null
      };
      if (!diag.events || !diag.events.length) diag.events = [];

      // one line per poll, so a single paste shows the whole trajectory:
      // does an assistant message ever appear, and does pending ever flip?
      const last = ((state.messages || [])[((state.messages || []).length - 1)]) || null;
      const assistants = (state.messages || []).filter((m) => m && m.role === 'assistant');
      const tail = assistants.length ? assistants[assistants.length - 1] : null;
      const tailMeta = (tail && tail.metadata) || {};
      const busy = !!(tail && tailMeta.pending === true) || events.some((e) => e.type === 'question_asked');
      lastBusy = busy;
      history.push({
        t: new Date(now).toLocaleTimeString(),
        n: (state.messages || []).length,
        lastRole: last ? last.role : null,
        assistant: tail ? 1 : 0,
        pending: tail ? (tailMeta.pending === undefined ? 'absent' : !!tailMeta.pending) : null,
        parts: tail ? (tail.parts || []).length : 0,
        settled,
        out: events.map((e) => e.type)
      });
      if (history.length > HISTORY) history.shift();
      diag.history = history.slice();

      previous = state;
      emit(events);
      reportDiag(false);
    } catch (err) {
      diag.decision = { error: String((err && err.message) || err).slice(0, 120) };
      reportDiag(true);
    } finally {
      inFlight = false;
    }
  }

  /** Send the report at most every DIAG_MIN_MS, or immediately when it matters. */
  function reportDiag(force) {
    if (!diag) return;
    const now = Date.now();
    if (!force && now - lastDiagSent < DIAG_MIN_MS) return;
    lastDiagSent = now;
    try {
      chrome.runtime.sendMessage({ type: 'baton-diag', diag }, () => void (chrome.runtime && chrome.runtime.lastError));
    } catch (_) {}
  }

  /**
   * The last chat-state snapshot, for the content script to turn into a limit
   * event. Kept here so there is one fetch, not two: the banner detector and the
   * poller read the same snapshot.
   */
  function snapshot() {
    return { state: previous, mode };
  }

  /** The background worker tells us which message ids the user stopped. */
  function noteStopped(ids) {
    for (const id of ids || []) stoppedIds.add(id);
    if (stoppedIds.size > 50) stoppedIds = new Set([...stoppedIds].slice(-50));
  }

  function start() {
    if (timer) return;
    const tick = () => {
      pollOnce();
      const wait = document.visibilityState === 'hidden'
        ? POLL_HIDDEN_MS
        : (lastBusy ? POLL_BUSY_MS : POLL_MS);
      timer = setTimeout(tick, wait);
    };
    tick();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    previous = null;
  }

  /** The turn the limit banner belongs to, as far as the last poll knows. */
  function currentTurn() {
    if (!Events || !previous) return null;
    const events = Events.fromLimit(previous, { mode });
    return events.length ? events[0].turnId : null;
  }

  root.BatonObserve = {
    start, stop, snapshot, noteStopped, pollOnce, currentTurn, readRoute,
    debug: () => lastEventDebug.slice(),
    diag: () => diag
  };
})();
