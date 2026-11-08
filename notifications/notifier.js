/**
 * Notifier
 * ------------------------------------------------------------------
 * Wraps chrome.notifications.create. Everything here is about the wording and
 * about not lying to the user: no answer text, no question text, no prompts.
 *
 * A denied permission is reported once in the options page rather than retried,
 * because Chrome will keep refusing until the user changes it by hand.
 */
(() => {
  const MAX_TITLE = 60;
  const TITLES = {
    response_done: 'Arena: response complete',
    question_asked: 'Arena: agent is asking you a question',
    tool_limit_reached: 'Arena: tool-call limit reached'
  };

  /** Collapse whitespace and cut at a word boundary. Titles can be whole prompts. */
  function tidyTitle(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= MAX_TITLE) return clean;
    const cut = clean.slice(0, MAX_TITLE);
    const space = cut.lastIndexOf(' ');
    return (space > MAX_TITLE * 0.6 ? cut.slice(0, space) : cut).trim() + '\u2026';
  }

  /**
   * The body never contains the model's output. At most: which mode, which model,
   * and, for E3, whether Baton answered the banner.
   */
  function bodyFor(event, context = {}) {
    const bits = [];
    if (event.mode && event.mode !== 'agent') bits.push(event.mode);
    if (event.model) bits.push('model ' + event.model.toUpperCase());
    if (event.type === 'tool_limit_reached') {
      bits.push(context.continued ? 'answered automatically' : 'waiting for you');
    }
    if (event.type === 'question_asked' && event.questionCount) {
      bits.push(event.questionCount === 1 ? '1 question' : event.questionCount + ' questions');
    }
    if (event.type === 'response_done' && event.timestamp && context.elapsedMs) {
      bits.push(Math.round(context.elapsedMs / 1000) + ' s');
    }
    return bits.join(' \u00b7 ');
  }

  function titleFor(event, threadTitle) {
    const base = TITLES[event.type] || 'Arena';
    const thread = tidyTitle(threadTitle);
    return thread ? base + ': ' + thread : base;
  }

  /**
   * Build the notification object. `includeText` lets the user opt into a snippet
   * of the answer or question; it is off by default and capped when on.
   */
  function compose(event, { threadTitle, continued, includeText, text } = {}) {
    const parts = [];
    const body = bodyFor(event, { continued });
    if (body) parts.push(body);
    if (includeText && text) parts.push(tidyTitle(text));
    return {
      title: titleFor(event, threadTitle),
      message: parts.join('\n') || 'Open Arena to see what happened.',
      // the tab id is attached at create time so a click can focus the thread
      isClickable: true
    };
  }

  function create(id, options, cb) {
    try {
      chrome.notifications.create(id, options, () => {
        void (chrome.runtime && chrome.runtime.lastError);
        if (cb) cb();
      });
    } catch (_) {
      if (cb) cb();
    }
  }

  const api = { TITLES, compose, bodyFor, titleFor, tidyTitle, create, MAX_TITLE };
  if (typeof window !== 'undefined') window.BatonNotifier = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
