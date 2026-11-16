'use strict';
// "claude-opus-5-5" -> "opus-5.5", "claude-sonnet-4-5-20250929" -> "sonnet-4.5",
// "claude-3-5-haiku-20241022" -> "haiku-3.5", "opus" -> "opus"
function shortModel(id) {
  if (!id || typeof id !== 'string') return null;
  let s = id.toLowerCase().replace(/\[.*?\]/g, '').replace(/^anthropic[./]/, '').replace(/^us\.anthropic\./, '');
  s = s.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-v\d+(:\d+)?$/, '');
  const fam = (s.match(/(opus|sonnet|haiku|fable)/) || [])[1];
  if (!fam) return s;
  const nums = s.replace(fam, '').match(/\d+/g) || [];
  return nums.length ? `${fam}-${nums.slice(0, 2).join('.')}` : fam;
}

function family(id) {
  const s = shortModel(id);
  return s ? s.split('-')[0] : null;
}

module.exports = { shortModel, family };
