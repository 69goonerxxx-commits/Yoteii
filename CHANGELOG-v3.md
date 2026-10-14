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
- Backup import check: backups containing the backup-reminder date, or the older wake-time format, were wrongly refused by the Phase 2 check. Fixed, and empty fields no longer cause a refusal.
- Icon guessing: no more wrong icons from letters inside words ("Start work" and "Party" no longer get the palette icon; headphones get the headphones icon; "Chart" gets the chart icon). Removed rules that could never apply.

## Storage
- Your data now lives in IndexedDB instead of localStorage: far more room, and saves are batched and flushed whenever the app is hidden or closed.
- On first launch your existing v2 data is copied over automatically. The old copy is left untouched and never read again.
- Automatic snapshots: once a day (first launch) and before every import, the last 7 are kept on the device. Settings, Backup, Snapshots lists them and can restore one (the current data is snapshotted first).
- Several open tabs or windows stay in sync.
- If IndexedDB isn't available, the app falls back to localStorage like v2 (no snapshots in that case).
- Clear data now also removes snapshots.

## Dates and backups
- Days are now stored as `2026-10-11` instead of `Sun Oct 11 2026`. They sort correctly and no longer depend on how the browser parses a date string.
- Existing data is converted automatically on first launch. A snapshot of the old data ("Before the update") is kept first.
- Backups are now version 3. Backups made by v2.6.5 still import and are converted on the way in. A v3 backup cannot be loaded by v2.6.5.
- Restoring a snapshot taken before the update converts it as well.

## Still planned
- Android app build with native reminders.
