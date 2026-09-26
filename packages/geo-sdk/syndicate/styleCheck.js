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
