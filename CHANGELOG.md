# Changelog

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
