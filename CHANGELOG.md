# Changelog

## 1.4.1, 7 November 2026

- The Diagnostics report now shows the last twelve polls as a trajectory: message count, the role of
  the last message, whether an assistant message exists at all, its pending flag and part count, and
  whether it counted as settled. One paste then answers the question the single snapshot could not,
  which is whether an assistant message ever appears in `/api/chat` while a run is happening.
- The report also says what the worker did with the last event: created, refused as already notified,
  refused as switched off, or refused by Chrome, with the reason. Seeing something and delivering it
  are now visible in one place instead of two.
- A structural "is the page busy" line: whether a control named Stop is on the page, and how many
  elements are marked streaming. It is reported, never used to decide an event, so a wrong guess here
  cannot raise a notification.
- Polling tightens to one second while a run is in flight and drops back to 2.5 seconds when it is not,
  so the pending flag going false is not missed between two lazy polls.
- Verified from the captures, and now relied on: the in-flight assistant message in `/api/chat` carries
  `metadata.pending: true`, and the same message carries `false` once committed. Every message in a
  committed transcript has `pending: false`, including a last message that ends in tool calls, so
  pending alone is not enough to call an answer finished, which is why answer text is also required.

## 1.4.0, 7 November 2026

- **Diagnosis first.** A new Diagnostics section on the settings page shows what Baton actually sees
  from a run: which chat id it found and how, which endpoint answered, how many messages came back,
  the last assistant message's part types and states, and why it did or did not decide the response
  was finished. It holds key names, types, states and lengths, never text, a title or an id.
- **Send a test completion event.** It pushes a synthetic `response_done` through the same intake as a
  real one. If that notifies, the notification path works and the problem is detection; if it does
  not, the worker is the problem. That distinction was invisible before, which is why a build that
  never notified looked identical to one with a broken button.
- Completion detection no longer depends on one shape. `metadata.pending`, `metadata.finishReason`,
  `metadata.status` and per-part `state` values are all read, with streaming and pending states taking
  precedence over done ones. A shape Baton does not recognise is left alone until the page has stopped
  changing for six seconds, so an unknown protocol errs towards notifying rather than staying silent.
- A message made only of reasoning and tool parts is a step on the way, not a finished response. The
  agent produces several per turn, and notifying on those would be a notification every few seconds.
- The chat id is found from any id-shaped path segment, and, when the address bar has none, from the
  requests the page itself has already made. Before this, a route Baton did not recognise meant it
  polled nothing and said nothing.
- The poll falls back to the plain `/api/chat/<id>` when the parameterised form is not accepted, and
  stops trying on 401 and 403 instead of hammering a signed-out tab.
- Tests: 37 for the event layer, including the cases where a marker must win and where an unmarked
  shape must wait for the page to settle.

## 1.3.1, 7 November 2026

- **The toolbar button works again.** The notification modules were written for a page, where
  `window` exists, but `background.js` loads them into a service worker, where it does not. The import
  threw, the worker died before it registered the click handler, and clicking the Baton icon did
  nothing at all. It was the one symptom a user meets first, and the page tests could not see it
  because they all run inside jsdom, where `window` is there.
- The modules now resolve a shared global instead of assuming one, so the same files load both as
  content scripts and into the worker.
- `background.js` registers the toolbar button before it loads anything else, and wraps the import in
  a guard. A broken notification module can no longer take the settings page down with it.
- Four tests that run `background.js` in a context with `self` and `chrome` but no `window` and no
  `document`, so this class of bug fails the build instead of the install. They check that the click
  handler registers, that clicking opens the settings page, and that a module which throws on load
  still leaves the button working.
- `npm test` runs them, and `scripts/build.sh` was unchanged.

## 1.3.0, 7 November 2026

- Notifications for three Arena events, one per turn however many tabs are open: a response
  completing, the agent asking you a question, and a run hitting the tool-call limit. Each is a switch
  of its own, all on by default.
- The completion and question events read Arena's own chat response, so they are not guesses from the
  page. A side-by-side turn notifies per model, because the two models finish at different times.
- The limit notification says whether Baton answered it, which makes it useful with auto-send off.
- Notifications are deduplicated by thread, turn, event and model in `chrome.storage.session`, so a
  reload does not repeat one but a restart of the browser forgets them.
- Clicking a notification brings the tab holding that thread to the front, switching windows if it
  has to.
- The body names the thread and the mode. Model output is never in it unless **Include text in
  notification** is switched on, and that switch is off by default.
- **Send a test notification** on the options page.
- `webRequest` is now a declared permission, used only to read message ids from Arena's evaluation
  requests. `notifications` moved from optional to required, since the three switches are on by
  default. `CHANGES.md` lists both, and lists everything else this release touched.
- Battle and modal turns are deliberately silent, and the tests grew to 39 plus a 22 case suite for
  the event rules.
- `scripts/build.sh` now fails if the manifest loads a file that did not make it into the zip. It
  caught `notifications/observe.js` missing while this release was being packed.

## 1.2.1, 8 November 2026

- The icon is now the same mark everywhere the product appears. The site's header was still drawing
  the old teal plate in inline SVG; it uses the plate from the icon set, and the same PNGs back the
  favicon, the Apple touch icon, the web app manifest and the social card, so a tab, a home screen
  shortcut and a shared link all show one icon rather than three.
- `scripts/make-icons.py` writes the 32, 180, 192 and 512 pixel versions alongside the toolbar sizes,
  so a change to the mark moves every place it is used in one run.
- Added `site/site.webmanifest` and a 1200 by 630 social card rendered by `scripts/shots.js`.
- The pill and the settings page no longer overwrite each other. Both write through one small store,
  `ui/settings.js`, which saves only the keys that changed and re-renders every open surface when
  storage changes. Before this, flipping a switch in the pill could undo a change made on the page a
  moment earlier.
- The settings page gained a search box that filters by setting name or by what it does, and says
  when nothing matches instead of leaving a blank card.
- New alert: a desktop notification when it hits the safety cap or steps back after a send that
  changed nothing. The permission is optional and requested when you turn the switch on.
- Six more tests, 32 in total.

## 1.2.0, 8 November 2026

- Settings moved into the pill. Hover to expand it, then click the gear in its top right corner: the
  plate swaps to a settings view in place, with no popup window over the page. Escape or the back
  arrow returns to the status view, and the pill stays open while you work through the switches.
- The pill shows the six switches, which are the ones you change mid-run. **All settings** opens the
  same UI as a full page, and so does the toolbar icon. Both read and write the same stored values,
  so a change in one place shows up in the other.
- Fixed the collapsed pill's padding. Contents were crowding the left edge; the plate is now inset
  evenly and the gear no longer shifts the count.
- Removed every scrollbar in the extension, and the spin buttons on the number fields. The number
  inputs are `appearance: textfield` with the WebKit inner and outer spin buttons hidden, so Delay
  and Safety cap read as plain fields inside the inset.
- One icon, used everywhere. The toolbar chevrons are recoloured onto a stone plate with the gradient
  kept, drawn once in `scripts/make-icons.py` at 16, 32, 48 and 128 pixels plus an SVG, and used for
  the toolbar, the settings page, its favicon and the landing page.
- New `background.js`, which opens the settings page from the toolbar and relays the picker and reset
  messages to the arena.ai tab. `popup.html` and `popup.js` are gone.
- Seven new tests, twenty six in total: the gear opens settings inside the pill, the status view is
  replaced rather than stacked, the pill carries switches and no dialog, the gear reports its state,
  a switch reaches storage without disturbing the rest, and auto-send off means no send.

## 1.1.1, 8 November 2026

- Fixed the direct download on the landing page. `*.zip` was gitignored, so the file the button
  points at was never committed and the site returned "File wasn't available on site". The build now
  ships `site/baton.zip`, and CI fails if the committed copy drifts from a fresh build.
- The download sheet animates in and out, and respects reduced-motion preferences.
- The on-page pill arrives with a short fade and rise the first time it appears.

## 1.1.0, 8 November 2026

- Fixed the false positive where a limit banner from an earlier turn was answered again. A banner now
  only counts when it is the newest thing in the conversation, when the text has moved on since the
  last send, and when the agent is not visibly working.
- The send is confirmed: if neither the banner clears nor the conversation changes within six
  seconds, the extension holds off for twenty rather than trying again.
- Single flight for sends, so two ticks can never click the same control.
- New target override. Pick the Keep working button on the page, or type a selector or an X and Y
  percentage. The position is stored as a share of the window, so it survives a resize.
- The on-page pill is rebuilt as a plate that expands on hover or keyboard focus, showing the state,
  the last action and the session total.
- The popup checks for a newer release and offers the zip and the notes directly.
- The landing page asks where to download from: this site, or the GitHub release in a new tab.
- Four new tests, nineteen in total.

## 1.0.2, 7 November 2026

- Clears the "Was this task successful?" prompt before sending. The panel covers the message box, so
  the extension now clicks Keep working, waits for the box to come back, and then types.
- New switch, Click Keep working first, on by default.
- The Keep working button is matched by proximity to that panel, so a similar control elsewhere on
  the page is not clicked.
- Four new tests: the prompt flow, the no-prompt case, and the stray-button case.

## 1.0.1, 7 November 2026

- Renamed to Baton. The extension id, storage keys and internal message names changed with it, so
  load the new folder and remove the old unpacked copy.
- Status pill text is plainer: "watching, 4 sent" instead of the old wording.
- Release zip is now `baton.zip`.

## 1.0.0, 7 November 2026

First release.

- Detects the tool-call limit banner on arena.ai/agent and sends one message per banner.
- Reverse text scan so long conversations stay cheap to check.
- Guards: draft protection, tab visibility check, 6 second repeat guard, safety cap of 30 sends.
- Popup with settings, a session counter, and a reset control.
- On-page status pill in the bottom right corner.
- jsdom test suite covering 10 behaviours, including the flicker and contenteditable paths.
