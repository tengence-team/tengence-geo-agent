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
 * WordPress 官方默认 robots 模板中的"刻意 Allow 长于 Disallow"组合，
 * 属标准语义而非缺陷，豁免不列入冲突：
 *   - Allow /wp-admin/admin-ajax.php  vs Disallow /wp-admin/
 *     （admin-ajax.php 是前端 AJAX 接口，必须放行；其余 wp-admin 禁爬）
 *   - Allow /wp-content/themes/…/assets/images/ vs Disallow /wp-content/themes/
 *     （文章/主题图片应可被搜索引擎收录）
 * @param {string} allow
 * @param {string} disallow
 * @returns {boolean}
 */
function isWpStandardPair(allow, disallow) {
  if (allow === '/wp-admin/admin-ajax.php' && disallow === '/wp-admin/') return true;
  if (
    disallow === '/wp-content/themes/' &&
    allow.startsWith('/wp-content/themes/') &&
    allow.includes('/assets/images/')
  ) {
    return true;
  }
  return false;
}

/**
 * Detect Allow/Disallow pairs that conflict on the same path within one group.
 * robots precedence is "most specific rule wins", so an Allow that is longer
 * than a Disallow on the same path silently overrides it — a common source of
 * "I blocked /admin/ but search engines still crawl /admin/panel/".
 * WordPress official default-template pairs are intentionally excluded.
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
        if (isWpStandardPair(a, d)) continue;
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
