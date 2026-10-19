// Every surface theme with every accent colour must stay readable. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PALS, ACCENTS, contrast, onAccent } from '../util.js';

const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const six = h => /^#[0-9a-f]{3}$/i.test(h) ? '#' + [...h.slice(1)].map(c => c + c).join('') : h;
const vars = (sel, start = sel + '{') => {
  const i = css.indexOf(start); assert.ok(i >= 0, 'missing css block ' + sel);
  const body = css.slice(i + start.length, css.indexOf('}', i));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9]+):([^;]+)/g)].map(m => [m[1], six(m[2].trim())]));
};
const dark = Object.assign({ bg:'#1c1c1e' }, vars(':root', ':root{--bg:#1c1c1e;')), light = vars(':root[data-theme=light]');
const surface = p => Object.assign({}, p.base === 'light' ? light : dark, p.id === 'dark' || p.id === 'light' ? {} : vars(':root[data-pal=' + p.id + ']'));

for (const p of PALS){
  const S = surface(p);
  test(p.name + ': text is readable on its surfaces', () => {
    assert.ok(contrast(S.text, S.bg) >= 7, 'text on bg ' + contrast(S.text, S.bg).toFixed(2));
    assert.ok(contrast(S.text, S.card) >= 7, 'text on card');
    assert.ok(contrast(S.sec, S.bg) >= 4.5, 'secondary on bg ' + contrast(S.sec, S.bg).toFixed(2));
    assert.ok(contrast(S.sec, S.card) >= 4.2, 'secondary on card ' + contrast(S.sec, S.card).toFixed(2));
  });
  for (const a of ACCENTS){
    test(p.name + ' + ' + a.name + ': the accent is readable', () => {
      const hex = p.base === 'light' ? a.light : a.dark;
      assert.ok(contrast(hex, S.bg) >= 3, 'accent on bg ' + contrast(hex, S.bg).toFixed(2));
      assert.ok(contrast(hex, S.card) >= 3, 'accent on card ' + contrast(hex, S.card).toFixed(2));
      assert.ok(contrast(onAccent(hex), hex) >= 4.5, 'text on accent ' + contrast(onAccent(hex), hex).toFixed(2));
    });
  }
}
test('every surface theme has a css block, and ids are unique', () => {
  assert.equal(new Set(PALS.map(p => p.id)).size, PALS.length);
  assert.equal(new Set(ACCENTS.map(a => a.id)).size, ACCENTS.length);
});
