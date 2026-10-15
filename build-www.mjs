// Collects the web app's files into www/, which is what the Android app bundles.
// Run with: node build-www.mjs
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';

const SKIP = /^(capacitor\.config|build-www|android-prepare)/;
const WANT = /^(index\.html|manifest\.webmanifest|styles\.css|icon.*\.(png|svg)|.*\.js)$/;

rmSync('www', { recursive: true, force: true });
mkdirSync('www');
const copied = [];
for (const f of readdirSync('.')) {
  if (!statSync(f).isFile() || SKIP.test(f) || !WANT.test(f)) continue;
  cpSync(f, 'www/' + f); copied.push(f);
}

// Every module the app imports must have been copied, or the app would not start.
let missing = 0;
for (const f of copied.filter(x => x.endsWith('.js'))) {
  for (const m of readFileSync('www/' + f, 'utf8').matchAll(/(?:import|from)\s*(?:[^'"]*?from\s*)?['"]\.\/([\w.-]+\.js)['"]/g)) {
    if (!existsSync('www/' + m[1])) { console.error(`${f} imports ${m[1]}, which is missing`); missing++; }
  }
}
if (!existsSync('www/index.html')) { console.error('index.html is missing'); missing++; }
if (missing) process.exit(1);
console.log(`www/ ready: ${copied.length} files`);
