# Changelog

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
