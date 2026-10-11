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

/**
 * Detect Allow/Disallow pairs that conflict on the same path within one group.
 * robots precedence is "most specific rule wins", so an Allow that is longer
 * than a Disallow on the same path silently overrides it — a common source of
 * "I blocked /admin/ but search engines still crawl /admin/panel/".
 * @param {object} robots parseRobots output
 * @returns {Array<{ua:string, allow:string, disallow:string}>}
 */
function detectRobotsConflicts(robots) {
  const conflicts = [];
  for (const g of (robots && Array.isArray(robots.groups) ? robots.groups : [])) {
    const dis = (g.disallow || []).map((d) => d.trim()).filter((d) => d !== '');
    const allow = (g.allow || []).map((a) => a.trim()).filter((a) => a !== '');
    if (!dis.length || !allow.length) continue;
    for (const a of allow) {
      // an Allow wins over a Disallow only when it is longer/more specific;
      // equal length is a genuine conflict (crawler-dependent outcome)
      for (const d of dis) {
        if (a.length === d.length) {
          conflicts.push({ ua: g.userAgents.join(','), allow: a, disallow: d });
        } else if (a.length > d.length && a.startsWith(d)) {
          conflicts.push({ ua: g.userAgents.join(','), allow: a, disallow: d });
        }
      }
    }
  }
  return conflicts;
}

module.exports = { parseRobots, detectRobotsConflicts };
