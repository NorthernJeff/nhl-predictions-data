/**
 * NHL Win/Loss Lines — hockey pool service (Google Apps Script web app).
 *
 * Paste this whole file into Extensions → Apps Script of a new Google Sheet,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Pools are stored in the "Pools" tab and entries in the "Entries" tab of that Sheet.
 *
 * Every rule that matters is checked here on the server, not just in the page:
 * entry deadline, unique names within a pool, the exact number of picks per
 * position, and that every pick is a real player / team in the playoffs.
 * Entries can never be edited once saved.
 */
var SITE = 'https://northernjeff.github.io/nhl-predictions-data/';
var NEED = { C: 2, LW: 2, RW: 2, D: 4, G: 2, T: 5 };
var TZ = 'America/Toronto';

function doGet(e) { return respond_(handle_((e && e.parameter) || {})); }
function doPost(e) {
  var p = {};
  try { p = JSON.parse(e.postData.contents); } catch (x) {}
  return respond_(handle_(p));
}
function respond_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function handle_(p) {
  try {
    if (p.action === 'create') return createPool_(p);
    if (p.action === 'pool') return getPool_(p);
    if (p.action === 'enter') return addEntry_(p);
    if (p.action === 'ping') return { ok: true };
    return { ok: false, error: 'Unknown request.' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------- storage ----------
function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}
function poolsSheet_() { return sheet_('Pools', ['Code', 'Type', 'Season', 'Created']); }
function entriesSheet_() { return sheet_('Entries', ['Code', 'Name', 'NameKey', 'Picks', 'Entered']); }
function rows_(sh) { var v = sh.getDataRange().getValues(); v.shift(); return v; }

// ---------- site data (the same JSON files the website shows) ----------
function siteJSON_(file) {
  var cache = CacheService.getScriptCache(), key = 'site_' + file, hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch(SITE + file + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Could not load ' + file + ' from the website.');
  var text = res.getContentText();
  try { cache.put(key, text, 300); } catch (x) {}
  return JSON.parse(text);
}

// ---------- rules ----------
function normCode_(c) { return String(c == null ? '' : c).replace(/\D/g, ''); }
function nameKey_(n) { return String(n).trim().replace(/\s+/g, ' ').toLowerCase(); }
function posGroups_(pos) {
  var g = {}, parts = String(pos || '').toUpperCase().split(/[^A-Z]+/);
  parts.forEach(function (p) {
    if (p === 'C') g.C = 1;
    else if (p === 'LW') g.LW = 1;
    else if (p === 'RW') g.RW = 1;
    else if (p === 'W') { g.LW = 1; g.RW = 1; }
    else if (p === 'F') { g.C = 1; g.LW = 1; g.RW = 1; }
    else if (p === 'D') g.D = 1;
  });
  return Object.keys(g);
}
function gameTime_(date, time) {
  // date "YYYY-MM-DD", time like "7:00 PM" (Eastern). Unknown time = noon, to be safe.
  var t = /^\d{1,2}:\d{2}\s*[AP]M$/i.test(String(time || '').trim()) ? String(time).trim().toUpperCase().replace(/\s+/, ' ') : '12:00 PM';
  return Utilities.parseDate(date + ' ' + t, TZ, 'yyyy-MM-dd h:mm a').getTime();
}
// Returns {state:'notyet'|'open'|'closed', deadline:ms|null, message}
function entryStatus_(season) {
  var po = siteJSON_('playoffs.json');
  if (!po || po.season !== season) {
    return { state: 'closed', deadline: null, message: 'The ' + season + ' playoffs are over, so this pool is closed to new entries.' };
  }
  if (!po.seeds) return { state: 'notyet', deadline: null, message: 'Entries open once all 16 playoff teams are known.' };
  if (po.games && po.games.length) return { state: 'closed', deadline: null, message: 'Entries closed when the first playoff game started.' };
  var first = null;
  (po.schedule || []).forEach(function (g) { var t = gameTime_(g[0], g[1]); if (first === null || t < first) first = t; });
  if (first !== null && Date.now() >= first) return { state: 'closed', deadline: first, message: 'Entries closed when the first playoff game started.' };
  return { state: 'open', deadline: first, message: '' };
}

// ---------- actions ----------
function createPool_(p) {
  if (p.type !== 'playoffs') return { ok: false, error: 'Only playoff pools are available right now.' };
  var season = siteJSON_('season.json').season;
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = poolsSheet_(), used = {};
    rows_(sh).forEach(function (r) { used[normCode_(r[0])] = 1; });
    var code;
    for (var i = 0; i < 50; i++) {
      code = String(100000 + Math.floor(Math.random() * 900000));
      if (!used[code]) break;
      code = null;
    }
    if (!code) return { ok: false, error: 'Could not create a pool code. Please try again.' };
    sh.appendRow(["'" + code, 'playoffs', season, new Date()]);
    return { ok: true, code: code, type: 'playoffs', season: season };
  } finally { lock.releaseLock(); }
}

function findPool_(code) {
  var c = normCode_(code);
  if (c.length !== 6) return null;
  var r = rows_(poolsSheet_()).filter(function (r) { return normCode_(r[0]) === c; })[0];
  return r ? { code: c, type: r[1], season: String(r[2]), created: r[3] } : null;
}

function getPool_(p) {
  var pool = findPool_(p.code);
  if (!pool) return { ok: false, error: 'No pool was found with that Pool Code.' };
  var st = entryStatus_(pool.season);
  var reveal = st.state === 'closed';
  var list = rows_(entriesSheet_()).filter(function (r) { return normCode_(r[0]) === pool.code; }).map(function (r) {
    var e = { name: String(r[1]), entered: r[4] };
    if (reveal) { try { e.picks = JSON.parse(r[3]); } catch (x) { e.picks = null; } }
    return e;
  });
  return { ok: true, pool: { code: pool.code, type: pool.type, season: pool.season }, status: st, entries: list, picksVisible: reveal };
}

function validPicks_(picks, season) {
  if (!picks || typeof picks !== 'object') return 'Your picks are missing.';
  var po = siteJSON_('playoffs.json'), st = siteJSON_('stats.json');
  if (po.season !== season || !po.seeds) return 'The playoff teams are not set yet.';
  var teams = {};
  ['W', 'E'].forEach(function (c) { po.seeds[c].forEach(function (pr) { teams[pr[0]] = 1; teams[pr[1]] = 1; }); });
  var seen = {};
  for (var k in NEED) {
    var arr = picks[k];
    if (!Array.isArray(arr) || arr.length !== NEED[k]) return 'Please pick exactly ' + NEED[k] + ' for ' + k + '.';
    for (var i = 0; i < arr.length; i++) {
      var id = String(arr[i]);
      if (seen[id]) return 'You picked the same choice twice: ' + id.replace('|', ' ');
      seen[id] = 1;
      if (k === 'T') { if (!teams[id]) return 'Not a playoff team: ' + id; continue; }
      var bar = id.indexOf('|'), tm = id.slice(0, bar), nm = id.slice(bar + 1);
      if (bar < 1 || !teams[tm]) return 'Not on a playoff team: ' + id.replace('|', ' ');
      if (k === 'G') {
        var g = (st.goalies[tm] || []).some(function (r) { return r[0] === nm; });
        if (!g) return 'Unknown goaltender: ' + nm;
      } else {
        var row = (st.skaters[tm] || []).filter(function (r) { return r[0] === nm; })[0];
        if (!row) return 'Unknown player: ' + nm;
        if (posGroups_(row[1]).indexOf(k) < 0) return nm + ' cannot be picked as ' + k + '.';
      }
    }
  }
  return '';
}

function addEntry_(p) {
  var pool = findPool_(p.code);
  if (!pool) return { ok: false, error: 'No pool was found with that Pool Code.' };
  var st = entryStatus_(pool.season);
  if (st.state !== 'open') return { ok: false, error: st.message };
  var name = String(p.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 24) return { ok: false, error: 'Your display name must be 2 to 24 characters.' };
  if (/[<>]/.test(name)) return { ok: false, error: 'Please use only letters, numbers and simple punctuation in your name.' };
  var bad = validPicks_(p.picks, pool.season);
  if (bad) return { ok: false, error: bad };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = entriesSheet_(), key = nameKey_(name);
    var taken = rows_(sh).some(function (r) { return normCode_(r[0]) === pool.code && String(r[2]) === key; });
    if (taken) return { ok: false, error: 'That name is already taken in this pool. Please choose another.' };
    var clean = {};
    for (var k in NEED) clean[k] = p.picks[k].map(String);
    sh.appendRow(["'" + pool.code, name, key, JSON.stringify(clean), new Date()]);
    return { ok: true, name: name };
  } finally { lock.releaseLock(); }
}
