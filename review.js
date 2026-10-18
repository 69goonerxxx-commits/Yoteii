// Weekly review: plain functions with no page needed, so they can be tested on their own.
// days:    [{ ds:'2026-10-12', planned:4, done:3 }, ...]   the last seven days, oldest first
// ratings: [{ v:1..5, d:'2026-10-12', w:'peak' }, ...]      energy ratings
export function weekSummary(days, ratings = []){
  const week = new Set(days.map(x => x.ds));
  const mine = ratings.filter(r => week.has(r.d) && r.v >= 1 && r.v <= 5);
  const perDay = days.map(x => {
    const rs = mine.filter(r => r.d === x.ds);
    return { ds:x.ds, planned:x.planned, done:x.done, pct:x.planned ? Math.round(x.done / x.planned * 100) : null,
             energy:rs.length ? rs.reduce((s, r) => s + r.v, 0) / rs.length : null };
  });
  const planned = perDay.reduce((s, x) => s + x.planned, 0), done = perDay.reduce((s, x) => s + x.done, 0);
  const withTasks = perDay.filter(x => x.planned > 0);
  const best = withTasks.length ? withTasks.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
  const byWin = {};
  mine.forEach(r => { if (r.w){ const o = byWin[r.w] || (byWin[r.w] = { s:0, n:0 }); o.s += r.v; o.n++; } });
  const wins = Object.keys(byWin).filter(k => byWin[k].n >= 2).sort((a, b) => byWin[b].s / byWin[b].n - byWin[a].s / byWin[a].n);
  return {
    perDay, planned, done, pct:planned ? Math.round(done / planned * 100) : null,
    best:best && best.pct > 0 ? { ds:best.ds, pct:best.pct } : null,
    energyAvg:mine.length ? mine.reduce((s, r) => s + r.v, 0) / mine.length : null,
    bestWindow:wins.length ? { w:wins[0], avg:byWin[wins[0]].s / byWin[wins[0]].n } : null
  };
}
