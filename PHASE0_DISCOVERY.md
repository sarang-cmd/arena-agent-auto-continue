# Phase 0: discovery report

Status: prepared before any feature code. Nothing in `notifications/` has been written yet.

Inputs read in full: `findings.md`, and the five sanitized captures in `uploads/`:

| File | Mode | Entries kept | What it is |
| --- | --- | --- | --- |
| `arena-agent-done.sanitized.json` | agent (chat) | 31 of 60 | a turn that ran to completion |
| `arena-agent-question.sanitized.json` | agent (chat) | 55 of 87 | two `ask_user` rounds, then a normal answer |
| `arena-agent-manualstop.sanitized.json` | coding (`/code/direct`) | 27 of 47 | a turn the user stopped |
| `arena-direct-done.sanitized.json` | evaluation, `direct-battle` | 55 of 92 | a turn that ran to completion |
| `arena-sidebyside-done.sanitized.json` | evaluation, `side-by-side` | 37 of 97 | two models answering one turn |

Two limits on the evidence, stated up front, because they change what can be built:

1. **Streaming bodies are missing.** Every `text/event-stream` entry in the agent captures has
   `response_body: ""`. Chrome's HAR exporter does not keep streamed bodies by default. The
   `create-evaluation` stream in the direct capture did survive (`text/event-stream`, 60031 bytes), so
   that one is readable.
2. **No capture contains a tool-call-limit event.** I searched every request and response body in all
   five files for `tool-call limit`: zero matches. So E3 has **no verified network signal at all**.

---

## 1. E1 `response_done`

### 1a. Agent mode, `productMode: "chat"` — Verified

Source: `GET /api/chat/<chatId>?includeStreamToken=false&recoverRun=false`

This is the state endpoint the page itself polls. In `arena-agent-question` it is called eight times,
and each response is a full snapshot:

```json
{
  "id": "01a1bb6e-5c5b-76c5-9350-505e2afea7aa",
  "taskId": "agent-runner",
  "productMode": "chat",
  "messages": [
    { "id": "01a1bb6e-7992-7695-acaa-b410edd8c71d", "role": "assistant",
      "metadata": { "pending": false,
                    "timing": { "startedAt": 1794145941906, "completedAt": 1794145943545 } },
      "parts": [ { "type": "step-start" },
                 { "type": "text", "text": "The capital of Australia is Canberra...", "state": "done" } ] }
  ]
}
```

The completion signal is the combination of three fields on the last assistant message:

| Field | Running | Finished |
| --- | --- | --- |
| `metadata.pending` | `true` | `false` |
| `metadata.timing.completedAt` | set (it is set when the model call ends, even mid-turn) | set |
| last text part `state` | `"streaming"` (not directly observed) | `"done"` |

I watched the transition in the same capture: message `01a1bb6f-c155` appears at 13:53:55 with
`pending: true`, then at 13:54:15 with `pending: false`, then a new user message follows. That is the
observed shape of "a turn finished and nothing more is coming".

Confidence: **Verified** for `pending` going `true → false` with a `state: "done"` text part and no
further parts arriving. The exact spelling `"streaming"` is **Inferred**; I did not see a live
streaming snapshot, because the sanitized captures only kept finished ones.

### 1b. Evaluation modes, `direct-battle` and `side-by-side` — Verified for the finish, weak for the turn

Two independent signals:

- `POST /nextjs-api/stream/create-evaluation` ends the model's output with `ad:{"finishReason":"stop"}`
  in the multiplexed stream. That line is present in `arena-direct-done` and is the last payload line
  in the file. Confidence: **Verified** that the line exists and is terminal for that turn.
- `GET /api/evaluation/webdev/<messageId>` returns `{"status":"ready","id":"...","manifest":{"buildResult":{"status":"success"}}}`.
  Confidence: **Verified**, but this marks the artifact build finishing, not necessarily the model
  turn; treat it as corroboration only.

The problem: the content script cannot read either stream body (limit 1 above), and this repo's rules
for the feature allow only the `notifications` permission, so `chrome.webRequest` is not available to
observe the `create-evaluation` request body. Without that body there is no message id to poll, so
**there is currently no way for the extension to derive a stable `turnId` in these modes**.
Confidence: **Verified** as a constraint, not a guess.

### 1c. Manual stop — Verified for the request, Unverified for the state

`arena-agent-manualstop` contains exactly one interesting call:

```
POST /nextjs-api/stream/stop/01a1bbc4-ff5d-7dac-9687-9e5b473c8875/messages/01a1bbc5-1853-7e33-b5de-71565adff272
-> 200 {"stoppedMessageIds":["01a1bbc5-1853-7673-91d9-23f08737ccb0","01a1bbc5-1853-7e33-b5de-71565adff272"]}
```

So a manual stop is a POST with the chat id and a message id in the path, and the response lists the
message ids that were stopped. Confidence: **Verified** for that endpoint and response shape.

What I cannot see is how the stopped message looks afterwards in `/api/chat/<chatId>`. The capture has
no such fetch. Until that is known, the extension cannot distinguish "finished on its own" from
"stopped by the user" in agent mode, which is exactly what E1's rule depends on. **This is the one
capture I need before E1 can be built safely.**

---

## 2. E2 `question_asked`

**Verified, and better than expected: it is a typed tool call, not plain text.**

In `/api/chat/<chatId>`, an assistant message that asks the user something carries a part of type
`tool-ask_user`:

```json
{
  "type": "tool-ask_user",
  "toolCallId": "tc_JGe4Vu8yePHNRx95M6SGoU",
  "state": "input-available",
  "input": { "questions": [ { "id": "destination",
                              "question": "Where would you like to go, and where will you be traveling from?",
                              "options": [ ... ],
                              "allowCustomResponse": true } ] },
  "output": { "skipped": false, "answers": [ ... ] }
}
```

The state field is the switch:

| `state` | Meaning | Observed at |
| --- | --- | --- |
| `input-available` | the agent asked and is waiting | 13:53:55 and 13:54:15 snapshots |
| `output-available` | the user answered | 13:54:15 and 13:54:35 snapshots |

The user's answer arrives as `POST /ai-proxy/realtime/v1/sessions/agent-runner:<chatId>/in/append` with
a `data-tool-results` part carrying `tool: "ask_user"`. That is the "question was answered" edge, so a
notification can be correctly scoped to the waiting period and never fire twice.

Confidence: **Verified**. No plain-text heuristic is needed in agent mode, and I recommend not adding
one (see the open questions).

---

## 3. E3 `tool_limit_reached`

**No network evidence, in any capture.** Zero occurrences of `tool-call limit` across all request and
response bodies, and no `finishReason` other than `"stop"` in the one readable stream.

What is verified is the DOM: Baton already matches the banner in production with

```js
// content.js
const RE_LIMIT = /reached the tool[-\s]?call limit/i;   // and a "send a message to continue" backstop
function findLimitNotice(deep = false)  // reverse text scan, last match first
```

That detection is the only thing that has ever been observed working for E3, and it is the signal the
brief tells me to reuse. So E3 becomes: **DOM event, cross-checked against the chat state to get a
stable turn id.**

The cross-check matters for dedupe. A DOM banner has no id, and Baton already knows this problem: it
re-arms after the banner has been absent for about 1.2 seconds, which is right for "may I send again"
but wrong for "is this a new event". Polling `/api/chat/<chatId>` gives the ids, so the event layer can
key E3 on `chatId + id of the last user message + 'tool_limit_reached'`, which is stable across a
reload.

Confidence: **Verified** that the DOM signal is what Baton uses; **Unverified** whether Arena also
reports the limit on the wire (it probably does, inside the `/out` stream, but a stream body cannot be
read by a content script).

---

## 4. Per-mode matrix

| Mode | Evidence in hand | E1 | E2 | E3 | Proposed fallback |
| --- | --- | --- | --- | --- | --- |
| Agent (`arena.ai/agent`, `productMode: chat`) | `arena-agent-done`, `arena-agent-question` | Verified (poll `/api/chat`) | Verified (`tool-ask_user` state) | DOM only | none needed for E1/E2; E3 from DOM plus chat-state turn id |
| Coding (`/code/direct`, `productMode: coding`) | `arena-agent-manualstop` | Inferred (same `agent-runner` transport, same `/api/chat` shape) | Inferred (same transport) | DOM only | enable E1/E2 behind the same code path, mark Inferred in the README, verify live |
| Direct (`direct-battle`) | `arena-direct-done` | Verified finish (`finishReason: stop`), no readable id | Unverified | Unverified | **disable** until an id source exists |
| Side by side (`side-by-side`, two evaluation ids) | `arena-sidebyside-done` | as above, two models per turn | Unverified | Unverified | **disable** until an id source exists |
| Battle | none | Unverified | Unverified | Unverified | **disable**; needs a capture |
| Multimodal (image, and so on) | none | Unverified | Unverified | Unverified | **disable**; needs a capture |

The rule I would apply in code: a mode is either explicitly enabled with a verified signal, or it
produces nothing. No mode gets a guess.

Two further facts from `/api/history/unified`, which does give thread titles:

```json
{ "type": "evaluation", "id": "...", "title": "Australia capital city facts",
  "mode": "side-by-side", "modality": "webdev",
  "modelAId": "...", "modelBId": "..." }
{ "type": "agentic", "productMode": "coding", "title": "Junction", "id": "..." }
```

Titles are not always short: one history entry's title is a multi-line prompt fragment. The
notification body must truncate. And `create-evaluation` carries `"mode":"direct-battle"` with a single
`modelAId`, which is evidence that Battle and Direct share one endpoint and differ by a field, so they
are not separate protocols. That part of the user's belief holds for the evaluation family.

---

## 5. Baton's current flow, and the collision risk

Detection, in `content.js`:

| Step | Function | Line (1.2.1) |
| --- | --- | --- |
| read the DOM for the banner | `findLimitNotice()` | 147 |
| decide whether this banner is actionable | `tick()` | 770 |
| freshness checks (banner is last, agent not busy, transcript fingerprint) | `isAtEndOfTranscript()`, `isAgentBusy()`, `transcriptFingerprint()` | 300 to 460 |
| delay, then send | `scheduleSend()` → `doSend()` → `attemptSend()` | 719, 640 |
| confirm it landed, else back off 20 s | `confirmEffect()` | 373 |

It does **not** use any network signal. `RE_LIMIT` is the whole of its detection.

Collision risk, stated plainly: notification and auto-continue would be two consumers of one DOM
observation, and Baton has state (`armed`, `suppressUntil`, `stopped`, the safety cap) that can stop the
send while a notification should still fire, and vice versa. The fix is a single emit point that both
consume: one `tool_limit_reached` event, fired once per turn key, with the notifier and the continue
path each subscribing. `stopped` must not suppress the event, because the user still wants to know the
run hit the limit even when Baton has stopped answering it. The test in the brief (one limit event
produces one continue and one notification) becomes a test of that seam.

I will also need to state in `CHANGES.md` that `findLimitNotice()` and `tick()` gain an emit call and
that the ordering inside `tick()` is untouched.

---

## 6. Proposed architecture, for confirmation alongside the questions

- `notifications/events.js`: pure. Takes an observation `{kind, chatState | dom, mode}` and returns
  `{type, turnId, threadId, mode, timestamp}` or `null`. No `chrome.*`, so `node --test` can drive it
  with the fixtures below.
- `notifications/observe.js`: the only place that touches the page. Polls `/api/chat/<chatId>` at a
  slow cadence while the tab is visible and a turn is live, and exposes the DOM banner from Baton's
  existing detector. Same origin, same endpoints the page already calls, no new destination.
- `notifications/dedupe.js`: `chrome.storage.session`, keyed `threadId + turnId + type`, capped list.
- `notifications/notifier.js`: wraps `chrome.notifications.create`; handles a denied permission by
  surfacing it in options once, no retry loop.
- Options: three toggles, "Include text in notification" (off), "Test notification".

Fixtures would be derived from these captures with all ids replaced by deterministic dummies, prompts
replaced by the short synthetic strings already used in `arena-direct-done`'s evaluation, and no
cookies or tokens (the sanitizer already removed those; I will also strip `recaptchaV3Token`, which
survived sanitizing in two request bodies and must not reach the repo).

That last point is a data-hygiene issue in the supplied files, and I checked it rather than assuming:
three of the five still carry credentials in `request_body`. `arena-agent-done` has 2 such entries,
`arena-agent-question` has 4, and `arena-direct-done` has 1, holding `recaptchaV3Token`, `arenaVisitId`
and a `cx` value. The sanitizer removed cookies and auth headers but not request bodies. They are
expired, but they should not be copied anywhere. My fixtures exclude them, and the fixture builder will
fail if a token-shaped string reaches it.

---

## 7. Open questions

Blocking E1 in agent mode:

1. **A capture of an agent-mode manual stop, plus the `/api/chat/<chatId>` fetch that follows it.** This
   is the only way to learn how a stopped turn differs from a finished one. The existing manual-stop
   capture is the coding mode and has no state fetch, so I cannot infer it.

Decision needed on scope:

2. **Battle and side-by-side granularity.** The side-by-side capture has two evaluation ids under one
   `evaluationSessionId` in one turn, so one notification per model is possible in principle and one
   per turn is possible in practice. Which do you want?
3. **Evaluation modes are disabled in the plan above**, because the extension cannot learn their message
   ids under the current permission rules. If you want them in, either allow `webRequest` (a new
   permission, which the brief forbids), or give me one capture per evaluation mode so I can look for a
   same-origin state endpoint that does not need ids from the request.
4. **"Direct chat" in the brief.** Arena's `/code/direct` reports `mode: "direct-battle"` and
   `modality: "webdev"`. Is that what you mean by Direct chat, or do you mean the plain chat composer
   (`productMode: "chat"`), which is what I have called Agent?

Behaviour questions:

5. **Plain-text questions.** I propose E2 fires only on `tool-ask_user` and never on a guess at prose,
   since a false positive is the failure the brief says must not happen. Do you want a heuristic behind
   an off-by-default switch anyway?
6. **Multimodal.** No capture. Leave disabled, or capture one image turn?
7. **Thread title in the notification.** Confirmed available and clean, but some titles are a whole
   prompt fragment. I will truncate to about 60 characters and never include answer text unless the
   option is on. Is a title-only body acceptable for all three events?

I will stop here and wait for answers before writing feature code, as the brief requires.
