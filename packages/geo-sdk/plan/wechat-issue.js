/**
 * WeChat issue assembly — "3 篇一期" 的选篇策略（2026-11-13）
 * ============================================================================
 * 背景：微信一期 = ONE 图文消息（多 news_item），此前按 publish_order 取 N 篇就发，
 * 结果被 G17/G18/G19 闸门拦掉几篇后，一期只剩 1 篇（2026-11-13 实测第 36 期）。
 *
 * 本模块只做两件纯逻辑的事，不做 I/O、不生成内容：
 *   1. resolvePerIssue — 决定"这一期几篇"（参数 > schedule.count > env > 3）；
 *   2. assembleIssue  — 在有序候选里逐篇跑闸门，PASS 的入选，FAIL 的进"待改写"清单，
 *      继续往后取直到凑满 perIssue（不因为前几篇不合格就缩水）。
 *
 * 闸门通过与否由调用方注入 `check(slug)` 决定（生产=checkArticle，测试=桩），
 * 这样"凑满 3 篇"的边界行为可以被单测直接覆盖，不需要碰平台接口。
 */

/** 每期默认篇数（可用参数 / schedule.count / 环境变量覆盖） */
const DEFAULT_PER_ISSUE = 3;
/** 一期最多考察多少篇候选（防某天候选大面积不合格时无限往下扫） */
const DEFAULT_MAX_CANDIDATES = 8;

/**
 * 解析本期篇数。优先级：显式参数 > schedule 行 count > 环境变量 WECHAT_PER_ISSUE > 默认 3。
 * 只用于 wechat；其他平台 count 语义不变。
 * @param {{perIssue?:number, scheduleCount?:number, env?:object}} [opts]
 * @returns {number} 正整数
 */
function resolvePerIssue({ perIssue, scheduleCount, env = process.env } = {}) {
  const pick = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };
  return pick(perIssue) ?? pick(scheduleCount) ?? pick(env && env.WECHAT_PER_ISSUE) ?? DEFAULT_PER_ISSUE;
}

/**
 * 组装一期：有序候选 → 入选 / 待改写 / 缺口。
 *
 * 行为：
 *   - 候选顺序由调用方给（现状 = 已登记 todo 优先 → blog publish_order 升序）；
 *   - 逐篇跑 check，PASS 收进 ready（凑满 perIssue 即停）；
 *   - FAIL 收进 needsRepair（不丢弃、不判死，留给"按渠道改写"环节处理）；
 *   - 最多考察 maxCandidates 篇；考察完仍不足 perIssue 记 shortage。
 *
 * @param {object} opts
 * @param {Array<{slug:string, title?:string}>} opts.candidates 有序候选
 * @param {number} [opts.perIssue] 本期要几篇（默认 3）
 * @param {number} [opts.maxCandidates] 最多考察几篇（默认 8）
 * @param {(slug:string)=>Promise<{ok:boolean, failures?:string[]}>} opts.check 闸门（注入）
 * @returns {Promise<{perIssue:number, ready:Array, needsRepair:Array, shortage:number, tried:number}>}
 */
async function assembleIssue({ candidates = [], perIssue, maxCandidates, check } = {}) {
  if (typeof check !== 'function') throw new Error('assembleIssue requires a check(slug) function');
  const want = Number(perIssue) > 0 ? Math.floor(Number(perIssue)) : DEFAULT_PER_ISSUE;
  const cap = Number(maxCandidates) > 0 ? Math.floor(Number(maxCandidates)) : DEFAULT_MAX_CANDIDATES;

  const ready = [];
  const needsRepair = [];
  let tried = 0;

  for (const c of candidates) {
    if (ready.length >= want) break;
    if (tried >= cap) break;
    tried += 1;
    let verdict;
    try {
      verdict = await check(c.slug);
    } catch (e) {
      // 检查本身出错时按"待改写"处理：绝不因为检查异常就把文章判死
      needsRepair.push({ slug: c.slug, title: c.title || null, failures: [`check error: ${e.message}`] });
      continue;
    }
    if (verdict && verdict.ok) {
      ready.push({ slug: c.slug, title: c.title || null });
    } else {
      needsRepair.push({ slug: c.slug, title: c.title || null, failures: (verdict && verdict.failures) || ['unknown'] });
    }
  }

  return { perIssue: want, ready, needsRepair, shortage: Math.max(0, want - ready.length), tried };
}

module.exports = {
  DEFAULT_PER_ISSUE,
  DEFAULT_MAX_CANDIDATES,
  resolvePerIssue,
  assembleIssue,
};
