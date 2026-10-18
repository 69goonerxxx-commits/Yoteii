// Backup validation: decides whether an imported file is safe to load, without touching storage.
export const BACKUP_VERSION = 3;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const num = v => typeof v === 'number' && Number.isFinite(v);
// A missing or empty (null) value is fine; a value of the wrong type is not.
const optNum = (o, k) => o[k] === undefined || o[k] === null || num(o[k]);
const optIn = (o, k, lo, hi) => o[k] === undefined || o[k] === null || (num(o[k]) && o[k] >= lo && o[k] <= hi);   // a number, and a sensible one
const optStr = (o, k) => o[k] === undefined || o[k] === null || typeof o[k] === 'string';
const arrOfObj = a => Array.isArray(a) && a.every(isObj);

// One checker per known storage key. Each returns true when the parsed value has a safe shape.
const CHECKS = {
  blocks: v => isObj(v) && Object.values(v).every(a => arrOfObj(a) && a.every(b => optStr(b, 't') && optStr(b, 'id') && optStr(b, 'from') && optStr(b, 'to') && optIn(b, 'd', 0, 1440) && optIn(b, 'm', 0, 1440) && optIn(b, 'fixed', 0, 2880) && optIn(b, 'at', 0, 2880) && (b.days === undefined || Array.isArray(b.days)))),
  plans: v => isObj(v) && Object.values(v).every(p => isObj(p) && optIn(p, 'w', 0, 1440) && (p.t === undefined || isObj(p.t)) && (p.o === undefined || arrOfObj(p.o)) && optStr(p, 'n')),
  hist: v => isObj(v) && Object.values(v).every(h => isObj(h) && (h.rows === undefined || (arrOfObj(h.rows) && h.rows.every(r => optStr(r, 't') && optNum(r, 's') && optNum(r, 'e') && optNum(r, 'u')))) && (h.note === undefined || typeof h.note === 'string')),
  ovr: v => isObj(v) && Object.values(v).every(arrOfObj),
  inbox: v => arrOfObj(v) && v.every(i => optStr(i, 't')),
  taskNotes: isObj, wins: isObj, wovr: isObj,
  usual: v => isObj(v) && Object.values(v).every(m => typeof m === 'string'),
  caps: v => isObj(v) && optIn(v, 'soft', 0, 2880) && optIn(v, 'hard', 0, 2880),
  clock: v => v === '12' || v === '24',
  wake: v => num(v) || isObj(v),               // older versions stored { home: minutes }
  schemaV: num, lastBackup: num,
  bkAsk: v => typeof v === 'string',           // the day the backup reminder was last shown
  setup: v => typeof v === 'boolean',
  dateFmt: v => v === 'iso',
};

// Returns { ok: true } or { ok: false, why: 'short reason a person can read' }.
export function validateBackup(j, P = 'yotei_v2_') {
  if (!isObj(j) || j.app !== 'yotei') return { ok: false, why: 'it was not made by Yotei' };
  if (j.v !== undefined && (!num(j.v) || j.v > BACKUP_VERSION)) return { ok: false, why: 'it was made by a newer version of Yotei' };
  if (!isObj(j.data) || !Object.keys(j.data).length) return { ok: false, why: 'it contains no data' };
  for (const [k, v] of Object.entries(j.data)) {
    if (!k.startsWith(P) || typeof v !== 'string') return { ok: false, why: 'it contains unexpected entries' };
    let p;
    try { p = JSON.parse(v); } catch { return { ok: false, why: 'the "' + k.slice(P.length) + '" data is damaged' }; }
    const chk = CHECKS[k.slice(P.length)];
    if (chk && !chk(p)) return { ok: false, why: 'the "' + k.slice(P.length) + '" data looks damaged' };
  }
  return { ok: true };
}
