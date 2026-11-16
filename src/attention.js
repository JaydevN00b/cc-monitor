'use strict';
// "Needs you" state machine for one session. Pure: callers pass timestamps in, so it is unit-testable.
//
// States (derived by state(now)):
//   needs_you  a PermissionRequest / Notification is pending with no activity from that agent since
//   your_turn  the main agent fired Stop and nothing happened since
//   working    tool or transcript activity
//   idle       nothing for IDLE_AFTER (a pending *permission* never decays: the work is truly blocked)
//
// Blocks are kept per agent ('main' or a subagent key): with parallel subagents, one agent can be
// waiting on a permission prompt while another keeps running tools; the second one must not clear
// the first one's block.
//
// Real payloads (Claude Code 2.1.x):
//   PermissionRequest { tool_name, tool_input, agent_id?, agent_type? }
//   Notification      { notification_type: 'permission_prompt' | 'idle_prompt' | ..., message }
const IDLE_AFTER = 10 * 60_000;
const SLACK = 1000; // transcript lines written just before a hook can be read just after it

class Attention {
  constructor() {
    this.blocks = new Map();   // agentKey -> block
    this.yourTurnSince = null;
    this.lastActivity = 0;
    this.lastTool = new Map(); // agentKey -> { tool, input } of the latest PreToolUse (Notification fallback)
  }

  _touch(t) { if (t > this.lastActivity) this.lastActivity = t; }

  // Any tool event or transcript line from `agentKey`.
  activity(t, agentKey = 'main') {
    this._touch(t);
    const b = this.blocks.get(agentKey);
    if (b && t > b.since + SLACK) this.blocks.delete(agentKey);
    if (this.yourTurnSince && t > this.yourTurnSince + SLACK) this.yourTurnSince = null;
  }

  // Same, but for hook events, which arrive in real time (no slack needed).
  hookActivity(t, agentKey = 'main') {
    this._touch(t);
    if (this.blocks.has(agentKey) && t >= this.blocks.get(agentKey).since) this.blocks.delete(agentKey);
    if (this.yourTurnSince && t >= this.yourTurnSince) this.yourTurnSince = null;
  }

  preTool(t, agentKey, tool, input) {
    this.lastTool.set(agentKey, { tool, input });
    this.hookActivity(t, agentKey);
  }

  // The user answered / typed: everything this session was waiting on is resolved.
  prompt(t) {
    this._touch(t);
    this.blocks.clear();
    this.yourTurnSince = null;
  }

  permission(t, { agentKey = 'main', agentId = null, agentType = null, tool = null, input = null } = {}) {
    this._touch(t);
    this.blocks.set(agentKey, { reason: 'permission', since: t, agentKey, agentId, agentType, tool, input, fromHook: true });
  }

  notification(t, type, message) {
    this._touch(t);
    if (type === 'permission_prompt') {
      // Normally PermissionRequest already created the block; this covers versions without that hook.
      if ([...this.blocks.values()].some((b) => b.reason === 'permission')) return;
      let key = 'main', last = this.lastTool.get('main');
      for (const [k, v] of this.lastTool) { key = k; last = v; } // most recent PreToolUse of any agent
      this.blocks.set(key, { reason: 'permission', since: t, agentKey: key, tool: last && last.tool, input: last && last.input, message, fromHook: true });
    } else if (type === 'idle_prompt' || type === 'elicitation_dialog') {
      if (this.blocks.has('main')) return;
      this.blocks.set('main', { reason: type === 'idle_prompt' ? 'input' : 'question', since: t, agentKey: 'main', message, fromHook: true });
    }
  }

  // Claude Code re-runs the status line the moment a permission prompt is answered (observed: the
  // refresh lands within ~100ms of the answer; PostToolUse only arrives once the tool finishes, which
  // can be minutes for an install). No refresh happens while the prompt is open, so a refresh a little
  // after the block started means the user answered it.
  statusRefresh(t) {
    for (const [k, b] of this.blocks) if (b.reason === 'permission' && t - b.since > 2000) this.blocks.delete(k);
  }

  stop(t, agentKey = 'main') {
    this._touch(t);
    if (agentKey !== 'main') return this.subagentStop(t, agentKey);
    this.blocks.delete('main'); // main can't be waiting on a prompt and finish its turn at once
    this.yourTurnSince = t;
  }

  subagentStop(t, agentKey) {
    this._touch(t);
    this.blocks.delete(agentKey);
    this.lastTool.delete(agentKey);
  }

  end() { this.blocks.clear(); this.yourTurnSince = null; }

  // Oldest pending block, or null.
  block() {
    let best = null;
    for (const b of this.blocks.values()) if (!best || b.since < best.since) best = b;
    return best;
  }

  state(now = Date.now()) {
    const b = this.block();
    if (b) {
      if (b.reason !== 'permission' && now - Math.max(b.since, this.lastActivity) > IDLE_AFTER) return 'idle';
      return 'needs_you';
    }
    if (now - this.lastActivity > IDLE_AFTER) return 'idle';
    if (this.yourTurnSince) return 'your_turn';
    return 'working';
  }
}

module.exports = { Attention, IDLE_AFTER };
