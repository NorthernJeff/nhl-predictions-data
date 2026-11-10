/**
 * NHL Win/Loss Lines — hockey pool service (Cloudflare Worker route /api).
 * Storage: a Cloudflare D1 database bound to this Worker as "DB" (see wrangler.jsonc).
 * Every rule that matters is enforced here: entry deadline, unique names per pool,
 * exact pick counts, valid playoff players/teams, and no edits after entering.
 *
 * Pool types:
 *   playoffs — 2 C, 2 LW, 2 RW, 4 D, 2 G, 5 teams from the 16 playoff teams.
 *   monthly  — 10 skaters from a top-25 points list frozen when the pool is created, 2 G, 5 teams.
 *              Covers the next calendar month that hasn't started; only each team's first N games of
 *              that month count, N = fewest games any team plays that month (stored with the pool).
 */
import { monthlyValues, snapStatus, takeSnapshot } from './snap.js';
const NEED = { C: 2, LW: 2, RW: 2, D: 4, G: 2, T: 5 };
const NEED_M = { S: 10, G: 2, T: 5 };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthName = m => MONTHS[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4);
const TZ = 'America/Toronto';

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
// Random device id kept in a cookie (no personal information) so one device can enter a pool only once.
const DEV_COOKIE = 'pdev';
function deviceOf(request) {
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)pdev=([A-Za-z0-9]{16,40})/);
  return m ? m[1] : null;
}
const randKey = (len, abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') => [...crypto.getRandomValues(new Uint8Array(len))].map(b => abc[b % abc.length]).join('');
async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
const normKey = k => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function onRequest(ctx) {
  const { request } = ctx;
  let dev = deviceOf(request), fresh = false;
  if (!dev) { dev = randKey(24, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'); fresh = true; }
  ctx.device = dev;
  const res = await handle(ctx);
  if (fresh) res.headers.append('Set-Cookie', `${DEV_COOKIE}=${dev}; Path=/api; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
  return res;
}

async function handle(ctx) {
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
    if (p.action === 'admin') return json(await adminView(ctx, p));
    if (p.action === 'remove') return json(await adminRemove(ctx, p));
    if (p.action === 'snapstatus') return json(await snapStatus(env, (await siteJSON(ctx, 'season.json')).season));
    if (p.action === 'snapnow') return json(await takeSnapshot(env));
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
  // monthly pools keep their month, N and frozen player list in "meta" (added after launch)
  const cols = await db.prepare('PRAGMA table_info(pools)').all();
  for (const col of ['meta', 'admin_hash']) if (!cols.results.some(c => c.name === col)) { try { await db.prepare(`ALTER TABLE pools ADD COLUMN ${col} TEXT`).run(); } catch (e) {} }
  const ecols = await db.prepare('PRAGMA table_info(entries)').all();
  if (!ecols.results.some(c => c.name === 'device')) { try { await db.prepare('ALTER TABLE entries ADD COLUMN device TEXT').run(); } catch (e) {} }
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

// Regular-season games by month: every played and scheduled game, with each team's game count.
async function monthGames(ctx) {
  const [g, s] = await Promise.all([siteJSON(ctx, 'games.json'), siteJSON(ctx, 'schedule.json')]);
  const list = [];
  for (const x of (g && g.games) || []) list.push({ d: x[0], t: null, a: x[1], h: x[3] });
  const seen = new Set(list.map(x => x.d + x.a + x.h));
  for (const x of (s && s.games) || []) if (!seen.has(x[0] + x[2] + x[3])) list.push({ d: x[0], t: x[1], a: x[2], h: x[3] });
  return list;
}
// The month a new monthly pool covers: the earliest month whose first game hasn't started yet.
async function nextMonth(ctx) {
  const list = await monthGames(ctx), by = {};
  for (const x of list) { const m = x.d.slice(0, 7); (by[m] = by[m] || []).push(x); }
  const now = Date.now();
  for (const m of Object.keys(by).sort()) {
    const gs = by[m];
    if (gs.some(x => x.t === null)) continue; // games already played in this month
    let first = null; for (const x of gs) { const t = easternToUTC(x.d, x.t); if (first === null || t < first) first = t; }
    if (first <= now) continue;
    const cnt = {}; for (const x of gs) { cnt[x.a] = (cnt[x.a] || 0) + 1; cnt[x.h] = (cnt[x.h] || 0) + 1; }
    const teams = Object.keys(cnt);
    if (teams.length < 32) continue; // a month with only a few games (e.g. the end of September)
    return { month: m, first, n: Math.min(...teams.map(t => cnt[t])) };
  }
  return null;
}
function topSkaters(stats, k) {
  const sk = [];
  for (const tm in (stats && stats.skaters) || {}) for (const x of stats.skaters[tm]) sk.push({ n: x[0], t: tm, pos: x[1], gp: x[2], pts: x[3], g: x[5] || 0 });
  sk.sort((a, b) => b.pts - a.pts || b.g - a.g || a.gp - b.gp);
  return sk.slice(0, k).map(x => [x.t, x.n, x.pos, x.pts, x.gp]);
}

async function createPool(ctx, p) {
  if (p.type !== 'playoffs' && p.type !== 'monthly') return { ok: false, error: 'Unknown pool type.' };
  const season = (await siteJSON(ctx, 'season.json')).season;
  let meta = null;
  if (p.type === 'monthly') {
    const nm = await nextMonth(ctx);
    if (!nm) return { ok: false, error: 'There are no more monthly pools this regular season.' };
    const stats = await siteJSON(ctx, 'stats.json');
    const players = topSkaters(stats, 25);
    if (players.length < 25) return { ok: false, error: 'Player statistics are not available yet. Please try again later.' };
    meta = { month: nm.month, n: nm.n, deadline: nm.first, players, frozen: stats.updated || null };
  }
  const adminKey = randKey(10);
  for (let i = 0; i < 30; i++) {
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const r = await ctx.env.DB.prepare('INSERT OR IGNORE INTO pools (code, type, season, created, meta, admin_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(code, p.type, season, new Date().toISOString(), meta ? JSON.stringify(meta) : null, await sha(code + ':' + adminKey)).run();
    if (r.meta && r.meta.changes === 1) return { ok: true, code, adminKey: adminKey.slice(0, 5) + '-' + adminKey.slice(5), type: p.type, season, month: meta && meta.month, monthName: meta && monthName(meta.month), n: meta && meta.n };
  }
  return { ok: false, error: 'Could not create a pool code. Please try again.' };
}

async function findPool(ctx, code) {
  const c = normCode(code);
  if (c.length !== 6) return null;
  const row = await ctx.env.DB.prepare('SELECT code, type, season, created, meta, admin_hash FROM pools WHERE code = ?').bind(c).first();
  if (row) { try { row.meta = row.meta ? JSON.parse(row.meta) : null; } catch (e) { row.meta = null; } }
  return row;
}
function monthlyStatus(pool) {
  const m = pool.meta || {}, dl = m.deadline;
  if (dl && Date.now() >= dl) return { state: 'closed', deadline: dl, message: 'Entries closed when the first game of ' + monthName(m.month) + ' started.' };
  return { state: 'open', deadline: dl || null, message: '' };
}
const statusFor = (ctx, pool) => pool.type === 'monthly' ? monthlyStatus(pool) : entryStatus(ctx, pool.season);

async function getPool(ctx, p) {
  const pool = await findPool(ctx, p.code);
  if (!pool) return { ok: false, error: 'No pool was found with that Pool Code.' };
  const st = await statusFor(ctx, pool);
  const reveal = st.state === 'closed';
  const { results } = await ctx.env.DB.prepare('SELECT name, picks, entered FROM entries WHERE code = ? ORDER BY entered').bind(pool.code).all();
  const entries = results.map(r => {
    const e = { name: r.name, entered: r.entered };
    if (reveal) { try { e.picks = JSON.parse(r.picks); } catch (x) { e.picks = null; } }
    return e;
  });
  const info = { code: pool.code, type: pool.type, season: pool.season };
  if (pool.type === 'monthly' && pool.meta) {
    Object.assign(info, { month: pool.meta.month, monthName: monthName(pool.meta.month), n: pool.meta.n, players: pool.meta.players, frozen: pool.meta.frozen });
    if (reveal) {
      // games each team played before the month, then every pick's points/saves within its team's first N games
      const g = await siteJSON(ctx, 'games.json'), k0 = {}, start = pool.meta.month + '-01';
      for (const x of (g && g.games) || []) for (const t of [x[1], x[3]]) { k0[t] = k0[t] || 0; if (x[0] < start) k0[t]++; }
      const kinds = { s: new Set(), g: new Set() };
      for (const e of entries) if (e.picks) { (e.picks.S || []).forEach(id => kinds.s.add(id)); (e.picks.G || []).forEach(id => kinds.g.add(id)); }
      try { info.values = await monthlyValues(ctx.env, pool.season, { s: [...kinds.s], g: [...kinds.g] }, k0, pool.meta.n); }
      catch (e) { info.values = {}; info.valuesError = String(e.message || e); }
    }
  }
  return { ok: true, pool: info, status: st, entries, picksVisible: reveal };
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

async function validMonthly(ctx, picks, pool) {
  if (!picks || typeof picks !== 'object') return 'Your picks are missing.';
  const st = await siteJSON(ctx, 'stats.json');
  const allowed = new Set(((pool.meta && pool.meta.players) || []).map(r => r[0] + '|' + r[1]));
  const seen = new Set();
  for (const k in NEED_M) {
    const arr = picks[k];
    if (!Array.isArray(arr) || arr.length !== NEED_M[k]) return 'Please pick exactly ' + NEED_M[k] + (k === 'S' ? ' skaters.' : k === 'G' ? ' goaltenders.' : ' teams.');
    for (const raw of arr) {
      const id = String(raw);
      if (seen.has(id)) return 'You picked the same choice twice: ' + id.replace('|', ' ');
      seen.add(id);
      if (k === 'T') { if (!(st.teams && st.teams[id])) return 'Unknown team: ' + id; continue; }
      const bar = id.indexOf('|'), tm = id.slice(0, bar), nm = id.slice(bar + 1);
      if (k === 'S') { if (!allowed.has(id)) return nm + ' is not on this pool\'s top-25 list.'; continue; }
      if (bar < 1 || !(st.goalies[tm] || []).some(r => r[0] === nm)) return 'Unknown goaltender: ' + nm;
    }
  }
  return '';
}

async function addEntry(ctx, p) {
  const pool = await findPool(ctx, p.code);
  if (!pool) return { ok: false, error: 'No pool was found with that Pool Code.' };
  const st = await statusFor(ctx, pool);
  if (st.state !== 'open') return { ok: false, error: st.message };
  const name = String(p.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 24) return { ok: false, error: 'Your display name must be 2 to 24 characters.' };
  if (/[<>]/.test(name)) return { ok: false, error: 'Please use only letters, numbers and simple punctuation in your name.' };
  const monthly = pool.type === 'monthly';
  const bad = monthly ? await validMonthly(ctx, p.picks, pool) : await validPicks(ctx, p.picks, pool.season);
  if (bad) return { ok: false, error: bad };
  const clean = {};
  for (const k in (monthly ? NEED_M : NEED)) clean[k] = p.picks[k].map(String);
  // The (code, name_key) primary key makes duplicate names impossible, even for simultaneous entries.
  const dup = await ctx.env.DB.prepare('SELECT 1 FROM entries WHERE code = ? AND device = ?').bind(pool.code, ctx.device).first();
  if (dup) return { ok: false, error: 'This device has already entered this pool. Each device can enter a pool only once.' };
  const r = await ctx.env.DB.prepare('INSERT OR IGNORE INTO entries (code, name, name_key, picks, entered, device) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(pool.code, name, nameKey(name), JSON.stringify(clean), new Date().toISOString(), ctx.device).run();
  if (!r.meta || r.meta.changes !== 1) return { ok: false, error: 'That name is already taken in this pool. Please choose another.' };
  return { ok: true, name };
}

// ---------- pool admin (needs the Admin Key shown once when the pool was started) ----------
async function adminPool(ctx, p) {
  const pool = await findPool(ctx, p.code);
  if (!pool) return { err: 'No pool was found with that Pool Code.' };
  if (!pool.admin_hash) return { err: 'This pool was started before admin keys existed, so it has no admin page.' };
  if (await sha(pool.code + ':' + normKey(p.key)) !== pool.admin_hash) return { err: 'That Admin Key is not correct for this pool.' };
  return { pool };
}
async function adminView(ctx, p) {
  const { pool, err } = await adminPool(ctx, p);
  if (err) return { ok: false, error: err };
  const { results } = await ctx.env.DB.prepare('SELECT name, name_key, entered FROM entries WHERE code = ? ORDER BY entered').bind(pool.code).all();
  const st = await statusFor(ctx, pool);
  return { ok: true, pool: { code: pool.code, type: pool.type, season: pool.season, monthName: pool.meta && pool.meta.month ? monthName(pool.meta.month) : null }, status: st,
    entries: results.map(r => ({ name: r.name, id: r.name_key, entered: r.entered })) };
}
async function adminRemove(ctx, p) {
  const { pool, err } = await adminPool(ctx, p);
  if (err) return { ok: false, error: err };
  const r = await ctx.env.DB.prepare('DELETE FROM entries WHERE code = ? AND name_key = ?').bind(pool.code, String(p.id || '')).run();
  if (!r.meta || r.meta.changes !== 1) return { ok: false, error: 'That entry was not found (it may already be removed).' };
  return { ok: true };
}
