Build "cc-monitor": a live session monitor that runs in its own window next to Claude Code. Do everything yourself end to end (scaffold, code, wire into my Claude Code, test, run it). Only stop to ask me for logins. I'm on Windows, but it must also work on macOS and Linux.

DESIGN
design-live.html in this folder is the approved design for the real panel. Match it closely: pure black, dot-matrix SVG displays (lit dots vs dim #1D1D1D dots), JetBrains Mono labels, Space Grotesk title, one vermilion accent #FF4D1A used only for live things. The window is that panel alone (about 520px wide), updating live. design-promo.html is only my marketing mockup; ignore it for the build.

WHAT IT SHOWS (subscription usage, not dollar cost)
1. Header: project name, LIVE dot + session timer, chips for my PLAN (Pro / Max / Team / API) and the main MODEL, git branch.
2. 5-hour limit: big dot-matrix % (needs a '%' glyph) + "resets in Xh Ym".
3. Weekly limit: 100-dot strip + % + reset time.
4. Context: dot strip, % used, tokens used / window size.
5. Tokens/min: dot equalizer for the last 30 minutes, newest column in accent and pulsing.
6. Models: every model used this session (main + subagents), each with a dot bar of its share of tokens and a %.
7. Agents: one row per agent (main + every subagent, including several running in parallel): name, which model it runs on, a dot timeline with one dot per minute (running = accent, done = grey), elapsed time.
8. Changes: files read/edited/written, +/- line counts, WRITING tag while a write is in progress, SAVED after.
No dollar figures anywhere in the UI.

DATA SOURCES (verify; don't assume field names)
- Status line: Claude Code pipes session JSON to the statusLine command on stdin. Write a Node status-line script that POSTs that JSON to the local server and still prints a short normal status line. Expect model info, context_window.*, and rate_limits.five_hour / rate_limits.seven_day (used_percentage, maybe reset times). If I already have a statusLine configured, chain it: run mine, print its output, forward the JSON.
- Hooks: PreToolUse, PostToolUse, SubagentStop, SessionStart, Stop → a single Node hook script that POSTs the stdin JSON to the server and exits 0 fast (never block Claude; ~300ms timeout; fail silently if the server is down). Subagents start on the Task/Agent tool call (record subagent type/name and its model); they end on SubagentStop.
- Transcripts: tail the session JSONL at transcript_path and each subagent's transcript. Sum message.usage tokens on assistant entries, per model (message.model) and per minute, for the tokens/min, models and agents sections.
- Plan: find where Claude Code exposes the subscription type locally (status-line JSON, or Claude Code's local config/account files; never read or log credential tokens). If it can't be found reliably, add a `plan` setting in cc-monitor's config that I set once, and show that.
FIRST STEP: install the forwarders in capture mode, run a real Claude Code session in a second terminal yourself (e.g. `claude -p "read package.json, then use a subagent to summarise the README"`), log the raw payloads, and build the parsers against the real fields you observe. Handle missing fields gracefully (show "—").

ARCHITECTURE
- Node 18+, minimal dependencies (ws is fine). No jq, no bash. Hook commands must be `node "<absolute path>"` so they work on Windows.
- Local server on 127.0.0.1:4317 only: receives POSTs, keeps state per session, pushes updates to the UI over WebSocket, serves the UI. Show the most recently active session, plus a small switcher if there are several.
- Window: app mode. On Windows `msedge --app=http://127.0.0.1:4317 --window-size=540,1220`; on mac/Linux Chrome `--app` if found, else the default browser.
- CLI: `cc-monitor install` (back up ~/.claude/settings.json, then merge the hooks + statusLine without clobbering existing entries), `cc-monitor uninstall` (restore cleanly), `cc-monitor` (start the server + open the window). Package it so `npx cc-monitor` works. Check whether the name is free on npm and suggest an alternative if not. Don't publish; I'll log in and publish myself.

DONE MEANS
Installed into my real Claude Code, server running, window open, and verified live with a real session in another terminal that reads files, edits a file and runs two subagents in parallel; every section updates. Then write a short README (install, uninstall, how it works, screenshot placeholder) and initialize git with a first commit. Tell me exactly what you changed in my settings.json.
