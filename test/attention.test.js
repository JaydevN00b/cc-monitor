'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Attention, IDLE_AFTER } = require('../src/attention');
const { createServer } = require('../src/server');

const T0 = 1_800_000_000_000;
const sec = (n) => n * 1000;

test('fresh activity is WORKING', () => {
  const a = new Attention();
  a.hookActivity(T0);
  assert.strictEqual(a.state(T0 + sec(1)), 'working');
});

test('PermissionRequest -> NEEDS YOU with reason, tool, command and agent', () => {
  const a = new Attention();
  a.preTool(T0, 'a:x1', 'Bash', { command: 'npm i' });
  a.permission(T0 + sec(1), { agentKey: 'a:x1', agentId: 'x1', agentType: 'general-purpose', tool: 'Bash', input: { command: 'npm i' } });
  assert.strictEqual(a.state(T0 + sec(5)), 'needs_you');
  const b = a.block();
  assert.strictEqual(b.reason, 'permission');
  assert.strictEqual(b.tool, 'Bash');
  assert.strictEqual(b.input.command, 'npm i');
  assert.strictEqual(b.agentKey, 'a:x1');
  assert.strictEqual(b.since, T0 + sec(1));
});

test('activity from the blocked agent clears the block; another agent does not', () => {
  const a = new Attention();
  a.permission(T0, { agentKey: 'a:x1', tool: 'Bash' });
  a.hookActivity(T0 + sec(2), 'a:other');          // parallel subagent keeps working
  assert.strictEqual(a.state(T0 + sec(3)), 'needs_you');
  a.hookActivity(T0 + sec(4), 'a:x1');             // PostToolUse after approval
  assert.strictEqual(a.state(T0 + sec(5)), 'working');
});

test('UserPromptSubmit clears every block and YOUR TURN', () => {
  const a = new Attention();
  a.permission(T0, { agentKey: 'main', tool: 'Bash' });
  a.permission(T0 + sec(1), { agentKey: 'a:x1', tool: 'Edit' });
  a.prompt(T0 + sec(2));
  assert.strictEqual(a.blocks.size, 0);
  assert.strictEqual(a.state(T0 + sec(3)), 'working');
  a.stop(T0 + sec(4));
  a.prompt(T0 + sec(5));
  assert.strictEqual(a.state(T0 + sec(6)), 'working');
});

test('Stop -> YOUR TURN, then any tool event -> WORKING', () => {
  const a = new Attention();
  a.hookActivity(T0);
  a.stop(T0 + sec(1));
  assert.strictEqual(a.state(T0 + sec(2)), 'your_turn');
  a.preTool(T0 + sec(3), 'a:bg', 'Read', {});      // a background subagent continues
  assert.strictEqual(a.state(T0 + sec(4)), 'working');
});

test('transcript lines written just before Stop/permission do not clear them (slack)', () => {
  const a = new Attention();
  a.stop(T0);
  a.activity(T0 + 500, 'main');                    // final assistant line read late
  assert.strictEqual(a.state(T0 + sec(1)), 'your_turn');
  a.permission(T0 + sec(10), { agentKey: 'main', tool: 'Bash' });
  a.activity(T0 + sec(9), 'main');                 // older line read after the hook
  assert.strictEqual(a.state(T0 + sec(11)), 'needs_you');
  a.activity(T0 + sec(13), 'main');                // genuinely new line
  assert.strictEqual(a.state(T0 + sec(14)), 'working');
});

test('idle_prompt notification after Stop -> NEEDS YOU (input); prompt clears it', () => {
  const a = new Attention();
  a.stop(T0);
  a.notification(T0 + sec(60), 'idle_prompt', 'Claude is waiting for your input');
  assert.strictEqual(a.state(T0 + sec(61)), 'needs_you');
  assert.strictEqual(a.block().reason, 'input');
  a.prompt(T0 + sec(70));
  assert.strictEqual(a.state(T0 + sec(71)), 'working');
});

test('permission_prompt notification does not duplicate an existing PermissionRequest block', () => {
  const a = new Attention();
  a.permission(T0, { agentKey: 'a:x1', tool: 'Bash', input: { command: 'ls' } });
  a.notification(T0 + sec(6), 'permission_prompt', 'Claude needs your permission');
  assert.strictEqual(a.blocks.size, 1);
  assert.strictEqual(a.block().since, T0);
});

test('permission_prompt notification alone falls back to the last PreToolUse', () => {
  const a = new Attention();
  a.preTool(T0, 'main', 'Bash', { command: 'rm -rf build' });
  a.notification(T0 + sec(6), 'permission_prompt', 'Claude needs your permission');
  assert.strictEqual(a.state(T0 + sec(7)), 'needs_you');
  assert.strictEqual(a.block().tool, 'Bash');
  assert.strictEqual(a.block().input.command, 'rm -rf build');
});

test('IDLE after 10 minutes; a pending permission never decays, an input wait does', () => {
  const a = new Attention();
  a.hookActivity(T0);
  assert.strictEqual(a.state(T0 + IDLE_AFTER + 1), 'idle');
  a.stop(T0 + sec(1));
  assert.strictEqual(a.state(T0 + sec(1) + IDLE_AFTER + 1), 'idle');

  const p = new Attention();
  p.permission(T0, { agentKey: 'main', tool: 'Bash' });
  assert.strictEqual(p.state(T0 + 3 * IDLE_AFTER), 'needs_you');

  const i = new Attention();
  i.notification(T0, 'idle_prompt', 'waiting');
  assert.strictEqual(i.state(T0 + IDLE_AFTER + 1), 'idle');
});

test('a status-line refresh after a permission prompt means it was answered (not input waits)', () => {
  const a = new Attention();
  a.permission(T0, { agentKey: 'a:x1', tool: 'Bash' });
  a.statusRefresh(T0 + 500);                       // refresh that accompanies the prompt itself: ignored
  assert.strictEqual(a.state(T0 + sec(1)), 'needs_you');
  a.statusRefresh(T0 + sec(85));                   // user approved; the tool is still running
  assert.strictEqual(a.state(T0 + sec(86)), 'working');
  const i = new Attention();
  i.notification(T0, 'idle_prompt', 'waiting');
  i.statusRefresh(T0 + sec(30));
  assert.strictEqual(i.state(T0 + sec(31)), 'needs_you');
});

test('SubagentStop clears that subagent\'s block; Stop clears main\'s; end() clears all', () => {
  const a = new Attention();
  a.permission(T0, { agentKey: 'a:x1', tool: 'Bash' });
  a.subagentStop(T0 + sec(1), 'a:x1');
  assert.strictEqual(a.blocks.size, 0);
  a.permission(T0 + sec(2), { agentKey: 'main', tool: 'Bash' });
  a.stop(T0 + sec(3));
  assert.strictEqual(a.state(T0 + sec(4)), 'your_turn');
  a.permission(T0 + sec(5), { agentKey: 'a:x2', tool: 'Bash' });
  a.end();
  assert.strictEqual(a.blocks.size, 0);
});

test('oldest block is reported when an agent and main both wait', () => {
  const a = new Attention();
  a.permission(T0 + sec(5), { agentKey: 'main', tool: 'Write' });
  a.permission(T0, { agentKey: 'a:x1', tool: 'Bash' });
  assert.strictEqual(a.block().tool, 'Bash');
});

// ---------------------------------------------------------------- several sessions through the server
test('server: several blocked sessions sort first (oldest wait first) and produce stacked alerts', async () => {
  const srv = createServer({ port: 0, log: () => {} });
  try {
    const now = Date.now();
    const mk = (id, cwd) => { const s = srv.getSession(id); s.cwd = cwd; s.touch(now - 1000); return s; };
    const gw = mk('s-gw', '/p/api-gateway');
    const docs = mk('s-docs', '/p/docs-site');
    const work = mk('s-work', '/p/photon');
    const turn = mk('s-turn', '/p/notes');
    gw.att.permission(now - 200_000, { agentKey: 'main', tool: 'Bash', input: { command: 'npm install express-rate-limit' } });
    docs.att.notification(now - 30_000, 'idle_prompt', 'Claude is waiting for your input');
    work.att.hookActivity(now - 500, 'main'); work.touch(now - 500);
    turn.att.stop(now - 5000);
    const snap = srv.snapshot(null);
    assert.deepStrictEqual(snap.sessions.slice(0, 2).map((s) => s.project), ['api-gateway', 'docs-site']);
    assert.deepStrictEqual(snap.alerts.map((a) => a.project), ['api-gateway', 'docs-site']);
    assert.strictEqual(snap.alerts[0].reason, 'permission');
    assert.strictEqual(snap.alerts[0].command, 'npm install express-rate-limit');
    assert.strictEqual(snap.alerts[1].reason, 'input');
    const st = Object.fromEntries(snap.sessions.map((s) => [s.project, s.attention.state]));
    assert.deepStrictEqual(st, { 'api-gateway': 'needs_you', 'docs-site': 'needs_you', photon: 'working', notes: 'your_turn' });
    // answering clears it
    gw.att.prompt(Date.now());
    const snap2 = srv.snapshot(null);
    assert.deepStrictEqual(snap2.alerts.map((a) => a.project), ['docs-site']);
  } finally { srv.close(); }
});
