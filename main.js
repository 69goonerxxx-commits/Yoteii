import { esc } from './util.js';
import { validateBackup } from './validate.js';
import { store, initStore, info, onStoreError, replaceAll, clearAll, estimateBytes, makeSnapshot, snapshotIfDue, listSnapshots, restoreSnapshot } from './storage.js';
import { applyOvr, typeOfIn, buildSchedule } from './engine.js';
import { isoLocal, parseDay, dowOf, cmpDay } from './dates.js';
import { migrateDates, needsDateMigration, DATE_FMT } from './migrate.js';
import { guessIcon, ICONS, iconMarkup, ICON_GROUPS, ICON_TAGS } from './icons.js';
import { APP_VERSION, FEATURES, LIMITS, CHANGELOG } from './about.js';
import { TPL } from './templates.js';
import { BLOCK_INFO, SCI_SRC, PRESS_PTS, CIRC_PTS } from './science.js';
// ============================================================
// YOTEI — script map (search for the header text to jump)
//   STORAGE & CONFIG            SEED DATA
//   APP STATE                   TIME HELPERS
//   SCHEDULING ENGINE           ICONS, COLOR, DOT SIZE/FILL
//   WINDOW-BLOCK EDITOR         DATA ACCESS & MIGRATION
//   TASK EDITOR                 TASK DETAIL SHEET
//   SUBTASK SHEET               HISTORY & TRENDS TABS
//   MAIN RENDER LOOP            NOW BANNER, CHIME, CLOCK
//   IMPORT / EXPORT / RESET     GESTURES
//   TABS & INIT
// ============================================================
// ============================================================
// STORAGE & CONFIG
// ============================================================
const $ = s => document.querySelector(s);
await initStore();   // load everything saved on this device before the app starts
await upgradeDates();
// v2 stored days as "Sun Oct 11 2026"; v3 uses "2026-10-11". Converted once, with a snapshot of the old data kept first.
async function upgradeDates(){
  if (store.get('dateFmt', null) === DATE_FMT) return;
  const data = store.dump();
  if (Object.keys(data).length){
    try{ await makeSnapshot('before-upgrade'); }catch{}
    const next = migrateDates(data);
    try{ await replaceAll(next); }
    catch{ Object.entries(next).forEach(([k, v]) => store.setRaw(k, v)); }   // couldn't save in one step: carry on in memory, the app warns and retries on the next launch
  }
  store.set('dateFmt', DATE_FMT);
}
// Saving can fail (storage full, or blocked in private mode). Say so, at most once every 15 seconds, and offer a backup.
let lastSaveWarn = 0;
function storeFailed(){
  const now = Date.now(); if (now - lastSaveWarn < 15000) return; lastSaveWarn = now;
  if (document.getElementById('toastMsg')) toast("Couldn't save your changes. Storage may be full or blocked. Back up now so nothing is lost.", 'Back up', exportData);
}
onStoreError(() => storeFailed());
snapshotIfDue().catch(() => {});   // first launch of the day: keep a snapshot of how things were
const DEF_WAKE = 300;                      // 5:00 AM, in minutes after midnight
const CAP = Object.assign({ soft: 22*60, hard: 23*60 }, store.get('caps', {}));  // defaults 10 PM soft, 11 PM hard; editable in Settings

// Shrink order when the morning runs late: opt -> flex -> core. Each block can shrink down to m (min minutes).
// ============================================================
// SEED DATA — built-in defaults, used until the user edits a list
// (see getBlocks/setBlocks below for how overrides replace these)
// ============================================================
const PRE = [];   // no built-in tasks: you add your own
const NIGHT = [];
const WORKOUT_DAYS = [1,4,6];  // Mon/Thu/Sat: certain, every week
const REST_DAYS = [0,2,3,5];   // Sun/Tue/Wed/Fri: Sunday is a fixed rest day; Tue/Wed/Fri default to rest until the week-1-2 vs week-3+ rotation is set up
const MODES = {
  home: { deadline:null, msg:'No fixed departure. The day flows from your wake time.', post:[]},
  school: { deadline:6*60, post:[]},
  away: { deadline:null, msg:'Set the wake time for where you are and everything shifts with it.', post:[] }
};

const WIN = {
  sleep:{ name:'Morning routine', from:0, to:60, note:'Sleep inertia: grogginess usually fades over the first hour or so.' },
  climb1:{ name:'First Climb', from:60, to:180, note:'Alertness tends to climb toward a first peak. Outdoor light can help.' },
  peak:{ name:'Sustained Peak', from:180, to:360, note:'For many people this is a strong focus window.' },
  trough:{ name:'Trough', from:360, to:480, note:'Many people dip after lunch. Alertness often drops.' },
  climb2:{ name:'Second Climb', from:480, to:720, note:'Often a second peak, sometimes as strong as the morning one.' },
  wmz:{ name:'Wake Maintenance Zone', from:720, to:900, note:'Many people find it hard to fall asleep here, and naps tend not to help.' },
  wind:{ name:'Night Routine', from:900, to:1080, note:'The same every night. Slow down and get ready for sleep.' }
};
const MODE_NAME = { home:'at home', school:'at school', away:'away' };
MODES.none = { deadline:null, msg:'Choose where you are for First Climb below to see the rest of the day. The morning routine is the same for every type.', post:[] };
Object.values(MODES).forEach(M => M.post.forEach(b => { b.w = b.w || 'climb1'; }));
// ============================================================
// APP STATE — in-memory + localStorage-backed
// ============================================================
let mode = null;
let wake = store.get('wake', DEF_WAKE);
if (typeof wake !== 'number') wake = (wake && wake.home) || DEF_WAKE;
let done = null, day = null, plans = store.get('plans', {});
let openState = store.get('open', {});
let editing = false, cur = null, edDays = [];
let noteEditing = null;
const todayStr = () => isoLocal(new Date());
let viewDate = todayStr();
loadDay(viewDate);
function defWake(){ const w = store.get('wake', DEF_WAKE); return typeof w === 'number' ? w : ((w && w.home) || DEF_WAKE); }
function planFor(ds){
  if (plans[ds]) return plans[ds];
  const L = store.get('day', null), D = store.get('done', null);
  if (L && L.date === ds && L.types) return { w:defWake(), d:(D && D.date === ds ? D.ids : []), t:L.types, a:!!L.away, n:L.note || '' };
  const h = ds < todayStr() ? store.get('hist', {})[ds] : null;
  if (h) return { w:h.wake, d:(h.rows || []).filter(r => r.done).map(r => r.id), t:h.types || {}, a:false, n:h.note || '' };
  return null;
}
function loadDay(ds){
  const p = planFor(ds);
  wake = p ? p.w : defWake();
  done = { date:ds, ids:p ? (p.d || []).slice() : [] };
  day = { date:ds, types:p ? { ...(p.t || {}) } : usualTypes(ds), away:p ? !!p.a : false, note:p ? (p.n || '') : '', oneoffs:p && p.o ? p.o.slice() : [], live:!!(p && p.l), shift:p && p.s ? p.s : null };
  if (p && p.p) day.prevTypes = p.p;
}
function saveDay(){
  plans[viewDate] = { w:wake, d:done.ids, t:day.types, a:!!day.away, n:day.note || '', p:day.prevTypes || null, o:day.oneoffs || [], l:!!day.live, s:day.shift || null };
  const ks = Object.keys(plans).sort(cmpDay);
  while (ks.length > 200) delete plans[ks.shift()];
  store.set('plans', plans);
  if (viewDate === todayStr()) store.set('wake', wake);
  if (viewDate <= todayStr()) saveHist();
}
function goDate(ds){ viewDate = ds; noteEditing = null; loadDay(ds); render(); }
const shownNotes = new Set();
function noteKey(id){ return viewDate + '_' + id; }
function getNote(id){ return store.get('taskNotes', {})[noteKey(id)] || ''; }
function setNote(id, txt){
  const nm = store.get('taskNotes', {}), k = noteKey(id);
  if (txt) nm[k] = txt; else delete nm[k];
  store.set('taskNotes', nm);
}


// ============================================================
// TIME HELPERS
// ============================================================
let CLOCK24 = store.get('clock', '12') === '24';
function fmt(m){
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(m/60), mm = m % 60;
  if (CLOCK24) return [String(h).padStart(2,'0') + ':' + String(mm).padStart(2,'0'), ''];
  return [((h+11)%12+1) + ':' + String(mm).padStart(2,'0'), h < 12 ? 'AM' : 'PM'];
}
function range(a, b){
  const x = fmt(a), y = fmt(b);
  return (x[1] === y[1] ? x[0] : x[0]+' '+x[1]) + ' – ' + y[0] + ' ' + y[1];
}
function mondayOf(ds){
  const d = parseDay(ds), wd = d.getDay(), diff = (wd === 0 ? -6 : 1 - wd);
  const m = new Date(d); m.setDate(d.getDate() + diff); return m;
}
function winFor(clock, wk){
  const WB = wins(), n = clock - (wk === undefined ? wake : wk), keys = Object.keys(WB); if (n < 0) return 'sleep';
  let w = keys[0]; for (const k of keys) if (n >= WB[k].from) w = k; return w;
}
const toVal = m => String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');

// ============================================================
// SCHEDULING ENGINE — turns blocks + wake time into timed rows
// NOTE: window from/to are labels, not hard constraints — a task
// can run past its window's nominal end (see the 'runs past
// window end' tag in rowHtml, and isNowW's overflow-aware check).
// ============================================================
function build(dow){
  dow = dow === undefined ? new Date().getDay() : dow;
  return buildSchedule({ dow, wake, day, CAP, MODES, WIN, OV: store.get('ovr', {}), getBlocks, wins, fmt });
}

const nowM = () => { const d = new Date(); return d.getHours()*60 + d.getMinutes(); };
// ============================================================
// ICONS, COLOR, DOT SIZE/FILL — visual helpers for the timeline
// ============================================================
const MODE_LABEL = { home:'Home', school:'School', away:'Away' };
function onColor(c){
  const m = /^#([0-9a-f]{6})$/i.exec((c || '').trim()); if (!m) return '#fff';
  const v = [0, 2, 4].map(i => { const x = parseInt(m[1].substr(i, 2), 16) / 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); });
  return (.2126 * v[0] + .7152 * v[1] + .0722 * v[2]) > .3 ? '#06121f' : '#fff';
}
const DOT_W = 56;
function dotHeight(use){
  const BASE = 56, MAX = 150, CAP_AT = 120; // minutes at which height maxes out
  if (!use || use <= 10) return BASE;
  const t = Math.min(1, (use - 10) / (CAP_AT - 10));
  return Math.round(BASE + t * (MAX - BASE));
}
function fracFor(r, NM){
  if (r.start === undefined || r.end === undefined || r.end <= r.start) return NM >= (r.start || 0) ? 1 : 0;
  if (NM <= r.start) return 0;
  if (NM >= r.end) return 1;
  return (NM - r.start) / (r.end - r.start);
}
function buildSpine(){
  const wrap = document.querySelector('#tl .tlwrap'); if (!wrap) return;
  wrap.querySelectorAll('.tlseg,.tlspine').forEach(e => e.remove());
  const wr = wrap.getBoundingClientRect(), GRAY = 'var(--graydot)', nodes = [], sc = (wr.width / (wrap.offsetWidth || wr.width)) || 1;   // sc corrects for large-text zoom
  const okc = c => (c && CSS.supports('color', c)) ? String(c).trim() : GRAY;
  Array.from(wrap.children).forEach(el => {
    if (el.matches('.gap') && nodes.length){ nodes[nodes.length - 1].gap = true; return; }
    if (!el.matches('.blk,.tlhead')) return;
    const dot = el.querySelector('.tldot'); if (!dot) return;
    const r = dot.getBoundingClientRect(), f = parseFloat(el.dataset.f);
    nodes.push({ c:okc(el.dataset.c), f:isFinite(f) ? f : 0, top:(r.top - wr.top) / sc, bottom:(r.bottom - wr.top) / sc, x:(r.left - wr.left + r.width / 2) / sc });
  });
  const oklab = CSS.supports('background-image', 'linear-gradient(in oklab to bottom, red, blue)') ? 'in oklab ' : '';
  for (let k = 0; k < nodes.length - 1; k++){
    const a = nodes[k], b = nodes[k + 1];
    const from = a.f >= 1 ? a.c : GRAY, to = b.f > 0 ? b.c : GRAY, top = a.bottom - 3, h = b.top - a.bottom + 6;
    if (h <= 0) continue;
    const seg = document.createElement('i'); seg.className = 'tlseg' + (a.gap ? ' dash' : '');
    seg.style.cssText = 'left:' + (a.x - 2) + 'px;top:' + top + 'px;height:' + h + 'px;background:' + (from.toLowerCase() === to.toLowerCase() ? from : 'linear-gradient(' + oklab + 'to bottom,' + from + ' 0%,' + from + ' 16%,' + to + ' 84%,' + to + ' 100%)');
    wrap.appendChild(seg);   // appended last: inserting it first would flip .tlhead:first-child and shift everything 10px
  }
}
window.addEventListener('resize', buildSpine);
if (document.fonts) document.fonts.addEventListener('loadingdone', buildSpine);
if (window.ResizeObserver) new ResizeObserver(() => buildSpine()).observe(document.getElementById('tl'));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildSpine);
function dotFillHtml(iconKey, color, frac, h){
  h = h || 56;
  const cov = Math.round(Math.max(0, Math.min(1, (frac * h - (h - 28) / 2) / 28)) * 100), svg = ICONS[iconKey];
  return svg ? '<span class="dotIconWrap"><span class="dotIconTop" style="clip-path:inset(0 0 ' + (100 - cov) + '% 0);color:' + onColor(color) + '">' + svg + '</span><span class="dotIconBot" style="clip-path:inset(' + cov + '% 0 0 0);color:' + color + '">' + svg + '</span></span>' : '<span class="dotIconPlain">' + esc(iconKey) + '</span>';
}
function dotBg(color, frac){
  if (frac <= 0) return 'var(--dotbg)';
  if (frac >= 1) return color;
  const p = frac * 100;
  return 'linear-gradient(180deg,' + color + ' 0%,' + color + ' ' + Math.max(0, p - 28).toFixed(1) + '%,var(--dotbg) ' + Math.min(100, p + 12).toFixed(1) + '%)';
}
const COLOR_SWATCHES = ['#f59e0b','#fbbf24','#facc15','#38bdf8','#fb7185','#a78bfa','#6366f1','#22c55e','#f97316','#eef2ff'];
const WIN_STYLE = {
  sleep:{ c:'#f59e0b', i:'sun' }, climb1:{ c:'#fbbf24', i:'sun' }, peak:{ c:'#facc15', i:'sun' },
  trough:{ c:'#38bdf8', i:'cloud' }, climb2:{ c:'#fb7185', i:'sunset' }, wmz:{ c:'#a78bfa', i:'cloud' }, wind:{ c:'#6366f1', i:'moon' }
};
function typeOf(k){ return typeOfIn(day.types, k, WIN); }
function schedule(){
  const sn = snapRows();
  if (sn) return { rows:sn, msg:'Saved record of this day. Edit anything and it rebuilds from your current routines.', tone:'ok' };
  return build(parseDay(viewDate).getDay());
}
function pickType(k, m){ needLive(); day.types[k] = m; saveDay(); render(); }
// ============================================================
// WINDOW-BLOCK EDITOR (the settings dialog for one window)
// ============================================================
const CHRONO = { early:-30, normal:0, late:45 };
const winBase = k => { const sh = CHRONO[store.get('chrono', 'normal')] || 0; return { ...WIN[k], ...(k === 'sleep' ? {} : { from:WIN[k].from + sh, to:WIN[k].to + sh }) }; };
const wins = () => {
  const o = store.get('wins', {}), W = store.get('wovr', {}), r = {};
  for (const k in WIN) r[k] = { ...winBase(k), ...(o[k] || {}) };
  if (day && day.date){
    const iso = day.date, dow = dowOf(day.date);
    for (const k in W) (W[k] || []).forEach(e => {
      if (!r[k] || (e.from && iso < e.from) || (e.to && iso > e.to) || (e.days && !e.days.includes(dow))) return;
      Object.keys(e.patch).forEach(f => { if (e.patch[f] === null) delete r[k][f]; else r[k][f] = e.patch[f]; });
    });
  }
  return r;
};
function openBlockEd(k){
  const W = wins()[k];
  cur = { l:'win', id:k, w:k, wk:k };
  $('#ed').dataset.mode = 'win'; $('#e_title').innerHTML = 'Edit <em>Block</em>';
  $('#e_tlab').textContent = 'Block name'; $('#e_dlab').textContent = 'Note';
  $('#e_t').value = W.name; $('#e_icon').value = W.icon || WIN_ICON_DEF[k]; updateIconBtn();
  $('#e_color').value = W.color || ''; CT = 'e'; drawColorRow('e'); setEdAccent();
  $('#e_bs').value = toVal(wake + W.from); $('#e_be').value = toVal(wake + W.to);
  $('#e_details').value = W.note || '';
  $('#e_wrap').style.display = 'none';
  $('#e_del').textContent = 'Reset'; $('#e_del').style.display = '';
  ['e_up', 'e_dn'].forEach(i => { $('#' + i).style.display = 'none'; });
  $('#ed').showModal(); $('#ed .ef').scrollTop = 0;
}
function saveWinBlock(name){
  const k = cur.id, a = ($('#e_bs').value || '00:00').split(':').map(Number), z = ($('#e_be').value || '00:00').split(':').map(Number);
  let from = a[0] * 60 + a[1] - wake, to = z[0] * 60 + z[1] - wake; if (from < 0) from += 1440; if (to < 0) to += 1440;
  if (to <= from){ edErr('A block has to end after it starts.'); return; }
  const o = wins()[k];
  askScope('edit', { l:'win', id:k,
    b:{ name, note:$('#e_details').value.trim(), color:$('#e_color').value || null, icon:$('#e_icon').value.trim() || WIN_ICON_DEF[k], from, to },
    old:{ name:o.name, note:o.note || '', color:o.color || null, icon:o.icon || WIN_ICON_DEF[k], from:o.from, to:o.to } });
}
// ============================================================
// DATA ACCESS & MIGRATION
// schemaV gates one-time migrations; bump it if you add another.
// ============================================================
const clone = a => JSON.parse(JSON.stringify(a));
function migrateFields(){
  if (store.get('schemaV', 0) >= 1){ return; }
  const blocks = store.get('blocks', null);
  if (blocks){
    let changed = false;
    for (const l in blocks){
      const arr = blocks[l];
      if (!Array.isArray(arr)) continue;
      for (const b of arr){
        if (b && b.s !== undefined){
          if (!b.details) b.details = b.s;
          delete b.s;
          changed = true;
        }
      }
    }
    if (changed) store.set('blocks', blocks);
  }
  store.set('schemaV', 1);
}
function getBlocks(l){
  if (l === 'oo') return day.oneoffs || [];
  const b = store.get('blocks', null);
  return b && b[l] ? b[l] : (l === 'pre' ? PRE : l === 'night' ? NIGHT : MODES[l].post);
}
function setBlocks(l, arr){ if (l === 'oo'){ day.oneoffs = arr; saveDay(); return; } const b = store.get('blocks', null) || {}; b[l] = arr; store.set('blocks', b); }
// ============================================================
// TASK EDITOR (the main add/edit-task dialog, #ed)
// ============================================================
function drawDays(){
  $('#e_days').innerHTML = ['Su','Mo','Tu','We','Th','Fr','Sa'].map((n, i) => '<button type="button" data-i="' + i + '"' + (edDays.includes(i) ? ' class="on"' : '') + '>' + n + '</button>').join('');
}
function effBlock(l, b){
  if (!b || l === 'oo') return b;
  const m1 = typeOf('climb1'), dm = m1 || Object.values(day.types || {})[0] || null;
  return applyOvr(b, store.get('ovr', {}), viewDate, parseDay(viewDate).getDay(), dm) || b;
}
const KIND_HINT = {
  core:'Shrinks last when time is tight. This only matters in the Morning and Night routines.',
  flex:'Shrinks first when time is tight. This only matters in the Morning and Night routines.',
  opt:'Cut first when time is tight. This only matters in the Morning and Night routines.',
  fixedlen:'Keeps its length and never shrinks. Add a Start time to pin it to a clock time.',
  sug:'A suggestion with no time. It shows on the timeline without taking any.',
  open:'Keeps its length, like Fixed length. Use it for a slot you will fill in later.'
};
function applyKindUI(){
  const k = $('#e_k').value, sug = k === 'sug', pri = ['core', 'flex', 'opt'].includes(k);
  $('#e_khint').textContent = KIND_HINT[k] || '';
  $('#e_howlong').style.display = sug ? 'none' : '';
  $('#e_se').style.display = sug ? 'none' : '';
  $('#e_mrow').style.display = sug ? 'none' : '';
  $('#e_fxrow').style.display = sug ? 'none' : '';
  $('#e_mwrap').style.display = pri ? '' : 'none';
}
function setKind(v){ $('#e_k').value = v; applyKindUI(); }
function refreshWinLock(){
  const on = !!$('#e_s').value && $('#e_wrap').style.display !== 'none';
  $('#e_w').disabled = on;
}
function openEd(l, id, w, startAt){
  const b = id ? effBlock(l, getBlocks(l).find(x => x.id === id)) : null;
  if (id && !b){ toast('That task is no longer in your routines. Use Rebuild this day to work with your current ones.'); return; }
  cur = { l, id, w, wk: l === 'pre' ? 'sleep' : l === 'night' ? 'wind' : ((b && b.w) || w || 'climb1') };
  $('#e_title').innerHTML = (b ? 'Edit' : 'New') + ' <em>Task</em>';
  $('#e_err').hidden = true;
  $('#ed').dataset.mode = 'task'; $('#e_tlab').textContent = 'Task'; $('#e_dlab').textContent = 'Details'; $('#e_del').textContent = 'Delete';
  $('#e_wrap').style.display = l === 'oo' ? '' : 'none';
  if (l === 'oo'){ const WB = wins(); $('#e_w').innerHTML = Object.keys(WB).map(k => '<option value="' + k + '">' + esc(WB[k].name) + '</option>').join(''); $('#e_w').value = (b && b.w) || w || 'climb1'; }
  const x = b || { t:'', d:20 };
  $('#e_t').value = x.t;
  $('#e_k').value = x.sug ? 'sug' : x.p === 'open' ? 'open' : ['core','flex','opt'].includes(x.p) ? x.p : 'fixedlen';
  $('#e_d').value = x.d; $('#e_m').value = x.m ?? ''; highlightChip();
  $('#e_icon').value = x.icon || ''; updateIconBtn();
  $('#e_color').value = x.color || ''; CT = 'e'; drawColorRow('e'); setEdAccent();
  let st = x.fixed !== undefined ? x.fixed : x.at;
  if (startAt !== undefined && !b) st = startAt;
  $('#e_fx').checked = x.fixed !== undefined;
  $('#e_s').value = st !== undefined ? toVal(st) : ''; $('#e_e').value = '';
  syncEnd(); refreshWinLock(); applyKindUI();
  $('#e_days').style.display = l === 'oo' ? 'none' : '';
  $('#e_details').value = x.details || ''; $('#e_p').value = (x.steps || []).join('\n');
  edDays = x.days ? x.days.slice() : [0,1,2,3,4,5,6]; drawDays();
  ['e_del','e_up','e_dn'].forEach(i => { $('#' + i).style.display = b ? '' : 'none'; });
  $('#ed').showModal(); $('#ed .ef').scrollTop = 0;
}
function moveBlock(d){
  const arr = clone(getBlocks(cur.l)), i = arr.findIndex(x => x.id === cur.id), wk = x => x.w || 'climb1';
  if (i < 0) return;
  if (arr[i].fixed !== undefined || arr[i].at !== undefined){ edErr('This task has a Start time, so it is ordered by that time. Change the Start time instead.'); return; }
  const vis = new Set(schedule().rows.map(r => r.id));
  let j = i + d;
  while (j >= 0 && j < arr.length && (wk(arr[j]) !== wk(arr[i]) || !vis.has(arr[j].id) || arr[j].fixed !== undefined || arr[j].at !== undefined)) j += d;
  if (j < 0 || j >= arr.length){ edErr(d < 0 ? 'It is already first in this window.' : 'It is already last in this window.'); return; }
  needLive();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  setBlocks(cur.l, arr); $('#ed').close(); render();
}
function edErr(msg){ const e = $('#e_err'); e.textContent = msg; e.hidden = false; try{ e.scrollIntoView({ block:'center', behavior:'smooth' }); }catch{} }
function syncEnd(){
  const s = $('#e_s').value, d = parseInt($('#e_d').value) || 0;
  if (!s || !d){ $('#e_e').value = ''; return; }
  const [h, mi] = s.split(':').map(Number), t = h*60 + mi + d;
  $('#e_e').value = t <= 1439 ? toVal(t) : '';
}
function highlightChip(){ const v = $('#e_d').value; document.querySelectorAll('#e_presets button').forEach(b => b.classList.toggle('on', b.dataset.m === v)); }
function updateIconBtn(){ const v = $('#e_icon').value; $('#e_iconBtn').innerHTML = v ? iconMarkup(v) : '+'; }
const ICON_CAT = {'Body & movement':'run','Food & drink':'meal','Mind & focus':'bulb','Rest & time':'moon','Home & social':'home','Travel & errands':'bag','Health & care':'heartbeat','Study & work':'books','Money & shopping':'basket','Chores & home':'broom','Social & fun':'confetti','Music & media':'music-note','Sports & outdoors':'soccer-ball','Nature & weather':'cloud-sun','Animals':'dog','Travel & places':'airplane-takeoff','Tech & settings':'desktop','More food & drink':'pizza'};
function catIcon(g){ const k = ICON_CAT[g] || (ICON_GROUPS[g] || [])[0]; return ICONS[k] || ICONS.star || ''; }
function ipId(g){ return 'ipg_' + g.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
const FA_VER = '6.7.2', FA_URL = n => 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@' + FA_VER + '/svgs/solid/' + n + '.svg';
const FA_GROUPS = {
  'Bathroom':['shower','toilet','toilet-paper','bath','soap','pump-soap','hands-bubbles','sink','faucet','faucet-drip','tooth','teeth','teeth-open','razor','spray-can-sparkles','brush','hand-sparkles','droplet','bottle-droplet','box-tissue','jug-detergent','plug-circle-bolt','water','broom','bucket'],
  'Clothes':['shirt','vest','vest-patches','socks','mitten','hat-cowboy','hat-wizard','hat-hard','glasses','user-tie','person-dress','shoe-prints','bag-shopping','gem','ring','crown','mask','head-side-mask','suitcase','umbrella','scissors','tags','tag','bell-concierge','clothes-hanger'],
  'Home':['house','house-chimney','house-user','couch','bed','lightbulb','fan','door-open','door-closed','key','kitchen-set','blender','mug-hot','utensils','plug','temperature-half','tv','trash','trash-can','box-archive','chair','jar','fire-burner','wind','shop','warehouse','toolbox','hammer','screwdriver-wrench','paint-roller'],
  'Education':['graduation-cap','book','book-open','book-open-reader','book-bookmark','pencil','pen','pen-nib','ruler','calculator','flask','atom','microscope','school','chalkboard','chalkboard-user','language','earth-americas','brain','paperclip','folder','file-lines','highlighter','marker','compass-drafting','square-root-variable','infinity','dna','magnet','scroll','pen-ruler','user-graduate'],
  'Tech':['desktop','laptop','mobile-screen','tablet-screen-button','keyboard','computer-mouse','headphones','microphone','camera','video','wifi','bluetooth','battery-full','plug','floppy-disk','hard-drive','server','code','terminal','robot','gamepad','print','qrcode','sim-card','satellite-dish','memory','microchip','laptop-code','database','cloud','cloud-arrow-up','cloud-arrow-down','power-off','satellite'],
  'Transport':['bicycle','car','bus','train','plane','ship','motorcycle','truck','taxi','van-shuttle','person-biking','person-walking','person-running','rocket','sailboat','gas-pump','road','traffic-light','map-location-dot','route','helicopter','train-subway','tractor','charging-station','car-side','plane-departure','plane-arrival','anchor','compass','map'],
  'Fitness':['dumbbell','heart-pulse','person-running','person-swimming','person-biking','person-hiking','person-skiing','person-walking','weight-scale','basketball','futbol','volleyball','baseball','football','table-tennis-paddle-ball','golf-ball-tee','hockey-puck','medal','trophy','stopwatch','mountain','fire','bolt','child-reaching','person-praying','spa','heart','shoe-prints','hand-fist','mattress-pillow'],
  'Medical':['stethoscope','pills','syringe','bandage','kit-medical','thermometer','lungs','eye','ear-listen','hand-holding-heart','hospital','notes-medical','bed-pulse','head-side-virus','virus','capsules','tablets','vial','prescription-bottle','user-doctor','user-nurse','house-medical','briefcase-medical','x-ray','tooth','brain','heart-circle-plus','wheelchair','crutch','eye-dropper','mask-face','staff-snake'],
  'Food':['utensils','burger','pizza-slice','bowl-rice','bowl-food','mug-hot','mug-saucer','wine-glass','beer-mug-empty','martini-glass','bottle-water','apple-whole','carrot','egg','cookie','cake-candles','ice-cream','bread-slice','cheese','fish','drumstick-bite','bacon','lemon','pepper-hot','candy-cane','cookie-bite','hotdog','shrimp','jar','blender','whiskey-glass','champagne-glasses','wheat-awn','seedling','plate-wheat','cow','kitchen-set','stroopwafel','lemon','pizza-slice'],
  'Nature':['sun','moon','cloud','cloud-sun','cloud-moon','cloud-rain','cloud-showers-heavy','snowflake','bolt','wind','umbrella-beach','rainbow','tree','leaf','seedling','mountain','mountain-sun','water','fire','temperature-high','temperature-low','star','tornado','hurricane','volcano','smog','droplet','clover','feather','meteor','earth-americas','globe','sun-plant-wilt','tents','campground','fire-flame-curved','spa','vihara'],
  'Animals':['paw','dog','cat','horse','fish','dove','spider','bug','hippo','frog','crow','kiwi-bird','dragon','cow','otter','bone','feather','worm','locust','mosquito','bugs','shrimp','hippo','fish-fins','horse-head','kiwi-bird','cat','dog'],
  'Work':['briefcase','building','handshake','chart-line','chart-pie','chart-column','dollar-sign','coins','wallet','credit-card','piggy-bank','receipt','money-bill','sack-dollar','cash-register','calendar-days','clipboard-list','clipboard-check','list-check','bullseye','flag','bell','envelope','phone','comments','comment','paper-plane','address-book','id-card','file-contract','signature','stamp','thumbtack','folder-open','inbox','business-time','user-group','users','award','lightbulb'],
  'Fun':['music','guitar','drum','film','clapperboard','ticket','gamepad','dice','chess','puzzle-piece','palette','paintbrush','camera-retro','masks-theater','wand-magic-sparkles','gift','cake-candles','champagne-glasses','face-smile','face-laugh','heart','ghost','skull','umbrella-beach','hands-praying','dice-d20','chess-knight','microphone-lines','radio','record-vinyl','compact-disc','volume-high','kite','binoculars','martini-glass-citrus','pizza-slice','star','icons','hat-wizard','robot'],
  'Time & rest':['bed','moon','bed-pulse','cloud-moon','stopwatch','clock','hourglass','hourglass-half','hourglass-end','hourglass-start','bell','bell-slash','calendar','calendar-check','calendar-day','calendar-week','calendar-days','sun','star','meteor','user-astronaut','shuttle-space','mattress-pillow','couch','mug-hot','spa','hot-tub-person','face-smile-beam','face-tired','face-sleeping'] 
};
const FA_CAT = {'Bathroom':'shower','Clothes':'shirt','Home':'house','Education':'graduation-cap','Tech':'desktop','Transport':'bicycle','Fitness':'dumbbell','Medical':'stethoscope','Food':'utensils','Nature':'leaf','Animals':'paw','Work':'briefcase','Fun':'masks-theater','Time & rest':'hourglass-half'};
function faMask(n){ return '<i class="fa" style="--u:url(' + FA_URL(n) + ')"></i>'; }
function faTile(n){ const k = 'fa-' + n; return ICONS[k] || (faMask(n) + '<img class="faProbe" src="' + FA_URL(n) + '" alt="" loading="lazy" onerror="this.closest(\'button\').remove()">'); }
function catMarkup(g){ return FA_CAT[g] ? (ICONS['fa-' + FA_CAT[g]] || faMask(FA_CAT[g])) : catIcon(g); }
function drawIconPicker(q){
  q = (q || '').trim().toLowerCase();
  const shown = [], match = (k, g, extra) => !q || (k.replace(/-/g, ' ') + ' ' + (extra || '') + ' ' + g.toLowerCase()).includes(q);
  let out = Object.keys(ICON_GROUPS).map(g => {
    const keys = ICON_GROUPS[g].filter(k => ICONS[k] && match(k, g, ICON_TAGS[k]));
    if (!keys.length) return '';
    shown.push(g);
    return '<div class="ipGroup" id="' + ipId(g) + '"><p class="lbl"><i class="gi">' + catIcon(g) + '</i><span>' + g + '</span></p><div class="ipRow">' + keys.map(k => '<button type="button" data-i="' + k + '" aria-label="' + k.replace(/-/g, ' ') + '" title="' + k.replace(/-/g, ' ') + '">' + ICONS[k] + '</button>').join('') + '</div></div>';
  }).join('');
  out += Object.keys(FA_GROUPS).map(g => {
    const names = Array.from(new Set(FA_GROUPS[g])).filter(n => match(n, g));
    if (!names.length) return '';
    shown.push(g);
    return '<div class="ipGroup" id="' + ipId(g) + '"><p class="lbl"><i class="gi">' + catMarkup(g) + '</i><span>' + g + '</span></p><div class="ipRow">' + names.map(n => '<button type="button" data-fa="' + n + '" aria-label="' + n.replace(/-/g, ' ') + '" title="' + n.replace(/-/g, ' ') + '">' + faTile(n) + '</button>').join('') + '</div></div>';
  }).join('');
  $('#ip_groups').innerHTML = out || '<p class="wn">No icon matches that. You can still paste an emoji below.</p>';
  $('#ip_tabs').innerHTML = shown.map(g => '<button type="button" role="tab" data-g="' + ipId(g) + '" aria-label="' + g + '" title="' + g + '">' + catMarkup(g) + '</button>').join('') + '<button type="button" role="tab" data-g="ip_custom" aria-label="Custom" title="Custom">' + (ICONS.sparkles || '') + '</button>';
  ipSpy();
}
async function pickFa(n){
  const key = 'fa-' + n;
  if (!ICONS[key]){
    try{
      const r = await fetch(FA_URL(n)); if (!r.ok) throw 0;
      const t = await r.text(), vb = (t.match(/viewBox="([^"]+)"/) || [])[1], ds = [...t.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(m => m[1]);
      if (!vb || !ds.length) throw 0;
      ICONS[key] = '<svg class="pi" viewBox="' + vb + '">' + ds.map(d => '<path d="' + d + '"/>').join('') + '</svg>';
      try{ const c = JSON.parse(localStorage.getItem('yotei_fa') || '{}'); c[key] = ICONS[key]; localStorage.setItem('yotei_fa', JSON.stringify(c)); }catch{}
    }catch{ toast('Could not load that icon. Check your connection and try again.'); return; }
  }
  $('#e_icon').value = key; updateIconBtn(); $('#iconPick').close();
}
function ipSpy(){
  const sc = $('#ip_scroll'), tabs = $('#ip_tabs'); if (!sc || !tabs) return;
  const top = sc.getBoundingClientRect().top + 24; let on = null;
  tabs.querySelectorAll('button').forEach(b => { const el = document.getElementById(b.dataset.g); if (el && el.getBoundingClientRect().top <= top) on = b; });
  if (!on) on = tabs.querySelector('button');
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) on = tabs.querySelector('button:last-child') || on;
  tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === on));
  if (on && !tabs.dataset.drag){ const l = on.offsetLeft - (tabs.clientWidth - on.offsetWidth) / 2; if (Math.abs(tabs.scrollLeft - l) > 4) tabs.scrollTo({ left:l, behavior:'smooth' }); }
}
$('#ip_scroll').addEventListener('scroll', () => { if (!ipBusy) ipSpy(); }, { passive:true });
let ipBusy = false;
$('#ip_tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const el = document.getElementById(b.dataset.g), sc = $('#ip_scroll'); if (!el) return;
  ipBusy = true; $('#ip_tabs').querySelectorAll('button').forEach(z => z.classList.toggle('on', z === b));
  sc.scrollTo({ top: sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 4, behavior:'smooth' });
  setTimeout(() => { ipBusy = false; ipSpy(); }, 450);
});
$('#ip_q').addEventListener('input', e => drawIconPicker(e.target.value));
$('#e_iconBtn').addEventListener('click', () => {
  const v = $('#e_icon').value;
  $('#e_icon_custom').value = (v && !ICONS[v]) ? v : '';
  $('#ip_q').value = ''; drawIconPicker('');
  $('#iconPick').showModal(); $('#ip_scroll').scrollTop = 0; ipSpy();
});
$('#ip_groups').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.fa){ pickFa(b.dataset.fa); return; }
  $('#e_icon').value = b.dataset.i; updateIconBtn(); $('#iconPick').close();
});
$('#ip_x').onclick = () => $('#iconPick').close();
$('#ip_ok').onclick = () => {
  $('#e_icon').value = $('#e_icon_custom').value.trim(); updateIconBtn(); $('#iconPick').close();
};
function curveAvg(pts, from, to){
  const at = h => { for (let i = 0; i < pts.length - 1; i++){ const [h0, v0] = pts[i], [h1, v1] = pts[i + 1]; if (h >= h0 && h <= h1) return v0 + (v1 - v0) * (h - h0) / (h1 - h0); } return pts[pts.length - 1][1]; };
  let t = 0; for (let i = 0; i <= 6; i++) t += at(from + (to - from) * i / 6);
  return Math.round(t / 7 / 5) * 5;
}
function openBlockInfo(k){
  const I = BLOCK_INFO[k], WB = wins(), W = WB[k]; if (!I || !W) return;
  const st = WIN_STYLE[k] || WIN_STYLE.climb1, col = safeCol(st.c) || st.c;
  const bi = $('#blockInfo'); bi.style.setProperty('--tc', col);
  const h = x => x;   // BLOCK_INFO strings are pre-escaped, with <sup> citations only
  const bar = (label, pts, note) => { const v = curveAvg(pts, I.from, I.to); return '<div class="biLv"><span>' + label + '</span><div class="biBar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + v + '" aria-label="' + label + ': ' + v + ' percent"><i style="width:' + v + '%"></i></div></div><p class="biNote">' + h(note) + '</p>'; };
  $('#bi_body').innerHTML =
    '<div class="biHead"><span class="tsIcon" style="--dot:' + col + ';color:' + onColor(col) + '">' + iconMarkup(st.i) + '</span><div class="tsHT"><div class="tsWhen">' + range(wake + W.from, wake + W.to) + '</div><b>' + esc(W.name) + '</b>' + (I.dn !== W.name ? '<div class="tsWhen">' + esc(I.dn) + '</div>' : '') + '</div></div>' +
    '<p class="biSci">' + h(I.sci) + '</p>' +
    '<div class="biFeels"><span>Feels like</span>' + I.feels.map(f => '<i>' + esc(f) + '</i>').join('') + '</div>' +
    '<div class="biCard"><div class="biT">Levels in this window</div>' + bar('Sleep pressure', PRESS_PTS, I.notes[0]) + bar('Circadian drive', CIRC_PTS, I.notes[1]) + '</div>' +
    '<div class="biCard"><div class="biT">Cues for this window</div>' + I.cues.map(c => '<p class="biCue"><b>' + esc(c.l) + '</b>' + h(c.t) + '</p>').join('') + '</div>' +
    '<details class="biCard"><summary><span class="biT">Common myth</span><em>' + esc(I.myth.hint) + '</em></summary><p>' + h(I.myth.text) + '</p></details>' +
    '<details class="biCard"><summary><span class="biT">If you push against it</span><em>' + esc(I.push.hint) + '</em></summary><p>' + h(I.push.text) + '</p></details>' +
    '<p class="biFoot">Numbers in brackets point to the sources listed in Settings. These are population averages, so your own rhythm may sit earlier or later.</p>';
  $('#bi_body').scrollTop = 0;
  bi.showModal();
}
(function(){ let y0 = null; const h = $('#bi_handle'), bi = $('#blockInfo');
  h.addEventListener('pointerdown', e => { y0 = e.clientY; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e => { if (y0 !== null && e.clientY - y0 > 40){ y0 = null; bi.close(); } });
  ['pointerup', 'pointercancel'].forEach(ev => h.addEventListener(ev, () => { y0 = null; }));
  bi.addEventListener('click', e => { if (e.target === bi) bi.close(); });
})();
(function(){
  const el = $('#srcList'); if (!el) return;
  el.innerHTML = SCI_SRC.map(x => '<li value="' + x.n + '"><span>' + esc(x.what) + '</span>' + (/^https:\/\//.test(x.url) ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>' : esc(x.title)) + '</li>').join('');
})();
// ============================================================
// TASK DETAIL SHEET — opens on tap, shows name/time + actions
// (Delete / Duplicate / Edit). Deliberately excludes Details —
// keep it lean, see the phase history for why.
// ============================================================
let sheetCtx = null;
Object.assign(ICONS, { 'check-circle':'<svg class="pi" viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm45.66,85.66-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32Z"/></svg>' });
const tile = (id, ic, label) => { $('#' + id).innerHTML = ICONS[ic] + '<span>' + label + '</span>'; };
function openTaskSheet(l, id){
  const { rows } = schedule();
  const r = rows.find(x => x.id === id);
  if (!r) return;
  sheetCtx = { l, id };
  const st = WIN_STYLE[r.w] || WIN_STYLE.climb1, col = safeCol(r.color) || st.c;
  const cut = r.use === 0 && !r.sug && r.fixed === undefined;
  const sh = $('#taskSheet'); sh.style.setProperty('--tc', col); sh.style.setProperty('--tcon', onColor(col));
  $('#ts_icon').innerHTML = iconMarkup(r.icon || guessIcon(r.t) || st.i);
  $('#ts_icon').style.setProperty('--dot', col); $('#ts_icon').style.color = onColor(col);
  $('#ts_title').innerHTML = esc(r.t) + (l !== 'oo' ? ICONS['arrows-clockwise'] : '');
  const dt = parseDay(viewDate).toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  const dur = m => m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  $('#ts_time').textContent = dt + ' \u00b7 ' + (cut ? 'Skipped today' : r.sug ? 'Suggestion' : range(r.start, r.end) + ' (' + dur(r.use) + ')');
  const dEl = $('#ts_details'); dEl.textContent = r.details || 'No details yet'; dEl.className = r.details ? '' : 'none';
  const ins = taskInsight(id); $('#ts_insight').textContent = ins; $('#ts_insight').hidden = !ins;
  const isDone = done.ids.includes(r.id), nt = getNote(id);
  tile('ts_del', 'trash', 'Delete'); tile('ts_dup', 'files', 'Duplicate');
  tile('ts_done', 'check-circle', isDone ? 'Not done' : 'Complete'); $('#ts_done').hidden = cut || r.sug;
  tile('ts_noteb', 'note', nt ? 'Edit note' : 'Add note');
  tile('ts_timer', 'timer', 'Timer'); $('#ts_timer').hidden = !(r.use > 0) || r.sug || viewDate !== todayStr() || snapMode();
  tile('ts_move', 'paper-plane', 'Move');
  $('#ts_edit').innerHTML = ICONS['pencil-line'] + 'Edit Task';
  sh.showModal(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
(function(){ let y0 = null; const h = $('#ts_handle'), sh = $('#taskSheet');
  h.addEventListener('pointerdown', e => { y0 = e.clientY; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e => { if (y0 !== null && e.clientY - y0 > 40){ y0 = null; sh.close(); } });
  ['pointerup', 'pointercancel'].forEach(ev => h.addEventListener(ev, () => { y0 = null; }));
  sh.addEventListener('click', e => { if (e.target === sh) sh.close(); });
})();
$('#ts_done').onclick = () => {
  const k = sheetCtx.id, i = done.ids.indexOf(k);
  if (i === -1) done.ids.push(k); else done.ids.splice(i, 1);
  saveDay(); $('#taskSheet').close(); render(); if (i === -1) offerTickAll(k);
};
$('#ts_edit').onclick = () => { $('#taskSheet').close(); openEd(sheetCtx.l, sheetCtx.id); };
$('#ts_del').onclick = () => {
  if (!confirm('Delete this task?')) return;
  setBlocks(sheetCtx.l, clone(getBlocks(sheetCtx.l)).filter(x => x.id !== sheetCtx.id));
  $('#taskSheet').close(); render();
};
$('#ts_dup').onclick = () => {
  const r = schedule().rows.find(x => x.id === sheetCtx.id); if (!r) return;
  $('#taskSheet').close();
  openEd('oo', null, r.w); cur.addScope = true;
  $('#e_t').value = r.t;
  $('#e_k').value = r.sug ? 'sug' : ['core', 'flex', 'opt'].includes(r.p) ? r.p : r.p === 'open' ? 'open' : 'fixedlen';
  $('#e_d').value = r.d !== undefined ? r.d : r.use; $('#e_m').value = r.m ?? ''; highlightChip();
  $('#e_icon').value = r.icon || ''; updateIconBtn();
  $('#e_color').value = r.color || ''; drawColorRow('e'); setEdAccent();
  $('#e_details').value = r.details || ''; $('#e_p').value = (r.steps || []).join('\n');
  $('#e_s').value = ''; $('#e_e').value = ''; $('#e_fx').checked = false; refreshWinLock(); applyKindUI();
};
// ============================================================
// SUBTASK SHEET — opens from the small icon next to a task's
// subtask count. Checklist only, no Delete/Duplicate/Edit here.
// ============================================================
let stepsSheetId = null;
function tickAllSteps(id, on = true){
  const r = schedule().rows.find(x => x.id === id); if (!r || !(r.steps || []).length) return;
  r.steps.forEach((z, i) => { const k = id + '#' + i, j = done.ids.indexOf(k); if (on && j === -1) done.ids.push(k); if (!on && j !== -1) done.ids.splice(j, 1); });
  const pi = done.ids.indexOf(id); if (on && pi === -1) done.ids.push(id); if (!on && pi !== -1) done.ids.splice(pi, 1);
  saveDay(); render();
}
function offerTickAll(id){
  const r = schedule().rows.find(x => x.id === id); if (!r) return;
  const n = (r.steps || []).filter((z, i) => !done.ids.includes(id + '#' + i)).length;
  if (n) toast(n === 1 ? 'Tick the subtask too?' : 'Tick all ' + n + ' subtasks too?', 'Tick all', () => tickAllSteps(id));
}
function ssRefresh(){
  const r = schedule().rows.find(x => x.id === stepsSheetId); if (!r) return;
  $('#ss_list').innerHTML = stepsRowsHtml(r);
  const all = (r.steps || []).every((z, i) => done.ids.includes(r.id + '#' + i));
  $('#ss_all').textContent = all ? 'Untick all' : 'Tick all';
}
function stepsRowsHtml(r){
  const dot = r.color || (WIN_STYLE[r.w] || WIN_STYLE.climb1).c;
  return (r.steps || []).map((z, i) => {
    const k = r.id + '#' + i, dn = done.ids.includes(k);
    return '<button class="stp' + (dn ? ' done' : '') + '" data-k="' + k + '" data-b="' + r.id + '" data-n="' + r.steps.length + '" style="--dot:' + dot + '"><span class="ssCheck"></span><span>' + esc(z) + '</span></button>';
  }).join('');
}
function openStepsSheet(id){
  const { rows } = schedule(), r = rows.find(x => x.id === id);
  if (!r || !(r.steps || []).length) return;
  stepsSheetId = id;
  $('#ss_title').textContent = r.t;
  ssRefresh();
  $('#stepsSheet').showModal();
}
$('#ss_close').onclick = () => $('#stepsSheet').close();
$('#ss_all').onclick = () => { const on = $('#ss_all').textContent === 'Tick all'; tickAllSteps(stepsSheetId, on); ssRefresh(); };
$('#ss_list').addEventListener('click', e => {
  const st = e.target.closest('.stp'); if (!st) return;
  const k = st.dataset.k, i = done.ids.indexOf(k);
  if (i === -1) done.ids.push(k); else done.ids.splice(i, 1);
  const b = st.dataset.b, all = Array.from({ length:+st.dataset.n }, (_, j) => done.ids.includes(b + '#' + j)).every(Boolean), bi = done.ids.indexOf(b);
  if (all && bi === -1) done.ids.push(b); else if (!all && bi !== -1) done.ids.splice(bi, 1);
  saveDay();
  render();
  ssRefresh();
});
$('#e_presets').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $('#e_d').value = b.dataset.m; highlightChip(); syncEnd();
});
$('#e_d').addEventListener('input', () => { highlightChip(); syncEnd(); });
$('#e_s').addEventListener('input', () => {
  const s = $('#e_s').value;
  if (s){ if ($('#e_k').value === 'sug') setKind('fixedlen'); syncEnd(); syncWinSel(); }
  else { $('#e_e').value = ''; $('#e_fx').checked = false; }
  refreshWinLock();
});
$('#e_e').addEventListener('input', () => {
  const s = $('#e_s').value, e = $('#e_e').value;
  if (!e) return;
  if (!s){ edErr('Pick a start time first.'); $('#e_e').value = ''; return; }
  const [h, mi] = s.split(':').map(Number), [h2, m2] = e.split(':').map(Number), d = h2*60 + m2 - (h*60 + mi);
  if (d > 0){ $('#e_d').value = d; highlightChip(); }
  else { edErr('End time has to be after the start time.'); syncEnd(); }
});
function syncWinSel(){
  const f = $('#e_s').value; if (!f || $('#e_wrap').style.display === 'none') return;
  const [h, mi] = f.split(':').map(Number); $('#e_w').value = winFor(h*60 + mi);
}
$('#e_k').addEventListener('change', () => {
  const k = $('#e_k').value;
  if (k === 'sug'){ $('#e_s').value = ''; $('#e_e').value = ''; $('#e_fx').checked = false; }
  if (k !== 'sug' && !(parseInt($('#e_d').value) > 0)){ $('#e_d').value = 20; highlightChip(); }
  if (['core', 'flex', 'opt'].includes(k) && $('#e_m').value === '') $('#e_m').value = $('#e_d').value;
  applyKindUI(); syncEnd(); refreshWinLock();
});
$('#e_fx').addEventListener('change', () => { if ($('#e_fx').checked && !$('#e_s').value) edErr('Pick a Start time for a fixed task.'); });
$('#e_days').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const i = +b.dataset.i;
  edDays = edDays.includes(i) ? edDays.filter(z => z !== i) : edDays.concat(i); drawDays();
});
$('#e_x').onclick = () => $('#ed').close();
$('#ed').addEventListener('input', () => { $('#e_err').hidden = true; });
$('#e_up').onclick = () => moveBlock(-1);
$('#e_dn').onclick = () => moveBlock(1);
$('#e_del').onclick = () => { setBlocks(cur.l, clone(getBlocks(cur.l)).filter(x => x.id !== cur.id)); $('#ed').close(); render(); };
$('#e_ok').onclick = () => {
  const t = $('#e_t').value.trim();
  if (!t){ edErr('Give the task a name first.'); return; }
  if (cur.l === 'win'){ saveWinBlock(t); return; }
  { const s = $('#e_s').value, e = $('#e_e').value;
    if (e && !s){ edErr('Add a start time too, or clear the end time.'); return; }
    if (s && e){ const [h, mi] = s.split(':').map(Number), [h2, m2] = e.split(':').map(Number); if (h2*60 + m2 <= h*60 + mi){ edErr('End time has to be after the start time.'); return; } }
  }
  let k = $('#e_k').value;
  if (k !== 'sug' && !(parseInt($('#e_d').value) > 0)){ edErr('Set how long it takes, in minutes.'); return; }
  const arr = clone(getBlocks(cur.l)), old0 = arr.find(x => x.id === cur.id), old = effBlock(cur.l, old0);
  const b = { id: old ? old.id : 'u' + Date.now().toString(36), t };
  if (old){ const FORM = ['id','t','d','m','p','sug','fixed','at','details','color','icon','steps','days','w']; Object.keys(old).forEach(z => { if (!FORM.includes(z)) b[z] = old[z]; }); }
  if (cur.l === 'oo') b.w = $('#e_w').value || 'climb1'; else if (old && old.w) b.w = old.w; else if (cur.l !== 'pre' && cur.l !== 'night') b.w = cur.w || 'climb1';
  const details = $('#e_details').value.trim(); if (details) b.details = details;
  const color = $('#e_color').value.trim(); if (color) b.color = color;
  const icon = $('#e_icon').value.trim(); if (icon) b.icon = icon;
  const steps = $('#e_p').value.split('\n').map(z => z.trim()).filter(Boolean); if (steps.length) b.steps = steps;
  if (cur.l !== 'oo'){ if (!edDays.length){ edErr('Pick at least one day.'); return; } if (edDays.length < 7) b.days = edDays.slice().sort(); }
  const d = Math.max(0, parseInt($('#e_d').value) || 0), m = parseInt($('#e_m').value);
  if (k === 'sug'){ b.sug = true; b.d = 0; }
  else {
    b.d = d;
    if (k === 'open') b.p = 'open';
    else if (k !== 'fixedlen'){ b.p = k; b.m = Math.min(d, isNaN(m) ? d : m); }
    const f = $('#e_s').value;
    if ($('#e_fx').checked && !f){ edErr('Pick a Start time for a fixed task, or turn Fixed time off.'); return; }
    if (f){
      const [h, mi] = f.split(':').map(Number), tm0 = h*60 + mi;
      if ($('#e_fx').checked) b.fixed = tm0; else b.at = tm0;
      if (cur.l !== 'pre' && cur.l !== 'night') b.w = winFor(tm0);
      else { const need = cur.l === 'pre' ? 'sleep' : 'wind', got = winFor(tm0); if (got !== need){ edErr('That time falls in ' + wins()[got].name + ', not ' + wins()[need].name + '. Add it from that window instead.'); return; } }
    }
  }
  if (cur.l === 'oo' && cur.addScope && !old && !cur.fromInbox){
    const w = b.w, l = w === 'sleep' ? 'pre' : w === 'wind' ? 'night' : (typeOf(w) || 'home');
    askScope('add', { l, id:b.id, b, old:null, w }); return;
  }
  if (cur.l !== 'oo'){
    if (old && !Object.keys(diffBlock(old, b)).length){ $('#ed').close(); return; }
    askScope(old ? 'edit' : 'add', { l:cur.l, id:b.id, b, old, w:cur.w }); return;
  }
  needLive();
  if (old0) arr[arr.indexOf(old0)] = b; else arr.push(b);
  if (cur.fromInbox) store.set('inbox', store.get('inbox', []).filter(x => x.id !== cur.fromInbox));
  setBlocks(cur.l, arr); $('#ed').close(); render();
};
$('#e_x2').onclick = () => $('#e_x').click();
$('#settingsBtn').addEventListener('click', () => setTab('settings'));
$('#editToggle').addEventListener('click', () => {
  editing = !editing;
  $('#settingsBtn').classList.toggle('on', editing);
  $('#editToggle').textContent = editing ? 'Turn off editing' : 'Turn on editing';
  if (editing) setTab('home');
  render();
});
// ============================================================
// HISTORY & TRENDS TABS
// ============================================================
function historyDayInner(h){
  const WB = wins(), rs = h.rows || [];
  const tp = h.types ? Object.keys(h.types).map(k => esc(WB[k] ? WB[k].name : k) + ': ' + (MODE_LABEL[h.types[k]] || '')).join(', ') : '';
  const groups = Object.keys(WB).map(k => {
    const g = rs.filter(r => r.w === k && (r.u > 0 || r.done));
    return g.length ? '<p class="hd">' + esc(WB[k].name) + '</p>' + g.map(r => '<p class="hl' + (r.done ? ' ok' : '') + '"><span class="ht">' + fmt(r.s).join(' ') + '</span>' + esc(r.t) + (r.n ? '<br><span class="ht">Note</span>' + esc(r.n) : '') + '</p>').join('') : '';
  }).join('');
  return (tp ? '<p class="wn">' + tp + '</p>' : '') + (h.note ? '<p class="hl">Note: ' + esc(h.note) + '</p>' : '') + groups;
}
function trendsHtml(){
  const H = store.get('hist', {}), days = Object.keys(H).sort((a, b) => cmpDay(b, a)).slice(0, 7).reverse();
  if (!days.length) return '<p class="wn">Not enough history yet for trends.</p>';
  const dayRows = days.map(d => {
    const h = H[d], rs = (h.rows || []).filter(r => r.u > 0 && !r.sug), n = rs.filter(r => r.done).length, pct = rs.length ? Math.round(n / rs.length * 100) : 0;
    return '<div class="trow"><span class="tlab">' + parseDay(d).toLocaleDateString(undefined, { weekday:'short' }) + '</span><div class="tbar"><div class="tfill" style="width:' + pct + '%"></div></div><span class="tpct">' + pct + '%</span></div>';
  }).join('');
  const counts = {};
  Object.values(H).forEach(h => (h.rows || []).forEach(r => {
    if (r.u <= 0 || r.sug) return;
    if (!counts[r.id]) counts[r.id] = { t: r.t, done: 0, total: 0 };
    counts[r.id].total++; if (r.done) counts[r.id].done++;
  }));
  const top = Object.values(counts).filter(c => c.total >= 2).sort((a, b) => b.done / b.total - a.done / a.total || b.total - a.total).slice(0, 6)
    .map(c => '<div class="trow"><span class="tlab wide">' + esc(c.t) + '</span><div class="tbar"><div class="tfill" style="width:' + Math.round(c.done / c.total * 100) + '%"></div></div><span class="tpct">' + c.done + '/' + c.total + '</span></div>').join('');
  const sk = streaks(H);
  return '<div class="sleep"><h2>Streaks</h2><p class="streak"><b>' + sk.cur + '</b>day streak, best ' + sk.best + '</p><p class="wn">A day counts when you finish 70% or more of its tasks.</p></div>' + weekHtml(H) + reviewHtml(H) + energyHtml(H) + ratingsHtml() + '<div class="sleep"><h2>Completion, last ' + days.length + ' day' + (days.length === 1 ? '' : 's') + '</h2>' + dayRows + '</div>' + (top ? '<div class="sleep"><h2>Most consistent tasks</h2>' + top + '</div>' : '');
}
function histHtml(){
  const H = store.get('hist', {});
  const days = Object.keys(H).filter(d => d !== todayStr()).sort((a, b) => cmpDay(b, a));
  const items = days.map(d => {
    const h = H[d], rs = h.rows || [], live = rs.filter(r => r.u > 0 && !r.sug), n = live.filter(r => r.done).length, dt = parseDay(d);
    return '<details class="hday"><summary><span class="bt">' + dt.toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric', year:'numeric' }) + '</span><span class="bm">' + n + ' of ' + live.length + ' done, woke ' + fmt(h.wake).join(' ') + '</span></summary><div class="hb">' + historyDayInner(h) + '<button class="hdel" data-hd="' + esc(d) + '">Delete this record</button></div></details>';
  }).join('');
  return items || '<p class="wn">No past days yet.</p>';
}
function drawNav(){
  const d = parseDay(viewDate);
  $('#date').innerHTML = '<b>' + d.toLocaleDateString(undefined, { weekday:'long' }) + '</b><span class="dacc">' + d.toLocaleDateString(undefined, { month:'long', day:'numeric', year:'numeric' }) + '</span>';
  const base = mondayOf(viewDate), todayDS = todayStr();
  let strip = '';
  for (let i = 0; i < 7; i++){
    const wd = new Date(base); wd.setDate(base.getDate() + i);
    const ds = isoLocal(wd), sel = ds === viewDate, isToday = ds === todayDS;
    strip += '<button class="wd' + (sel ? ' on' : '') + (isToday ? ' today' : '') + '" data-d="' + ds + '"><span class="wdn">' + wd.toLocaleDateString(undefined, { weekday:'short' }) + '</span><span class="wdd">' + wd.getDate() + '</span><span class="wdots">' + dayColors(ds).map(c => '<i style="--c:' + c + '"></i>').join('') + '</span></button>';
  }
  $('#weekstrip').innerHTML = strip;
  $('#datePick').value = isoLocal(d);
  $('#todayBtn').hidden = viewDate === todayStr();
  $('#liveBtn').hidden = !snapMode();
  drawHdr();
}
let lastSig = '';
function saveHist(){
  const tn = store.get('taskNotes', {});
  const snap = { dow:dowOf(day.date), wake, types:day.types, note:day.note || '', rows:schedule().rows.map(r => ({ w:r.w, id:r.id, t:r.t, md:r.md || null, s:r.start, e:r.end, u:r.use, sug:!!r.sug, done:done.ids.includes(r.id), n:tn[day.date + '_' + r.id] || '' })) };
  const sig = day.date + JSON.stringify(snap);
  if (sig === lastSig) return;
  lastSig = sig;
  const h = store.get('hist', {});
  if (!snap.rows.some(r => r.u > 0 && !r.sug)){ if (h[day.date]){ delete h[day.date]; store.set('hist', h); } return; }
  h[day.date] = snap;
  const keys = Object.keys(h).sort(cmpDay);
  while (keys.length > 90) delete h[keys.shift()];
  store.set('hist', h);
  const oldest = keys[0], nm = store.get('taskNotes', {});
  let ch = false;
  for (const k in nm){ if (k.split('_')[0] < oldest){ delete nm[k]; ch = true; } }
  if (ch) store.set('taskNotes', nm);
}
// ============================================================
// MAIN RENDER LOOP — render() picks today vs. another date,
// draw() builds today's live interactive timeline.
// ============================================================
function render(){
  applyWinColors();
  drawNav();
  if (document.activeElement !== $('#dnote')) $('#dnote').value = day.note || '';
  drawInbox(); drawEnergy(); drawEmpty();
  document.body.classList.toggle('snap', snapMode());
  draw();
  $('#trends').innerHTML = trendsHtml();
  $('#histbox').innerHTML = histHtml();
  const hrs = c => ((wake + 1440 - c) / 60).toFixed(1);
  $('#sleep').innerHTML =
    '<div class="capRow"><label for="capS">Soft cap</label><input type="time" id="capS" value="' + toVal(CAP.soft) + '"><i>' + hrs(CAP.soft) + ' h before wake</i></div>' +
    '<div class="capRow"><label for="capH">Hard cap</label><input type="time" id="capH" value="' + toVal(CAP.hard) + '"><i>' + hrs(CAP.hard) + ' h before wake</i></div>' +
    (hrs(CAP.hard) < 7 ? '<p class="wn">Under 7 h between your hard cap and wake time. Most adults do better with 7 to 9 h, so consider an earlier cap or a later wake.</p>' : '');
  if (viewDate === todayStr()) saveHist();
}
function draw(){
  const w = wake, isToday = viewDate === todayStr(), NM = isToday ? nowM() : (viewDate < todayStr() ? 1e4 : -1);
  $('#wake').value = toVal(w);
  const { rows, msg, tone } = schedule();
  let capMsg = '', capTone = 'warn';
  if (isToday && (NM >= CAP.hard || NM < wake)){ capMsg = 'Past your hard sleep cap (' + fmt(CAP.hard).join(' ') + '). Lights out. After it, only core tasks stay on the schedule.'; capTone = 'bad'; }
  else if (isToday && NM >= CAP.soft) capMsg = 'Past your soft sleep cap (' + fmt(CAP.soft).join(' ') + '). Wrap up. Optional tasks after it are skipped.';
  const m = $('#msg'); m.textContent = capMsg || msg; m.className = 'msg ' + (capMsg ? capTone : tone);
  const live = rows.filter(r => r.use > 0);
  const n = live.filter(r => done.ids.includes(r.id)).length;
  $('#prog').textContent = live.length ? n + ' of ' + live.length + ' done' : '';
  const rowHtml = (r, prev) => {
    const cut = r.use === 0 && !r.sug && r.fixed === undefined, dn = done.ids.includes(r.id);
    let tag = '';
    const isNow = r.use > 0 && !r.sug && NM >= r.start && NM < r.end;
    const winB = WIN[r.w] ? wins()[r.w] : null;
    const overflow = winB && r.use > 0 && !r.sug && r.start <= w + winB.to && r.end > w + winB.to;
    const sw = (prev && prev.md && r.md !== prev.md && MODE_NAME[r.md] ? '<span class="tag warn">switched to ' + MODE_NAME[r.md] + '</span>' : '') + (r.fixed !== undefined ? '<span class="tag">fixed time</span>' : '') + (overflow ? '<span class="tag warn">runs past window end</span>' : '');
    if (cut) tag = '<span class="tag bad">' + (r.capCut ? 'past sleep cap' : 'cut today') + '</span>';
    else if (r.m !== undefined && r.use < r.d) tag = '<span class="tag warn">' + (r.use - r.d) + ' min</span>';
    else if (r.p === 'buf') tag = '<span class="tag ok">buffer</span>';
    const st = WIN_STYLE[r.w] || WIN_STYLE.climb1;
    const dotColor = safeCol(r.color) || st.c;
    const h = dotHeight(r.use);
    const frac = (r.sug || r.use === 0) ? 0 : fracFor(r, NM);
    const dotIcon = dotFillHtml(r.icon || guessIcon(r.t) || st.i, dotColor, frac, h);
    const dotStyle = 'width:' + DOT_W + 'px;height:' + h + 'px;border-radius:' + (DOT_W / 2) + 'px;background:' + dotBg(dotColor, frac);
    const nDone = (r.steps || []).filter((z, i) => done.ids.includes(r.id + '#' + i)).length;
    const stepBadge = r.steps && r.steps.length ? '<span class="stepsBtn chipS" role="button" tabindex="0" data-sid="' + r.id + '" aria-label="Subtasks"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/></svg>' + nDone + '/' + r.steps.length + '</span>' : '';
    const timeLbl = (cut || r.sug) ? '' : fmt(r.start).join(' ');
    const check = r.sug ? '' : '<span class="tlcheck"></span>';
    const timed = r.use > 0 && !r.sug && !cut;
    let pq = null; for (let q = rows.indexOf(r) - 1; q >= 0; q--){ if (rows[q].use > 0 && !rows[q].sug){ pq = rows[q]; break; } }
    const col1 = '<span class="tlcol1">' + (timed && (!pq || pq.end < r.start) && !(isNow && frac * h < 22) ? '<span class="tltime">' + fmt(r.start).join(' ') + '</span>' : '') + (timed && !(isNow && (1 - frac) * h < 22) ? '<span class="tlend">' + fmt(r.end).join(' ') + '</span>' : '') + (isNow ? '<span class="tlnow" style="top:' + Math.max(16, Math.min(80, Math.round(frac * 100))) + '%">' + fmt(NM).join(' ') + '</span>' : '') + '</span>';
    const dur = m => m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    const metaTxt = cut ? 'Skipped' : r.sug ? 'Suggestion' : r.use > 0 ? (isNow ? (r.end - NM) + 'm remaining' : range(r.start, r.end) + ' (' + dur(r.use) + ')') : fmt(r.start).join(' ');
    const noteIc = getNote(r.id) ? '<span class="noteMark" aria-label="Has a note"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg></span>' : '';
    const chips = (stepBadge || noteIc) ? '<span class="tlchips">' + stepBadge + noteIc + '</span>' : '';
    return '<div class="blk" data-c="' + dotColor + '" data-f="' + frac.toFixed(3) + '"><button class="tlrow' + (dn ? ' done' : '') + (isNow ? ' now' : '') + (cut ? ' cut' : '') + (r.sug ? ' sug' : '') + '" style="--dot:' + dotColor + ';--h:' + h + 'px" data-id="' + r.id + '" data-l="' + (r.post ? r.md : 'pre') + '" data-locked="' + ((cut || r.sug) ? 1 : 0) + '" aria-label="' + esc(r.t) + (cut ? ', skipped' : r.sug ? ', suggestion' : dn ? ', done' : ', not done') + '">' + col1 + '<span class="tldot" style="' + dotStyle + '">' + dotIcon + '</span><span class="tlbody"><span class="time">' + metaTxt + tag + sw + '</span><span class="ttl">' + esc(r.t) + (editing && r.p !== 'buf' ? '<span class="dragH" aria-label="Drag to move" title="Drag to move">&#8942;&#8942;</span>' : '') + '</span>' + chips + '</span>' + check + '</button>' + noteHtml(r) + '</div>';
  };
  function gapRows(rs){
    let out = '';
    for (let i = 0; i < rs.length; i++){
      out += rowHtml(rs[i], rs[i - 1]);
      const cur = rs[i], next = rs[i + 1];
      if (cur.use > 0 && !cur.sug && next && next.use > 0 && !next.sug && next.start > cur.end){
        const mins = next.start - cur.end, h = Math.floor(mins / 60), m = mins % 60;
        const dur = (h ? h + 'h ' : '') + (m || !h ? m + 'm' : '');
        out += '<div class="gap"><span class="gaptxt">' + dur + ' free</span>' + (!editing ? '' : '<button class="add" data-l="' + (cur.md || 'pre') + '" data-w="' + cur.w + '" data-s="' + cur.end + '">+ Add task</button>') + '</div>';
      }
    }
    return out;
  }
  function noteHtml(r){
    if (noteEditing === r.id && !editing) return '<div class="noteEdit"><textarea class="ntxt">' + esc(getNote(r.id)) + '</textarea><div class="ea"><button class="ncancel">Cancel</button><button class="nsave" data-nid="' + r.id + '">Save</button></div></div>';
    const n = getNote(r.id);
    return (n && shownNotes.has(noteKey(r.id)) ? '<div class="noteShow open" data-nid="' + r.id + '" title="Tap to edit">' + esc(n) + '</div>' : '');
  }
  const WB = wins();
  const winSection = k => {
    const t = typeOf(k), rs = rows.filter(r => r.w === k), st = WIN_STYLE[k];
    const nominalEnd = wake + WB[k].to, lastTaskEnd = rs.length ? Math.max(...rs.map(r => r.end)) : nominalEnd;
    const isNowW = NM >= wake + WB[k].from && NM < Math.max(nominalEnd, lastTaskEnd), started = NM >= wake + WB[k].from;
    let html = '<div class="tlhead" data-k="' + k + '" data-c="' + st.c + '" data-f="' + (started ? 1 : 0) + '" style="--dot:' + st.c + '"><span class="tlspacer"></span><span class="tldot" style="color:' + onColor(st.c) + '">' + iconMarkup(st.i) + '</span><div class="tlheadtext"><b>' + esc(WB[k].name) + '</b><span class="tlmeta">' + (isNowW ? 'Now, ' : '') + range(wake + WB[k].from, wake + WB[k].to) + '</span></div></div>';
    if (k !== 'sleep' && k !== 'wind'){
      const bypassColor = started ? st.c : 'var(--graydot)';
      const modeKeys = Object.keys(MODE_LABEL).filter(m => !(k === 'wmz' && m === 'school'));
      html += '<div class="modeWrap"><div class="mode" style="box-shadow:0 0 0 4px var(--bg),0 0 0 7px ' + bypassColor + '" role="group" aria-label="Where you are during ' + esc(WB[k].name) + '">' + modeKeys.map(m => '<button data-w="' + k + '" data-m="' + m + '"' + (t === m ? ' class="on"' : '') + '>' + MODE_LABEL[m] + '</button>').join('') + '</div></div>';
    }
    if ((k === 'sleep' || k === 'wind') && isToday && rs.some(r => r.use > 0 && !r.sug && !done.ids.includes(r.id))) html += '<button class="add runBtn" data-run="' + k + '">Start ' + esc(WB[k].name.toLowerCase()) + '</button>';
    if (k === 'sleep' || k === 'wind' || t || rs.length){
      html += rs.length ? gapRows(rs) : '<p class="wn">No tasks yet.</p>';
      if (editing || !rs.length) html += '<button class="add" data-l="' + (k === 'sleep' ? 'pre' : k === 'wind' ? 'night' : t || 'oo') + '" data-w="' + k + '">+ Add task</button>';
    } else html += '<p class="wn">Choose where you are for this stretch and its tasks appear here.</p>';
    if (editing) html += '<button class="add" data-eb="' + k + '">Edit block</button>';
    return html;
  };
  $('#tl').innerHTML = '<div class="tlwrap">' + Object.keys(WIN).map(winSection).join('') + '</div>';
  buildSpine();
  $('#awayBtn').style.display = '';
  $('#awayBtn').classList.toggle('on', !!day.away);
  $('#awayBtn').textContent = day.away ? 'Away day: on' : 'Away day'; $('#awayBtn').setAttribute('aria-pressed', !!day.away);
  $('#awayHint').textContent = day.away ? 'Today is set as an Away day. Tasks below are just suggestions, so a note here is often all you need. Tap Away day again to undo.' : '';
  if (isToday) drawNowBanner(rows); else $('#nowBanner').classList.remove('show');
}

$('#wake').addEventListener('change', e => {
  if (!e.target.value) return;
  const [h, m] = e.target.value.split(':').map(Number);
  needLive(); wake = h*60 + m; saveDay(); render();
});
$('#reset').addEventListener('click', () => { wake = DEF_WAKE; saveDay(); render(); });
$('#reset').setAttribute('aria-label', 'Reset wake time to ' + fmt(DEF_WAKE).join(' '));
$('#sleep').addEventListener('change', e => {
  if (!/^cap[SH]$/.test(e.target.id) || !e.target.value) return;
  const [h, m] = e.target.value.split(':').map(Number), mins = h * 60 + m;
  const nx = { soft: CAP.soft, hard: CAP.hard }; nx[e.target.id === 'capS' ? 'soft' : 'hard'] = mins;
  if (mins >= 18 * 60 && nx.soft < nx.hard){ CAP.soft = nx.soft; CAP.hard = nx.hard; store.set('caps', { soft:CAP.soft, hard:CAP.hard }); }
  render();
});
$('#awayBtn').addEventListener('click', () => {
  needLive();
  day.away = !day.away;
  if (day.away){ day.prevTypes = { ...day.types }; Object.keys(WIN).forEach(k => { if (k !== 'sleep' && k !== 'wind') day.types[k] = 'away'; }); }
  else { day.types = day.prevTypes || {}; delete day.prevTypes; }
  saveDay(); render();
});
$('#tl').addEventListener('click', e => {
  const mb = e.target.closest('.mode button');
  if (mb){ pickType(mb.dataset.w, mb.dataset.m); return; }
  if (lpFired){ lpFired = false; return; }
  const nmk = e.target.closest('.noteMark');
  if (nmk){
    e.stopPropagation();
    const nk = noteKey(nmk.closest('.tlrow').dataset.id);
    if (shownNotes.has(nk)) shownNotes.delete(nk); else shownNotes.add(nk);
    render(); return;
  }
  const nsh = e.target.closest('.noteShow');
  if (nsh){ noteEditing = nsh.dataset.nid; render(); return; }
  const nb = e.target.closest('.noteBtn');
  if (nb){ noteEditing = nb.dataset.nid; render(); return; }
  if (e.target.closest('.ncancel')){ noteEditing = null; render(); return; }
  const ns = e.target.closest('.nsave');
  if (ns){
    const id = ns.dataset.nid, txt = e.target.closest('.noteEdit').querySelector('.ntxt').value.trim();
    setNote(id, txt);
    if (txt) shownNotes.add(noteKey(id)); else shownNotes.delete(noteKey(id));
    noteEditing = null; render(); if (txt) toast('Note saved'); return;
  }
  const ad = e.target.closest('.add');
  if (ad){
    if (ad.dataset.eb) openBlockEd(ad.dataset.eb);
    else openEd(ad.dataset.l, null, ad.dataset.w, ad.dataset.s === undefined ? undefined : Number(ad.dataset.s));
    return;
  }
  const hd = e.target.closest('.tlhead');
  if (hd){ openBlockInfo(hd.dataset.k); return; }
  const sb = e.target.closest('.stepsBtn');
  if (sb){ openStepsSheet(sb.dataset.sid); return; }
  const row = e.target.closest('.tlrow'); if (!row) return;
  if (editing){ openEd(row.dataset.l, row.dataset.id); return; }
  const chk = e.target.closest('.tlcheck');
  if (chk){
    if (row.dataset.locked === '1') return;
    const key = row.dataset.id, i = done.ids.indexOf(key);
    if (i === -1) done.ids.push(key); else done.ids.splice(i, 1);
    if (navigator.vibrate) navigator.vibrate(i === -1 ? 12 : 6);
    saveDay(); render(); if (i === -1) offerTickAll(key); return;
  }
  openTaskSheet(row.dataset.l, row.dataset.id);
});
// ============================================================
// NOW BANNER, CHIME, CLOCK
// ============================================================
let lastNowId = undefined;
function chime(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.6);
  }catch{}
}
function drawNowBanner(rows){
  const NM = nowM(), cur = rows.find(r => r.use > 0 && !r.sug && NM >= r.start && NM < r.end);
  if (lastNowId === undefined) lastNowId = cur ? cur.id : null;
  else if ((cur ? cur.id : null) !== lastNowId){ lastNowId = cur ? cur.id : null; chime(); }
  const b = $('#nowBanner');
  if (!cur){ b.classList.remove('show'); return; }
  const st = WIN_STYLE[cur.w] || WIN_STYLE.climb1, left = cur.end - NM;
  $('#nb-i').innerHTML = iconMarkup(cur.icon || st.i);
  { const nt = 'Now: ' + cur.t; if ($('#nb-t').textContent !== nt) $('#nb-t').textContent = nt; }
  $('#nb-s').textContent = (left <= 1 ? 'less than a minute left' : left + ' min left');
  b.style.setProperty('--nb', cur.color || st.c);
  b.classList.add('show');
}
function drawClock(){ $('#clk').textContent = fmt(nowM()).join(' '); }
drawClock(); setInterval(drawClock, 15000);
function dayTick(){
  if (todayStr() !== lastToday){ const was = viewDate === lastToday; lastToday = todayStr(); if (was){ goDate(lastToday); return; } }
  if (viewDate === todayStr() && !document.querySelector('.hday[open]') && noteEditing === null && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) draw();
}
setInterval(dayTick, 20000);
$('#dnote').value = day.note || '';
$('#dnote').addEventListener('input', e => { day.note = e.target.value; saveDay(); });
// ============================================================
// IMPORT / EXPORT / RESET
// ============================================================
// Backup files keep the v2 layout (keys carry the yotei_v2_ prefix), so they stay readable by older versions.
function backupData(){ const o = {}; Object.entries(store.dump()).forEach(([k, v]) => { o['yotei_v2_' + k] = v; }); return o; }
function exportData(){
  const o = backupData();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app:'yotei', v:3, data:o })], { type:'application/json' }));
  a.download = 'yotei-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove(); store.set('lastBackup', Date.now()); updateBackupInfo();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importData(file){
  if (file.size > 8 * 1024 * 1024){ alert('That file is too large to be a Yotei backup. Nothing was changed.'); return; }
  const r = new FileReader();
  r.onload = async () => {
    let j = null;
    try{ j = JSON.parse(r.result); }catch{}
    const P = 'yotei_v2_';
    const chk = validateBackup(j, P);
    if (!chk.ok){ alert('That file can\'t be used as a Yotei backup because ' + chk.why + '. Nothing was changed.'); return; }
    if (!confirm('Replace everything in Yotei with this backup?')) return;
    const old = store.dump(); let data = {};
    Object.keys(j.data).forEach(k => { data[k.slice(P.length)] = j.data[k]; });
    if (needsDateMigration(data)) data = migrateDates(data);   // backups from v2 use the old day format
    try{ await makeSnapshot('before-import'); }catch{}
    try{ await replaceAll(data); }
    catch{
      try{ await replaceAll(old); }catch{}
      alert('Import failed, possibly because storage is full. Your previous data was restored.');
      return;
    }
    location.reload();
  };
  r.readAsText(file);
}
$('#rst').addEventListener('click', () => { if (confirm('Remove every routine task and reset all block names, colors and times? Your history is kept. You can undo this right after.')){ const snap = grab(); ['blocks', 'wins', 'ovr', 'wovr'].forEach(k => store.remove(k)); render(); showUndo('Routine reset', snap); } });
$('#exp').onclick = exportData;
async function openSnaps(){
  const why = { daily:'Daily', 'before-import':'Before an import', 'before-restore':'Before a restore', 'before-upgrade':'Before the update' };
  let L = []; try{ L = await listSnapshots(); }catch{}
  $('#snapList').innerHTML = L.length
    ? L.map(x => '<div class="snapRow"><span>' + esc(new Date(x.at).toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })) + ' · ' + esc(why[x.reason] || x.reason) + '</span><button data-id="' + esc(x.id) + '">Restore</button></div>').join('')
    : '<p class="wn">' + (info().backend === 'idb' ? 'No snapshots yet. The first one is saved the next time you open Yotei on a new day.' : 'Snapshots are not available in this browser.') + '</p>';
  $('#snapDlg').showModal();
}
$('#snapBtn').onclick = openSnaps;
$('#snap_x').onclick = () => $('#snapDlg').close();
$('#snapList').addEventListener('click', async e => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  if (!confirm('Replace everything in Yotei with this snapshot? Your current data is saved as a snapshot first.')) return;
  try{ await restoreSnapshot(b.dataset.id); location.reload(); }catch{ alert('Could not restore that snapshot. Nothing was changed.'); }
});
$('#imp').onclick = () => $('#impf').click();
$('#impf').onchange = e => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ''; };
let lastToday = todayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && todayStr() !== lastToday){ lastToday = todayStr(); goDate(lastToday); }
});
$('#tl').addEventListener('toggle', e => {
  const d = e.target;
  if (d.dataset && d.dataset.k){ openState[d.dataset.k] = d.open; store.set('open', openState); }
}, true);
const openPicker = () => { const p = $('#datePick'); try{ if (p.showPicker) p.showPicker(); else p.click(); }catch{} };
$('#dateBtn').addEventListener('click', openPicker);
$('#datePick').addEventListener('click', openPicker);
$('#todayBtn').addEventListener('click', () => goDate(todayStr()));
$('#datePick').addEventListener('change', e => {
  if (!e.target.value) return;
  const [y, mo, dd] = e.target.value.split('-').map(Number);
  goDate(isoLocal(new Date(y, mo - 1, dd)));
});
// ============================================================
// GESTURES — long-press to edit, swipe on the week strip
// ============================================================
let lpTimer = null, lpFired = false, lpX = 0, lpY = 0;
function lpClear(){ clearTimeout(lpTimer); lpTimer = null; }
$('#tl').addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest('.dragH')) return;
  const row = e.target.closest('.tlrow'), head = e.target.closest('.tlhead');
  if (!row && !head) return;
  lpFired = false; lpX = e.clientX; lpY = e.clientY;
  lpTimer = setTimeout(() => {
    lpFired = true;
    if (navigator.vibrate) navigator.vibrate(12);
    if (row) dragCand = { row, x:lpX, y:lpY }; else openBlockEd(head.dataset.k);
  }, 420);
});
$('#tl').addEventListener('pointermove', e => { if (lpTimer && (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10)) lpClear(); });
['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, () => { lpClear(); setTimeout(() => { lpFired = false; }, 50); }));
$('#tl').addEventListener('contextmenu', e => { if (e.target.closest('.tlrow, .tlhead')) e.preventDefault(); });
let swX = null, swY = null, swFired = false;
$('#weekstrip').addEventListener('pointerdown', e => { swX = e.clientX; swY = e.clientY; swFired = false; });
$('#weekstrip').addEventListener('pointerup', e => {
  if (swX === null) return;
  const dx = e.clientX - swX, dy = e.clientY - swY;
  swX = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)){
    swFired = true;
    const d = parseDay(viewDate); d.setDate(d.getDate() + (dx < 0 ? 7 : -7));
    goDate(isoLocal(d));
  }
});
let dsX = null, dsY = null, dsT = 0, dsFired = 0;
const dsSkip = '.modeWrap,.mode,.noteEdit,.dragH,input,textarea,select,button.add,.wakerow';
$('.panel').addEventListener('pointerdown', e => {
  dsX = (drag || dragCand || e.target.closest(dsSkip)) ? null : e.clientX; dsY = e.clientY; dsT = Date.now();
});
$('.panel').addEventListener('pointerup', e => {
  if (dsX === null) return;
  const dx = e.clientX - dsX, dy = e.clientY - dsY; dsX = null;
  if (drag || dragCand || Date.now() - dsT > 800) return;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5){
    dsFired = Date.now();
    const d = parseDay(viewDate); d.setDate(d.getDate() + (dx < 0 ? 1 : -1));
    goDate(isoLocal(d));
  }
});
$('.panel').addEventListener('pointercancel', () => { dsX = null; });
$('.panel').addEventListener('click', e => { if (Date.now() - dsFired < 400){ e.stopPropagation(); e.preventDefault(); } }, true);
function setTopH(){ const t = document.querySelector('.top'); if (t) document.documentElement.style.setProperty('--topH', t.getBoundingClientRect().height + 'px'); }
setTopH(); window.addEventListener('resize', setTopH);
if (window.ResizeObserver) new ResizeObserver(setTopH).observe(document.querySelector('.top'));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(setTopH);
$('#weekstrip').addEventListener('click', e => {
  if (swFired){ swFired = false; return; }
  const b = e.target.closest('.wd'); if (!b) return;
  goDate(b.dataset.d);
});
// ============================================================
// TABS & INIT
// ============================================================
$('#tl').addEventListener('keydown', e => {
  const sb = e.target.closest && e.target.closest('.stepsBtn');
  if (sb && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); e.stopPropagation(); openStepsSheet(sb.dataset.sid); }
});
// ============================================================
// ABOUT & CHANGELOG (Settings tab)
// To ship a release: add an entry at the TOP of CHANGELOG, bump
// APP_VERSION, and bump the CACHE name in sw.js so devices update.
// ============================================================
// ============================================================
// RUN MODE, STREAKS + WEEK VIEW, TEMPLATES, REMINDERS
// ============================================================
let run = null, runTimer = null, wakeLock = null;
function runStart(k){
  const q = schedule().rows.filter(r => r.w === k && r.use > 0 && !r.sug && !done.ids.includes(r.id));
  if (!q.length) return;
  run = { k, q, i:0, left:q[0].use * 60, paused:false, last:Date.now(), beeped:false };
  runDraw(); $('#runDlg').showModal();
  clearInterval(runTimer); runTimer = setInterval(runTick, 250);
  try{ if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {}); }catch{}
}
function runBeep(){
  try{
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    const A = new (window.AudioContext || window.webkitAudioContext)(), o = A.createOscillator(), g = A.createGain();
    o.connect(g); g.connect(A.destination); o.frequency.value = 660; g.gain.value = .08; o.start();
    setTimeout(() => { o.stop(); A.close(); }, 350);
  }catch{}
}
function runDraw(){
  const r = run.q[run.i], st = WIN_STYLE[run.k];
  $('#runStep').textContent = 'Step ' + (run.i + 1) + ' of ' + run.q.length;
  $('#runIcon').innerHTML = iconMarkup(r.icon || guessIcon(r.t) || st.i);
  $('#runTitle').textContent = r.t;
  $('#runDet').textContent = r.details || '';
  $('#runPause').textContent = run.paused ? 'Resume' : 'Pause';
  $('#runDone').textContent = run.i === run.q.length - 1 ? 'Finish' : 'Done';
  runTick();
}
function runTick(){
  if (!run) return;
  const now = Date.now();
  if (!run.paused) run.left -= (now - run.last) / 1000;
  run.last = now;
  const total = run.q[run.i].use * 60, over = run.left < 0, sec = Math.ceil(Math.abs(run.left));
  $('#runTime').textContent = (over ? '+' : '') + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  $('#runTime').classList.toggle('over', over);
  $('#runBar').style.width = Math.max(0, Math.min(100, (1 - run.left / total) * 100)) + '%';
  if (over && !run.beeped){ run.beeped = true; runBeep(); }
}
function runNext(mark){
  const r = run.q[run.i];
  if (mark && !done.ids.includes(r.id)){ done.ids.push(r.id); saveDay(); }
  run.i++;
  if (run.i >= run.q.length){ runEnd(); return; }
  run.left = run.q[run.i].use * 60; run.beeped = false; run.last = Date.now(); runDraw();
}
function runEnd(){
  clearInterval(runTimer); run = null;
  try{ if (wakeLock) wakeLock.release(); }catch{}
  wakeLock = null;
  if ($('#runDlg').open) $('#runDlg').close();
  render();
}
$('#runPause').onclick = () => { run.paused = !run.paused; run.last = Date.now(); runDraw(); };
$('#runPlus').onclick = () => { run.left += 60; run.beeped = false; runTick(); };
$('#runSkip').onclick = () => runNext(false);
$('#runDone').onclick = () => runNext(true);
$('#runClose').onclick = runEnd;
$('#runDlg').addEventListener('close', () => { if (run) runEnd(); });
$('#tl').addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('.runBtn');
  if (b){ e.stopPropagation(); runStart(b.dataset.run); }
}, true);

let weekOff = 0;
const dayPct = h => { const rs = (h.rows || []).filter(r => r.u > 0 && !r.sug); return rs.length ? rs.filter(r => r.done).length / rs.length : null; };
function streaks(H){
  const ok = d => H[d] && (dayPct(H[d]) || 0) >= .7;
  const days = Object.keys(H).sort(cmpDay);
  let best = 0, len = 0, prev = null;
  days.forEach(d => {
    if (ok(d)){ len = prev && Math.round((parseDay(d) - prev) / 864e5) === 1 ? len + 1 : 1; prev = parseDay(d); best = Math.max(best, len); }
    else { len = 0; prev = null; }
  });
  let cur = 0; const c = parseDay(todayStr());
  if (!ok(isoLocal(c))) c.setDate(c.getDate() - 1);
  while (ok(isoLocal(c))){ cur++; c.setDate(c.getDate() - 1); }
  return { cur, best };
}
function weekHtml(H){
  const base = new Date(mondayOf(todayStr())); base.setDate(base.getDate() + weekOff * 7);
  let cols = '', sum = 0, cnt = 0;
  for (let i = 0; i < 7; i++){
    const d = new Date(base); d.setDate(base.getDate() + i);
    const ds = isoLocal(d), p = H[ds] ? dayPct(H[ds]) : null, pc = p === null ? null : Math.round(p * 100);
    if (pc !== null){ sum += pc; cnt++; }
    cols += '<button class="wcol' + (ds === todayStr() ? ' today' : '') + '" data-d="' + ds + '"><span class="wbar"><i style="height:' + (pc || 0) + '%"></i></span><span>' + d.toLocaleDateString(undefined, { weekday:'short' }) + '</span><span>' + (pc === null ? '-' : pc + '%') + '</span></button>';
  }
  const end = new Date(base); end.setDate(base.getDate() + 6);
  const f = x => x.toLocaleDateString(undefined, { month:'short', day:'numeric' });
  return '<div class="sleep"><h2>' + (weekOff === 0 ? 'This week' : weekOff === -1 ? 'Last week' : 'Week view') + '</h2><div class="wkNav"><button data-wk="-1" aria-label="Previous week">&lsaquo;</button><span>' + f(base) + ' to ' + f(end) + '</span><button data-wk="1" aria-label="Next week"' + (weekOff >= 0 ? ' disabled' : '') + '>&rsaquo;</button></div><div class="wk">' + cols + '</div><p class="wn">' + (cnt ? 'Average ' + Math.round(sum / cnt) + '% over ' + cnt + ' tracked day' + (cnt === 1 ? '' : 's') + '. Tap a day to open it.' : 'No tracked days this week.') + '</p></div>';
}
$('#trends').addEventListener('click', e => {
  const ch = e.target.closest('[data-chr]');
  if (ch){ store.set('chrono', ch.dataset.chr); if ($('#chrSel')) $('#chrSel').value = ch.dataset.chr; render(); $('#trends').innerHTML = trendsHtml(); toast('Energy rhythm updated'); return; }
  const n = e.target.closest('[data-wk]');
  if (n){ if (!n.disabled){ weekOff = Math.min(0, weekOff + Number(n.dataset.wk)); $('#trends').innerHTML = trendsHtml(); } return; }
  const c = e.target.closest('.wcol');
  if (c){ setTab('home'); goDate(c.dataset.d); }
});

function tplApply(list, name){
  const bl = store.get('blocks', null) || {};
  bl[list] = TPL[list].sets[name].map((x, i) => ({ id:'t' + Date.now().toString(36) + i, t:x[0], d:x[1], m:x[2], p:x[3] }));
  store.set('blocks', bl);
}
function applyTpl(list, name){
  const min = TPL[list].sets[name].reduce((a, x) => a + x[1], 0);
  if (!confirm('Replace your ' + TPL[list].label.toLowerCase() + ' with "' + name + '" (' + min + ' min)? Your current list for this routine will be overwritten.')) return;
  tplApply(list, name); render();
}
function remCard(){
  const R = store.get('rem', { on:false, lead:0 }), has = 'Notification' in window, perm = has ? Notification.permission : 'unsupported', on = R.on && perm === 'granted';
  const state = !has ? 'Notifications are not available in this browser. On iPhone, add Yotei to your Home Screen first.' : perm === 'denied' ? 'Notifications are blocked. Allow them for this site in your browser settings.' : on ? 'Reminders are on.' : 'Reminders are off.';
  return '<h2>Reminders</h2><p class="wn">' + state + '</p><p class="wn">They only fire while Yotei is open or running in the background, and phones may pause web apps. Keep Yotei open if timing matters.</p><div class="capRow"><label for="remLead">Remind me</label><select id="remLead">' + [[0, 'At start'], [5, '5 min before'], [10, '10 min before']].map(o => '<option value="' + o[0] + '"' + (R.lead === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div><div class="ea"><button id="remToggle">' + (on ? 'Turn off' : 'Turn on') + '</button><button id="remTest">Send test</button></div>';
}
async function notify(title, body, tag){
  try{
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && reg.showNotification){ await reg.showNotification(title, { body, tag, icon:'icon-192.png', badge:'icon-192.png', vibrate:[120, 60, 120] }); return; }
  }catch{}
  try{ new Notification(title, { body, tag, icon:'icon-192.png' }); }catch{}
}
function remCheck(){
  const R = store.get('rem', { on:false, lead:0 });
  if (!R.on || !('Notification' in window) || Notification.permission !== 'granted') return;
  const ds = todayStr(), sv = { wake, day, done };
  let rows = [], dn = [];
  try{ loadDay(ds); rows = build(new Date().getDay()).rows; dn = done.ids.slice(); }
  finally{ wake = sv.wake; day = sv.day; done = sv.done; }
  const sent = store.get('remSent', null), S = sent && sent.d === ds ? sent : { d:ds, ids:[] }, nm = nowM();
  let ch = false;
  rows.filter(r => r.use > 0 && !r.sug && !dn.includes(r.id)).forEach(r => {
    const key = r.id + '@' + r.start;
    if (nm >= r.start - R.lead && nm < r.start + 3 && !S.ids.includes(key)){
      S.ids.push(key); ch = true;
      notify(R.lead ? r.t + ' in ' + R.lead + ' min' : 'Time for ' + r.t, range(r.start, r.end), key);
    }
  });
  if (ch) store.set('remSent', S);
}
setInterval(remCheck, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') remCheck(); });
$('#tab-settings').insertAdjacentHTML('beforeend',
  '<div class="sleep" id="remCard">' + remCard() + '</div>' +
  '<div class="sleep"><h2>Routine templates</h2><p class="wn">Start from a ready-made routine, then edit it however you like.</p>' +
  Object.keys(TPL).map(l => '<p class="tplRow">' + TPL[l].label + '</p><div class="ea">' + Object.keys(TPL[l].sets).map(n => '<button data-tpl="' + l + '|' + n + '">' + n + '</button>').join('') + '</div>').join('') + '</div>');
$('#tab-settings').addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.tpl){ const [l, n] = t.dataset.tpl.split('|'); applyTpl(l, n); return; }
  if (t.id === 'remToggle'){
    const R = store.get('rem', { on:false, lead:0 });
    if (R.on) R.on = false;
    else if ('Notification' in window){ const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); R.on = p === 'granted'; }
    store.set('rem', R); $('#remCard').innerHTML = remCard();
  }
  if (t.id === 'remTest'){
    if ('Notification' in window && Notification.permission === 'granted') notify('Yotei', 'Reminders are working.', 'test');
    else alert('Turn on reminders first.');
  }
});
$('#tab-settings').addEventListener('change', e => {
  if (e.target.id !== 'remLead') return;
  const R = store.get('rem', { on:false, lead:0 }); R.lead = Number(e.target.value); store.set('rem', R);
});

// ============================================================
// ONE-OFF TASKS + INBOX, PAST-DAY RECORDS, ENERGY, CALENDAR IMPORT,
// APPEARANCE, FIRST-RUN SETUP
// ============================================================
function snapMode(){ return viewDate < todayStr() && !day.live && !!store.get('hist', {})[viewDate]; }
function snapRows(){
  if (!snapMode()) return null;
  return (store.get('hist', {})[viewDate].rows || []).map(r => ({ id:r.id, t:r.t, w:r.w, md:r.md || undefined, start:r.s, end:r.e, use:r.u, d:r.u, sug:!!r.sug, post:r.w !== 'sleep', p:'core', snap:true }));
}
$('#liveBtn').addEventListener('click', () => { day.live = true; saveDay(); render(); });

function defaultWin(){
  if (viewDate !== todayStr()) return 'climb1';
  const WB = wins(), n = nowM() - wake;
  for (const k of Object.keys(WB)) if (n >= WB[k].from && n < WB[k].to) return k;
  return 'climb1';
}
$('#dnote').parentElement.insertAdjacentHTML('beforebegin', '<div class="sleep inbox" id="inboxCard"></div>');
$('#tab-inbox').appendChild($('#inboxCard'));
function drawInbox(){
  const el = $('#inboxCard'); if (!el) return;
  const keep = $('#inT') ? $('#inT').value : '', list = store.get('inbox', []);
  el.innerHTML = '<h2>Inbox</h2><p class="wn">Capture a task now. Schedule it when you know when.</p><div class="inRow"><input id="inT" placeholder="Add a task" maxlength="80" aria-label="New inbox task"><button id="inAdd">Add</button></div>' +
    list.map(x => '<div class="inItem"><span>' + esc(x.t) + '</span><span class="inAct"><button data-sch="' + x.id + '">Schedule</button><button data-rm="' + x.id + '" aria-label="Delete ' + esc(x.t) + '">&times;</button></span></div>').join('') +
    '';
  $('#inT').value = keep;
}
$('#inboxCard').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'inAdd'){
    const v = $('#inT').value.trim(); if (!v) return;
    const l = store.get('inbox', []); l.push({ id:'i' + Date.now().toString(36), t:v }); store.set('inbox', l);
    $('#inT').value = ''; drawInbox();
  } else if (b.dataset.rm){ const _s = grab(); store.set('inbox', store.get('inbox', []).filter(x => x.id !== b.dataset.rm)); drawInbox(); showUndo('Removed from inbox', _s); }
  else if (b.dataset.sch){
    const it = store.get('inbox', []).find(x => x.id === b.dataset.sch);
    if (it){ openEd('oo', null, defaultWin()); $('#e_t').value = it.t; cur.fromInbox = it.id; }
  } else if (b.id === 'ooNew') openEd('oo', null, defaultWin());
  else if (b.id === 'cpDay') openMv('day');
  else if (b.id === 'lateBtn') openShift();
});
$('#inboxCard').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'inT'){ e.preventDefault(); $('#inAdd').click(); } });

function energyHtml(H){
  const wr = {};
  Object.values(H).forEach(h => (h.rows || []).forEach(r => { if (r.u <= 0 || r.sug || !r.w) return; const o = wr[r.w] || (wr[r.w] = { d:0, t:0 }); o.t++; if (r.done) o.d++; }));
  const WB = wins(), ks = Object.keys(wr).filter(k => wr[k].t >= 5 && WB[k]).sort((a, b) => wr[b].d / wr[b].t - wr[a].d / wr[a].t);
  if (ks.length < 2) return '';
  const pc = k => Math.round(wr[k].d / wr[k].t * 100), best = ks[0], worst = ks[ks.length - 1];
  return '<div class="sleep"><h2>Your energy, from your data</h2><p class="wn">You finish the most in ' + esc(WB[best].name) + ' (' + pc(best) + '%) and the least in ' + esc(WB[worst].name) + ' (' + pc(worst) + '%). Try putting your hardest tasks in your strongest window.</p>' +
    ks.map(k => '<div class="trow"><span class="tlab wide">' + esc(WB[k].name) + '</span><div class="tbar"><div class="tfill" style="width:' + pc(k) + '%"></div></div><span class="tpct">' + pc(k) + '%</span></div>').join('') + '</div>';
}

// ---- calendar (.ics) import ----
function icsDate(v){
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/.exec(v.trim()); if (!m) return null;
  if (m[4] === undefined) return { allDay:true };
  return { d: m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) };
}
function parseICS(txt){
  const L = txt.replace(/\r/g, '').replace(/\n[ \t]/g, '').split('\n'), ev = []; let c = null;
  L.forEach(l => {
    if (l === 'BEGIN:VEVENT') c = {};
    else if (l === 'END:VEVENT'){ if (c) ev.push(c); c = null; }
    else if (c){
      const i = l.indexOf(':'); if (i < 0) return;
      const key = l.slice(0, i).split(';')[0].toUpperCase(), val = l.slice(i + 1);
      if (key === 'DTSTART') c.s = icsDate(val); else if (key === 'DTEND') c.e = icsDate(val);
      else if (key === 'SUMMARY') c.t = val.replace(/\\n/gi, ' ').replace(/\\([,;])/g, '$1').replace(/\\\\/g, '\\');
      else if (key === 'RRULE') c.r = true;
    }
  });
  return ev;
}
function importICS(txt){
  const today = parseDay(todayStr()), lo = new Date(today), hi = new Date(today);
  lo.setDate(lo.getDate() - 30); hi.setDate(hi.getDate() + 90);
  const r = { added:0, allDay:0, rec:0, out:0 }, WB = wins();
  parseICS(txt).forEach(e => {
    if (!e.s || !e.t) return;
    if (e.s.allDay){ r.allDay++; return; }
    if (e.r) r.rec++;
    if (e.s.d < lo || e.s.d > hi){ r.out++; return; }
    const ds = isoLocal(e.s.d), start = e.s.d.getHours() * 60 + e.s.d.getMinutes();
    let dur = e.e && e.e.d ? Math.round((e.e.d - e.s.d) / 60000) : 30; if (!(dur > 0)) dur = 30; dur = Math.min(dur, 600);
    const p = plans[ds] || planFor(ds) || { w:defWake(), d:[], t:{}, a:false, n:'' }, n = start - p.w;
    let w = 'climb1'; for (const k of Object.keys(WB)) if (n >= WB[k].from && n < WB[k].to) w = k;
    const id = 'ics' + [...(ds + start + e.t)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7).toString(36);
    p.o = (p.o || []).filter(x => x.id !== id).concat({ id, t:e.t.slice(0, 80), d:dur, m:dur, p:'core', fixed:start, w, icon:'calendar' });
    plans[ds] = p; r.added++;
  });
  store.set('plans', plans); loadDay(viewDate); render();
  return r;
}

// ---- appearance + settings cards ----
function applyLook(){
  const T = store.get('theme', 'dark'), th = T === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : T;
  document.documentElement.dataset.theme = th; document.documentElement.dataset.text = store.get('text', 'normal');
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = th === 'light' ? '#f3f5fb' : '#1c1c1e';
}
const selOpts = (arr, cur) => arr.map(o => '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>').join('');
$('#tab-settings').insertAdjacentHTML('beforeend',
  '<div class="sleep"><h2>Energy rhythm</h2><p class="wn">Shifts when your energy windows start: 30 min earlier, as planned, or 45 min later.</p><div class="capRow"><label for="chrSel">Rhythm</label><select id="chrSel">' + selOpts([['early', 'Early bird'], ['normal', 'In between'], ['late', 'Night owl']], store.get('chrono', 'normal')) + '</select></div></div>' +
  '<div class="sleep"><h2>Appearance</h2><div class="capRow"><label for="thSel">Theme</label><select id="thSel">' + selOpts([['dark', 'Dark'], ['light', 'Light'], ['auto', 'Match device']], store.get('theme', 'dark')) + '</select></div><div class="capRow"><label for="clkSel">Clock</label><select id="clkSel">' + selOpts([['12', '12-hour'], ['24', '24-hour']], store.get('clock', '12')) + '</select></div><div class="capRow"><label for="txSel">Text size</label><select id="txSel">' + selOpts([['normal', 'Normal'], ['large', 'Large']], store.get('text', 'normal')) + '</select></div></div>' +
  '<div class="sleep"><h2>Calendar import</h2><p class="wn">Import a .ics file from Google, Apple or Outlook calendar. Timed events become fixed-time one-off tasks (30 days back, 90 ahead, in your device time zone). All-day events are skipped, and recurring events import only their first occurrence.</p><button class="add" id="icsBtn">Choose .ics file</button><input type="file" id="icsF" accept=".ics,text/calendar" hidden></div>');
$('#tab-settings').addEventListener('change', e => {
  if (e.target.id === 'chrSel'){ store.set('chrono', e.target.value); render(); }
  else if (e.target.id === 'thSel'){ store.set('theme', e.target.value); applyLook(); }
  else if (e.target.id === 'txSel'){ store.set('text', e.target.value); applyLook(); }
  else if (e.target.id === 'clkSel'){ store.set('clock', e.target.value); CLOCK24 = e.target.value === '24'; drawClock(); render(); }
});
$('#icsBtn').addEventListener('click', () => $('#icsF').click());
$('#icsF').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    const r = importICS(String(rd.result));
    alert('Imported ' + r.added + ' event' + (r.added === 1 ? '' : 's') + '.' + (r.allDay ? ' Skipped ' + r.allDay + ' all-day.' : '') + (r.out ? ' Skipped ' + r.out + ' outside the date range.' : '') + (r.rec ? ' ' + r.rec + ' recurring (first occurrence only).' : ''));
  };
  rd.readAsText(f); e.target.value = '';
});
applyLook();

// ---- first-run setup ----
function openSetup(){
  const opt = l => '<option value="">Start empty</option>' + Object.keys(TPL[l].sets).map(n => '<option>' + n + '</option>').join('');
  $('#su_pre').innerHTML = opt('pre'); $('#su_night').innerHTML = opt('night');
  $('#setupDlg').showModal();
}
$('#su_ok').onclick = () => {
  const [h, m] = ($('#su_wake').value || '05:00').split(':').map(Number);
  store.set('wake', h * 60 + m); store.set('chrono', $('#su_chrono').value); $('#chrSel').value = $('#su_chrono').value;
  if ($('#su_pre').value) tplApply('pre', $('#su_pre').value);
  if ($('#su_night').value) tplApply('night', $('#su_night').value);
  store.set('setup', true); $('#setupDlg').close(); goDate(todayStr());
};
$('#su_skip').onclick = () => { store.set('setup', true); $('#setupDlg').close(); };

// ============================================================
// SCOPED EDITS, MOVE / COPY, COPY DAY, RUNNING LATE
// ============================================================
function diffBlock(o, n){
  const nd = x => { const y = { ...x }; if (Array.isArray(y.days) && y.days.length === 7) delete y.days; return y; };
  o = nd(o); n = nd(n);
  const p = {};
  new Set([...Object.keys(o), ...Object.keys(n)]).forEach(k => {
    if (k !== 'id' && JSON.stringify(o[k]) !== JSON.stringify(n[k])) p[k] = n[k] === undefined ? null : n[k];
  });
  return p;
}
let scopeCtx = null, scDays = [], scModes = [];
function drawScChips(){
  $('#sc_days').innerHTML = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((n, i) => '<button type="button" data-i="' + i + '"' + (scDays.includes(i) ? ' class="on"' : '') + '>' + n + '</button>').join('');
  $('#sc_modes').innerHTML = ['home', 'school', 'away'].map(m => '<button type="button" data-m="' + m + '"' + (scModes.includes(m) ? ' class="on"' : '') + '>' + MODE_LABEL[m] + ' days</button>').join('');
}
function askScope(type, ctx){
  scopeCtx = { type, ...ctx }; scDays = []; scModes = [];
  const when = parseDay(viewDate).toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  $('#sc_h').textContent = type === 'reset' ? 'Reset this block for' : type === 'delete' ? 'Delete this task for' : type === 'add' ? 'Add this task to' : 'Apply this change to';
  $('#sc_opts').innerHTML = [['day', 'Only this day (' + when + ')'], ['from', 'This day and the days after'], ['all', 'All days']].map(a => '<button data-sc="' + a[0] + '">' + a[1] + '</button>').join('');
  $('#sc_modes').style.display = (ctx.l === 'pre' || ctx.l === 'night') ? '' : 'none';
  drawScChips(); $('#scopeDlg').showModal();
}
function applyScope(sc){ const _s = grab(), ty = scopeCtx && scopeCtx.type; needLive(); applyScope0(sc); showUndo(ty === 'delete' ? 'Task deleted' : ty === 'add' ? 'Task added' : 'Task updated', _s); }
function applyScope0(sc){
  const c = scopeCtx; if (!c) return;
  if (c.l === 'win'){ applyWinScope(sc, c); return; }
  const iso = viewDate, filt = {}, OV = store.get('ovr', {}), arr = clone(getBlocks(c.l));
  if (scDays.length) filt.days = scDays.slice().sort();
  if (scModes.length && (c.l === 'pre' || c.l === 'night')) filt.modes = scModes.slice();
  const hasFilt = !!(filt.days || filt.modes), push = (id, e) => { (OV[id] = OV[id] || []).push(e); };
  const range_ = { from:sc === 'all' ? null : iso, to:sc === 'day' ? iso : null };
  if (c.type === 'add'){
    if (sc === 'day'){
      const o = { ...c.b, w:c.w || (c.l === 'pre' ? 'sleep' : c.l === 'night' ? 'wind' : 'climb1') };
      delete o.days; delete o.modes;
      day.oneoffs = (day.oneoffs || []).concat(o); saveDay();
    } else {
      const b = { ...c.b, ...filt }; if (sc === 'from') b.from = iso;
      arr.push(b); setBlocks(c.l, arr);
      if (c.l !== 'pre' && c.l !== 'night' && c.w && !typeOf(c.w)){ day.types[c.w] = c.l; saveDay(); }
    }
  } else if (c.type === 'delete'){
    if (sc === 'all' && !hasFilt){ setBlocks(c.l, arr.filter(x => x.id !== c.id)); delete OV[c.id]; }
    else push(c.id, { ...range_, ...filt, patch:null });
  } else {
    const patch = diffBlock(c.old, c.b);
    if (Object.keys(patch).length){
      if (sc === 'all' && !hasFilt){
        { const bi = arr.findIndex(x => x.id === c.id), nb = { ...arr[bi] }; Object.keys(patch).forEach(k => { if (patch[k] === null) delete nb[k]; else nb[k] = patch[k]; }); arr[bi] = nb; } setBlocks(c.l, arr);
        (OV[c.id] || []).forEach(e => { if (e.patch) Object.keys(patch).forEach(k => delete e.patch[k]); });
        OV[c.id] = (OV[c.id] || []).filter(e => e.patch === null || Object.keys(e.patch).length);
        if (!OV[c.id].length) delete OV[c.id];
      } else push(c.id, { ...range_, ...filt, patch });
    }
  }
  store.set('ovr', OV); scopeCtx = null; $('#scopeDlg').close(); $('#ed').close(); render();
}
$('#sc_days').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const i = Number(b.dataset.i); scDays = scDays.includes(i) ? scDays.filter(x => x !== i) : scDays.concat(i); drawScChips(); });
$('#sc_modes').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const m = b.dataset.m; scModes = scModes.includes(m) ? scModes.filter(x => x !== m) : scModes.concat(m); drawScChips(); });
$('#sc_opts').addEventListener('click', e => { const b = e.target.closest('button'); if (b) applyScope(b.dataset.sc); });
$('#sc_x').onclick = () => $('#scopeDlg').close();
$('#e_del').onclick = () => {
  if (cur.l === 'oo'){ const _s = grab(); needLive(); setBlocks('oo', clone(getBlocks('oo')).filter(x => x.id !== cur.id)); $('#ed').close(); render(); showUndo('Task deleted', _s); return; }
  askScope(cur.l === 'win' ? 'reset' : 'delete', { l:cur.l, id:cur.id });
};
$('#ts_del').onclick = () => {
  if (sheetCtx.l === 'oo'){ if (!confirm('Delete this task?')) return; const _s = grab(); needLive(); setBlocks('oo', clone(getBlocks('oo')).filter(x => x.id !== sheetCtx.id)); $('#taskSheet').close(); render(); showUndo('Task deleted', _s); return; }
  $('#taskSheet').close(); askScope('delete', { l:sheetCtx.l, id:sheetCtx.id });
};

// ---- move / copy a task, copy a day ----
function winAt(n){ const WB = wins(); let w = 'climb1'; for (const k of Object.keys(WB)) if (n >= WB[k].from && n < WB[k].to) w = k; return w; }
function addOneOff(ds, o){
  if (ds === viewDate){ day.oneoffs = (day.oneoffs || []).concat(o); saveDay(); return; }
  const p = plans[ds] || planFor(ds) || { w:defWake(), d:[], t:{}, a:false, n:'' };
  p.o = (p.o || []).concat(o); plans[ds] = p; store.set('plans', plans);
}
let mvMode = 'task', shBy = 15;
function openMv(mode){
  mvMode = mode;
  const t = parseDay(viewDate); t.setDate(t.getDate() + 1);
  $('#mv_d').value = isoLocal(t); $('#mv_t').value = '';
  $('#mv_h').textContent = mode === 'day' ? 'Copy this day to' : 'Move or copy to';
  ['mv_tw', 'mv_inbox', 'mv_copy'].forEach(i => { $('#' + i).style.display = mode === 'day' ? 'none' : ''; });
  $('#mv_go').textContent = mode === 'day' ? 'Copy day' : 'Move';
  $('#mvDlg').showModal();
}
function mvDate(){ const v = $('#mv_d').value; if (!v) return null; const [y, m, d] = v.split('-').map(Number); return isoLocal(new Date(y, m - 1, d)); }
function mvDo(kind){ const _s = grab(); needLive(); mvDo0(kind); showUndo(kind === 'copy' ? 'Copied' : kind === 'inbox' ? 'Moved to inbox' : 'Moved', _s); }
function mvDo0(kind){
  const r = schedule().rows.find(x => x.id === sheetCtx.id); if (!r) return;
  const ds = kind === 'inbox' ? null : mvDate(); if (kind !== 'inbox' && !ds) return;
  const o = { id:'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), t:r.t, d:r.d !== undefined ? r.d : r.use };
  ['m', 'p', 'sug', 'icon', 'color', 'details', 'steps', 'fixed', 'at'].forEach(k => { if (r[k] !== undefined) o[k] = r[k]; });
  const tm = $('#mv_t').value;
  if (tm){ const [h, mi] = tm.split(':').map(Number); o.fixed = h * 60 + mi; if (!o.d) o.d = 20; }
  if (ds) o.w = o.fixed !== undefined ? winFor(o.fixed, (planFor(ds) || {}).w ?? defWake()) : (r.w || 'climb1');
  const removeHere = () => {
    if (sheetCtx.l === 'oo') day.oneoffs = (day.oneoffs || []).filter(x => x.id !== sheetCtx.id);
    else { const OV = store.get('ovr', {}), iso = viewDate; (OV[sheetCtx.id] = OV[sheetCtx.id] || []).push({ from:iso, to:iso, patch:null }); store.set('ovr', OV); }
  };
  if (kind === 'inbox'){ const l = store.get('inbox', []); l.push({ id:'i' + Date.now().toString(36), t:r.t }); store.set('inbox', l); removeHere(); }
  else { if (kind === 'move') removeHere(); addOneOff(ds, o); }
  saveDay(); $('#mvDlg').close(); render();
}
function copyDay(src, dst){
  const p = src === viewDate ? { w:wake, t:day.types, a:day.away, o:day.oneoffs || [], s:day.shift } : (planFor(src) || {});
  plans[dst] = { w:p.w ?? defWake(), d:[], t:{ ...(p.t || {}) }, a:!!p.a, n:'', p:null, o:(p.o || []).map(x => ({ ...x, id:x.id + 'c' + Math.random().toString(36).slice(2, 5) })), l:false, s:p.s || null };
  const OV = store.get('ovr', {}), si = src, di = dst;
  Object.keys(OV).forEach(id => OV[id].filter(e => e.from === si && e.to === si).forEach(e => OV[id].push({ ...e, from:di, to:di })));
  store.set('ovr', OV); store.set('plans', plans);
}
$('#ts_move').onclick = () => { $('#taskSheet').close(); openMv('task'); };
$('#mv_go').onclick = () => {
  if (mvMode === 'task'){ mvDo('move'); return; }
  const ds = mvDate(); if (!ds) return;
  if (ds === viewDate){ alert('Pick a different day.'); return; }
  if (plans[ds] && !confirm('That day already has a plan. Replace it?')) return;
  const _s = grab(); copyDay(viewDate, ds); $('#mvDlg').close(); goDate(ds); showUndo('Day copied', _s);
};
$('#mv_copy').onclick = () => mvDo('copy');
$('#mv_inbox').onclick = () => mvDo('inbox');
$('#mv_x').onclick = () => $('#mvDlg').close();

// ---- running late ----
function openShift(){
  shBy = day.shift ? day.shift.by : 15;
  $('#sh_from').value = toVal(day.shift ? day.shift.from : (viewDate === todayStr() ? nowM() : wake));
  document.querySelectorAll('#sh_chips button').forEach(b => b.classList.toggle('on', Number(b.dataset.m) === shBy));
  $('#sh_clear').style.display = day.shift ? '' : 'none';
  $('#shDlg').showModal();
}
$('#sh_chips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; shBy = Number(b.dataset.m); document.querySelectorAll('#sh_chips button').forEach(x => x.classList.toggle('on', x === b)); });
$('#sh_ok').onclick = () => { const [h, m] = ($('#sh_from').value || '00:00').split(':').map(Number); needLive(); day.shift = { from:h * 60 + m, by:shBy }; saveDay(); $('#shDlg').close(); render(); };
$('#sh_clear').onclick = () => { needLive(); day.shift = null; saveDay(); $('#shDlg').close(); render(); };
$('#sh_x').onclick = () => $('#shDlg').close();

// ============================================================
// UNDO + TOASTS, USUAL DAYS, ENERGY CHECK-INS, TASK INSIGHTS,
// ANY-TASK TIMER, WEEKLY REVIEW, SHARE BACKUP, DRAG AND DROP
// ============================================================
let toastT = null;
function toast(msg, label, fn){
  $('#toastMsg').textContent = msg;
  const b = $('#toastBtn'); b.style.display = label ? '' : 'none'; b.textContent = label || '';
  b.onclick = () => { $('#toast').classList.remove('show'); if (fn) fn(); };
  $('#toast').classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => $('#toast').classList.remove('show'), 7000);
}
const UNDO_KEYS = ['blocks', 'ovr', 'plans', 'inbox', 'taskNotes', 'hist', 'wins', 'wovr'];
function grab(){ const s = {}; UNDO_KEYS.forEach(k => { s[k] = store.raw(k); }); return s; }
function showUndo(msg, s){
  toast(msg, 'Undo', () => {
    UNDO_KEYS.forEach(k => store.setRaw(k, s[k]));
    plans = store.get('plans', {}); loadDay(viewDate); render();
  });
}

function usualTypes(ds){
  const m = store.get('usual', {})[dowOf(ds)]; if (!m) return {};
  const t = {}; ['climb1', 'peak', 'trough', 'climb2', 'wmz'].forEach(k => { t[k] = k === 'wmz' && m === 'school' ? 'home' : m; }); return t;
}
function drawUsual(){
  const U = store.get('usual', {}), nm = { '': 'None', home:'Home', school:'School', away:'Away' };
  $('#usualGrid').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(i => '<button class="uwb" data-i="' + i + '"><b>' + ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][i] + '</b><span>' + nm[U[i] || ''] + '</span></button>').join('');
}
$('#tab-settings').insertAdjacentHTML('beforeend', '<div class="sleep"><h2>Usual days</h2><p class="wn">Tap a weekday to set where you usually are. New days start with it already picked.</p><div class="wk" id="usualGrid"></div></div>');
drawUsual();
$('#usualGrid').addEventListener('click', e => {
  const b = e.target.closest('.uwb'); if (!b) return;
  const U = store.get('usual', {}), order = ['', 'home', 'school', 'away'], i = b.dataset.i;
  U[i] = order[(order.indexOf(U[i] || '') + 1) % 4]; if (!U[i]) delete U[i];
  store.set('usual', U); drawUsual();
});

$('#dnote').parentElement.insertAdjacentHTML('beforebegin', '<div class="sleep" id="energyCard"></div>');
function drawEnergy(){
  const el = $('#energyCard'); if (!el) return;
  if (viewDate !== todayStr() || snapMode()){ el.style.display = 'none'; return; }
  el.style.display = '';
  const L = store.get('energy', []), last = L[L.length - 1], names = ['Drained', 'Low', 'Okay', 'Good', 'Great'];
  el.innerHTML = '<h2>How is your energy?</h2><div class="enRow">' + names.map((n, i) => '<button data-en="' + (i + 1) + '" aria-label="' + (i + 1) + ', ' + n + '">' + (i + 1) + '</button>').join('') + '</div><p class="wn">1 is drained, 5 is great. ' + (last ? 'Last: ' + last.v + ' at ' + fmt(last.at).join(' ') + '.' : 'A few ratings a day teach Yotei your rhythm.') + '</p>';
}
$('#energyCard').addEventListener('click', e => {
  const b = e.target.closest('[data-en]'); if (!b) return;
  const L = store.get('energy', []); L.push({ v:Number(b.dataset.en), at:nowM(), o:nowM() - wake, w:defaultWin(), d:todayStr() });
  store.set('energy', L.slice(-500)); toast('Energy ' + b.dataset.en + ' saved'); drawEnergy();
});
function ratingsHtml(){
  const L = store.get('energy', []); if (L.length < 5) return '';
  const WB = wins(), by = {};
  L.forEach(r => { const o = by[r.w] || (by[r.w] = { s:0, n:0 }); o.s += r.v; o.n++; });
  const ks = Object.keys(by).filter(k => WB[k] && by[k].n >= 2).sort((a, b) => by[b].s / by[b].n - by[a].s / by[a].n);
  if (ks.length < 2) return '';
  const av = k => by[k].s / by[k].n, hi = L.filter(r => r.v >= 4); let sug = '';
  if (hi.length >= 6){
    const diff = hi.reduce((a, r) => a + r.o, 0) / hi.length - (WIN.peak.from + WIN.peak.to) / 2, want = diff <= -25 ? 'early' : diff >= 30 ? 'late' : 'normal';
    if (want !== store.get('chrono', 'normal')) sug = '<p class="wn">Your high-energy ratings cluster ' + (diff < 0 ? 'earlier' : 'later') + ' than the default. <button class="add" data-chr="' + want + '">Use ' + ({ early:'Early bird', normal:'In between', late:'Night owl' })[want] + '</button></p>';
  }
  return '<div class="sleep"><h2>Your energy ratings</h2><p class="wn">Strongest in ' + esc(WB[ks[0]].name) + ' (' + av(ks[0]).toFixed(1) + ' of 5), weakest in ' + esc(WB[ks[ks.length - 1]].name) + '.</p>' +
    ks.map(k => '<div class="trow"><span class="tlab wide">' + esc(WB[k].name) + '</span><div class="tbar"><div class="tfill" style="width:' + Math.round(av(k) / 5 * 100) + '%"></div></div><span class="tpct">' + av(k).toFixed(1) + '</span></div>').join('') + sug + '</div>';
}

function taskInsight(id){
  const H = store.get('hist', {}), days = Object.keys(H).sort((a, b) => cmpDay(b, a));
  let tot = 0, dn = 0, streak = 0, live = true;
  days.forEach(d => {
    const r = (H[d].rows || []).find(x => x.id === id && x.u > 0 && !x.sug); if (!r) return;
    if (d === todayStr() && !r.done) return;
    tot++; if (r.done){ dn++; if (live) streak++; } else live = false;
  });
  if (tot < 3) return '';
  const pc = Math.round(dn / tot * 100);
  return 'Done ' + dn + ' of ' + tot + ' days (' + pc + '%)' + (streak > 1 ? ', ' + streak + ' in a row' : '') + '.' + (tot >= 5 && pc < 40 ? ' You skip this often. Try shortening it or moving it to another window.' : '');
}
$('#ts_noteb').onclick = () => {
  noteEditing = sheetCtx.id; $('#taskSheet').close(); render();
  setTimeout(() => { const t = document.querySelector('.noteEdit .ntxt'); if (t){ t.scrollIntoView({ block:'center' }); t.focus(); } }, 60);
};
$('#ts_timer').onclick = () => {
  const r = schedule().rows.find(x => x.id === sheetCtx.id); $('#taskSheet').close();
  if (!r || !(r.use > 0)) return;
  run = { k:r.w, q:[r], i:0, left:r.use * 60, paused:false, last:Date.now(), beeped:false };
  runDraw(); $('#runDlg').showModal();
  clearInterval(runTimer); runTimer = setInterval(runTick, 250);
  try{ if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {}); }catch{}
};

function reviewHtml(H){
  const base = new Date(mondayOf(todayStr())); base.setDate(base.getDate() + weekOff * 7);
  let sum = 0, cnt = 0, bestD = null, bestP = -1; const skip = {}, win = {};
  for (let i = 0; i < 7; i++){
    const d = new Date(base); d.setDate(base.getDate() + i);
    const h = H[isoLocal(d)]; if (!h) continue;
    const p = dayPct(h); if (p === null) continue;
    sum += p; cnt++; if (p > bestP){ bestP = p; bestD = d; }
    (h.rows || []).forEach(r => {
      if (r.u <= 0 || r.sug) return;
      if (!r.done) skip[r.t] = (skip[r.t] || 0) + 1;
      if (r.w){ const o = win[r.w] || (win[r.w] = { d:0, t:0 }); o.t++; if (r.done) o.d++; }
    });
  }
  if (cnt < 3) return '';
  const WB = wins(), avg = Math.round(sum / cnt * 100);
  const sk = Object.entries(skip).filter(x => x[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const wk = Object.keys(win).filter(k => win[k].t >= 3 && WB[k]).sort((a, b) => win[b].d / win[b].t - win[a].d / win[a].t);
  const tip = avg < 50 ? 'A lighter plan might serve you better. Shorten or drop the most-skipped tasks.' : avg >= 80 ? 'Strong week. Keep what works, and maybe add one stretch goal.' : 'Solid. Put your hardest task in your strongest window.';
  return '<div class="sleep about"><h2>Weekly review</h2><ul><li>Average completion ' + avg + '% over ' + cnt + ' tracked days.</li><li>Best day: ' + bestD.toLocaleDateString(undefined, { weekday:'long' }) + ' (' + Math.round(bestP * 100) + '%).</li>' +
    (wk.length ? '<li>Strongest window: ' + esc(WB[wk[0]].name) + '.</li>' : '') + (sk.length ? '<li>Most skipped: ' + sk.map(x => esc(x[0]) + ' (' + x[1] + 'x)').join(', ') + '.</li>' : '') + '</ul><p>' + tip + '</p></div>';
}

function backupJson(){
  return JSON.stringify({ app:'yotei', v:3, data:backupData() });
}
async function shareBackup(){
  const f = new File([backupJson()], 'yotei-backup-' + new Date().toISOString().slice(0, 10) + '.json', { type:'application/json' });
  if (navigator.canShare && navigator.canShare({ files:[f] })){
    try{ await navigator.share({ files:[f], title:'Yotei backup' }); store.set('lastBackup', Date.now()); updateBackupInfo(); return; }
    catch(e){ if (e && e.name === 'AbortError') return; }
  }
  exportData();
}
$('#shareBk').addEventListener('click', shareBackup);

// ---- drag and drop (edit mode): drop on a task to reorder, on the top bar to move ----
let drag = null, dragCand = null;
const dragMove = e => { const g = $('#dragGhost'); g.style.left = (e.clientX - 20) + 'px'; g.style.top = (e.clientY - 46) + 'px'; };
function beginDrag(row, e){
  drag = { id:row.dataset.id, l:row.dataset.l };
  const base = parseDay(viewDate);
  $('#dropBar').innerHTML = '<button data-inbox="1">Inbox</button>' + [1, 2, 3, 4, 5, 6, 7].map(i => { const d = new Date(base); d.setDate(base.getDate() + i); return '<button data-day="' + isoLocal(d) + '">' + d.toLocaleDateString(undefined, { weekday:'short' }) + ' ' + d.getDate() + '</button>'; }).join('');
  $('#dropBar').classList.add('show');
  const g = $('#dragGhost'); g.textContent = row.querySelector('.ttl').textContent.replace(/\s+/g, ' ').trim(); g.style.display = 'block'; dragMove(e);
  if (navigator.vibrate) navigator.vibrate(8);
}
document.addEventListener('pointerdown', e => {   // the drag handle (shown while editing) starts a drag at once
  const h = e.target.closest && e.target.closest('.dragH'); if (!h) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault(); lpClear(); lpFired = true; beginDrag(h.closest('.tlrow'), e);
});
document.addEventListener('pointermove', e => {
  if (dragCand && !drag && Math.hypot(e.clientX - dragCand.x, e.clientY - dragCand.y) > 8){ beginDrag(dragCand.row, e); dragCand = null; }
  if (!drag) return;
  e.preventDefault(); dragMove(e);
  if (e.clientY < 120) window.scrollBy(0, -12); else if (e.clientY > innerHeight - 140) window.scrollBy(0, 12);
  document.querySelectorAll('#dropBar .over, .dropRow').forEach(x => x.classList.remove('over', 'dropRow'));
  const el = document.elementFromPoint(e.clientX, e.clientY); if (!el) return;
  const chip = el.closest('#dropBar button'), row = el.closest('.tlrow');
  if (chip) chip.classList.add('over'); else if (row && row.dataset.id !== drag.id) row.classList.add('dropRow');
}, { passive:false });
$('#tl').addEventListener('touchmove', e => { if (drag || dragCand) e.preventDefault(); }, { passive:false });
$('#tl').addEventListener('contextmenu', e => { if (e.target.closest('.tlrow')) e.preventDefault(); });
function dragEnd(e, cancel){
  if (dragCand){ const c = dragCand; dragCand = null; if (!cancel && !drag){ openEd(c.row.dataset.l, c.row.dataset.id); return; } }
  if (!drag) return;
  const d = drag; drag = null;
  const el = cancel ? null : document.elementFromPoint(e.clientX, e.clientY);
  const chip = el && el.closest('#dropBar button'), tgt = el && el.closest('.tlrow');
  $('#dropBar').classList.remove('show'); $('#dragGhost').style.display = 'none';
  document.querySelectorAll('#dropBar .over, .dropRow').forEach(x => x.classList.remove('over', 'dropRow'));
  if (!el) return;
  if (chip){
    sheetCtx = { l:d.l, id:d.id };
    if (chip.dataset.inbox) mvDo('inbox');
    else { if (chip.dataset.day === viewDate) return; $('#mv_d').value = chip.dataset.day; $('#mv_t').value = ''; mvDo('move'); }
  } else if (tgt && tgt.dataset.id !== d.id) reorderBlock(d.l, d.id, tgt.dataset.id, tgt.dataset.l);
}
document.addEventListener('pointerup', e => dragEnd(e, false));
document.addEventListener('pointercancel', e => dragEnd(e, true));
function reorderBlock(l, id, beforeId, tl){
  if (l !== tl){ toast('Drop it on a task in the same list.'); return; }
  const _s = grab(), arr = clone(getBlocks(l)), i = arr.findIndex(x => x.id === id), j = arr.findIndex(x => x.id === beforeId), wk = x => x.w || 'climb1';
  if (i < 0 || j < 0 || wk(arr[i]) !== wk(arr[j])){ toast('Drop it on a task in the same window.'); return; }
  if (arr[i].fixed !== undefined || arr[i].at !== undefined){ toast('This task is ordered by its Start time. Change it in Edit to move it.'); return; }
  needLive(); const [x] = arr.splice(i, 1); arr.splice(arr.findIndex(z => z.id === beforeId), 0, x);
  setBlocks(l, arr); render(); showUndo(l === 'oo' ? 'Reordered' : 'Reordered for all days', _s);
}

// ============================================================
// EDITABLE PAST DAYS + COLOR PICKER
// ============================================================
function needLive(){
  if (!snapMode()) return false;
  day.live = true; saveDay();
  toast('Rebuilt this day from your current routines so it can be edited.');
  return true;
}
const RING = ['#f28b95', '#e9804d', '#fbc531', '#7cb342', '#5b8fc9', '#0f8a5f', '#d94452', '#1565c0', '#ffffff'];
const RECENT0 = ['#a86c3c', '#8a8a8a', '#31b5d6', '#ffd966', '#5b78b4'];
const hex2 = n => Math.round(n).toString(16).padStart(2, '0');
function hsv2hex(h, s, v){
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + hex2(f(5) * 255) + hex2(f(3) * 255) + hex2(f(1) * 255);
}
function hex2hsv(hx){
  const m = /^#?([0-9a-f]{6})$/i.exec(hx || ''); if (!m) return null;
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = 0; if (d){ h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s:mx ? d / mx : 0, v:mx };
}
let CT = 'e';
function drawColorRow(p){
  p = typeof p === 'string' ? p : CT;
  const v = ($('#' + p + '_color').value || '').toLowerCase(), inList = RING.includes(v), custom = v && !inList;
  $('#' + p + '_colors').innerHTML = '<button type="button" class="cring cauto' + (!v ? ' on' : '') + '" data-c="" role="radio" aria-checked="' + !v + '" aria-label="Automatic color">Auto</button>' +
    RING.map(c => '<button type="button" class="cring' + (v === c ? ' on' : '') + '" data-c="' + c + '" style="--c:' + c + '" role="radio" aria-checked="' + (v === c) + '" aria-label="Color ' + c + '"></button>').join('') +
    '<button type="button" class="cring ccustom' + (custom ? ' has on' : '') + '" data-custom="1" style="--c:' + (custom ? v : 'transparent') + '" role="radio" aria-checked="' + !!custom + '" aria-label="Pick a custom color"></button>';
}
function highlightColor(){ drawColorRow(); }
function setEdAccent(){
  const c = $('#e_color').value || (WIN_STYLE[cur.wk] || WIN_STYLE.climb1).c, ed = $('#ed');
  ed.style.setProperty('--accent', c); ed.style.setProperty('--onacc', onColor(c));
}
['e'].forEach(p => $('#' + p + '_colors').addEventListener('click', e => {
  e.preventDefault();   // stop the wrapping label from re-clicking the first swatch
  const b = e.target.closest('button'); if (!b) return;
  CT = p;
  if (b.dataset.custom){ openColorSheet(); return; }
  $('#' + p + '_color').value = b.dataset.c; drawColorRow(p); if (p === 'e') setEdAccent();
}));

let hsv = { h:45, s:.8, v:1 }, wheelDrawn = false, csDrag = null;
function drawWheel(){
  const c = $('#cs_canvas'), x = c.getContext('2d'), n = c.width, R = n / 2, img = x.createImageData(n, n), d = img.data;
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++){
    const dx = px - R + .5, dy = py - R + .5, r = Math.hypot(dx, dy); if (r > R) continue;
    const h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360, s = r / R, i = (py * n + px) * 4;
    const f = k => { const q = (k + h / 60) % 6; return 1 - s * Math.max(0, Math.min(q, 4 - q, 1)); };
    d[i] = f(5) * 255; d[i + 1] = f(3) * 255; d[i + 2] = f(1) * 255; d[i + 3] = r > R - 1 ? (R - r) * 255 : 255;
  }
  x.putImageData(img, 0, 0);
}
function csApply(){
  const hx = hsv2hex(hsv.h, hsv.s, hsv.v), R = $('#cs_wheel').clientWidth / 2, a = hsv.h * Math.PI / 180, kn = $('#cs_knob');
  kn.style.left = (R + Math.cos(a) * hsv.s * R) + 'px'; kn.style.top = (R - Math.sin(a) * hsv.s * R) + 'px'; kn.style.background = hx;
  $('#cs_bright').style.background = 'linear-gradient(to right,#000,' + hsv2hex(hsv.h, hsv.s, 1) + ')';
  $('#cs_bthumb').style.left = (hsv.v * $('#cs_bright').clientWidth) + 'px';
  $('#cs_prev').style.background = hx;
  $('#' + CT + '_color').value = hx; drawColorRow(CT); if (CT === 'e') setEdAccent();
}
function drawRecent(){
  $('#cs_recent').innerHTML = store.get('recentColors', RECENT0).slice(0, 5).map(c => '<button type="button" data-c="' + c + '" style="background:' + c + '" aria-label="Use ' + c + '"></button>').join('');
}
function openColorSheet(){
  if (!wheelDrawn){ drawWheel(); wheelDrawn = true; }
  hsv = hex2hsv($('#' + CT + '_color').value) || hex2hsv('#ffc533');
  drawRecent(); $('#colorSheet').showModal(); csApply();
}
function csClose(){
  const v = ($('#' + CT + '_color').value || '').toLowerCase();
  if (v && !RING.includes(v)){ const L = store.get('recentColors', RECENT0).filter(c => c.toLowerCase() !== v); L.unshift(v); store.set('recentColors', L.slice(0, 5)); }
  if ($('#colorSheet').open) $('#colorSheet').close();
}
const csWheelPt = e => { const r = $('#cs_wheel').getBoundingClientRect(), R = r.width / 2, dx = e.clientX - r.left - R, dy = e.clientY - r.top - R; hsv.h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360; hsv.s = Math.min(Math.hypot(dx, dy) / R, 1); csApply(); };
const csBrightPt = e => { const r = $('#cs_bright').getBoundingClientRect(); hsv.v = Math.max(.12, Math.min(1, (e.clientX - r.left) / r.width)); csApply(); };
[['cs_wheel', 'w', csWheelPt], ['cs_bright', 'b', csBrightPt]].forEach(([id, k, fn]) => {
  const el = $('#' + id);
  el.addEventListener('pointerdown', e => { csDrag = k; el.setPointerCapture(e.pointerId); fn(e); });
  el.addEventListener('pointermove', e => { if (csDrag === k) fn(e); });
  ['pointerup', 'pointercancel'].forEach(ev => el.addEventListener(ev, () => { csDrag = null; }));
});
$('#cs_recent').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; hsv = hex2hsv(b.dataset.c); csApply(); });
$('#cs_done').onclick = csClose;
$('#colorSheet').addEventListener('click', e => { if (e.target === $('#colorSheet')) csClose(); });
(function(){ let y0 = null; const h = $('#cs_handle');
  h.addEventListener('pointerdown', e => { y0 = e.clientY; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e => { if (y0 !== null && e.clientY - y0 > 60){ y0 = null; csClose(); } });
  ['pointerup', 'pointercancel'].forEach(ev => h.addEventListener(ev, () => { y0 = null; }));
})();

// ============================================================
// DELETE HISTORY, WINDOW COLORS
// ============================================================
const WIN_DEF = Object.fromEntries(Object.entries(WIN_STYLE).map(([k, v]) => [k, v.c]));
const WIN_ICON_DEF = Object.fromEntries(Object.entries(WIN_STYLE).map(([k, v]) => [k, v.i]));
function applyWinColors(){ const W = wins(); for (const k in WIN_STYLE){ WIN_STYLE[k].c = safeCol(W[k].color) || WIN_DEF[k]; WIN_STYLE[k].i = W[k].icon || WIN_ICON_DEF[k]; } }
function applyWinScope(sc, c){
  const iso = viewDate, filt = {};
  if (scDays.length) filt.days = scDays.slice().sort();
  const o = store.get('wins', {}), W = store.get('wovr', {}), k = c.id, hasFilt = !!filt.days, base = winBase(k);
  const patch = c.type === 'reset' ? { name:base.name, note:base.note, from:base.from, to:base.to, color:null, icon:null } : diffBlock(c.old, c.b);
  if (Object.keys(patch).length){
    if (sc === 'all' && !hasFilt){
      if (c.type === 'reset'){ delete o[k]; delete W[k]; }
      else {
        o[k] = { ...(o[k] || {}) };
        Object.keys(patch).forEach(f => { if (patch[f] === null) delete o[k][f]; else o[k][f] = patch[f]; });
        if (!Object.keys(o[k]).length) delete o[k];
        (W[k] || []).forEach(e => Object.keys(patch).forEach(f => { delete e.patch[f]; }));
        W[k] = (W[k] || []).filter(e => Object.keys(e.patch).length); if (!W[k].length) delete W[k];
      }
    } else (W[k] = W[k] || []).push({ from:sc === 'all' ? null : iso, to:sc === 'day' ? iso : null, ...filt, patch });
  }
  store.set('wins', o); store.set('wovr', W); scopeCtx = null; $('#scopeDlg').close(); $('#ed').close(); render();
}
applyWinColors();
function delHist(ds){
  const _s = grab(), H = store.get('hist', {}); delete H[ds]; store.set('hist', H);
  delete plans[ds]; store.set('plans', plans);
  const tn = store.get('taskNotes', {}); Object.keys(tn).forEach(k => { if (k.split('_')[0] === ds) delete tn[k]; }); store.set('taskNotes', tn);
  if (viewDate === ds) loadDay(ds);
  lastSig = ''; render(); showUndo('Record deleted', _s);
}
function clearHist(){
  if (!confirm('Delete the saved records of all past days, including their done marks and task notes? Your routines are kept.')) return;
  const _s = grab(), t = todayStr();
  store.set('hist', {});
  Object.keys(plans).forEach(d => { if (d < t) delete plans[d]; }); store.set('plans', plans);
  const tn = store.get('taskNotes', {}); Object.keys(tn).forEach(k => { if (k.split('_')[0] < t) delete tn[k]; }); store.set('taskNotes', tn);
  lastSig = ''; loadDay(viewDate); render(); showUndo('History deleted', _s);
}
$('#histbox').addEventListener('click', e => {
  const b = e.target.closest('.hdel'); if (!b) return;
  if (confirm('Delete the saved record for ' + b.dataset.hd + '? This removes its done marks and task notes.')) delHist(b.dataset.hd);
});
$('#tab-settings').insertAdjacentHTML('beforeend', '<div class="sleep"><h2>History data</h2><p class="wn">Delete the saved records of past days, with their done marks and task notes. Your routines stay as they are. You can also delete a single day from the History tab.</p><button class="add" id="clrHist">Delete all recorded history</button></div>');
$('#clrHist').addEventListener('click', clearHist);

// ============================================================
// STRUCTURED-STYLE SHELL: header, week dots, add button
// ============================================================
function drawHdr(){
  const t = document.body.dataset.tab || 'home', d = parseDay(viewDate), el = $('#hdrTitle'); if (!el) return;
  if (t === 'home') el.innerHTML = esc(d.toLocaleDateString(undefined, { month:'long' })) + ' <em>' + d.getFullYear() + '</em>';
  else el.textContent = ({ inbox:'Inbox', history:'History', settings:'Settings' })[t] || 'Yotei';
}
function dayColors(ds){
  let rows = [];
  if (ds === viewDate) rows = schedule().rows;
  else { const sv = { wake, day, done }; try{ loadDay(ds); rows = build(dowOf(ds)).rows; }catch{} finally{ wake = sv.wake; day = sv.day; done = sv.done; } }
  const out = [], seen = new Set();
  rows.forEach(r => {
    if (!(r.use > 0) || r.sug || out.length >= 3) return;
    const c = safeCol(r.color) || (WIN_STYLE[r.w] || WIN_STYLE.climb1).c, k = String(c).toLowerCase();
    if (!seen.has(k)){ seen.add(k); out.push(c); }
  });
  return out;
}
$('#fab').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
$('#fab').addEventListener('click', () => {
  const inbox = '<svg viewBox="0 0 24 24"><path d="M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5"/></svg>';
  $('#fabMenu .fabIn').innerHTML = [['add', ICONS.pen, 'Add a task'], ['inbox', inbox, 'Add to inbox'], ['late', ICONS.alarm, day.shift ? 'Pushed ' + day.shift.by + ' min later' : 'Running late?'], ['copy', ICONS.calendar, 'Copy this day to another date']]
    .map(a => '<button data-a="' + a[0] + '">' + a[1] + '<span>' + a[2] + '</span></button>').join('');
  $('#fabMenu').showModal();
});
$('#fabMenu').addEventListener('click', e => {
  if (e.target === $('#fabMenu')){ $('#fabMenu').close(); return; }
  const b = e.target.closest('button'); if (!b) return;
  $('#fabMenu').close();
  if (b.dataset.a === 'add'){ openEd('oo', null, defaultWin()); cur.addScope = true; }
  else if (b.dataset.a === 'inbox'){ setTab('inbox'); setTimeout(() => $('#inT') && $('#inT').focus(), 60); }
  else if (b.dataset.a === 'late') openShift();
  else openMv('day');
});

$('#clrAll').addEventListener('click', () => { $('#clr_ok').checked = false; $('#clr_go').disabled = true; $('#clrDlg').showModal(); });
$('#clr_ok').addEventListener('change', e => { $('#clr_go').disabled = !e.target.checked; });
$('#clr_x').onclick = () => $('#clrDlg').close();
$('#clr_exp').onclick = () => shareBackup();
$('#clr_go').onclick = async () => {
  try{ await clearAll(); }catch{}
  try{ sessionStorage.clear(); }catch{}
  location.replace(location.pathname);
};

// ============================================================
// SAFETY, ACCESSIBILITY, EMPTY STATE
// ============================================================
function safeCol(c){ return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) ? c.trim() : null; }
Object.entries({ ed:'Task editor', fabMenu:'Add', iconPick:'Choose an icon', colorSheet:'Pick a color', scopeDlg:'Apply this change to', snapDlg:'Snapshots', mvDlg:'Move or copy', shDlg:'Running late', clrDlg:'Clear all data', setupDlg:'Welcome to Yotei', runDlg:'Routine timer', taskSheet:'Task details', blockInfo:'Block information', stepsSheet:'Subtasks' })
  .forEach(([id, l]) => { const d = document.getElementById(id); if (d) d.setAttribute('aria-label', l); });
$('#tl').insertAdjacentHTML('beforebegin', '<div class="sleep emptyCard" id="emptyCard" hidden><h2>Start with your first task</h2><p class="wn">Add what you want to do today. A task added for all days repeats every day. You can use the + button any time.</p><button class="add" id="emptyAdd">Add a task</button></div>');
function drawEmpty(){
  const el = $('#emptyCard'); if (!el) return;
  el.hidden = schedule().rows.some(r => r.use > 0 && !r.sug);
}
$('#emptyAdd').addEventListener('click', () => { openEd('oo', null, defaultWin()); cur.addScope = true; });
$('#hdrTitle').addEventListener('click', () => { if (document.body.dataset.tab === 'home' && viewDate !== todayStr()) goDate(todayStr()); });
function focusNow(){ if (viewDate !== todayStr()) return; const r = document.querySelector('.tlrow.now'); if (r) r.scrollIntoView({ block:'center' }); }

(function(){
  const list = a => a.map(x => '<li>' + esc(x) + '</li>').join('');
  const sect = (n, a) => a && a.length ? '<h3>' + n + '</h3><ul>' + list(a) + '</ul>' : '';
  $('#tab-settings').insertAdjacentHTML('beforeend',
    '<div class="sleep about"><h2>About Yotei <span class="ver">v' + APP_VERSION + '</span></h2><p>Status: stable. Everything below is working.</p><p class=\"wn\">Icons: Phosphor, and Font Awesome Free (CC BY 4.0, fontawesome.com).</p><h3 style="font:700 12px Poppins,sans-serif;color:var(--text)">Features</h3><ul>' + list(FEATURES) + '</ul><h3 style="font:700 12px Poppins,sans-serif;color:var(--text)">Good to know</h3><ul>' + list(LIMITS) + '</ul></div>' +
    '<div class="sleep about"><h2>Changelog</h2>' + CHANGELOG.map((c, i) =>
      '<details class="clog"' + (i === 0 ? ' open' : '') + '><summary>v' + esc(c.v) + '<span>' + esc(c.date) + '</span></summary>' + sect('Added', c.added) + sect('Changed', c.changed) + sect('Fixed', c.fixed) + '</details>').join('') + '</div>');
})();
const tabs = document.querySelectorAll('.tabs button');
function setTab(t){
  tabs.forEach(b => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); b.setAttribute('aria-controls', 'tab-' + b.dataset.tab); });
  document.querySelectorAll('.tab').forEach(sec => { sec.hidden = sec.id !== 'tab-' + t; sec.setAttribute('role', 'tabpanel'); });
  store.set('tab', t); document.body.dataset.tab = t; drawHdr();
}
tabs.forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
setTab(store.get('tab', 'home'));
const FRESH = ['hist', 'plans', 'blocks', 'day', 'wake', 'setup'].every(k => store.get(k, null) === null);
migrateFields();
migrateV2();
migrateV3();
render();
if (FRESH) openSetup();
setTimeout(focusNow, 150);
(function(){
  const a = new URLSearchParams(location.search).get('action'); if (!a) return;
  try{ history.replaceState(null, '', location.pathname); }catch{}
  setTab('home'); goDate(todayStr());
  if (a === 'morning') runStart('sleep'); else if (a === 'inbox'){ setTab('inbox'); setTimeout(() => $('#inT') && $('#inT').focus(), 60); }
})();
function migrateV2(){
  if (store.get('schemaV', 0) >= 2) return;
  const bl = store.get('blocks', null);
  if (bl){
    const moved = [];
    for (const l of ['home', 'school', 'away']){
      if (!Array.isArray(bl[l])) continue;
      bl[l] = bl[l].filter(b => { if (b && b.w === 'wind'){ if (l === 'home' && !b.sug) moved.push(b); return false; } return true; });
    }
    if (!bl.night && moved.length) bl.night = moved.map(b => { const c = { ...b }; delete c.w; if (!c.p){ c.p = 'flex'; c.m = Math.min(c.d, 5); } return c; });
    store.set('blocks', bl);
  }
  store.set('schemaV', 2);
}
function migrateV3(){  // add the new Away suggestions to an Away list you already customised
  if (store.get('schemaV', 0) >= 3) return;
  const bl = store.get('blocks', null);
  if (bl && Array.isArray(bl.away)){
    const add = MODES.away.post.filter(d => /^a[cm]\d/.test(d.id) && !bl.away.some(x => x.id === d.id));
    if (add.length){ bl.away = bl.away.concat(add); store.set('blocks', bl); }
  }
  store.set('schemaV', 3);
}
function updateBackupInfo(){
  const t = store.get('lastBackup', 0), d = t ? Math.floor((Date.now() - t) / 864e5) : null;
  const needs = (d === null || d >= 7) && Object.keys(store.get('hist', {})).length >= 3;
  const bytes = estimateBytes();
  $('#bkInfo').textContent = (d === null ? 'No backup yet.' : d === 0 ? 'Last backup: today.' : 'Last backup: ' + d + ' day' + (d === 1 ? '' : 's') + ' ago.') + ' Stored on this device: ' + Math.max(1, Math.round(bytes / 1024)) + ' KB.';
  $('#settingsBtn').classList.toggle('nudge', needs); document.querySelector('.tabs [data-tab=settings]').classList.toggle('nudge', needs);
  $('#settingsBtn').setAttribute('aria-label', needs ? 'Settings, backup suggested' : 'Settings');
}
updateBackupInfo();
if ($('#settingsBtn').classList.contains('nudge') && store.get('bkAsk', '') !== todayStr()){ store.set('bkAsk', todayStr()); setTimeout(() => toast('Time for a backup. Your data lives only on this device.', 'Back up', shareBackup), 1500); }
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator){
  // The page may already have finished loading by the time this script runs (startup waits for saved data).
  const registerSw = () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); };
  if (document.readyState === 'complete') registerSw(); else window.addEventListener('load', registerSw);
}
