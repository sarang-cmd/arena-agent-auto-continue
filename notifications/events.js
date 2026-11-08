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

  /**
   * Is this assistant message finished?
   *
   * Verified shape from the captures: `pending` goes true to false, the text
   * part carries state "done", and nothing else arrives afterwards. `pending`
   * is the authority; the text state is used as corroboration when present.
   */
  function isFinished(message) {
    if (!message || message.role !== 'assistant') return false;
    const meta = message.metadata || {};
    if (meta.pending === true) return false;
    const texts = (message.parts || []).filter((p) => p.type === 'text');
    if (texts.length === 0) return false;
    const states = texts.map((p) => p.state).filter(Boolean);
    if (states.length && states.some((s) => s !== 'done')) return false;
    return true;
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
      const doneNow = isFinished(message);
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
            timestamp: Date.now()
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
    pendingQuestion,
    looksStopped,
    fromChatState,
    fromEvaluation,
    fromLimit,
    turnIdFor,
    keyFor
  };

  if (typeof window !== 'undefined') window.BatonEvents = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
