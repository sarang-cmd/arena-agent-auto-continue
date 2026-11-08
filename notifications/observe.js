/**
 * Page observer
 * ------------------------------------------------------------------
 * The only place that talks to Arena. It polls the same state endpoint the page
 * itself polls, and hands raw snapshots to the pure event layer. It never reads
 * the answer stream, so it cannot see or log answer text.
 *
 * Runs in the content script. Everything it learns goes to the background worker
 * as one message, which is where dedupe and notifications live.
 */
(() => {
  const Events = window.BatonEvents;
  const POLL_MS = 2500;
  const POLL_HIDDEN_MS = 15000;

  let timer = null;
  let previous = null;
  let chatId = null;
  let mode = null;
  let inFlight = false;
  let stoppedIds = new Set();
  let lastEventDebug = [];

  /** The chat id in the address bar, for the routes that carry one. */
  function readRoute() {
    const path = location.pathname;
    const agent = path.match(/^\/agent\/([0-9a-f-]{8,})/i);
    const code = path.match(/^\/code\/([0-9a-f-]{8,})/i);
    if (agent) return { chatId: agent[1], mode: 'agent' };
    if (code) return { chatId: code[1], mode: 'coding' };
    return { chatId: null, mode: null };
  }

  function debug(entry) {
    // event types and decisions only: no text, no ids beyond a short prefix
    lastEventDebug.push(entry);
    if (lastEventDebug.length > 20) lastEventDebug.shift();
  }

  function emit(events) {
    if (!events || !events.length) return;
    for (const event of events) {
      debug({ at: Date.now(), type: event.type, mode: event.mode, turn: String(event.turnId).slice(0, 8) });
    }
    try {
      chrome.runtime.sendMessage({ type: 'baton-event', events }, () => {
        void (chrome.runtime && chrome.runtime.lastError);
      });
    } catch (_) {}
  }

  async function fetchState(id) {
    const url = '/api/chat/' + encodeURIComponent(id) +
      '?includeStreamToken=false&recoverRun=false';
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return res.json();
  }

  async function pollOnce() {
    if (inFlight) return;
    const route = readRoute();
    if (!route.chatId) { chatId = null; previous = null; return; }

    // a new thread in the same tab starts a fresh baseline
    if (route.chatId !== chatId) {
      chatId = route.chatId;
      mode = route.mode;
      previous = null;
      stoppedIds = new Set();
    }
    if (!Events || !Events.isSupported(mode)) return;

    inFlight = true;
    try {
      const state = await fetchState(chatId);
      if (!state) return;
      const events = Events.fromChatState(previous, state, { mode, stoppedIds });
      previous = state;
      emit(events.filter((e) => e.type !== 'suppressed'));
    } catch (_) {
      /* offline or signed out: try again on the next tick */
    } finally {
      inFlight = false;
    }
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
      const wait = document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : POLL_MS;
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

  window.BatonObserve = { start, stop, snapshot, noteStopped, pollOnce, currentTurn,
    debug: () => lastEventDebug.slice(), readRoute };
})();
