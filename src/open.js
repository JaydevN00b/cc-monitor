'use strict';
// Open the panel as a chromeless "app" window.
// Windows: Edge --app (always installed). macOS/Linux: Chrome/Chromium/Edge/Brave --app, else default browser.
// A dedicated --user-data-dir makes the window open at the requested size as its own
// window instead of becoming a tab in an already-running browser.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { paths } = require('./config');

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

function candidates() {
  const p = process.platform;
  if (p === 'win32') {
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const list = [];
    for (const base of pf) list.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const base of pf) list.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    return list.filter((f) => fs.existsSync(f)).concat([which('msedge'), which('chrome')].filter(Boolean));
  }
  if (p === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ].filter((f) => fs.existsSync(f));
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']
    .map(which).filter(Boolean);
}

function openWindow(url) {
  const browser = candidates()[0];
  if (browser) {
    const profile = path.join(paths.home, 'browser-profile');
    fs.mkdirSync(profile, { recursive: true });
    const args = [`--app=${url}`, '--window-size=540,1220', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=Translate'];
    const child = spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => fallback(url));
    child.unref();
    return { browser, appMode: true };
  }
  fallback(url);
  return { browser: 'default browser', appMode: false };
}

function fallback(url) {
  const p = process.platform;
  const [cmd, args] = p === 'win32' ? ['cmd', ['/c', 'start', '', url]] : p === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

module.exports = { openWindow };
