/**
 * diagnose/robots.js — robots.txt parser (zero deps)
 */

function parseRobots(text) {
  const raw = String(text || '');
  const out = {
    exists: raw.trim().length > 0,
    sitemaps: [],
    groups: [],
    raw: raw.slice(0, 2000),
  };
  if (!out.exists) return out;

  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const idx = s.indexOf(':');
    if (idx === -1) continue;
    const k = s.slice(0, idx).trim().toLowerCase();
    const v = s.slice(idx + 1).trim();
    if (k === 'sitemap') {
      out.sitemaps.push(v);
    } else if (k === 'user-agent') {
      current = { userAgents: [v.toLowerCase()], disallow: [], allow: [] };
      out.groups.push(current);
    } else if (k === 'disallow' && current) {
      current.disallow.push(v);
    } else if (k === 'allow' && current) {
      current.allow.push(v);
    }
  }
  return out;
}

module.exports = { parseRobots };
