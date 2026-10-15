// Runs after `npx cap add android`: sets the version number, makes the launcher icons from icon.svg,
// and (later) any manifest changes. Every step reports what it did, and warns instead of failing
// if the generated project looks different from what is expected.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const APP = 'android/app/src/main';
const warn = m => console.warn('WARNING: ' + m);

// ---- version: 3.0.0 -> name "3.0.0", code 3 * 10000 + 0 * 100 + 0, times 1000, plus the build number ----
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const [maj, min, pat] = version.split('.').map(n => parseInt(n, 10) || 0);
const code = (maj * 10000 + min * 100 + pat) * 1000 + Math.min(parseInt(process.env.BUILD_NUMBER || '0', 10) || 0, 999);
{
  const f = 'android/app/build.gradle';
  let g = readFileSync(f, 'utf8'), n = 0;
  g = g.replace(/versionCode\s+\d+/, () => { n++; return 'versionCode ' + code; }).replace(/versionName\s+"[^"]*"/, () => { n++; return 'versionName "' + version + '"'; });
  if (n !== 2) warn('could not set the version in ' + f);
  writeFileSync(f, g);
  console.log(`version ${version}, versionCode ${code}`);
}

// ---- launcher icons, drawn from icon.svg ----
const { default: sharp } = await import('sharp');
const svg = readFileSync('icon.svg', 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const defs = (inner.match(/<defs>[\s\S]*?<\/defs>/) || [''])[0];
const art = inner.replace(defs, '').replace(/<rect[^>]*\/>/g, '');
const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>`;
const foreground = wrap(defs + `<g transform="translate(97.28 97.28) scale(0.62)">${art}</g>`);
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const roundMask = n => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}"><circle cx="${n / 2}" cy="${n / 2}" r="${n / 2}"/></svg>`);
for (const [d, k] of Object.entries(DENSITY)) {
  const dir = `${APP}/res/mipmap-${d}`; mkdirSync(dir, { recursive: true });
  const px = Math.round(48 * k), big = Math.round(108 * k);
  const square = await sharp(Buffer.from(svg), { density: 384 }).resize(px, px).png().toBuffer();
  await sharp(square).toFile(`${dir}/ic_launcher.png`);
  await sharp(square).composite([{ input: roundMask(px), blend: 'dest-in' }]).png().toFile(`${dir}/ic_launcher_round.png`);
  await sharp(Buffer.from(foreground), { density: 384 }).resize(big, big).png().toFile(`${dir}/ic_launcher_foreground.png`);
}
mkdirSync(`${APP}/res/mipmap-anydpi-v26`, { recursive: true });
mkdirSync(`${APP}/res/values`, { recursive: true });
const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n';
writeFileSync(`${APP}/res/mipmap-anydpi-v26/ic_launcher.xml`, adaptive);
writeFileSync(`${APP}/res/mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive);
writeFileSync(`${APP}/res/values/ic_launcher_background.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0A1226</color>\n</resources>\n');
console.log('launcher icons written');

if (!existsSync(`${APP}/AndroidManifest.xml`)) warn('AndroidManifest.xml not found');
