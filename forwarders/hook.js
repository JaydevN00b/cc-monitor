#!/usr/bin/env node
// cc-monitor hook forwarder. Reads the hook JSON from stdin, POSTs it to the
// local cc-monitor server and exits 0 as fast as possible. Never blocks Claude
// Code, never prints anything, fails silently if the server is down.
'use strict';
const http = require('http');
const PORT = Number(process.env.CC_MONITOR_PORT) || 4317;
const done = () => process.exit(0);
setTimeout(done, 1500).unref(); // absolute ceiling, whatever happens

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('error', done);
process.stdin.on('end', () => {
  if (!body.trim()) return done();
  try {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/hook', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 300,
    }, (res) => { res.resume(); res.on('end', done); });
    req.on('timeout', () => { req.destroy(); done(); });
    req.on('error', done);
    req.end(body);
  } catch { done(); }
});
