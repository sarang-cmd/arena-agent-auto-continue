/**
 * Notification event layer
 * ------------------------------------------------------------------
 * Turns raw observations into events. Pure: no chrome APIs, no DOM, no fetch,
 * so the whole decision table can be driven from fixtures in node --test.
 *
 * Two observation shapes exist because Arena has two protocols:
 *
 *   chatState  the reply from GET /api/chat/<chatId>, which is what the page
 *              itself polls. Carries messages with metadata.pending, metadata
 *              .timing and parts of type tool-ask_user.
 *   evaluation the request body and the later status reply for
 *              POST /nextjs-api/stream/create-evaluation, one per model.
 *
 * The tool-call limit is neither: it is a DOM banner, which has no id. Its turn
 * is identified by the chat state at the moment the banner is seen, so the
 * event still dedupes across reloads.
 */
(() => {
  // The same four files are loaded twice: into a page as content scripts, and
  // into the service worker through importScripts. A service worker has no
  // `window`, so the shared global is resolved rather than assumed. Without
  // this, importScripts threw and the toolbar button was dead.
  const root = typeof self !== 'undefined' ? self : globalThis;

  const EVENTS = {
    RESPONSE_DONE: 'response_done',
    QUESTION_ASKED: 'question_asked',
    TOOL_LIMIT: 'tool_limit_reached'
  };

  /** Modes with a verified signal in the captures. Anything else stays silent. */
  const SUPPORTED = {
    agent: { source: 'chatState', reason: 'agent-runner transport, /api/chat' },
    coding: { source: 'chatState', reason: 'same agent-runner transport' },
    'direct-battle': { source: 'evaluation', reason: 'create-evaluation' },
    'side-by-side': { source: 'evaluation', reason: 'create-evaluation, two models' }
  };

  const isSupported = (mode) => Object.prototype.hasOwnProperty.call(SUPPORTED, mode);

  /* --------------------------------------------------------------- helpers */

  const partTypes = (message) => (message && message.parts ? message.parts : []).map((p) => p.type);

  const lastAssistant = (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'assistant') return messages[i];
    }
    return null;
  };

  const lastUser = (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') return messages[i];
    }
    return null;
  };

  /**
   * A turn id that survives a reload: the id of the user message the turn is
   * answering. Falls back to the assistant id, then to the chat id.
   */
  function turnIdFor(chatState, messageIndex) {
    const messages = (chatState && chatState.messages) || [];
    const upto = messages.slice(0, messageIndex + 1);
    const user = lastUser(upto);
    if (user && user.id) return user.id;
    const assistant = messages[messageIndex];
    if (assistant && assistant.id) return assistant.id;
    return chatState && chatState.id ? chatState.id : null;
  }

  // States that mean a part, and so its message, is still moving. The names
  // come from the AI SDK part shapes Arena's bundle uses; anything else is
  // treated as unknown rather than guessed either way.
  const BUSY_STATES = new Set(['streaming', 'pending', 'input-streaming', 'running',
    'in-progress', 'started', 'queued']);
  const DONE_STATES = new Set(['done', 'complete', 'completed', 'finished', 'output-available']);
  const DONE_REASONS = new Set(['stop', 'end_turn', 'eos', 'max_tokens', 'stop_sequence']);

  /**
   * Is the page still working on this message? Three answers, not two:
   * true, false, and null for a shape we have not seen yet. Only null falls
   * through to the timing heuristic, so a shape we do recognise is never
   * overridden by a timer.
   */
  function busySignal(message) {
    if (!message || message.role !== 'assistant') return { busy: null, signal: 'not-assistant' };
    const meta = message.metadata || {};

    if (meta.pending === true) return { busy: true, signal: 'metadata.pending true' };
    if (meta.pending === false) return { busy: false, signal: 'metadata.pending false' };
    if (meta.stopped === true) return { busy: false, signal: 'metadata.stopped' };
    if (typeof meta.finishReason === 'string' && DONE_REASONS.has(meta.finishReason)) {
      return { busy: false, signal: 'metadata.finishReason ' + meta.finishReason };
    }
    if (typeof meta.status === 'string') {
      const s = meta.status.toLowerCase();
      if (DONE_STATES.has(s)) return { busy: false, signal: 'metadata.status ' + s };
      if (BUSY_STATES.has(s)) return { busy: true, signal: 'metadata.status ' + s };
    }

    let sawDone = false;
    for (const part of message.parts || []) {
      const state = typeof part.state === 'string' ? part.state.toLowerCase() : null;
      if (state && BUSY_STATES.has(state)) return { busy: true, signal: 'part.state ' + state };
      if (state && DONE_STATES.has(state)) sawDone = true;
    }
    if (sawDone) return { busy: false, signal: 'part.state done' };
    return { busy: null, signal: 'no busy or done marker' };
  }

  /** Does this message carry answer text, as opposed to only steps? */
  function hasAnswerText(message) {
    for (const part of (message && message.parts) || []) {
      if (part.type !== 'text') continue;
      if (typeof part.text === 'string' && part.text.trim().length > 0) return true;
    }
    if (typeof message.content === 'string' && message.content.trim().length > 0) return true;
    return false;
  }

  /**
   * Is this assistant message finished?
   *
   * `options.settled` is measured by the observer, not guessed here: it means
   * the structural fingerprint of the chat has not changed for several polls.
   * It is only consulted when the message carries no marker either way, which
   * is the case the captures never covered.
   */
  function isFinished(message, options = {}) {
    if (!message || message.role !== 'assistant') return false;
    const sig = busySignal(message);
    if (sig.busy === true) return false;
    if (pendingQuestion(message)) return false;
    // A message made only of reasoning and tool parts is a step on the way, not
    // a finished response. The captures show the agent producing several of
    // these per turn, so notifying on them would be a notification every few
    // seconds for one answer.
    if (!hasAnswerText(message)) return false;
    if (sig.busy === false) return true;
    return options.settled === true;
  }

  /**
   * A structural summary of a chat state: key names, part types and states,
   * plus lengths. No text, no ids, no titles. This is what the diagnostics
   * panel shows so a wrong assumption can be found from the user's own page
   * without anyone reading a conversation.
   */
  function shapeOf(state) {
    const messages = (state && state.messages) || [];
    const last = messages.length ? messages[messages.length - 1] : null;
    const assistant = lastAssistant(messages);
    const parts = (assistant && assistant.parts) || [];
    return {
      chatKeys: Object.keys(state || {}).sort().slice(0, 20),
      messages: messages.length,
      roles: messages.slice(-4).map((m) => m && m.role),
      assistant: assistant
        ? {
            metadataKeys: Object.keys(assistant.metadata || {}).sort().slice(0, 20),
            pending: assistant.metadata ? assistant.metadata.pending : undefined,
            finishReason: assistant.metadata ? assistant.metadata.finishReason : undefined,
            partTypes: parts.map((p) => p.type).slice(0, 12),
            partStates: parts.map((p) => p.state || null).slice(0, 12),
            textLengths: parts.filter((p) => p.type === 'text')
              .map((p) => (typeof p.text === 'string' ? p.text.length : null)).slice(0, 6)
          }
        : null,
      lastRole: last ? last.role : null
    };
  }

  /** A pending ask_user part: the agent is waiting on the user right now. */
  function pendingQuestion(message) {
    if (!message || message.role !== 'assistant') return null;
    for (const part of message.parts || []) {
      if (part.type === 'tool-ask_user' && part.state === 'input-available') return part;
    }
    return null;
  }

  /**
   * Did the user stop this turn?
   *
   * Unverified for agent mode: no capture contains both a stop request and the
   * chat state that follows it. These are the shapes a stop would plausibly
   * leave behind, checked so that E1 errs towards staying quiet. When none of
   * them match, E1 fires on completion as normal, which is the documented risk.
   */
  function looksStopped(message, stoppedIds) {
    if (!message) return false;
    if (stoppedIds && message.id && stoppedIds.has(message.id)) return true;
    const meta = message.metadata || {};
    if (meta.stopped === true || meta.finishReason === 'stopped') return true;
    for (const part of message.parts || []) {
      if (part.state === 'stopped' || part.finishReason === 'stopped') return true;
    }
    return false;
  }

  /* ------------------------------------------------------- chat state path */

  /**
   * Diff two chat-state snapshots and return the events that became true in the
   * newer one. `previous` may be null, which is the first poll after a load: the
   * existing history is then taken as the baseline and produces nothing, so a
   * reload does not replay old turns as new notifications.
   */
  function fromChatState(previous, next, options = {}) {
    const mode = (options.mode || 'agent').toLowerCase();
    if (!isSupported(mode) || !SUPPORTED[mode].source.includes('chatState')) return [];
    if (!next || !Array.isArray(next.messages)) return [];

    const stoppedIds = options.stoppedIds || null;
    const threadId = next.id || null;
    const events = [];
    const messages = next.messages;

    if (!previous || !Array.isArray(previous.messages)) {
      return [];
    }

    const before = new Map(previous.messages.map((m) => [m.id, m]));

    messages.forEach((message, index) => {
      const prior = before.get(message.id);

      // E2: a question that is waiting now and was not waiting before.
      const question = pendingQuestion(message);
      const askedBefore = prior ? !!pendingQuestion(prior) : false;
      if (question && !askedBefore) {
        events.push({
          type: EVENTS.QUESTION_ASKED,
          turnId: turnIdFor(next, index),
          threadId,
          mode,
          timestamp: Date.now(),
          // never the question text: only the count, which is not content
          questionCount: (question.input && question.input.questions || []).length
        });
      }

      // E1: finished on its own, and not finished before.
      const doneNow = isFinished(message, options);
      // no settled here: a prior state that was still streaming must not count
      // as already finished, or the completion would never fire
      const doneBefore = prior ? isFinished(prior) : false;
      if (doneNow && !doneBefore) {
        if (looksStopped(message, stoppedIds)) {
          events.push({
            type: 'suppressed',
            reason: 'stopped',
            turnId: turnIdFor(next, index),
            threadId,
            mode,
            timestamp: Date.now()
          });
        } else if (!pendingQuestion(message)) {
          events.push({
            type: EVENTS.RESPONSE_DONE,
            turnId: turnIdFor(next, index),
            threadId,
            mode,
            timestamp: Date.now(),
            // which marker decided it, for the diagnostics panel
            signal: busySignal(message).signal,
            settled: options.settled === true
          });
        }
      }
    });

    return events;
  }

  /* ------------------------------------------------------- evaluation path */

  /**
   * One event per model, per the agreed rule for Battle and Side by side.
   *
   * `request` is the parsed body of POST /nextjs-api/stream/create-evaluation:
   *   { id, mode, modality, modelAId, modelAMessageId, modelBId?, modelBMessageId? }
   * `statuses` maps a model key to the last seen status string for that model's
   * evaluation, for example { a: 'ready', b: 'pending' }.
   */
  function fromEvaluation(request, statuses, previous, options = {}) {
    if (!request) return [];
    const mode = (request.mode || '').toLowerCase();
    if (!isSupported(mode) || SUPPORTED[mode].source !== 'evaluation') return [];

    const turnId = request.id || null;
    const threadId = request.id || null;
    const events = [];
    const seen = previous || {};

    const models = [
      ['a', request.modelAMessageId || null],
      ['b', request.modelBMessageId || null]
    ];

    for (const [key, messageId] of models) {
      if (!messageId) continue;
      const status = (statuses || {})[key];
      if (status !== 'ready') continue;
      if (seen[key] === 'ready') continue;
      events.push({
        type: EVENTS.RESPONSE_DONE,
        turnId,
        threadId,
        mode,
        model: key,
        messageId,
        timestamp: Date.now(),
        // webdev artifacts have a name; nothing else does
        artifact: request.modality || null
      });
    }

    return events;
  }

  /* ------------------------------------------------------------ limit path */

  /**
   * E3 from the DOM banner. The banner has no id of its own, so the turn is the
   * last user message in the chat state at that moment; if the state has not been
   * polled yet the banner text is used as a weaker key rather than guessing.
   */
  function fromLimit(chatState, options = {}) {
    const mode = (options.mode || 'agent').toLowerCase();
    if (!isSupported(mode) || SUPPORTED[mode].source !== 'chatState') return [];
    if (!chatState || !Array.isArray(chatState.messages)) return [];

    const messages = chatState.messages;
    const user = lastUser(messages);
    const turnId = (user && user.id) || chatState.id || null;
    if (!turnId) return [];

    return [{
      type: EVENTS.TOOL_LIMIT,
      turnId,
      threadId: chatState.id || null,
      mode,
      timestamp: Date.now()
    }];
  }

  /* -------------------------------------------------------------- dedupe key */

  const keyFor = (event) =>
    [event.threadId || '-', event.turnId || '-', event.type, event.model || '-'].join('|');

  const api = {
    EVENTS,
    SUPPORTED,
    isSupported,
    isFinished,
    hasAnswerText,
    busySignal,
    shapeOf,
    pendingQuestion,
    looksStopped,
    fromChatState,
    fromEvaluation,
    fromLimit,
    turnIdFor,
    keyFor
  };

  root.BatonEvents = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
