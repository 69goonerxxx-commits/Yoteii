// Unit tests for the scheduling engine. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, applyOvr, typeOfIn, isoLocal } from '../src/engine.js';

const WIN = { sleep:{from:0}, climb1:{from:60}, peak:{from:180}, trough:{from:360}, climb2:{from:480}, wmz:{from:720}, wind:{from:900} };
const fmt = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; const h = Math.floor(m / 60), mm = m % 60; return [((h + 11) % 12 + 1) + ':' + String(mm).padStart(2, '0'), h < 12 ? 'AM' : 'PM']; };
const mk = (o = {}) => {
  const blocks = { pre: [], night: [], home: [], school: [], away: [], ...(o.blocks || {}) };
  const MODES = { home:{deadline:null,msg:'home',post:blocks.home}, school:{deadline:360,post:blocks.school}, away:{deadline:null,msg:'away',post:blocks.away}, none:{deadline:null,msg:'none',post:[]} };
  const day = { date:'Sun Oct 11 2026', types:{ climb1:'home' }, oneoffs:[], shift:null, ...(o.day || {}) };
  return { dow:0, wake:300, day, CAP:{ soft:1320, hard:1380 }, MODES, WIN, OV:{}, wins:() => WIN, fmt, getBlocks: l => l === 'oo' ? day.oneoffs : blocks[l] || [], ...o.ctx };
};
const task = (id, d, p, extra = {}) => ({ id, t:id, d, p, ...extra });

test('an empty day produces no rows', () => {
  assert.deepEqual(buildSchedule(mk()).rows, []);
});

test('early start before a deadline adds a buffer', () => {
  const r = buildSchedule(mk({ day:{ types:{ climb1:'school' } }, blocks:{ pre:[task('a', 30, 'core', { m:10 }), task('b', 15, 'flex', { m:5 })] } }));
  assert.equal(r.msg, 'Early start: 15 min of buffer added before you leave at 6:00 AM.');
  assert.equal(r.rows.at(-1).id, 'buf');
  assert.equal(r.rows.at(-1).use, 15);
});

test('late start shrinks optional first, then flexible, then core', () => {
  const pre = [task('core', 10, 'core', { m:5 }), task('flex', 20, 'flex', { m:10 }), task('opt', 15, 'opt', { m:5 })];
  const r = buildSchedule(mk({ ctx:{ wake:330 }, day:{ types:{ climb1:'school' } }, blocks:{ pre } }));
  const use = Object.fromEntries(r.rows.map(x => [x.id, x.use]));
  assert.deepEqual(use, { core:10, flex:15, opt:5 });
  assert.equal(r.tone, 'warn');
  assert.equal(r.msg, 'Late start: routine shortened by 15 min so you can leave at 6:00 AM.');
});

test('too late even at minimum lengths is reported as bad', () => {
  const r = buildSchedule(mk({ ctx:{ wake:350 }, day:{ types:{ climb1:'school' } }, blocks:{ pre:[task('a', 30, 'core', { m:20 })] } }));
  assert.equal(r.tone, 'bad');
  assert.match(r.msg, /over\. Wake earlier or trim the routine\.$/);
});

test('a fixed-time task stays put and warns when earlier tasks run past it', () => {
  const home = [task('A', 120, 'fixedlen', { w:'climb1' }), task('B', 30, 'fixedlen', { w:'climb1', fixed:360 })];
  const r = buildSchedule(mk({ blocks:{ home } }));
  const B = r.rows.find(x => x.id === 'B');
  assert.equal(B.start, 360);
  assert.equal(r.tone, 'bad');
  assert.match(r.msg, /run past its 6:00 AM start/);
});

test('night routine shrinks to finish before the hard cap', () => {
  const night = [task('wash', 30, 'core', { m:10 }), task('read', 60, 'opt', { m:0 })];
  const r = buildSchedule(mk({ blocks:{ night }, ctx:{ CAP:{ soft:1320, hard:1260 } } }));
  const read = r.rows.find(x => x.id === 'read');
  assert.equal(read.use, 30);
  assert.equal(r.rows.find(x => x.id === 'wash').use, 30);
});

test('"running late" shift pushes later tasks', () => {
  const home = [task('A', 30, 'fixedlen', { w:'climb1' }), task('B', 30, 'fixedlen', { w:'climb1' })];
  const base = buildSchedule(mk({ blocks:{ home } })).rows.find(x => x.id === 'B').start;
  const shifted = buildSchedule(mk({ blocks:{ home }, day:{ shift:{ from:300, by:30 } } })).rows.find(x => x.id === 'B').start;
  assert.equal(shifted - base, 30);
});

test('overrides can patch or remove a task for a date range', () => {
  const b = { id:'x', t:'Walk', d:20 };
  const OV = { x:[{ from:'2026-10-10', to:'2026-10-12', patch:{ d:45 } }] };
  assert.equal(applyOvr(b, OV, '2026-10-11', 0, 'home').d, 45);
  assert.equal(applyOvr(b, OV, '2026-10-20', 0, 'home').d, 20);
  assert.equal(applyOvr(b, { x:[{ patch:null }] }, '2026-10-11', 0, 'home'), null);
});

test('typeOfIn falls back to the nearest earlier window', () => {
  assert.equal(typeOfIn({ climb1:'home' }, 'peak', WIN), 'home');
  assert.equal(typeOfIn({}, 'peak', WIN), null);
});

test('isoLocal formats local dates as YYYY-MM-DD', () => {
  assert.equal(isoLocal(new Date(2026, 9, 11)), '2026-10-11');
});
