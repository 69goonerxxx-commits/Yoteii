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
Add an entry at the top of `CHANGELOG` in `about.js`, bump `APP_VERSION`, and bump `CACHE` in `sw.js`.

## Deploy
Push to `main`; `.github/workflows/pages.yml` publishes to GitHub Pages (enable Pages with source "GitHub Actions" in the repo settings).

## Parity tests (used while splitting v2.6.5 into modules)
`python3 tests/parity.py <site-dir> out.json` and `python3 tests/flows.py <site-dir> out.json` load the app in headless Chromium with a fixed clock and fixture data and save what it renders; run them on two versions and compare the JSON to prove nothing changed. `tests/offline.py <site-dir>` checks offline reload.
Needs `pip install playwright` and `playwright install chromium`.
