'use strict';
/**
 * Deterministic platform-style validation (tengence-geo-sdk/syndicate/styleCheck)
 * ============================================================================
 * Hard, rule-based checks against a platform's style file (styles/*.yaml). This is
 * the "校验" half of the MCP surface — it never rewrites content, it only reports
 * whether a given title/body already satisfies the platform's constraints.
 *
 * The semantic rewrite (title hooks, body restructuring) lives in the Skill /
 * harness, NOT here, so the server stays free of any content-generation role.
 *
 * Checks performed:
 *   - title length vs rewrite.title.max
 *   - title forbidden words (rewrite.title.forbidden)
 *   - body length vs minChars / maxChars
 *   - required CTA presence (rewrite.cta.required)
 *   - required internal links (rewrite.internalLinks.required)
 *   - removeBlocks that must NOT appear
 *   - forbiddenPhrases (marketing phrases banned by the platform audit) that must NOT appear
 *   - externalLinks: brand link classification (anti-drainage) — denied conversion
 *     URLs are always errors; article-page URLs are allowed up to maxBrandLinks
 *     and only inside the trailing 延伸阅读 area
 *   - keepBlocks that SHOULD appear (warning only)
 *
 * Returns { ok, errors[], warnings[], strategy, checklist[], platform }.
 * `ok` is true only when errors is empty; warnings never block.
 */

const registry = require('./registry');

/** Count characters with full Unicode (CJK) awareness. */
function charLen(s) {
  return [...String(s)].length;
}

/**
 * Validate title + body against a platform's style rules.
 * @param {{platform:string, title?:string, body?:string}} args
 * @returns {{ok:boolean, errors:string[], warnings:string[], strategy:?string, checklist:string[], platform:string}}
 */
function check({ platform, title, body }) {
  const p = registry.getPlatform(platform);
  if (!p) {
    throw new Error(`Unknown platform: "${platform}" (not in syndicate registry)`);
  }
  const rw = p.rewrite || {};
  const errors = [];
  const warnings = [];

  // ---- title ----
  if (title != null) {
    const t = String(title);
    const tMax = rw.title && rw.title.max;
    if (tMax && charLen(t) > tMax) {
      errors.push(`标题超出 ${tMax} 字（当前 ${charLen(t)} 字）`);
    }
    const forb = (rw.title && rw.title.forbidden) || [];
    for (const w of forb) {
      if (t.includes(w)) errors.push(`标题含违禁词『${w}』`);
    }
  }

  // ---- body ----
  if (body != null) {
    const b = String(body);
    const bLen = charLen(b);
    const min = rw.body && rw.body.minChars;
    const max = rw.body && rw.body.maxChars;
    if (min && bLen < min) {
      warnings.push(`正文偏短（${bLen} 字 < 建议 ${min} 字）`);
    }
    if (max && bLen > max) {
      errors.push(`正文超出 ${max} 字（当前 ${bLen} 字）`);
    }

    // required CTA
    const cta = rw.cta;
    if (cta && cta.required) {
      const tokens = ['关注', '回复', '领取', '订阅'].filter(Boolean);
      const hasCta = tokens.some((tk) => b.includes(tk));
      if (!hasCta) {
        warnings.push(`缺少 CTA 引导（建议：${cta.text || '关注/回复引导'}）`);
      }
    }

    // required internal links
    const il = rw.internalLinks;
    if (il && il.required) {
      const hasLink =
        /\[[^\]]+\]\([^)]+\)/.test(b) ||
        b.includes('](/') ||
        b.includes('](http');
      if (!hasLink) {
        warnings.push('缺少内链（主题集群要求至少 2-3 个）');
      }
    }

    // removeBlocks must not appear
    const remove = rw.removeBlocks || [];
    for (const blk of remove) {
      if (blk && b.includes(blk)) errors.push(`应删除块：『${blk}』`);
    }

    // forbiddenPhrases: marketing phrases banned by the platform's audit rules
    // (e.g. Juejin §5 "发布广告内容"). Hit = hard error.
    const phrases = rw.forbiddenPhrases || [];
    for (const ph of phrases) {
      if (ph && b.includes(ph)) errors.push(`禁用营销短语：『${ph}』`);
    }

    // externalLinks: classify brand-domain links (anti-drainage rule).
    // Two kinds are distinguished, because the platform ban targets CONVERSION
    // drainage, not editorial cross-references:
    //   - denied  (首页/产品/定价/注册/控制台…)          -> always an error
    //   - allowed (本站文章正文 /blog/article/)         -> permitted, count may be
    //     unrestricted when maxBrandLinks < 0 (「相关阅读」/ 引用不限条数)
    // Third-party citations are never counted.
    const el = rw.externalLinks;
    if (el && el.maxBrandLinks != null) {
      const pats = Array.isArray(el.brandDomainPatterns) ? el.brandDomainPatterns : [];
      const urls = String(b).match(/https?:\/\/[^\s)"']+/g) || [];
      const brandHits = urls.filter((u) => pats.some((d) => d && u.includes(d)));
      const unique = [...new Set(brandHits)];
      const limit = Number(el.maxBrandLinks);
      // maxBrandLinks < 0 means "no cap" (相关阅读 / 引用条数不限)
      const unlimited = !(limit >= 0);

      const denied = Array.isArray(el.brandLinkDeniedPatterns) ? el.brandLinkDeniedPatterns : [];
      const allowed = Array.isArray(el.brandLinkAllowedPatterns) ? el.brandLinkAllowedPatterns : [];

      // (1) conversion / marketing landing pages: hard ban regardless of count
      for (const u of unique) {
        const hit = denied.find((p) => p && u.includes(p));
        if (hit) {
          errors.push(`禁止的转化链接（营销落点）：${u}（命中『${hit}』）`);
        }
      }

      // (2) non-article brand URLs that are not explicitly denied either
      for (const u of unique) {
        if (allowed.some((p) => p && u.includes(p))) continue;
        if (denied.some((p) => p && u.includes(p))) continue; // already reported above
        errors.push(`本站链接须指向文章正文页（${allowed.join(' | ')}）：${u}`);
      }

      // (3) count cap applies to the surviving editorial article links.
      //     A negative maxBrandLinks disables the cap entirely.
      const editorial = unique.filter((u) => allowed.some((p) => p && u.includes(p)));
      if (limit >= 0 && editorial.length > limit) {
        errors.push(
          `文末延伸阅读链接 ${editorial.length} 个，超出上限 ${limit}（引流风险）：${editorial.slice(0, 3).join(', ')}`
        );
      }

      // (4) placement hint: brand links read better grouped in a trailing 相关阅读
      //     block. Advisory only (warnings) — the count is unrestricted, and this
      //     stays a hint so it never blocks publication on its own.
      if (el.brandLinkTailOnly && editorial.length) {
        const heads = [...String(b).matchAll(/(^|\n)##\s+/g)];
        const tailStart = heads.length ? (heads[heads.length - 1].index || 0) + 1 : -1;
        if (tailStart >= 0) {
          for (const u of editorial) {
            const at = String(b).indexOf(u);
            if (at >= 0 && at < tailStart) {
              warnings.push(`本站链接建议集中在文末『相关阅读』区（最后一个二级标题之后）：${u}`);
            }
          }
        }
      }

    }
    // NOTE: when maxBrandLinks < 0 there is no count cap at all — only the
    // denied / allowed-path checks above still gate the content.

    // keepBlocks should appear (warning only)
    const keep = rw.keepBlocks || [];
    for (const blk of keep) {
      if (blk && !b.includes(blk)) warnings.push(`建议保留块：『${blk}』`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    strategy: rw.strategy || null,
    checklist: rw.checklist || [],
    platform,
  };
}

module.exports = { check, charLen };
