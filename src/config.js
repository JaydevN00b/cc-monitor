'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = path.join(os.homedir(), '.cc-monitor');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const paths = {
  home,
  bin: path.join(home, 'bin'),
  backups: path.join(home, 'backups'),
  config: path.join(home, 'config.json'),
  capture: path.join(home, 'capture.jsonl'),
  claudeDir,
  settings: path.join(claudeDir, 'settings.json'),
  claudeJson: path.join(os.homedir(), '.claude.json'),
};

function readConfig() {
  try { return JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch { return {}; }
}

function writeConfig(cfg) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = { paths, readConfig, writeConfig, PORT: Number(process.env.CC_MONITOR_PORT) || 4317 };
