# Yotei v3.0.3 (3.0.0 notes below)

Released as 3.0.0 (Oct 2026). The user-facing version of this list is the 3.0.0 entry in `about.js`.

## 3.0.3
- Header space: Capacitor padded the WebView below the status bar and also injected the same inset as a CSS variable, so the page added it a second time (an empty band above the title that vanished on scroll). SystemBars now uses insetsHandling "native" with viewport-fit cover hinted, so the CSS reads the inset only when the WebView really is edge to edge. The header sticks at the inset, with a strip in the page colour behind the status bar.
- Keyboard: while a text field is focused and the viewport has shrunk, body gets class kb: the tab bar, + button and week strip hide, and the field scrolls to the centre of what is left.

## 3.0.2
- Android reminders: scheduled with the phone (Capacitor Local Notifications) for today and the next two days, replanned whenever the screen changes or the app is opened. They fire with the app closed and are restored after a restart. Permission prompt, exact-timing setting and a test button are in Settings.
- In-app dialogs: all 20 browser confirm() and alert() popups are replaced by ask() and tell() in main.js and a msgDlg in index.html. Destructive buttons are red, Cancel is focused on questions, Esc and the Android back button count as Cancel. tests/flows.py accepts the new dialog automatically.
- Startup error panel: plain "Something went wrong" message with Export my data, Reload, Details and a dismiss button, replacing the red technical box. Export reads the saved data directly, so it works even if main.js never started, and uses the same file format and share sheet as Settings > Export. A missing app file is named in Details.
- Poppins bundled into styles.css (latin, weights 400 to 700). No Google Fonts request.
- Wording: "on this device" in the app, "in this browser" on the web.
- The Buffer time task is gone. Spare time before a departure is free time, and the message says so.
- New test (html-ids) fails if main.js asks for an element index.html does not have.

## 3.0.1
- Saves now start straight away. A change made in the last instant before the app closed or reloaded could be lost (measured: 60 of 60 in the worst case, now 0 of 60).
- Android app groundwork: Capacitor project and GitHub build, backups through the Android share sheet, back button handling, status and navigation bar spacing, no service worker inside the app.

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

## Timeline and editor
- The timeline sits about 12px further left (icons, text and the vertical line). The tick buttons stay where they were.
- Free time is now shown everywhere it exists: before the first task, between tasks, after the last task, and for blocks with no tasks. Each gap has a broken line, a "free" label and an always-visible "+ Add task" that opens the editor at that time. Gaps under 5 minutes are not shown. Past days (saved records) show gaps without the add button.
- End time first: set an End time and Yotei counts back from it using the length (6:00 AM and 20 minutes gives a 5:40 AM start). The End stays put when the length changes. Typing a Start works as before.
- Editor error messages no longer vanish the moment they appear (the old "add a start time" message was hidden instantly).
- Day types: a task can be added to Home, School, Away, any two, or all three. One copy is saved per type, linked together. Editing a linked task updates every copy, and ticking or unticking a type adds or removes that copy. "Only this day" ignores the types. Morning and night routine tasks are unchanged.
- Icon picking: a cloud icon that is still downloading can no longer land on a different task later. The tile shows a loading state, gives up after 8 seconds with a message, and works out when offline.
- Toasts: wider, centered, above the round + button. They can no longer stay on screen (timestamp safety net), and tapping one dismisses it. Moving to another screen clears an older one.
- Delete always works: tasks with no id, a number as an id or a duplicate id are repaired at startup, a task filed in the wrong list is found, and deleting one that no longer exists just completes. On a past day, deleting removes the task from that day's saved record (with Undo). The "no longer in your routines" message now offers "Delete it".
