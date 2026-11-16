'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Session } = require('../src/session');
const { layout } = require('../public/glyphs');

const MIN = 60_000;
const iso = (t) => new Date(t).toISOString();
const assistant = (t, id, agentId, extra = {}) => ({
  type: 'assistant', timestamp: iso(t), agentId,
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: extra.content || [{ type: 'text', text: 'x' }] },
});
const hook = (s, ev, extra = {}) => s.onHook({ session_id: s.id, hook_event_name: ev, cwd: '/p/demo', ...extra });
const row = (v, pred) => v.agents.find(pred);

test('elapsed runs from the agent\'s own start to SubagentStop', () => {
  const s = new Session('s1');
  hook(s, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'tu1', tool_input: { subagent_type: 'Explore', description: 'look' } });
  const a = s.agentByToolUse('tu1');
  a.start = Date.now() - 90_000;                       // spawned 90s ago
  hook(s, 'PreToolUse', { tool_name: 'Read', tool_use_id: 'r1', agent_id: 'abc123', agent_type: 'Explore', tool_input: {} });
  hook(s, 'SubagentStop', { agent_id: 'abc123', agent_type: 'Explore' });
  const r = row(s.view(), (x) => x.id === 'abc123');
  assert.strictEqual(r.running, false);
  assert.ok(r.end - r.start >= 89_000 && r.end - r.start < 100_000, `elapsed ${r.end - r.start}`);
});

test('no SubagentStop: done after 3 minutes of transcript silence, end = last line', () => {
  const s = new Session('s2');
  const t0 = Date.now() - 10 * MIN;
  s.ensureSubagent({ agentId: 'ag1', type: 'general-purpose' });
  s.onEntry(assistant(t0, 'm1', 'ag1'), 'ag1');
  s.onEntry(assistant(t0 + 2 * MIN, 'm2', 'ag1'), 'ag1');
  s.reapAgents(Date.now());
  const r = row(s.view(), (x) => x.id === 'ag1');
  assert.strictEqual(r.running, false);
  assert.strictEqual(r.start, t0);
  assert.strictEqual(r.end, t0 + 2 * MIN);
});

test('an agent still writing is not reaped; one waiting on a permission is never reaped', () => {
  const s = new Session('s3');
  const now = Date.now();
  s.ensureSubagent({ agentId: 'live', type: 'Explore' });
  s.onEntry(assistant(now - 30_000, 'm1', 'live'), 'live');
  const blocked = s.ensureSubagent({ agentId: 'wait', type: 'Explore' });
  s.onEntry(assistant(now - 20 * MIN, 'm2', 'wait'), 'wait');
  s.att.permission(now - 19 * MIN, { agentKey: blocked.key, tool: 'Bash' });
  s.reapAgents(now);
  assert.strictEqual(s.agentById('live').running, true);
  assert.strictEqual(s.agentById('wait').running, true);
  const v = s.view();
  assert.strictEqual(row(v, (x) => x.id === 'wait').blocked, true);
  assert.deepStrictEqual(v.agentTotals, { running: 1, blocked: 1, done: 0 });
});

test('restarting the server does not resurrect old agents (no 280h timers)', () => {
  // Fresh Session = server restart, replaying a transcript from yesterday with an Agent call
  // whose result was never written (the terminal was killed).
  const s = new Session('s4');
  const y = Date.now() - 26 * 3600_000;
  s.onEntry({ type: 'user', timestamp: iso(y), message: { content: 'hi' } }, null);
  s.onEntry(assistant(y + 5000, 'm1', undefined, { content: [{ type: 'tool_use', id: 'tuX', name: 'Agent', input: { subagent_type: 'Plan' } }] }), null);
  s.reapAgents(Date.now());
  const v = s.view();
  const r = v.agents.find((x) => !x.main);
  assert.strictEqual(r.running, false);
  assert.ok(r.end - r.start < MIN, `elapsed should be tiny, got ${(r.end - r.start) / 3600_000}h`);
  assert.deepStrictEqual(v.agentTotals, { running: 0, blocked: 0, done: 1 });
});

test('parent session ending marks running agents done', () => {
  const s = new Session('s5');
  s.ensureSubagent({ agentId: 'a1', type: 'Explore', start: Date.now() - 5000 });
  s.endSession();
  assert.strictEqual(s.agentById('a1').running, false);
});

test('main elapsed is its current run, not the first line of a resumed transcript', () => {
  const s = new Session('s6');
  const old = Date.now() - 3 * 24 * 3600_000;
  s.onEntry({ type: 'user', timestamp: iso(old), message: { content: 'old' } }, null);
  const fresh = Date.now() - 5 * MIN;
  s.onEntry({ type: 'user', timestamp: iso(fresh), message: { content: 'resumed' } }, null);
  s.onEntry(assistant(fresh + 10_000, 'm9'), null);
  const main = s.view().agents[0];
  assert.strictEqual(main.start, fresh);
});

test('after a restart, a finished turn in the transcript shows YOUR TURN', () => {
  const s = new Session('s10');
  const t0 = Date.now() - 20_000;
  s.onEntry({ type: 'user', timestamp: iso(t0), message: { content: 'hi' } }, null);
  const fin = assistant(t0 + 5000, 'm1');
  fin.message.stop_reason = 'end_turn';
  s.onEntry(fin, null);
  assert.strictEqual(s.view().attention.state, 'your_turn');
});

test('order: main, running/blocked, then done newest first; nothing is dropped', () => {
  const s = new Session('s7');
  const now = Date.now();
  for (let i = 0; i < 60; i++) {
    const a = s.ensureSubagent({ agentId: 'd' + i, type: 'Explore', start: now - (100 - i) * MIN });
    s.finishAgent(a, now - (99 - i) * MIN);
  }
  s.ensureSubagent({ agentId: 'r1', type: 'Explore', start: now - 1000 });
  const v = s.view();
  assert.strictEqual(v.agents.length, 62);
  assert.strictEqual(v.agents[0].main, true);
  assert.strictEqual(v.agents[1].id, 'r1');
  assert.strictEqual(v.agents[2].id, 'd59');        // newest finished
  assert.strictEqual(v.agents[61].id, 'd0');
  assert.deepStrictEqual(v.agentTotals, { running: 1, blocked: 0, done: 60 });
});

test('names: real name when provided, else type with a short id suffix', () => {
  const s = new Session('s8');
  const custom = s.ensureSubagent({ agentId: 'a1', type: 'rate-limiter', isBuiltIn: false });
  const named = s.ensureSubagent({ agentId: 'a2', type: 'general-purpose', name: 'migrator' });
  const builtin = s.ensureSubagent({ agentId: 'a3f9c2', type: 'general-purpose', isBuiltIn: true });
  assert.strictEqual(s.displayName(custom), 'rate-limiter');
  assert.strictEqual(s.displayName(named), 'migrator');
  assert.strictEqual(s.displayName(builtin), 'general-purpose·3f9');
});

test('blocked subagent shows in the request card with its name and model', () => {
  const s = new Session('s9');
  s.ensureSubagent({ agentId: 'a1', type: 'rate-limiter', isBuiltIn: false, start: Date.now() - 1000 });
  hook(s, 'PermissionRequest', { agent_id: 'a1', agent_type: 'rate-limiter', tool_name: 'Bash', tool_input: { command: 'npm install express-rate-limit' } });
  const att = s.view().attention;
  assert.strictEqual(att.state, 'needs_you');
  assert.strictEqual(att.block.agent, 'rate-limiter');
  assert.strictEqual(att.block.command, 'npm install express-rate-limit');
});

// ---------------------------------------------------------------- 5-hour dot matrix
test('glyphs: every glyph owns its own 5 columns with exactly one blank column between', () => {
  for (let p = 0; p <= 100; p++) {
    const L = layout(`${p}%`);
    L.glyphs.forEach((g, i) => {
      if (i > 0) assert.strictEqual(g.col - (L.glyphs[i - 1].col + 5), 1, `gap before glyph ${i} in ${p}%`);
    });
    for (const [key, ch] of L.lit) {
      const c = Number(key.split(',')[0]);
      const g = L.glyphs.find((x) => c >= x.col && c < x.col + 5);
      assert.ok(g && g.ch === ch, `dot at column ${c} of ${p}% belongs to the wrong glyph`);
    }
    const last = L.glyphs[L.glyphs.length - 1];
    assert.strictEqual(L.cols, last.col + 5 + 1, `right margin for ${p}%`);
  }
});
