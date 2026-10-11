// ============================================================
// DATES: a "day" is identified by an ISO string like "2026-10-11" (local calendar date).
// ISO strings sort in date order, so they can be compared with < and > directly.
// ============================================================
export const isoLocal = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// "2026-10-11" -> a Date at local midnight that day.
export function parseDay(iso){
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const dowOf = iso => parseDay(iso).getDay();
export const cmpDay = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const isIso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// v2 used Date.toDateString() ("Sun Oct 11 2026") as the day key. Convert that to ISO.
// Returns the ISO string, the input unchanged if it already is ISO, or null if it is neither.
const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
export function legacyToIso(s){
  if (isIso(s)) return s;
  const m = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{4})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const y = +m[3], mo = MONTHS[m[1]], d = +m[2], dt = new Date(y, mo, d);
  return dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d ? isoLocal(dt) : null;
}
