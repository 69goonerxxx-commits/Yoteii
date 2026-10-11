# Yotei v3: changes so far (draft)

The in-app version stays 2.6.5 until v3 is released. When it ships: add an entry at the top of `CHANGELOG` in `about.js`, bump `APP_VERSION`, bump `CACHE` in `sw.js`.

## Under the hood
- Split the single 3,300-line file into modules (`engine.js`, `icons.js`, `validate.js`, `styles.css`, and more). No change in behavior, checked against v2.6.5.
- Scheduling engine is now a separate, tested module.
- App icons added (the install and notification icons were missing).
- A red error box now appears if the app fails to start, naming what failed.

## Fixes
- Saving: if storage is full or blocked, the app now says so and offers a backup. Before, it failed silently.
- Backups: importing now checks every part of the file and refuses damaged or newer-version backups with a reason, leaving your data untouched.
- Reset routine: now undoable for a few seconds. The warning text no longer says it can't be undone.
- Icon guessing: no more wrong icons from letters inside words ("Start work" and "Party" no longer get the palette icon; headphones get the headphones icon; "Chart" gets the chart icon). Removed rules that could never apply.

## Still planned
- Dates keyed in ISO format, with data migration from v2.
- Move storage to IndexedDB with automatic local snapshots.
- Android app build with native reminders.
