import { weekSummary } from './review.js';
import { esc } from './util.js';
import { validateBackup } from './validate.js';
import { TASK_LISTS, sameId, normalizeIds, removeTask, removeFromRecord } from './tasks.js';
import { store, initStore, info, onStoreError, replaceAll, clearAll, estimateBytes, makeSnapshot, snapshotIfDue, listSnapshots, restoreSnapshot } from './storage.js';
import { applyOvr, typeOfIn, buildSchedule } from './engine.js';
import { isoLocal, parseDay, dowOf, cmpDay } from './dates.js';
import { migrateDates, needsDateMigration, DATE_FMT } from './migrate.js';

// ---- running inside the Android app (Capacitor)? Plugins only exist there. ----
const CAPACITOR = window.Capacitor, IS_NATIVE = !!(CAPACITOR && CAPACITOR.isNativePlatform && CAPACITOR.isNativePlatform());
const nativePlugin = n => (IS_NATIVE && CAPACITOR.Plugins && CAPACITOR.Plugins[n]) || null;
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
let toastT = null, toastUntil = 0, toastShownAt = 0;   // toast state (see toast() below)
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
const WIN_STYLE = {
  sleep:{ c:'#f59e0b', i:'sunrise' }, climb1:{ c:'#f97316', i:'mountain' }, peak:{ c:'#facc15', i:'brain' },
  trough:{ c:'#38bdf8', i:'coffee' }, climb2:{ c:'#34d399', i:'rocket' }, wmz:{ c:'#a78bfa', i:'eye' }, wind:{ c:'#6366f1', i:'moon' }
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
// The list a row says it belongs to can be wrong for data saved by older versions; find where the task really is.
function resolveList(l, id){
  if (!id || l === 'oo' || l === 'win' || getBlocks(l).some(x => sameId(x.id, id))) return l;
  return TASK_LISTS.find(x => x !== l && getBlocks(x).some(y => sameId(y.id, id))) || l;
}
function openEd(l, id, w, startAt){
  l = resolveList(l, id);
  const b = id ? effBlock(l, getBlocks(l).find(x => sameId(x.id, id))) : null;
  if (id && !b){ toast('That task is no longer in your routines.', 'Delete it', () => ghostDelete(l, id)); return; }
  cur = { l, id, w, wk: l === 'pre' ? 'sleep' : l === 'night' ? 'wind' : ((b && b.w) || w || 'climb1'), isNew: !b };
  edTypes = (b && WIN_LISTS.includes(l)) ? linkedTypes(l, b) : null; edTypesOrig = edTypes ? edTypes.slice() : null;
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
  endDriven = false; $('#e_s').value = st !== undefined ? toVal(st) : ''; $('#e_e').value = '';
  syncEnd(); refreshWinLock(); applyKindUI();
  $('#e_days').style.display = l === 'oo' ? 'none' : '';
  $('#e_dates').style.display = l === 'oo' ? 'none' : ''; $('#e_from').value = x.from || ''; $('#e_to').value = x.to || '';
  drawEdTypes();
  $('#e_details').value = x.details || ''; edSteps.set(x.steps);
  edDays = x.days ? x.days.slice() : [0,1,2,3,4,5,6]; drawDays();
  ['e_del','e_up','e_dn'].forEach(i => { $('#' + i).style.display = b ? '' : 'none'; });
  $('#ed').showModal(); $('#ed .ef').scrollTop = 0;
}
function moveBlock(d){
  const arr = clone(getBlocks(cur.l)), i = arr.findIndex(x => sameId(x.id, cur.id)), wk = x => x.w || 'climb1';
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
// Day types: which of Home / School / Away a task is added to. A task in several types is saved as one copy per type,
// tied together by a shared link key (lk), so editing one updates the others.
const WIN_LISTS = ['home', 'school', 'away'];
let edTypes = null, edTypesOrig = null;   // null = not chosen yet, show the default
const newTaskId = n => 'u' + Date.now().toString(36) + (n || 0) + Math.random().toString(36).slice(2, 5);
function linkedTypes(l, b){ return !b.lk ? [l] : WIN_LISTS.filter(L => L === l || getBlocks(L).some(x => x.lk && x.lk === b.lk)); }
function typesVisible(){
  if (WIN_LISTS.includes(cur.l)) return true;
  return cur.l === 'oo' && !!cur.addScope && !!cur.isNew && !['sleep', 'wind'].includes($('#e_w').value || 'climb1');
}
function defaultType(){ return WIN_LISTS.includes(cur.l) ? cur.l : (typeOf($('#e_w').value || 'climb1') || 'home'); }
const shownTypes = () => edTypes || [defaultType()];
function drawEdTypes(){
  const vis = typesVisible(); $('#e_typesWrap').style.display = vis ? '' : 'none'; if (!vis) return;
  const on = shownTypes();
  $('#e_types').innerHTML = WIN_LISTS.map(m => '<button type="button" data-m="' + m + '"' + (on.includes(m) ? ' class="on"' : '') + '>' + MODE_LABEL[m] + '</button>').join('');
}
$('#e_types').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const m = b.dataset.m, on = shownTypes(), next = on.includes(m) ? on.filter(x => x !== m) : on.concat(m);
  if (!next.length){ edErr('A task needs at least one day type.'); return; }
  edTypes = WIN_LISTS.filter(x => next.includes(x)); drawEdTypes();
});
$('#e_w').addEventListener('change', drawEdTypes);
let endDriven = false;   // true while the Start was worked out from the End and the length (End entered first)
function startFromEnd(){
  const e = $('#e_e').value; if (!e) return false;
  if ($('#e_k').value === 'sug') setKind('fixedlen');
  let d = parseInt($('#e_d').value) || 0;
  if (!d){ d = 20; $('#e_d').value = d; highlightChip(); }
  const [h2, m2] = e.split(':').map(Number), st = h2 * 60 + m2 - d;
  if (st < 0){ edErr('That end time is too early for a ' + d + '-minute task. Pick a later end time or a shorter length.'); return false; }
  $('#e_s').value = toVal(st); endDriven = true; syncWinSel(); refreshWinLock();
  return true;
}
function syncEnd(){
  if (endDriven) return;
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
let pickTok = 0;   // identifies the current icon pick; closing the picker or editor cancels any pick that is still downloading
async function pickFa(n, btn){
  const key = 'fa-' + n, tok = ++pickTok;
  if (!ICONS[key]){
    if (btn) btn.classList.add('loading');
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 8000);
    try{
      if (navigator.onLine === false) throw 0;
      const r = await fetch(FA_URL(n), { signal:ac.signal }); if (!r.ok) throw 0;
      const t = await r.text(), vb = (t.match(/viewBox="([^"]+)"/) || [])[1], ds = [...t.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(m => m[1]);
      if (!vb || !ds.length) throw 0;
      ICONS[key] = '<svg class="pi" viewBox="' + vb + '">' + ds.map(d => '<path d="' + d + '"/>').join('') + '</svg>';
      try{ const c = JSON.parse(localStorage.getItem('yotei_fa') || '{}'); c[key] = ICONS[key]; localStorage.setItem('yotei_fa', JSON.stringify(c)); }catch{}
    }catch{
      clearTimeout(timer); if (btn) btn.classList.remove('loading');
      if (tok === pickTok) toast('Could not load that icon. Check your connection and try again.');
      return;
    }
    clearTimeout(timer); if (btn) btn.classList.remove('loading');
  }
  if (tok !== pickTok) return;   // the picker or editor was closed (or another icon chosen) while this downloaded: leave the editor alone
  $('#e_icon').value = key; updateIconBtn(); $('#iconPick').close();
}
$('#iconPick').addEventListener('close', () => { pickTok++; });
$('#ed').addEventListener('close', () => { pickTok++; });
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
  if (b.dataset.fa){ pickFa(b.dataset.fa, b); return; }
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
  const r = rows.find(x => sameId(x.id, id));
  if (!r) return;
  sheetCtx = { l: resolveList(l, id), id };
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
$('#ts_dup').onclick = () => {
  const r = schedule().rows.find(x => sameId(x.id, sheetCtx.id)); if (!r) return;
  $('#taskSheet').close();
  openEd('oo', null, r.w); cur.addScope = true; drawEdTypes();
  $('#e_t').value = r.t;
  $('#e_k').value = r.sug ? 'sug' : ['core', 'flex', 'opt'].includes(r.p) ? r.p : r.p === 'open' ? 'open' : 'fixedlen';
  $('#e_d').value = r.d !== undefined ? r.d : r.use; $('#e_m').value = r.m ?? ''; highlightChip();
  $('#e_icon').value = r.icon || ''; updateIconBtn();
  $('#e_color').value = r.color || ''; drawColorRow('e'); setEdAccent();
  $('#e_details').value = r.details || ''; edSteps.set(r.steps);
  endDriven = false; $('#e_s').value = ''; $('#e_e').value = ''; $('#e_fx').checked = false; refreshWinLock(); applyKindUI();
};
// ============================================================
// SUBTASK SHEET — opens from the small icon next to a task's
// subtask count. Checklist only, no Delete/Duplicate/Edit here.
// ============================================================
// ---- subtask rows (task editor and to-do editor): add one at a time, drag to reorder, remove with the cross ----
function stepRow(v){
  const o = typeof v === 'string' ? { t:v } : (v || {});
  const d = document.createElement('div'); d.className = 'sdRow'; if (o.d) d.dataset.d = '1';
  d.innerHTML = '<span class="sdH" aria-label="Drag to reorder" title="Drag to reorder">&#8942;&#8942;</span><input class="sdIn" maxlength="120" placeholder="Subtask" aria-label="Subtask"><button type="button" class="sdX" aria-label="Remove subtask">&times;</button>';
  d.querySelector('input').value = o.t || ''; return d;
}
function makeSteps(boxSel, nSel, addSel){
  const box = $(boxSel);
  const get = () => [...box.querySelectorAll('.sdRow')].map(r => ({ t:r.querySelector('.sdIn').value.trim(), d:r.dataset.d === '1' })).filter(s => s.t);
  const count = () => { const n = get().length; $(nSel).textContent = n ? '(' + n + ')' : ''; };
  const set = a => { box.innerHTML = ''; (a || []).forEach(v => box.appendChild(stepRow(v))); count(); };
  $(addSel).onclick = () => { const r = stepRow(''); box.appendChild(r); r.querySelector('input').focus(); };
  box.addEventListener('input', count);
  box.addEventListener('click', e => { const x = e.target.closest('.sdX'); if (x){ x.closest('.sdRow').remove(); count(); } });
  box.addEventListener('keydown', e => {
    const inp = e.target.closest('.sdIn'); if (!inp) return;
    const row = inp.closest('.sdRow');
    if (e.key === 'Enter'){ e.preventDefault(); if (!inp.value.trim()) return; const r = stepRow(''); row.after(r); r.querySelector('input').focus(); }
    else if (e.key === 'Backspace' && !inp.value){ e.preventDefault(); const p = row.previousElementSibling; row.remove(); count(); if (p) p.querySelector('input').focus(); }
  });
  let row = null;
  box.addEventListener('pointerdown', e => { const h = e.target.closest('.sdH'); if (!h) return; row = h.closest('.sdRow'); row.classList.add('drag'); h.setPointerCapture(e.pointerId); e.preventDefault(); });
  box.addEventListener('pointermove', e => {
    if (!row) return;
    const others = [...box.children].filter(r => r !== row); let before = null;
    for (const r of others){ const b = r.getBoundingClientRect(); if (e.clientY < b.top + b.height / 2){ before = r; break; } }
    if (before !== row.nextElementSibling) box.insertBefore(row, before);
  });
  const end = () => { if (row){ row.classList.remove('drag'); row = null; } };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  return { get, set };
}
const edSteps = makeSteps('#e_steps', '#e_stepsN', '#e_stepAdd');
const tdeSteps = makeSteps('#tde_steps', '#tde_stepsN', '#tde_stepAdd');

let stepsSheetId = null;
function tickAllSteps(id, on = true){
  const r = schedule().rows.find(x => sameId(x.id, id)); if (!r || !(r.steps || []).length) return;
  r.steps.forEach((z, i) => { const k = id + '#' + i, j = done.ids.indexOf(k); if (on && j === -1) done.ids.push(k); if (!on && j !== -1) done.ids.splice(j, 1); });
  const pi = done.ids.indexOf(id); if (on && pi === -1) done.ids.push(id); if (!on && pi !== -1) done.ids.splice(pi, 1);
  saveDay(); render();
}
function offerTickAll(id){
  const r = schedule().rows.find(x => sameId(x.id, id)); if (!r) return;
  const n = (r.steps || []).filter((z, i) => !done.ids.includes(id + '#' + i)).length;
  if (n) toast(n === 1 ? 'Tick the subtask too?' : 'Tick all ' + n + ' subtasks too?', 'Tick all', () => tickAllSteps(id));
}
function ssRefresh(){
  const r = schedule().rows.find(x => sameId(x.id, stepsSheetId)); if (!r) return;
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
  const { rows } = schedule(), r = rows.find(x => sameId(x.id, id));
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
  $('#e_d').value = b.dataset.m; highlightChip(); if (endDriven) startFromEnd(); else syncEnd();
});
$('#e_d').addEventListener('input', () => { highlightChip(); if (endDriven){ if (parseInt($('#e_d').value) > 0) startFromEnd(); } else syncEnd(); });
$('#e_s').addEventListener('input', () => {
  const s = $('#e_s').value; endDriven = false;
  if (s){ if ($('#e_k').value === 'sug') setKind('fixedlen'); syncEnd(); syncWinSel(); }
  else { $('#e_e').value = ''; $('#e_fx').checked = false; }
  refreshWinLock();
});
$('#e_e').addEventListener('input', () => {
  const s = $('#e_s').value, e = $('#e_e').value;
  if (!e){ if (endDriven){ $('#e_s').value = ''; $('#e_fx').checked = false; endDriven = false; refreshWinLock(); } return; }
  if (!s || endDriven){                       // End first (or End changed again): count back from it using the length
    if (!startFromEnd()){ $('#e_e').value = ''; if (endDriven){ $('#e_s').value = ''; endDriven = false; refreshWinLock(); } }
    return;
  }
  const [h, mi] = s.split(':').map(Number), [h2, m2] = e.split(':').map(Number), d = h2*60 + m2 - (h*60 + mi);
  if (d > 0){ $('#e_d').value = d; highlightChip(); }
  else { edErr('End time has to be after the start time.'); syncEnd(); }
});
function syncWinSel(){
  const f = $('#e_s').value; if (!f || $('#e_wrap').style.display === 'none') return;
  const [h, mi] = f.split(':').map(Number); $('#e_w').value = winFor(h*60 + mi); drawEdTypes();
}
$('#e_k').addEventListener('change', () => {
  const k = $('#e_k').value;
  if (k === 'sug'){ endDriven = false; $('#e_s').value = ''; $('#e_e').value = ''; $('#e_fx').checked = false; }
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
$('#ed').addEventListener('input', () => { $('#e_err').hidden = true; }, true);   // capture phase: clear the old message first, so an error raised by this very input stays visible
$('#e_up').onclick = () => moveBlock(-1);
$('#e_dn').onclick = () => moveBlock(1);
$('#e_ok').onclick = () => {
  const t = $('#e_t').value.trim();
  if (!t){ edErr('Give the task a name first.'); return; }
  if (cur.l === 'win'){ saveWinBlock(t); return; }
  { let s = $('#e_s').value; const e = $('#e_e').value;
    if (e && !s){ if (!startFromEnd()) return; s = $('#e_s').value; }
    if (s && e){ const [h, mi] = s.split(':').map(Number), [h2, m2] = e.split(':').map(Number); if (h2*60 + m2 <= h*60 + mi){ edErr('End time has to be after the start time.'); return; } }
  }
  let k = $('#e_k').value;
  if (k !== 'sug' && !(parseInt($('#e_d').value) > 0)){ edErr('Set how long it takes, in minutes.'); return; }
  const arr = clone(getBlocks(cur.l)), old0 = arr.find(x => sameId(x.id, cur.id)), old = effBlock(cur.l, old0);
  const b = { id: old ? old.id : 'u' + Date.now().toString(36), t };
  if (old){ const FORM = ['id','t','d','m','p','sug','fixed','at','details','color','icon','steps','days','w']; Object.keys(old).forEach(z => { if (!FORM.includes(z)) b[z] = old[z]; }); }
  if (cur.l === 'oo') b.w = $('#e_w').value || 'climb1'; else if (old && old.w) b.w = old.w; else if (cur.l !== 'pre' && cur.l !== 'night') b.w = cur.w || 'climb1';
  const details = $('#e_details').value.trim(); if (details) b.details = details;
  const color = $('#e_color').value.trim(); if (color) b.color = color;
  const icon = $('#e_icon').value.trim(); if (icon) b.icon = icon;
  const steps = edSteps.get().map(s => s.t); if (steps.length) b.steps = steps;
  if (cur.fromInbox) b.src = 'inbox'; else if (cur.fromTodo) b.src = 'todo';     // shown as a small tag on the timeline
  if (cur.l !== 'oo'){ if (!edDays.length){ edErr('Pick at least one day.'); return; } if (edDays.length < 7) b.days = edDays.slice().sort(); }
  if (cur.l !== 'oo'){
    const f0 = $('#e_from').value, t0 = $('#e_to').value;
    if (f0 && t0 && t0 < f0){ edErr('The end date is before the start date.'); return; }
    if (f0) b.from = f0; else delete b.from;
    if (t0) b.to = t0; else delete b.to;
  }
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
  const wantTypes = WIN_LISTS.includes(cur.l) || (cur.l === 'oo' && cur.addScope && cur.isNew && b.w !== 'sleep' && b.w !== 'wind');
  const T = wantTypes ? (edTypes ? edTypes.slice() : [WIN_LISTS.includes(cur.l) ? cur.l : (typeOf(b.w) || 'home')]) : undefined;
  const typesChanged = !!(old && T && edTypesOrig && (T.length !== edTypesOrig.length || T.some(x => !edTypesOrig.includes(x))));
  if (cur.l === 'oo' && cur.addScope && !old && !cur.fromInbox){
    const w = b.w, l = w === 'sleep' ? 'pre' : w === 'wind' ? 'night' : (typeOf(w) || 'home');
    askScope('add', { l, id:b.id, b, old:null, w, types:T }); return;
  }
  if (cur.l !== 'oo'){
    if (old && !Object.keys(diffBlock(old, b)).length && !typesChanged){ $('#ed').close(); return; }
    askScope(old ? 'edit' : 'add', { l:cur.l, id:b.id, b, old, w:cur.w, types:T }); return;
  }
  needLive();
  if (old0) arr[arr.indexOf(old0)] = b; else arr.push(b);
  if (cur.fromInbox) store.set('inbox', store.get('inbox', []).filter(x => x.id !== cur.fromInbox));
  if (cur.fromTodo){
    const tl = store.get('todos', []), src = tl.find(x => x.id === cur.fromTodo);
    if (src && src.rep && src.due){ tdAdvance(src); store.set('todos', tl); }      // a repeating to-do stays and moves to its next date
    else store.set('todos', tl.filter(x => x.id !== cur.fromTodo));
    drawTodo();
  }
  setBlocks(cur.l, arr); $('#ed').close(); render();
};
$('#e_x2').onclick = () => $('#e_x').click();
$('#settingsBtn').addEventListener('click', () => setTab('settings'));
$('#editDone').addEventListener('click', () => $('#editToggle').click());   // quick way out of editing mode
$('#editToggle').addEventListener('click', () => {
  editing = !editing;
  $('#settingsBtn').classList.toggle('on', editing);
  document.body.classList.toggle('editing', editing);
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
function weekReviewHtml(){
  const H = store.get('hist', {}), WB = wins(), days = [];
  for (let i = 6; i >= 0; i--){
    const d = parseDay(todayStr()); d.setDate(d.getDate() - i); const ds = isoLocal(d);
    let planned = 0, dn = 0;
    if (ds === todayStr()){ const t = remRowsFor(ds); const rs = t.rows.filter(r => r.use > 0 && !r.sug); planned = rs.length; dn = rs.filter(r => t.done.includes(r.id)).length; }
    else if (H[ds]){ const rs = (H[ds].rows || []).filter(r => r.u > 0 || r.done); planned = rs.length; dn = rs.filter(r => r.done).length; }
    days.push({ ds, planned, done:dn });
  }
  const S = weekSummary(days, store.get('energy', []));
  if (!S.planned) return '<div class="sleep weekCard"><h2>Your week</h2><p class="wn">Plan a few tasks and tick them off. Your week shows up here.</p></div>';
  const dl = ds => parseDay(ds).toLocaleDateString(undefined, { weekday:'long' });
  const cols = S.perDay.map(x => '<div class="wkCol"><div class="wkBar"><i style="height:' + (x.pct || 0) + '%"></i></div>' + (x.energy ? '<b class="wkDot" style="background:' + EN_COL[Math.round(x.energy) - 1] + '"></b>' : '<b class="wkDot none"></b>') + '<span>' + parseDay(x.ds).toLocaleDateString(undefined, { weekday:'narrow' }) + '</span></div>').join('');
  const lines = [];
  if (S.best) lines.push('Best day: ' + dl(S.best.ds) + ' (' + S.best.pct + '%).');
  if (S.energyAvg) lines.push('Energy averaged ' + S.energyAvg.toFixed(1) + ' out of 5' + (S.bestWindow && WB[S.bestWindow.w] ? ', best in ' + esc(WB[S.bestWindow.w].name) + '.' : '.'));
  return '<div class="sleep weekCard"><h2>Your week</h2><p class="wkBig"><b>' + S.done + '</b> of ' + S.planned + ' tasks done <span>' + S.pct + '%</span></p><div class="wkBars">' + cols + '</div>' + lines.map(l => '<p class="wn">' + l + '</p>').join('') + '<p class="wn wkKey">Bars show tasks done. The dot under each is that day\'s average energy.</p></div>';
}
function trendsHtml(){ return weekReviewHtml() + trendsBody(); }
function trendsBody(){
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
  let strip = '', anyDots = false;
  for (let i = 0; i < 7; i++){
    const wd = new Date(base); wd.setDate(base.getDate() + i);
    const ds = isoLocal(wd), sel = ds === viewDate, isToday = ds === todayDS;
    strip += '<button class="wd' + (sel ? ' on' : '') + (isToday ? ' today' : '') + '" data-d="' + ds + '"><span class="wdn">' + wd.toLocaleDateString(undefined, { weekday:'short' }) + '</span><span class="wdd">' + wd.getDate() + '</span><span class="wdots">' + dayColors(ds).map(c => { anyDots = true; return '<i style="--c:' + c + '"></i>'; }).join('') + '</span></button>';
  }
  $('#weekstrip').innerHTML = strip; $('#weekstrip').classList.toggle('nodots', !anyDots);      // no empty row of dots when nothing is planned
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
  remSoon(); if (document.body.dataset.setpage === 'sched') drawDated();
  applyWinColors();
  drawNav();
  if (document.activeElement !== $('#dnote')) $('#dnote').value = day.note || '';
  drawInbox(); drawTodo(); drawEnergy(); drawEmpty();
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
    const sw = (prev && prev.md && r.md !== prev.md && MODE_NAME[r.md] ? '<span class="tag warn">switched to ' + MODE_NAME[r.md] + '</span>' : '') + (r.src ? '<span class="tag">from ' + (r.src === 'todo' ? 'To-do' : 'Inbox') + '</span>' : '') + (r.fixed !== undefined ? '<span class="tag">fixed time</span>' : '') + (overflow ? '<span class="tag warn">runs past window end</span>' : '');
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
  const MIN_GAP = 5, canAdd = !snapMode();      // gaps shorter than 5 minutes are not worth showing
  function gapEl(from, to, l, w){                // a free stretch of time: broken line + "free" label + add button
    const mins = to - from; if (mins < MIN_GAP) return '';
    const h = Math.floor(mins / 60), m = mins % 60, dur = ((h ? h + 'h ' : '') + (m || !h ? m + 'm' : '')).trim();
    return '<div class="gap"><span class="gaptxt">' + dur + ' free</span>' + (canAdd ? '<button class="add" data-l="' + l + '" data-w="' + w + '" data-s="' + from + '">+ Add task</button>' : '') + '</div>';
  }
  function gapRows(rs){
    let out = '';
    for (let i = 0; i < rs.length; i++){
      out += rowHtml(rs[i], rs[i - 1]);
      const cur = rs[i], next = rs[i + 1];
      if (cur.use > 0 && !cur.sug && next && next.use > 0 && !next.sug && next.start > cur.end) out += gapEl(cur.end, next.start, cur.md || 'pre', cur.w);
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
      const timed = rs.filter(r => r.use > 0 && !r.sug), addL = k === 'sleep' ? 'pre' : k === 'wind' ? 'night' : t || 'oo';
      const ws = wake + WB[k].from, we = wake + WB[k].to;
      const headGap = timed.length ? gapEl(ws, Math.min(...timed.map(r => r.start)), addL, k) : '';       // free time before the first task
      const tailGap = timed.length ? gapEl(Math.max(...timed.map(r => r.end)), we, addL, k) : '';          // free time after the last task
      const allGap = timed.length ? '' : gapEl(ws, we, addL, k);                                           // a block with nothing in it
      html += headGap + (rs.length ? gapRows(rs) : '<p class="wn">No tasks yet.</p>') + tailGap + allGap;
      if (editing || (!rs.length && !allGap)) html += '<button class="add" data-l="' + addL + '" data-w="' + k + '">+ Add task</button>';
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
    if (!txt) shownNotes.delete(noteKey(id));   // notes stay hidden until you tap the note icon
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
// IN-APP MESSAGES: replace the browser's confirm() and alert() popups
// ask(text, opts) -> Promise<boolean>.  tell(text) -> shows a message with one OK button.
// opts: title, ok (button text), cancel (button text), danger (red OK), info (no Cancel button)
// ============================================================
var mdResolve = null;
function mdClose(v){ const d = $('#msgDlg'), r = mdResolve; mdResolve = null; if (d.open) d.close(); if (r) r(v); }
function ask(text, opts = {}){
  return new Promise(res => {
    if (mdResolve) mdClose(false);
    mdResolve = res;
    const t = $('#md_title'); t.textContent = opts.title || ''; t.hidden = !opts.title;
    $('#md_text').textContent = text;
    const no = $('#md_no'), ok = $('#md_ok');
    no.hidden = !!opts.info; no.textContent = opts.cancel || 'Cancel';
    ok.textContent = opts.ok || 'OK'; ok.classList.toggle('danger', !!opts.danger);
    $('#msgDlg').showModal();
    (opts.info ? ok : no).focus();       // for questions the safe choice (Cancel) is the one highlighted
  });
}
const tell = text => ask(text, { info:true });
$('#md_ok').onclick = () => mdClose(true);
$('#md_no').onclick = () => mdClose(false);
$('#msgDlg').addEventListener('close', () => { const r = mdResolve; mdResolve = null; if (r) r(false); });   // Esc or the Android back button

// ============================================================
// IMPORT / EXPORT / RESET
// ============================================================
// Backup files keep the v2 layout (keys carry the yotei_v2_ prefix), so they stay readable by older versions.
function backupData(){ const o = {}; Object.entries(store.dump()).forEach(([k, v]) => { o['yotei_v2_' + k] = v; }); return o; }
// In the Android app a page cannot download a file by itself. Export saves straight into Downloads/Yotei through a small piece of
// native code (YoteiFiles). Share keeps using Android's share sheet. If the native part is missing, Export falls back to the share sheet.
async function shareBackupNative(name, json){
  const fs = nativePlugin('Filesystem'), sh = nativePlugin('Share'); if (!fs || !sh) return false;
  try{
    const r = await fs.writeFile({ path:name, data:json, directory:'CACHE', encoding:'utf8' });
    await sh.share({ title:'Yotei backup', url:r.uri, dialogTitle:'Save your Yotei backup' });
    store.set('lastBackup', Date.now()); updateBackupInfo();
  }catch(e){ if (!/cancel/i.test(String((e && e.message) || e))) tell('Could not save the backup. Please try again.'); }
  return true;
}
async function saveBackupNative(name, json){
  const yf = nativePlugin('YoteiFiles');
  if (yf){
    try{ await yf.saveToDownloads({ name, data:json, mime:'application/json' }); store.set('lastBackup', Date.now()); updateBackupInfo(); toast('Saved to Downloads/Yotei'); return true; }
    catch(e){ /* fall through to the share sheet */ }
  }
  return shareBackupNative(name, json);
}

// ---- automatic weekly backup (the Android app): one file a week in Downloads/Yotei, the latest 8 are kept ----
const AUTO_DAYS = 7, AUTO_KEEP = 8;
const autoBackupOn = () => store.get('autoBackup', true) !== false;
async function autoBackupMaybe(){
  if (!IS_NATIVE || !autoBackupOn()) return;
  const yf = nativePlugin('YoteiFiles'); if (!yf) return;
  if (Date.now() - store.get('lastAutoBackup', 0) < AUTO_DAYS * 864e5) return;
  if (!Object.keys(store.get('hist', {})).length && !Object.keys(store.get('plans', {})).length) return;      // nothing worth saving yet
  try{
    await yf.saveToDownloads({ name:'yotei-auto-' + todayStr() + '.json', data:backupJson(), mime:'application/json' });
    store.set('lastAutoBackup', Date.now()); store.set('lastBackup', Date.now()); updateBackupInfo(); drawAutoBackup();
    try{ await yf.trimBackups({ prefix:'yotei-auto-', keep:AUTO_KEEP }); }catch{}
  }catch{}
}
function drawAutoBackup(){
  const box = $('#abBox'); if (!box) return;
  box.hidden = !IS_NATIVE; if (!IS_NATIVE) return;
  const on = autoBackupOn(), t = store.get('lastAutoBackup', 0);
  $('#abInfo').textContent = 'Export saves into Downloads/Yotei. ' + (on ? 'Automatic weekly backup is on' + (t ? ' (last one ' + new Date(t).toLocaleDateString(undefined, { month:'short', day:'numeric' }) + ')' : '') + ', keeping the latest ' + AUTO_KEEP + '.' : 'Automatic weekly backup is off.');
  $('#abToggle').textContent = on ? 'Turn off automatic backup' : 'Turn on automatic backup';
}
$('#abToggle').addEventListener('click', () => { store.set('autoBackup', !autoBackupOn()); drawAutoBackup(); if (autoBackupOn()) autoBackupMaybe(); });
drawAutoBackup();
if (IS_NATIVE) setTimeout(autoBackupMaybe, 4000);
async function exportData(){
  if (await saveBackupNative('yotei-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ app:'yotei', v:3, data:backupData() }))) return;
  const o = backupData();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app:'yotei', v:3, data:o })], { type:'application/json' }));
  a.download = 'yotei-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove(); store.set('lastBackup', Date.now()); updateBackupInfo();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importData(file){
  if (file.size > 8 * 1024 * 1024){ tell('That file is too large to be a Yotei backup. Nothing was changed.'); return; }
  const r = new FileReader();
  r.onload = async () => {
    let j = null;
    try{ j = JSON.parse(r.result); }catch{}
    const P = 'yotei_v2_';
    const chk = validateBackup(j, P);
    if (!chk.ok){ tell('That file can\'t be used as a Yotei backup because ' + chk.why + '. Nothing was changed.'); return; }
    if (!await ask('Replace everything in Yotei with this backup?', { ok:'Replace', danger:true })) return;
    const old = store.dump(); let data = {};
    Object.keys(j.data).forEach(k => { data[k.slice(P.length)] = j.data[k]; });
    if (needsDateMigration(data)) data = migrateDates(data);   // backups from v2 use the old day format
    try{ await makeSnapshot('before-import'); }catch{}
    try{ await replaceAll(data); }
    catch{
      try{ await replaceAll(old); }catch{}
      tell('Import failed, possibly because storage is full. Your previous data was restored.');
      return;
    }
    location.reload();
  };
  r.readAsText(file);
}
$('#rst').addEventListener('click', async () => { if (await ask('Remove every routine task and reset all block names, colors and times? Your history is kept. You can undo this right after.', { ok:'Reset', danger:true })){ const snap = grab(); ['blocks', 'wins', 'ovr', 'wovr'].forEach(k => store.remove(k)); render(); showUndo('Routine reset', snap); } });
$('#exp').onclick = exportData;
async function openSnaps(){
  const why = { daily:'Daily', 'before-import':'Before an import', 'before-restore':'Before a restore', 'before-upgrade':'Before the update' };
  let L = []; try{ L = await listSnapshots(); }catch{}
  $('#snapList').innerHTML = L.length
    ? L.map(x => '<div class="snapRow"><span>' + esc(new Date(x.at).toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })) + ' · ' + esc(why[x.reason] || x.reason) + '</span><button data-id="' + esc(x.id) + '">Restore</button></div>').join('')
    : '<p class="wn">' + (info().backend === 'idb' ? 'No snapshots yet. The first one is saved the next time you open Yotei on a new day.' : 'Snapshots are not available ' + (IS_NATIVE ? 'on this device.' : 'in this browser.')) + '</p>';
  $('#snapDlg').showModal();
}
$('#snapBtn').onclick = openSnaps;
$('#snap_x').onclick = () => $('#snapDlg').close();
$('#snapList').addEventListener('click', async e => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  if (!await ask('Replace everything in Yotei with this snapshot? Your current data is saved as a snapshot first.', { ok:'Replace', danger:true })) return;
  try{ await restoreSnapshot(b.dataset.id); location.reload(); }catch{ tell('Could not restore that snapshot. Nothing was changed.'); }
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
// ---- keyboard: when it opens the page shrinks, so hide the tab bar, + button and week strip and keep the field in view ----
let vhMax = innerHeight, vwLast = innerWidth;
function kbUpdate(){
  if (innerWidth !== vwLast){ vwLast = innerWidth; vhMax = innerHeight; }          // rotated: measure again
  vhMax = Math.max(vhMax, innerHeight);
  const ae = document.activeElement;
  const typing = !!ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && !/^(checkbox|radio|button|file|range|color|submit)$/.test(ae.type || '');
  const open = typing && innerHeight < vhMax - 120, was = document.body.classList.contains('kb');
  document.body.classList.toggle('kb', open);
  if (open && !was && !ae.closest('dialog')) setTimeout(() => { try{ ae.scrollIntoView({ block:'center', behavior:'smooth' }); }catch{} }, 120);
}
window.addEventListener('resize', kbUpdate);
document.addEventListener('focusin', () => setTimeout(kbUpdate, 250));
document.addEventListener('focusout', () => setTimeout(kbUpdate, 100));
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
async function applyTpl(list, name){
  const min = TPL[list].sets[name].reduce((a, x) => a + x[1], 0);
  if (!await ask('Replace your ' + TPL[list].label.toLowerCase() + ' with "' + name + '" (' + min + ' min)? Your current list for this routine will be overwritten.', { ok:'Replace' })) return;
  tplApply(list, name); render();
}
// ---- Android app: reminders are handed to the phone's alarm system, so they fire when the app is closed ----
var remNative = { perm:null, exact:null }, remTimer = null, remBusy = false, remAgain = false, remSig = null;
const REM_DAYS = 3, REM_CHANNEL = 'yotei-reminders', REM_TEST_ID = 1;
async function remNativeState(){
  const LN = nativePlugin('LocalNotifications'); if (!LN) return;
  try{ remNative.perm = (await LN.checkPermissions()).display; }catch{}
  try{ remNative.exact = (await LN.checkExactNotificationSetting()).exact_alarm; }catch{ remNative.exact = 'granted'; }
  const c = $('#remCard'); if (c) c.innerHTML = remCard();
}
function remRowsFor(ds){
  const sv = { wake, day, done };
  try{ loadDay(ds); return { rows: build(dowOf(ds)).rows, done: done.ids.slice() }; }
  finally{ wake = sv.wake; day = sv.day; done = sv.done; }
}
function remId(s){ let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h & 0x7fffffff) || 2; }
function remPlan(R){
  const out = [], now = Date.now(), seen = new Set();
  for (let i = 0; i < REM_DAYS; i++){
    const d = parseDay(todayStr()); d.setDate(d.getDate() + i);
    const ds = isoLocal(d), { rows, done: dn } = remRowsFor(ds);
    rows.filter(r => r.use > 0 && !r.sug && !dn.includes(r.id)).forEach(r => {
      const at = parseDay(ds); at.setHours(0, r.start - R.lead, 0, 0);
      if (at.getTime() <= now + 2000) return;
      let id = remId(ds + '|' + r.id + '|' + r.start); while (id === REM_TEST_ID || seen.has(id)) id++; seen.add(id);
      out.push({ id, at, ds, rid: r.id, t: r.t, title: R.lead ? r.t + ' in ' + R.lead + ' min' : 'Time for ' + r.t, body: range(r.start, r.end) });
    });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 60);
}
function remSoon(force){
  if (!IS_NATIVE) return;
  if (force) remSig = null;
  clearTimeout(remTimer); remTimer = setTimeout(remSync, 2500);
}
const REM_ACTIONS = 'TASK';
async function remActions(LN){ try{ await LN.registerActionTypes({ types:[{ id:REM_ACTIONS, actions:[{ id:'done', title:'Done' }, { id:'snooze', title:'Snooze 10 min' }] }] }); }catch{} }
function markDoneFor(ds, id){
  const sv = { vd:viewDate, wake, day, done };
  try{ viewDate = ds; loadDay(ds); if (!done.ids.includes(id)) done.ids.push(id); saveDay(); }
  finally{ viewDate = sv.vd; wake = sv.wake; day = sv.day; done = sv.done; }
  render();
}
async function onNotifAction(ev){
  const LN = nativePlugin('LocalNotifications'), n = ev && ev.notification, ex = (n && n.extra) || {};
  if (!LN || !ex.ds || !ex.rid) return;
  try{ await LN.cancel({ notifications:[{ id:n.id }] }); }catch{}
  if (ev.actionId === 'done'){ markDoneFor(ex.ds, ex.rid); remSoon(true); toast('Marked done: ' + (ex.t || 'task')); }
  else if (ev.actionId === 'snooze'){
    const at = new Date(Date.now() + 10 * 60000), id = remId('snz|' + ex.ds + '|' + ex.rid + '|' + at.getTime());
    try{
      await remChannel(LN); await remActions(LN);
      await LN.schedule({ notifications:[{ id, title:(ex.t || 'Task'), body:'Snoozed for 10 minutes', channelId:REM_CHANNEL, actionTypeId:REM_ACTIONS, extra:ex, schedule:{ at, allowWhileIdle:true } }] });
      store.set('snz', store.get('snz', []).filter(s => s.at > Date.now()).concat({ id, at:at.getTime() })); toast('Snoozed for 10 minutes');
    }catch{}
  }
}
if (IS_NATIVE){ const LN0 = nativePlugin('LocalNotifications'); if (LN0 && LN0.addListener) try{ LN0.addListener('localNotificationActionPerformed', onNotifAction); }catch{} }
async function remChannel(LN){ await LN.createChannel({ id:REM_CHANNEL, name:'Task reminders', description:'Tells you when a task is about to start', importance:4, vibration:true }); }
async function remSync(){
  const LN = nativePlugin('LocalNotifications'); if (!LN) return;
  if (remBusy){ remAgain = true; return; }
  remBusy = true;
  try{
    const R = store.get('rem', { on:false, lead:0 });
    const ok = R.on && (await LN.checkPermissions()).display === 'granted';
    const plan = ok ? remPlan(R) : [], sig = plan.map(p => p.id + '@' + p.at.getTime() + p.title).join('|');
    if (sig === remSig) return;
    const snz = new Set(store.get('snz', []).filter(s => s.at > Date.now()).map(s => s.id));      // snoozed reminders stay
    const old = ((await LN.getPending()).notifications || []).filter(n => n.id !== REM_TEST_ID && !snz.has(n.id)).map(n => ({ id: n.id }));
    if (old.length) await LN.cancel({ notifications: old });
    if (plan.length){
      await remChannel(LN); await remActions(LN);
      await LN.schedule({ notifications: plan.map(p => ({ id: p.id, title: p.title, body: p.body, channelId: REM_CHANNEL, actionTypeId: REM_ACTIONS, extra: { ds: p.ds, rid: p.rid, t: p.t }, schedule: { at: p.at, allowWhileIdle: true } })) });
    }
    remSig = sig;
  }catch(err){ console.warn('Yotei reminders:', err); }
  finally{ remBusy = false; if (remAgain){ remAgain = false; remSoon(); } }
}
function remCard(){
  const R = store.get('rem', { on:false, lead:0 }), has = 'Notification' in window, perm = has ? Notification.permission : 'unsupported', on = R.on && perm === 'granted';
  const leadSel = '<div class="capRow"><label for="remLead">Remind me</label><select id="remLead">' + [[0, 'At start'], [5, '5 min before'], [10, '10 min before']].map(o => '<option value="' + o[0] + '"' + (R.lead === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>';
  if (IS_NATIVE){
    const p = remNative.perm, nOn = R.on && p === 'granted';
    const st = p === 'denied' ? 'Notifications are blocked. Turn them on for Yotei in Android Settings, under Apps, Yotei, Notifications.' : nOn ? 'Reminders are on.' : 'Reminders are off.';
    const ex = nOn && remNative.exact === 'denied' ? '<p class="wn">For reminders on the exact minute, allow "Alarms &amp; reminders" for Yotei. Without it Android can delay them by a few minutes.</p><div class="ea"><button id="remExact">Allow exact timing</button></div>' : '';
    return '<h2>Reminders</h2><p class="wn">' + st + '</p><p class="wn">Yotei sets reminders for today and the next two days with your phone\'s alarm system, so they fire even when the app is closed. If some do not show up, allow notifications and unrestricted battery use for Yotei in Android Settings.</p><p class="wn">Tasks in a part of the day where you have not chosen Home, School or Away get no reminders. Set your Usual days under Schedule so coming days are ready.</p>' + ex + leadSel + '<div class="ea"><button id="remToggle">' + (nOn ? 'Turn off' : 'Turn on') + '</button><button id="remTest">Send test</button></div>';
  }
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
  if (IS_NATIVE || !R.on || !('Notification' in window) || Notification.permission !== 'granted') return;
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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible'){ remCheck(); if (IS_NATIVE){ remNativeState(); remSoon(); autoBackupMaybe(); } } });
if (IS_NATIVE){ remNativeState(); remSoon(true); }
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
    else if (IS_NATIVE){
      const LN = nativePlugin('LocalNotifications');
      try{ let p = await LN.checkPermissions(); if (p.display !== 'granted') p = await LN.requestPermissions(); R.on = p.display === 'granted'; }catch{ R.on = false; }
    }
    else if ('Notification' in window){ const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); R.on = p === 'granted'; }
    store.set('rem', R);
    if (IS_NATIVE){ await remNativeState(); remSoon(true); } else $('#remCard').innerHTML = remCard();
  }
  if (t.id === 'remExact'){ try{ await nativePlugin('LocalNotifications').changeExactNotificationSetting(); }catch{} }
  if (t.id === 'remTest' && IS_NATIVE){
    const LN = nativePlugin('LocalNotifications'), R = store.get('rem', { on:false, lead:0 });
    if (!LN || !R.on || remNative.perm !== 'granted'){ tell('Turn on reminders first.'); return; }
    try{
      await remChannel(LN);
      await LN.schedule({ notifications: [{ id:REM_TEST_ID, title:'Yotei', body:'Reminders are working.', channelId:REM_CHANNEL, schedule:{ at:new Date(Date.now() + 3000), allowWhileIdle:true } }] });
      toast('Test reminder coming in a few seconds.');
    }catch{ tell('Could not send a test reminder.'); }
    return;
  }
  if (t.id === 'remTest'){
    if ('Notification' in window && Notification.permission === 'granted') notify('Yotei', 'Reminders are working.', 'test');
    else tell('Turn on reminders first.');
  }
});
$('#tab-settings').addEventListener('change', e => {
  if (e.target.id !== 'remLead') return;
  const R = store.get('rem', { on:false, lead:0 }); R.lead = Number(e.target.value); store.set('rem', R); remSoon(true);
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
$('#dnote').parentElement.insertAdjacentHTML('beforebegin', '<div class="inbox" id="inboxCard"></div>');
$('#tab-inbox').appendChild($('#inboxCard'));
const IN_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 7.5v9M7.5 12h9" stroke="var(--bg)"/></svg>';
const IN_TRAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" fill="currentColor" stroke="none" opacity=".25"/><path d="M4 13h4.5l1.2 2.2h4.6L15.5 13H20M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/></svg>';
function drawInbox(){
  const el = $('#inboxCard'); if (!el) return;
  const list = store.get('inbox', []);
  const btn = '<button class="inNew" id="inNew">' + IN_PLUS + '<span>New Inbox Task</span></button>';
  const items = list.map(x => '<div class="inCard"><div class="inMain"><span class="inT">' + esc(x.t) + '</span><button type="button" class="inGo" data-sch="' + x.id + '">' + IN_CAL + 'Schedule</button></div><button type="button" class="inRm" data-rm="' + x.id + '" aria-label="Delete ' + esc(x.t) + '">&times;</button></div>').join('');
  el.innerHTML = list.length
    ? btn + '<div class="inCards">' + items + '</div>'
    : '<div class="inEmpty"><div class="inIcon">' + IN_TRAY + '</div><h2>Your Unscheduled Thoughts</h2><p class="wn">Capture tasks and thoughts as they come. Move them to your timeline when you\u2019re ready to schedule.</p>' + btn + '</div>';
}
const IN_CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
function openInboxComposer(){ setTab('inbox'); openQuickAdd(); }
$('#inboxCard').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'inNew'){ openQuickAdd(); return; }
  if (b.dataset.rm){ const _s = grab(); store.set('inbox', store.get('inbox', []).filter(x => x.id !== b.dataset.rm)); drawInbox(); showUndo('Removed from inbox', _s); }
  else if (b.dataset.sch){
    const it = store.get('inbox', []).find(x => x.id === b.dataset.sch);
    if (it){ openEd('oo', null, defaultWin()); $('#e_t').value = it.t; cur.fromInbox = it.id; }
  } else if (b.id === 'ooNew') openEd('oo', null, defaultWin());
  else if (b.id === 'cpDay') openMv('day');
  else if (b.id === 'lateBtn') openShift();
});

// ---- quick-add box (Inbox). It is a dialog, so the keyboard cannot push the page around. ----
function openQuickAdd(){
  $('#qa_title').textContent = 'New inbox task'; $('#qa_ok').textContent = 'Add'; $('#qa_t').placeholder = 'Add a task'; $('#qa_t').value = '';
  $('#qaDlg').showModal(); $('#qa_t').focus(); setTimeout(() => $('#qa_t').focus(), 80);
}
function qaSave(){
  const v = $('#qa_t').value.trim(); if (!v) return;
  const l = store.get('inbox', []); l.push({ id:'i' + Date.now().toString(36), t:v }); store.set('inbox', l); drawInbox();
  $('#qaDlg').close();
}
$('#qa_ok').onclick = qaSave;
$('#qa_x').onclick = () => $('#qaDlg').close();
$('#qa_t').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); qaSave(); } });

// ---- To-do tab: lists as chips, star, due date, subtasks, drag to reorder, sort, show done ----
let tdSel = 'all';       // the chip that is selected: 'all', a smart view ('sv:today' | 'sv:upcoming' | 'sv:starred'), or a list id
let tdCalMonth = null, tdCalDay = null;   // calendar view: the month shown (YYYY-MM-01) and the selected day
const TD_SMART = [['sv:today', 'Today'], ['sv:upcoming', 'Upcoming'], ['sv:starred', 'Starred']];
const tdIsSmart = s => String(s).startsWith('sv:');
function tdListSel(ls){ return (ls || tdLists()).some(z => z.id === tdSel) ? tdSel : 'main'; }   // the list a new to-do goes into
function tdName(sel, ls){ const s = TD_SMART.find(z => z[0] === sel); return s ? s[1] : ((ls || tdLists()).find(z => z.id === sel) || { name:'Tasks' }).name; }
function tdIn(x, sel, ls){        // is this to-do part of the selected view?
  const td = todayStr();
  if (sel === 'all') return true;
  if (sel === 'sv:today') return !!x.due && x.due <= td;       // today and overdue
  if (sel === 'sv:upcoming') return !!x.due && x.due > td;
  if (sel === 'sv:starred') return !!x.star;
  return tdListOf(x, ls) === sel;
}
const TD_REP = { d:'Daily', wd:'Weekdays', w:'Weekly', m:'Monthly', y:'Yearly' };
const TD_LOOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l3 3-3 3M20 5H8a4 4 0 0 0-4 4v1M7 22l-3-3 3-3M4 19h12a4 4 0 0 0 4-4v-1"/></svg>';
function tdNext(x){        // the next due date of a repeating to-do: after its current date, and never before today
  const td = todayStr(); let d = parseDay(x.due), n = 0;
  const step = () => {
    const y = d.getFullYear(), mo = d.getMonth(), dd = d.getDate();
    if (x.rep === 'd') d = new Date(y, mo, dd + 1);
    else if (x.rep === 'wd'){ d = new Date(y, mo, dd + 1); while (d.getDay() === 0 || d.getDay() === 6) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); }
    else if (x.rep === 'w') d = new Date(y, mo, dd + 7);
    else if (x.rep === 'm') d = new Date(y, mo + 1, Math.min(dd, new Date(y, mo + 2, 0).getDate()));
    else d = new Date(y + 1, mo, Math.min(dd, new Date(y + 1, mo + 1, 0).getDate()));
  };
  do { step(); } while (isoLocal(d) < td && ++n < 800);
  return isoLocal(d);
}
function tdAdvance(it){ it.due = tdNext(it); if (Array.isArray(it.steps)) it.steps.forEach(s => { s.d = false; }); }   // done once: on to the next date
const tdOpen = new Set();   // to-dos whose subtasks and note are showing
const IN_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>';
const TD_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>';
const TD_STEP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/></svg>';
const TD_NOTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
function tdLists(){ const s = store.get('todoLists', null), a = Array.isArray(s) ? s.filter(x => x && x.id).slice() : []; if (!a.some(x => x.id === 'main')) a.unshift({ id:'main', name:'Tasks' }); return a; }
function tdListOf(x, ls){ return x.l && (ls || tdLists()).some(z => z.id === x.l) ? x.l : 'main'; }
function tdPrefs(){ const p = Object.assign({ sort:'date', done:true, hide:[], mode:'list' }, store.get('todoPrefs', {})); if (p.sort === 'due') p.sort = 'date'; return p; }
function tdSetPref(k, v){ const p = store.get('todoPrefs', {}); p[k] = v; store.set('todoPrefs', p); }
const tdMin = s => { const z = /^(\d{2}):(\d{2})$/.exec(s || ''); return z ? +z[1] * 60 + +z[2] : null; };
function tdDue(x){        // the due label, and whether the to-do is overdue
  if (!x.due) return null;
  const td = todayStr(), t0 = parseDay(td), n = k => { const d = new Date(t0); d.setDate(t0.getDate() + k); return isoLocal(d); };
  const mins = tdMin(x.dt), late = !x.done && (x.due < td || (x.due === td && mins !== null && mins < nowM()));
  const day = x.due === td ? 'Today' : x.due === n(1) ? 'Tomorrow' : x.due === n(-1) ? 'Yesterday'
    : parseDay(x.due).toLocaleDateString(undefined, Object.assign({ weekday:'short', month:'short', day:'numeric' }, x.due.slice(0, 4) !== td.slice(0, 4) ? { year:'numeric' } : {}));
  return { late, today:x.due === td, text:(late ? 'Overdue \u00b7 ' : '') + day + (mins !== null ? ', ' + fmt(mins).join(' ') : '') };
}
const TD_COLORS = ['#5e96cb', '#22c55e', '#f59e0b', '#ec4899', '#a78bfa', '#14b8a6'];
const TD_CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
const TD_SECS = [['late', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['upcoming', 'Upcoming'], ['none', 'No date']];
function drawTodo(){
  const el = $('#todoCard'); if (!el) return;
  const lists = tdLists(); if (tdSel !== 'all' && !tdIsSmart(tdSel) && !lists.some(x => x.id === tdSel)) tdSel = 'all';
  const P = tdPrefs(), all = store.get('todos', []), view = all.filter(x => tdIn(x, tdSel, lists)), isList = lists.some(x => x.id === tdSel), showCal = P.mode === 'cal' && !tdIsSmart(tdSel);
  const nameOf = id => (lists.find(x => x.id === id) || lists[0]).name;
  const chips = '<div class="tdChipsW"><div class="tdChips" role="tablist" aria-label="Lists">' + [{ id:'all', name:'All' }].concat(TD_SMART.map(z => ({ id:z[0], name:z[1], sv:true })), lists).map(x => '<button type="button" role="tab" class="tdChip' + (x.id === tdSel ? ' on' : '') + '" data-ls="' + x.id + '" aria-selected="' + (x.id === tdSel) + '">' + esc(x.name) + (x.sv ? '<span class="tdCn">' + all.filter(z => !z.done && tdIn(z, x.id, lists)).length + '</span>' : '') + '</button>').join('') + '</div><button type="button" class="tdChip tdAddL" data-ls="+" aria-label="New list">+</button></div>';
  const btn = '<button class="inNew" id="tdNew">' + IN_PLUS + '<span>New To-do</span></button>';
  if (!view.length && !showCal){
    el.innerHTML = chips + '<div class="inEmpty"><div class="inIcon">' + IN_CHECK + '</div><h2>' + (tdSel === 'all' ? 'Your To-do List' : esc(tdName(tdSel, lists))) + '</h2><p class="wn">' + (tdSel === 'all' ? 'A simple checklist for things to get done. Add a date if it has a deadline, and tick them off as you go.' : 'Nothing here yet.') + '</p>' + btn + (isList ? '<button type="button" class="tdLink" id="tdListEdit">Edit list</button>' : '') + '</div>';
    return;
  }
  const td = todayStr(), tmr = (() => { const d = parseDay(td); d.setDate(d.getDate() + 1); return isoLocal(d); })();
  const isLate = x => { const d = tdDue(x); return !!(d && d.late); };
  const bucket = x => !x.due ? 'none' : isLate(x) ? 'late' : x.due === td ? 'today' : x.due === tmr ? 'tomorrow' : x.due > tmr ? 'upcoming' : 'late';
  const open = view.filter(x => !x.done), dn = view.filter(x => x.done);
  const dueKey = x => (x.due || '9999-99-99') + ' ' + (x.dt || '99:99');
  const starFirst = (a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0);
  const sortFn = P.sort === 'az' ? (a, b) => a.t.localeCompare(b.t) : P.sort === 'new' ? (a, b) => String(b.id).localeCompare(String(a.id)) : null;
  const arrange = a => sortFn ? a.slice().sort(sortFn) : a;
  const row = (x, canDrag) => {
    const li = lists.findIndex(z => z.id === tdListOf(x, lists)), lc = li <= 0 ? 'var(--accent)' : TD_COLORS[li % TD_COLORS.length];
    const di = tdDue(x), st = Array.isArray(x.steps) ? x.steps : [], nd = st.filter(s => s.d).length, ex = tdOpen.has(x.id) && (st.length || x.note);
    const tagTxt = lists.length > 1 && !isList ? '<span class="tdTag">' + esc(nameOf(tdListOf(x, lists))) + '</span>' : '';
    const exBtn = (ic, txt, lab) => '<button type="button" class="tdMb" data-ex="' + x.id + '" aria-expanded="' + !!ex + '" aria-label="' + lab + '">' + ic + txt + '</button>';
    const meta = (di ? '<span class="tdDue' + (di.late ? ' late' : di.today ? ' today' : '') + '">' + TD_CAL + esc(di.text) + '</span>' : '') + (x.rep && TD_REP[x.rep] ? '<span class="tdRep">' + TD_LOOP + TD_REP[x.rep] + '</span>' : '') +
      (st.length ? exBtn(TD_STEP, nd + '/' + st.length, 'Subtasks, ' + nd + ' of ' + st.length + ' done') : '') + (x.note ? exBtn(TD_NOTE, '', 'Note') : '') + tagTxt;
    const exp = ex ? '<div class="tdExp">' + st.map((s, i) => '<button type="button" class="tdStp' + (s.d ? ' done' : '') + '" data-sg="' + x.id + '" data-si="' + i + '"><span class="tdSc"></span><span>' + esc(s.t) + '</span></button>').join('') + (x.note ? '<div class="tdNote">' + esc(x.note) + '</div>' : '') + '</div>' : '';
    return '<div class="tdItem' + (x.done ? ' done' : '') + '" data-id="' + x.id + '" style="--lc:' + lc + '"><button class="tdChk" data-tg="' + x.id + '" aria-pressed="' + (x.done ? 'true' : 'false') + '" aria-label="' + (x.done ? 'Mark not done: ' : 'Mark done: ') + esc(x.t) + '"></button>' +
      '<div class="tdMain"><button class="tdTxt" data-ed="' + x.id + '">' + esc(x.t) + '</button>' + (meta ? '<div class="tdMeta">' + meta + '</div>' : '') + exp + '</div>' +
      ((!x.done || (canDrag && !x.done)) ? '<div class="tdSide">' + (x.done ? '' : '<button class="tdStar' + (x.star ? ' on' : '') + '" data-st="' + x.id + '" aria-pressed="' + (x.star ? 'true' : 'false') + '" aria-label="' + (x.star ? 'Remove star: ' : 'Star: ') + esc(x.t) + '">' + TD_STAR + '</button>') + (!x.done && canDrag ? '<span class="tdH" aria-label="Drag to reorder" title="Drag to reorder">&#8942;&#8942;</span>' : '') + '</div>' : '') + '</div>';
  };
  const grp = (a, g, canDrag) => a.length ? '<div class="tdList" data-grp="' + g + '">' + a.map(x => row(x, canDrag)).join('') + '</div>' : '';
  const opt = (v, t) => '<option value="' + v + '"' + (P.sort === v ? ' selected' : '') + '>' + t + '</option>';
  const vt = '<div class="tdView" role="group" aria-label="View"><button type="button" data-vm="list" aria-pressed="' + !showCal + '" aria-label="List view"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/></svg></button><button type="button" data-vm="cal" aria-pressed="' + showCal + '" aria-label="Calendar view">' + TD_CAL + '</button></div>';
  const edl = isList ? '<button type="button" class="tdEdl" id="tdListEdit" aria-label="Edit list"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>' : '';
  if (showCal){ el.innerHTML = chips + '<div class="tdBar"><span></span><div class="tdBarR">' + vt + edl + '</div></div>' + tdCalHtml(view, grp, lists); return; }
  const bar = '<div class="tdBar"><label class="tdSortL"><span>Sort</span><select id="td_sort" aria-label="Sort by">' + opt('date', 'By date') + opt('mine', 'My order') + opt('az', 'A to Z') + opt('new', 'Newest first') + '</select></label><div class="tdBarR">' + vt + edl + '</div></div>';
  let body = '';
  if (P.sort === 'date'){
    const hide = new Set(P.hide || []);
    TD_SECS.forEach(([k, label]) => {
      const items = open.filter(x => bucket(x) === k).sort((a, b) => starFirst(a, b) || (k === 'none' ? 0 : dueKey(a).localeCompare(dueKey(b))));
      if (!items.length) return;
      const o = !hide.has(k);
      body += '<section class="tdSec' + (k === 'late' ? ' late' : '') + '"><button type="button" class="tdSecH" data-sec="' + k + '" aria-expanded="' + o + '"><span>' + label + '</span><span class="tdN">' + items.length + '</span><svg viewBox="0 0 24 24" aria-hidden="true" class="' + (o ? 'open' : '') + '"><path d="M6 9l6 6 6-6"/></svg></button>' + (o ? grp(items, k, k === 'none') : '') + '</section>';
    });
  } else {
    const drag = P.sort === 'mine';
    body = grp(arrange(open.filter(x => x.star)), 'star', drag) + grp(arrange(open.filter(x => !x.star && isLate(x))), 'late', drag) + grp(arrange(open.filter(x => !x.star && !isLate(x))), 'norm', drag);
  }
  el.innerHTML = chips + btn + bar + body +
    (dn.length ? '<p class="tdSub"><button type="button" id="tdDoneTog" aria-expanded="' + P.done + '">Done (' + dn.length + ')<svg viewBox="0 0 24 24" aria-hidden="true" class="' + (P.done ? 'open' : '') + '"><path d="M6 9l6 6 6-6"/></svg></button><button type="button" id="tdClear">Clear done</button></p>' + (P.done ? grp(arrange(dn), 'done', false) : '') : '');
}
function tdCalHtml(view, grp, lists){
  const td = todayStr();
  if (!tdCalMonth) tdCalMonth = td.slice(0, 7) + '-01';
  if (!tdCalDay) tdCalDay = td;
  const m0 = parseDay(tdCalMonth), y = m0.getFullYear(), mo = m0.getMonth();
  const first = new Date(y, mo, 1), lead = (first.getDay() + 6) % 7, dim = new Date(y, mo + 1, 0).getDate();
  const byDay = {}; view.forEach(x => { if (x.due) (byDay[x.due] = byDay[x.due] || []).push(x); });
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="calC off"></span>');
  for (let d = 1; d <= dim; d++){
    const iso = isoLocal(new Date(y, mo, d)), its = byDay[iso] || [], open = its.filter(x => !x.done);
    const dots = open.slice(0, 3).map(x => { const li = lists.findIndex(z => z.id === tdListOf(x, lists)); return '<i style="background:' + (x.due < td ? 'var(--bad)' : li <= 0 ? 'var(--accent)' : TD_COLORS[li % TD_COLORS.length]) + '"></i>'; }).join('');
    cells.push('<button type="button" class="calC' + (iso === td ? ' today' : '') + (iso === tdCalDay ? ' sel' : '') + '" data-cd="' + iso + '" aria-pressed="' + (iso === tdCalDay) + '" aria-label="' + esc(parseDay(iso).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })) + ', ' + open.length + ' to do"><b>' + d + '</b><span class="calD">' + dots + '</span></button>');
  }
  const head = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(n => '<span>' + n + '</span>').join('');
  const day = byDay[tdCalDay] || [], o = day.filter(x => !x.done), dn = day.filter(x => x.done);
  const chev = d => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  return '<div class="calHead"><button type="button" class="calNav" data-cm="-1" aria-label="Previous month">' + chev('M15 6l-6 6 6 6') + '</button><h2>' + esc(first.toLocaleDateString(undefined, { month:'long', year:'numeric' })) + '</h2><button type="button" class="calNav" data-cm="1" aria-label="Next month">' + chev('M9 6l6 6-6 6') + '</button><button type="button" class="tdLink" data-cm="0">Today</button></div>' +
    '<div class="calGrid calWd" aria-hidden="true">' + head + '</div><div class="calGrid">' + cells.join('') + '</div>' +
    '<div class="calDay"><h3>' + esc(parseDay(tdCalDay).toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' })) + '</h3>' + (o.length ? grp(o, 'cal', false) : '') +
    (dn.length ? '<p class="tdSub"><span>Done (' + dn.length + ')</span></p>' + grp(dn, 'caldone', false) : '') + (!day.length ? '<p class="wn">Nothing due on this day.</p>' : '') +
    '<button type="button" class="tdLink" id="calAdd">+ Add a to-do for this day</button></div>';
}
$('#todoCard').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.ls){ if (b.dataset.ls === '+') openListDlg(null); else { tdSel = b.dataset.ls; drawTodo(); } return; }
  if (b.dataset.vm){ tdSetPref('mode', b.dataset.vm); if (b.dataset.vm === 'cal' && tdIsSmart(tdSel)) tdSel = 'all'; drawTodo(); return; }
  if (b.dataset.cd){ tdCalDay = b.dataset.cd; drawTodo(); return; }
  if (b.dataset.cm !== undefined){
    const n = +b.dataset.cm, td = todayStr();
    if (n === 0){ tdCalMonth = td.slice(0, 7) + '-01'; tdCalDay = td; }
    else { const d = parseDay(tdCalMonth || td.slice(0, 7) + '-01'); d.setMonth(d.getMonth() + n, 1); tdCalMonth = isoLocal(d); tdCalDay = tdCalMonth.slice(0, 7) === td.slice(0, 7) ? td : tdCalMonth; }
    drawTodo(); return;
  }
  if (b.id === 'calAdd'){ openTodoEd(null, { due:tdCalDay }); return; }
  if (b.id === 'tdNew'){ openTodoEd(null); return; }
  if (b.id === 'tdListEdit'){ openListDlg(tdSel); return; }
  if (b.id === 'tdDoneTog'){ tdSetPref('done', !tdPrefs().done); drawTodo(); return; }
  if (b.dataset.sec){ const h = new Set(tdPrefs().hide || []); if (h.has(b.dataset.sec)) h.delete(b.dataset.sec); else h.add(b.dataset.sec); tdSetPref('hide', [...h]); drawTodo(); return; }
  if (b.dataset.ex){ if (tdOpen.has(b.dataset.ex)) tdOpen.delete(b.dataset.ex); else tdOpen.add(b.dataset.ex); drawTodo(); return; }
  const l = store.get('todos', []);
  if (b.dataset.tg){
    const it = l.find(x => x.id === b.dataset.tg);
    if (it && !it.done && it.rep && it.due){        // a repeating to-do: ticking it moves it to its next date
      const _s = grab(); tdAdvance(it); store.set('todos', l); drawTodo(); try{ if (navigator.vibrate) navigator.vibrate(15); }catch{}
      showUndo('Done. Next: ' + (tdDue(it) || { text:it.due }).text, _s);
    } else if (it){ it.done = !it.done; store.set('todos', l); drawTodo(); try{ if (it.done && navigator.vibrate) navigator.vibrate(15); }catch{} }
  }
  else if (b.dataset.st){ const it = l.find(x => x.id === b.dataset.st); if (it){ if (it.star) delete it.star; else it.star = true; store.set('todos', l); drawTodo(); } }
  else if (b.dataset.sg){ const it = l.find(x => x.id === b.dataset.sg), s = it && Array.isArray(it.steps) ? it.steps[+b.dataset.si] : null; if (s){ s.d = !s.d; store.set('todos', l); drawTodo(); } }
  else if (b.dataset.ed) openTodoEd(b.dataset.ed);
  else if (b.id === 'tdClear'){
    const ls = tdLists(), _s = grab(); store.set('todos', l.filter(x => !(x.done && tdIn(x, tdSel, ls)))); drawTodo(); showUndo('Cleared the done to-dos', _s);
  }
});
$('#todoCard').addEventListener('change', e => { if (e.target.id === 'td_sort'){ tdSetPref('sort', e.target.value); drawTodo(); } });
// drag a to-do by its handle; it moves within its own group (starred, overdue, other, or done)
function tdReorder(ids){
  const l = store.get('todos', []), set = new Set(ids), slots = [];
  l.forEach((x, i) => { if (set.has(x.id)) slots.push(i); });
  const by = {}; l.forEach(x => { by[x.id] = x; });
  ids.forEach((id, k) => { if (by[id] !== undefined && slots[k] !== undefined) l[slots[k]] = by[id]; });
  store.set('todos', l); drawTodo();
}
(function(){
  let row = null, box = null; const card = $('#todoCard');
  card.addEventListener('pointerdown', e => { const h = e.target.closest('.tdH'); if (!h) return; row = h.closest('.tdItem'); box = row.parentElement; row.classList.add('drag'); h.setPointerCapture(e.pointerId); e.preventDefault(); });
  card.addEventListener('pointermove', e => {
    if (!row) return;
    const others = [...box.children].filter(r => r !== row); let before = null;
    for (const r of others){ const bb = r.getBoundingClientRect(); if (e.clientY < bb.top + bb.height / 2){ before = r; break; } }
    if (before !== row.nextElementSibling) box.insertBefore(row, before);
  });
  const end = () => { if (!row) return; const ids = [...box.children].map(r => r.dataset.id); row.classList.remove('drag'); row = null; box = null; tdReorder(ids); };
  card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
})();
// ---- the to-do editor: name, list, due date and time, star, note, subtasks ----
let tdeId = null;
function openTodoEd(id, preset){
  tdeId = id || null;
  const it = id ? store.get('todos', []).find(x => x.id === id) : null, ls = tdLists();
  $('#tde_title').textContent = it ? 'Edit to-do' : 'New to-do';
  $('#tde_t').value = it ? it.t : '';
  $('#tde_lw').style.display = ls.length > 1 ? '' : 'none';
  $('#tde_list').innerHTML = ls.map(x => '<option value="' + x.id + '">' + esc(x.name) + '</option>').join('');
  $('#tde_list').value = it ? tdListOf(it, ls) : tdListSel(ls);
  const tmr = (() => { const d = parseDay(todayStr()); d.setDate(d.getDate() + 1); return isoLocal(d); })();
  const pre = it ? {} : Object.assign(tdSel === 'sv:today' ? { due:todayStr() } : tdSel === 'sv:upcoming' ? { due:tmr } : tdSel === 'sv:starred' ? { star:true } : {}, preset || {});   // a new to-do starts as the view you are in
  $('#tde_d').value = it ? it.due || '' : pre.due || ''; $('#tde_tm').value = it && it.dt || ''; $('#tde_rep').value = it && it.rep || '';
  const on = !!(it ? it.star : pre.star); $('#tde_star').classList.toggle('on', on); $('#tde_star').setAttribute('aria-pressed', on);
  $('#tde_note').value = it && it.note || '';
  tdeSteps.set(it && it.steps);
  $('#tde_err').hidden = true; $('#tde_del').style.display = it ? '' : 'none'; $('#tde_move').style.display = it ? '' : 'none';
  $('#tdeDlg').showModal(); $('#tdeDlg .ef').scrollTop = 0;
  if (!it){ $('#tde_t').focus(); setTimeout(() => $('#tde_t').focus(), 80); } else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function tdeSave(){
  const err = msg => { $('#tde_err').textContent = msg; $('#tde_err').hidden = false; };
  const t = $('#tde_t').value.trim(); if (!t){ err('Give the to-do a name.'); return; }
  let due = $('#tde_d').value; const dt = $('#tde_tm').value, rep = $('#tde_rep').value;
  if (rep && !due) due = todayStr();             // a repeating to-do needs a date to start from
  if (dt && !due){ err('Pick a date for that time, or clear the time.'); return; }
  const l = store.get('todos', []); let it = tdeId ? l.find(x => x.id === tdeId) : null;
  if (!it){ it = { id:'t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), done:false }; l.push(it); }
  const put = (k, v) => { if (v) it[k] = v; else delete it[k]; };
  it.t = t; it.l = $('#tde_lw').style.display === 'none' ? (it.l || tdListSel()) : $('#tde_list').value;
  put('due', due); put('dt', due ? dt : ''); put('rep', rep); put('star', $('#tde_star').classList.contains('on') ? true : undefined);
  put('note', $('#tde_note').value.trim());
  const st = tdeSteps.get(); if (st.length) it.steps = st; else delete it.steps;
  store.set('todos', l); $('#tdeDlg').close(); drawTodo();
}
$('#tde_ok').onclick = tdeSave;
$('#tde_x').onclick = () => $('#tdeDlg').close();
$('#tde_t').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); tdeSave(); } });
$('#tde_star').onclick = () => { const on = !$('#tde_star').classList.contains('on'); $('#tde_star').classList.toggle('on', on); $('#tde_star').setAttribute('aria-pressed', on); };
$('#tde_chips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return; const q = b.dataset.q;
  if (q === 'nd'){ $('#tde_d').value = ''; $('#tde_tm').value = ''; }
  else if (q === 'nt') $('#tde_tm').value = '';
  else { const d = parseDay(todayStr()); d.setDate(d.getDate() + +q); $('#tde_d').value = isoLocal(d); }
  $('#tde_err').hidden = true;
});
// Send to Timeline: opens the task editor with this to-do filled in. The to-do leaves the list only when that task is saved.
$('#tde_tl').onclick = () => {
  if (!tdeId) return;
  const t = $('#tde_t').value.trim(); if (!t){ $('#tde_err').textContent = 'Give the to-do a name.'; $('#tde_err').hidden = false; return; }
  const due = $('#tde_d').value, tm = tdMin($('#tde_tm').value), note = $('#tde_note').value.trim(), steps = tdeSteps.get().map(s => s.t), id = tdeId;
  $('#tdeDlg').close(); setTab('home');
  if (due && due >= todayStr() && due !== viewDate) goDate(due);        // schedule it on its due day
  openEd('oo', null, defaultWin(), due && tm !== null ? tm : undefined);
  $('#e_t').value = t; $('#e_details').value = note; edSteps.set(steps); cur.fromTodo = id;
};
$('#tde_inbox').onclick = async () => {
  if (!tdeId) return;
  const t = $('#tde_t').value.trim(); if (!t){ $('#tde_err').textContent = 'Give the to-do a name.'; $('#tde_err').hidden = false; return; }
  const lose = $('#tde_d').value || $('#tde_note').value.trim() || tdeSteps.get().length;
  if (lose && !await ask('Inbox tasks keep only a name, so the date, note and subtasks would be dropped. Move it anyway?', { ok:'Move to Inbox' })) return;
  const _s = grab(), id = tdeId;
  const ib = store.get('inbox', []); ib.push({ id:'i' + Date.now().toString(36), t }); store.set('inbox', ib);
  store.set('todos', store.get('todos', []).filter(x => x.id !== id));
  $('#tdeDlg').close(); drawTodo(); drawInbox(); showUndo('Moved to Inbox', _s);
};
$('#tde_del').onclick = () => {
  if (!tdeId) return; const _s = grab(); store.set('todos', store.get('todos', []).filter(x => x.id !== tdeId)); $('#tdeDlg').close(); drawTodo(); showUndo('To-do removed', _s);
};
// ---- list names ----
let tdlEdit = null;
function openListDlg(id){
  tdlEdit = id; const it = id ? tdLists().find(x => x.id === id) : null;
  $('#tdl_title').textContent = it ? 'Edit list' : 'New list'; $('#tdl_t').value = it ? it.name : '';
  $('#tdl_del').hidden = !it || id === 'main';
  $('#tdlDlg').showModal(); $('#tdl_t').focus(); setTimeout(() => $('#tdl_t').focus(), 80);
}
function tdlSave(){
  const v = $('#tdl_t').value.trim(); if (!v) return;
  const ls = tdLists(), it = tdlEdit ? ls.find(x => x.id === tdlEdit) : null;
  if (it) it.name = v; else { const id = 'l' + Date.now().toString(36); ls.push({ id, name:v }); tdSel = id; }
  store.set('todoLists', ls); $('#tdlDlg').close(); drawTodo();
}
$('#tdl_ok').onclick = tdlSave;
$('#tdl_x').onclick = () => $('#tdlDlg').close();
$('#tdl_t').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); tdlSave(); } });
$('#tdl_del').onclick = () => {
  const id = tdlEdit; if (!id || id === 'main') return;
  const _s = grab(), ls = tdLists().filter(x => x.id !== id), t = store.get('todos', []);
  t.forEach(x => { if (x.l === id) x.l = 'main'; });       // the to-dos are kept: they move to the first list
  store.set('todos', t); store.set('todoLists', ls); tdSel = 'all'; $('#tdlDlg').close(); drawTodo(); showUndo('List deleted. Its to-dos moved to ' + ls[0].name, _s);
};

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
    tell('Imported ' + r.added + ' event' + (r.added === 1 ? '' : 's') + '.' + (r.allDay ? ' Skipped ' + r.allDay + ' all-day.' : '') + (r.out ? ' Skipped ' + r.out + ' outside the date range.' : '') + (r.rec ? ' ' + r.rec + ' recurring (first occurrence only).' : ''));
  };
  rd.readAsText(f); e.target.value = '';
});
applyLook();

// ---- welcome cards (first run, after a reset, and from About) ----
let welFlow = false, welIdx = 0;
function welGo(i){
  const t = $('#wl_track'), n = t.children.length; welIdx = Math.max(0, Math.min(n - 1, i));
  $('#wl_dots').innerHTML = Array.from({ length:n }, (_, k) => '<i' + (k === welIdx ? ' class="on"' : '') + '></i>').join('');
  $('#wl_next').textContent = welIdx === n - 1 ? (welFlow ? 'Get started' : 'Done') : 'Next';
  $('#wl_skip').hidden = welIdx === n - 1;
  [...t.children].forEach((c, k) => c.classList.toggle('on', k === welIdx));
  $('#welDlg').style.setProperty('--g', t.children[welIdx].style.getPropertyValue('--g') || '#3b82f6');
}
function openWelcome(flow){
  welFlow = !!flow; $('#welDlg').showModal(); $('#wl_track').scrollLeft = 0; welGo(0);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
$('#wl_track').addEventListener('scroll', () => { const t = $('#wl_track'), i = Math.round(t.scrollLeft / Math.max(1, t.clientWidth)); if (i !== welIdx) welGo(i); });
$('#wl_next').onclick = () => { const t = $('#wl_track'); if (welIdx >= t.children.length - 1) $('#welDlg').close(); else t.scrollTo({ left:(welIdx + 1) * t.clientWidth, behavior:'smooth' }); };
$('#wl_skip').onclick = () => $('#welDlg').close();
$('#welDlg').addEventListener('close', () => { if (welFlow){ welFlow = false; store.set('welcomed', true); openSetup(); } });
document.addEventListener('click', e => { if (e.target.id === 'replayWel') openWelcome(false); });

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
let scopeCtx = null, scDays = [], scModes = [], scFrom = '', scTo = '';
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
  $('#sc_range').style.display = (type === 'reset' || ctx.l === 'win') ? 'none' : '';       // dates are for tasks
  $('#sc_from').value = viewDate; $('#sc_to').value = '';
  { const tn = $('#sc_typesNote'), ts = ctx.types && type !== 'delete' ? ctx.types : null; tn.style.display = ts ? '' : 'none'; if (ts) tn.textContent = 'Day types: ' + ts.map(m => MODE_LABEL[m]).join(', ') + '. This applies to the options below, except "Only this day".'; }
  drawScChips(); $('#scopeDlg').showModal();
}
function applyScope(sc){ const _s = grab(), ty = scopeCtx && scopeCtx.type; needLive(); applyScope0(sc); showUndo(ty === 'delete' ? 'Task deleted' : ty === 'add' ? 'Task added' : 'Task updated', _s); }
// ---- deleting: must always work, whatever state an older version left the task in ----
function removeFromRoutines(c){
  const all = {}; TASK_LISTS.forEach(l => { all[l] = getBlocks(l); });
  const r = removeTask(all, { ...c, ...rowInfo(c.id) });
  if (r.list) setBlocks(r.list, r.blocks[r.list]);
  return !!r.list;
}
function rowInfo(id){ const r = schedule().rows.find(x => sameId(x.id, id)); return r ? { t: r.t, w: r.w } : {}; }
// A past day shows a frozen record of what was there. Deleting from it removes that entry from the record.
async function deleteFromRecord(c){
  if (!await ask('Remove this task from the record of this day?', { ok:'Remove', danger:true })) return;
  const _s = grab(), H = store.get('hist', {}), rec = H[viewDate], next = removeFromRecord(rec, { id: c.id, ...rowInfo(c.id) });
  if (next !== rec){ H[viewDate] = next; store.set('hist', H); }
  render(); showUndo('Task removed', _s);
}
// A task that is on screen but no longer in any routine.
function ghostDelete(l, id){
  if (snapMode()){ deleteFromRecord({ l, id }); return; }
  const _s = grab(); needLive();
  if (l === 'oo') setBlocks('oo', clone(getBlocks('oo')).filter(x => !sameId(x.id, id))); else removeFromRoutines({ l, id });
  render(); showUndo('Task deleted', _s);
}
function applyScope0(sc){
  const c = scopeCtx; if (!c) return;
  if (c.l === 'win'){ applyWinScope(sc, c); return; }
  const iso = viewDate, filt = {}, OV = store.get('ovr', {}), arr = clone(getBlocks(c.l));
  if (scDays.length) filt.days = scDays.slice().sort();
  if (scModes.length && (c.l === 'pre' || c.l === 'night')) filt.modes = scModes.slice();
  const hasFilt = !!(filt.days || filt.modes), push = (id, e) => { (OV[id] = OV[id] || []).push(e); };
  const range_ = sc === 'range' ? { from:scFrom || null, to:scTo || null } : { from:sc === 'all' ? null : iso, to:sc === 'day' ? iso : null };
  const stamp = o => { if (sc === 'from') o.from = (o.from && o.from > iso) ? o.from : iso; else if (sc === 'range'){ if (scFrom) o.from = scFrom; if (scTo) o.to = scTo; } return o; };   // the dates a new task carries
  if (c.type === 'add'){
    if (sc === 'day'){
      const o = { ...c.b, w:c.w || (c.l === 'pre' ? 'sleep' : c.l === 'night' ? 'wind' : 'climb1') };
      delete o.days; delete o.modes;
      day.oneoffs = (day.oneoffs || []).concat(o); saveDay();
    } else {
      const types = (c.types && c.types.length) ? c.types : [c.l], lk = types.length > 1 ? (c.b.lk || 'k' + c.id) : c.b.lk;
      types.forEach((tp, i) => {
        const b = stamp({ ...c.b, ...filt }); if (lk) b.lk = lk; if (i > 0) b.id = newTaskId(i);
        const a = tp === c.l ? arr : clone(getBlocks(tp)); a.push(b); setBlocks(tp, a);
      });
      if (c.l !== 'pre' && c.l !== 'night' && c.w && !typeOf(c.w) && types.includes(c.l)){ day.types[c.w] = c.l; saveDay(); }
    }
  } else if (c.type === 'delete'){
    if (sc === 'all' && !hasFilt){ removeFromRoutines(c); delete OV[c.id]; }
    else push(c.id, { ...range_, ...filt, patch:null });
  } else {
    const patch = diffBlock(c.old, c.b);
    const dp = {}; ['from', 'to'].forEach(k => { if (k in patch){ dp[k] = patch[k]; delete patch[k]; } });
    if (Object.keys(dp).length){                 // start and end dates belong to the task itself, whatever days the rest of the edit covers
      const bi0 = arr.findIndex(x => sameId(x.id, c.id)), lk0 = bi0 >= 0 ? arr[bi0].lk : null;
      const put = x => { const nb = { ...x }; Object.keys(dp).forEach(k => { if (dp[k] === null) delete nb[k]; else nb[k] = dp[k]; }); return nb; };
      if (bi0 >= 0) arr[bi0] = put(arr[bi0]);
      setBlocks(c.l, arr);
      if (lk0) WIN_LISTS.forEach(L => { if (L !== c.l) setBlocks(L, clone(getBlocks(L)).map(x => x.lk === lk0 ? put(x) : x)); });
    }
    if (Object.keys(patch).length){
      if (sc === 'all' && !hasFilt){
        { const bi = arr.findIndex(x => sameId(x.id, c.id)), nb = { ...arr[bi] }; Object.keys(patch).forEach(k => { if (patch[k] === null) delete nb[k]; else nb[k] = patch[k]; }); arr[bi] = nb; } setBlocks(c.l, arr);
        (OV[c.id] || []).forEach(e => { if (e.patch) Object.keys(patch).forEach(k => delete e.patch[k]); });
        OV[c.id] = (OV[c.id] || []).filter(e => e.patch === null || Object.keys(e.patch).length);
        if (!OV[c.id].length) delete OV[c.id];
      } else push(c.id, { ...range_, ...filt, patch });
    }
    if (c.types && WIN_LISTS.includes(c.l) && sc !== 'day'){
      const base = getBlocks(c.l).find(x => sameId(x.id, c.id)) || {}, copies = {};
      WIN_LISTS.forEach(L => { if (L !== c.l && base.lk){ const x = getBlocks(L).find(y => y.lk === base.lk); if (x) copies[L] = x; } });
      const have = [c.l, ...Object.keys(copies)], toAdd = c.types.filter(t => !have.includes(t)), toDrop = have.filter(t => !c.types.includes(t));
      let lk = base.lk;
      if (!lk && toAdd.length){ lk = 'k' + c.id; setBlocks(c.l, getBlocks(c.l).map(x => sameId(x.id, c.id) ? { ...x, lk } : x)); }
      const whole = sc === 'all' && !hasFilt, pt = { ...patch }; delete pt.lk;
      Object.keys(copies).forEach(L => {                       // copies that stay: carry the change over
        if (toDrop.includes(L) || !Object.keys(pt).length) return;
        if (whole) setBlocks(L, clone(getBlocks(L)).map(x => { if (x.id !== copies[L].id) return x; const nb = { ...x }; Object.keys(pt).forEach(k => { if (pt[k] === null) delete nb[k]; else nb[k] = pt[k]; }); return nb; }));
        else push(copies[L].id, { ...range_, ...filt, patch: { ...pt } });
      });
      toDrop.forEach(L => {                                    // unticked types: remove that copy
        const id = L === c.l ? c.id : copies[L].id;
        if (whole){ setBlocks(L, clone(getBlocks(L)).filter(x => !sameId(x.id, id))); delete OV[id]; }
        else push(id, { ...range_, ...filt, patch:null });
      });
      toAdd.forEach((L, i) => {                                // newly ticked types: add a copy
        const cp = stamp({ ...c.b, ...filt, id: newTaskId(i + 1), lk });
        const a = clone(getBlocks(L)); a.push(cp); setBlocks(L, a);
      });
    }
  }
  store.set('ovr', OV); scopeCtx = null; $('#scopeDlg').close(); $('#ed').close(); render();
}
$('#sc_days').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const i = Number(b.dataset.i); scDays = scDays.includes(i) ? scDays.filter(x => x !== i) : scDays.concat(i); drawScChips(); });
$('#sc_modes').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const m = b.dataset.m; scModes = scModes.includes(m) ? scModes.filter(x => x !== m) : scModes.concat(m); drawScChips(); });
$('#sc_opts').addEventListener('click', e => { const b = e.target.closest('button'); if (b) applyScope(b.dataset.sc); });
$('#sc_range_ok').onclick = () => {
  const f = $('#sc_from').value, t = $('#sc_to').value;
  if (!f && !t){ tell('Pick a start date, an end date, or both.'); return; }
  if (f && t && t < f){ tell('The end date is before the start date.'); return; }
  scFrom = f; scTo = t; applyScope('range');
};
$('#sc_x').onclick = () => $('#scopeDlg').close();
$('#e_del').onclick = () => {
  if (cur.l === 'oo'){ const _s = grab(); needLive(); setBlocks('oo', clone(getBlocks('oo')).filter(x => !sameId(x.id, cur.id))); $('#ed').close(); render(); showUndo('Task deleted', _s); return; }
  askScope(cur.l === 'win' ? 'reset' : 'delete', { l:cur.l, id:cur.id });
};
$('#ts_del').onclick = async () => {
  if (snapMode()){ $('#taskSheet').close(); deleteFromRecord(sheetCtx); return; }
  if (sheetCtx.l === 'oo'){ if (!await ask('Delete this task?', { ok:'Delete', danger:true })) return; const _s = grab(); needLive(); setBlocks('oo', clone(getBlocks('oo')).filter(x => !sameId(x.id, sheetCtx.id))); $('#taskSheet').close(); render(); showUndo('Task deleted', _s); return; }
  $('#taskSheet').close(); askScope('delete', { l:sheetCtx.l, id:sheetCtx.id });
};

// ---- move / copy a task, copy a day ----
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
  const r = schedule().rows.find(x => sameId(x.id, sheetCtx.id)); if (!r) return;
  const ds = kind === 'inbox' ? null : mvDate(); if (kind !== 'inbox' && !ds) return;
  const o = { id:'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), t:r.t, d:r.d !== undefined ? r.d : r.use };
  ['m', 'p', 'sug', 'icon', 'color', 'details', 'steps', 'fixed', 'at'].forEach(k => { if (r[k] !== undefined) o[k] = r[k]; });
  const tm = $('#mv_t').value;
  if (tm){ const [h, mi] = tm.split(':').map(Number); o.fixed = h * 60 + mi; if (!o.d) o.d = 20; }
  if (ds) o.w = o.fixed !== undefined ? winFor(o.fixed, (planFor(ds) || {}).w ?? defWake()) : (r.w || 'climb1');
  const removeHere = () => {
    if (sheetCtx.l === 'oo') day.oneoffs = (day.oneoffs || []).filter(x => !sameId(x.id, sheetCtx.id));
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
$('#mv_go').onclick = async () => {
  if (mvMode === 'task'){ mvDo('move'); return; }
  const ds = mvDate(); if (!ds) return;
  if (ds === viewDate){ tell('Pick a different day.'); return; }
  if (plans[ds] && !await ask('That day already has a plan. Replace it?', { ok:'Replace', danger:true })) return;
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
function hideToast(){ clearTimeout(toastT); toastUntil = 0; $('#toast').classList.remove('show'); }
function toast(msg, label, fn){
  clearTimeout(toastT);
  toastUntil = Date.now() + 7000; toastShownAt = Date.now();
  toastT = setTimeout(hideToast, 7000);                 // timer first, so nothing below can leave a toast stuck on screen
  $('#toastMsg').textContent = msg;
  const b = $('#toastBtn'); b.style.display = label ? '' : 'none'; b.textContent = label || '';
  b.onclick = () => { hideToast(); if (fn) fn(); };
  $('#toast').classList.add('show');
}
// Safety nets: a toast can never outlive its time, even if the phone paused the timer; tapping the message dismisses it.
setInterval(() => { if (toastUntil && Date.now() > toastUntil + 300) hideToast(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && toastUntil && Date.now() >= toastUntil) hideToast(); });
$('#toast').addEventListener('click', e => { if (e.target.id !== 'toastBtn') hideToast(); });
const UNDO_KEYS = ['blocks', 'ovr', 'plans', 'inbox', 'todos', 'todoLists', 'todoPrefs', 'taskNotes', 'hist', 'wins', 'wovr'];
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
const EN_NAMES = ['Drained', 'Low', 'Okay', 'Good', 'Great'], EN_COL = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];
function drawEnergy(){
  const el = $('#energyCard'); if (!el) return;
  if (viewDate !== todayStr() || snapMode()){ el.style.display = 'none'; return; }
  el.style.display = '';
  const T = store.get('energy', []).filter(x => x.d === todayStr()), last = T[T.length - 1];
  const btn = (n, i) => '<button data-en="' + (i + 1) + '" class="' + (last && last.v === i + 1 ? 'on' : '') + '" style="--ec:' + EN_COL[i] + ';--ecb:' + EN_COL[i] + '24" aria-pressed="' + !!(last && last.v === i + 1) + '" aria-label="' + (i + 1) + ', ' + n + '"><span class="enN">' + (i + 1) + '</span><span class="enL">' + n + '</span></button>';
  el.innerHTML = '<h2>How is your energy?</h2><div class="enRow' + (last ? ' has' : '') + '">' + EN_NAMES.map(btn).join('') + '</div>' +
    (last ? '<p class="wn enNow"><i style="background:' + EN_COL[last.v - 1] + '"></i><span><b>' + EN_NAMES[last.v - 1] + '</b> at ' + fmt(last.at).join(' ') + '. Tap it again to clear, or tap another to change.</span></p>'
          : '<p class="wn">Tap how you feel right now. A few ratings a day teach Yotei your rhythm.</p>');
}
$('#energyCard').addEventListener('click', e => {
  const b = e.target.closest('[data-en]'); if (!b) return;
  const L = store.get('energy', []), v = Number(b.dataset.en);
  let li = -1; for (let i = L.length - 1; i >= 0; i--) if (L[i].d === todayStr()){ li = i; break; }
  if (li >= 0 && L[li].v === v){ L.splice(li, 1); store.set('energy', L); toast('Energy cleared'); drawEnergy(); return; }     // tapped the chosen level again: clear it
  L.push({ v, at:nowM(), o:nowM() - wake, w:defaultWin(), d:todayStr() });
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
  const r = schedule().rows.find(x => sameId(x.id, sheetCtx.id)); $('#taskSheet').close();
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
  if (IS_NATIVE && await shareBackupNative('yotei-backup-' + new Date().toISOString().slice(0, 10) + '.json', backupJson())) return;
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
  const _s = grab(), arr = clone(getBlocks(l)), i = arr.findIndex(x => sameId(x.id, id)), j = arr.findIndex(x => sameId(x.id, beforeId)), wk = x => x.w || 'climb1';
  if (i < 0 || j < 0 || wk(arr[i]) !== wk(arr[j])){ toast('Drop it on a task in the same window.'); return; }
  if (arr[i].fixed !== undefined || arr[i].at !== undefined){ toast('This task is ordered by its Start time. Change it in Edit to move it.'); return; }
  needLive(); const [x] = arr.splice(i, 1); arr.splice(arr.findIndex(z => sameId(z.id, beforeId)), 0, x);
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
const RING = ['#f87171', '#fb923c', '#fbbf24', '#facc15', '#a3e635', '#4ade80', '#2dd4bf', '#22d3ee', '#60a5fa', '#818cf8', '#a78bfa', '#e879f9', '#f472b6', '#fb7185', '#94a3b8', '#f8fafc'];
const RECENT0 = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
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
    RING.map(c => '<button type="button" class="cring' + (v === c ? ' on' : '') + '" data-c="' + c + '" style="--c:' + c + ';--ck:' + onColor(c) + '" role="radio" aria-checked="' + (v === c) + '" aria-label="Color ' + c + '"></button>').join('') +
    '<button type="button" class="cring ccustom' + (custom ? ' has on' : '') + '" data-custom="1" style="--c:' + (custom ? v : 'transparent') + '" role="radio" aria-checked="' + !!custom + '" aria-label="Pick a custom color"></button>';
}
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
async function clearHist(){
  if (!await ask('Delete the saved records of all past days, including their done marks and task notes? Your routines are kept.', { ok:'Delete', danger:true })) return;
  const _s = grab(), t = todayStr();
  store.set('hist', {});
  Object.keys(plans).forEach(d => { if (d < t) delete plans[d]; }); store.set('plans', plans);
  const tn = store.get('taskNotes', {}); Object.keys(tn).forEach(k => { if (k.split('_')[0] < t) delete tn[k]; }); store.set('taskNotes', tn);
  lastSig = ''; loadDay(viewDate); render(); showUndo('History deleted', _s);
}
$('#histbox').addEventListener('click', async e => {
  const b = e.target.closest('.hdel'); if (!b) return;
  if (await ask('Delete the saved record for ' + b.dataset.hd + '? This removes its done marks and task notes.', { ok:'Delete', danger:true })) delHist(b.dataset.hd);
});
$('#tab-settings').insertAdjacentHTML('beforeend', '<div class="sleep"><h2>History data</h2><p class="wn">Delete the saved records of past days, with their done marks and task notes. Your routines stay as they are. You can also delete a single day from the History tab.</p><button class="add" id="clrHist">Delete all recorded history</button></div>');
$('#clrHist').addEventListener('click', clearHist);

// ============================================================
// STRUCTURED-STYLE SHELL: header, week dots, add button
// ============================================================
function drawHdr(){
  const t = document.body.dataset.tab || 'home', d = parseDay(viewDate), el = $('#hdrTitle'); if (!el) return;
  if (t === 'home') el.innerHTML = esc(d.toLocaleDateString(undefined, { month:'long' })) + ' <em>' + d.getFullYear() + '</em>';
  else el.textContent = ({ inbox:'Inbox', todo:'To-do', history:'History', settings:'Settings' })[t] || 'Yotei';
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
  $('#fabMenu .fabIn').innerHTML = [['add', ICONS.pen, 'Add a task'], ['inbox', inbox, 'Add to inbox'], ['todo', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/></svg>', 'Add a to-do'], ['late', ICONS.alarm, day.shift ? 'Pushed ' + day.shift.by + ' min later' : 'Running late?'], ['copy', ICONS.calendar, 'Copy this day to another date']]
    .map(a => '<button data-a="' + a[0] + '">' + a[1] + '<span>' + a[2] + '</span></button>').join('');
  $('#fabMenu').showModal();
});
$('#fabMenu').addEventListener('click', e => {
  if (e.target === $('#fabMenu')){ $('#fabMenu').close(); return; }
  const b = e.target.closest('button'); if (!b) return;
  $('#fabMenu').close();
  if (b.dataset.a === 'add'){ openEd('oo', null, defaultWin()); cur.addScope = true; drawEdTypes(); }
  else if (b.dataset.a === 'inbox') openInboxComposer();
  else if (b.dataset.a === 'todo'){ setTab('todo'); openTodoEd(null); }
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
Object.entries({ ed:'Task editor', fabMenu:'Add', iconPick:'Choose an icon', colorSheet:'Pick a color', scopeDlg:'Apply this change to', snapDlg:'Snapshots', mvDlg:'Move or copy', shDlg:'Running late', clrDlg:'Clear all data', setupDlg:'Welcome to Yotei', welDlg:'Welcome to Yotei', qaDlg:'Quick add', tdlDlg:'To-do list', tdeDlg:'To-do', runDlg:'Routine timer', taskSheet:'Task details', blockInfo:'Block information', stepsSheet:'Subtasks', msgDlg:'Message' })
  .forEach(([id, l]) => { const d = document.getElementById(id); if (d) d.setAttribute('aria-label', l); });
$('#tl').insertAdjacentHTML('beforebegin', '<div class="sleep emptyCard" id="emptyCard" hidden><h2>Start with your first task</h2><p class="wn">Add what you want to do today. A task added for all days repeats every day. You can use the + button any time.</p><button class="add" id="emptyAdd">Add a task</button></div>');
function drawEmpty(){
  const el = $('#emptyCard'); if (!el) return;
  el.hidden = schedule().rows.some(r => r.use > 0 && !r.sug);
}
$('#emptyAdd').addEventListener('click', () => { openEd('oo', null, defaultWin()); cur.addScope = true; drawEdTypes(); });
$('#hdrTitle').addEventListener('click', () => { if (document.body.dataset.tab === 'home' && viewDate !== todayStr()) goDate(todayStr()); });
function focusNow(){ if (viewDate !== todayStr()) return; const r = document.querySelector('.tlrow.now'); if (r) r.scrollIntoView({ block:'center' }); }

(function(){
  const list = a => a.map(x => '<li>' + esc(x) + '</li>').join('');
  const sect = (n, a) => a && a.length ? '<h3>' + n + '</h3><ul>' + list(a) + '</ul>' : '';
  $('#tab-settings').insertAdjacentHTML('beforeend',
    '<div class="sleep about"><h2>About Yotei <span class="ver">v' + APP_VERSION + '</span></h2><p>Status: stable. Everything below is working.</p><p class=\"wn\">Icons: Phosphor, and Font Awesome Free (CC BY 4.0, fontawesome.com).</p><p class=\"wn\">Yotei was inspired by <b>Structured</b>. Much of its look and layout (the timeline, week strip, Inbox and add button) comes from that app, with thanks.</p><button class=\"add\" id=\"replayWel\" type=\"button\">Show the welcome tour</button><h3 style="font:700 12px Poppins,sans-serif;color:var(--text)">Features</h3><ul>' + list(FEATURES) + '</ul><h3 style="font:700 12px Poppins,sans-serif;color:var(--text)">Good to know</h3><ul>' + list(LIMITS) + '</ul></div>' +
    '<div class="sleep about"><h2>Changelog</h2>' + (() => {
      const MON = { Jan:'January', Feb:'February', Mar:'March', Apr:'April', May:'May', Jun:'June', Jul:'July', Aug:'August', Sep:'September', Oct:'October', Nov:'November', Dec:'December' };
      const label = d => { const z = /^([A-Za-z]{3})[a-z]* (\d{4})$/.exec(d || ''); return z && MON[z[1]] ? MON[z[1]] + ' ' + z[2] : (d === 'Initial' ? 'First release' : d || 'Earlier'); };
      const groups = [];
      CHANGELOG.forEach(c => { const l = label(c.date), g = groups[groups.length - 1]; if (g && g.l === l) g.items.push(c); else groups.push({ l, items:[c] }); });
      return groups.map((g, gi) => '<details class="clMonth"' + (gi === 0 ? ' open' : '') + '><summary>' + esc(g.l) + '<span>' + g.items.length + (g.items.length === 1 ? ' version' : ' versions') + '</span></summary>' +
        g.items.map((c, i) => '<details class="clog"' + (gi === 0 && i === 0 ? ' open' : '') + '><summary>v' + esc(c.v) + '</summary>' + sect('Added', c.added) + sect('Changed', c.changed) + sect('Fixed', c.fixed) + '</details>').join('') + '</details>').join('');
    })() + '</div>');
})();
const tabs = document.querySelectorAll('.tabs button');
// ---- Android back button (only wired up inside the Android app) ----
const BACK_ORDER = ['msgDlg', 'tdlDlg', 'tdeDlg', 'qaDlg', 'welDlg', 'scopeDlg', 'iconPick', 'colorSheet', 'mvDlg', 'snapDlg', 'shDlg', 'clrDlg', 'stepsSheet', 'runDlg', 'blockInfo', 'taskSheet', 'ed', 'fabMenu'];
function handleBack(){
  for (const id of BACK_ORDER){
    const d = document.getElementById(id);
    if (!d || !d.open) continue;
    const x = id === 'fabMenu' ? null : d.querySelector('#tdl_x,#tde_x,#qa_x,#wl_skip,#sc_x,#ip_x,#mv_x,#snap_x,#sh_x,#clr_x,#runClose,#ss_close,#e_x');
    if (x) x.click(); else d.close();
    return true;
  }
  if (document.body.dataset.tab === 'settings' && document.body.dataset.setpage){ setPageOpen(null); return true; }   // inside a settings page: back to the menu
  if (document.body.dataset.tab !== 'home'){ setTab('home'); return true; }
  return false;
}
{ const app = nativePlugin('App'); if (app) app.addListener('backButton', () => { if (!handleBack()) app.exitApp(); }); }
function setTab(t){
  if (toastUntil && Date.now() - toastShownAt > 500) hideToast();   // a message from the previous screen shouldn't follow you around
  tabs.forEach(b => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); b.setAttribute('aria-controls', 'tab-' + b.dataset.tab); });
  document.querySelectorAll('.tab').forEach(sec => { sec.hidden = sec.id !== 'tab-' + t; sec.setAttribute('role', 'tabpanel'); });
  store.set('tab', t); document.body.dataset.tab = t; drawHdr();
  if (t === 'settings') setPageOpen(null);      // tapping Settings always shows the menu
  if (t === 'todo') drawTodo();                 // due labels follow the clock
}
tabs.forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
setTab('home');          // always start on the Timeline
const FRESH = ['hist', 'plans', 'blocks', 'day', 'wake', 'setup'].every(k => store.get(k, null) === null);
migrateFields();
migrateV2();
migrateV3();
// Older versions could leave tasks with no id, a number for an id, or two tasks in a list with the same id.
{ const b = store.get('blocks', null); if (b){ const r = normalizeIds(b); if (r.changed) store.set('blocks', r.blocks); } }
render();
// a dialog opens above everything, so the Welcome dialog waits until the loading screen has gone
if (FRESH){ if (document.getElementById('boot')) window.__afterBoot = () => openWelcome(true); else openWelcome(true); }
setTimeout(focusNow, 150);
(function(){
  const a = new URLSearchParams(location.search).get('action'); if (!a) return;
  try{ history.replaceState(null, '', location.pathname); }catch{}
  setTab('home'); goDate(todayStr());
  if (a === 'morning') runStart('sleep'); else if (a === 'inbox') openInboxComposer();
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
if (IS_NATIVE) $('#bkWhy').textContent = 'Your tasks, blocks and history live on this device only. Export a copy so uninstalling the app or clearing its data does not erase them.';
updateBackupInfo();
if ($('#settingsBtn').classList.contains('nudge') && store.get('bkAsk', '') !== todayStr()){ store.set('bkAsk', todayStr()); setTimeout(() => toast('Time for a backup. Your data lives only on this device.', 'Back up', shareBackup), 1500); }
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && !IS_NATIVE){
  // The page may already have finished loading by the time this script runs (startup waits for saved data).
  const registerSw = () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); };
  if (document.readyState === 'complete') registerSw(); else window.addEventListener('load', registerSw);
}
// ---- Settings > Schedule > Tasks with dates: a task past its end date leaves the timeline, so this is where it can still be found ----
const listLabel = l => (TPL[l] && TPL[l].label) || (MODE_LABEL[l] ? MODE_LABEL[l] + ' day' : l);
function dateText(ds){ const d = parseDay(ds), y = d.getFullYear() !== new Date().getFullYear(); return d.toLocaleDateString(undefined, y ? { month:'short', day:'numeric', year:'numeric' } : { month:'short', day:'numeric' }); }
function datedTasks(){
  const out = [];
  TASK_LISTS.forEach(l => getBlocks(l).forEach(b => { if (b.from || b.to) out.push({ l, b }); }));
  return out;
}
function drawDated(){
  const el = $('#datedList'); if (!el) return;
  const t = todayStr(), list = datedTasks();
  el.innerHTML = list.length ? list.map(({ l, b }) => {
    const range = b.from && b.to ? dateText(b.from) + ' to ' + dateText(b.to) : b.from ? 'From ' + dateText(b.from) : 'Until ' + dateText(b.to);
    const st = b.to && b.to < t ? 'Ended' : b.from && b.from > t ? 'Not started' : 'Active';
    return '<div class="dtRow"><div class="dtTxt"><b>' + esc(b.t || 'Task') + '</b><small>' + esc(listLabel(l)) + ' &middot; ' + range + ' &middot; ' + st + '</small></div><div class="dtAct"><button data-dedit="' + esc(String(b.id)) + '" data-dl="' + l + '">Edit</button><button data-drm="' + esc(String(b.id)) + '" data-dl="' + l + '" aria-label="Remove ' + esc(b.t || 'task') + '">&times;</button></div></div>';
  }).join('') : '<p class="wn">No tasks with dates yet. When you add or change a task, choose "Or choose dates" to give it a start and an end.</p>';
}
$('#datedList').addEventListener('click', async e => {
  const ed = e.target.closest('[data-dedit]'), rm = e.target.closest('[data-drm]');
  if (ed){ openEd(ed.dataset.dl, ed.dataset.dedit); return; }
  if (rm){
    if (!await ask('Remove this task from every day?', { ok:'Remove', danger:true })) return;
    const l = rm.dataset.dl, id = rm.dataset.drm, lk = (getBlocks(l).find(x => sameId(x.id, id)) || {}).lk;
    setBlocks(l, clone(getBlocks(l)).filter(x => !sameId(x.id, id)));
    if (lk) TASK_LISTS.forEach(L => { if (L !== l) setBlocks(L, clone(getBlocks(L)).filter(x => x.lk !== lk)); });
    render(); drawDated(); toast('Task removed');
  }
});
// ============================================================
// SETTINGS MENU: grouped rows that each open their own page. The cards themselves are moved, not rebuilt, so every control keeps working.
// ============================================================
const SI = {
  bell:'<path d="M6 17h12l-1.5-2v-4a4.5 4.5 0 0 0-9 0v4L6 17zM10 20a2 2 0 0 0 4 0"/>',
  palette:'<path d="M12 4a8 8 0 1 0 0 16c1.2 0 1.8-.8 1.5-1.8-.3-1 .3-2.2 1.5-2.2h1.5a3 3 0 0 0 3-3A8 8 0 0 0 12 4z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16" cy="11" r="1"/>',
  sliders:'<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  pencil:'<path d="M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3"/>',
  save:'<path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19h14"/>',
  cal:'<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  reset:'<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>',
  flask:'<path d="M9 4h6M10 4v6l-5 9a1 1 0 0 0 1 1.5h12a1 1 0 0 0 1-1.5l-5-9V4"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  chev:'<path d="M9 6l6 6-6 6"/>', back:'<path d="M15 6l-6 6 6 6"/>'
};
const sIcon = (k, extra = '') => '<svg viewBox="0 0 24 24" aria-hidden="true"' + extra + '>' + SI[k] + '</svg>';
const SET_MENU = [
  { label:'General', rows:[
    { id:'rem',   t:'Reminders',  ic:'bell',    col:'#5fae6b', cards:['Reminders'] },
    { id:'look',  t:'Appearance', ic:'palette', col:'#8fb85a', cards:['Appearance'] },
    { id:'sched', t:'Schedule',   ic:'sliders', col:'#5b8bb8', cards:['Sleep caps', 'Energy rhythm', 'Usual days', 'Routine templates', 'Tasks with dates'] },
    { id:'edit',  t:'Editing',    ic:'pencil',  col:'#e0a03a', cards:['Editing'] }] },
  { label:'Data', rows:[
    { id:'bk',    t:'Backup',          ic:'save',  col:'#e0787f', cards:['Backup'] },
    { id:'cal',   t:'Calendar import', ic:'cal',   col:'#5fae6b', cards:['Calendar import'] },
    { id:'hist',  t:'History data',    ic:'clock', col:'#5b8bb8', cards:['History data'] },
    { id:'reset', t:'Reset',           ic:'reset', col:'#d9606a', cards:['Reset'] }] },
  { label:'About', rows:[
    { id:'sci',   t:'Science sources', ic:'flask', col:'#8478d0', cards:['Science sources'] },
    { id:'about', t:'About Yotei',     ic:'info',  col:'#5b8bb8', cards:['About Yotei', 'Changelog'] }] }
];
function settingsValue(id){
  if (id === 'rem'){ const R = store.get('rem', { on:false }); return R.on && (IS_NATIVE ? remNative.perm === 'granted' : ('Notification' in window && Notification.permission === 'granted')) ? 'On' : 'Off'; }
  if (id === 'look'){ const s = $('#thSel'); return s ? s.selectedOptions[0].textContent : ''; }
  if (id === 'edit') return editing ? 'On' : 'Off';
  if (id === 'bk'){ const t = store.get('lastBackup', 0); return t ? (Date.now() - t < 864e5 ? 'Today' : new Date(t).toLocaleDateString(undefined, { month:'short', day:'numeric' })) : 'Never'; }
  if (id === 'about') return 'v' + APP_VERSION;
  return '';
}
function updateSettingsValues(){ document.querySelectorAll('#setMenu .setRow').forEach(r => { r.querySelector('.setV').textContent = settingsValue(r.dataset.page); }); }
function setPageOpen(id){
  const menu = $('#setMenu'); if (!menu) return;
  document.querySelectorAll('#tab-settings .setPage').forEach(p => { p.hidden = p.dataset.page !== id; });
  menu.hidden = !!id; document.body.dataset.setpage = id || '';
  updateSettingsValues(); if (id === 'sched') drawDated(); window.scrollTo(0, 0);
}
function buildSettings(){
  const tab = $('#tab-settings'), all = [...tab.children].filter(c => c.classList.contains('sleep'));
  const find = name => all.find(c => { const h = c.querySelector('h2'); return h && h.textContent.trim().startsWith(name); });
  const menu = document.createElement('div'); menu.id = 'setMenu';
  const pages = [];
  SET_MENU.forEach(g => {
    menu.insertAdjacentHTML('beforeend', '<p class="setLbl">' + g.label + '</p>');
    const box = document.createElement('div'); box.className = 'setGroup';
    g.rows.forEach(r => {
      box.insertAdjacentHTML('beforeend', '<button type="button" class="setRow" data-page="' + r.id + '"><span class="setIc" style="background:' + r.col + '">' + sIcon(r.ic) + '</span><span class="setT">' + r.t + '</span><span class="setV"></span>' + sIcon('chev', ' class="setChev"') + '</button>');
      const cards = r.cards.map(find).filter(Boolean);
      const pg = document.createElement('div'); pg.className = 'setPage'; pg.dataset.page = r.id; pg.dataset.n = cards.length; pg.hidden = true;
      pg.insertAdjacentHTML('beforeend', '<div class="setHead"><button type="button" class="setBack" aria-label="Back to Settings">' + sIcon('back') + '</button><h2>' + r.t + '</h2></div>');
      cards.forEach(c => pg.appendChild(c)); pages.push(pg);
    });
    menu.appendChild(box);
  });
  tab.appendChild(menu); menu.insertAdjacentHTML('beforeend', '<p class="setCredit">Inspired by Structured</p>'); pages.forEach(p => tab.appendChild(p));
  all.filter(c => c.parentElement === tab).forEach(c => { c.hidden = true; });   // anything not placed above stays out of the way
  tab.addEventListener('click', e => {
    const r = e.target.closest('.setRow'); if (r){ setPageOpen(r.dataset.page); return; }
    if (e.target.closest('.setBack')){ setPageOpen(null); return; }
    setTimeout(updateSettingsValues, 80);
  });
  tab.addEventListener('change', () => setTimeout(updateSettingsValues, 80));
  setPageOpen(null);
}
buildSettings();

// Loading screen: leave once everything is drawn. In the Android app it stays for at least 6 seconds so the dots are seen.
window.__bootMin = IS_NATIVE ? 6000 : 0; if (window.__bootOff) window.__bootOff();
