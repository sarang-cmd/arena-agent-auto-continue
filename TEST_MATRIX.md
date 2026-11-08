# Manual test matrix

For the user to run, in a real Chrome with the unpacked extension loaded. Every step says what should
happen; if a row fails, the note in the last column says what it means.

Read this first:

- **E1 in agent mode has one known gap.** No capture showed how a manually stopped turn looks in
  `/api/chat`, so a stopped response may still notify as complete (row 6). This is the only row where
  a wrong result is expected rather than a bug.
- **Evaluation modes are new and less proven.** Their ids come from the request body, learned with
  `webRequest`; there is no capture of a second model finishing, so rows 9 and 10 are unverified.
- Clear the dedupe store between runs, or a row will look like it "did not fire" when it did. In the
  service worker console: `chrome.storage.session.clear()`.

Setup:

1. `npm install`, then run `npm run build`, then load `dist/` unpacked at `chrome://extensions`.
2. Open the options page from the toolbar icon and press **Send a test notification**.
3. Leave the options page open in a second tab while testing; it shows the current switches.

## Rows

| # | Mode | Event | Steps | Expected | If it fails |
| --- | --- | --- | --- | --- | --- |
| 1 | Agent | E1 | Send a short prompt, wait for the answer to finish | One notification, title `Arena: response complete` plus the thread title, no answer text | `pending` was never observed going false: the poll may be too slow, or the route has no chat id |
| 2 | Agent | E2 | Ask something that makes the agent ask a question, for example "Plan a trip, ask me what you need" | One notification, `Arena: agent is asking you a question` | The tool part may be named differently; check `tool-ask_user` in the `/api/chat` response |
| 3 | Agent | E2 | Answer the question, then let the agent ask a second one | A second notification for the second question, and none for the first | Dedupe key is colliding on the turn instead of the question |
| 4 | Agent | E3 | Run a task long enough to hit the tool-call limit | One notification, `Arena: tool-call limit reached`, body says `answered automatically`, and exactly one `continue` is sent | If the notification is missing but the send happened, the emit point in `tick()` was not reached |
| 5 | Agent | E3 with auto-send off | Same, with Auto-send off | Notification still fires, body says `waiting for you`, no message sent | The event is being gated by the send path instead of standing alone |
| 6 | Agent | manual stop | Start a long answer, press Stop | **Preferably no notification.** If one arrives claiming completion, that is the known gap | This is the row the missing capture would fix |
| 7 | Agent | reload mid-response | Start an answer, reload the tab while it runs | No notification for the old turn; the new turn notifies normally | The first poll is being treated as a diff instead of a baseline |
| 8 | Agent | two tabs | Same thread open twice, run one turn | Exactly one notification, not two | Dedupe is per tab rather than per thread and turn |
| 9 | Direct | E1 | Run a Direct turn to completion | One notification naming the mode | Message ids were not learned: check the `create-evaluation` request in the network panel |
| 10 | Side by side | E1 | Run a turn, let model A finish first | One notification naming model A, then another for model B | The agreement was one per model; if you get one per turn, `fromEvaluation` is collapsing them |
| 11 | Battle | any | Run a Battle turn | Nothing | Battle has no capture and is deliberately silent |
| 12 | Multimodal | any | Any image turn | Nothing | Same: no capture, no guessing |
| 13 | any | toggles off | Switch `Response complete` off, run an agent turn to completion | No notification for E1; E2 and E3 still fire | `eventEnabled` is not reading the stored key |
| 14 | any | text option on | Switch `Include text in notification` on, run a turn | The notification body includes a short snippet | The observer is not passing text; it deliberately does not read answer text, so this needs the page to supply it |
| 15 | any | notifications blocked | In Chrome site settings, block notifications for the extension, run a turn | The options page says notifications are blocked; no retry loop | The wording was not updated after the permission state check |
| 16 | any | permission state | Disable the extension's notification permission, reopen options | The Notifications note reads "Notifications are blocked for this extension" | `refreshNotify` did not run |
| 17 | any | search | Type `question` in the options search box | Only the matching notification toggle stays visible | Row filtering regressed |

## What a passing run proves

Rows 1 to 8 and 13 prove the three events, dedupe and the toggles for the modes with a verified
signal. Rows 9 to 12 record what is deliberately not supported. Row 6 is the one row where the
expected result is a guess, and it is called out in the README and in the Phase 0 report.
