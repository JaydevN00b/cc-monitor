'use strict';
// cc-monitor panel renderer. All displays are dot-matrix SVGs: lit dots vs dim #1D1D1D dots.
const C = { fg: '#F4F4F4', fg2: '#C8C8C8', mute: '#8A8A8A', done: '#6A6A6A', dim: '#1D1D1D', accent: '#FF4D1A' };
const DASH = '—';
const { layout: glyphLayout } = window.CCGlyphs;

let state = null;
let clockSkew = 0;
let connected = false;
let selected = new URLSearchParams(location.search).get('session') || null; // deep link: /?session=<id>
let ws = null;
const notified = new Set();   // block keys already notified (once per block)
let firstState = true;

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + clockSkew;
const phase = (ms) => `animation-delay:-${(now() % ms) / 1000}s`; // keep animations in phase across re-renders
const dot = (cx, cy, r, fill, pulse) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${pulse ? ` class="breathe" style="${phase(1600)}"` : ''}/>`;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clampPct = (v) => Math.max(0, Math.min(100, v));
const p2 = (v) => String(v).padStart(2, '0');

function fmtTok(n) {
  if (!isNum(n)) return DASH;
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 || n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}
function clock(ms, long) {
  if (!isNum(ms) || ms < 0) return long ? '--:--:--' : '--:--';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h || long ? `${p2(h)}:${p2(m)}:${p2(x)}` : `${p2(m)}:${p2(x)}`;
}
function hm(ms) {
  if (!isNum(ms)) return DASH;
  if (ms <= 0) return 'NOW';
  const m = Math.ceil(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}D ${h}H` : h ? `${h}H ${mm}M` : `${mm}M`;
}
// "3m", "45s", "1h 4m": wait time on tabs
function shortWait(ms) {
  if (!isNum(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
// "3m 12s": wait time in the alert strip
function longWait(ms) {
  if (!isNum(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : m ? `${m}m ${p2(s % 60)}s` : `${s}s`;
}
function weekday(t) {
  if (!isNum(t)) return DASH;
  const d = new Date(t);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function shorten(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
// "Bash(npm install express-rate-limit)"
function askLabel(b) {
  if (!b) return '';
  if (b.reason !== 'permission') return b.reason === 'question' ? 'QUESTION' : 'WAITING FOR YOUR INPUT';
  return b.tool ? `${b.tool}${b.command ? `(${shorten(b.command, 60)})` : ''}` : 'PERMISSION';
}

// ------------------------------------------------------------------ dot displays
// Big percentage: 16px grid, r=5.6. Layout (own columns per glyph, 1-column gaps) comes from glyphs.js.
function bigPercent(pct) {
  const text = isNum(pct) ? `${Math.round(clampPct(pct))}%` : '--';
  const L = glyphLayout(text);
  let out = '';
  for (let c = 0; c < L.cols; c++) for (let r = 0; r < L.rows; r++) {
    const ch = L.lit.get(`${c},${r}`);
    out += dot(8 + c * 16, 8 + r * 16, 5.6, ch ? (ch === '%' || !isNum(pct) ? C.mute : C.fg) : C.dim);
  }
  const w = L.cols * 16, h = L.rows * 16;
  return `<svg width="${Math.round(w * 1.17)}" height="${Math.round(h * 1.17)}" style="max-width:100%;height:auto" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(text)}">${out}</svg>`;
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
function tabs(v) {
  const sessions = (state && state.sessions) || [];
  if (sessions.length < 2) return '';
  const t = now();
  const label = (s) => (sessions.filter((o) => o.project === s.project).length > 1 ? `${s.project}·${s.id.slice(0, 4)}` : s.project);
  const html = sessions.map((s) => {
    const a = s.attention || { state: 'working' };
    const on = v && v.id === s.id;
    const tip = `${s.project} · ${a.state.replace('_', ' ')}${on && !state.auto ? ' · click again to follow the latest session' : ''}`;
    if (a.state === 'needs_you') {
      return `<button class="tab needs" data-sel="${esc(s.id)}" data-cur="${on ? 1 : 0}" title="${esc(tip)}"><span class="tdot pulse" style="${phase(1400)}"></span><span class="trunc">${esc(label(s))}</span><span class="wait">${shortWait(t - a.since)}</span></button>`;
    }
    if (a.state === 'your_turn') {
      return `<button class="tab turn ${on ? 'on' : ''}" data-sel="${esc(s.id)}" data-cur="${on ? 1 : 0}" title="${esc(tip)}"><span class="tdot hollow"></span><span class="trunc">${esc(label(s))}</span></button>`;
    }
    if (a.state === 'idle') {
      return `<button class="tab idle ${on ? 'on' : ''}" data-sel="${esc(s.id)}" data-cur="${on ? 1 : 0}" title="${esc(tip)}"><span class="tdot off"></span><span class="trunc">${esc(label(s))}</span></button>`;
    }
    return `<button class="tab work ${on ? 'on' : ''}" data-sel="${esc(s.id)}" data-cur="${on ? 1 : 0}" title="${esc(tip)}"><span class="tdot blink" style="${phase(1200)}"></span><span class="trunc">${esc(label(s))}</span></button>`;
  }).join('');
  return `<div class="tabs" role="tablist" aria-label="Sessions">${html}</div>`;
}

function header(v) {
  const t = now();
  const att = (v && v.attention) || { state: 'working' };
  const live = connected && v && v.live && att.state !== 'idle';
  const elapsed = v && v.startedAt ? (live ? t : v.lastActivity) - v.startedAt : null;
  let right;
  if (!connected) right = `<span class="m">OFFLINE</span>`;
  else if (att.state === 'needs_you') right = `<span class="blink" style="display:flex;align-items:center;gap:8px;${phase(1200)}"><span class="hdot"></span>WAITING ${clock(t - att.since)}</span>`;
  else if (live) right = `<span class="hdot breathe" style="${phase(1600)}"></span>LIVE ${clock(elapsed, true)}`;
  else right = `<span class="hdot" style="background:${C.done}"></span><span class="m">IDLE ${clock(elapsed, true)}</span>`;
  const plan = (v && v.plan) || (state && state.plan);
  return `
  <div class="row" style="align-items:center;height:40px">
    <span class="grot trunc" style="font-size:24px;font-weight:700;letter-spacing:-.02em" title="${esc(v && v.sessionName || '')}">${esc(v ? v.project : 'cc-monitor')}</span>
    <div class="mono num" style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:${C.accent};flex:none">${right}</div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
    <span class="chip ${plan ? 'fill' : 'ghost'}">${esc(plan || 'PLAN ' + DASH)}</span>
    <span class="chip">${esc((v && v.model) || DASH)}</span>
    <span class="lbl trunc" style="margin-left:auto">BRANCH ${esc((v && v.branch) || DASH)}</span>
  </div>${tabs(v)}`;
}

// Alert strips for *other* blocked sessions (oldest first) + the request card for the viewed one.
function alerts(v) {
  const t = now();
  const list = ((state && state.alerts) || []).filter((a) => !v || a.id !== v.id);
  let html = list.map((a) => `
    <div class="alert" role="alert">
      <div class="mono atitle"><span class="tdot pulse" style="background:#000;${phase(1400)}"></span><span class="trunc">${esc(String(a.project).toUpperCase())} NEEDS YOU</span></div>
      <button class="mono view" data-sel="${esc(a.id)}">VIEW →</button>
      <div class="mono adetail trunc">${esc(a.reason === 'permission' ? 'PERMISSION · ' + askLabel(a) : askLabel(a))} · ${longWait(t - a.since)}</div>
    </div>`).join('');

  const att = v && v.attention;
  if (att && att.state === 'needs_you' && att.block) {
    const b = att.block;
    const ago = clock(t - att.since);
    if (b.reason === 'permission') {
      html += `
      <div class="card">
        <div class="row"><span class="lbl" style="color:${C.accent}">PERMISSION REQUEST${b.count > 1 ? ` · 1 OF ${b.count}` : ''}</span><span class="lbl">ASKED ${ago} AGO</span></div>
        <div class="mono" style="font-size:15px;font-weight:700;margin-top:14px">${esc(b.tool || 'Tool')}</div>
        ${b.command ? `<div class="mono code">${esc(b.command)}</div>` : ''}
        <div class="row" style="margin-top:14px;gap:12px"><span class="lbl trunc">REQUESTED BY <span class="w" style="text-transform:none">${esc(b.agent || 'main')}</span>${b.model ? ` · <span style="text-transform:none">${esc(b.model)}</span>` : ''}</span><span class="lbl" style="flex:none">ANSWER IN TERMINAL</span></div>
      </div>`;
    } else {
      html += `
      <div class="card">
        <div class="row"><span class="lbl" style="color:${C.accent}">${b.reason === 'question' ? 'QUESTION' : 'WAITING FOR YOUR INPUT'}</span><span class="lbl">SINCE ${ago} AGO</span></div>
        <div class="mono code">${esc(b.message || 'Claude is waiting for your input')}</div>
        <div class="row" style="margin-top:14px"><span class="lbl">CLAUDE FINISHED AND IS WAITING</span><span class="lbl">REPLY IN TERMINAL</span></div>
      </div>`;
    }
  }

  // One-time permission prompt for desktop notifications (only when the user turned them on).
  if (state && state.notify && 'Notification' in window && Notification.permission === 'default') {
    html += `<button class="mono enable" id="enable-notify">ENABLE NOTIFICATIONS</button>`;
  }
  return html ? `<div style="margin-top:16px;display:flex;flex-direction:column;gap:10px">${html}</div>` : '';
}

function fiveHour(v) {
  const f = v && v.fiveHour;
  return `<div class="sep">
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
  const tot = (v && v.agentTotals) || { running: 0, blocked: 0, done: 0 };
  const t = now();
  const rows = list.map((a) => {
    const color = a.main ? C.fg : a.blocked || a.running ? C.accent : C.done;
    const end = a.end || t;
    const el = a.start ? clock(Math.max(0, end - a.start)) : '--:--';
    const active = a.main || a.running || a.blocked;
    const tip = [a.name, a.type !== a.name ? a.type : '', a.description, a.blocked ? 'waiting on you' : ''].filter(Boolean).join(' · ');
    return `
      <div class="mono trunc" style="font-size:12px;color:${active ? C.fg : C.mute};${a.main ? 'font-weight:700' : ''}" title="${esc(tip)}">${esc(a.name)}</div>
      <div class="mono trunc m" style="font-size:10px">${esc(a.model || DASH)}</div>
      <div>${timeline(a.dots, color, `${a.name} activity`)}</div>
      <div class="mono num ${a.blocked ? 'blink' : ''}" style="font-size:11px;text-align:right;color:${!a.main && (a.running || a.blocked) ? C.accent : C.mute}${a.blocked ? ';' + phase(1200) : ''}">${el}</div>`;
  }).join('');
  const head = tot.blocked
    ? `<span class="b" style="color:${C.accent}">${tot.blocked}</span> <span class="m">BLOCKED · ${tot.running} RUNNING${tot.done ? ` · ${tot.done} DONE` : ''}</span>`
    : `<span class="b" style="color:${tot.running ? C.accent : C.fg}">${tot.running}</span> <span class="m">RUNNING · ${tot.done} DONE</span>`;
  return `<div class="sep">
    <div class="row" style="margin-bottom:8px"><span class="lbl">Agents</span><span class="mono" style="font-size:12px">${head}</span></div>
    <div class="agents" style="display:grid;grid-template-columns:minmax(92px,150px) 48px 1fr 52px;row-gap:6px;column-gap:8px;align-items:center">${rows || `<div class="mono m" style="font-size:12px">${DASH}</div>`}</div>
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

// ------------------------------------------------------------------ title + desktop notifications
function updateTitle() {
  const n = ((state && state.alerts) || []).length;
  const title = n ? `● ${n} needs you · cc-monitor` : 'cc-monitor';
  if (document.title !== title) document.title = title;
}

function maybeNotify() {
  const list = (state && state.alerts) || [];
  const live = new Set(list.map((a) => `${a.id}:${a.since}`));
  for (const k of [...notified]) if (!live.has(k)) notified.delete(k); // forget resolved blocks
  if (firstState) { live.forEach((k) => notified.add(k)); firstState = false; return; } // no burst on open
  for (const a of list) {
    const key = `${a.id}:${a.since}`;
    if (notified.has(key)) continue;
    notified.add(key);
    if (!state.notify || !('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) continue;
    try {
      const n = new Notification(`${a.project} needs you`, {
        body: a.reason === 'permission' ? `Permission: ${askLabel(a)}` : askLabel(a).toLowerCase().replace(/^./, (c) => c.toUpperCase()),
        tag: key,
        silent: false,
      });
      n.onclick = () => { window.focus(); select(a.id); n.close(); };
    } catch { /* notifications unavailable */ }
  }
}

// ------------------------------------------------------------------ render
const cache = {};
function put(id, html) {
  if (cache[id] === html) return;
  cache[id] = html;
  const el = document.getElementById(id);
  // keep scroll positions of inner scrollers (agents list, command box) across re-renders
  const keep = [...el.querySelectorAll('.agents, .code')].map((n) => n.scrollTop);
  el.innerHTML = html;
  [...el.querySelectorAll('.agents, .code')].forEach((n, i) => { if (keep[i]) n.scrollTop = keep[i]; });
}

function render() {
  const v = state && state.view;
  updateTitle();
  put('s-header', header(v));
  put('s-alert', alerts(v));
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

function select(id) {
  selected = id || null;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'select', id: selected }));
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#enable-notify')) {
    Notification.requestPermission().then(() => { cache['s-alert'] = null; render(); });
    return;
  }
  const b = e.target.closest('[data-sel]');
  if (!b) return;
  // Clicking the tab you are already pinned to goes back to following the latest session.
  if (b.classList.contains('tab') && b.dataset.cur === '1' && state && !state.auto) return select(null);
  select(b.dataset.sel);
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
    if (state.auto && selected && !(state.sessions || []).some((s) => s.id === selected)) selected = null;
    maybeNotify();
    render();
  };
  ws.onclose = () => { connected = false; render(); setTimeout(connect, 2000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

render();
connect();
setInterval(render, 1000); // timers tick locally between server pushes
