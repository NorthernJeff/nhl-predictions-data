// Hourly stat snapshots for monthly pools (Cloudflare cron, see wrangler.jsonc "triggers").
// Each snapshot stores every skater's season points and every goalie's season saves together with how many
// games each team had played at that moment. A monthly pool then counts, for a team's players, the change
// between "team had played k0 games" (before the month) and "team had played k0 + N games".
const UA = { 'User-Agent': 'puck-off.com monthly pool snapshots', Accept: 'application/json' };
export const normName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

async function ensure(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS snaps (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, season TEXT NOT NULL, teamgp TEXT NOT NULL, data TEXT NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS snaps_season ON snaps (season, id)'),
    db.prepare('CREATE TABLE IF NOT EXISTS people (pid INTEGER NOT NULL, season TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, nkey TEXT NOT NULL, teams TEXT NOT NULL, PRIMARY KEY (pid, season, kind))'),
  ]);
}
async function getJ(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(url + ' answered ' + r.status);
  return r.json();
}

export async function takeSnapshot(env) {
  const db = env.DB; if (!db) return { ok: false, error: 'no DB' };
  await ensure(db);
  const seasonFile = await (await env.ASSETS.fetch(new Request('https://puck-off.com/season.json'))).json();
  const season = seasonFile.season; // "2026-27"
  if (seasonFile.phase && seasonFile.phase !== 'regular') return { ok: true, skipped: 'not regular season' };
  const sid = season.slice(0, 4) + '20' + season.slice(5, 7); // 20262027
  const q = `?limit=-1&start=0&cayenneExp=${encodeURIComponent(`seasonId=${sid} and gameTypeId=2`)}`;
  const [st, sk, gk] = await Promise.all([
    getJ('https://api-web.nhle.com/v1/standings/now'),
    getJ('https://api.nhle.com/stats/rest/en/skater/summary' + q),
    getJ('https://api.nhle.com/stats/rest/en/goalie/summary' + q),
  ]);
  const teamgp = {};
  for (const t of st.standings || []) { const a = t.teamAbbrev && (t.teamAbbrev.default || t.teamAbbrev); if (a) teamgp[a] = t.gamesPlayed; }
  if (Object.keys(teamgp).length < 30) return { ok: false, error: 'standings incomplete' };
  const data = { s: {}, g: {} }, people = [];
  for (const r of sk.data || []) { data.s[r.playerId] = r.points || 0; people.push([r.playerId, 's', r.skaterFullName, r.teamAbbrevs || '']); }
  for (const r of gk.data || []) { data.g[r.playerId] = r.saves || 0; people.push([r.playerId, 'g', r.goalieFullName, r.teamAbbrevs || '']); }
  if (people.length < 300) return { ok: false, error: 'player list incomplete' };
  // skip when nothing changed since the last snapshot
  const last = await db.prepare('SELECT teamgp, data FROM snaps WHERE season = ? ORDER BY id DESC LIMIT 1').bind(season).first();
  const tg = JSON.stringify(teamgp), dj = JSON.stringify(data);
  if (last && last.teamgp === tg && last.data === dj) return { ok: true, skipped: 'unchanged' };
  const stmts = [db.prepare('INSERT INTO snaps (ts, season, teamgp, data) VALUES (?, ?, ?, ?)').bind(new Date().toISOString(), season, tg, dj)];
  for (const [pid, kind, name, teams] of people)
    stmts.push(db.prepare('INSERT INTO people (pid, season, kind, name, nkey, teams) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (pid, season, kind) DO UPDATE SET name = excluded.name, nkey = excluded.nkey, teams = CASE WHEN instr(people.teams, excluded.teams) > 0 THEN people.teams ELSE people.teams || \',\' || excluded.teams END')
      .bind(pid, season, kind, name, normName(name), teams));
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  return { ok: true, saved: true, teams: Object.keys(teamgp).length, players: people.length };
}

export async function snapStatus(env, season) {
  await ensure(env.DB);
  const r = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(ts) AS last FROM snaps WHERE season = ?').bind(season).first();
  return { ok: true, season, snapshots: r.n, last: r.last };
}

// Values for a monthly pool's picks: { "TEAM|Name": points or saves within the team's first N games of the month }.
// k0[team] = games the team played before the month starts.
export async function monthlyValues(env, season, picksByKind, k0, n) {
  await ensure(env.DB);
  const db = env.DB;
  const rows = (await db.prepare('SELECT id, teamgp FROM snaps WHERE season = ? ORDER BY id').bind(season).all()).results
    .map(r => ({ id: r.id, gp: JSON.parse(r.teamgp) }));
  if (!rows.length) return {};
  const pick = (t, k) => { let best = null; for (const r of rows) if ((r.gp[t] ?? 0) <= k) best = r.id; return best; };
  // people lookup
  const ppl = (await db.prepare('SELECT pid, kind, nkey, teams FROM people WHERE season = ?').bind(season).all()).results;
  const findPid = (kind, id) => {
    const bar = id.indexOf('|'), t = id.slice(0, bar), key = normName(id.slice(bar + 1));
    const same = ppl.filter(p => p.kind === kind && p.nkey === key);
    const onTeam = same.filter(p => p.teams.split(',').includes(t));
    return (onTeam[0] || (same.length === 1 ? same[0] : null) || {}).pid;
  };
  const need = new Set(), plan = [];
  for (const kind of ['s', 'g']) for (const id of picksByKind[kind] || []) {
    const t = id.slice(0, id.indexOf('|')), pid = findPid(kind, id);
    if (pid == null || k0[t] == null) { plan.push([id, kind, null]); continue; }
    let a = pick(t, k0[t]); const b = pick(t, k0[t] + n);
    if (b == null) { plan.push([id, kind, null]); continue; }
    if (a == null) a = k0[t] === 0 ? 0 : rows[0].id; // no snapshot before the month: season start counts from zero
    if (a) need.add(a); need.add(b); plan.push([id, kind, pid, a, b]);
  }
  const data = {};
  const ids = [...need];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await db.prepare(`SELECT id, data FROM snaps WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const r of res.results) data[r.id] = JSON.parse(r.data);
  }
  const out = {};
  for (const [id, kind, pid, a, b] of plan) {
    if (pid == null) { out[id] = 0; continue; }
    const v = s => (s && s[kind] && s[kind][pid]) || 0;
    out[id] = Math.max(0, v(data[b]) - (a ? v(data[a]) : 0));
  }
  return out;
}
