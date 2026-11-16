'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Session } = require('./session');
const { detectPlan } = require('./plan');
const { paths, readConfig, PORT } = require('./config');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const GONE_MS = 30 * 60_000;         // sessions idle this long leave the tab bar (unless a permission is pending)
const DISCOVER_MS = 15 * 60_000;     // on startup, pick up transcripts touched in the last 15 min

function createServer({ port = PORT, capture = false, log = console.log } = {}) {
  const cfg = readConfig();
  const sessions = new Map();

  function getSession(id) {
    let s = sessions.get(id);
    if (!s) { s = new Session(id, { countCacheReads: cfg.countCacheReads }); sessions.set(id, s); }
    return s;
  }

  // Pick up sessions that were already running before cc-monitor started.
  function discover() {
    const root = path.join(paths.claudeDir, 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { return; }
    const now = Date.now();
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(root, d, f);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (now - st.mtimeMs > DISCOVER_MS) continue;
        const s = getSession(f.replace(/\.jsonl$/, ''));
        s.setTranscript(p);
      }
    }
  }

  function readBody(req, cb) {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { b += c; if (b.length > 20e6) req.destroy(); });
    req.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} cb(j); });
  }

  function ingest(kind, j) {
    if (!j || !j.session_id) return;
    if (capture) { try { fs.appendFileSync(paths.capture, JSON.stringify({ t: Date.now(), kind, body: j }) + '\n'); } catch {} }
    const s = getSession(j.session_id);
    if (kind === 'status') s.onStatus(j); else s.onHook(j);
    s.poll();
    schedule();
  }

  const server = http.createServer((req, res) => {
    const [url, qs] = req.url.split('?');
    if (req.method === 'POST' && (url === '/hook' || url === '/status')) {
      res.writeHead(204).end(); // answer immediately; forwarders must never wait on us
      return readBody(req, (j) => { try { ingest(url.slice(1), j); } catch (e) { log('ingest error:', e.message); } });
    }
    if (req.method === 'GET' && url === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ app: 'cc-monitor', pid: process.pid }));
      return;
    }
    if (req.method === 'GET' && url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot(new URLSearchParams(qs || '').get('session'))));
      return;
    }
    if (req.method === 'GET') {
      const file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
      if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
      fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end('not found');
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
      });
      return;
    }
    res.writeHead(405).end();
  });

  // Only accept WebSocket connections from our own page (blocks other local web pages).
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin || '';
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Liveness: Claude Code writes ~/.claude/sessions/<pid>.json for each interactive session
  // ({ pid, sessionId, ... }). Only those two fields are used; *.key files are never read.
  // A session whose process is gone is dropped, even if the terminal was closed abruptly.
  // Any session idle for GONE_MS leaves the bar, except one still waiting on a permission prompt.
  const pidOf = new Map();
  let livenessAt = 0;
  function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  function checkLiveness() {
    if (Date.now() - livenessAt < 3000) return;
    livenessAt = Date.now();
    const dir = path.join(paths.claudeDir, 'sessions');
    const current = new Map();
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        if (j.sessionId && j.pid) current.set(j.sessionId, Number(j.pid));
      } catch {}
    }
    for (const s of sessions.values()) {
      const pid = current.get(s.id);
      if (pid) { pidOf.set(s.id, pid); if (!alive(pid)) markEnded(s); }
      else if (pidOf.has(s.id)) markEnded(s); // its pid file disappeared: Claude Code exited
    }
  }
  function markEnded(s) { if (!s.ended) s.endSession(); }

  function liveSessions() {
    checkLiveness();
    const now = Date.now();
    return [...sessions.values()].filter((s) => {
      if (!s.lastActivity || s.ended) return false;
      const b = s.att.block();
      if (b && b.reason === 'permission' && pidOf.has(s.id)) return true; // truly blocked, process alive
      return now - s.lastActivity < GONE_MS;
    }).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  // Tabs: sessions that need you first (longest waiting first), then by most recent activity.
  function tabOrder(list, now) {
    const sums = list.map((s) => s.summary(now));
    const needs = sums.filter((x) => x.attention.state === 'needs_you').sort((a, b) => a.attention.since - b.attention.since);
    return [...needs, ...sums.filter((x) => x.attention.state !== 'needs_you')];
  }

  let notifyCache = { at: 0, on: false };
  function notifyOn() {
    if (Date.now() - notifyCache.at > 2000) notifyCache = { at: Date.now(), on: readConfig().notify === true };
    return notifyCache.on;
  }

  function snapshot(selected) {
    const now = Date.now();
    for (const s of sessions.values()) s.reapAgents(now);
    const list = liveSessions();
    const pick = (selected && list.find((s) => s.id === selected)) || list[0] || null;
    const tabs = tabOrder(list, now);
    const alerts = tabs.filter((t) => t.attention.state === 'needs_you')
      .map((t) => ({ id: t.id, project: t.project, since: t.attention.since, ...t.attention.block }));
    return {
      type: 'state',
      serverNow: now,
      auto: !selected || !pick || pick.id !== selected,
      sessions: tabs,
      alerts,
      notify: notifyOn(),
      view: pick ? pick.view(detectPlan()) : null,
      plan: detectPlan(),
    };
  }

  function broadcast() {
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      try { ws.send(JSON.stringify(snapshot(ws.selected))); } catch {}
    }
    for (const s of sessions.values()) s.dirty = false;
  }

  let timer = null;
  function schedule() { if (!timer) timer = setTimeout(() => { timer = null; broadcast(); }, 150); }

  wss.on('connection', (ws) => {
    ws.selected = null;
    ws.on('message', (m) => {
      let j; try { j = JSON.parse(m); } catch { return; }
      if (j.type === 'select') { ws.selected = j.id || null; ws.send(JSON.stringify(snapshot(ws.selected))); }
    });
    ws.send(JSON.stringify(snapshot(null)));
  });

  // Poll transcripts every second; push when anything changed, and at least every 5s
  // (keeps minute-based dot timelines rolling even when nothing happens).
  let lastPush = 0;
  const tick = setInterval(() => {
    let dirty = false;
    for (const s of liveSessions()) { s.poll(); dirty = dirty || s.dirty; }
    if (dirty || Date.now() - lastPush > 5000) { lastPush = Date.now(); broadcast(); }
  }, 1000);

  return {
    server, sessions, snapshot, getSession,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          discover();
          for (const s of sessions.values()) s.poll();
          resolve(port);
        });
      });
    },
    close() { clearInterval(tick); wss.close(); server.close(); },
  };
}

module.exports = { createServer };
