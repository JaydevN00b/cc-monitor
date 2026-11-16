'use strict';
// Per-session state, fed by three sources:
//   status line JSON (POST /status), hook JSON (POST /hook), transcript JSONL tailing.
// Field names below are the ones observed in real Claude Code 2.1.x payloads.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Tailer } = require('./tail');
const { shortModel, family } = require('./models');
const { Attention } = require('./attention');

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const BUILTIN_AGENTS = new Set(['general-purpose', 'explore', 'plan', 'statusline-setup', 'claude-code-guide', 'output-style-setup']);
const STALE_AGENT = 3 * 60_000;   // a subagent whose transcript has been silent this long is done
const RUN_GAP = 60 * 60_000;      // a gap this long starts a new "run" of the main agent (resumed sessions)
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const MIN = 60_000;
const minuteOf = (t) => Math.floor(t / MIN);
const ts = (e) => { const t = Date.parse(e && e.timestamp); return isFinite(t) ? t : null; };

// Global, account-wide data: rate limits are the same for every session.
const account = { rateLimits: null, rateLimitsAt: 0 };

class Session {
  constructor(id, opts = {}) {
    this.id = id;
    this.cwd = null;
    this.projectDir = null;
    this.transcriptPath = null;
    this.startedAt = null;
    this.lastActivity = 0;
    this.status = null;          // last status-line JSON (cost block removed)
    this.statusAt = 0;
    this.gitBranch = null;
    this.mainModel = null;
    this.mainBusy = false;
    this.countCacheReads = !!opts.countCacheReads;

    this.msgs = new Map();       // message.id -> { agent, model, tokens, t, ctx }
    this.lastMainMsg = null;
    this.toolUses = new Map();   // tool_use_id -> { name, input, agent }
    this.toolsDone = new Set();  // tool_use_ids whose result was applied (hook or transcript)
    this.files = new Map();      // abs path -> file change record
    this.reads = new Set();

    this.main = this._newAgent('main', { name: 'main' });
    this.agents = [this.main];   // main first, then subagents in spawn order

    this.mainTailer = null;
    this.subTailers = new Map(); // agentId -> Tailer
    this.dirty = true;
    this._gitAt = 0;

    this.att = new Attention();  // needs-you / your-turn / working / idle
    this.ended = false;
    this.runStart = null;        // start of the main agent's current run (not the transcript's first line)
    this._lastActT = 0;
  }

  // Track the main agent's current run: a gap longer than RUN_GAP starts a new one.
  _run(t) {
    if (!t) return;
    if (!this.runStart) this.runStart = t;
    else if (t > this._lastActT && t - this._lastActT > RUN_GAP) this.runStart = t;
    else if (t < this.runStart && this.runStart - t < RUN_GAP) this.runStart = t; // backfill of earlier lines
    if (t > this._lastActT) this._lastActT = t;
  }

  // ---------------------------------------------------------------- helpers
  _newAgent(key, o) {
    return { key, agentId: null, toolUseId: null, name: 'agent', description: '', modelHint: null,
      start: null, end: null, running: false, minutes: new Set(), ...o };
  }

  touch(t = Date.now()) {
    if (t > this.lastActivity) this.lastActivity = t;
    if (!this.startedAt || t < this.startedAt) this.startedAt = t;
    this.dirty = true;
  }

  agentByToolUse(id) { return id ? this.agents.find((a) => a.toolUseId === id) : null; }
  agentById(id) { return id ? this.agents.find((a) => a.agentId === id) : null; }

  ensureSubagent({ toolUseId, agentId, type, description, model, start, name, isBuiltIn }) {
    let a = this.agentById(agentId) || this.agentByToolUse(toolUseId);
    if (!a) {
      a = this._newAgent(agentId ? 'a:' + agentId : 'tu:' + toolUseId, { running: true, start: start || null });
      this.agents.push(a);
    }
    if (agentId) a.agentId = agentId;
    if (toolUseId) a.toolUseId = toolUseId;
    if (type) a.name = type;
    if (name && !a.customName) a.customName = name;
    if (typeof isBuiltIn === 'boolean') a.isBuiltIn = isBuiltIn;
    if (description) a.description = description;
    if (model && !a.modelHint) a.modelHint = model;
    if (start && (!a.start || start < a.start)) a.start = start;
    this.dirty = true;
    return a;
  }

  // An agent's end never moves backwards and is never before its start.
  finishAgent(a, t = Date.now()) {
    if (!a || a === this.main) return;
    if (a.running) {
      a.running = false;
      a.end = Math.max(t, a.start || t);
    } else if (!a.end) a.end = Math.max(t, a.start || t);
    this.dirty = true;
  }

  // Real name if the payload has one (custom agent type or an explicit name), else "type·id".
  displayName(a) {
    if (a === this.main) return 'main';
    if (a.customName) return String(a.customName);
    const type = String(a.name || 'agent');
    const builtIn = typeof a.isBuiltIn === 'boolean' ? a.isBuiltIn : BUILTIN_AGENTS.has(type.toLowerCase());
    if (!builtIn) return type;
    const id = String(a.agentId || '').replace(/^a/, '') || String(a.toolUseId || '').replace(/^toolu_\d*/, '');
    return id ? `${type.toLowerCase()}·${id.slice(0, 3).toLowerCase()}` : type.toLowerCase();
  }

  subagentsDir() {
    return this.transcriptPath ? this.transcriptPath.replace(/\.jsonl$/i, '') + path.sep + 'subagents' : null;
  }

  setTranscript(p) {
    if (!p || this.transcriptPath === p) return;
    this.transcriptPath = p;
    this.mainTailer = new Tailer(p, (e) => this.onEntry(e, null));
  }

  setCwd(cwd) { if (cwd && !this.cwd) this.cwd = cwd; }

  // ---------------------------------------------------------------- status line
  onStatus(j) {
    const copy = { ...j };
    delete copy.cost;            // never keep dollar figures
    this.status = copy;
    this.statusAt = Date.now();
    this.att.statusRefresh(this.statusAt);
    this.setCwd(j.cwd || (j.workspace && j.workspace.current_dir));
    if (j.workspace && j.workspace.project_dir) this.projectDir = j.workspace.project_dir;
    this.setTranscript(j.transcript_path);
    if (j.model && (j.model.id || j.model.display_name)) this.mainModel = j.model.id || j.model.display_name;
    if (j.rate_limits && (j.rate_limits.five_hour || j.rate_limits.seven_day)) {
      account.rateLimits = j.rate_limits;
      account.rateLimitsAt = Date.now();
    }
    this.dirty = true;
  }

  // ---------------------------------------------------------------- hooks
  onHook(j) {
    const now = Date.now();
    this.setCwd(j.cwd);
    this.setTranscript(j.transcript_path);
    const ev = j.hook_event_name;
    const sub = j.agent_id ? this.linkSubagentFromHook(j) : null;
    const who = sub || this.main;
    if (sub) { if (!sub.start) sub.start = now; sub.lastSeen = Math.max(sub.lastSeen || 0, now); }
    this.dirty = true;

    if (ev === 'SessionEnd') { this.endSession(now); return; }
    this.ended = false; // any other event (e.g. a resumed session) makes it live again

    // Notifications and Stop are not "work": they must not light up activity dots or extend timers.
    if (ev !== 'Notification' && ev !== 'Stop' && ev !== 'PermissionRequest') {
      who.minutes.add(minuteOf(now));
      this.touch(now);
      if (!sub) this._run(now);
    } else if (now > this.lastActivity) {
      this.lastActivity = now;
    }

    switch (ev) {
      case 'SessionStart':
        if (!this.startedAt) this.startedAt = now;
        return;
      case 'UserPromptSubmit':
        this.mainBusy = true;
        this.att.prompt(now);
        return;
      case 'PermissionRequest':
        this.att.permission(now, { agentKey: who.key, agentId: j.agent_id || null, agentType: j.agent_type || null,
          tool: j.tool_name || null, input: j.tool_input || null });
        return;
      case 'Notification':
        this.att.notification(now, j.notification_type, j.message);
        return;
      case 'Stop':
        if (!sub) { this.mainBusy = false; this.att.stop(now, 'main'); }
        return;
      case 'SubagentStop':
        if (sub) { this.finishAgent(sub, now); this.att.subagentStop(now, sub.key); }
        if (j.agent_transcript_path && j.agent_id && !this.subTailers.has(j.agent_id)) {
          this.addSubTailer(j.agent_id, j.agent_transcript_path);
        }
        return;
      case 'PreToolUse':
        if (!sub) this.mainBusy = true;
        this.att.preTool(now, who.key, j.tool_name, j.tool_input);
        this.toolStart(j.tool_use_id, j.tool_name, j.tool_input || {}, who.key, now);
        return;
      case 'PostToolUse':
        this.att.hookActivity(now, who.key);
        this.toolEnd(j.tool_use_id, j.tool_name, j.tool_input || {}, j.tool_response, now);
        return;
      default:
    }
  }

  // Session over (SessionEnd hook or its process is gone): nothing is running or waiting any more.
  endSession(t = Date.now()) {
    this.ended = true;
    this.mainBusy = false;
    this.att.end();
    for (const a of this.agents) if (a !== this.main && a.running) this.finishAgent(a, a.lastSeen || t);
    this.dirty = true;
  }

  linkSubagentFromHook(j) {
    let a = this.agentById(j.agent_id);
    if (a) return a;
    // Exact link through the subagent's meta.json (toolUseId of the Agent call).
    const meta = this.readMeta(j.agent_id);
    if (meta && meta.toolUseId) {
      return this.ensureSubagent({ agentId: j.agent_id, toolUseId: meta.toolUseId, type: meta.agentType || j.agent_type,
        description: meta.description, model: meta.model, name: meta.name, isBuiltIn: meta.isBuiltIn });
    }
    // Fallback: oldest still-unlinked running Agent call with the same subagent type.
    a = this.agents.find((x) => x !== this.main && !x.agentId && x.running && (!j.agent_type || x.name === j.agent_type));
    if (a) { a.agentId = j.agent_id; return a; }
    return this.ensureSubagent({ agentId: j.agent_id, type: j.agent_type });
  }

  readMeta(agentId) {
    const dir = this.subagentsDir();
    if (!dir) return null;
    try { return JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8')); } catch { return null; }
  }

  // ---------------------------------------------------------------- tools (shared by hooks + transcript)
  toolStart(id, name, input, agentKey, t) {
    if (!id || !name) return;
    if (!this.toolUses.has(id)) this.toolUses.set(id, { name, input, agent: agentKey });
    if (AGENT_TOOLS.has(name) && agentKey === 'main') {
      this.ensureSubagent({ toolUseId: id, type: input.subagent_type || 'general-purpose',
        description: input.description, model: input.model, start: t, name: input.name });
    }
    if (WRITE_TOOLS.has(name) && !this.toolsDone.has(id)) {
      const f = this.file(input.file_path || input.notebook_path);
      if (f) { f.pending.add(id); f.pendingSince = f.pendingSince || t; f.t = t; this.dirty = true; }
    }
  }

  toolEnd(id, name, input, resp, t) {
    if (!id) return;
    const known = this.toolUses.get(id);
    name = name || (known && known.name);
    input = input && Object.keys(input).length ? input : (known && known.input) || {};
    if (this.toolsDone.has(id)) return;
    this.toolsDone.add(id);
    this.dirty = true;
    if (typeof resp === 'string') { try { resp = JSON.parse(resp); } catch { /* keep string */ } }

    if (AGENT_TOOLS.has(name)) {
      const a = this.agentByToolUse(id);
      const r = resp && typeof resp === 'object' ? resp : {};
      if (a && r.agentId && !a.agentId) a.agentId = r.agentId;
      if (a && r.resolvedModel && !a.modelHint) a.modelHint = r.resolvedModel;
      // background agents return immediately ("async_launched"); only completed ones end here.
      if (a && (r.status === 'completed' || r.status === 'error' || r.status === 'failed')) this.finishAgent(a, t);
      return;
    }
    if (READ_TOOLS.has(name)) {
      const p = input.file_path || input.notebook_path;
      if (p) this.reads.add(p);
      return;
    }
    if (WRITE_TOOLS.has(name)) {
      const f = this.file(input.file_path || input.notebook_path || (resp && resp.filePath));
      if (!f) return;
      f.pending.delete(id);
      if (!f.pending.size) f.pendingSince = 0;
      f.t = t;
      const r = resp && typeof resp === 'object' ? resp : null;
      if (!r) return; // denied / error: just clear the WRITING state
      let add = 0, del = 0;
      if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
        for (const h of r.structuredPatch) for (const l of h.lines || []) {
          if (l[0] === '+') add++; else if (l[0] === '-') del++;
        }
      } else if (r.type === 'create' && typeof r.content === 'string') {
        add = r.content.split('\n').length - (r.content.endsWith('\n') ? 1 : 0);
      }
      f.added += add; f.removed += del;
      if (name === 'Write') { f.writes++; if (r.type === 'create') f.created = true; } else f.edits++;
      f.saved = true;
    }
  }

  file(p) {
    if (!p) return null;
    let f = this.files.get(p);
    if (!f) { f = { path: p, added: 0, removed: 0, edits: 0, writes: 0, created: false, saved: false, pending: new Set(), pendingSince: 0, t: Date.now() }; this.files.set(p, f); }
    return f;
  }

  // ---------------------------------------------------------------- transcripts
  addSubTailer(agentId, file) {
    const t = new Tailer(file, (e) => this.onEntry(e, agentId));
    this.subTailers.set(agentId, t);
    t.poll();
  }

  scanSubagents() {
    const dir = this.subagentsDir();
    if (!dir) return;
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const m = n.match(/^agent-(.+)\.meta\.json$/);
      if (!m) continue;
      const agentId = m[1];
      const known = this.agentById(agentId);
      if (known && this.subTailers.has(agentId) && !known.running) continue;
      const meta = this.readMeta(agentId);
      if (!meta) continue;
      const a = this.ensureSubagent({ agentId, toolUseId: meta.toolUseId, type: meta.agentType,
        description: meta.description, model: meta.model, name: meta.name, isBuiltIn: meta.isBuiltIn });
      if (meta.finished && a.running) this.finishAgent(a, a.lastSeen || Date.now());
      if (!this.subTailers.has(agentId)) this.addSubTailer(agentId, path.join(dir, `agent-${agentId}.jsonl`));
    }
  }

  onEntry(e, agentId) {
    const t = ts(e);
    if (e.gitBranch && e.gitBranch !== 'HEAD' && !agentId) this.gitBranch = e.gitBranch;
    if (e.cwd) this.setCwd(e.cwd);
    if (t && (e.type === 'user' || e.type === 'assistant')) {
      if (!this.startedAt || t < this.startedAt) this.startedAt = t;
      if (t > this.lastActivity) this.lastActivity = t;
    }
    const agent = agentId ? this.agentById(agentId) || this.ensureSubagent({ agentId }) : this.main;
    if (t && (e.type === 'user' || e.type === 'assistant')) {
      agent.minutes.add(minuteOf(t));
      agent.lastSeen = Math.max(agent.lastSeen || 0, t);
      if (agent !== this.main && (!agent.start || t < agent.start)) agent.start = t;
      if (agent === this.main) this._run(t);
      const newest = t >= this.att.lastActivity - 1000;
      this.att.activity(t, agent.key);
      // The main agent's final reply of a turn ends with stop_reason "end_turn": a backup for the Stop
      // hook (e.g. the server restarted after Stop fired). Only if nothing newer has been seen.
      if (agent === this.main && e.type === 'assistant' && e.message && e.message.stop_reason === 'end_turn' && newest) {
        this.att.stop(t, 'main');
        this.mainBusy = false;
      }
      // A finished agent that writes again (e.g. resumed with SendMessage) is running again.
      if (agent !== this.main && !agent.running && agent.end && t > agent.end + 5000 && Date.now() - t < STALE_AGENT) {
        agent.running = true; agent.end = null;
      }
    }
    const m = e.message;
    if (e.type === 'assistant' && m) {
      if (m.usage && m.id && m.model && m.model !== '<synthetic>') {
        const u = m.usage;
        const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
          + (this.countCacheReads ? (u.cache_read_input_tokens || 0) : 0);
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        const rec = { agent: agent.key, model: m.model, tokens, t: t || Date.now(), ctx };
        this.msgs.set(m.id, rec); // same id repeats once per content block: overwrite, never add
        if (agent === this.main) { this.lastMainMsg = rec; this.mainModel = this.mainModel || m.model; if (!this.status) this.mainModel = m.model; }
        else agent.model = m.model;
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content) if (c.type === 'tool_use') this.toolStart(c.id, c.name, c.input || {}, agent.key, t || Date.now());
      }
      this.dirty = true;
    } else if (e.type === 'user' && m && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type !== 'tool_result' || !c.tool_use_id) continue;
        const known = this.toolUses.get(c.tool_use_id);
        if (!known) continue;
        this.toolEnd(c.tool_use_id, known.name, known.input, c.is_error ? null : e.toolUseResult, t || Date.now());
      }
    }
  }

  poll() {
    if (this.mainTailer) this.mainTailer.poll();
    this.scanSubagents();
    for (const tl of this.subTailers.values()) tl.poll();
    const now = Date.now();
    this.reapAgents(now);
    // Safety: a WRITING tag never sticks for more than 5 minutes (e.g. a crashed tool).
    for (const f of this.files.values()) if (f.pending.size && now - f.pendingSince > 5 * MIN) { f.pending.clear(); f.pendingSince = 0; this.dirty = true; }
    this.refreshGit();
  }

  // A subagent is done when SubagentStop arrives. If it never does (crash, killed terminal, server
  // restarted mid-run), it is done once its transcript has been silent for STALE_AGENT, unless it is
  // waiting on a permission prompt. Its end is its last line, so elapsed never keeps growing.
  reapAgents(now = Date.now()) {
    for (const a of this.agents) {
      if (a === this.main || !a.running) continue;
      if (this.att.blocks.has(a.key)) continue;
      const last = Math.max(a.lastSeen || 0, a.start || 0);
      if (!last) { a.start = now; continue; } // no timestamps at all yet: start the clock now
      if (now - last > STALE_AGENT) this.finishAgent(a, last);
    }
  }

  refreshGit() {
    const dir = this.projectDir || this.cwd;
    if (!dir || Date.now() - this._gitAt < 15_000) return;
    this._gitAt = Date.now();
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeout: 2000, windowsHide: true }, (err, out) => {
      const b = !err && String(out).trim();
      if (b && b !== 'HEAD' && b !== this.gitBranch) { this.gitBranch = b; this.dirty = true; }
    });
  }

  // ---------------------------------------------------------------- view model for the UI
  view(plan) {
    const now = Date.now();
    const nowMin = minuteOf(now);
    const st = this.status && now - this.statusAt < 6 * 3600_000 ? this.status : null;
    const rl = (st && st.rate_limits) || account.rateLimits || {};
    const lim = (x) => (x && typeof x.used_percentage === 'number'
      ? { pct: x.used_percentage, resetsAt: x.resets_at ? Number(x.resets_at) * (Number(x.resets_at) < 1e12 ? 1000 : 1) : null }
      : null);

    // context
    let context = null;
    const cw = st && st.context_window;
    if (cw && (cw.used_percentage != null || cw.current_usage)) {
      const cu = cw.current_usage || {};
      const used = (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.output_tokens || 0);
      context = { pct: cw.used_percentage != null ? cw.used_percentage : (cw.context_window_size ? used / cw.context_window_size * 100 : null),
        used: used || null, size: cw.context_window_size || null };
    } else if (this.lastMainMsg) {
      context = { pct: null, used: this.lastMainMsg.ctx, size: null };
    }

    // tokens/min, models
    const buckets = new Array(30).fill(0);
    const perModel = new Map();
    const perAgentModel = new Map();
    let lastMinute = 0;
    for (const r of this.msgs.values()) {
      const k = shortModel(r.model);
      perModel.set(k, (perModel.get(k) || 0) + r.tokens);
      const am = perAgentModel.get(r.agent) || new Map();
      am.set(r.model, (am.get(r.model) || 0) + r.tokens);
      perAgentModel.set(r.agent, am);
      const idx = 29 - (nowMin - minuteOf(r.t));
      if (idx >= 0 && idx < 30) buckets[idx] += r.tokens;
      if (now - r.t < MIN) lastMinute += r.tokens;
    }
    const totalTok = [...perModel.values()].reduce((a, b) => a + b, 0);
    const models = [...perModel.entries()].sort((a, b) => b[1] - a[1])
      .map(([name, tok]) => ({ name, tokens: tok, share: totalTok ? tok / totalTok : 0 }));

    const mainModelId = (st && st.model && (st.model.id || st.model.display_name)) || this.mainModel;
    const topModel = (key) => {
      const am = perAgentModel.get(key);
      if (!am || !am.size) return null;
      return [...am.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };

    const attState = this.ended ? 'idle' : this.att.state(now);
    const mainEnd = attState === 'working' || attState === 'needs_you' ? null : this.lastActivity;
    const agents = this.agents.map((a) => {
      const isMain = a === this.main;
      const modelId = topModel(a.key) || a.model || a.modelHint || (isMain ? mainModelId : null);
      const blocked = !this.ended && this.att.blocks.has(a.key);
      const start = isMain ? (this.runStart || this.startedAt) : a.start;
      const end = isMain ? mainEnd : (a.running ? null : (a.end || a.lastSeen || a.start || null));
      const dots = [];
      for (let i = 21; i >= 0; i--) {
        const m = nowMin - i;
        if (isMain) dots.push(a.minutes.has(m) ? 1 : 0);
        else {
          const s0 = start ? minuteOf(start) : null;
          const e0 = a.running ? nowMin : (end ? minuteOf(end) : s0);
          dots.push(s0 != null && m >= s0 && m <= e0 ? 1 : 0);
        }
      }
      return {
        id: a.agentId || a.key,
        name: this.displayName(a),
        type: isMain ? 'main' : String(a.name || 'agent'),
        description: a.description || '',
        model: family(modelId) || (modelId ? String(modelId) : null),
        running: isMain ? (this.mainBusy && attState === 'working') : a.running,
        blocked,
        main: isMain,
        start: start || null,
        end: end || null,
        dots,
      };
    });
    // main first, then running/blocked (oldest start first), then done agents newest first. Nothing is dropped.
    const [mainRow, ...subRows] = agents;
    const live = subRows.filter((a) => a.running || a.blocked).sort((x, y) => (x.start || 0) - (y.start || 0));
    const done = subRows.filter((a) => !a.running && !a.blocked).sort((x, y) => (y.end || 0) - (x.end || 0));
    const orderedAgents = [mainRow, ...live, ...done];

    const base = this.projectDir || this.cwd || '';
    const files = [...this.files.values()].filter((f) => f.pending.size || f.saved)
      .sort((a, b) => b.t - a.t).map((f) => {
        const inside = base && f.path.toLowerCase().startsWith(base.toLowerCase());
        let rel = inside ? f.path.slice(base.length).replace(/^[\\/]+/, '') : f.path;
        if (!inside) { const parts = rel.split(/[\\/]/); if (parts.length > 2) rel = '…' + path.sep + parts.slice(-2).join(path.sep); }
        const i = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
        return { dir: i >= 0 ? rel.slice(0, i + 1) : '', base: i >= 0 ? rel.slice(i + 1) : rel,
          added: f.added, removed: f.removed, writing: f.pending.size > 0, created: f.created };
      });
    let edited = 0, written = 0;
    for (const f of this.files.values()) { if (f.edits) edited++; if (f.writes) written++; }

    return {
      id: this.id,
      project: path.basename(base) || this.id.slice(0, 8),
      sessionName: (st && st.session_name) || null,
      startedAt: this.runStart || this.startedAt,
      lastActivity: this.lastActivity,
      live: now - this.lastActivity < 5 * MIN,
      plan: plan || null,
      model: (st && st.model && st.model.display_name) || shortModel(mainModelId) || null,
      branch: this.gitBranch,
      fiveHour: lim(rl.five_hour),
      weekly: lim(rl.seven_day),
      context,
      tpm: { buckets, now: lastMinute },
      models,
      agents: orderedAgents,
      agentTotals: { running: live.filter((a) => !a.blocked).length, blocked: live.filter((a) => a.blocked).length, done: done.length },
      attention: this.attentionView(now),
      changes: { read: this.reads.size, edited, written, files },
    };
  }

  // What the UI needs to show "needs you": state, how long, and what is being asked.
  attentionView(now = Date.now()) {
    const state = this.ended ? 'idle' : this.att.state(now);
    const b = state === 'needs_you' ? this.att.block() : null;
    const view = { state, since: state === 'your_turn' ? this.att.yourTurnSince : null, block: null };
    if (b) {
      const agent = b.agentKey === 'main' ? this.main : this.agents.find((a) => a.key === b.agentKey);
      const modelId = agent ? (agent === this.main ? this.mainModel : (agent.model || agent.modelHint)) : null;
      view.since = b.since;
      view.block = {
        reason: b.reason,              // 'permission' | 'input' | 'question'
        tool: b.tool || null,
        command: describeInput(b.tool, b.input),
        agent: agent ? this.displayName(agent) : (b.agentType || 'main'),
        model: family(modelId) || null,
        message: b.message || null,
        count: this.att.blocks.size,
      };
    }
    return view;
  }

  summary(now = Date.now()) {
    const base = this.projectDir || this.cwd || '';
    return { id: this.id, project: path.basename(base) || this.id.slice(0, 8), lastActivity: this.lastActivity,
      attention: this.attentionView(now) };
  }
}

// "npm install express-rate-limit" for Bash, the file for edits, a short JSON summary otherwise.
function describeInput(tool, input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.command === 'string') return input.command;
  if (input.file_path || input.notebook_path) return input.file_path || input.notebook_path;
  if (input.url) return input.url;
  if (input.pattern) return input.pattern;
  try { const s = JSON.stringify(input); return s.length > 300 ? s.slice(0, 297) + '…' : s; } catch { return null; }
}

module.exports = { Session, account, describeInput };
