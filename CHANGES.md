# Changes to existing Baton behaviour, 1.3.0

Baton gained notifications for three Arena events. This file lists every change to something that
already existed, because the brief says the auto-continue path must not change silently.

## Changed

**`manifest.json` permissions.** Was `storage`, `activeTab`, plus `notifications` as optional. Now
`storage`, `activeTab`, `notifications`, `webRequest`. Two reasons:

- `notifications` is promoted from optional to required, because the three event toggles are on by
  default and an optional permission cannot be requested from a service worker without a user
  gesture on every install.
- `webRequest` is new, and it is the one permission the brief's rules did not anticipate. The
  evaluation family (Direct, Battle, Side by side) only exposes its message ids inside the body of
  `POST /nextjs-api/stream/create-evaluation`, and `chrome.webRequest` is the only API that can read
  it. The user approved this explicitly. It is scoped to `https://arena.ai/*` and
  `https://*.arena.ai/*`, it only inspects POSTs, and it reads only request bodies, not responses.

**`content.js` gained a call inside `tick()`.** Immediately after Baton computes the banner signature,
and *before* the `armed` and `suppressUntil` guards, it now emits one `tool_limit_reached` event per
banner signature via `emitLimitEvent()`. Ordering matters and is deliberate: the event fires even when
Baton has stopped sending (safety cap, suppressed, hidden tab), because a user who switched auto-send
off still wants to know the run hit the limit.

**`content.js` gained `reportLimitOutcome()`**, called from `attemptSend()` after a send, which tells
the worker whether auto-continue answered, so the E3 notification can say "answered automatically" or
"waiting for you". It carries no text.

**`content.js` starts a page observer** (`notifications/observe.js`) in `start()`. If it fails to
load, the failure is swallowed: auto-continue keeps working with notifications absent.

**`content.js` accepts one new message**, `baton-stopped`, carrying the message ids the background
worker saw in a `/nextjs-api/stream/stop/` request.

**Settings.** Four new keys, `notifyResponseDone`, `notifyQuestionAsked`, `notifyToolLimit`,
`includeNotificationText`. Three default to on, the text option to off. They are additive: an existing
stored settings object is merged over the defaults, so nothing existing changes value.

**Options page.** A Notifications section with the four switches and a test button, and the Alerts
note reworded. The "Notify when Baton pauses" switch and its behaviour are unchanged.

**`package.json` `npm test`** now runs both suites: `node --test test/notifications.test.js` and
`node test/test.js`. The old suite is untouched apart from three added cases.

**Build.** `scripts/build.sh` also packs `notifications/` and `ui/settings.js` into the zip.

## Not changed, stated because it was a risk

- The send path itself: `findLimitNotice`, the freshness checks (`isAtEndOfTranscript`, `isAgentBusy`,
  the transcript fingerprint), `scheduleSend`, `doSend`, `attemptSend`, `confirmEffect` and every
  constant are as they were in 1.2.1.
- The re-arm behaviour, the 20 s suppression after a failed send, the safety cap, and the single-flight
  guard. The existing 32 tests still pass unmodified; the new ones are additive.
- No network destination was added. The observer polls `/api/chat/<id>` and
  `/api/evaluation/<modality>/<id>` on `arena.ai`, both of which the page itself calls.
