// Fails if main.js asks for an element that index.html does not have (the crash that stopped the app from starting).
// Works whether the tests sit in a tests/ folder or beside the app files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const file = name => new URL(existsSync(new URL('../' + name, import.meta.url)) ? '../' + name : './' + name, import.meta.url);
const html = readFileSync(file('index.html'), 'utf8'), js = readFileSync(file('main.js'), 'utf8');

test('every element main.js looks up by id exists in index.html or is built by main.js', () => {
  const wanted = new Set([
    ...[...js.matchAll(/(?:\$|\$\$|querySelector)\(\s*['"]#([\w-]+)/g)].map(m => m[1]),
    ...[...js.matchAll(/getElementById\(\s*['"]([\w-]+)/g)].map(m => m[1]),
  ]);
  const inHtml = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const inJs = new Set([...js.matchAll(/id=\\?["']([\w-]+)\\?["']/g)].map(m => m[1]));
  const missing = [...wanted].filter(id => !inHtml.has(id) && !inJs.has(id));
  assert.deepEqual(missing, [], 'main.js needs these ids, but index.html does not have them: ' + missing.join(', '));
});

test('no id appears twice in index.html', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});
