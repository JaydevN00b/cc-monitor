'use strict';
// Polling JSONL tailer. Cross-platform (fs.watch is unreliable on network drives,
// WSL and some macOS setups), cheap: one fs.stat per file per tick.
const fs = require('fs');

class Tailer {
  constructor(file, onEntry) {
    this.file = file;
    this.onEntry = onEntry;
    this.offset = 0;
    this.rest = '';
    this.busy = false;
  }

  poll() {
    if (this.busy) return;
    let st;
    try { st = fs.statSync(this.file); } catch { return; }
    if (st.size < this.offset) { this.offset = 0; this.rest = ''; } // truncated / rewritten
    if (st.size === this.offset) return;
    this.busy = true;
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(this.file, 'r');
      try { fs.readSync(fd, buf, 0, len, this.offset); } finally { fs.closeSync(fd); }
      this.offset = st.size;
      const text = this.rest + buf.toString('utf8');
      const lines = text.split('\n');
      this.rest = lines.pop(); // partial last line, finish next time
      for (const line of lines) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        try { this.onEntry(e); } catch (err) { if (process.env.CC_MONITOR_DEBUG) console.error(err); }
      }
    } finally { this.busy = false; }
  }
}

module.exports = { Tailer };
