'use strict';
const POINT_VALUE = { NQ: 20, MNQ: 2 };
const MISTAKES = ['כניסה מוקדמת', 'כניסה מאוחרת / רדיפה', 'יציאה מוקדמת', 'עסקה של אדמין / קהילה',
  'מסחר נקמה', 'מסחר יתר', 'נגד המגמה', 'בלי סטאפ ברור'];
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const SCORE = [
  ['setup', 'סטאפ מהאסטרטגיה שלי', 25],
  ['risk', 'סיכון בגבול המותר, מחושב מראש', 20],
  ['stop', 'סטופ מוגדר מראש ולא הוזז אחורה', 20],
  ['noadd', 'לא הוספתי חוזים למפסידה', 15],
  ['calm', 'כניסה רגועה, לא מתוך FOMO או נקמה', 10],
  ['exit', 'יציאה לפי התוכנית', 10],
];
const CHECKLIST = ['מצב רגשי 6 ומעלה', 'ישנתי ואכלתי', 'לייבים, קבוצות וטלגרם סגורים', 'נעילה יומית מוגדרת בפלטפורמה',
  'רמות ותרחישים מסומנים', 'יודע איזה סטאפ אני מחכה לו', '"המטרה היום היא 100/100, לא כסף"'];
const LIVE_ITEM = 2;
const DEFAULTS = { phase: '1', start: '', risk: 50, maxLoss: 200, target: 200 };
let S = { ...DEFAULTS };
try { S = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tj-settings') || '{}') }; } catch {}
const RULES = () => [
  `סיכון לעסקה: מקסימום $${S.risk}, מחושב לפני הכניסה.`,
  'מקסימום 2 הפסדים ביום. אחרי השני סוגרים את הפלטפורמה.',
  `הפסד יומי מקסימלי: $${S.maxLoss}, עם נעילה אוטומטית בפלטפורמה.`,
  'אסור להוסיף חוזים לעסקה מפסידה. אף פעם.',
  'לא מזיזים סטופ אחורה.',
  'מקסימום 3 עסקאות ביום.',
  `הגעתי ל־+$${S.target}? מסיים את היום.`,
  'רק סטאפים מהאסטרטגיה שלי, לא עסקאות של אדמינים.',
  'בלי לייבים וקהילות בזמן הסשן.',
  'מצב רגשי מתחת ל־6 מתוך 10? לא סוחר היום.',
];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};
const localDate = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/* ---------- storage ---------- */
let db;
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('trading-journal', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('trades')) d.createObjectStore('trades', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('days')) d.createObjectStore('days', { keyPath: 'date' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function store(name, mode, fn) {
  return new Promise((res, rej) => {
    const tx = db.transaction(name, mode);
    const out = fn(tx.objectStore(name));
    tx.oncomplete = () => res(out && out.result);
    tx.onerror = () => rej(tx.error);
  });
}
const put = (name, v) => store(name, 'readwrite', s => s.put(v));

/* ---------- calculations ---------- */
function calc(t) {
  const sign = t.dir === 'long' ? 1 : -1;
  const pv = POINT_VALUE[t.symbol] || 2;
  const pts = (t.exit - t.entry) * sign;
  const pnl = pts * t.qty * pv - (t.fees || 0);
  const hasStop = t.stop != null && t.stop !== t.entry;
  const riskPts = hasStop ? Math.abs(t.entry - t.stop) : null;
  const risk = hasStop ? riskPts * t.qty * pv : null;
  const r = hasStop ? pts / riskPts : null;
  const rr = hasStop && t.target != null ? Math.abs(t.target - t.entry) / riskPts : null;
  return { pts, pnl, riskPts, risk, r, rr };
}
const scoreOf = t => SCORE.reduce((s, [k, , p]) => s + (t.score && t.score[k] ? p : 0), 0);
const money = v => (v < 0 ? '−' : v > 0 ? '+' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const num = (v, d = 2) => v == null || !isFinite(v) ? '—' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
const cls = v => v > 0 ? 'pos-mark' : v < 0 ? 'neg-mark' : '';
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const byTime = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));

/* ---------- state ---------- */
let trades = [];
let days = new Map();
let editing = null;
let images = [];
let openDetail = null;

function analyzeDay(date) {
  const ts = trades.filter(t => t.date === date).sort(byTime);
  const day = days.get(date);
  const broken = new Set();
  let losses = 0, cum = 0;
  ts.forEach(t => {
    const c = calc(t), sc = t.score || {};
    if (losses >= 2) broken.add(2);
    if (cum >= S.target) broken.add(7);
    if (c.risk == null || c.risk > S.risk + 0.001) broken.add(1);
    if (!sc.noadd) broken.add(4);
    if (!sc.stop) broken.add(5);
    if (!sc.setup) broken.add(8);
    if (c.pnl < 0) losses++;
    cum += c.pnl;
  });
  if (cum < -S.maxLoss) broken.add(3);
  if (ts.length > 3) broken.add(6);
  if (ts.length && day) {
    if (day.mood != null && day.mood < 6) broken.add(10);
    if (day.checklist && !day.checklist[LIVE_ITEM]) broken.add(9);
  }
  return { date, n: ts.length, losses, pnl: cum, score: avg(ts.map(scoreOf)), broken: [...broken].sort((a, b) => a - b), day };
}
function inRange(date) {
  const from = $('#f-from').value, to = $('#f-to').value;
  return (!from || date >= from) && (!to || date <= to);
}
function filtered() {
  const setup = $('#f-setup').value, res = $('#f-result').value;
  return trades.filter(t => {
    const p = calc(t).pnl;
    return inRange(t.date) && (!setup || t.setup === setup) && (!res || (res === 'win' ? p > 0 : p <= 0));
  }).sort(byTime);
}
const tradingDays = () => [...new Set(trades.map(t => t.date))].sort();

/* ---------- today ---------- */
function loadDayForm() {
  const date = $('#d-date').value;
  const d = days.get(date) || {};
  $('#d-mood').value = d.mood ?? '';
  $('#d-learned').value = d.learned || '';
  $$('#d-check input').forEach((i, n) => { i.checked = !!(d.checklist && d.checklist[n]); });
  $('#d-saved').textContent = '';
}
function renderToday() {
  const date = $('#d-date').value;
  const a = analyzeDay(date);
  const tiles = [
    ['עסקאות', `${a.n} / 3`], ['הפסדים', `${a.losses} / 2`],
    ['רווח/הפסד', money(a.pnl), cls(a.pnl)], ['ציון ממוצע', a.score == null ? '—' : a.score.toFixed(0)],
  ];
  $('#d-tiles').replaceChildren(...tiles.map(tile));
  const rules = RULES();
  $('#d-rules').replaceChildren(...rules.map((r, i) => {
    const bad = a.broken.includes(i + 1);
    return el('li', { className: bad ? 'broken' : 'ok' }, el('span', { className: 'st', textContent: bad ? '✗ נשבר' : '✓' }), el('span', { textContent: r }));
  }));
  const lock = $('#lock');
  const mood = Number($('#d-mood').value);
  let msg = '';
  if (date === localDate()) {
    if ($('#d-mood').value && mood < 6) msg = 'מצב רגשי מתחת ל־6. לא סוחר היום.';
    else if (a.losses >= 2) msg = 'הפסד שני. סוגר את הפלטפורמה, היום נגמר.';
    else if (a.pnl <= -S.maxLoss) msg = 'הגעת להפסד היומי המקסימלי. היום נגמר.';
    else if (a.pnl >= S.target) msg = 'הגעת ליעד היומי. מסיים את היום.';
    else if (a.n >= 3) msg = '3 עסקאות היום. מסיים את היום.';
  }
  lock.hidden = !msg; lock.textContent = msg;

  const all = [...new Set([...tradingDays(), ...days.keys()])].sort().reverse();
  $('#days-table tbody').replaceChildren(...all.map(d => {
    const x = analyzeDay(d);
    const td = (text, c = '') => el('td', { className: c, textContent: text });
    const row = el('tr', {}, td(d, 'num'), td(x.day && x.day.mood != null ? String(x.day.mood) : '—', 'num'), td(String(x.n), 'num'),
      td(x.score == null ? '—' : x.score.toFixed(0), 'num'), td(money(x.pnl), 'num ' + cls(x.pnl)),
      td(x.broken.length ? x.broken.join(', ') : x.n ? 'אין' : '—'), td((x.day && x.day.learned) || '—', 'wrap'));
    row.style.cursor = 'pointer';
    row.onclick = () => { $('#d-date').value = d; loadDayForm(); renderToday(); scrollTo({ top: 0, behavior: 'smooth' }); };
    return row;
  }));
}
const tile = ([k, v, c]) => el('div', { className: 'tile' }, el('div', { className: 'k', textContent: k }),
  el('div', { className: 'v num ' + (c || ''), textContent: v }));

/* ---------- dashboard ---------- */
function kv(rows) {
  const dl = el('dl', { className: 'kv' });
  rows.forEach(([k, v, c]) => dl.append(el('dt', { textContent: k }), el('dd', { className: c || '', textContent: v })));
  return dl;
}
function renderPhase() {
  const ds = tradingDays().filter(d => !S.start || d >= S.start).map(analyzeDay);
  const ts = trades.filter(t => !S.start || t.date >= S.start);
  const score = avg(ts.map(scoreOf));
  const riskBreaks = ds.reduce((s, d) => s + d.broken.filter(b => b <= 4).length, 0);
  const box = $('#phase');
  $('#phase-title').textContent = 'התקדמות בשלב ' + S.phase;
  if (S.phase === '1') {
    const bar = el('div', { className: 'progress' }, el('div'));
    bar.firstChild.style.width = Math.min(100, ds.length / 10 * 100) + '%';
    const ready = ds.length >= 10 && score >= 90 && riskBreaks === 0;
    box.replaceChildren(el('div', { textContent: `ימי מסחר: ${ds.length} מתוך 10` }), bar, kv([
      ['ציון ממוצע (יעד: 90+)', score == null ? '—' : score.toFixed(0), score != null && score < 90 ? 'warn' : ''],
      ['שבירות של חוקי הסיכון 1–4 (יעד: 0)', String(riskBreaks), riskBreaks ? 'warn' : ''],
      ['תנאי מעבר לשלב 2', ready ? 'הושגו' : 'עדיין לא'],
    ]), el('p', { className: 'muted', textContent: 'הרווח לא משנה בשלב הזה.' }));
  } else {
    box.replaceChildren(kv([
      ['ימי מסחר בשלב', String(ds.length)],
      ['ציון ממוצע', score == null ? '—' : score.toFixed(0)],
      ['שבירות של חוקי הסיכון 1–4', String(riskBreaks), riskBreaks ? 'warn' : ''],
      ['ימים שעמדו בכל החוקים', `${ds.filter(d => !d.broken.length).length} מתוך ${ds.length}`],
    ]));
  }
}
function renderWeek() {
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - now.getDay());
  const from = localDate(start);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  const to = localDate(end);
  const ds = tradingDays().filter(d => d >= from && d <= to).map(analyzeDay);
  const ts = trades.filter(t => t.date >= from && t.date <= to);
  const box = $('#week');
  if (!ts.length) { box.replaceChildren(el('p', { className: 'muted', textContent: `אין עסקאות השבוע (${from} עד ${to}).` })); return; }
  const counts = {};
  ds.forEach(d => d.broken.forEach(b => { counts[b] = (counts[b] || 0) + 1; }));
  const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const best = [...ts].sort((a, b) => scoreOf(b) - scoreOf(a) || byTime(a, b))[0];
  box.replaceChildren(kv([
    ['שבוע', `${from} עד ${to}`],
    ['ציון ממוצע', avg(ts.map(scoreOf)).toFixed(0)],
    ['ימים שעמדתי בכל החוקים', `${ds.filter(d => !d.broken.length).length} מתוך ${ds.length}`],
    ['החוק שנשבר הכי הרבה', worst ? `חוק ${worst[0]} (${worst[1]} ימים): ${RULES()[worst[0] - 1]}` : 'אף חוק לא נשבר'],
    ['העסקה הכי טובה בביצוע', `${best.date} ${best.time || ''} · ${best.setup || 'ללא סטאפ'} · ציון ${scoreOf(best)}`],
    ['רווח/הפסד', money(ts.reduce((s, t) => s + calc(t).pnl, 0)), 'num'],
  ]));
}
function renderTiles(list) {
  const c = list.map(calc);
  const wins = c.filter(x => x.pnl > 0), losses = c.filter(x => x.pnl < 0);
  const sum = a => a.reduce((s, x) => s + x.pnl, 0);
  const net = sum(c), gw = sum(wins), gl = -sum(losses);
  const rs = c.filter(x => x.r != null).map(x => x.r);
  let peak = 0, eq = 0, dd = 0;
  c.forEach(x => { eq += x.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); });
  const sc = avg(list.map(scoreOf));
  $('#tiles').replaceChildren(...[
    ['ציון ממוצע', sc == null ? '—' : sc.toFixed(0)],
    ['עסקאות 100/100', list.length ? `${list.filter(t => scoreOf(t) === 100).length} / ${list.length}` : '—'],
    ['רווח/הפסד נקי', money(net), cls(net)],
    ['אחוז הצלחה', list.length ? (wins.length / list.length * 100).toFixed(0) + '%' : '—'],
    ['פרופיט פקטור', gl ? num(gw / gl) : '—'],
    ['R ממוצע', rs.length ? num(avg(rs)) + 'R' : '—'],
    ['רווח ממוצע', wins.length ? money(gw / wins.length) : '—'],
    ['הפסד ממוצע', losses.length ? money(-gl / losses.length) : '—'],
    ['דרואודאון מקסימלי', dd ? money(-dd) : '—'],
  ].map(tile));
}

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
function lineChart(box, pts, opts) {
  if (!pts.length) { box.replaceChildren(el('p', { className: 'muted', textContent: 'אין נתונים להצגה.' })); return; }
  const W = 900, H = 260, L = 64, R = 16, T = 12, B = 26;
  let lo = opts.lo ?? Math.min(...pts.map(p => p.y)), hi = opts.hi ?? Math.max(...pts.map(p => p.y));
  if (opts.lo == null) { if (lo === hi) { lo -= 1; hi += 1; } const pad = (hi - lo) * 0.08; lo -= pad; hi += pad; }
  const X = i => L + (pts.length === 1 ? (W - L - R) / 2 : i / (pts.length - 1) * (W - L - R));
  const Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label });
  const step = opts.step || niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: v === opts.ref ? 'var(--muted)' : 'var(--grid)', 'stroke-width': 1 }));
    const tx = svgEl('text', { x: L - 8, y: Y(v) + 4, 'text-anchor': 'end' }); tx.textContent = opts.fmt(v); svg.append(tx);
  }
  const first = svgEl('text', { x: L, y: H - 6 }); first.textContent = opts.first; svg.append(first);
  const last = svgEl('text', { x: W - R, y: H - 6, 'text-anchor': 'end' }); last.textContent = opts.last; svg.append(last);
  svg.append(svgEl('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + X(i) + ' ' + Y(p.y)).join(' '), fill: 'none',
    stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  if (pts.length <= 40) pts.forEach((p, i) => svg.append(svgEl('circle', { cx: X(i), cy: Y(p.y), r: 4, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2 })));
  const cross = svgEl('line', { y1: T, y2: H - B, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross);
  svg.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * W;
    const i = pts.length === 1 ? 0 : Math.max(0, Math.min(pts.length - 1, Math.round((x - L) / (W - L - R) * (pts.length - 1))));
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
    showTip(e, pts[i].tip);
  });
  svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  box.replaceChildren(svg);
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f > 5 ? 10 : f > 2 ? 5 : f > 1 ? 2 : 1) * p;
}
function renderEquity(list) {
  let eq = 0;
  const pts = list.length ? [{ y: 0, tip: 'התחלה · $0' }, ...list.map(t => { const p = calc(t).pnl; eq += p;
    return { y: eq, tip: `${t.date} · עסקה ${money(p)} · מצטבר ${money(eq)}` }; })] : [];
  lineChart($('#equity'), pts, { label: 'עקומת הון', ref: 0, fmt: v => '$' + v.toLocaleString('en-US'),
    first: list.length ? list[0].date : '', last: list.length ? list[list.length - 1].date : '' });
}
function renderScores() {
  const ds = tradingDays().filter(inRange).map(analyzeDay);
  lineChart($('#scores'), ds.map(d => ({ y: d.score, tip: `${d.date} · ציון ${d.score.toFixed(0)} · ${d.n} עסקאות · ${d.broken.length ? 'נשברו חוקים: ' + d.broken.join(', ') : 'כל החוקים נשמרו'}` })),
    { label: 'ציון משמעת יומי', lo: 0, hi: 100, step: 25, ref: 100, fmt: v => String(v),
      first: ds.length ? ds[0].date : '', last: ds.length ? ds[ds.length - 1].date : '' });
}
function showTip(e, text) {
  const t = $('#tip'); t.textContent = text; t.hidden = false;
  const w = t.offsetWidth;
  t.style.left = Math.max(4, Math.min(innerWidth - w - 4, e.clientX - w / 2)) + 'px';
  t.style.top = (e.clientY - 40) + 'px';
}
const hideTip = () => { $('#tip').hidden = true; };

function renderBars(sel, list, keysOf, order) {
  const groups = new Map();
  list.forEach(t => keysOf(t).forEach(k => {
    const g = groups.get(k) || { n: 0, pnl: 0, wins: 0 };
    const p = calc(t).pnl; g.n++; g.pnl += p; if (p > 0) g.wins++;
    groups.set(k, g);
  }));
  let rows = [...groups.entries()];
  rows = order ? rows.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])) : rows.sort((a, b) => b[1].pnl - a[1].pnl);
  const box = $(sel);
  if (!rows.length) { box.replaceChildren(el('p', { className: 'muted', textContent: 'אין נתונים להצגה.' })); return; }
  const max = Math.max(...rows.map(r => Math.abs(r[1].pnl))) || 1;
  const wrap = el('div', { className: 'bars' });
  rows.forEach(([k, g]) => {
    const bar = el('div', { className: 'bar ' + (g.pnl >= 0 ? 'p' : 'n') });
    bar.style.width = Math.abs(g.pnl) / max * 50 + '%';
    const track = el('div', { className: 'track' }, bar);
    const tipText = `${k}: ${money(g.pnl)} · ${g.n} עסקאות · ${(g.wins / g.n * 100).toFixed(0)}% הצלחה`;
    track.addEventListener('pointermove', e => showTip(e, tipText));
    track.addEventListener('pointerleave', hideTip);
    wrap.append(el('div', { textContent: k }), track,
      el('div', {}, el('span', { className: 'num', textContent: money(g.pnl) }),
        el('span', { className: 'sub', textContent: ` · ${g.n} · ${(g.wins / g.n * 100).toFixed(0)}%` })));
  });
  box.replaceChildren(wrap);
}

/* ---------- trades table ---------- */
function renderTable(list) {
  const body = $('#trades-table tbody');
  body.replaceChildren();
  $('#empty').hidden = list.length > 0;
  [...list].reverse().forEach(t => {
    const c = calc(t);
    const td = (text, c2 = '') => el('td', { className: c2, textContent: text });
    const actions = el('td', {},
      el('button', { className: 'link', textContent: 'פרטים', onclick: () => { openDetail = openDetail === t.id ? null : t.id; render(); } }),
      el('button', { className: 'link', textContent: 'עריכה', onclick: () => openForm(t) }),
      el('button', { className: 'link', textContent: 'מחיקה', onclick: async () => {
        if (confirm('למחוק את העסקה?')) { await store('trades', 'readwrite', s => s.delete(t.id)); await refresh(); } } }));
    body.append(el('tr', {},
      td(t.date + (t.time ? ' ' + t.time : ''), 'num'), td(t.symbol, 'ltr'), td(t.dir === 'long' ? 'לונג' : 'שורט'),
      td(String(t.qty), 'num'), td(num(t.entry), 'num'), td(num(t.exit), 'num'), td(num(c.pts), 'num'),
      td(money(c.pnl), 'num ' + cls(c.pnl)), td(c.r == null ? '—' : num(c.r) + 'R', 'num'), td(String(scoreOf(t)), 'num'),
      td(t.setup || '—'), td((t.mistakes || []).join(', ') || '—'), actions));
    if (openDetail === t.id) {
      const cell = el('td', { colSpan: 13 });
      const line = (k, v) => v ? cell.append(el('p', {}, el('b', { textContent: k + ': ' }), v)) : null;
      line('סטופ / יעד', `${num(t.stop)} / ${num(t.target)}`);
      line('סיכון', c.risk == null ? '' : `${money(-c.risk)} (${num(c.riskPts)} נק׳)` + (c.rr == null ? '' : ` · יחס מתוכנן 1:${num(c.rr)}`));
      line('נקודות שירדו בציון', SCORE.filter(([k]) => !(t.score && t.score[k])).map(([, l, p]) => `${l} (−${p})`).join(' · '));
      line('מצב רגשי', t.emotion); line('מה הרגשתי', t.notes); line('לקח', t.lesson);
      if (t.images && t.images.length) cell.append(el('div', { className: 'thumbs' }, ...t.images.map(thumb)));
      body.append(el('tr', { className: 'detail' }, cell));
    }
  });
}
function thumb(src) {
  return el('figure', {}, el('img', { src, alt: 'צילום מסך', onclick: () => { $('#viewer-img').src = src; $('#viewer').showModal(); } }));
}

/* ---------- form ---------- */
function openForm(t) {
  editing = t || null;
  const f = $('#form'); f.reset();
  $('#dlg-title').textContent = t ? 'עריכת עסקה' : 'עסקה חדשה';
  const v = t || { date: localDate(), time: new Date().toTimeString().slice(0, 5), symbol: 'MNQ', dir: 'long', qty: 1, fees: 0,
    score: {}, mistakes: [], images: [] };
  for (const k of ['date', 'time', 'symbol', 'dir', 'qty', 'fees', 'entry', 'stop', 'target', 'exit', 'setup', 'emotion', 'notes', 'lesson'])
    f.elements[k].value = v[k] ?? '';
  $$('#score input').forEach(i => { i.checked = !!(v.score && v.score[i.value]); });
  $$('#mistakes input').forEach(i => { i.checked = (v.mistakes || []).includes(i.value); });
  images = [...(v.images || [])];
  renderThumbs(); updateCalc();
  $('#dlg').showModal();
}
function readForm() {
  const f = $('#form').elements;
  const n = k => f[k].value === '' ? null : Number(f[k].value);
  return {
    id: editing ? editing.id : (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    date: f.date.value, time: f.time.value, symbol: f.symbol.value, dir: f.dir.value,
    qty: n('qty') || 1, fees: n('fees') || 0, entry: n('entry'), stop: n('stop'), target: n('target'), exit: n('exit'),
    setup: f.setup.value.trim(), emotion: f.emotion.value,
    score: Object.fromEntries($$('#score input').map(i => [i.value, i.checked])),
    mistakes: $$('#mistakes input:checked').map(i => i.value),
    notes: f.notes.value.trim(), lesson: f.lesson.value.trim(), images,
  };
}
function updateCalc() {
  const t = readForm(), box = $('#calc');
  box.replaceChildren();
  const add = (k, v, c = '') => box.append(el('span', { className: c }, k + ' ', el('b', { className: 'num', textContent: v })));
  const c = calc(t);
  if (t.entry != null && c.risk != null) {
    const over = c.risk > S.risk + 0.001;
    add('סיכון:', `${money(-c.risk)} (${num(c.riskPts)} נק׳)` + (over ? ` — מעל המותר ($${S.risk})` : ''), over ? 'warn' : '');
  }
  if (c.rr != null) add('יחס מתוכנן:', '1:' + num(c.rr));
  if (t.entry != null && t.exit != null) { add('תוצאה:', `${money(c.pnl)} (${num(c.pts)} נק׳)`); if (c.r != null) add('R:', num(c.r) + 'R'); }
  $('#score-total').textContent = scoreOf(t) + ' / 100';
}
function renderThumbs() {
  $('#thumbs').replaceChildren(...images.map((src, i) => {
    const fig = thumb(src);
    fig.append(el('button', { type: 'button', textContent: '×', title: 'הסר', onclick: () => { images.splice(i, 1); renderThumbs(); } }));
    return fig;
  }));
}
function compress(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = el('canvas', { width: Math.round(img.width * k), height: Math.round(img.height * k) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

/* ---------- backup ---------- */
function download(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function toCsv(list) {
  const head = ['date', 'time', 'symbol', 'direction', 'contracts', 'entry', 'stop', 'target', 'exit', 'fees', 'points', 'pnl', 'R',
    'score', 'setup', 'emotion', 'mistakes', 'notes', 'lesson'];
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = list.map(t => { const c = calc(t); return [t.date, t.time, t.symbol, t.dir, t.qty, t.entry, t.stop, t.target, t.exit, t.fees,
    c.pts, c.pnl.toFixed(2), c.r == null ? '' : c.r.toFixed(2), scoreOf(t), t.setup, t.emotion,
    (t.mistakes || []).join('; '), t.notes, t.lesson].map(q).join(','); });
  return '﻿' + [head.join(','), ...rows].join('\r\n');
}

/* ---------- render ---------- */
function render() {
  const setups = [...new Set(trades.map(t => t.setup).filter(Boolean))].sort();
  const fs = $('#f-setup'), cur = fs.value;
  fs.replaceChildren(el('option', { value: '', textContent: 'הכול' }), ...setups.map(s => el('option', { value: s, textContent: s })));
  fs.value = setups.includes(cur) ? cur : '';
  $('#setups').replaceChildren(...setups.map(s => el('option', { value: s })));
  $('#rules-list').replaceChildren(...RULES().map(r => el('li', { textContent: r })));
  const list = filtered();
  renderToday(); renderPhase(); renderWeek(); renderTiles(list); renderScores(); renderEquity(list);
  renderBars('#by-plan', list, t => [scoreOf(t) === 100 ? '100/100' : 'שברו חוק'], ['100/100', 'שברו חוק']);
  renderBars('#by-setup', list, t => [t.setup || 'ללא סטאפ']);
  renderBars('#by-mistake', list, t => t.mistakes && t.mistakes.length ? t.mistakes : ['ללא טעויות']);
  renderBars('#by-emotion', list, t => [t.emotion || 'לא צוין']);
  renderBars('#by-day', list, t => [DAYS[new Date(t.date + 'T12:00').getDay()]], DAYS);
  renderTable(list);
}
async function refresh() {
  trades = await store('trades', 'readonly', s => s.getAll());
  days = new Map((await store('days', 'readonly', s => s.getAll())).map(d => [d.date, d]));
  render();
}

async function init() {
  db = await openDb();
  $('#score').replaceChildren(...SCORE.map(([k, l, p]) => el('label', {}, el('input', { type: 'checkbox', value: k }), l,
    el('span', { className: 'pts num', textContent: String(p) }))));
  $('#d-check').replaceChildren(...CHECKLIST.map(c => el('label', {}, el('input', { type: 'checkbox' }), c)));
  $('#mistakes').replaceChildren(...MISTAKES.map(m => el('label', {}, el('input', { type: 'checkbox', value: m }), m)));
  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
    $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + b.dataset.view; });
    $('#filters').hidden = !['dashboard', 'trades'].includes(b.dataset.view);
  }));
  $$('#filters input, #filters select').forEach(i => i.addEventListener('change', render));
  $('#f-clear').onclick = () => { $$('#filters input, #filters select').forEach(i => { i.value = ''; }); render(); };

  $('#d-date').value = localDate();
  $('#d-date').addEventListener('change', () => { loadDayForm(); renderToday(); });
  $('#d-mood').addEventListener('input', renderToday);
  $('#d-save').onclick = async () => {
    const mood = $('#d-mood').value === '' ? null : Math.max(1, Math.min(10, Number($('#d-mood').value)));
    await put('days', { date: $('#d-date').value, mood, checklist: $$('#d-check input').map(i => i.checked), learned: $('#d-learned').value.trim() });
    await refresh();
    $('#d-saved').textContent = 'נשמר';
  };

  for (const k of Object.keys(DEFAULTS)) {
    const input = $('#s-' + k);
    input.value = S[k];
    input.addEventListener('change', () => {
      S[k] = input.type === 'number' ? (Number(input.value) || DEFAULTS[k]) : input.value;
      localStorage.setItem('tj-settings', JSON.stringify(S));
      render();
    });
  }

  $('#btn-new').onclick = () => openForm();
  $('#btn-cancel').onclick = () => $('#dlg').close();
  $('#form').addEventListener('input', updateCalc);
  $('#form').addEventListener('submit', async e => {
    e.preventDefault();
    await put('trades', readForm());
    $('#dlg').close();
    await refresh();
  });
  $('#in-img').addEventListener('change', async e => {
    for (const f of e.target.files) images.push(await compress(f));
    e.target.value = ''; renderThumbs();
  });
  $('#viewer').addEventListener('click', () => $('#viewer').close());
  $('#btn-export').onclick = () => download(`trading-journal-${localDate()}.json`,
    JSON.stringify({ version: 2, settings: S, trades, days: [...days.values()] }), 'application/json');
  $('#btn-csv').onclick = () => download('trades.csv', toCsv(filtered()), 'text/csv');
  $('#in-import').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.trades)) throw new Error('bad file');
      const valid = data.trades.filter(t => t && t.id && t.date && t.entry != null && t.exit != null);
      for (const t of valid) await put('trades', t);
      for (const d of (data.days || []).filter(d => d && d.date)) await put('days', d);
      alert(`יובאו ${valid.length} עסקאות.`);
      await refresh();
    } catch { alert('הקובץ אינו קובץ גיבוי תקין.'); }
    e.target.value = '';
  });
  await refresh();
  loadDayForm();
}
init();
