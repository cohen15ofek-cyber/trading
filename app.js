'use strict';
const LEGACY_POINT_VALUE = { NQ: 20, MNQ: 2 };
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const SCORE = [
  ['setup', 'סטאפ מהאסטרטגיה שלי', 25],
  ['risk', 'גודל פוזיציה לפי התוכנית, סטופ מחושב מראש', 20],
  ['stop', 'סטופ מוגדר מראש ולא הוזז אחורה', 20],
  ['noadd', 'לא הוספתי חוזים למפסידה', 15],
  ['calm', 'כניסה רגועה, לא מתוך FOMO או נקמה', 10],
  ['exit', 'יציאה לפי התוכנית', 10],
];
const DEFAULTS = { phase: '1', start: '', maxContracts: 1, maxLoss: 200 };
// Dollars per point, to turn a stop in points into dollars at risk.
const POINT_VALUE = { NQ: 20, MNQ: 2, ES: 50, MES: 5 };
// The position-size rule: at most S.maxContracts micro contracts. A full-size contract counts as 10 micros.
const MICROS = { MNQ: 1, MES: 1, NQ: 10, ES: 10 };
const overSize = t => t.qty != null && t.qty * (MICROS[t.symbol] || 1) > S.maxContracts;
let S = { ...DEFAULTS };
try { S = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tj-settings') || '{}') }; } catch {}
const RULES = () => [
  '2 עסקאות ב־BE (ברייק איבן)? היום נגמר.',
  'ניצחון אחד? היום נגמר.',
  '2 הפסדים? היום נגמר.',
  'אחרי כל עסקה: הפסקה של 15 דקות לפחות לפני העסקה הבאה.',
  'אסור להוסיף חוזים לעסקה פתוחה. אף פעם.',
  `לא עוברים הפסד יומי של $${S.maxLoss}.`,
  'מקסימום 3 עסקאות ביום.',
];
// Risk rules for the phase check: no adding contracts, daily loss limit.
const RISK_RULES = [5, 6];
const BREAK_MIN = 15;
// Rule numbers from the first rule list (10 rules) -> the current list. Old rules with no match are kept as text.
const RULES_VERSION = 2;
const OLD_MAP = { 2: 3, 3: 6, 4: 5, 6: 7 };
const OLD_TEXT = { 1: 'סיכון לעסקה מעל המותר', 5: 'הזזת סטופ אחורה', 7: 'המשך מסחר אחרי היעד היומי',
  8: 'סטאפ שלא מהאסטרטגיה', 9: 'לייבים וקהילות בזמן הסשן', 10: 'מצב רגשי מתחת ל־6' };
function migrateTrade(t) {
  if (t.rv >= RULES_VERSION) return t;
  const old = t.broken || [];
  return { ...t, rv: RULES_VERSION, broken: [...new Set(old.map(b => OLD_MAP[b]).filter(Boolean))],
    oldBroken: old.filter(b => !OLD_MAP[b]).map(b => OLD_TEXT[b]).filter(Boolean) };
}
function migrateDay(d) {
  if (d.rv >= RULES_VERSION || !d.rules) return { ...d, rv: RULES_VERSION };
  const next = RULES().map(() => null);
  d.rules.forEach((v, i) => { const n = OLD_MAP[i + 1]; if (n && v != null) next[n - 1] = v; });
  return { ...d, rules: next, rv: RULES_VERSION };
}
const endOf = t => mins(t.exitTime) != null ? mins(t.exitTime) : mins(t.time);
const mins = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const DIR = { long: 'לונג', short: 'שורט', neutral: 'ניטרלי' };
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
// Trade management questions. Each answer is optional, so old trades and quick entries still work.
const Q = {
  acct: ['חשבון', [['real', 'אמיתי'], ['demo', 'דמו']]],
  exit: ['איך יצאתי', [['tp', 'טייק פרופיט'], ['sl', 'סטופ'], ['be', 'ברייק איבן'], ['manual', 'יציאה ידנית']]],
  be: ['מתי העברתי לברייק איבן', [['none', 'לא העברתי'], ['early', 'לפני 1R'], ['late', 'אחרי 1R']]],
  hit: ['אחרי שיצאתי, המחיר הגיע ליעד שלי?', [['yes', 'כן'], ['no', 'לא'], ['unk', 'לא בדקתי']]],
  reentry: ['כניסה חוזרת לאותו רעיון אחרי סטופ או BE?', [['yes', 'כן'], ['no', 'לא']]],
  struct: ['ביחס למבנה של 15 דקות', [['with', 'עם המבנה'], ['against', 'נגד המבנה']]],
  mind: ['מה עבר לי בראש בכניסה', [['calm', 'רגוע, לפי התוכנית'], ['sure', '"אני בטוח"'], ['fomo', 'FOMO'],
    ['revenge', 'להחזיר הפסד'], ['fear', 'פחד / היסוס']]],
};
// What kind of trade it was. "Random" keeps the rules but wasn't planned.
const KIND = { plan: 'עסקת תוכנית', random: 'עסקה סתם', broke: 'שברתי חוק' };
const kindOf = t => t.kind || (t.kept === false ? 'broke' : t.kept === true ? 'kept' : '');
const kindLabel = t => KIND[kindOf(t)] || (kindOf(t) === 'kept' ? 'עמדתי בחוקים (לפני הסיווג)' : 'לא סווג');
const RANDOM_WHY = [['notStrategy', 'לא סטאפ מהאסטרטגיה'], ['notScenario', 'לא היה בתרחישים'], ['emotion', 'נכנסתי מהרגש']];
const MISTAKES = [['earlyBE', 'BE לפני 1R'], ['stopBack', 'הזזתי סטופ אחורה'], ['manual', 'יצאתי ידנית לפני הזמן'],
  ['reentry', 'כניסה חוזרת אחרי סטופ/BE'], ['against', 'נגד המבנה של 15 דקות']];
// Old trades kept the same facts in separate fields.
const mistakesOf = t => t.mistakes || [t.be === 'early' && 'earlyBE', t.exit === 'manual' && 'manual',
  t.reentry === 'yes' && 'reentry', t.struct === 'against' && 'against'].filter(Boolean);
const qLabel = (k, v) => (Q[k][1].find(o => o[0] === v) || [, ''])[1];
const monthName = m => m === 'all' ? 'כל הזמן' : `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

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
// An imported trade that hasn't been completed yet (no trade type, no rules answer).
const pendingOf = t => t.src === 'tradovate' && t.kept == null && !t.kind;
const scored = ts => ts.filter(t => !pendingOf(t));
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
const byTime = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')) || String(a.id).localeCompare(String(b.id));

/* ---------- state ---------- */
let trades = [];
let days = new Map();
let editing = null;
let images = [];
let openDetail = null;
let scEditing = null;
let scImage = null;
let month = localDate().slice(0, 7);
let numbering = new Map();
let acct = 'all';
// Trades logged before the account field existed were all on real money.
const acctOf = t => t.acct || 'real';
const DEMO_TEST = 20;

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
  const headNo = day.headspace === 'no';
  return { nos, moodLow, headNo, status: nos.length || headNo ? 'no' : complete ? 'yes' : 'open' };
}
function analyzeDay(date) {
  const ts = trades.filter(t => t.date === date).sort(byTime);
  const day = dayOf(date);
  const gate = gateOf(day);
  const broken = new Set();
  let losses = 0, wins = 0, bes = 0, cum = 0, prev = null;
  ts.forEach(t => {
    if (bes >= 2) broken.add(1);
    if (wins >= 1) broken.add(2);
    if (losses >= 2) broken.add(3);
    // Measured from the previous exit time, or its entry time when no exit time was written.
    if (prev && endOf(prev) != null && mins(t.time) != null && mins(t.time) - endOf(prev) < BREAK_MIN) broken.add(4);
    if (t.kept === false) (t.broken || []).forEach(b => broken.add(b));
    const p = pnlOf(t);
    if (p < 0) losses++; else if (p > 0) wins++; else bes++;
    cum += p; prev = t;
  });
  if (cum < -S.maxLoss) broken.add(6);
  if (ts.length > 3) broken.add(7);
  if (ts.length && gate.status === 'no') gate.nos.forEach(i => broken.add(i + 1));
  const skipped = !ts.length && gate.status === 'no';
  const flagged = ts.some(t => t.kept === false);
  return { date, n: ts.length, losses, wins, bes, last: prev, pnl: cum, score: avg(scored(ts).map(scoreOf)), day, gate, skipped,
    broken: [...broken].sort((a, b) => a - b), kept: skipped || (ts.length > 0 && !broken.size && !flagged && !gate.headNo) };
}
const inRange = date => month === 'all' || date.startsWith(month);
const filtered = () => trades.filter(t => inRange(t.date) && (acct === 'all' || acctOf(t) === acct)).sort(byTime);
const tradingDays = () => [...new Set(trades.map(t => t.date))].sort();
// Days that count for the process: days with trades, and days that were skipped because of the rules.
const processDays = () => [...new Set([...tradingDays(), ...[...days.keys()].filter(d => analyzeDay(d).skipped)])].sort();

/* ---------- pre-market ---------- */
// Free-text day fields saved as they are typed.
const DAY_TEXT = ['sleep', 'news', 'pd', 'liq'];
const ENERGY = { high: 'גבוהה', mid: 'בינונית', low: 'נמוכה' };
const AP_STATUS = { taken: 'לקחתי אותה', missed: 'לא לקחתי אותה', none: 'לא היה A+ היום' };
// A thumbnail with a remove button, or nothing.
function previewInto(sel, src, onRemove) {
  if (!src) { $(sel).replaceChildren(); return; }
  const fig = thumb(src);
  fig.append(el('button', { type: 'button', textContent: '×', title: 'הסר', onclick: onRemove }));
  $(sel).replaceChildren(fig);
}
function loadDayForms() {
  const d = dayOf(curDate());
  $('#bias-text').value = d.biasText || '';
  $('#mood').value = d.mood ?? '';
  $('#feeling').value = d.feeling || '';
  $('#review-text').value = d.review || '';
  for (const k of DAY_TEXT) $('#' + k).value = d[k] ?? '';
  const ap = d.aplus || {};
  $('#ap-conf').value = ap.conf || ''; $('#ap-rr').value = ap.rr ?? ''; $('#ap-time').value = ap.time || ''; $('#ap-why').value = ap.why || '';
  resetScenarioForm();
}
function resetScenarioForm() {
  scEditing = null; scImage = null;
  $('#sc-text').value = '';
  $('#sc-inval').value = '';
  setSeg('#sc-type', 'long');
  $('#sc-title').textContent = '3. תרחיש חדש';
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
      ...(s.inval ? [el('p', { className: 'inval', textContent: 'מבטל: ' + s.inval })] : []),
      el('div', { className: 'played' }, el('span', { className: 'muted', textContent: 'אחרי הסשן:' }),
        el('div', { className: 'seg' }, ...PLAYED.map(([v, t]) => el('button', { type: 'button', textContent: t, ariaPressed: String(s.played === v),
          onclick: () => setList(list.map(x => x.id === s.id ? { ...x, played: x.played === v ? null : v } : x)) })))),
      el('div', { className: 'foot' },
        el('label', {}, el('input', { type: 'checkbox', checked: !!s.taken,
          onchange: e => setList(list.map(x => x.id === s.id ? { ...x, taken: e.target.checked } : x)) }), 'לקחתי את התרחיש'),
        el('button', { className: 'link', textContent: 'עריכה', onclick: () => {
          scEditing = s.id; scImage = s.image || null;
          $('#sc-text').value = s.text || ''; $('#sc-inval').value = s.inval || ''; setSeg('#sc-type', s.type);
          $('#sc-title').textContent = '3. עריכת תרחיש'; $('#sc-add').textContent = 'שמירת התרחיש'; $('#sc-cancel').hidden = false;
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
  setSeg('#bias-result', d.biasResult || '');
  setSeg('#energy', d.energy || '');
  setSeg('#headspace', d.headspace || '');
  $('#head-no').hidden = d.headspace !== 'no';
  previewInto('#htf-preview', d.htfImage, () => saveDay(date, { htfImage: null }));
  const ap = d.aplus || {};
  setSeg('#ap-status', ap.status || '');
  $('#ap-box').hidden = !['taken', 'missed'].includes(ap.status);
  $('#ap-why-label').hidden = ap.status !== 'missed';
  previewInto('#ap-preview', ap.image, () => saveDay(date, { aplus: { ...ap, image: null } }));
  const box = $('#rv-preview');
  if (d.reviewImage) {
    const fig = thumb(d.reviewImage);
    fig.append(el('button', { type: 'button', textContent: '×', title: 'הסר', onclick: () => saveDay(date, { reviewImage: null }) }));
    box.replaceChildren(fig);
  } else box.replaceChildren();
}

/* ---------- analyses ---------- */
const PLAYED = [['yes', 'קרה'], ['partial', 'חלקית'], ['no', 'לא קרה']];
const playedLabel = v => (PLAYED.find(o => o[0] === v) || [, ''])[1];
const BIAS_RESULT = { yes: 'הביאס צדק', partial: 'הביאס צדק חלקית', no: 'הביאס טעה' };
const fmtDate = d => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const hasPre = d => !!(d && (d.bias || d.biasText || d.htfImage || d.pd || d.liq || (d.scenarios || []).length));
function weekOf(date) {
  const s = new Date(date + 'T12:00'); s.setDate(s.getDate() - s.getDay());
  const e = new Date(s); e.setDate(s.getDate() + 6);
  return [localDate(s), localDate(e)];
}
function renderAnalyses() {
  const dates = [...new Set([...days.keys(), ...trades.map(t => t.date)])].filter(inRange)
    .filter(d => hasPre(days.get(d)) || trades.some(t => t.date === d) || days.get(d)?.review).sort();
  const ds = dates.map(d => ({ date: d, day: dayOf(d), a: analyzeDay(d) }));
  const tradingDs = ds.filter(x => x.a.n);
  const judged = ds.filter(x => x.day.biasResult);
  const scs = ds.flatMap(x => x.day.scenarios || []);
  const scJudged = scs.filter(s => s.played);
  // Trades in the bias direction on days the bias turned out wrong: the cost of holding on to a bias.
  const stubborn = ds.filter(x => x.day.biasResult === 'no' && ['long', 'short'].includes(x.day.bias))
    .flatMap(x => trades.filter(t => t.date === x.date && t.dir === x.day.bias));
  $('#an-count').textContent = `${ds.length} ימים ב${monthName(month)}`;
  $('#an-tiles').replaceChildren(...[
    ['ימי מסחר עם pre-market', tradingDs.length ? `${tradingDs.filter(x => hasPre(x.day)).length} / ${tradingDs.length}` : '—'],
    ['הביאס צדק', judged.length ? `${judged.filter(x => x.day.biasResult === 'yes').length} / ${judged.length}`
      + (judged.some(x => x.day.biasResult === 'partial') ? ` · חלקית ${judged.filter(x => x.day.biasResult === 'partial').length}` : '') : '—'],
    ['תרחישים שקרו', scJudged.length ? `${scJudged.filter(s => s.played === 'yes').length} / ${scJudged.length}` : '—'],
    ['תרחישים שלקחתי', scs.length ? `${scs.filter(s => s.taken).length} / ${scs.length}` : '—'],
    ['עסקאות לכיוון ביאס שטעה', stubborn.length ? `${stubborn.length} · ${money(stubborn.reduce((s, t) => s + pnlOf(t), 0))}` : '0',
      stubborn.length ? 'warn' : ''],
  ].map(tile));

  const list = $('#an-list');
  if (!ds.length) { list.replaceChildren(el('p', { className: 'muted', textContent: 'אין עדיין ימים בתקופה הזו.' })); return; }
  const out = [];
  let week = '';
  for (const { date, day, a } of ds) {
    const [ws, we] = weekOf(date);
    if (ws !== week) { week = ws; out.push(el('h3', { className: 'week-head' }, 'שבוע ', el('span', { className: 'num', textContent: `${fmtDate(ws).slice(0, 5)}–${fmtDate(we)}` }))); }
    const head = el('div', { className: 'an-head' },
      el('b', { textContent: `יום ${DAYS[new Date(date + 'T12:00').getDay()]} · ${fmtDate(date)}` }),
      ...(day.bias ? [el('span', { className: 'tag ' + day.bias, textContent: 'ביאס ' + DIR[day.bias] })] : []),
      ...(day.biasResult ? [el('span', { className: 'res ' + (day.biasResult === 'yes' ? 'win' : day.biasResult === 'no' ? 'loss' : 'be'),
        textContent: BIAS_RESULT[day.biasResult] })] : []),
      el('button', { className: 'link', textContent: 'פתיחת היום', onclick: () => { $('#day').value = date; loadDayForms(); render(); showView('pre'); scrollTo({ top: 0 }); } }));
    const card = el('div', { className: 'card an-day' }, head);
    if (!hasPre(day)) card.append(el('p', { className: 'warn', textContent: 'לא נכתב pre-market ליום הזה.' }));
    const mindBits = [day.sleep && `שינה ${day.sleep} שעות`, day.energy && 'אנרגיה ' + ENERGY[day.energy], day.mood != null && `מצב רגשי ${day.mood}`,
      day.headspace && (day.headspace === 'yes' ? 'בראש הנכון' : 'לא בראש הנכון')].filter(Boolean);
    if (mindBits.length) card.append(el('p', { className: 'an-mind' + (day.headspace === 'no' ? ' warn' : ''), textContent: mindBits.join(' · ') }));
    if (day.htfImage) card.append(el('div', { className: 'thumbs' }, thumb(day.htfImage)));
    if (day.biasText) card.append(el('p', { className: 'an-text', textContent: day.biasText }));
    for (const [k, label] of [['news', 'חדשות'], ['pd', 'Premium / Discount'], ['liq', 'נזילות']])
      if (day[k]) card.append(el('p', { className: 'an-text' }, el('span', { className: 'muted', textContent: label + ': ' }), day[k]));
    if ((day.scenarios || []).length) card.append(el('div', { className: 'an-scs' }, ...day.scenarios.map(s => {
      const sc = el('div', { className: 'an-sc' });
      if (s.image) sc.append(el('img', { src: s.image, alt: 'תמונת התרחיש', onclick: () => view(s.image) }));
      sc.append(el('div', { className: 'an-sc-body' },
        el('div', { className: 'row' }, el('span', { className: 'tag ' + s.type, textContent: DIR[s.type] }),
          ...(s.played ? [el('span', { className: 'res ' + (s.played === 'yes' ? 'win' : s.played === 'no' ? 'loss' : 'be'), textContent: playedLabel(s.played) })] : []),
          ...(s.taken ? [el('span', { className: 'res be', textContent: 'לקחתי' })] : [])),
        ...(s.text ? [el('p', { textContent: s.text })] : []),
        ...(s.inval ? [el('p', { className: 'inval', textContent: 'מבטל: ' + s.inval })] : [])));
      return sc;
    })));
    const ap = day.aplus || {};
    if (ap.status) {
      const apEl = el('div', { className: 'an-review' }, el('span', { className: 'muted', textContent: 'עסקת ה־A+: ' }),
        AP_STATUS[ap.status] + [ap.conf, ap.rr != null && ap.rr + 'R', ap.time && 'ב־' + ap.time].filter(Boolean).map(x => ' · ' + x).join('')
        + (ap.status === 'missed' && ap.why ? ` · למה לא: ${ap.why}` : ''));
      card.append(apEl);
      if (ap.image) card.append(el('div', { className: 'thumbs' }, thumb(ap.image)));
    }
    if (day.review || day.reviewImage) {
      const rv = el('div', { className: 'an-review' }, el('span', { className: 'muted', textContent: 'מה קרה בפועל: ' }));
      if (day.review) rv.append(el('span', { textContent: day.review }));
      card.append(rv);
      if (day.reviewImage) card.append(el('div', { className: 'thumbs' }, thumb(day.reviewImage)));
    }
    const kinds = Object.entries(trades.filter(t => t.date === date).reduce((m, t) => { const k = kindLabel(t); m[k] = (m[k] || 0) + 1; return m; }, {}))
      .map(([k, n]) => `${k} ${n}`).join(' · ');
    card.append(el('p', { className: 'an-trades' }, a.n
      ? el('span', {}, `${a.n === 1 ? 'עסקה אחת' : a.n + ' עסקאות'} · `, el('span', { className: 'num ' + cls(a.pnl), textContent: fmtU(sumU(trades.filter(t => t.date === date))) }),
        ` · ${kinds}` + (a.broken.length ? ` · נשברו חוקים ${a.broken.join(', ')}` : ''))
      : el('span', { className: 'muted', textContent: a.skipped ? 'דילגתי על היום לפי החוקים' : 'לא סחרתי' })));
    out.push(card);
  }
  list.replaceChildren(...out);
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
    no: ['היום לא סוחרים.', g.headNo && !g.nos.length ? 'סימנת בבוקר שאתה לא בראש הנכון. לדלג על היום זה לעמוד בחוקים.'
      : 'אם אני סוחר היום, אני עובר על החוקים שלי. לדלג על היום זה לעמוד בחוקים.'],
    open: ['לפני שפותחים את הגרף:', 'סמן כן או לא ליד כל חוק, ותכתוב איך אתה מרגיש.'],
  }[g.status];
  v.className = 'verdict ' + g.status;
  v.replaceChildren(text[0], el('small', { textContent: text[1] }),
    ...(g.moodLow ? [el('small', { textContent: 'שים לב: מצב רגשי מתחת ל־6. ככה מתחילים הימים שבהם נשברים חוקים.' })] : []));
  const gaveIn = trades.filter(t => t.date === date && t.reentry === 'yes').length;
  $('#urge-count').textContent = `היום: עמדתי בדחף ${day.urgeHeld || 0} פעמים · נכנסתי שוב ${gaveIn} פעמים`;
  $('#d-tiles').replaceChildren(...[
    ['עסקאות', `${a.n} / 3`], ['ניצחונות', `${a.wins} / 1`], ['הפסדים', `${a.losses} / 2`], ['BE', `${a.bes} / 2`],
    ['רווח/הפסד', money(a.pnl), cls(a.pnl)], ['ציון ממוצע', a.score == null ? '—' : a.score.toFixed(0)],
  ].map(tile));

  const lock = $('#lock');
  let msg = '';
  if (date === localDate()) {
    const since = a.last && endOf(a.last) != null ? mins(new Date().toTimeString()) - endOf(a.last) : null;
    if (a.wins >= 1) msg = 'ניצחון. היום נגמר. סוגר את הפלטפורמה ושומר את הרווח.';
    else if (a.losses >= 2) msg = 'הפסד שני. סוגר את הפלטפורמה, היום נגמר.';
    else if (a.bes >= 2) msg = 'שני BE. היום נגמר.';
    else if (a.pnl <= -S.maxLoss) msg = 'הגעת להפסד היומי המקסימלי. היום נגמר.';
    else if (a.n >= 3) msg = '3 עסקאות היום. מסיים את היום.';
    else if (since != null && since >= 0 && since < BREAK_MIN) msg = `הפסקה. קם מהמסך. אפשר לחזור בעוד ${BREAK_MIN - since} דקות (נמדד משעת היציאה, או משעת הכניסה אם לא רשמת יציאה).`;
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
  const score = avg(scored(trades.filter(t => !S.start || t.date >= S.start)).map(scoreOf));
  const riskBreaks = ds.reduce((s, d) => s + d.broken.filter(b => RISK_RULES.includes(b)).length, 0);
  const box = $('#phase');
  $('#phase-title').textContent = 'התקדמות בשלב ' + S.phase;
  const rows = [
    ['ציון ממוצע' + (S.phase === '1' ? ' (יעד: 90+)' : ''), score == null ? '—' : score.toFixed(0), score != null && score < 90 ? 'warn' : ''],
    ['שבירות של חוקי הסיכון 5–6 (יעד: 0)', String(riskBreaks), riskBreaks ? 'warn' : ''],
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
  const best = scored(ts).sort((a, b) => scoreOf(b) - scoreOf(a) || byTime(a, b))[0];
  box.replaceChildren(kv([
    ['שבוע', `${from} עד ${to}`],
    ['ימים שעמדתי בחוקים', keptText(ds)],
    ['ימים שדילגתי', String(ds.filter(d => d.skipped).length)],
    ['ציון ממוצע', scored(ts).length ? avg(scored(ts).map(scoreOf)).toFixed(0) : '—'],
    ['החוק שנשבר הכי הרבה', worst ? `חוק ${worst[0]} (${worst[1]} ימים): ${RULES()[worst[0] - 1]}` : 'אף חוק לא נשבר'],
    ['העסקה הכי טובה בביצוע', best ? `${best.date} ${best.time || ''} · ${best.symbol} · ציון ${scoreOf(best)}` : '—'],
    ['רווח/הפסד', fmtU(sumU(ts)), 'num'],
  ]));
}
const rSum = ts => ts.reduce((s, t) => s + (rOf(t) || 0), 0);
let unit = 'usd';
try { unit = localStorage.getItem('tj-unit') === 'R' ? 'R' : 'usd'; } catch {}
const valOf = t => unit === 'R' ? rOf(t) || 0 : pnlOf(t);
const sumU = ts => ts.reduce((s, t) => s + valOf(t), 0);
const fmtU = v => unit === 'R' ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + 'R' : money(v);
const upDown = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const frac = (a, b) => b ? `${a} / ${b}` : '—';

// A half circle split into coloured parts, left to right.
function gauge(parts) {
  const total = parts.reduce((s, [v]) => s + v, 0);
  const R = 50, cx = 60, cy = 60, W = 10;
  const pt = a => `${(cx - R * Math.cos(a)).toFixed(2)} ${(cy - R * Math.sin(a)).toFixed(2)}`;
  const arc = (a0, a1, color) => svgEl('path', { d: `M ${pt(a0)} A ${R} ${R} 0 0 1 ${pt(a1)}`, stroke: color, 'stroke-width': W,
    fill: 'none', 'stroke-linecap': 'round' });
  const svg = svgEl('svg', { viewBox: '0 0 120 66', class: 'gauge', 'aria-hidden': 'true' });
  if (!total) { svg.append(arc(0, Math.PI, 'var(--grid)')); return svg; }
  const shown = parts.filter(([v]) => v > 0), gap = shown.length > 1 ? 0.16 : 0;
  let a = 0;
  shown.forEach(([v, color], i) => {
    const span = v / total * Math.PI;
    svg.append(arc(a + (i ? gap / 2 : 0), a + span - (i < shown.length - 1 ? gap / 2 : 0), color));
    a += span;
  });
  return svg;
}
// A ring: the green share of wins against losses.
function donut(win, loss) {
  const r = 22, C = 2 * Math.PI * r;
  const svg = svgEl('svg', { viewBox: '0 0 60 60', class: 'donut', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 30, cy: 30, r, fill: 'none', stroke: win + loss ? 'var(--neg)' : 'var(--grid)', 'stroke-width': 8 }));
  if (win > 0) svg.append(svgEl('circle', { cx: 30, cy: 30, r, fill: 'none', stroke: 'var(--pos)', 'stroke-width': 8,
    'stroke-dasharray': `${C * win / (win + loss)} ${C}`, transform: 'rotate(-90 30 30)' }));
  return svg;
}
const counts = (...xs) => el('div', { className: 'gcounts' }, ...xs.map(([n, c, t]) => el('span', { className: 'gc ' + c, title: t, textContent: String(n) })));
function kpi(label, value, valueCls, visual, foot) {
  return el('div', { className: 'kpi' },
    el('div', { className: 'kpi-text' }, el('div', { className: 'k', textContent: label }),
      el('div', { className: 'v num ' + (valueCls || ''), textContent: value })),
    ...(visual ? [el('div', { className: 'kpi-vis' }, ...visual)] : []),
    ...(foot ? [el('div', { className: 'kpi-foot' }, ...foot)] : []));
}
function renderTiles(list) {
  const vals = list.map(valOf), net = vals.reduce((s, x) => s + x, 0);
  const wins = list.filter(t => pnlOf(t) > 0), losses = list.filter(t => pnlOf(t) < 0);
  const w = wins.length, l = losses.length, be = list.length - w - l;
  const gw = sumU(wins), gl = -sumU(losses);
  const avgW = w ? gw / w : 0, avgL = l ? gl / l : 0;
  const sc = avg(scored(list).map(scoreOf));
  const ds = processDays().filter(inRange).map(analyzeDay);
  const dayVals = [...new Set(list.map(t => t.date))].map(d => sumU(list.filter(t => t.date === d)));
  const dw = dayVals.filter(v => v > 0).length, dl = dayVals.filter(v => v < 0).length, dbe = dayVals.length - dw - dl;
  // This week so far: Sunday to today, same account filter, any month.
  const [ws] = weekOf(localDate());
  const week = trades.filter(t => t.date >= ws && t.date <= localDate() && (acct === 'all' || acctOf(t) === acct));
  $('#month-title').textContent = 'דאשבורד · ' + monthName(month);
  setSeg('#unit', unit);
  $('#kpis').replaceChildren(
    kpi('רווח/הפסד נטו', list.length ? fmtU(net) : '—', upDown(net), null,
      [el('span', { className: 'muted', textContent: list.length === 1 ? 'עסקה אחת' : `${list.length} עסקאות` })]),
    kpi('אחוז הצלחה', w + l ? Math.round(w / (w + l) * 100) + '%' : '—', '',
      [gauge([[w, 'var(--pos)'], [be, 'var(--accent)'], [l, 'var(--neg)']]), counts([w, 'win', 'ניצחונות'], [be, 'be', 'BE'], [l, 'loss', 'הפסדים'])]),
    kpi('Profit Factor', gl ? num(gw / gl) : gw ? '∞' : '—', '', [donut(gw, gl)]),
    kpi('ימים מרוויחים', dw + dl ? Math.round(dw / (dw + dl) * 100) + '%' : '—', '',
      [gauge([[dw, 'var(--pos)'], [dbe, 'var(--accent)'], [dl, 'var(--neg)']]), counts([dw, 'win', 'ימים מרוויחים'], [dbe, 'be', 'ימים מאוזנים'], [dl, 'loss', 'ימים מפסידים'])]),
    kpi('ממוצע ניצחון / הפסד', avgL ? num(avgW / avgL) : '—', '', null, w || l ? [
      el('div', { className: 'wl' }, ...(avgW ? [el('span', { className: 'w', style: `flex:${avgW}` })] : []),
        ...(avgL ? [el('span', { className: 'l', style: `flex:${avgL}` })] : [])),
      el('div', { className: 'wl-labels' }, el('span', { className: 'up', textContent: w ? fmtU(avgW) : '—' }),
        el('span', { className: 'down', textContent: l ? fmtU(-avgL) : '—' }))] : null),
  );
  $('#tiles').replaceChildren(...[
    ...(acct === 'demo' ? [['מבחן הדמו', `${trades.filter(t => acctOf(t) === 'demo').length} / ${DEMO_TEST}`]] : []),
    ['מתחילת השבוע', week.length ? fmtU(sumU(week)) : '—', upDown(sumU(week))],
    [month === 'all' ? 'עסקאות' : 'עסקאות החודש', String(list.length)],
    ['סה״כ עסקאות', String(trades.length)],
    ['ניצחון / הפסד / BE', `${w} / ${l} / ${be}`],
    ['ימים בחוקים', frac(ds.filter(d => d.kept).length, ds.length)],
    ['עסקאות תוכנית', frac(list.filter(t => t.kind === 'plan').length, list.length)],
    ['ציון ממוצע', sc == null ? '—' : sc.toFixed(0)],
  ].map(tile));
}
// The month as a calendar: trades, dollars and R per day, with a total for each week.
function renderCalendar(list) {
  const box = $('#calendar');
  $('#cal-title').textContent = 'לוח החודש' + (month === 'all' ? '' : ' · ' + monthName(month));
  if (month === 'all') { box.replaceChildren(el('p', { className: 'muted', textContent: 'בחר חודש כדי לראות את הלוח.' })); return; }
  const [y, m] = month.split('-').map(Number);
  const startDay = new Date(y, m - 1, 1).getDay(), count = new Date(y, m, 0).getDate();
  const grid = el('div', { className: 'cal' },
    ...['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳', 'שבוע'].map(h => el('div', { className: 'cal-h', textContent: h })));
  const cells = [...Array(startDay).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7) cells.push(null);
  for (let i = 0; i < cells.length; i += 7) {
    const row = cells.slice(i, i + 7);
    for (const d of row) {
      if (!d) { grid.append(el('div', { className: 'cal-d empty' })); continue; }
      const ts = list.filter(t => t.date === d), pnl = ts.reduce((s, t) => s + pnlOf(t), 0);
      const c = el('div', { className: 'cal-d' + (ts.length ? (pnl > 0 ? ' pos' : pnl < 0 ? ' neg' : ' flat') : '') + (d === localDate() ? ' today' : ''),
        title: ts.length ? `${fmtDate(d)} · ${ts.length} עסקאות · ${money(pnl)} · ${num(rSum(ts))}R` : fmtDate(d) },
        el('span', { className: 'cal-n', textContent: String(Number(d.slice(8))) }));
      if (ts.length) {
        c.append(el('b', { className: 'num', textContent: fmtU(sumU(ts)) }),
          el('span', { className: 'cal-t', textContent: ts.length === 1 ? 'עסקה אחת' : ts.length + ' עסקאות' }));
        c.onclick = () => { $('#day').value = d; loadDayForms(); render(); showView('analyses'); };
      }
      grid.append(c);
    }
    const wk = list.filter(t => row.includes(t.date)), wpnl = wk.reduce((s, t) => s + pnlOf(t), 0);
    grid.append(el('div', { className: 'cal-w' + (wk.length ? (wpnl > 0 ? ' pos' : wpnl < 0 ? ' neg' : '') : '') },
      ...(wk.length ? [el('b', { className: 'num', textContent: fmtU(sumU(wk)) }),
        el('span', { className: 'cal-t', textContent: (n => n === 1 ? 'יום אחד' : n + ' ימים')(new Set(wk.map(t => t.date)).size) })] : [el('span', { className: 'muted', textContent: '—' })])));
  }
  box.replaceChildren(grid);
}
// Where the money goes: the patterns from the review, counted for the chosen month.
function renderLeaks(list) {
  const sum = ts => ts.reduce((s, t) => s + pnlOf(t), 0);
  const row = (k, ts, bad = true) => [k, ts.length ? `${ts.length === 1 ? 'עסקה אחת' : ts.length + ' עסקאות'} · ${fmtU(sumU(ts))}` : '0', ts.length && bad ? 'warn' : ''];
  const rr = list.map(t => t.rr).filter(x => x != null);
  const early = list.filter(t => t.be === 'early');
  const missed = list.filter(t => t.hit === 'yes' && pnlOf(t) <= 0);
  const overRisk = list.filter(overSize);
  const risks = list.map(t => t.risk).filter(x => x != null);
  const undocumented = list.filter(t => !t.kind || !t.mind || t.stopPts == null);
  const box = $('#leaks');
  if (!list.length) { box.replaceChildren(el('p', { className: 'muted', textContent: 'אין עסקאות בתקופה הזו.' })); return; }
  box.replaceChildren(kv([
    row('עסקאות ששברו חוק', list.filter(t => t.kept === false)),
    row('עסקאות סתם (בגבולות החוקים, בלי תוכנית)', list.filter(t => t.kind === 'random')),
    row('הזזת סטופ אחורה', list.filter(t => mistakesOf(t).includes('stopBack'))),
    row('יציאה ידנית לפני הזמן', list.filter(t => mistakesOf(t).includes('manual'))),
    row('כניסה חוזרת אחרי סטופ או BE', list.filter(t => t.reentry === 'yes')),
    ['דחף לכניסה חוזרת: עמדתי בו / נכנסתי', `${[...days.values()].filter(d => inRange(d.date)).reduce((s, d) => s + (d.urgeHeld || 0), 0)}`
      + ` / ${list.filter(t => t.reentry === 'yes').length}`],
    row('עסקאות נגד המבנה של 15 דקות', list.filter(t => t.struct === 'against')),
    row('כניסה מתוך "אני בטוח" / FOMO / נקמה / פחד', list.filter(t => t.mind && t.mind !== 'calm')),
    [`פוזיציה גדולה מ־${S.maxContracts} מיקרו`, String(overRisk.length), overRisk.length ? 'warn' : ''],
    ['סיכון ממוצע לעסקה · הסיכון הכי גדול', risks.length ? `${money(avg(risks)).replace('+', '')} · ${money(Math.max(...risks)).replace('+', '')}` : '—'],
    ['יחס מתוכנן ממוצע (יעד: 2 ומעלה)', rr.length ? `1:${num(avg(rr), 1)} · ${rr.filter(x => x < 2).length} עסקאות מתחת ל־2` : '—',
      rr.length && avg(rr) < 2 ? 'warn' : ''],
    ['העברה לברייק איבן לפני 1R', String(early.length), early.length ? 'warn' : ''],
    ['ניצחונות שפספסתי (יצאתי, והמחיר הגיע ליעד)', String(missed.length), missed.length ? 'warn' : ''],
    ['עסקאות בלי ניהול עסקה מתועד', `${undocumented.length} מתוך ${list.length}`, undocumented.length ? 'warn' : ''],
  ]));
}
function renderDays() {
  const all = [...new Set([...processDays(), ...days.keys()])].filter(inRange).sort().reverse();
  $('#days-table tbody').replaceChildren(...all.map(d => {
    const x = analyzeDay(d);
    const td = (text, c = '') => el('td', { className: c, textContent: text });
    const row = el('tr', {}, td(d, 'num'), td(x.skipped ? 'דילגתי' : x.n ? 'סחרתי' : '—'),
      td(x.day.mood != null ? String(x.day.mood) : '—', 'num'), td(String(x.n), 'num'),
      td(x.score == null ? '—' : x.score.toFixed(0), 'num'), td(x.n ? fmtU(sumU(trades.filter(t => t.date === d))) : '—', 'num ' + cls(x.pnl)),
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
  $('#equity-title').textContent = `רווח/הפסד מצטבר (${unit === 'R' ? 'R' : '$'})`;
  const pts = list.length ? [{ y: 0, tip: 'התחלה · ' + fmtU(0) }, ...list.map(t => { const p = valOf(t); eq += p;
    return { y: eq, tip: `${t.date} · עסקה ${fmtU(p)} · מצטבר ${fmtU(eq)}` }; })] : [];
  lineChart($('#equity'), pts, { label: 'רווח/הפסד מצטבר', ref: 0,
    fmt: v => unit === 'R' ? num(v, 1) + 'R' : '$' + v.toLocaleString('en-US'),
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

function renderBars(sel, list, keysOf, order, inR = unit === 'R') {
  const groups = new Map();
  const fmt = v => inR ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + 'R' : money(v);
  list.forEach(t => keysOf(t).forEach(k => {
    const g = groups.get(k) || { n: 0, pnl: 0, wins: 0 };
    const p = inR ? rOf(t) || 0 : pnlOf(t); g.n++; g.pnl += p; if (pnlOf(t) > 0) g.wins++;
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
    const tipText = `${k}: ${fmt(g.pnl)} · ${g.n} עסקאות · ${(g.wins / g.n * 100).toFixed(0)}% הצלחה`;
    track.addEventListener('pointermove', e => showTip(e, tipText));
    track.addEventListener('pointerleave', hideTip);
    wrap.append(el('div', { textContent: k }), track,
      el('div', {}, el('span', { className: 'num', textContent: fmt(g.pnl) }),
        el('span', { className: 'sub', textContent: ` · ${g.n} · ${(g.wins / g.n * 100).toFixed(0)}%` })));
  });
  box.replaceChildren(wrap);
}

/* ---------- journal ---------- */
const rulesLabel = t => pendingOf(t) ? '● להשלמה' : t.kept === false ? '✗ ' + ((t.broken || []).length ? 'חוק ' + t.broken.join(', ') : 'נשבר חוק')
  : t.kind === 'random' ? '~ סתם' : t.kind === 'plan' ? '✓ תוכנית' : t.kept === true ? '✓ עמדתי' : '—';
function renderPending() {
  const pend = trades.filter(pendingOf).sort(byTime);
  const box = $('#pending');
  box.hidden = !pend.length;
  if (!pend.length) return;
  box.replaceChildren(el('span', { textContent: (pend.length === 1 ? 'עסקה אחת מ־Tradovate מחכה' : pend.length + ' עסקאות מ־Tradovate מחכות')
    + ' להשלמה: סוג העסקה, מה עבר לי בראש והסטופ. עד אז ' + (pend.length === 1 ? 'היא לא נכנסת' : 'הן לא נכנסות') + ' לציון.' }),
    el('button', { type: 'button', className: 'primary', textContent: 'להשלמת הבאה', onclick: () => openForm(pend[0]) }));
}
function renderTable(list) {
  renderPending();
  const body = $('#trades-table tbody');
  body.replaceChildren();
  $('#empty').hidden = list.length > 0;
  list.forEach(t => {
    const p = pnlOf(t), r = rOf(t);
    const td = (text, c = '') => el('td', { className: c, textContent: text });
    const actions = el('td', {},
      el('button', { className: 'link', textContent: 'פרטים', onclick: () => { openDetail = openDetail === t.id ? null : t.id; render(); } }),
      el('button', { className: 'link', textContent: 'עריכה', onclick: () => openForm(t) }),
      el('button', { className: 'link', textContent: 'מחיקה', onclick: async () => {
        if (confirm('למחוק את העסקה?')) { await store('trades', 'readwrite', s => s.delete(t.id)); await refresh(); } } }));
    body.append(el('tr', {},
      td('#' + numbering.get(t.id), 'num muted'), td(DAYS[new Date(t.date + 'T12:00').getDay()]), td(t.date + (t.time ? ' ' + t.time : ''), 'num'), el('td', {}, el('span', { className: 'ltr', textContent: t.symbol }), ...(acctOf(t) === 'demo' ? [' ', el('span', { className: 'res demo', textContent: 'דמו' })] : [])), td(DIR[t.dir] || ''),
      el('td', {}, el('span', { className: 'res ' + resultOf(t)[0], textContent: resultOf(t)[1] })),
      td(money(p), 'num ' + cls(p)), td(r == null ? '—' : num(r) + 'R', 'num'), td(pendingOf(t) ? '—' : String(scoreOf(t)), 'num'),
      td(rulesLabel(t), pendingOf(t) ? 'pending' : t.kept === false ? 'warn' : t.kind === 'random' ? 'random' : t.kept === true ? 'ok' : ''),
      el('td', { className: 'pic' }, ...(t.images && t.images.length ? [el('img', { src: t.images[0], alt: 'תמונת העסקה', title: 'לחץ להגדלה',
        onclick: () => view(t.images[0]) }), ...(t.images.length > 1 ? [el('span', { className: 'muted', textContent: ' +' + (t.images.length - 1) })] : [])] : ['—'])),
      actions));
    if (openDetail === t.id) {
      const cell = el('td', { colSpan: 12 });
      const line = (k, v) => v ? cell.append(el('p', {}, el('b', { textContent: k + ': ' }), v)) : null;
      line('סוג העסקה', kindOf(t) ? kindLabel(t) + ((t.randomWhy || []).length
        ? ' · ' + t.randomWhy.map(w => (RANDOM_WHY.find(o => o[0] === w) || [, w])[1]).join(', ') : '') : '');
      line('טעויות בניהול', mistakesOf(t).map(m => (MISTAKES.find(o => o[0] === m) || [, m])[1]).join(' · '));
      if (t.src === 'tradovate') line('מ־Tradovate', [t.entryPrice != null && `כניסה ${t.entryPrice} → יציאה ${t.exitPrice}`,
        t.qty != null && `${t.qty} חוזים`, t.fees ? 'עמלות ' + money(-t.fees) : '', t.time && t.exitTime && `${t.time}–${t.exitTime}`,
        t.tvAccount && 'חשבון ' + t.tvAccount].filter(Boolean).join(' · '));
      line('ניהול העסקה', [t.setup && 'סטאפ: ' + t.setup, t.qty != null && `${t.qty} חוזים`, t.stopPts != null && `סטופ ${t.stopPts} נק׳`, t.risk != null && 'סיכון: $' + t.risk, t.rr != null && 'יחס: 1:' + t.rr,
        t.exitTime && 'יציאה ב־' + t.exitTime, ...Object.keys(Q).filter(k => t[k]).map(k => `${Q[k][0]}: ${qLabel(k, t[k])}`)]
        .filter(Boolean).join(' · '));
      line('חוקים שנשברו', (t.broken || []).map(b => `${b}. ${RULES()[b - 1]}`).join(' · '));
      line('חוקים מהרשימה הקודמת שנשברו', (t.oldBroken || []).join(' · '));
      line('מה אעשה אחרת', t.lesson);
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
  const last = trades.length ? [...trades].sort(byTime).at(-1) : null;
  e.date.value = t ? t.date : curDate();
  e.time.value = t ? t.time || '' : new Date().toTimeString().slice(0, 5);
  // Account and size carry over from the last trade; new trades are MNQ (one micro is the plan).
  const sym = t ? t.symbol : 'MNQ';
  if (sym && ![...e.symbol.options].some(o => o.value === sym)) e.symbol.append(new Option(sym, sym));
  e.symbol.value = [...e.symbol.options].some(o => o.value === sym) ? sym : 'MNQ';
  e.acct.value = t ? acctOf(t) : last ? acctOf(last) : 'real';
  e.qty.value = t ? t.qty ?? '' : last && last.qty != null ? last.qty : 1;
  e.stopPts.value = t && t.stopPts != null ? t.stopPts : '';
  e.dir.value = t ? t.dir : 'long';
  e.setup.value = t ? t.setup || '' : '';
  e.rr.value = t && t.rr != null ? t.rr : '';
  e.exitTime.value = t ? t.exitTime || '' : '';
  e.lesson.value = t ? t.lesson || '' : '';
  e.notes.value = t ? t.notes || '' : '';
  if (t) {
    const p = pnlOf(t), r = rOf(t);
    e.res.value = p > 0 ? 'win' : p < 0 ? 'loss' : 'be';
    e.amount.value = Math.abs(p);
    e.r.value = r == null ? '' : Math.abs(r);
    const k = kindOf(t);
    if (KIND[k]) e.kind.value = k;
    if (t.mind) e.mind.value = t.mind;
    if (t.hit) e.hit.value = t.hit;
  }
  const ms = t ? mistakesOf(t) : [];
  $$('#mistakes input').forEach(i => { i.checked = ms.includes(i.value); });
  $$('#random-why input').forEach(i => { i.checked = !!(t && (t.randomWhy || []).includes(i.value)); });
  $$('#broken input').forEach(i => { i.checked = !!(t && (t.broken || []).includes(Number(i.value))); });
  e.mind[0].required = true;
  $('.more').open = !!(t && (t.setup || t.rr != null || t.exitTime || t.lesson));
  images = [...((t && t.images) || [])];
  renderThumbs(); updateForm();
  $('#dlg').showModal();
}
// Dollars at risk = stop in points x dollars per point x contracts.
const riskOf = e => { const q = okNum(e.qty.value), s = okNum(e.stopPts.value);
  return q == null || s == null ? null : Math.abs(q) * Math.abs(s) * (POINT_VALUE[e.symbol.value] || 2); };
const okNum = s => { const v = parseNum(s); return v == null || isNaN(v) ? null : v; };
const checked = sel => $$(sel + ' input:checked').map(i => i.value);
// The score follows from the answers, so it can't be filled in generously.
function scoreFrom(t) {
  const ms = t.mistakes || [];
  return {
    setup: t.kind !== 'random',
    risk: t.stopPts != null && !overSize(t),
    stop: !ms.includes('stopBack'),
    noadd: !(t.broken || []).includes(5),
    calm: t.mind === 'calm',
    exit: !ms.includes('earlyBE') && !ms.includes('manual'),
  };
}
function readForm() {
  const e = $('#form').elements;
  const sign = e.res.value === 'loss' ? -1 : e.res.value === 'be' ? 0 : 1;
  const kind = e.kind.value || null;
  const mistakes = checked('#mistakes');
  const pnl = sign * Math.abs(parseNum(e.amount.value) || 0);
  const risk = riskOf(e) ?? (editing && editing.stopPts == null ? editing.risk ?? null : null);
  // R typed by hand wins; otherwise it is the result divided by the dollars at risk.
  const rTyped = okNum(e.r.value);
  const r = rTyped != null ? sign * Math.abs(rTyped) : risk ? Math.round(pnl / risk * 100) / 100 : null;
  const t = {
    id: editing ? editing.id : uid(), rv: RULES_VERSION,
    date: e.date.value, time: e.time.value, symbol: e.symbol.value, dir: e.dir.value, acct: e.acct.value || 'real',
    qty: okNum(e.qty.value) == null ? null : Math.abs(okNum(e.qty.value)),
    stopPts: okNum(e.stopPts.value) == null ? null : Math.abs(okNum(e.stopPts.value)),
    risk, pnl, r, kind, kept: kind == null ? null : kind !== 'broke',
    broken: kind === 'broke' ? checked('#broken').map(Number) : [],
    randomWhy: kind === 'random' ? checked('#random-why') : [],
    mind: e.mind.value || null, mistakes, hit: $('#q-hit').hidden ? null : e.hit.value || null,
    notes: e.notes.value.trim(), images,
    setup: e.setup.value.trim(), exitTime: e.exitTime.value, lesson: e.lesson.value.trim(),
    rr: okNum(e.rr.value) == null ? null : Math.abs(okNum(e.rr.value)),
    oldBroken: editing ? editing.oldBroken || [] : [],
    ...(editing ? Object.fromEntries(['ext', 'src', 'entryPrice', 'exitPrice', 'fees', 'tvAccount'].filter(k => editing[k] != null).map(k => [k, editing[k]])) : {}),
    // The same facts in the fields the dashboard already reads.
    reentry: mistakes.includes('reentry') ? 'yes' : 'no', struct: mistakes.includes('against') ? 'against' : 'with',
    be: mistakes.includes('earlyBE') ? 'early' : null,
    exit: mistakes.includes('manual') ? 'manual' : sign > 0 ? 'tp' : sign < 0 ? 'sl' : 'be',
  };
  t.score = scoreFrom(t);
  return t;
}
function updateForm() {
  const e = $('#form').elements;
  // Typing a minus sign (e.g. -1R or -50) marks the trade as a loss on its own.
  if (parseNum(e.amount.value) < 0 || parseNum(e.r.value) < 0) e.res.value = 'loss';
  const isBE = e.res.value === 'be';
  e.amount.required = !isBE;
  if (isBE) { e.amount.value = 0; e.r.value = 0; }
  const risk = riskOf(e), qty = okNum(e.qty.value), rr = okNum(e.rr.value);
  const over = overSize({ qty: qty == null ? null : Math.abs(qty), symbol: e.symbol.value });
  $('#risk-calc').textContent = risk == null ? '' : `סיכון בעסקה: $${risk.toLocaleString('en-US')}`;
  $('#random-box').hidden = e.kind.value !== 'random';
  $('#broken-box').hidden = e.kind.value !== 'broke';
  const ms = checked('#mistakes');
  // Only worth asking when the trade didn't reach the target.
  $('#q-hit').hidden = e.res.value === 'win' && !ms.includes('earlyBE') && !ms.includes('manual');
  $('#mg-warn').replaceChildren(...[
    over && `פוזיציה גדולה מהמותר (${S.maxContracts} מיקרו).`,
    rr != null && Math.abs(rr) < 2 && 'יחס מתוכנן מתחת ל־1:2.',
    ms.includes('reentry') && 'כניסה חוזרת לאותו רעיון: זה הרגע שבו נשברים אצלך חוקים.',
  ].filter(Boolean).map(x => el('div', { textContent: x })));
  for (const [n, eg] of [['qty', '1'], ['stopPts', '40'], ['rr', '2'], ['amount', '103 או ‎-103'], ['r', '2 או ‎-1']])
    e[n].setCustomValidity(isNaN(parseNum(e[n].value)) ? 'צריך מספר, למשל ' + eg : '');
  const t = readForm(), lost = SCORE.filter(([k]) => !t.score[k]);
  $('#score-line').replaceChildren('ציון העסקה: ', el('b', { className: 'num', textContent: scoreOf(t) + ' / 100' }),
    ...(lost.length ? [el('span', { className: 'muted', textContent: ' · ירד על: ' + lost.map(([, l, p]) => `${l} (−${p})`).join(', ') })] : []));
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
  const head = ['#', 'date', 'time', 'exit_time', 'symbol', 'direction', 'setup', 'contracts', 'stop_points', 'risk', 'planned_rr', 'pnl', 'R', 'score', 'kept_rules',
    'broken_rules', 'kind', 'random_why', 'mistakes', ...Object.keys(Q), 'notes', 'lesson'];
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = list.map(t => { const r = rOf(t); return [numbering.get(t.id), t.date, t.time, t.exitTime, t.symbol, t.dir, t.setup, t.qty, t.stopPts, t.risk, t.rr,
    pnlOf(t).toFixed(2), r == null ? '' : r.toFixed(2), scoreOf(t), t.kept == null ? '' : t.kept ? 'yes' : 'no',
    (t.broken || []).join('; '), kindOf(t) ? kindLabel(t) : '', (t.randomWhy || []).join('; '), mistakesOf(t).join('; '), ...Object.keys(Q).map(k => t[k] ? qLabel(k, t[k]) : ''), t.notes, t.lesson].map(q).join(','); });
  return '﻿' + [head.join(','), ...rows].join('\r\n');
}

/* ---------- import from Tradovate ---------- */
// Dollars per point for the contracts a Tradovate file may hold.
Object.assign(POINT_VALUE, { M2K: 5, RTY: 50, MYM: 0.5, YM: 5, MGC: 10, GC: 100, MCL: 100, CL: 1000 });
const TV_ZONES = [['local', 'שעון המחשב שלך'], ['America/New_York', 'שעון ניו יורק'], ['America/Chicago', 'שעון שיקגו'], ['UTC', 'UTC']];
let tvFile = null;    // executions read from the chosen file
let tvState = {};     // zone, acct, fee, fileAcct, auto
const tvGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const tvSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
const hkey = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const pad2 = n => String(n).padStart(2, '0');
// "04/23/2024 09:11:54" (Tradovate), "4/23/24 9:11 PM", "2024-04-23 09:11:54", or ISO with a zone.
function parseStamp(s, dmy) {
  s = String(s || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (m) {
    const st = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
    if (m[7]) st.abs = Date.parse(s.replace(' ', 'T'));
    return st;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(s);
  if (!m) return null;
  const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  let h = +m[4]; if (m[7]) { h %= 12; if (/pm/i.test(m[7])) h += 12; }
  const [mo, d] = dmy ? [+m[2], +m[1]] : [+m[1], +m[2]];
  return { y, mo, d, h, mi: +m[5], s: +(m[6] || 0) };
}
function wallIn(zone, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
const asUtc = w => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
// A time read in `zone`, as the clock on this computer shows it.
function toLocal(st, zone) {
  let w = st;
  if (st.abs != null || zone !== 'local') {
    let ms = st.abs;
    if (ms == null) { const g = asUtc(st); ms = g - (asUtc(wallIn(zone, g)) - g); ms = g - (asUtc(wallIn(zone, ms)) - ms); }
    const d = new Date(ms);
    w = { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
  }
  return { date: `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`, time: `${pad2(w.h)}:${pad2(w.mi)}`, key: asUtc(w) };
}
const rootOf = (product, contract) => {
  const p = String(product || '').trim().toUpperCase();
  if (p) return p;
  const c = String(contract || '').trim().toUpperCase(), m = /^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/.exec(c);
  return m ? m[1] : c;
};
const cmpId = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

// Reads an Orders (or Fills / Performance) export into executions: one row per fill.
function tvRead(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('empty');
  const head = rows[0].map(hkey);
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const cell = (r, ...idx) => { for (const i of idx) if (i >= 0 && r[i] != null && String(r[i]).trim() !== '') return String(r[i]).trim(); return ''; };
  const raw = [];
  let kind;
  if (col('buyprice') >= 0 && col('sellprice') >= 0 && col('boughttimestamp') >= 0 && col('soldtimestamp') >= 0) {
    // Performance: each row is a buy fill paired with a sell fill; split it back into the two fills.
    kind = 'Performance';
    const c = { sym: col('symbol', 'contract'), qty: col('qty', 'quantity'), bp: col('buyprice'), sp: col('sellprice'),
      bt: col('boughttimestamp'), stt: col('soldtimestamp'), bid: col('buyfillid'), sid: col('sellfillid'), acct: col('account') };
    rows.slice(1).forEach((r, i) => {
      const qty = Math.abs(parseNum(cell(r, c.qty)));
      if (!qty) return;
      const base = { acct: cell(r, c.acct), contract: cell(r, c.sym), root: rootOf('', cell(r, c.sym)), qty };
      raw.push({ ...base, side: 1, price: parseNum(cell(r, c.bp)), t: cell(r, c.bt), id: cell(r, c.bid) || 'b' + i });
      raw.push({ ...base, side: -1, price: parseNum(cell(r, c.sp)), t: cell(r, c.stt), id: cell(r, c.sid) || 's' + i });
    });
  } else {
    kind = 'Orders';
    const c = { side: col('bs', 'side', 'buysell', 'action'), qty: col('filledqty', 'fillqty', 'qty', 'quantity'),
      price: [col('avgprice'), col('avgfillprice'), col('decimalfillavg'), col('fillprice'), col('price')],
      time: [col('filltime'), col('timestamp'), col('time'), col('datetime')], contract: col('contract', 'symbol'), product: col('product'),
      status: col('status'), acct: col('account'), id: col('orderid', 'fillid', 'id') };
    if (c.side < 0 || c.qty < 0 || c.price.every(i => i < 0) || c.time.every(i => i < 0) || (c.contract < 0 && c.product < 0)) throw new Error('format');
    for (const r of rows.slice(1)) {
      const status = cell(r, c.status), side = cell(r, c.side), qty = Math.abs(parseNum(cell(r, c.qty)));
      if (status && !/fill/i.test(status)) continue;          // canceled, rejected, working
      if (!/^(b|s)/i.test(side) || !qty || isNaN(qty)) continue;
      raw.push({ acct: cell(r, c.acct), contract: cell(r, c.contract) || cell(r, c.product), root: rootOf(cell(r, c.product), cell(r, c.contract)),
        side: /^b/i.test(side) ? 1 : -1, qty, price: parseNum(cell(r, ...c.price)), t: cell(r, ...c.time), id: cell(r, c.id) || String(raw.length) });
    }
  }
  // Day-first dates only if some date can't be month-first.
  const dmy = raw.some(x => { const m = /^(\d{1,2})\/(\d{1,2})\//.exec(x.t); return m && +m[1] > 12; });
  const execs = raw.map(x => ({ ...x, st: parseStamp(x.t, dmy) })).filter(x => x.st && isFinite(x.price));
  if (!execs.length) throw new Error('nofills');
  return { kind, execs, accounts: [...new Set(execs.map(x => x.acct).filter(Boolean))] };
}

// Pairs fills into trades: a trade runs from flat to flat, per account and contract.
function tvTrades(execs, zone, fee) {
  const xs = execs.map(x => ({ ...x, at: toLocal(x.st, zone) })).sort((a, b) => a.at.key - b.at.key || cmpId(a.id, b.id));
  const books = new Map(), out = [];
  for (const x of xs) {
    const k = x.acct + '|' + x.contract;
    const b = books.get(k) || { pos: 0, lots: [], cur: null };
    books.set(k, b);
    let q = x.qty;
    while (q > 0) {
      if (b.pos === 0 || Math.sign(b.pos) === x.side) {
        if (!b.cur) b.cur = { acct: x.acct, root: x.root, dir: x.side > 0 ? 'long' : 'short', start: x, end: x,
          openQty: 0, openVal: 0, closeQty: 0, closeVal: 0, pts: 0, maxPos: 0, ids: new Set() };
        b.lots.push({ qty: q, price: x.price });
        b.pos += x.side * q;
        b.cur.openQty += q; b.cur.openVal += q * x.price; b.cur.maxPos = Math.max(b.cur.maxPos, Math.abs(b.pos)); b.cur.ids.add(x.id);
        q = 0;
      } else {
        const lot = b.lots[0], c = Math.min(q, lot.qty);
        b.cur.pts += (x.price - lot.price) * c * (b.pos > 0 ? 1 : -1);
        b.cur.closeQty += c; b.cur.closeVal += c * x.price; b.cur.end = x; b.cur.ids.add(x.id);
        lot.qty -= c; q -= c; b.pos += x.side * c;
        if (!lot.qty) b.lots.shift();
        if (b.pos === 0) { out.push(b.cur); b.cur = null; }
      }
    }
  }
  const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
  const trades = out.map(c => {
    const pv = POINT_VALUE[c.root];
    const gross = pv ? round(c.pts * pv, 2) : null, fees = round((fee || 0) * c.closeQty, 2);
    return { key: 'tv:' + c.acct + ':' + [...c.ids].sort(cmpId).join('-'), acct: c.acct, symbol: c.root, dir: c.dir,
      date: c.start.at.date, time: c.start.at.time, exitTime: c.end.at.time, qty: c.maxPos, contracts: c.closeQty,
      entryPrice: round(c.openVal / c.openQty, 4), exitPrice: round(c.closeVal / c.closeQty, 4),
      gross, fees, pnl: gross == null ? null : round(gross - fees, 2) };
  });
  const open = [...books.values()].filter(b => b.pos !== 0).length;
  return { trades, open };
}

// What each imported trade does in the journal: new, joins a trade logged by hand, updates, or is already there.
function tvPlan(list) {
  const used = new Set();
  return list.map(x => {
    const near = t => mins(t.time) == null || mins(x.time) == null ? Infinity : Math.abs(mins(t.time) - mins(x.time));
    let target = trades.find(t => t.ext === x.key && !used.has(t.id));
    if (!target) target = trades.filter(t => !used.has(t.id) && t.date === x.date && t.dir === x.dir && acctOf(t) === tvState.acct
      && (t.ext ? t.src === 'tradovate' && near(t) <= 1 && t.exitTime === x.exitTime : near(t) <= 10))
      .sort((a, b) => near(a) - near(b))[0];
    if (target) used.add(target.id);
    let action = !target ? 'new' : target.ext ? 'update' : 'merge';
    if (action === 'update' && target.pnl === x.pnl && target.qty === x.qty && target.time === x.time && target.exitTime === x.exitTime
      && target.ext === x.key && target.fees === x.fees) action = 'same';
    return { x, action, target };
  });
}
function tvCurrent() {
  const all = tvTrades(tvFile.execs, tvState.zone, tvState.fee);
  const list = all.trades.filter(x => tvState.fileAcct === 'all' || x.acct === tvState.fileAcct);
  return { list, open: all.open, plan: tvPlan(list) };
}
async function tvOpen(file) {
  const box = $('#tv-preview');
  try { tvFile = tvRead(await file.text()); }
  catch (err) {
    tvFile = null;
    box.replaceChildren(el('p', { className: 'warn', textContent: err.message === 'nofills'
      ? 'לא נמצאו בקובץ עסקאות שבוצעו (רק פקודות שבוטלו או ממתינות).'
      : 'הקובץ לא נראה כמו דוח Orders של Tradovate. ודא שהורדת מהלשונית Orders. אם זה כן הקובץ הנכון, שלח לי אותו ואתאים את הייבוא.' }));
    return;
  }
  // The file doesn't say which clock it uses: pick the one that lines up with trades already in the journal.
  const remembered = tvGet('tj-tz', 'local');
  const last = trades.length ? [...trades].sort(byTime).at(-1) : null;
  tvState = { acct: last ? acctOf(last) : 'real', fileAcct: 'all', fee: Math.max(0, parseNum(tvGet('tj-fee', '0')) || 0), del: new Set() };
  const fits = TV_ZONES.map(([z]) => [z, tvPlan(tvTrades(tvFile.execs, z, 0).trades).filter(p => p.action !== 'new').length])
    .sort((a, b) => b[1] - a[1] || (a[0] === remembered ? -1 : b[0] === remembered ? 1 : 0));
  Object.assign(tvState, { zone: fits[0][1] > 0 ? fits[0][0] : remembered, auto: fits[0][1] > 0 });
  tvRender();
}
function tvRender() {
  const box = $('#tv-preview');
  if (!tvFile) { box.replaceChildren(); return; }
  const { list, open, plan } = tvCurrent();
  const dates = list.map(x => x.date).sort();
  const sel = (label, value, opts, onChange) => el('label', {}, label, (() => {
    const s = el('select', {}, ...opts.map(([v, t]) => el('option', { value: v, textContent: t })));
    s.value = value; s.onchange = () => onChange(s.value); return s;
  })());
  const feeInput = el('input', { type: 'text', inputMode: 'decimal', dir: 'ltr', value: tvState.fee ? String(tvState.fee) : '', placeholder: '0' });
  feeInput.onchange = () => { tvState.fee = Math.max(0, parseNum(feeInput.value) || 0); tvSet('tj-fee', String(tvState.fee)); tvRender(); };
  const controls = el('div', { className: 'fgrid' },
    sel('השעות בקובץ לפי' + (tvState.auto ? ' (זוהה אוטומטית)' : ''), tvState.zone, TV_ZONES,
      v => { tvState.zone = v; tvState.auto = false; tvSet('tj-tz', v); tvRender(); }),
    sel('חשבון ביומן', tvState.acct, [['real', 'אמיתי'], ['demo', 'דמו']], v => { tvState.acct = v; tvRender(); }),
    ...(tvFile.accounts.length > 1 ? [sel('חשבון בקובץ', tvState.fileAcct, [['all', 'כל החשבונות'], ...tvFile.accounts.map(a => [a, a])],
      v => { tvState.fileAcct = v; tvRender(); })] : []),
    el('label', {}, 'עמלה לחוזה, הלוך וחזור ($)', feeInput));
  const count = a => plan.filter(p => p.action === a).length;
  const n = { new: count('new'), merge: count('merge'), update: count('update'), same: count('same') };
  const unknown = list.filter(x => x.pnl == null).length;
  const what = p => p.action === 'new' ? 'חדשה'
    : p.action === 'merge' ? `תתחבר לעסקה #${numbering.get(p.target.id)} שרשמת (${p.target.time})`
    : p.action === 'update' ? `תתעדכן (#${numbering.get(p.target.id)})` : 'כבר ביומן';
  const td = (t, c = '') => el('td', { className: c, textContent: t });
  const table = el('div', { className: 'table-wrap' }, el('table', { className: 'tv-table' },
    el('thead', {}, el('tr', {}, ...['תאריך', 'כניסה', 'יציאה', 'מדד', 'כיוון', 'חוזים', 'מחיר כניסה', 'מחיר יציאה', 'רווח/הפסד', 'ביומן'].map(h => el('th', { textContent: h })))),
    el('tbody', {}, ...plan.map(p => el('tr', { className: 'tv-' + p.action },
      td(fmtDate(p.x.date), 'num'), td(p.x.time, 'num'), td(p.x.exitTime, 'num'), td(p.x.symbol, 'ltr'), td(DIR[p.x.dir]),
      td(String(p.x.qty), 'num'), td(String(p.x.entryPrice), 'num'), td(String(p.x.exitPrice), 'num'),
      td(p.x.pnl == null ? 'לא ידוע' : money(p.x.pnl), 'num ' + cls(p.x.pnl || 0)), td(what(p)))))));
  const linked = new Set(plan.filter(p => p.target).map(p => p.target.id));
  // Only days the file has trades on: there a hand-logged trade may already be part of an imported one.
  const fileDays = new Set(dates);
  const orphans = trades.filter(t => !t.ext && acctOf(t) === tvState.acct && fileDays.has(t.date) && !linked.has(t.id)).sort(byTime);
  for (const id of [...tvState.del]) if (!orphans.some(t => t.id === id)) tvState.del.delete(id);
  const todo = n.new + n.merge + n.update + tvState.del.size;
  const go = el('button', { type: 'button', className: 'primary', disabled: !todo || unknown > 0,
    textContent: todo ? 'ייבוא: ' + [n.new && (n.new === 1 ? 'עסקה חדשה אחת' : n.new + ' עסקאות חדשות'),
      n.merge + n.update && (n.merge + n.update === 1 ? 'עדכון אחד' : n.merge + n.update + ' עדכונים'),
      tvState.del.size && (tvState.del.size === 1 ? 'מחיקה אחת' : tvState.del.size + ' מחיקות')].filter(Boolean).join(' · ') : 'אין מה לייבא' });
  go.onclick = async () => {
    const res = await tvApply(plan);
    tvFile = null;
    const lastDate = dates.at(-1);
    if (lastDate) month = lastDate.slice(0, 7);
    await refresh();
    box.replaceChildren(el('p', { className: 'ok', textContent: [res.added === 1 ? 'נוספה עסקה חדשה אחת' : `נוספו ${res.added} עסקאות חדשות`,
      res.updated === 1 ? 'עודכנה אחת' : `עודכנו ${res.updated}`, res.deleted ? (res.deleted === 1 ? 'נמחקה אחת כפולה' : `נמחקו ${res.deleted} כפולות`) : '']
      .filter(Boolean).join(', ') + '.' }),
      ...(res.added ? [el('p', { textContent: 'עכשיו נשאר להשלים אותן ביומן: סוג העסקה, מה עבר לי בראש והסטופ.' })] : []),
      el('button', { type: 'button', className: 'primary', textContent: 'ליומן', onclick: () => showView('journal') }));
  };
  box.replaceChildren(
    el('p', { className: 'tv-sum' }, `${tvFile.kind}: ${list.length === 1 ? 'עסקה סגורה אחת' : list.length + ' עסקאות סגורות'}`,
      ...(dates.length ? [' · ', el('span', { className: 'num', textContent: `${fmtDate(dates[0])}–${fmtDate(dates.at(-1))}` })] : []),
      ...(tvFile.accounts.length ? [' · חשבון ', el('span', { className: 'ltr', textContent: tvFile.accounts.join(', ') })] : [])),
    ...(open ? [el('p', { className: 'muted', textContent: 'יש בסוף הקובץ פוזיציה שעוד לא נסגרה. היא תיכנס בייבוא הבא, אחרי שתיסגר.' })] : []),
    ...(unknown ? [el('p', { className: 'warn', textContent: 'יש בקובץ חוזה שאני לא יודע כמה שווה בו נקודה. שלח לי את הקובץ ואוסיף אותו.' })] : []),
    controls,
    table,
    ...(orphans.length ? [el('div', { className: 'tv-orphans' },
      el('p', { className: 'warn', textContent: 'עסקאות שרשמת ביד בימים האלה ולא נמצאו בקובץ. אם עסקה כזו כבר כלולה בעסקה מהקובץ '
        + '(למשל כשהוספת חוזה לפוזיציה פתוחה), סמן אותה למחיקה כדי שלא תיספר פעמיים:' }),
      ...orphans.map(t => el('label', {}, el('input', { type: 'checkbox', checked: tvState.del.has(t.id),
        onchange: e => { e.target.checked ? tvState.del.add(t.id) : tvState.del.delete(t.id); tvRender(); } }),
        `#${numbering.get(t.id)} · ${fmtDate(t.date)} ${t.time || ''} · ${DIR[t.dir] || ''} · ${money(pnlOf(t))}`)))] : []),
    el('div', { className: 'row end' }, el('button', { type: 'button', className: 'ghost', textContent: 'ביטול', onclick: () => { tvFile = null; tvRender(); } }), go));
}
async function tvApply(plan) {
  let added = 0, updated = 0;
  for (const { x, action, target } of plan) {
    if (action === 'same') continue;
    const facts = { ext: x.key, src: 'tradovate', date: x.date, time: x.time, exitTime: x.exitTime, symbol: x.symbol, dir: x.dir,
      qty: x.qty, pnl: x.pnl, fees: x.fees, entryPrice: x.entryPrice, exitPrice: x.exitPrice, tvAccount: x.acct };
    if (target) {
      const t = { ...target, ...facts };
      // A stop written by hand gives the real R with the exact result.
      if (t.stopPts != null) { t.risk = t.stopPts * (POINT_VALUE[t.symbol] || 2) * (t.qty || 1); t.r = Math.round(t.pnl / t.risk * 100) / 100; }
      if (t.kind) t.score = scoreFrom(t);
      await put('trades', t); updated++;
    } else {
      await put('trades', { id: uid(), rv: RULES_VERSION, ...facts, acct: tvState.acct, r: null, risk: null, stopPts: null,
        kind: null, kept: null, broken: [], randomWhy: [], mind: null, mistakes: [], hit: null, notes: '', images: [],
        setup: '', lesson: '', rr: null, score: {}, oldBroken: [] });
      added++;
    }
  }
  let deleted = 0;
  for (const id of tvState.del) { await store('trades', 'readwrite', s => s.delete(id)); deleted++; }
  return { added, updated, deleted };
}

/* ---------- render ---------- */
function showView(name) {
  $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x.dataset.view === name));
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
  $('#daybar').hidden = !['pre', 'rules'].includes(name);
}
function renderMonths() {
  const ms = [...new Set([localDate().slice(0, 7), ...trades.map(t => t.date.slice(0, 7)), ...[...days.keys()].map(d => d.slice(0, 7))])]
    .sort().reverse();
  $$('.acct-select').forEach(sel => { sel.value = acct; });
  for (const sel of $$('.month-select')) {
    sel.replaceChildren(...[...ms, 'all'].map(m => el('option', { value: m, textContent: monthName(m) })));
    sel.value = month;
  }
  const n = filtered().length;
  $('#month-count').textContent = month === 'all' ? `${trades.length} עסקאות סה״כ`
    : `${n === 1 ? 'עסקה אחת' : n + ' עסקאות'} ב${monthName(month)} · ${trades.length} עסקאות סה״כ מאז ההתחלה`;
  $('#setups').replaceChildren(...[...new Set(trades.map(t => t.setup).filter(Boolean))].sort().map(s => el('option', { value: s })));
}
function render() {
  const list = filtered();
  renderMonths(); renderPre(); renderAnalyses(); renderRules(); renderTable(list);
  renderTiles(list); renderCalendar(list); renderLeaks(list); renderPhase(); renderWeek(); renderScores(); renderEquity(list); renderDays();
  renderBars('#by-kept', list, t => [kindLabel(t)], [...Object.values(KIND), 'עמדתי בחוקים (לפני הסיווג)', 'לא סווג']);
  renderBars('#by-rule', list.filter(t => t.kept === false), t => (t.broken || []).length ? t.broken.map(b => 'חוק ' + b) : ['לא צוין']);
  renderBars('#by-dir', list, t => [DIR[t.dir] || '—'], ['לונג', 'שורט', 'ניטרלי']);
  renderBars('#by-mind', list.filter(t => t.mind), t => [qLabel('mind', t.mind)], Q.mind[1].map(o => o[1]));
  renderBars('#by-exit', list.filter(t => t.exit), t => [qLabel('exit', t.exit)], Q.exit[1].map(o => o[1]));
  const hours = [...new Set(list.filter(t => t.time).map(t => t.time.slice(0, 2)))].sort().map(h => `${h}:00–${h}:59`);
  renderBars('#by-hour', list.filter(t => t.time), t => [`${t.time.slice(0, 2)}:00–${t.time.slice(0, 2)}:59`], hours);
  renderBars('#by-day', list, t => [DAYS[new Date(t.date + 'T12:00').getDay()]], DAYS);
}
async function refresh() {
  trades = (await store('trades', 'readonly', s => s.getAll())).map(migrateTrade);
  days = new Map((await store('days', 'readonly', s => s.getAll())).map(d => [d.date, migrateDay(d)]));
  // Trade numbers run in time order over all trades, so #1 is the first trade ever logged.
  numbering = new Map([...trades].sort(byTime).map((t, i) => [t.id, i + 1]));
  render();
}

async function init() {
  db = await openDb();
  const chips = (sel, opts) => $(sel).replaceChildren(...opts.map(([v, t]) => el('label', {}, el('input', { type: 'checkbox', value: v }), t)));
  chips('#mistakes', MISTAKES);
  chips('#random-why', RANDOM_WHY);
  $('#broken').replaceChildren(...RULES().map((r, i) => el('label', {}, el('input', { type: 'checkbox', value: String(i + 1) }), `${i + 1}. ${r}`)));
  $$('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $$('.month-select').forEach(sel => sel.addEventListener('change', () => { month = sel.value; render(); }));
  $$('.acct-select').forEach(sel => sel.addEventListener('change', () => { acct = sel.value; render(); }));
  $$('#unit button').forEach(b => b.onclick = () => { unit = b.dataset.v; try { localStorage.setItem('tj-unit', unit); } catch {} render(); });
  for (const [k, [label, opts]] of Object.entries(Q)) {
    if (!$('#q-' + k)) continue;
    $('#q-' + k).replaceChildren(el('span', { className: 'q-label', textContent: label }),
      el('div', { className: 'seg' }, ...opts.map(([v, t]) => el('label', {}, el('input', { type: 'radio', name: k, value: v }), t))));
  }

  $('#day').value = localDate();
  $('#day').addEventListener('change', () => { if (!$('#day').value) $('#day').value = localDate(); loadDayForms(); render(); });

  // pre-market
  $$('#bias button').forEach(b => b.onclick = () => saveDay(curDate(), { bias: dayOf(curDate()).bias === b.dataset.v ? '' : b.dataset.v }));
  $('#bias-text').addEventListener('change', e => saveDay(curDate(), { biasText: e.target.value.trim() }));
  const toggle = (sel, key) => $$(sel + ' button').forEach(b => b.onclick = () =>
    saveDay(curDate(), { [key]: dayOf(curDate())[key] === b.dataset.v ? null : b.dataset.v }));
  toggle('#energy', 'energy');
  toggle('#headspace', 'headspace');
  for (const k of DAY_TEXT) $('#' + k).addEventListener('change', e => saveDay(curDate(), { [k]: e.target.value.trim() }));
  const setHtfImage = async files => { if (files[0]) await saveDay(curDate(), { htfImage: await compress(files[0]) }); };
  $('#htf-img').addEventListener('change', async e => { await setHtfImage(e.target.files); e.target.value = ''; });
  acceptImages($('#htf-card'), setHtfImage);
  const setAp = patch => saveDay(curDate(), { aplus: { ...(dayOf(curDate()).aplus || {}), ...patch } });
  $$('#ap-status button').forEach(b => b.onclick = () => setAp({ status: (dayOf(curDate()).aplus || {}).status === b.dataset.v ? null : b.dataset.v }));
  $('#ap-conf').addEventListener('change', e => setAp({ conf: e.target.value.trim() }));
  $('#ap-rr').addEventListener('change', e => { const v = parseNum(e.target.value); setAp({ rr: v == null || isNaN(v) ? null : Math.abs(v) }); });
  $('#ap-time').addEventListener('change', e => setAp({ time: e.target.value }));
  $('#ap-why').addEventListener('change', e => setAp({ why: e.target.value.trim() }));
  const setApImage = async files => { if (files[0]) await setAp({ image: await compress(files[0]) }); };
  $('#ap-img').addEventListener('change', async e => { await setApImage(e.target.files); e.target.value = ''; });
  acceptImages($('#ap-box'), setApImage);
  $$('#bias-result button').forEach(b => b.onclick = () =>
    saveDay(curDate(), { biasResult: dayOf(curDate()).biasResult === b.dataset.v ? null : b.dataset.v }));
  $('#review-text').addEventListener('change', e => saveDay(curDate(), { review: e.target.value.trim() }));
  const setReviewImage = async files => { if (files[0]) await saveDay(curDate(), { reviewImage: await compress(files[0]) }); };
  $('#rv-img').addEventListener('change', async e => { await setReviewImage(e.target.files); e.target.value = ''; });
  acceptImages($('#review-card'), setReviewImage);
  $$('#sc-type button').forEach(b => b.onclick = () => setSeg('#sc-type', b.dataset.v));
  const setScImage = async files => { if (files[0]) scImage = await compress(files[0]); renderScPreview(); };
  $('#sc-img').addEventListener('change', async e => { await setScImage(e.target.files); e.target.value = ''; });
  acceptImages($('#sc-card'), setScImage);
  $('#sc-cancel').onclick = resetScenarioForm;
  $('#sc-add').onclick = async () => {
    const text = $('#sc-text').value.trim();
    if (!text && !scImage) { $('#sc-text').focus(); return; }
    const date = curDate(), list = dayOf(date).scenarios || [];
    const s = { id: scEditing || uid(), type: getSeg('#sc-type') || 'long', text, image: scImage, inval: $('#sc-inval').value.trim() };
    const next = scEditing ? list.map(x => x.id === scEditing ? { ...x, ...s } : x) : [...list, s];
    resetScenarioForm();
    await saveDay(date, { scenarios: next });
  };

  // rules
  $('#mood').addEventListener('change', e => saveDay(curDate(),
    { mood: e.target.value === '' ? null : Math.max(1, Math.min(10, Math.round(Number(e.target.value)))) }));
  $('#feeling').addEventListener('change', e => saveDay(curDate(), { feeling: e.target.value.trim() }));
  $('#urge-held').onclick = () => saveDay(curDate(), { urgeHeld: (dayOf(curDate()).urgeHeld || 0) + 1 });
  $('#urge-undo').onclick = () => saveDay(curDate(), { urgeHeld: Math.max(0, (dayOf(curDate()).urgeHeld || 0) - 1) });
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

  // import from Tradovate
  $('#tv-file').addEventListener('change', async e => { const f = e.target.files[0]; if (f) await tvOpen(f); e.target.value = ''; });
  $('#tv-go').onclick = () => { showView('data'); $('#tv-card').scrollIntoView({ block: 'start' }); };

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
