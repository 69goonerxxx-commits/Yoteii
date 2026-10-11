// ============================================================
// DATA MIGRATIONS that work on a whole backup/dump: a map of key -> JSON text.
// Pure functions (no storage access), so they can be tested and reused for imports and snapshots.
// ============================================================
import { legacyToIso } from './dates.js';

export const DATE_FMT = 'iso';
export const needsDateMigration = data => data.dateFmt !== JSON.stringify(DATE_FMT);

// v2 -> v3: day keys change from "Sun Oct 11 2026" to "2026-10-11". Safe to run twice; anything it
// does not recognise is left exactly as it was.
export function migrateDates(data){
  const out = { ...data };
  const read = k => { try{ return data[k] === undefined ? undefined : JSON.parse(data[k]); }catch{ return undefined; } };
  const put = (k, v) => { out[k] = JSON.stringify(v); };
  const iso = s => (typeof s === 'string' ? (legacyToIso(s) ?? s) : s);
  const isMap = v => v && typeof v === 'object' && !Array.isArray(v);

  for (const k of ['plans', 'hist']){                       // objects keyed by day
    const o = read(k); if (!isMap(o)) continue;
    const n = {}; Object.keys(o).forEach(d => { n[iso(d)] = o[d]; }); put(k, n);
  }
  const tn = read('taskNotes');                              // keys look like "<day>_<task id>"
  if (isMap(tn)){
    const n = {};
    Object.keys(tn).forEach(k => { const i = k.indexOf('_'); n[i > 0 ? iso(k.slice(0, i)) + k.slice(i) : k] = tn[k]; });
    put('taskNotes', n);
  }
  for (const k of ['day', 'done']){ const o = read(k); if (isMap(o) && 'date' in o){ o.date = iso(o.date); put(k, o); } }
  const rs = read('remSent'); if (isMap(rs) && 'd' in rs){ rs.d = iso(rs.d); put('remSent', rs); }
  const en = read('energy'); if (Array.isArray(en)){ en.forEach(e => { if (e && typeof e === 'object' && 'd' in e) e.d = iso(e.d); }); put('energy', en); }
  const bk = read('bkAsk'); if (typeof bk === 'string') put('bkAsk', iso(bk));

  out.dateFmt = JSON.stringify(DATE_FMT);
  return out;
}
