#!/usr/bin/env node
// cc-monitor status line. Claude Code pipes the session JSON on stdin.
// 1) forward it to the local cc-monitor server (fire and forget, 300ms max)
// 2) if the user had a statusLine before cc-monitor was installed, run it with
//    the same stdin and print its output; otherwise print a short line of our own.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.CC_MONITOR_PORT) || 4317;
setTimeout(() => process.exit(0), 4000).unref();

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cc-monitor', 'config.json'), 'utf8')); }
  catch { return {}; }
}

function forward(body) {
  return new Promise((resolve) => {
    try {
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: '/status', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 300,
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.on('error', resolve);
      req.end(body);
    } catch { resolve(); }
  });
}

function runChained(cmd, body) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return resolve(null); }
    const t = setTimeout(() => { try { child.kill(); } catch {} resolve(out || null); }, 3000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(t); resolve(null); });
    child.on('close', () => { clearTimeout(t); resolve(out); });
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

function pct(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v) + '%' : '—'; }

function ownLine(j) {
  const parts = [];
  const model = j.model && (j.model.display_name || j.model.id);
  parts.push(model || 'claude');
  const cw = j.context_window || {};
  if (cw.used_percentage != null) parts.push('ctx ' + pct(cw.used_percentage));
  const rl = j.rate_limits || {};
  if (rl.five_hour && rl.five_hour.used_percentage != null) parts.push('5h ' + pct(rl.five_hour.used_percentage));
  if (rl.seven_day && rl.seven_day.used_percentage != null) parts.push('wk ' + pct(rl.seven_day.used_percentage));
  return parts.join(' · ');
}

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('end', async () => {
  const cfg = readConfig();
  const chained = cfg.chainedStatusLine && cfg.chainedStatusLine.command;
  const [, chainedOut] = await Promise.all([
    body.trim() ? forward(body) : Promise.resolve(),
    chained ? runChained(chained, body) : Promise.resolve(null),
  ]);
  if (chained && chainedOut != null) {
    process.stdout.write(chainedOut);
  } else {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    process.stdout.write(ownLine(j));
  }
  process.exit(0);
});
