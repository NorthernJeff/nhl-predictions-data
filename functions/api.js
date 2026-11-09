/**
 * NHL Win/Loss Lines — hockey pool service (Cloudflare Pages Function at /api).
 * Storage: a Cloudflare D1 database bound to this Pages project as "DB".
 * Every rule that matters is enforced here: entry deadline, unique names per pool,
 * exact pick counts, valid playoff players/teams, and no edits after entering.
 */
const NEED = { C: 2, LW: 2, RW: 2, D: 4, G: 2, T: 5 };
const TZ = 'America/Toronto';

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function onRequest(ctx) {
  const { request, env } = ctx;
  try {
    if (!env.DB) return json({ ok: false, error: 'The pool database is not connected yet.' });
    await ensureTables(env.DB);
    let p = {};
    if (request.method === 'POST') { try { p = JSON.parse(await request.text()); } catch (e) {} }
    else p = Object.fromEntries(new URL(request.url).searchParams);
    if (p.action === 'ping') return json({ ok: true });
    if (p.action === 'create') return json(await createPool(ctx, p));
    if (p.action === 'pool') return json(await getPool(ctx, p));
    if (p.action === 'enter') return json(await addEntry(ctx, p));
    return json({ ok: false, error: 'Unknown request.' });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS pools (code TEXT PRIMARY KEY, type TEXT NOT NULL, season TEXT NOT NULL, created TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS entries (code TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, picks TEXT NOT NULL, entered TEXT NOT NULL, PRIMARY KEY (code, name_key))'),
  ]);
  tablesReady = true;
}

// The site's own data files, read from this same deployment.
async function siteJSON(ctx, file) {
  const url = new URL('/' + file, ctx.request.url);
  const res = await ctx.env.ASSETS.fetch(new Request(url.toString()));
  if (!res.ok) throw new Error('Could not load ' + file + '.');
  return res.json();
}

const normCode = c => String(c == null ? '' : c).replace(/\D/g, '');
const nameKey = n => String(n).trim().replace(/\s+/g, ' ').toLowerCase();
function posGroups(pos) {
  const g = new Set();
  String(pos || '').toUpperCase().split(/[^A-Z]+/).forEach(p => {
    if (p === 'C') g.add('C'); else if (p === 'LW') g.add('LW'); else if (p === 'RW') g.add('RW');
    else if (p === 'W') { g.add('LW'); g.add('RW'); }
    else if (p === 'F') { g.add('C'); g.add('LW'); g.add('RW'); }
    else if (p === 'D') g.add('D');
  });
  return [...g];
}
// Eastern wall-clock time -> UTC milliseconds (handles EST/EDT).
function easternToUTC(date, time) {
  const m = String(time || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  let h = 12, min = 0;
  if (m) { h = (+m[1]) % 12 + (m[3].toUpperCase() === 'PM' ? 12 : 0); min = +m[2]; }
  const [Y, M, D] = date.split('-').map(Number);
  let guess = Date.UTC(Y, M - 1, D, h, min);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    guess += Date.UTC(Y, M - 1, D, h, min) - shown;
  }
  return guess;
}
async function entryStatus(ctx, season) {
  const po = await siteJSON(ctx, 'playoffs.json');
  if (!po || po.season !== season) return { state: 'closed', deadline: null, message: 'The ' + season + ' playoffs are over, so this pool is closed to new entries.' };
  if (!po.seeds) return { state: 'notyet', deadline: null, message: 'Entries open once all 16 playoff teams are known.' };
  if (po.games && po.games.length) return { state: 'closed', deadline: null, message: 'Entries closed when the first playoff game started.' };
  let first = null;
  for (const g of po.schedule || []) { const t = easternToUTC(g[0], g[1]); if (first === null || t < first) first = t; }
  if (first !== null && Date.now() >= first) return { state: 'closed', deadline: first, message: 'Entries closed when the first playoff game started.' };
  return { state: 'open', deadline: first, message: '' };
}

async function createPool(ctx, p) {
  if (p.type !== 'playoffs') return { ok: false, error: 'Only playoff pools are available right now.' };
  const season = (await siteJSON(ctx, 'season.json')).season;
  for (let i = 0; i < 30; i++) {
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const r = await ctx.env.DB.prepare('INSERT OR IGNORE INTO pools (code, type, season, created) VALUES (?, ?, ?, ?)')
      .bind(code, 'playoffs', season, new Date().toISOString()).run();
    if (r.meta && r.meta.changes === 1) return { ok: true, code, type: 'playoffs', season };
  }
  return { ok: false, error: 'Could not create a pool code. Please try again.' };
}

async function findPool(ctx, code) {
  const c = normCode(code);
  if (c.length !== 6) return null;
  return ctx.env.DB.prepare('SELECT code, type, season, created FROM pools WHERE code = ?').bind(c).first();
}

async function getPool(ctx, p) {
  const pool = await findPool(ctx, p.code);
  if (!pool) return { ok: false, error: 'No pool was found with that Pool Code.' };
  const st = await entryStatus(ctx, pool.season);
  const reveal = st.state === 'closed';
  const { results } = await ctx.env.DB.prepare('SELECT name, picks, entered FROM entries WHERE code = ? ORDER BY entered').bind(pool.code).all();
  const entries = results.map(r => {
    const e = { name: r.name, entered: r.entered };
    if (reveal) { try { e.picks = JSON.parse(r.picks); } catch (x) { e.picks = null; } }
    return e;
  });
  return { ok: true, pool: { code: pool.code, type: pool.type, season: pool.season }, status: st, entries, picksVisible: reveal };
}

async function validPicks(ctx, picks, season) {
  if (!picks || typeof picks !== 'object') return 'Your picks are missing.';
  const po = await siteJSON(ctx, 'playoffs.json'), st = await siteJSON(ctx, 'stats.json');
  if (po.season !== season || !po.seeds) return 'The playoff teams are not set yet.';
  const teams = new Set(['W', 'E'].flatMap(c => po.seeds[c].flat()));
  const seen = new Set();
  for (const k in NEED) {
    const arr = picks[k];
    if (!Array.isArray(arr) || arr.length !== NEED[k]) return 'Please pick exactly ' + NEED[k] + ' for ' + k + '.';
    for (const raw of arr) {
      const id = String(raw);
      if (seen.has(id)) return 'You picked the same choice twice: ' + id.replace('|', ' ');
      seen.add(id);
      if (k === 'T') { if (!teams.has(id)) return 'Not a playoff team: ' + id; continue; }
      const bar = id.indexOf('|'), tm = id.slice(0, bar), nm = id.slice(bar + 1);
      if (bar < 1 || !teams.has(tm)) return 'Not on a playoff team: ' + id.replace('|', ' ');
      if (k === 'G') {
        if (!(st.goalies[tm] || []).some(r => r[0] === nm)) return 'Unknown goaltender: ' + nm;
      } else {
        const row = (st.skaters[tm] || []).find(r => r[0] === nm);
        if (!row) return 'Unknown player: ' + nm;
        if (!posGroups(row[1]).includes(k)) return nm + ' cannot be picked as ' + k + '.';
      }
    }
  }
  return '';
}

async function addEntry(ctx, p) {
  const pool = await findPool(ctx, p.code);
  if (!pool) return { ok: false, error: 'No pool was found with that Pool Code.' };
  const st = await entryStatus(ctx, pool.season);
  if (st.state !== 'open') return { ok: false, error: st.message };
  const name = String(p.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 24) return { ok: false, error: 'Your display name must be 2 to 24 characters.' };
  if (/[<>]/.test(name)) return { ok: false, error: 'Please use only letters, numbers and simple punctuation in your name.' };
  const bad = await validPicks(ctx, p.picks, pool.season);
  if (bad) return { ok: false, error: bad };
  const clean = {};
  for (const k in NEED) clean[k] = p.picks[k].map(String);
  // The (code, name_key) primary key makes duplicate names impossible, even for simultaneous entries.
  const r = await ctx.env.DB.prepare('INSERT OR IGNORE INTO entries (code, name, name_key, picks, entered) VALUES (?, ?, ?, ?, ?)')
    .bind(pool.code, name, nameKey(name), JSON.stringify(clean), new Date().toISOString()).run();
  if (!r.meta || r.meta.changes !== 1) return { ok: false, error: 'That name is already taken in this pool. Please choose another.' };
  return { ok: true, name };
}
