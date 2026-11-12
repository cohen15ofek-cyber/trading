'use strict';
const LEGACY_POINT_VALUE = { NQ: 20, MNQ: 2 };
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const SCORE = [
  ['setup', 'סטאפ מהאסטרטגיה שלי', 25],
  ['risk', 'סיכון בגבול המותר, מחושב מראש', 20],
  ['stop', 'סטופ מוגדר מראש ולא הוזז אחורה', 20],
  ['noadd', 'לא הוספתי חוזים למפסידה', 15],
  ['calm', 'כניסה רגועה, לא מתוך FOMO או נקמה', 10],
  ['exit', 'יציאה לפי התוכנית', 10],
];
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
const DIR = { long: 'לונג', short: 'שורט', neutral: 'ניטרלי' };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};
const localDate = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();

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
// Trades saved by the first version of the journal have prices instead of a typed result.
function legacy(t) {
  if (t.entry == null || t.exit == null) return { pnl: 0, r: null };
  const pts = (t.exit - t.entry) * (t.dir === 'long' ? 1 : -1);
  const pnl = pts * (t.qty || 1) * (LEGACY_POINT_VALUE[t.symbol] || 2) - (t.fees || 0);
  const riskPts = t.stop != null && t.stop !== t.entry ? Math.abs(t.entry - t.stop) : null;
  return { pnl, r: riskPts ? pts / riskPts : null };
}
const pnlOf = t => t.pnl != null ? t.pnl : legacy(t).pnl;
const rOf = t => t.pnl != null ? t.r : legacy(t).r;
const scoreOf = t => SCORE.reduce((s, [k, , p]) => s + (t.score && t.score[k] ? p : 0), 0);
const money = v => (v < 0 ? '−' : v > 0 ? '+' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const num = (v, d = 2) => v == null || !isFinite(v) ? '—' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
const cls = v => v > 0 ? 'pos-mark' : v < 0 ? 'neg-mark' : '';
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
// Reads "103", "-1", "1-", "−1" or "1,250.5". Returns null when empty or not a number.
const parseNum = s => {
  const t = String(s ?? '').replace(/[\s,$\u200e\u200f]/g, '');
  if (!t) return null;
  const neg = /[-\u2212]/.test(t), v = Number(t.replace(/[-\u2212]/g, ''));
  return isFinite(v) && t.replace(/[-\u2212]/g, '') !== '' ? (neg ? -v : v) : NaN;
};
const resultOf = t => { const p = pnlOf(t); return p > 0 ? ['win', 'ניצחון'] : p < 0 ? ['loss', 'הפסד'] : ['be', 'BE']; };
const byTime = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));

/* ---------- state ---------- */
let trades = [];
let days = new Map();
let editing = null;
let images = [];
let openDetail = null;
let scEditing = null;
let scImage = null;

const curDate = () => $('#day').value || localDate();
const dayOf = date => days.get(date) || { date };
async function saveDay(date, patch) {
  const d = { ...dayOf(date), ...patch, date };
  days.set(date, d);
  render();
  await put('days', d);
}

// The check before the session: every rule answered yes -> may trade; any "no" or mood under 6 -> skip the day.
function gateOf(day) {
  const a = day.rules || [];
  const nos = RULES().map((_, i) => i).filter(i => a[i] === false);
  const moodLow = day.mood != null && day.mood < 6;
  const complete = RULES().every((_, i) => a[i] === true || a[i] === false);
  return { nos, moodLow, status: nos.length || moodLow ? 'no' : complete ? 'yes' : 'open' };
}
function analyzeDay(date) {
  const ts = trades.filter(t => t.date === date).sort(byTime);
  const day = dayOf(date);
  const gate = gateOf(day);
  const broken = new Set();
  let losses = 0, cum = 0;
  ts.forEach(t => {
    if (losses >= 2) broken.add(2);
    if (cum >= S.target) broken.add(7);
    if (t.kept === false) (t.broken || []).forEach(b => broken.add(b));
    const p = pnlOf(t);
    if (p < 0) losses++;
    cum += p;
  });
  if (cum < -S.maxLoss) broken.add(3);
  if (ts.length > 3) broken.add(6);
  if (ts.length && gate.status === 'no') {
    gate.nos.forEach(i => broken.add(i + 1));
    if (gate.moodLow) broken.add(10);
  }
  const skipped = !ts.length && gate.status === 'no';
  const flagged = ts.some(t => t.kept === false);
  return { date, n: ts.length, losses, pnl: cum, score: avg(ts.map(scoreOf)), day, gate, skipped,
    broken: [...broken].sort((a, b) => a - b), kept: skipped || (ts.length > 0 && !broken.size && !flagged) };
}
function inRange(date) {
  const from = $('#f-from').value, to = $('#f-to').value;
  return (!from || date >= from) && (!to || date <= to);
}
const filtered = () => trades.filter(t => inRange(t.date)).sort(byTime);
const tradingDays = () => [...new Set(trades.map(t => t.date))].sort();
// Days that count for the process: days with trades, and days that were skipped because of the rules.
const processDays = () => [...new Set([...tradingDays(), ...[...days.keys()].filter(d => analyzeDay(d).skipped)])].sort();

/* ---------- pre-market ---------- */
function loadDayForms() {
  const d = dayOf(curDate());
  $('#bias-text').value = d.biasText || '';
  $('#mood').value = d.mood ?? '';
  $('#feeling').value = d.feeling || '';
  resetScenarioForm();
}
function resetScenarioForm() {
  scEditing = null; scImage = null;
  $('#sc-text').value = '';
  setSeg('#sc-type', 'long');
  $('#sc-title').textContent = 'תרחיש חדש';
  $('#sc-add').textContent = 'הוספת תרחיש';
  $('#sc-cancel').hidden = true;
  renderScPreview();
}
const setSeg = (sel, v) => $$(sel + ' button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v));
const getSeg = sel => { const b = $(sel + ' button[aria-pressed="true"]'); return b ? b.dataset.v : ''; };
function renderScPreview() {
  const box = $('#sc-preview');
  if (!scImage) { box.replaceChildren(); return; }
  const fig = thumb(scImage);
  fig.append(el('button', { type: 'button', textContent: '×', title: 'הסר', onclick: () => { scImage = null; renderScPreview(); } }));
  box.replaceChildren(fig);
}
function renderPre() {
  const date = curDate(), d = dayOf(date);
  setSeg('#bias', d.bias || '');
  const list = d.scenarios || [];
  const setList = next => saveDay(date, { scenarios: next });
  $('#sc-list').replaceChildren(...list.map(s => {
    const body = el('div', { className: 'body' },
      el('span', { className: 'tag ' + s.type, textContent: DIR[s.type] }),
      el('p', { textContent: s.text || '' }),
      el('div', { className: 'foot' },
        el('label', {}, el('input', { type: 'checkbox', checked: !!s.taken,
          onchange: e => setList(list.map(x => x.id === s.id ? { ...x, taken: e.target.checked } : x)) }), 'לקחתי את התרחיש'),
        el('button', { className: 'link', textContent: 'עריכה', onclick: () => {
          scEditing = s.id; scImage = s.image || null;
          $('#sc-text').value = s.text || ''; setSeg('#sc-type', s.type);
          $('#sc-title').textContent = 'עריכת תרחיש'; $('#sc-add').textContent = 'שמירת התרחיש'; $('#sc-cancel').hidden = false;
          renderScPreview(); $('#sc-text').focus();
        } }),
        el('button', { className: 'link', textContent: 'מחיקה', onclick: () => {
          if (confirm('למחוק את התרחיש?')) setList(list.filter(x => x.id !== s.id));
        } })));
    const card = el('div', { className: 'scenario' });
    if (s.image) card.append(el('img', { src: s.image, alt: 'תמונת התרחיש', onclick: () => view(s.image) }));
    card.append(body);
    return card;
  }));
  if (!list.length) $('#sc-list').replaceChildren(el('p', { className: 'muted', textContent: 'עוד לא נכתבו תרחישים ליום הזה.' }));
}

/* ---------- rules ---------- */
function renderRules() {
  const date = curDate(), a = analyzeDay(date), day = a.day;
  const answers = day.rules || [];
  $('#rules-check').replaceChildren(...RULES().map((r, i) => {
    const v = answers[i];
    const set = val => { const next = RULES().map((_, k) => answers[k] ?? null); next[i] = v === val ? null : val; saveDay(date, { rules: next }); };
    return el('li', { className: v === true ? 'yes' : v === false ? 'no' : '' },
      el('span', { className: 'n num', textContent: String(i + 1) }), el('span', { className: 'txt', textContent: r }),
      el('div', { className: 'yn' },
        el('button', { type: 'button', className: 'y', textContent: 'כן', ariaPressed: String(v === true), onclick: () => set(true) }),
        el('button', { type: 'button', className: 'x', textContent: 'לא', ariaPressed: String(v === false), onclick: () => set(false) })));
  }));
  const v = $('#verdict'), g = a.gate;
  const text = {
    yes: ['מותר לסחור היום.', 'סימנת כן על כל החוקים. המטרה היא 100/100, לא כסף.'],
    no: ['היום לא סוחרים.', g.moodLow && !g.nos.length ? 'מצב רגשי מתחת ל־6. לדלג על היום זה לעמוד בחוקים.'
      : 'אם אני סוחר היום, אני עובר על החוקים שלי. לדלג על היום זה לעמוד בחוקים.'],
    open: ['לפני שפותחים את הגרף:', 'סמן כן או לא ליד כל חוק, ותכתוב איך אתה מרגיש.'],
  }[g.status];
  v.className = 'verdict ' + g.status;
  v.replaceChildren(text[0], el('small', { textContent: text[1] }));
  $('#d-tiles').replaceChildren(...[
    ['עסקאות', `${a.n} / 3`], ['הפסדים', `${a.losses} / 2`],
    ['רווח/הפסד', money(a.pnl), cls(a.pnl)], ['ציון ממוצע', a.score == null ? '—' : a.score.toFixed(0)],
  ].map(tile));

  const lock = $('#lock');
  let msg = '';
  if (date === localDate()) {
    if (a.losses >= 2) msg = 'הפסד שני. סוגר את הפלטפורמה, היום נגמר.';
    else if (a.pnl <= -S.maxLoss) msg = 'הגעת להפסד היומי המקסימלי. היום נגמר.';
    else if (a.pnl >= S.target) msg = 'הגעת ליעד היומי. מסיים את היום.';
    else if (a.n >= 3) msg = '3 עסקאות היום. מסיים את היום.';
    else if (a.n && g.status === 'no') msg = 'סימנת שהיום לא סוחרים, ויש עסקאות. עוצר כאן.';
  }
  lock.hidden = !msg; lock.textContent = msg;
  $('#day-name').textContent = 'יום ' + DAYS[new Date(date + 'T12:00').getDay()] + (date === localDate() ? ' · היום' : '');
}
const tile = ([k, v, c]) => el('div', { className: 'tile' }, el('div', { className: 'k', textContent: k }),
  el('div', { className: 'v num ' + (c || ''), textContent: v }));

/* ---------- summary ---------- */
function kv(rows) {
  const dl = el('dl', { className: 'kv' });
  rows.forEach(([k, v, c]) => dl.append(el('dt', { textContent: k }), el('dd', { className: c || '', textContent: v })));
  return dl;
}
const keptText = ds => `${ds.filter(d => d.kept).length} מתוך ${ds.length}`;
function renderPhase() {
  const all = processDays().filter(d => !S.start || d >= S.start).map(analyzeDay);
  const ds = all.filter(d => d.n);
  const score = avg(trades.filter(t => !S.start || t.date >= S.start).map(scoreOf));
  const riskBreaks = ds.reduce((s, d) => s + d.broken.filter(b => b <= 4).length, 0);
  const box = $('#phase');
  $('#phase-title').textContent = 'התקדמות בשלב ' + S.phase;
  const rows = [
    ['ציון ממוצע' + (S.phase === '1' ? ' (יעד: 90+)' : ''), score == null ? '—' : score.toFixed(0), score != null && score < 90 ? 'warn' : ''],
    ['שבירות של חוקי הסיכון 1–4 (יעד: 0)', String(riskBreaks), riskBreaks ? 'warn' : ''],
    ['ימים שעמדתי בחוקים (כולל ימים שדילגתי)', keptText(all)],
  ];
  if (S.phase === '1') {
    const bar = el('div', { className: 'progress' }, el('div'));
    bar.firstChild.style.width = Math.min(100, ds.length / 10 * 100) + '%';
    const ready = ds.length >= 10 && score >= 90 && riskBreaks === 0;
    box.replaceChildren(el('div', { textContent: `ימי מסחר: ${ds.length} מתוך 10` }), bar,
      kv([...rows, ['תנאי מעבר לשלב 2', ready ? 'הושגו' : 'עדיין לא', ready ? 'ok' : '']]),
      el('p', { className: 'muted', textContent: 'הרווח לא משנה בשלב הזה.' }));
  } else box.replaceChildren(kv([['ימי מסחר בשלב', String(ds.length)], ...rows]));
}
function renderWeek() {
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - now.getDay());
  const end = new Date(start); end.setDate(start.getDate() + 6);
  const from = localDate(start), to = localDate(end);
  const ds = processDays().filter(d => d >= from && d <= to).map(analyzeDay);
  const ts = trades.filter(t => t.date >= from && t.date <= to);
  const box = $('#week');
  if (!ds.length) { box.replaceChildren(el('p', { className: 'muted', textContent: `אין עדיין ימים השבוע (${from} עד ${to}).` })); return; }
  const counts = {};
  ds.forEach(d => d.broken.forEach(b => { counts[b] = (counts[b] || 0) + 1; }));
  const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const best = [...ts].sort((a, b) => scoreOf(b) - scoreOf(a) || byTime(a, b))[0];
  box.replaceChildren(kv([
    ['שבוע', `${from} עד ${to}`],
    ['ימים שעמדתי בחוקים', keptText(ds)],
    ['ימים שדילגתי', String(ds.filter(d => d.skipped).length)],
    ['ציון ממוצע', ts.length ? avg(ts.map(scoreOf)).toFixed(0) : '—'],
    ['החוק שנשבר הכי הרבה', worst ? `חוק ${worst[0]} (${worst[1]} ימים): ${RULES()[worst[0] - 1]}` : 'אף חוק לא נשבר'],
    ['העסקה הכי טובה בביצוע', best ? `${best.date} ${best.time || ''} · ${best.symbol} · ציון ${scoreOf(best)}` : '—'],
    ['רווח/הפסד', money(ts.reduce((s, t) => s + pnlOf(t), 0)), 'num'],
  ]));
}
function renderTiles(list) {
  const p = list.map(pnlOf);
  const wins = p.filter(x => x > 0), net = p.reduce((s, x) => s + x, 0);
  const rs = list.map(rOf).filter(x => x != null);
  const sc = avg(list.map(scoreOf));
  const ds = processDays().filter(inRange).map(analyzeDay);
  $('#tiles').replaceChildren(...[
    ['ימים שעמדתי בחוקים', ds.length ? keptText(ds) : '—'],
    ['עסקאות שעמדו בחוקים', list.length ? `${list.filter(t => t.kept !== false).length} / ${list.length}` : '—'],
    ['ציון ממוצע', sc == null ? '—' : sc.toFixed(0)],
    ['רווח/הפסד נקי', money(net), cls(net)],
    ['אחוז הצלחה', list.length ? (wins.length / list.length * 100).toFixed(0) + '%' : '—'],
    ['R ממוצע', rs.length ? num(avg(rs)) + 'R' : '—'],
  ].map(tile));
}
function renderDays() {
  const all = [...new Set([...processDays(), ...days.keys()])].filter(inRange).sort().reverse();
  $('#days-table tbody').replaceChildren(...all.map(d => {
    const x = analyzeDay(d);
    const td = (text, c = '') => el('td', { className: c, textContent: text });
    const row = el('tr', {}, td(d, 'num'), td(x.skipped ? 'דילגתי' : x.n ? 'סחרתי' : '—'),
      td(x.day.mood != null ? String(x.day.mood) : '—', 'num'), td(String(x.n), 'num'),
      td(x.score == null ? '—' : x.score.toFixed(0), 'num'), td(x.n ? money(x.pnl) : '—', 'num ' + cls(x.pnl)),
      td(x.kept ? '✓ עמדתי בחוקים' : x.broken.length ? 'חוק ' + x.broken.join(', ') : x.n ? 'נשבר חוק' : '—', x.kept ? 'ok' : x.n ? 'warn' : ''));
    row.style.cursor = 'pointer';
    row.onclick = () => { $('#day').value = d; loadDayForms(); render(); showView('rules'); scrollTo({ top: 0 }); };
    return row;
  }));
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
  const pts = list.length ? [{ y: 0, tip: 'התחלה · $0' }, ...list.map(t => { const p = pnlOf(t); eq += p;
    return { y: eq, tip: `${t.date} · עסקה ${money(p)} · מצטבר ${money(eq)}` }; })] : [];
  lineChart($('#equity'), pts, { label: 'רווח/הפסד מצטבר', ref: 0, fmt: v => '$' + v.toLocaleString('en-US'),
    first: list.length ? list[0].date : '', last: list.length ? list[list.length - 1].date : '' });
}
function renderScores() {
  const ds = tradingDays().filter(inRange).map(analyzeDay);
  lineChart($('#scores'), ds.map(d => ({ y: d.score, tip: `${d.date} · ציון ${d.score.toFixed(0)} · ${d.n} עסקאות · ${d.kept ? 'עמדתי בחוקים' : 'נשבר חוק' + (d.broken.length ? ' ' + d.broken.join(', ') : '')}` })),
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
    const p = pnlOf(t); g.n++; g.pnl += p; if (p > 0) g.wins++;
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

/* ---------- journal ---------- */
const rulesLabel = t => t.kept === false ? '✗ ' + ((t.broken || []).length ? 'חוק ' + t.broken.join(', ') : 'נשבר חוק') : t.kept === true ? '✓ עמדתי' : '—';
function renderTable(list) {
  const body = $('#trades-table tbody');
  body.replaceChildren();
  $('#empty').hidden = list.length > 0;
  [...list].reverse().forEach(t => {
    const p = pnlOf(t), r = rOf(t);
    const td = (text, c = '') => el('td', { className: c, textContent: text });
    const actions = el('td', {},
      el('button', { className: 'link', textContent: 'פרטים', onclick: () => { openDetail = openDetail === t.id ? null : t.id; render(); } }),
      el('button', { className: 'link', textContent: 'עריכה', onclick: () => openForm(t) }),
      el('button', { className: 'link', textContent: 'מחיקה', onclick: async () => {
        if (confirm('למחוק את העסקה?')) { await store('trades', 'readwrite', s => s.delete(t.id)); await refresh(); } } }));
    body.append(el('tr', {},
      td(t.date + (t.time ? ' ' + t.time : ''), 'num'), td(t.symbol, 'ltr'), td(DIR[t.dir] || ''),
      el('td', {}, el('span', { className: 'res ' + resultOf(t)[0], textContent: resultOf(t)[1] })),
      td(money(p), 'num ' + cls(p)), td(r == null ? '—' : num(r) + 'R', 'num'), td(String(scoreOf(t)), 'num'),
      td(rulesLabel(t), t.kept === false ? 'warn' : t.kept === true ? 'ok' : ''),
      el('td', { className: 'pic' }, ...(t.images && t.images.length ? [el('img', { src: t.images[0], alt: 'תמונת העסקה', title: 'לחץ להגדלה',
        onclick: () => view(t.images[0]) }), ...(t.images.length > 1 ? [el('span', { className: 'muted', textContent: ' +' + (t.images.length - 1) })] : [])] : ['—'])),
      actions));
    if (openDetail === t.id) {
      const cell = el('td', { colSpan: 10 });
      const line = (k, v) => v ? cell.append(el('p', {}, el('b', { textContent: k + ': ' }), v)) : null;
      line('חוקים שנשברו', (t.broken || []).map(b => `${b}. ${RULES()[b - 1]}`).join(' · '));
      line('נקודות שירדו בציון', SCORE.filter(([k]) => !(t.score && t.score[k])).map(([, l, pt]) => `${l} (−${pt})`).join(' · '));
      line('מה הרגשתי', t.notes);
      if (t.images && t.images.length) cell.append(el('div', { className: 'thumbs' }, ...t.images.map(thumb)));
      if (!cell.childNodes.length) cell.append(el('p', { className: 'muted', textContent: 'אין פרטים נוספים.' }));
      body.append(el('tr', { className: 'detail' }, cell));
    }
  });
}
const view = src => { $('#viewer-img').src = src; $('#viewer').showModal(); };
const thumb = src => el('figure', {}, el('img', { src, alt: 'תמונה', onclick: () => view(src) }));

/* ---------- trade form ---------- */
function openForm(t) {
  editing = t || null;
  const f = $('#form'); f.reset();
  $('#dlg-title').textContent = t ? 'עריכת עסקה' : 'עסקה חדשה';
  const e = f.elements;
  e.date.value = t ? t.date : curDate();
  e.time.value = t ? t.time || '' : new Date().toTimeString().slice(0, 5);
  e.symbol.value = t && [...e.symbol.options].some(o => o.value === t.symbol) ? t.symbol : 'NQ';
  e.dir.value = t ? t.dir : 'long';
  if (t) {
    const p = pnlOf(t), r = rOf(t);
    e.res.value = p > 0 ? 'win' : p < 0 ? 'loss' : 'be';
    e.amount.value = Math.abs(p);
    e.r.value = r == null ? '' : Math.abs(r);
    e.notes.value = t.notes || '';
    if (t.kept != null) e.kept.value = t.kept ? 'yes' : 'no';
  }
  $$('#score input').forEach(i => { i.checked = !!(t && t.score && t.score[i.value]); });
  $$('#broken input').forEach(i => { i.checked = !!(t && (t.broken || []).includes(Number(i.value))); });
  images = [...((t && t.images) || [])];
  renderThumbs(); updateForm();
  $('#dlg').showModal();
}
function readForm() {
  const e = $('#form').elements;
  const sign = e.res.value === 'loss' ? -1 : e.res.value === 'be' ? 0 : 1;
  const kept = e.kept.value === 'yes' ? true : e.kept.value === 'no' ? false : null;
  return {
    id: editing ? editing.id : uid(),
    date: e.date.value, time: e.time.value, symbol: e.symbol.value, dir: e.dir.value,
    pnl: sign * Math.abs(parseNum(e.amount.value) || 0),
    r: parseNum(e.r.value) == null || isNaN(parseNum(e.r.value)) ? null : sign * Math.abs(parseNum(e.r.value)),
    score: Object.fromEntries($$('#score input').map(i => [i.value, i.checked])),
    kept, broken: kept === false ? $$('#broken input:checked').map(i => Number(i.value)) : [],
    notes: e.notes.value.trim(), images,
  };
}
function updateForm() {
  const e = $('#form').elements;
  $('#score-total').textContent = scoreOf(readForm()) + ' / 100';
  $('#broken-box').hidden = e.kept.value !== 'no';
  // Typing a minus sign (e.g. -1R or -50) marks the trade as a loss on its own.
  if (parseNum(e.amount.value) < 0 || parseNum(e.r.value) < 0) e.res.value = 'loss';
  e.amount.setCustomValidity(isNaN(parseNum(e.amount.value)) ? 'צריך מספר, למשל 103 או ‎-103' : '');
  e.r.setCustomValidity(isNaN(parseNum(e.r.value)) ? 'צריך מספר, למשל 2 או ‎-1' : '');
  const be = e.res.value === 'be';
  e.amount.required = !be;
  if (be) { e.amount.value = 0; e.r.value = 0; }
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

// Lets images be dragged onto an area, or pasted into it with Ctrl+V.
function acceptImages(target, onFiles) {
  const pics = list => [...list].filter(f => f.type.startsWith('image/'));
  let depth = 0;
  target.addEventListener('dragenter', e => { e.preventDefault(); depth++; target.classList.add('drop'); });
  target.addEventListener('dragover', e => e.preventDefault());
  target.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; target.classList.remove('drop'); } });
  target.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; target.classList.remove('drop');
    const fs = pics(e.dataTransfer.files); if (fs.length) onFiles(fs);
  });
  target.addEventListener('paste', e => {
    const fs = pics(e.clipboardData.files); if (fs.length) { e.preventDefault(); onFiles(fs); }
  });
}

/* ---------- backup ---------- */
function download(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function toCsv(list) {
  const head = ['date', 'time', 'symbol', 'direction', 'pnl', 'R', 'score', 'kept_rules', 'broken_rules', 'notes'];
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = list.map(t => { const r = rOf(t); return [t.date, t.time, t.symbol, t.dir, pnlOf(t).toFixed(2), r == null ? '' : r.toFixed(2),
    scoreOf(t), t.kept == null ? '' : t.kept ? 'yes' : 'no', (t.broken || []).join('; '), t.notes].map(q).join(','); });
  return '﻿' + [head.join(','), ...rows].join('\r\n');
}

/* ---------- render ---------- */
function showView(name) {
  $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x.dataset.view === name));
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
  $('#daybar').hidden = !['pre', 'rules'].includes(name);
}
function render() {
  const list = filtered();
  renderPre(); renderRules(); renderTable(list);
  renderTiles(list); renderPhase(); renderWeek(); renderScores(); renderEquity(list); renderDays();
  renderBars('#by-kept', list, t => [t.kept === false ? 'שברתי חוק' : 'עמדתי בחוקים'], ['עמדתי בחוקים', 'שברתי חוק']);
  renderBars('#by-rule', list.filter(t => t.kept === false), t => (t.broken || []).length ? t.broken.map(b => 'חוק ' + b) : ['לא צוין']);
  renderBars('#by-symbol', list, t => [t.symbol || '—']);
  renderBars('#by-day', list, t => [DAYS[new Date(t.date + 'T12:00').getDay()]], DAYS);
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
  $('#broken').replaceChildren(...RULES().map((r, i) => el('label', {}, el('input', { type: 'checkbox', value: String(i + 1) }), `${i + 1}. ${r}`)));
  $$('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $$('.filters input').forEach(i => i.addEventListener('change', render));
  $('#f-clear').onclick = () => { $$('.filters input').forEach(i => { i.value = ''; }); render(); };

  $('#day').value = localDate();
  $('#day').addEventListener('change', () => { if (!$('#day').value) $('#day').value = localDate(); loadDayForms(); render(); });

  // pre-market
  $$('#bias button').forEach(b => b.onclick = () => saveDay(curDate(), { bias: dayOf(curDate()).bias === b.dataset.v ? '' : b.dataset.v }));
  $('#bias-text').addEventListener('change', e => saveDay(curDate(), { biasText: e.target.value.trim() }));
  $$('#sc-type button').forEach(b => b.onclick = () => setSeg('#sc-type', b.dataset.v));
  const setScImage = async files => { if (files[0]) scImage = await compress(files[0]); renderScPreview(); };
  $('#sc-img').addEventListener('change', async e => { await setScImage(e.target.files); e.target.value = ''; });
  acceptImages($('#sc-card'), setScImage);
  $('#sc-cancel').onclick = resetScenarioForm;
  $('#sc-add').onclick = async () => {
    const text = $('#sc-text').value.trim();
    if (!text && !scImage) { $('#sc-text').focus(); return; }
    const date = curDate(), list = dayOf(date).scenarios || [];
    const s = { id: scEditing || uid(), type: getSeg('#sc-type') || 'long', text, image: scImage };
    const next = scEditing ? list.map(x => x.id === scEditing ? { ...x, ...s } : x) : [...list, s];
    resetScenarioForm();
    await saveDay(date, { scenarios: next });
  };

  // rules
  $('#mood').addEventListener('change', e => saveDay(curDate(),
    { mood: e.target.value === '' ? null : Math.max(1, Math.min(10, Math.round(Number(e.target.value)))) }));
  $('#feeling').addEventListener('change', e => saveDay(curDate(), { feeling: e.target.value.trim() }));
  for (const k of Object.keys(DEFAULTS)) {
    const input = $('#s-' + k);
    input.value = S[k];
    input.addEventListener('change', () => {
      S[k] = input.type === 'number' ? (Number(input.value) || DEFAULTS[k]) : input.value;
      localStorage.setItem('tj-settings', JSON.stringify(S));
      $$('#broken label').forEach((l, i) => { l.lastChild.textContent = `${i + 1}. ${RULES()[i]}`; });
      render();
    });
  }

  // journal
  $('#btn-new').onclick = () => openForm();
  $('#btn-cancel').onclick = () => $('#dlg').close();
  $('#form').addEventListener('input', updateForm);
  $('#form').addEventListener('submit', async e => {
    e.preventDefault();
    await put('trades', readForm());
    $('#dlg').close();
    showView('journal');
    await refresh();
  });
  const addImages = async files => { for (const f of files) images.push(await compress(f)); renderThumbs(); };
  $('#in-img').addEventListener('change', async e => { await addImages(e.target.files); e.target.value = ''; });
  acceptImages($('#form'), addImages);
  // A file dropped outside a drop area must not replace the page.
  ['dragover', 'drop'].forEach(ev => addEventListener(ev, e => e.preventDefault()));
  $('#viewer').addEventListener('click', () => $('#viewer').close());

  // backup
  $('#btn-export').onclick = () => download(`trading-journal-${localDate()}.json`,
    JSON.stringify({ version: 3, settings: S, trades, days: [...days.values()] }), 'application/json');
  $('#btn-csv').onclick = () => download('trades.csv', toCsv(filtered()), 'text/csv');
  $('#in-import').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.trades)) throw new Error('bad file');
      const valid = data.trades.filter(t => t && t.id && t.date);
      for (const t of valid) await put('trades', t);
      for (const d of (data.days || []).filter(d => d && d.date)) await put('days', d);
      alert(`יובאו ${valid.length} עסקאות.`);
      await refresh(); loadDayForms();
    } catch { alert('הקובץ אינו קובץ גיבוי תקין.'); }
    e.target.value = '';
  });
  await refresh();
  loadDayForms();
  showView('pre');
}
init();
