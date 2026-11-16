# cc-monitor

A live session monitor for [Claude Code](https://claude.com/claude-code) that runs in its own small window next to your terminal. Every display is a dot-matrix readout: your subscription limits, context, tokens per minute, models, agents and file changes, all updating as Claude works.

![cc-monitor screenshot](docs/screenshot.png)
<!-- screenshot placeholder: add docs/screenshot.png -->

It shows subscription usage, not dollar cost. No dollar figures appear anywhere.

| Section | What it shows |
|---|---|
| Header | Project, LIVE + session timer, plan chip (PRO / MAX / TEAM / API), main model, git branch, session switcher when several are active |
| 5-hour limit | Big dot-matrix % and time until reset |
| Weekly limit | 100-dot strip, % and reset day/time |
| Context | % of the context window used, tokens used / window size |
| Tokens/min | Equalizer for the last 30 minutes. The newest minute pulses |
| Models | Every model used this session (main + subagents) and its share of tokens |
| Agents | Main plus every subagent, including parallel ones: its model, a dot per minute (running = accent, done = grey), elapsed time |
| Changes | Files read / edited / written, +/− lines, WRITING while a write is in flight, SAVED after |

## Install

Requires Node 18+ and Claude Code. Works on Windows, macOS and Linux.

```sh
npx cc-monitor install   # wire the hooks + status line into ~/.claude/settings.json
npx cc-monitor           # start the server and open the window
```

Restart any Claude Code sessions that were already running so they pick up the hooks.

`install` first backs up `~/.claude/settings.json` to `~/.cc-monitor/backups/`. It then:

- copies two small forwarder scripts to `~/.cc-monitor/bin/` (a stable path, so it still works after the npx cache is cleared)
- appends one hook entry for `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop` and `SessionEnd`. Your existing hooks are left alone
- sets `statusLine` to cc-monitor's script. If you already had a status line, it is remembered and **chained**: yours still runs and its output is what you see

Running `install` again is safe. It never adds duplicates.

## Uninstall

```sh
npx cc-monitor uninstall
```

This removes only cc-monitor's hook entries and puts your previous status line back (or removes the key if you had none). A backup is taken first. You can then delete `~/.cc-monitor/`.

## Other commands

```sh
cc-monitor plan max      # override the plan chip (pro | max | team | api | auto)
cc-monitor status        # installed? running? detected plan
cc-monitor --no-open     # server only
cc-monitor --capture     # also log raw payloads to ~/.cc-monitor/capture.jsonl
```

The port is `4317` (localhost only). Set `CC_MONITOR_PORT` to change it.

## How it works

```
Claude Code ──status line JSON──▶ statusline.js ──POST /status──┐
            ──hook JSON─────────▶ hook.js       ──POST /hook────┤
            ──writes transcripts (JSONL)─────────── tailed ─────┤
                                                                 ▼
                                    cc-monitor server (127.0.0.1:4317)
                                                                 │ WebSocket
                                                                 ▼
                                       app-mode window (Edge / Chrome)
```

- **Status line**: Claude Code pipes session JSON to the status line command. It carries `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`), `context_window.*` and `model`. The script forwards it (300 ms timeout) and prints your status line, or a short one of its own. The `cost` block is dropped on arrival.
- **Hooks**: one script for every event. It POSTs stdin to the server and exits 0 right away (300 ms request timeout, 1.5 s hard ceiling). It prints nothing and fails silently when the server is down, so it never blocks Claude. Subagents are recorded when the `Agent`/`Task` tool is called (type, description, model) and finish on `SubagentStop`.
- **Transcripts**: the server tails the session JSONL and every `subagents/agent-*.jsonl`. Each subagent's `.meta.json` links it to the `Agent` call that spawned it, which keeps parallel subagents apart. Token usage is summed from `message.usage` on assistant entries, per model and per minute. Entries are deduplicated by `message.id`, because Claude Code writes one entry per content block. "Tokens" means input + cache-write + output. Cache reads are left out, since counting them would re-count the whole context on every turn. Set `"countCacheReads": true` in `~/.cc-monitor/config.json` to include them.
- **Plan**: read from `oauthAccount.organizationType` / `organizationRateLimitTier` in `~/.claude.json`. Only those fields are read, and the credentials file is never opened. `cc-monitor plan <name>` overrides it.
- **Sessions**: the window follows the most recently active session. A switcher appears when several are active. A session disappears when it ends: on the `SessionEnd` hook, or when its Claude Code process is gone (checked through `~/.claude/sessions/<pid>.json`). Headless `claude -p` runs drop out after 10 minutes idle.
- Sessions already running when cc-monitor starts are picked up from their transcripts.
- Headless (`-p`) runs don't call the status line, so their context window size shows as "—". Missing values always show "—".

## Development

```sh
npm install
npm test          # install/uninstall round trip in a throwaway config dir
node bin/cc-monitor.js
```

## License

MIT
