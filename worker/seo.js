// Search-engine pages rendered by the Worker from the same data files the app uses.
//   /nhl-predictions  — today's and tomorrow's games with win probabilities, last night's results,
//                       standings and points leaders, as plain HTML Google can read.
//   /sitemap.xml      — list of the site's pages for search engines.
export const SITE = 'https://puck-off.com';
export const BRAND = 'Puck-Off';

const TEAMS = [
  ['Atlantic','BOS','Boston Bruins'],['Atlantic','BUF','Buffalo Sabres'],['Atlantic','DET','Detroit Red Wings'],['Atlantic','FLA','Florida Panthers'],['Atlantic','MTL','Montréal Canadiens'],['Atlantic','OTT','Ottawa Senators'],['Atlantic','TBL','Tampa Bay Lightning'],['Atlantic','TOR','Toronto Maple Leafs'],
  ['Metropolitan','CAR','Carolina Hurricanes'],['Metropolitan','CBJ','Columbus Blue Jackets'],['Metropolitan','NJD','New Jersey Devils'],['Metropolitan','NYI','New York Islanders'],['Metropolitan','NYR','New York Rangers'],['Metropolitan','PHI','Philadelphia Flyers'],['Metropolitan','PIT','Pittsburgh Penguins'],['Metropolitan','WSH','Washington Capitals'],
  ['Central','CHI','Chicago Blackhawks'],['Central','COL','Colorado Avalanche'],['Central','DAL','Dallas Stars'],['Central','MIN','Minnesota Wild'],['Central','NSH','Nashville Predators'],['Central','STL','St. Louis Blues'],['Central','UTA','Utah Mammoth'],['Central','WPG','Winnipeg Jets'],
  ['Pacific','ANA','Anaheim Ducks'],['Pacific','CGY','Calgary Flames'],['Pacific','EDM','Edmonton Oilers'],['Pacific','LAK','Los Angeles Kings'],['Pacific','SJS','San Jose Sharks'],['Pacific','SEA','Seattle Kraken'],['Pacific','VAN','Vancouver Canucks'],['Pacific','VGK','Vegas Golden Knights'],
];
const T = {}; TEAMS.forEach(([d, a, n]) => (T[a] = { div: d, name: n }));
const nm = a => (T[a] ? T[a].name : a);
// Same constants as the app's Elo model (index.html)
const ELO = { K: 7, INIT: 80, HOME: 30, B2B: 35, REVERT: 1 / 3 };

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function getJSON(env, origin, path) {
  try {
    const r = await env.ASSETS.fetch(new Request(origin + '/' + path));
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

// Today's date in Eastern time as YYYY-MM-DD
function etDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const longDate = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayNum = s => Math.round(new Date(s + 'T12:00:00Z').getTime() / 864e5);
const eloP = dr => 1 / (1 + Math.pow(10, -dr / 400));
const timeKey = t => { const m = /(\d+):(\d+)\s*(AM|PM)/i.exec(t || ''); if (!m) return 9999; let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; return h * 60 + +m[2]; };

function runElo(season, archives, prior, games, poGames) {
  const R = {}, last = {}, preds = [];
  const priorGD = t => { const p = prior && prior.teams && prior.teams[t]; return p ? (p.gf - p.ga) / p.gp : 0; };
  const g = t => (t in R) ? R[t] : (R[t] = (prior && prior.teams && prior.teams[t] && prior.teams[t].elo != null) ? prior.teams[t].elo : 1500 + ELO.INIT * priorGD(t));
  const play = (list, lst, record) => {
    for (const [d, a, ag, h, hg] of list) {
      const dn = dayNum(d), ra = a in lst ? dn - lst[a] - 1 : 9, rh = h in lst ? dn - lst[h] - 1 : 9;
      const p = eloP(g(h) - g(a) + ELO.HOME + ELO.B2B * ((ra === 0) - (rh === 0))), y = hg > ag ? 1 : 0;
      if (record) preds.push({ d, a, h, p, y });
      const ch = ELO.K * Math.log(Math.abs(hg - ag) + 1) * (y - p); R[h] += ch; R[a] -= ch; lst[a] = lst[h] = dn;
    }
  };
  for (const s of (season && season.archives) || []) {
    const A = archives[s]; if (!A) continue;
    play([...(A.games || []), ...(A.playoffGames || [])], {}, false);
    for (const t in T) { g(t); R[t] = 1500 + (R[t] - 1500) * (1 - ELO.REVERT); }
  }
  play(games, last, true);
  play(poGames, last, false);
  for (const t in T) g(t);
  return { R, last, preds };
}

function standings(games) {
  const S = {}; TEAMS.forEach(t => (S[t[1]] = { tm: t[1], div: t[0], gp: 0, w: 0, l: 0, o: 0, rw: 0, gf: 0, ga: 0 }));
  for (const [, a, ag, h, hg, note] of games) for (const [t, f, x] of [[a, ag, hg], [h, hg, ag]]) {
    const r = S[t]; if (!r) continue; r.gp++; r.gf += f; r.ga += x;
    if (f > x) { r.w++; if (!note) r.rw++; } else if (note) r.o++; else r.l++;
  }
  return Object.values(S).map(r => ({ ...r, pts: 2 * r.w + r.o, pct: r.gp ? (2 * r.w + r.o) / (2 * r.gp) : 0, diff: r.gf - r.ga }))
    .sort((a, b) => b.pts - a.pts || b.pct - a.pct || b.rw - a.rw || b.w - a.w || b.diff - a.diff);
}

const pct = p => Math.round(p * 100) + '%';

export async function renderPredictions(env, origin) {
  const [season, gamesF, sched, stats, prior, po] = await Promise.all(
    ['season.json', 'games.json', 'schedule.json', 'stats.json', 'prior.json', 'playoffs.json'].map(f => getJSON(env, origin, f)));
  const archives = {};
  await Promise.all(((season && season.archives) || []).map(async s => { archives[s] = await getJSON(env, origin, 'archive/' + s + '.json'); }));
  const games = (gamesF && gamesF.games) || [];
  const poOn = !!(season && season.phase === 'playoffs' && po);
  const poGames = poOn ? po.games || [] : [];
  const E = runElo(season, archives, prior, games, poGames);
  const seasonName = (season && season.season) || '2026-27';

  // upcoming schedule (regular season + playoff games), rest days counted from the previous game played or scheduled
  const all = [...((sched && sched.games) || [])];
  if (poOn) for (const g of po.schedule || []) all.push(g);
  const played = new Set([...games, ...poGames].map(g => g[0] + '|' + g[1] + '|' + g[3]));
  const upcoming = all.filter(g => !played.has(g[0] + '|' + g[2] + '|' + g[3]));
  const rest = (tm, date) => {
    let prev = tm in E.last ? E.last[tm] : null;
    for (const g of upcoming) if ((g[2] === tm || g[3] === tm) && g[0] < date) { const d = dayNum(g[0]); if (prev == null || d > prev) prev = d; }
    return prev == null ? 9 : dayNum(date) - prev - 1;
  };
  const predict = g => {
    const [d, , a, h] = g, ra = rest(a, d), rh = rest(h, d);
    const p = eloP(E.R[h] - E.R[a] + ELO.HOME + ELO.B2B * ((ra === 0) - (rh === 0)));
    return { d, time: g[1], a, h, p, b2bA: ra === 0, b2bH: rh === 0 };
  };

  const today = etDate(0);
  const dates = [...new Set(upcoming.map(g => g[0]).filter(d => d >= today))].sort();
  const day1 = dates[0], day2 = dates[1];
  const byDay = d => upcoming.filter(g => g[0] === d).sort((x, y) => timeKey(x[1]) - timeKey(y[1])).map(predict);

  const pastDates = [...new Set(games.concat(poGames).map(g => g[0]).filter(d => d < today))].sort();
  const lastNight = pastDates[pastDates.length - 1];
  const predMap = {}; E.preds.forEach(x => (predMap[x.d + '|' + x.a + '|' + x.h] = x));
  const results = games.concat(poGames).filter(g => g[0] === lastNight);

  // season record of the base model (same eligibility rule as the app: skip each team's first 3 games, then the first 40 eligible)
  const gp = {}; const elig = [];
  for (const x of E.preds) { if ((gp[x.a] || 0) >= 3 && (gp[x.h] || 0) >= 3) elig.push(x); gp[x.a] = (gp[x.a] || 0) + 1; gp[x.h] = (gp[x.h] || 0) + 1; }
  const scored = elig.slice(40); const ok = scored.filter(x => (x.p > 0.5) === (x.y === 1)).length;
  const acc = scored.length ? Math.round(100 * ok / scored.length) : null;

  const st = standings(games);
  const sk = [];
  if (stats && stats.skaters) for (const tm in stats.skaters) for (const x of stats.skaters[tm]) sk.push({ n: x[0], tm, pos: x[1], gp: x[2], pts: x[3], g: x[5], a: x[6] });
  const leaders = sk.sort((a, b) => b.pts - a.pts || (b.g || 0) - (a.g || 0) || a.gp - b.gp).slice(0, 10);

  const fav = x => (x.p >= 0.5 ? x.h : x.a);
  const gameRow = x => `<tr><td class="tm">${esc(x.time || '')}</td><td><b>${esc(nm(x.a))}</b> at <b>${esc(nm(x.h))}</b>${x.b2bA || x.b2bH ? ` <span class="tag">${[x.b2bA ? esc(x.a) : '', x.b2bH ? esc(x.h) : ''].filter(Boolean).join(', ')} back-to-back</span>` : ''}</td><td class="num">${pct(1 - x.p)}</td><td class="num">${pct(x.p)}</td><td><span class="pick">${esc(nm(fav(x)))}</span></td></tr>`;
  const gamesTable = (list) => list.length
    ? `<div class="scroll"><table><thead><tr><th>Time (ET)</th><th>Matchup</th><th class="num">Away win</th><th class="num">Home win</th><th>Favourite</th></tr></thead><tbody>${list.map(gameRow).join('')}</tbody></table></div>`
    : `<p class="muted">No games scheduled.</p>`;
  const l1 = day1 ? byDay(day1) : [], l2 = day2 ? byDay(day2) : [];
  const d1label = day1 === today ? 'Tonight' : day1 ? shortDate(day1) : 'Next games';
  const top = l1.slice().sort((a, b) => Math.abs(b.p - 0.5) - Math.abs(a.p - 0.5))[0];

  const resRows = results.map(g => {
    const [, a, ag, h, hg, note] = g, x = predMap[g[0] + '|' + a + '|' + h];
    const win = hg > ag ? h : a, picked = x ? (x.p >= 0.5 ? h : a) : null;
    return `<tr><td>${esc(nm(a))} <b>${ag}</b> – <b>${hg}</b> ${esc(nm(h))}${note ? ` <span class="tag">${esc(note)}</span>` : ''}</td><td>${x ? esc(nm(picked)) + ' (' + pct(Math.max(x.p, 1 - x.p)) + ')' : '–'}</td><td>${picked ? (picked === win ? '<span class="ok">✓ Correct</span>' : '<span class="bad">✗ Missed</span>') : ''}</td></tr>`;
  }).join('');

  const divTables = ['Atlantic', 'Metropolitan', 'Central', 'Pacific'].map(dv => `<div class="card"><h3>${dv} Division</h3><table><thead><tr><th>Team</th><th class="num">GP</th><th class="num">W</th><th class="num">L</th><th class="num">OTL</th><th class="num">PTS</th><th class="num">DIFF</th></tr></thead><tbody>${st.filter(r => r.div === dv).map(r => `<tr><td>${esc(nm(r.tm))}</td><td class="num">${r.gp}</td><td class="num">${r.w}</td><td class="num">${r.l}</td><td class="num">${r.o}</td><td class="num"><b>${r.pts}</b></td><td class="num">${r.diff > 0 ? '+' : ''}${r.diff}</td></tr>`).join('')}</tbody></table></div>`).join('');

  const leadRows = leaders.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${esc(r.n)}</td><td>${esc(r.tm)}</td><td>${esc(r.pos)}</td><td class="num">${r.gp}</td><td class="num">${r.g ?? ''}</td><td class="num">${r.a ?? ''}</td><td class="num"><b>${r.pts}</b></td></tr>`).join('');

  const faq = [
    ['How are these NHL predictions made?', `Every team has an Elo rating that starts from last season's results and moves after every game: beating a strong team, or winning by more goals, raises it more. Each game's win probability comes from the gap between the two ratings, plus a home-ice edge and a penalty for a team on the second night of a back-to-back. The full app also adjusts for tonight's lineups and for shot-quality luck, so its numbers can differ by a few points.`],
    ['How accurate are the predictions?', acc != null ? `This season the base model has picked the winner in ${ok} of ${scored.length} scored games (${acc}%). Hockey is close to a coin flip on any given night — even the best models rarely get past 60% over a full season.` : `The model's season record appears here once enough games have been played. Hockey is close to a coin flip on any given night — even the best models rarely get past 60% over a full season.`],
    ['When are the predictions updated?', `Scores are refreshed every hour. Ratings, standings and the schedule get a full refresh at midnight and 6 PM Eastern, and projected lineups shortly after.`],
    ['Is this betting advice?', `No. ${BRAND} is a free fan project for fun and hockey pools. Win probabilities are estimates, not guarantees, and nothing here is a recommendation to bet.`],
    ['Can I run a hockey pool with my friends?', `Yes — ${BRAND} has a free NHL playoff pool. Start one, share the 6-digit pool code, and everyone picks 2 centres, 2 left wings, 2 right wings, 4 defencemen, 2 goalies and 5 teams. The leaderboard updates automatically.`],
  ];
  const updated = (gamesF && gamesF.updated) || today;
  const title = `NHL Predictions Today (${shortDate(day1 || today)}) – Win Probabilities for Every Game | ${BRAND}`;
  const desc = `Free NHL predictions for ${day1 === today ? 'tonight' : shortDate(day1 || today)}: win probabilities for all ${l1.length || ''} games, last night's results, ${seasonName} standings and points leaders. Updated daily.`.replace(/all  games/, 'every game');
  const ld = [
    { '@context': 'https://schema.org', '@type': 'WebPage', name: 'NHL Predictions Today', url: SITE + '/nhl-predictions', dateModified: updated, isPartOf: { '@type': 'WebSite', name: BRAND, url: SITE + '/' } },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: BRAND, item: SITE + '/' }, { '@type': 'ListItem', position: 2, name: 'NHL Predictions Today', item: SITE + '/nhl-predictions' }] },
  ];

  const body = `
<header class="top"><a class="brand" href="/">🏒 ${BRAND}</a><nav><a href="/">Open the app</a><a href="/nhl-playoff-pool">Playoff pool</a></nav></header>
<main>
<p class="crumb"><a href="/">${BRAND}</a> › NHL Predictions Today</p>
<h1>NHL Predictions Today</h1>
<p class="lede">Win probabilities for every NHL game ${day1 === today ? 'tonight' : 'on the next game day'}, <b>${esc(longDate(day1 || today))}</b>. ${top ? `Biggest favourite: <b>${esc(nm(fav(top)))}</b> at ${pct(Math.max(top.p, 1 - top.p))}.` : ''} ${acc != null ? `The model has picked ${acc}% of winners this season.` : ''}</p>
<p class="cta"><a class="btn" href="/">See full predictions, lineups &amp; charts →</a></p>

<h2>${day1 === today ? `Tonight's NHL Games · ${esc(shortDate(day1))}` : `NHL Games ${esc(d1label)}`}</h2>
${gamesTable(l1)}
${day2 ? `<h2>NHL Games ${esc(shortDate(day2))}</h2>${gamesTable(l2)}` : ''}

${lastNight ? `<h2>Last Night's NHL Results · ${esc(shortDate(lastNight))}</h2>
<div class="scroll"><table><thead><tr><th>Final score</th><th>Our pick</th><th>Result</th></tr></thead><tbody>${resRows}</tbody></table></div>` : ''}

<h2>NHL Standings ${esc(seasonName)}</h2>
<div class="grid">${divTables}</div>

<h2>NHL Points Leaders</h2>
<div class="scroll"><table><thead><tr><th class="num">#</th><th>Player</th><th>Team</th><th>Pos</th><th class="num">GP</th><th class="num">G</th><th class="num">A</th><th class="num">PTS</th></tr></thead><tbody>${leadRows}</tbody></table></div>

<h2>How Our NHL Predictions Work</h2>
<p>${esc(faq[0][1])}</p>

<h2>Frequently Asked Questions</h2>
${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}

<div class="card promo"><h3>Start a free NHL playoff pool</h3><p>Pick players and teams, share a code with friends or the office, and watch the leaderboard update itself.</p><a class="btn" href="/nhl-playoff-pool">How the pool works →</a></div>
</main>
<footer><span>Data from Hockey-Reference (official NHL data). Updated ${esc(updated)}.</span> <span>${BRAND} is an independent fan site, not affiliated with the NHL or any team.</span> <a href="/legal">Legal Disclaimer</a></footer>`;

  return page({ title, desc, path: '/nhl-predictions', ld, body });
}

export function page({ title, desc, path, ld, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}${path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#11151b">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og-image.png">
${(ld || []).map(o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n')}
<style>
:root{--bg:#11151b;--card:#1a2029;--soft:#232a35;--line:#2e3642;--ink:#e8ecf2;--ink2:#b5bdc9;--muted:#7f8a99;--acc:#6f9bff;--ok:#51cf66;--bad:#ff6b6b;--gold:#e9bd3f;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--acc)}.top{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap;gap:8px}
.brand{font-weight:800;font-size:19px;color:var(--ink);text-decoration:none}.top nav a{margin-left:16px;color:var(--ink2);text-decoration:none;font-size:14px}.top nav a:hover{color:var(--ink)}
main{max-width:980px;margin:0 auto;padding:12px 20px 40px}h1{font-size:34px;line-height:1.15;margin:8px 0 10px}h2{font-size:22px;margin:34px 0 10px;padding-top:6px;border-top:1px solid var(--line)}h3{margin:0 0 8px;font-size:16px}
.crumb{color:var(--muted);font-size:13px;margin:6px 0 0}.crumb a{color:var(--muted)}.lede{font-size:17px;color:var(--ink2);max-width:760px}.muted{color:var(--muted)}
.btn{display:inline-block;background:linear-gradient(180deg,#fff4c2,var(--gold));color:#3a2a00;font-weight:800;padding:10px 18px;border-radius:999px;text-decoration:none}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14.5px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:600;font-size:12.5px;text-transform:uppercase;letter-spacing:.03em}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}td.tm{color:var(--ink2)}.pick{font-weight:700}.tag{font-size:11.5px;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:1px 6px;margin-left:4px}
.ok{color:var(--ok);font-weight:700}.bad{color:var(--bad);font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.card table{font-size:14px}.promo{margin-top:34px}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0}summary{cursor:pointer;font-weight:700}details p{color:var(--ink2);margin:8px 0 2px}
footer{border-top:1px solid var(--line);padding:16px 20px;color:var(--muted);font-size:13px;display:flex;gap:14px;flex-wrap:wrap;justify-content:center}footer a{color:var(--ink2)}
@media(max-width:520px){h1{font-size:28px}.grid{grid-template-columns:1fr}th,td{padding:7px 6px}}
</style>
</head>
<body>${body}</body>
</html>`;
}

export function sitemap() {
  const today = etDate(0);
  const urls = [['/', today, 'hourly', '1.0'], ['/nhl-predictions', today, 'hourly', '0.9'], ['/nhl-playoff-pool', '2026-11-09', 'weekly', '0.8'], ['/pools', '2026-11-09', 'weekly', '0.6'], ['/legal', '2026-11-09', 'yearly', '0.2']];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, d, f, pr]) => `  <url><loc>${SITE}${p}</loc><lastmod>${d}</lastmod><changefreq>${f}</changefreq><priority>${pr}</priority></url>`).join('\n')}
</urlset>
`;
}
