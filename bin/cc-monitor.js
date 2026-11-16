#!/usr/bin/env node
'use strict';
const http = require('http');
const { PORT, paths, readConfig, writeConfig } = require('../src/config');

const args = process.argv.slice(2);
const cmd = args.includes('--help') || args.includes('-h') ? 'help' : args[0] && !args[0].startsWith('-') ? args[0] : 'start';
const flag = (f) => args.includes(f);
const URL = `http://127.0.0.1:${PORT}`;

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/ping`, { timeout: 600 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b).app === 'cc-monitor'); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function help() {
  console.log(`cc-monitor: live session monitor for Claude Code

  cc-monitor              start the server and open the monitor window
  cc-monitor install      add the hooks + status line to ~/.claude/settings.json (backed up first)
  cc-monitor uninstall    remove them again and restore your previous status line
  cc-monitor plan <name>  set the plan chip manually (pro | max | team | api | auto)
  cc-monitor notify on|off  desktop notification when a session needs you (off by default)
  cc-monitor status       show whether it is installed and running

  options:  --no-open (server only)   --capture (log raw payloads to ${paths.capture})
  port:     ${PORT} (override with CC_MONITOR_PORT)`);
}

async function start() {
  if (await ping()) {
    console.log(`cc-monitor is already running on ${URL}`);
    if (!flag('--no-open')) require('../src/open').openWindow(URL);
    return;
  }
  const { createServer } = require('../src/server');
  const srv = createServer({ capture: flag('--capture') });
  try { await srv.listen(); } catch (e) {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use by another program. Set CC_MONITOR_PORT to change it.` : e.message);
    process.exit(1);
  }
  console.log(`cc-monitor running on ${URL}  (Ctrl+C to stop)`);
  const settings = require('fs').existsSync(paths.settings) ? require('fs').readFileSync(paths.settings, 'utf8') : '';
  if (!settings.includes('.cc-monitor/bin/')) console.log('Not installed into Claude Code yet. Run: cc-monitor install');
  if (!flag('--no-open')) {
    const r = require('../src/open').openWindow(URL);
    console.log(r.appMode ? `Window opened with ${r.browser}` : `Opened in your ${r.browser}`);
  }
  const stop = () => { srv.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  switch (cmd) {
    case 'start': return start();
    case 'install': {
      const r = require('../src/install').install();
      console.log('cc-monitor installed into', paths.settings);
      if (r.backup) console.log('  backup:      ', r.backup);
      console.log('  hooks added: ', r.added.length ? r.added.join(', ') : '(already present)');
      console.log('  statusLine:  ', r.statusCmd);
      if (r.chained) console.log('  your previous status line is chained and still shown:', r.chained.command);
      console.log('Restart running Claude Code sessions (or open /hooks) to pick up the hooks. Then run: cc-monitor');
      return;
    }
    case 'uninstall': {
      const r = require('../src/install').uninstall();
      console.log('cc-monitor removed from', paths.settings);
      if (r.backup) console.log('  backup:        ', r.backup);
      console.log('  hooks removed: ', r.removed.length ? [...new Set(r.removed)].join(', ') : '(none found)');
      console.log('  statusLine:    ', r.restored ? 'restored to ' + r.restored.command : 'removed');
      return;
    }
    case 'plan': {
      const v = (args[1] || '').toLowerCase();
      const cfg = readConfig();
      if (!v || v === 'auto') delete cfg.plan; else cfg.plan = v;
      writeConfig(cfg);
      console.log(cfg.plan ? `plan set to ${cfg.plan.toUpperCase()}` : 'plan: auto-detect');
      return;
    }
    case 'notify': {
      const v = (args[1] || '').toLowerCase();
      const cfg = readConfig();
      if (v === 'on' || v === 'off') { cfg.notify = v === 'on'; writeConfig(cfg); }
      else if (v) { console.error('usage: cc-monitor notify on|off'); process.exit(1); }
      console.log(`desktop notifications: ${cfg.notify ? 'ON' : 'OFF'}`);
      if (cfg.notify) console.log('They fire once per block, only while the monitor window is not focused.\nThe first time, click "ENABLE NOTIFICATIONS" in the monitor window to allow them.');
      return;
    }
    case 'status': {
      const fs = require('fs');
      const s = fs.existsSync(paths.settings) ? fs.readFileSync(paths.settings, 'utf8') : '';
      console.log('installed:', s.includes('.cc-monitor/bin/') ? 'yes' : 'no', '|', 'server:', (await ping()) ? `running on ${URL}` : 'not running');
      console.log('plan:', require('../src/plan').detectPlan() || '—');
      return;
    }
    case 'help': case '--help': case '-h': return help();
    default: help(); process.exit(1);
  }
}

main();
