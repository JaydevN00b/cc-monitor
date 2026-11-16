'use strict';
// Subscription plan detection.
// 1) `plan` in ~/.cc-monitor/config.json wins (set with `cc-monitor plan max`).
// 2) Otherwise ~/.claude.json -> oauthAccount.organizationType / organizationRateLimitTier.
//    Only those non-secret fields are read. ~/.claude/.credentials.json is never opened.
// 3) No OAuth account but an API key in the environment -> API.
const fs = require('fs');
const { paths, readConfig } = require('./config');

let cache = { at: 0, value: null };

function fromClaudeJson() {
  let j;
  try { j = JSON.parse(fs.readFileSync(paths.claudeJson, 'utf8')); } catch { return null; }
  const oa = j && j.oauthAccount;
  if (!oa) return null;
  const type = String(oa.organizationType || '').toLowerCase();
  const tier = String(oa.organizationRateLimitTier || oa.userRateLimitTier || '').toLowerCase();
  const mult = (tier.match(/(\d+)x/) || [])[1];
  if (type.includes('max')) return mult ? `MAX ${mult}X` : 'MAX';
  if (type.includes('pro')) return 'PRO';
  if (type.includes('team')) return 'TEAM';
  if (type.includes('enterprise')) return 'ENTERPRISE';
  if (type.includes('api') || oa.billingType === 'api') return 'API';
  return null;
}

function detectPlan() {
  const now = Date.now();
  if (now - cache.at < 60_000) return cache.value;
  const cfg = readConfig();
  let value = null;
  if (cfg.plan) value = String(cfg.plan).toUpperCase();
  if (!value) value = fromClaudeJson();
  if (!value && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) value = 'API';
  cache = { at: now, value };
  return value;
}

module.exports = { detectPlan };
