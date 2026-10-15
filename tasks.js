// ============================================================
// TASK LOOKUP AND REMOVAL: pure helpers that never assume the saved data is tidy.
// Older versions could leave tasks with no id, a number as the id, or two tasks in one list sharing an id.
// ============================================================
export const TASK_LISTS = ['pre', 'night', 'home', 'school', 'away'];

// Ids compare as text, so 101 and "101" are the same task.
export const sameId = (a, b) => a !== undefined && a !== null && a !== '' && b !== undefined && b !== null && b !== '' && String(a) === String(b);

// Does saved task x match the task c that was tapped? By id when both have one, otherwise by title and window.
export function matchTask(x, c){
  if (!x || typeof x !== 'object') return false;
  const hasX = x.id !== undefined && x.id !== null && x.id !== '', hasC = c.id !== undefined && c.id !== null && c.id !== '' && c.id !== 'undefined';
  if (hasX && hasC) return sameId(x.id, c.id);
  return c.t !== undefined && x.t === c.t && (x.w || '') === (c.w || '');
}

// Give every task in a blocks object its own text id. Returns { blocks, changed }; the input is not modified.
export function normalizeIds(blocks, makeId){
  const out = {}; let changed = false, n = 0;
  const mk = makeId || (() => 'r' + Date.now().toString(36) + (n++).toString(36) + Math.random().toString(36).slice(2, 5));
  for (const l of Object.keys(blocks || {})){
    const arr = blocks[l];
    if (!Array.isArray(arr)){ out[l] = arr; continue; }
    const seen = new Set();
    out[l] = arr.map(x => {
      if (!x || typeof x !== 'object') return x;
      let id = typeof x.id === 'number' ? String(x.id) : x.id;
      if (typeof id !== 'string' || !id || seen.has(id)) id = mk();
      seen.add(id);
      if (id === x.id) return x;
      changed = true; return { ...x, id };
    });
  }
  return { blocks: out, changed };
}

// Remove the tapped task from the routines. Looks in its own list first, then in the others, in case it was filed
// somewhere else. Returns { blocks, list } where list is the list it was removed from (or null if it was not found).
export function removeTask(blocks, c, lists = TASK_LISTS){
  const order = [c.l, ...lists.filter(l => l !== c.l)].filter(l => lists.includes(l));
  for (const l of order){
    const arr = blocks[l];
    if (!Array.isArray(arr)) continue;
    const keep = arr.filter(x => !matchTask(x, c));
    if (keep.length !== arr.length) return { blocks: { ...blocks, [l]: keep }, list: l };
  }
  return { blocks, list: null };
}

// Remove a task from the saved record of a past day. Returns the new record (unchanged if nothing matched).
export function removeFromRecord(rec, c){
  if (!rec || !Array.isArray(rec.rows)) return rec;
  const rows = rec.rows.filter(r => !(matchTask(r, c)));
  return rows.length === rec.rows.length ? rec : { ...rec, rows };
}
