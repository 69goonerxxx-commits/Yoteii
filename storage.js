// ============================================================
// STORAGE: everything Yotei saves.
//
// Reads are synchronous (from an in-memory copy loaded at startup), so the rest of the app
// can keep calling store.get / store.set. Writes go to IndexedDB in small batches, and are
// flushed whenever the page is hidden or closed. If IndexedDB is unavailable, the app falls
// back to localStorage exactly as v2 did.
//
// Existing v2 data is copied from localStorage into IndexedDB on first launch. The old copy
// is left in place and never read again.
// ============================================================
import { migrateDates, needsDateMigration } from './migrate.js';

const LEGACY = 'yotei_v2_';                 // v2 localStorage key prefix
const MIRROR = new Set(['theme', 'text']);  // index.html reads these before the app starts, so they also stay in localStorage
const DB_NAME = 'yotei', KV = 'kv', SNAP = 'snap';
const META = '__migrated';                  // marks that the localStorage copy has been imported
const SNAP_KEEP = 7;

const cache = new Map();                    // key -> JSON string, same shape localStorage used
const pending = new Set();                  // keys changed but not yet written to IndexedDB
let db = null, backend = 'ls', timer = 0, inflight = Promise.resolve(), onError = () => {}, channel = null;

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const finish = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted')); });
// Run writes in one transaction. If anything throws part-way, cancel the whole thing so nothing is half-saved.
function run(stores, fn){
  const tx = db.transaction(stores, 'readwrite'), done = finish(tx);
  try{ fn(tx); }catch(e){ try{ tx.abort(); }catch{} done.catch(() => {}); throw e; }
  return done;
}
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const isData = k => !k.startsWith('__');

function openDb(){
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
    let r; try{ r = indexedDB.open(DB_NAME, 1); }catch(e){ return rej(e); }
    r.onupgradeneeded = () => { r.result.createObjectStore(KV); r.result.createObjectStore(SNAP, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });
}

function legacyEntries(){
  const o = {};
  try{
    for (let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY)) o[k.slice(LEGACY.length)] = localStorage.getItem(k);
    }
  }catch{}
  return o;
}

function mirror(k, s){
  if (!MIRROR.has(k) && backend !== 'ls') return true;
  try{ if (s === null) localStorage.removeItem(LEGACY + k); else localStorage.setItem(LEGACY + k, s); return true; }
  catch{ return false; }
}

function tell(msg){ try{ if (channel) channel.postMessage(msg); }catch{} }

// ---- startup -------------------------------------------------------------
export async function initStore(){
  try{
    db = await timeout(openDb(), 3000);
    db.onversionchange = () => { try{ db.close(); }catch{} };
    const s = db.transaction(KV, 'readonly').objectStore(KV);
    const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
    keys.forEach((k, i) => cache.set(k, vals[i]));
    if (!cache.has(META)){
      const old = legacyEntries(), stamp = String(Date.now());
      await run(KV, tx => { const w = tx.objectStore(KV); Object.entries(old).forEach(([k, v]) => w.put(v, k)); w.put(stamp, META); });
      Object.entries(old).forEach(([k, v]) => cache.set(k, v));
      cache.set(META, stamp);
    }
    backend = 'idb';
  }catch{
    db = null; backend = 'ls'; cache.clear();
    Object.entries(legacyEntries()).forEach(([k, v]) => cache.set(k, v));
  }
  try{
    channel = new BroadcastChannel('yotei-store');
    channel.onmessage = e => {
      const m = e.data || {};
      if (m.reset){ location.reload(); return; }
      if (typeof m.k !== 'string') return;
      if (m.v === null) cache.delete(m.k); else cache.set(m.k, m.v);
    };
  }catch{}
  const out = () => { flush(); };
  addEventListener('pagehide', out);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') out(); });
}

export const info = () => ({ backend });
export const onStoreError = fn => { onError = fn; };

// ---- reading and writing ---------------------------------------------------
function queue(k){
  if (backend !== 'idb') return;
  pending.add(k);
  if (!timer) timer = setTimeout(flush, 20);
}

export function flush(){
  clearTimeout(timer); timer = 0;
  if (!db || !pending.size) return inflight;
  const batch = [...pending].map(k => [k, cache.has(k) ? cache.get(k) : null]);
  pending.clear();
  inflight = inflight.then(() => run(KV, tx => {
    const w = tx.objectStore(KV);
    batch.forEach(([k, v]) => { if (v === null) w.delete(k); else w.put(v, k); });
  })).catch(e => { batch.forEach(([k]) => pending.add(k)); onError(e); });
  return inflight;
}

export const store = {
  get(k, d){ const v = cache.get(k); if (v === undefined) return d; try{ return JSON.parse(v); }catch{ return d; } },
  set(k, v){
    let s; try{ s = JSON.stringify(v); }catch{ onError(); return false; }
    if (s === undefined) return store.remove(k);
    cache.set(k, s); tell({ k, v: s }); queue(k);
    if (!mirror(k, s) && backend === 'ls'){ onError(); return false; }
    return true;
  },
  remove(k){ cache.delete(k); tell({ k, v: null }); queue(k); mirror(k, null); return true; },
  raw(k){ return cache.has(k) ? cache.get(k) : null; },            // the stored JSON text, for undo
  setRaw(k, s){ if (s === null) store.remove(k); else { cache.set(k, s); tell({ k, v: s }); queue(k); mirror(k, s); } },
  keys(){ return [...cache.keys()].filter(isData); },
  dump(){ const o = {}; store.keys().forEach(k => { o[k] = cache.get(k); }); return o; },  // key -> JSON text
};

export function estimateBytes(){
  let n = 0; cache.forEach((v, k) => { if (isData(k)) n += (k.length + v.length) * 2; });
  return n;
}

// Replace everything with the given key -> JSON text map (import, restore). Throws if saving fails.
export async function replaceAll(data){
  await flush();
  if (db){
    await run(KV, tx => {
      const w = tx.objectStore(KV);
      w.clear(); w.put(cache.get(META) || String(Date.now()), META);
      Object.entries(data).forEach(([k, v]) => w.put(v, k));
    });
  }
  const meta = cache.get(META);
  cache.clear(); if (meta !== undefined) cache.set(META, meta);
  Object.entries(data).forEach(([k, v]) => cache.set(k, v));
  if (backend === 'ls'){
    Object.keys(legacyEntries()).forEach(k => localStorage.removeItem(LEGACY + k));
    Object.entries(data).forEach(([k, v]) => localStorage.setItem(LEGACY + k, v));
  }else{
    MIRROR.forEach(k => { try{ if (k in data) localStorage.setItem(LEGACY + k, data[k]); else localStorage.removeItem(LEGACY + k); }catch{} });
  }
  tell({ reset: true });
}

// Delete everything Yotei has saved, including snapshots and the old localStorage copy.
export async function clearAll(){
  await flush();
  if (db){
    await run([KV, SNAP], tx => {
      tx.objectStore(KV).clear(); tx.objectStore(KV).put(cache.get(META) || String(Date.now()), META);
      tx.objectStore(SNAP).clear();
    });
  }
  const meta = cache.get(META); cache.clear(); if (meta !== undefined) cache.set(META, meta);
  Object.keys(legacyEntries()).forEach(k => { try{ localStorage.removeItem(LEGACY + k); }catch{} });
  tell({ reset: true });
}

// ---- automatic snapshots (kept on this device, last 7) ----------------------
export async function makeSnapshot(reason){
  if (!db || !hasUserData()) return null;      // nothing worth protecting yet
  await flush();
  const at = Date.now(), rec = { id: String(at) + '-' + Math.random().toString(36).slice(2, 6), at, reason, data: store.dump() };
  await run(SNAP, tx => { tx.objectStore(SNAP).put(rec); });
  const ids = (await req(db.transaction(SNAP, 'readonly').objectStore(SNAP).getAllKeys())).sort();
  const extra = ids.slice(0, Math.max(0, ids.length - SNAP_KEEP));
  if (extra.length) await run(SNAP, tx => { extra.forEach(id => tx.objectStore(SNAP).delete(id)); });
  return rec.id;
}

const hasUserData = () => ['blocks', 'plans', 'hist', 'inbox'].some(k => cache.has(k));
const dayOf = t => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

// Once per day, on the first launch: save what the previous day left behind, before any edits.
export async function snapshotIfDue(){
  if (!db) return null;
  const list = await listSnapshots();
  if (list.some(s => dayOf(s.at) === dayOf(Date.now()))) return null;
  return makeSnapshot('daily');
}

export async function listSnapshots(){
  if (!db) return [];
  const all = await req(db.transaction(SNAP, 'readonly').objectStore(SNAP).getAll());
  return all.map(s => ({ id: s.id, at: s.at, reason: s.reason, keys: Object.keys(s.data).length })).sort((a, b) => b.at - a.at);
}

export async function restoreSnapshot(id){
  if (!db) throw new Error('snapshots unavailable');
  const rec = await req(db.transaction(SNAP, 'readonly').objectStore(SNAP).get(id));
  if (!rec) throw new Error('snapshot not found');
  await makeSnapshot('before-restore');
  await replaceAll(needsDateMigration(rec.data) ? migrateDates(rec.data) : rec.data);   // snapshots from before the update use the old day format
}
