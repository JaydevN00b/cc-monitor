// Install/uninstall round trip against a throwaway CLAUDE_CONFIG_DIR + HOME.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
const claudeDir = path.join(tmp, '.claude');
fs.mkdirSync(claudeDir);
const original = {
  theme: 'dark',
  statusLine: { type: 'command', command: 'node -e "process.stdout.write(\'MINE\')"' },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo existing' }] }] },
};
fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(original, null, 2));
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, HOME: tmp, USERPROFILE: tmp };
const cli = path.join(__dirname, '..', 'bin', 'cc-monitor.js');
const run = (...a) => execFileSync(process.execPath, [cli, ...a], { env, encoding: 'utf8' });

run('install');
let s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
assert.ok(s.statusLine.command.includes('.cc-monitor/bin/statusline.js'));
assert.strictEqual(s.hooks.PreToolUse.length, 2, 'existing hook kept, ours appended');
for (const ev of ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd']) assert.ok(s.hooks[ev], ev);
run('install'); // idempotent
s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
assert.strictEqual(s.hooks.PreToolUse.length, 2, 'no duplicates on reinstall');

// status line chains the previous one and still prints its output (server is not required)
const out = execFileSync(process.execPath, [path.join(tmp, '.cc-monitor', 'bin', 'statusline.js')],
  { env: { ...env, CC_MONITOR_PORT: '1' }, input: JSON.stringify({ session_id: 'x', model: { display_name: 'Opus' } }), encoding: 'utf8' });
assert.strictEqual(out.trim(), 'MINE');

// hook forwarder exits 0 quickly with the server down
const t0 = Date.now();
execFileSync(process.execPath, [path.join(tmp, '.cc-monitor', 'bin', 'hook.js')], { env: { ...env, CC_MONITOR_PORT: '1' }, input: '{"session_id":"x"}' });
assert.ok(Date.now() - t0 < 1500, 'hook is fast');

run('uninstall');
s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
assert.deepStrictEqual(s, original, 'uninstall restores the original settings exactly');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('smoke test passed');
