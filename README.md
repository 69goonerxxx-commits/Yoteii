# Yotei

A daily schedule that flows from your wake time. Installable web app (PWA), no build step, no dependencies.

## Run locally
`npm start` (or any static server, e.g. `python3 -m http.server 8080`) and open http://localhost:8080.
ES modules need a server; opening index.html directly from disk will not work.

## Layout
- Everything the app needs sits in the top-level folder (no subfolders), so it can be uploaded to GitHub from a phone.
- `index.html`: page shell
- `main.js`: app logic (being split into smaller modules)
- `engine.js`: the scheduling engine (pure functions, unit tested)
- `icons.js`, `about.js`, `templates.js`, `science.js`, `util.js`: extracted modules
- `styles.css`: all styles
- `icon.svg`, `icon-*.png`: app icons
- `sw.js`: service worker (offline cache). Bump `CACHE` on every release.
- `tests/`: `engine.test.mjs` (run with `npm test`, no installs needed) and browser parity checks (Python + Playwright), see below

## If the app looks broken
A red box at the bottom of the screen names the file that failed to load, or the error that stopped the app. Screenshot it.

## Releasing
Add an entry at the top of `CHANGELOG` in `about.js`, bump `APP_VERSION`, bump `version` in `package.json`, and bump `CACHE` in `sw.js` (a new cache name is what makes installed copies update).

## Deploy
Push to `main`; `.github/workflows/pages.yml` publishes to GitHub Pages (enable Pages with source "GitHub Actions" in the repo settings).

## Android app
The Android app is this same web app inside a Capacitor shell. GitHub builds it; nothing is installed locally.
- `capacitor.config.json`: app id (`app.yotei`), name and web folder.
- `build-www.mjs`: gathers the web files into `www/`.
- `android-prepare.mjs`: sets the version and makes the launcher icons from `icon.svg`.
- `.github/workflows/android.yml`: builds the APK and puts it on the Releases page (Actions, Android APK, Run workflow).
- Signing: add two repository secrets, `KEYSTORE_B64` and `KEYSTORE_PASSWORD`, and every build installs over the last one. Without them the build is debug-signed and cannot be updated in place.
- The Android app keeps its own data (separate from the website). Use Export, then Import to move data across.

## Parity tests (used while splitting v2.6.5 into modules)
`python3 tests/parity.py <site-dir> out.json` and `python3 tests/flows.py <site-dir> out.json` load the app in headless Chromium with a fixed clock and fixture data and save what it renders; run them on two versions and compare the JSON to prove nothing changed. `tests/offline.py <site-dir>` checks offline reload.
Needs `pip install playwright` and `playwright install chromium`.
