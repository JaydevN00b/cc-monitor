'use strict';
// install / uninstall cc-monitor into ~/.claude/settings.json
// - backs up settings.json before any change
// - copies the forwarder scripts to ~/.cc-monitor/bin (stable path, survives npx cache cleanup)
// - merges hooks (appends our entry per event, never removes others)
// - replaces statusLine with ours, remembering the previous one so it is chained and restored
const fs = require('fs');
const path = require('path');
const { paths, readConfig, writeConfig } = require('./config');

const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd'];
const MARKER = 'cc-monitor'; // every command we install contains this path segment

function q(p) { return '"' + p.replace(/\\/g, '/') + '"'; }

function readSettings() {
  if (!fs.existsSync(paths.settings)) return {};
  const raw = fs.readFileSync(paths.settings, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throw on invalid JSON: never overwrite a file we cannot parse
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
  const tmp = paths.settings + '.cc-monitor-tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, paths.settings);
}

function backup() {
  if (!fs.existsSync(paths.settings)) return null;
  fs.mkdirSync(paths.backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(paths.backups, `settings.${stamp}.json`);
  fs.copyFileSync(paths.settings, dest);
  return dest;
}

function isOurs(cmd) { return typeof cmd === 'string' && cmd.replace(/\\/g, '/').includes('/.' + MARKER + '/'); }

function copyForwarders() {
  fs.mkdirSync(paths.bin, { recursive: true });
  for (const f of ['hook.js', 'statusline.js']) {
    fs.copyFileSync(path.join(__dirname, '..', 'forwarders', f), path.join(paths.bin, f));
  }
}

function install() {
  const settings = readSettings();
  const bak = backup();
  copyForwarders();
  const hookCmd = 'node ' + q(path.join(paths.bin, 'hook.js'));
  const statusCmd = 'node ' + q(path.join(paths.bin, 'statusline.js'));

  settings.hooks = settings.hooks || {};
  const added = [];
  for (const ev of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const already = list.some((g) => (g.hooks || []).some((h) => isOurs(h.command)));
    if (!already) {
      const group = { hooks: [{ type: 'command', command: hookCmd, timeout: 5 }] };
      if (ev === 'PreToolUse' || ev === 'PostToolUse') group.matcher = '*';
      list.push(group);
      added.push(ev);
    }
    settings.hooks[ev] = list;
  }

  const cfg = readConfig();
  const prev = settings.statusLine;
  if (prev && !isOurs(prev.command)) {
    cfg.chainedStatusLine = prev; // run it from our status line, restore it on uninstall
  }
  settings.statusLine = { type: 'command', command: statusCmd, padding: 0 };
  writeConfig(cfg);
  writeSettings(settings);
  return { backup: bak, added, chained: cfg.chainedStatusLine || null, hookCmd, statusCmd };
}

function uninstall() {
  const settings = readSettings();
  const bak = backup();
  const removed = [];
  if (settings.hooks) {
    for (const ev of Object.keys(settings.hooks)) {
      const list = settings.hooks[ev];
      if (!Array.isArray(list)) continue;
      const kept = [];
      for (const g of list) {
        const hooks = (g.hooks || []).filter((h) => !isOurs(h.command));
        if (hooks.length !== (g.hooks || []).length) removed.push(ev);
        if (hooks.length) kept.push({ ...g, hooks });
      }
      if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  }
  const cfg = readConfig();
  let restored = null;
  if (settings.statusLine && isOurs(settings.statusLine.command)) {
    if (cfg.chainedStatusLine) { settings.statusLine = cfg.chainedStatusLine; restored = cfg.chainedStatusLine; }
    else delete settings.statusLine;
  }
  delete cfg.chainedStatusLine;
  writeConfig(cfg);
  writeSettings(settings);
  return { backup: bak, removed, restored };
}

module.exports = { install, uninstall, HOOK_EVENTS };
