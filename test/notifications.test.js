/**
 * Unit tests for the notification stack: the pure event layer, the dedupe
 * contract and the notification wording. node --test, no dependencies.
 *
 *   node --test test/notifications.test.js
 *
 * Fixtures in test/fixtures/ are built by scripts/make-fixtures.py from the
 * sanitized captures, with ids, titles and question text replaced.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

const load = (file) => {
  const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const module = { exports: {} };
  new Function('module', 'exports', 'window', code)(module, module.exports, undefined);
  return module.exports;
};

const Events = load('notifications/events.js');
const Notifier = load('notifications/notifier.js');

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

/* ---------------------------------------------------------------- E1 and E2 */

test('E1: an answer that finishes on its own produces one response_done', () => {
  const before = fixture('agent-e1-before.json');
  const after = fixture('agent-finished.json');

  const events = Events.fromChatState(before, after, { mode: 'agent' });

  const done = events.filter((e) => e.type === 'response_done');
  assert.equal(done.length, 1, 'exactly one completion');
  assert.equal(done[0].turnId, 'msg-00', 'the turn is the user message it answers');
  assert.equal(done[0].threadId, after.id);
  assert.equal(done[0].mode, 'agent');
});

test('E1: the same snapshot twice produces nothing the second time', () => {
  const before = fixture('agent-e1-before.json');
  const after = fixture('agent-finished.json');
  assert.ok(Events.fromChatState(before, after, { mode: 'agent' }).length > 0);

  const again = Events.fromChatState(after, after, { mode: 'agent' });
  assert.equal(again.length, 0, 'a re-poll of the same state is not a new event');
});

test('E1: the first poll after a reload is a baseline, not a burst', () => {
  const after = fixture('agent-finished.json');
  const events = Events.fromChatState(null, after, { mode: 'agent' });
  assert.deepEqual(events, [], 'history is not replayed as notifications');
});

test('E1: a pending answer is not a completion, a finished one is', () => {
  const running = fixture('agent-running.json');
  const events = Events.fromChatState(fixture('agent-e1-before.json'), running, { mode: 'agent' });

  // msg-01 in this snapshot has finished; msg-03 is the one still running, so it
  // must not be reported even though it is the newest message
  const done = events.filter((e) => e.type === 'response_done');
  assert.deepEqual(done.map((e) => e.turnId), ['msg-00']);
  assert.ok(!done.some((e) => e.turnId === 'msg-03'), 'the pending turn is silent');
});

test('E1: a turn the user stopped is suppressed, not reported', () => {
  const before = fixture('agent-e1-before.json');
  const after = fixture('agent-finished.json');
  const stoppedIds = new Set(['msg-01']);

  const events = Events.fromChatState(before, after, { mode: 'agent', stoppedIds });
  assert.equal(events.filter((e) => e.type === 'response_done').length, 0);
  assert.equal(events.filter((e) => e.type === 'suppressed').length, 1);
});

test('E1: a stopped id that matches nothing changes nothing', () => {
  const events = Events.fromChatState(
    fixture('agent-e1-before.json'), fixture('agent-finished.json'),
    { mode: 'agent', stoppedIds: new Set(['msg-99']) });
  assert.equal(events.filter((e) => e.type === 'response_done').length, 1);
});

/* --------------------------------------------------------------------- E2 */

test('E2: a question that starts waiting produces one question_asked', () => {
  const running = fixture('agent-running.json');
  const finished = fixture('agent-finished.json');

  const events = Events.fromChatState(running, finished, { mode: 'agent' });
  const asked = events.filter((e) => e.type === 'question_asked');
  assert.equal(asked.length, 1, 'the newly waiting question is reported once');
  assert.ok(asked[0].questionCount >= 1);
});

test('E2: an answered question is not a question', () => {
  const waiting = fixture('agent-question-waiting.json');
  const answered = fixture('agent-question-answered.json');

  const events = Events.fromChatState(waiting, answered, { mode: 'agent' });
  assert.equal(events.filter((e) => e.type === 'question_asked').length, 0);
});

test('E2: a question that was already waiting is not repeated', () => {
  const waiting = fixture('agent-question-waiting.json');
  const events = Events.fromChatState(waiting, waiting, { mode: 'agent' });
  assert.equal(events.length, 0);
});

/* --------------------------------------------------------------------- E3 */

test('E3: the limit is keyed to the turn it belongs to', () => {
  const state = fixture('agent-finished.json');
  const events = Events.fromLimit(state, { mode: 'agent' });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_limit_reached');
  assert.equal(events[0].turnId, 'msg-04', 'the last user message at that moment');
  assert.equal(Events.keyFor(events[0]), [state.id, 'msg-04', 'tool_limit_reached', '-'].join('|'));
});

test('E3: two polls of the same turn produce the same key, so only one notifies', () => {
  const state = fixture('agent-finished.json');
  const a = Events.fromLimit(state, { mode: 'agent' })[0];
  const b = Events.fromLimit(state, { mode: 'agent' })[0];
  assert.equal(Events.keyFor(a), Events.keyFor(b));
});

/* ----------------------------------------------------- evaluation family */

test('evaluation: a direct-battle turn completes once', () => {
  const { request, responses } = fixture('evaluation-direct.json');
  const statuses = { a: responses.a.status };

  const events = Events.fromEvaluation(request, statuses, {}, {});
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'response_done');
  assert.equal(events[0].model, 'a');
  assert.equal(events[0].turnId, 'eval-01');
});

test('side by side: one notification per model, as agreed', () => {
  const { request, responses } = fixture('evaluation-side-by-side.json');
  const statuses = { a: responses.a.status, b: responses.b.status };

  const events = Events.fromEvaluation(request, statuses, {}, {});
  assert.equal(events.length, 1, 'only the model that finished notifies yet');
  assert.equal(events[0].model, 'a');

  // then the second model finishes
  const later = Events.fromEvaluation(request, { a: 'ready', b: 'ready' }, { a: 'ready' }, {});
  assert.equal(later.length, 1);
  assert.equal(later[0].model, 'b');
  assert.notEqual(Events.keyFor(events[0]), Events.keyFor(later[0]), 'models are separate keys');
});

test('side by side: polling does not re-notify a model that already finished', () => {
  const { request } = fixture('evaluation-side-by-side.json');
  const seen = { a: 'ready', b: 'ready' };
  const events = Events.fromEvaluation(request, { a: 'ready', b: 'ready' }, seen, {});
  assert.deepEqual(events, []);
});

/* ------------------------------------------------------------ mode gating */

test('unsupported modes produce nothing rather than guessing', () => {
  const state = fixture('agent-finished.json');
  for (const mode of ['battle', 'multimodal', 'image', 'unknown']) {
    assert.deepEqual(Events.fromChatState(null, state, { mode }), [], mode);
    assert.deepEqual(Events.fromLimit(state, { mode }), [], mode);
  }
});

test('a mode with a chat signal is recognised, and the list is closed', () => {
  assert.ok(Events.isSupported('agent'));
  assert.ok(Events.isSupported('coding'));
  assert.ok(Events.isSupported('side-by-side'));
  assert.ok(!Events.isSupported('battle'));
});

/* ----------------------------------------------------- notification wording */

test('the body never contains answer or question text by default', () => {
  const event = {
    type: 'response_done', turnId: 'msg-00', threadId: 'aaaaaaaa-0000-4000-8000-000000000000',
    mode: 'agent', timestamp: Date.now()
  };
  const composed = Notifier.compose(event, { threadTitle: 'Trip planning', includeText: false });
  // no answer text: at most a neutral sentence pointing back at the page
  assert.ok(!/Canberra|capital|Australia/i.test(composed.message));
  assert.equal(composed.message, 'Open Arena to see what happened.');
  assert.match(composed.title, /Arena: response complete/);
  assert.match(composed.title, /Trip planning/);
});

test('the option adds text only when it is switched on', () => {
  const event = { type: 'response_done', turnId: 't', threadId: 'x', mode: 'agent' };
  const withText = Notifier.compose(event, {
    threadTitle: 'Trip planning', includeText: true, text: 'The capital of Australia is Canberra.'
  });
  assert.match(withText.message, /Canberra/);
});

test('E3 says whether auto-continue answered', () => {
  const event = { type: 'tool_limit_reached', turnId: 't', threadId: 'x', mode: 'agent' };
  const answered = Notifier.compose(event, { continued: true });
  const waiting = Notifier.compose(event, { continued: false });
  assert.match(answered.message, /answered automatically/);
  assert.match(waiting.message, /waiting for you/);
});

test('a long thread title is cut at a word boundary, not mid-word', () => {
  const long = 'Project: Perplexity Auto-Rename Chrome MV3 extension goal automatically replace';
  const title = Notifier.titleFor({ type: 'response_done' }, long);
  assert.ok(title.length <= Notifier.MAX_TITLE + 'Arena: response complete: '.length + 2);
  assert.match(title, /\u2026$/);
  assert.ok(!/\s\u2026$/.test(title));
});

test('side by side distinguishes the two models in the body', () => {
  const a = Notifier.compose({ type: 'response_done', mode: 'side-by-side', model: 'a' }, {});
  const b = Notifier.compose({ type: 'response_done', mode: 'side-by-side', model: 'b' }, {});
  assert.match(a.message, /model A/);
  assert.match(b.message, /model B/);
});

test('every file the manifest loads exists, and parses', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const wanted = [];
  for (const cs of manifest.content_scripts || []) wanted.push(...(cs.js || []));
  wanted.push(...((manifest.background || {}).scripts || []));
  const missing = wanted.filter((f) => !fs.existsSync(path.join(root, f)));
  assert.deepEqual(missing, [], 'manifest loads a file that is not in the tree');
  for (const f of wanted) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(root, f), 'utf8')), f);
  }
});

/* ---------------------------------------------------------------- detection
 * The captures never covered the agent chat-state shape, so these cases pin the
 * decision down from both sides: a marker that is present must win, and an
 * unmarked message must only count once the page has stopped changing.
 */

const assistant = (overrides) => ({
  id: 'a1', role: 'assistant',
  metadata: { pending: false },
  parts: [{ type: 'text', state: 'done', text: 'hello' }],
  ...overrides
});

test('pending true is busy, whatever else the message says', () => {
  assert.equal(Events.isFinished(assistant({ metadata: { pending: true } })), false);
});

test('pending false is done, even with no text state to corroborate it', () => {
  const msg = assistant({ parts: [{ type: 'text', text: 'hello' }] });
  assert.equal(Events.isFinished(msg), true);
  assert.match(Events.busySignal(msg).signal, /pending false/);
});

test('a streaming part keeps it busy when pending is absent', () => {
  const msg = assistant({ metadata: {}, parts: [{ type: 'text', state: 'streaming', text: 'half' }] });
  assert.equal(Events.isFinished(msg), false, 'must not notify mid stream');
  assert.match(Events.busySignal(msg).signal, /streaming/);
});

test('a done part finishes it when pending is absent', () => {
  const msg = assistant({ metadata: {}, parts: [{ type: 'text', state: 'done', text: 'an answer' }] });
  assert.equal(Events.isFinished(msg), true);
});

test('a finishReason of stop counts as done', () => {
  const msg = assistant({ metadata: { finishReason: 'stop' }, parts: [{ type: 'text', text: 'an answer' }] });
  assert.equal(Events.isFinished(msg), true);
});

test('an unmarked message only counts once the page has settled', () => {
  const msg = assistant({ metadata: {}, parts: [{ type: 'text', text: 'x' }] });
  assert.equal(Events.isFinished(msg), false, 'unknown shape must not fire on its own');
  assert.equal(Events.isFinished(msg, { settled: true }), true, 'settled makes it fire');
});

test('an empty message never counts as finished', () => {
  assert.equal(Events.isFinished({ role: 'assistant', metadata: {}, parts: [] }, { settled: true }), false);
});

test('a step made only of reasoning and tool parts is not a finished response', () => {
  const step = assistant({
    metadata: { pending: false },
    parts: [{ type: 'reasoning', state: 'done' }, { type: 'tool-ask_user', state: 'output-available' }]
  });
  assert.equal(Events.isFinished(step), false);
  assert.equal(Events.isFinished(step, { settled: true }), false, 'settling must not promote a step');
});

test('a pending question is not a completion', () => {
  const msg = assistant({
    metadata: {},
    parts: [
      { type: 'text', state: 'done' },
      { type: 'tool-ask_user', state: 'input-available' }
    ]
  });
  assert.equal(Events.isFinished(msg, { settled: true }), false);
});

test('the settled flag alone drives E1 through fromChatState', () => {
  const before = { id: 'chat-1', messages: [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'go' }] },
    { id: 'm2', role: 'assistant', metadata: {}, parts: [{ type: 'text', state: 'streaming' }] }
  ] };
  const after = { id: 'chat-1', messages: [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'go' }] },
    { id: 'm2', role: 'assistant', metadata: {}, parts: [{ type: 'text', text: 'result' }] }
  ] };
  const notYet = Events.fromChatState(before, after, { mode: 'agent', settled: false });
  const settled = Events.fromChatState(before, after, { mode: 'agent', settled: true });
  assert.deepEqual(notYet.map((e) => e.type), []);
  assert.deepEqual(settled.map((e) => e.type), ['response_done']);
  assert.match(settled[0].signal, /no busy or done marker/);
});

test('the structural summary carries no text and no ids', () => {
  const state = { id: 'chat-secret-id', messages: [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'my private prompt' }] },
    { id: 'm2', role: 'assistant', metadata: { pending: false, model: 'x' },
      parts: [{ type: 'text', state: 'done', text: 'my private answer' }] }
  ] };
  const shape = Events.shapeOf(state);
  const json = JSON.stringify(shape);
  assert.ok(!json.includes('private'), 'text leaked into the shape report');
  assert.ok(!json.includes('chat-secret-id'), 'the chat id leaked into the shape report');
  assert.ok(!json.includes('m1'), 'a message id leaked into the shape report');
  assert.deepEqual(shape.roles, ['user', 'assistant']);
  assert.deepEqual(shape.assistant.partStates, ['done']);
  assert.deepEqual(shape.assistant.metadataKeys, ['model', 'pending']);
});
