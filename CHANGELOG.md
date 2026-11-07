# Changelog

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
