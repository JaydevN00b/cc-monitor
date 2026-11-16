'use strict';
// cc-monitor panel renderer. All displays are dot-matrix SVGs: lit dots vs dim #1D1D1D dots.
const C = { fg: '#F4F4F4', mute: '#8A8A8A', done: '#6A6A6A', dim: '#1D1D1D', accent: '#FF4D1A' };
const DASH = '—';

// 5x7 glyphs, rows top to bottom (same font as the approved design).
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};

let state = null;
let clockSkew = 0;
let connected = false;
let selected = null;
let ws = null;

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + clockSkew;
const pulseDelay = () => `animation-delay:-${(now() % 1600) / 1000}s`; // keep pulses in phase across re-renders
const dot = (cx, cy, r, fill, pulse) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${pulse ? ` class="breathe" style="${pulseDelay()}"` : ''}/>`;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clampPct = (v) => Math.max(0, Math.min(100, v));

function fmtTok(n) {
  if (!isNum(n)) return DASH;
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 || n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}
function clock(ms, long) {
  if (!isNum(ms) || ms < 0) return long ? '--:--:--' : '--:--';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (v) => String(v).padStart(2, '0');
  return h || long ? `${p(h)}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}
function hm(ms) {
  if (!isNum(ms)) return DASH;
  if (ms <= 0) return 'NOW';
  const m = Math.ceil(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}D ${h}H` : h ? `${h}H ${mm}M` : `${mm}M`;
}
function weekday(t) {
  if (!isNum(t)) return DASH;
  const d = new Date(t);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ dot displays
// Big percentage: 16px grid, r=5.6, one blank column/row of margin, glyph columns + 1 gap.
function bigPercent(pct) {
  const text = isNum(pct) ? `${Math.round(clampPct(pct))}%` : '--';
  const chars = text.split('');
  const cols = 1 + chars.length * 6, rows = 9;
  const lit = new Map();
  chars.forEach((ch, i) => {
    const g = FONT[ch];
    const color = ch === '%' || !isNum(pct) ? C.mute : C.fg;
    g.forEach((row, r) => [...row].forEach((b, c) => { if (b === '1') lit.set(`${1 + i * 6 + c},${r + 1}`, color); }));
  });
  let out = '';
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) out += dot(8 + c * 16, 8 + r * 16, 5.6, lit.get(`${c},${r}`) || C.dim);
  const w = cols * 16;
  return `<svg width="${Math.round(w * 1.17)}" style="max-width:100%" viewBox="0 0 ${w} 144" role="img" aria-label="${esc(text)}">${out}</svg>`;
}

// Two-row strip, filled column by column (top then bottom), 8px pitch, r=2.7.
function strip(pct, dots, label) {
  const cols = dots / 2;
  const n = isNum(pct) ? Math.round(clampPct(pct) / 100 * dots) : 0;
  let out = '';
  for (let c = 0; c < cols; c++) for (let r = 0; r < 2; r++) out += dot(4 + c * 8, 4 + r * 8, 2.7, c * 2 + r < n ? C.fg : C.dim);
  return `<svg width="100%" viewBox="0 0 ${cols * 8} 16" role="img" aria-label="${esc(label)}">${out}</svg>`;
}

function bar(share, cols, label) {
  const n = Math.round(Math.max(0, Math.min(1, share)) * cols);
  let out = '';
  for (let c = 0; c < cols; c++) out += dot(4 + c * 8, 4, 2.7, c < n ? C.fg : C.dim);
  return `<svg width="100%" viewBox="0 0 ${cols * 8} 8" role="img" aria-label="${esc(label)}">${out}</svg>`;
}

// 30 columns x 5 rows, newest column on the right in accent and pulsing.
function equalizer(buckets) {
  const max = Math.max(1, ...buckets);
  let out = '';
  buckets.forEach((v, c) => {
    const h = v > 0 ? Math.max(1, Math.round(v / max * 5)) : 0;
    const newest = c === buckets.length - 1;
    const color = newest ? C.accent : c >= buckets.length - 7 ? C.fg : C.mute;
    for (let r = 0; r < 5; r++) {
      const on = 5 - r <= h;
      out += dot(4 + c * 8, 4 + r * 8, 2.7, on ? color : C.dim, on && newest);
    }
  });
  return `<svg width="100%" viewBox="0 0 240 40" role="img" aria-label="Tokens per minute, last 30 minutes">${out}</svg>`;
}

function timeline(dots, color, label) {
  let out = '';
  dots.forEach((on, c) => { out += dot(4 + c * 8, 4, 2.7, on ? color : C.dim); });
  return `<svg width="100%" viewBox="0 0 ${dots.length * 8} 8" role="img" aria-label="${esc(label)}">${out}</svg>`;
}

// ------------------------------------------------------------------ sections
function header(v) {
  const t = now();
  const live = connected && v && v.live;
  const elapsed = v && v.startedAt ? (live ? t : v.lastActivity) - v.startedAt : null;
  const liveHtml = !connected
    ? `<span class="m">OFFLINE</span>`
    : live
      ? `<span class="breathe" style="width:8px;height:8px;border-radius:50%;background:${C.accent};${pulseDelay()}"></span>LIVE ${clock(elapsed, true)}`
      : `<span style="width:8px;height:8px;border-radius:50%;background:${C.done}"></span><span class="m">IDLE ${clock(elapsed, true)}</span>`;
  const plan = (v && v.plan) || (state && state.plan);
  const sessions = (state && state.sessions) || [];
  const tabs = sessions.length > 1
    ? `<div class="tabs" role="tablist">
        <button class="tab ${state.auto ? 'on' : ''}" data-sel="" title="Follow the most recently active session">AUTO</button>
        ${sessions.map((s) => ({ ...s, label: sessions.filter((o) => o.project === s.project).length > 1 ? `${s.project}·${s.id.slice(0, 4)}` : s.project })).map((s) => `<button class="tab trunc ${!state.auto && v && v.id === s.id ? 'on' : ''}" data-sel="${esc(s.id)}" title="${esc(s.project)} · ${esc(s.id)}">${esc(s.label)}</button>`).join('')}
      </div>` : '';
  return `
  <div class="row" style="align-items:center;height:40px">
    <span class="grot trunc" style="font-size:24px;font-weight:700;letter-spacing:-.02em" title="${esc(v && v.sessionName || '')}">${esc(v ? v.project : 'cc-monitor')}</span>
    <div class="mono num" style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:${C.accent};flex:none">${liveHtml}</div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
    <span class="chip ${plan ? 'fill' : 'ghost'}">${esc(plan || 'PLAN ' + DASH)}</span>
    <span class="chip">${esc((v && v.model) || DASH)}</span>
    <span class="lbl trunc" style="margin-left:auto">BRANCH ${esc((v && v.branch) || DASH)}</span>
  </div>${tabs}`;
}

function fiveHour(v) {
  const f = v && v.fiveHour;
  return `<div style="margin-top:22px">
    <div class="row" style="margin-bottom:10px"><span class="lbl">5-hour limit</span><span class="lbl">RESETS IN <span class="w">${f && f.resetsAt ? hm(f.resetsAt - now()) : DASH}</span></span></div>
    ${bigPercent(f ? f.pct : null)}
  </div>`;
}

function weekly(v) {
  const w = v && v.weekly;
  return `<div class="sep">
    <div class="row" style="margin-bottom:10px"><span class="lbl">Weekly limit</span><span class="mono num" style="font-size:12px"><span class="b">${w ? Math.round(w.pct) + '%' : DASH}</span> <span class="m">RESETS ${w && w.resetsAt ? weekday(w.resetsAt) : DASH}</span></span></div>
    ${strip(w ? w.pct : null, 100, `Weekly limit ${w ? Math.round(w.pct) : 'unknown'} percent used`)}
  </div>`;
}

function contextAndTpm(v) {
  const c = v && v.context;
  const tpm = (v && v.tpm) || { buckets: new Array(30).fill(0), now: null };
  return `<div class="sep" style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
    <div>
      <div class="row" style="margin-bottom:10px"><span class="lbl">Context</span><span class="mono num b" style="font-size:12px">${c && isNum(c.pct) ? Math.round(c.pct) + '%' : DASH}</span></div>
      ${strip(c ? c.pct : null, 50, `Context ${c && isNum(c.pct) ? Math.round(c.pct) : 'unknown'} percent`)}
      <div class="mono num m" style="font-size:11px;margin-top:8px">${c ? fmtTok(c.used) : DASH} / ${c ? fmtTok(c.size) : DASH}</div>
    </div>
    <div>
      <div class="row" style="margin-bottom:10px"><span class="lbl">Tokens/min</span><span class="mono num b a" style="font-size:12px">${v ? fmtTok(tpm.now) : DASH}</span></div>
      ${equalizer(tpm.buckets)}
    </div>
  </div>`;
}

function models(v) {
  const list = (v && v.models) || [];
  const rows = list.length ? list.map((m) => `
      <div class="mono trunc w" style="font-size:12px" title="${esc(m.name)}">${esc(m.name)}</div>
      <div>${bar(m.share, 30, `${m.name} ${Math.round(m.share * 100)} percent of tokens`)}</div>
      <div class="mono num" style="font-size:12px;text-align:right">${Math.round(m.share * 100)}%</div>`).join('')
    : `<div class="mono m" style="font-size:12px">${DASH}</div><div>${bar(0, 30, 'no tokens yet')}</div><div class="mono m" style="font-size:12px;text-align:right">${DASH}</div>`;
  return `<div class="sep">
    <div class="row" style="margin-bottom:8px"><span class="lbl">Models · share of tokens</span><span class="mono" style="font-size:12px"><span class="b">${list.length || DASH}</span> <span class="m">IN USE</span></span></div>
    <div style="display:grid;grid-template-columns:100px 1fr 40px;row-gap:6px;column-gap:12px;align-items:center">${rows}</div>
  </div>`;
}

function agents(v) {
  const list = (v && v.agents) || [];
  const subs = list.filter((a) => !a.main);
  const running = subs.filter((a) => a.running).length;
  const done = subs.length - running;
  const t = now();
  const rows = list.map((a) => {
    const color = a.main ? C.fg : a.running ? C.accent : C.done;
    const end = a.main ? (v.live ? t : v.lastActivity) : a.running ? t : a.end;
    const el = a.start ? clock((end || t) - a.start) : '--:--';
    return `
      <div class="mono trunc" style="font-size:12px;color:${a.main || a.running ? C.fg : C.mute}" title="${esc(a.description || a.name)}">${esc(a.name)}</div>
      <div class="mono trunc m" style="font-size:10px">${esc(a.model || DASH)}</div>
      <div>${timeline(a.dots, color, `${a.name} activity`)}</div>
      <div class="mono num" style="font-size:11px;text-align:right;color:${!a.main && a.running ? C.accent : C.mute}">${el}</div>`;
  }).join('');
  return `<div class="sep">
    <div class="row" style="margin-bottom:8px"><span class="lbl">Agents</span><span class="mono" style="font-size:12px"><span class="b" style="color:${running ? C.accent : C.fg}">${running}</span> <span class="m">RUNNING · ${done} DONE</span></span></div>
    <div style="display:grid;grid-template-columns:92px 48px 1fr 48px;row-gap:6px;column-gap:8px;align-items:center">${rows || `<div class="mono m" style="font-size:12px">${DASH}</div>`}</div>
  </div>`;
}

function changes(v) {
  const ch = (v && v.changes) || { read: 0, edited: 0, written: 0, files: [] };
  const files = ch.files.slice(0, 12);
  const rows = files.map((f) => `
    <div class="mono" style="display:grid;grid-template-columns:1fr auto 72px;gap:14px;align-items:center;height:30px;font-size:12.5px">
      <span class="trunc" title="${esc(f.dir + f.base)}"><span class="m">${esc(f.dir)}</span><span class="w">${esc(f.base)}</span></span>
      <span class="num m"><span class="w">+${f.added}</span> −${f.removed}</span>
      <span style="text-align:right">${f.writing ? '<span class="chip fill">WRITING</span>' : '<span class="chip ghost">SAVED</span>'}</span>
    </div>`).join('');
  const more = ch.files.length > files.length ? `<div class="lbl" style="margin-top:6px">+${ch.files.length - files.length} MORE</div>` : '';
  return `<div class="sep">
    <div class="row" style="margin-bottom:4px"><span class="lbl">Changes</span><span class="mono" style="font-size:12px"><span class="b">${ch.files.length}</span> <span class="m">FILES</span></span></div>
    <div class="lbl" style="margin-bottom:6px">READ <span class="w">${ch.read}</span> · EDITED <span class="w">${ch.edited}</span> · WRITTEN <span class="w">${ch.written}</span></div>
    ${rows || `<div class="mono m" style="font-size:12px;height:30px;display:flex;align-items:center">No edits yet</div>`}${more}
  </div>`;
}

function emptyState() {
  return `<div class="empty mono m">
    WAITING FOR A CLAUDE CODE SESSION<br><br>
    1. <code>cc-monitor install</code> once<br>
    2. start or continue a <code>claude</code> session<br>
    3. this panel follows the most recently active session
  </div>`;
}

// ------------------------------------------------------------------ render
const cache = {};
function put(id, html) {
  if (cache[id] === html) return;
  cache[id] = html;
  document.getElementById(id).innerHTML = html;
}

function render() {
  const v = state && state.view;
  put('s-header', header(v));
  if (!v) {
    put('s-five', emptyState());
    ['s-week', 's-ctx', 's-models', 's-agents', 's-changes'].forEach((id) => put(id, ''));
    return;
  }
  put('s-five', fiveHour(v));
  put('s-week', weekly(v));
  put('s-ctx', contextAndTpm(v));
  put('s-models', models(v));
  put('s-agents', agents(v));
  put('s-changes', changes(v));
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sel]');
  if (!b) return;
  selected = b.dataset.sel || null;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'select', id: selected }));
});

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    connected = true;
    if (selected) ws.send(JSON.stringify({ type: 'select', id: selected }));
    render();
  };
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.type !== 'state') return;
    clockSkew = j.serverNow - Date.now();
    state = j;
    render();
  };
  ws.onclose = () => { connected = false; render(); setTimeout(connect, 2000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

render();
connect();
setInterval(render, 1000); // timers tick locally between server pushes
