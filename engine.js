// ============================================================
// SCHEDULING ENGINE: turns blocks + wake time into timed rows.
// Pure functions: everything they read is passed in, so they can be tested without a browser.
// ============================================================
import { isoLocal } from './dates.js';
export { isoLocal };

export function typeOfIn(types, k, WIN){
  const keys = Object.keys(WIN);
  for (let i = keys.indexOf(k); i >= 0; i--) if (types[keys[i]]) return types[keys[i]];
  return null;
}

export function applyOvr(b, OV, iso, dow, dm){
  const L = OV[b.id]; if (!L) return b;
  let x = b, ch = false;
  for (const e of L){
    if ((e.from && iso < e.from) || (e.to && iso > e.to) || (e.days && !e.days.includes(dow)) || (e.modes && !(dm && e.modes.includes(dm)))) continue;
    if (e.patch === null) return null;
    x = { ...x, ...e.patch }; ch = true;
  }
  if (ch) Object.keys(x).forEach(k => { if (x[k] === null) delete x[k]; });
  return x;
}

// ctx: { dow, wake, day, CAP, MODES, WIN, OV, getBlocks(list), wins(), fmt(minutes) }
export function buildSchedule(ctx){
  const { dow, wake, day, CAP, MODES, WIN, OV, getBlocks, wins, fmt } = ctx;
  const typeOf = k => typeOfIn(day.types, k, WIN);
  const m1 = typeOf('climb1'), M = MODES[m1 || 'none'], iso = day.date, dm = m1 || Object.values(day.types || {})[0] || null;
  const eff = b => applyOvr(b, OV, iso, dow, dm), onDay = b => (!b.days || b.days.includes(dow)) && (!b.from || iso >= b.from) && (!b.modes || (dm && b.modes.includes(dm)));
  const ooF = k => (day.oneoffs || []).filter(x => (x.w || 'climb1') === k).map(x => ({ ...x, md:'oo', post:true }));
  const fixSort = arr => { const ix = [], fx = []; arr.forEach((b, i) => { if ((b.fixed !== undefined || b.at !== undefined) && !b.sug){ ix.push(i); fx.push(b); } }); fx.sort((a, b) => (a.fixed !== undefined ? a.fixed : a.at) - (b.fixed !== undefined ? b.fixed : b.at)); const out = arr.slice(); ix.forEach((i, j) => { out[i] = fx[j]; }); return out; };
  const pre = fixSort(getBlocks('pre').map(eff).filter(Boolean).filter(onDay).concat(ooF('sleep'))).map(b => ({ ...b, use:b.d }));
  let msg = M.msg || '', tone = 'ok';
  if (M.deadline !== null){
    const avail = M.deadline - wake, total = pre.reduce((a, b) => a + b.d, 0), leave = fmt(M.deadline).join(' ');
    if (avail >= total){
      const gap = avail - total;
      if (gap > 0){
        pre.push({ id:'buf', t:'Buffer time', details:'Extra time from an early start.', d:gap, use:gap, p:'buf' });
        msg = 'Early start: ' + gap + ' min of buffer added before you leave at ' + leave + '.';
      } else msg = 'Fits exactly. You leave at ' + leave + '.';
    } else {
      let need = total - avail;
      for (const pri of ['opt','flex','core']) for (const b of pre){
        if (b.p !== pri || need <= 0) continue;
        const cut = Math.min(need, b.use - (b.m || 0));
        b.use -= cut; need -= cut;
      }
      if (need > 0){ tone = 'bad'; msg = 'Even at minimum lengths you are ' + need + ' min over. Wake earlier or trim the routine.'; }
      else { tone = 'warn'; msg = 'Late start: routine shortened by ' + (total - avail) + ' min so you can leave at ' + leave + '.'; }
    }
  }
  let t = wake; const rows = [];
  let shd = false; const sh = day.shift, bump = () => { if (sh && !shd && t >= sh.from){ t += sh.by; shd = true; } };
  for (const b of pre){
    bump();
    const bf = b.p === 'buf';
    const at0 = (!bf && !b.sug && b.fixed !== undefined) ? b.fixed : (!bf && !b.sug && b.at !== undefined && b.at > t) ? b.at : t;
    rows.push({ ...b, w:bf ? 'climb1' : 'sleep', md:bf ? m1 : b.md, start:at0, end:at0 + b.use }); t = Math.max(t, at0 + b.use);
  }
  if (M.deadline !== null) t = Math.max(t, M.deadline);
  for (const k of Object.keys(WIN)){
    const night = k === 'wind', tp = night ? 'night' : typeOf(k), oo = ooF(k);
    if (k === 'sleep' || (!tp && !oo.length)) continue;
    let list = fixSort((tp ? getBlocks(tp).map(eff).filter(Boolean).filter(x => (night || (x.w || 'climb1') === k) && onDay(x)) : []).concat(oo));
    if (night){
      t = Math.max(t, wake + wins().wind.from);
      list = list.map(b => ({ ...b, use:b.d }));
      let need = list.filter(b => !b.sug).reduce((a, b) => a + b.use, 0) - (CAP.hard - t);
      for (const pri of ['opt', 'flex', 'core']) for (const b of list){
        if (b.p !== pri || need <= 0 || b.sug) continue;
        const cut = Math.min(need, b.use - (b.m || 0));
        b.use -= cut; need -= cut;
      }
    }
    for (const b of list){
      bump();
      const at = b.fixed !== undefined ? b.fixed : (!b.sug && b.at !== undefined && b.at > t) ? b.at : t;
      if (b.fixed !== undefined && !b.sug && t > b.fixed){ tone = 'bad'; msg = 'The tasks before "' + b.t + '" run past its ' + fmt(b.fixed).join(' ') + ' start. Trim them, move it later, or wake earlier.'; }
      let use = b.use !== undefined ? b.use : b.d, capCut = false;
      if (b.fixed === undefined && !b.sug && b.md !== 'oo' && ((at >= CAP.hard && b.p !== 'core') || (at >= CAP.soft && b.p === 'opt'))){ use = 0; capCut = true; }
      rows.push({ ...b, w:k, use, capCut, start:at, end:at + use, post:true, md:b.md === 'oo' ? 'oo' : tp });
      t = Math.max(t, at + use);
    }
  }
  return { rows, msg, tone };
}
