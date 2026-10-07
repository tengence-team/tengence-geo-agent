/**
 * geo_solution domain — end-to-end from a fixture diagnosis report
 * ============================================================================
 * Pins the GEO/SEO implementation-plan contract:
 *   - generateSolution reads the site's latest diagnosis report (data/reports/)
 *   - default output: 19 top-level chapters, NO pricing chapter
 *   - quote:true: 21 chapters incl. 报价方案 + 年度例行费用
 *   - diagnosis fail items (P0 rows) are mapped into the plan §一 problem list
 *   - evidence lines (§4.4/§5.5/§7.2/…) surface inside the matching plan chapters
 *   - the plan lands at <site>/data/plans/<YYYYMMDD>-<site>-geo-solution.md and is readable back
 *   - a site without a diagnosis report fails loudly (never invents content)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = require('../packages/geo-sdk/site');
const geo = require('../packages/geo-sdk/geo_solution');

let TMP;
let SITE_KEY = 'fixture_site';

const REPORT = `# fixture.example.com GEO/SEO 全面诊断报告

> 诊断时间：2026-10-01　诊断工具：tengence geo-agent（diagnose_site）
> 站点 key：fixture_site　报告路径：data/reports/20261001-fixture_site-diagnosis.md

## 1. 执行摘要

### 健康度总评

| 维度 | 评分 | 判断 |
|---|---|---|
| 技术基础设施（HTTPS/协议/重定向/压缩） | 8.0 / 10 | HTTP/2 达标，缓存头缺失 |
| 内容可抓取性（Crawlability / 渲染方式） | 7.0 / 10 | SSR 内容直接进 HTML |
| 页面 SEO 基础（Title/Meta/Canonical/图片） | 4.0 / 10 | Title 重复，图片 alt 缺失 |
| 索引架构（Sitemap/URL 规范/错误页） | 2.0 / 10 | sitemap 仅 19 URL，12 个稳定 500 |
| 结构化数据 | 1.0 / 10 | 全站零 JSON-LD |
| 多语言 / 国际化 | 2.0 / 10 | 仅中文，英文不可索引 |
| 性能与 CDN | 5.0 / 10 | 无 CDN，HTTP/1.1 |
| 安全 | 6.0 / 10 | 证书有效，缺 HSTS 外补充头 |
| GEO / AI 可引用性 | 2.0 / 10 | 无 llms.txt，AI 爬虫可达但无结构化 |
| 品牌与信任信号 | 6.0 / 10 | 老域名 + 认证资质 |

**综合评分：约 4.3 / 10**　**GEO 就绪度：约 2.5 / 10**

### 一句话结论
> 内容在、机器读不全。

### 3 个必须立刻处理的问题
1. **sitemap 仅 19 URL 漏报约 46 页** —— 证据：robots 引用 sitemap 但收录不全；影响：索引覆盖率不足。
2. **12 个稳定 500 软错误** —— 证据：list/15–30 区间反复 500；影响：消耗抓取预算。
3. **全站 Title/Meta 重复 + 零 JSON-LD** —— 证据：页面无差异化；影响：长尾不起量、AI 无法抽取。

## 2. 站点全景与规模盘点

### 2.1 URL 规模实测（evidence.scale + 代表页）

| 页面类型 | sitemap 收录数 | 实测可达（200） | 关键发现 |
|---|---:|---:|---|
| 产品类 | 4 | 4 | 参数页可访问 |
| 新闻类 | 0 | 43 | 漏报 |
| **合计** | **19** | **≈65** | 覆盖不足 |

## 3. 站点画像与技术栈

| 维度 | 现状（实测） |
|---|---|
| 技术栈 / 渲染方式 | PHP SSR |

## 4. 技术 SEO 基础

### 4.4 安全响应头与 Cookie
- 证书有效剩余 180 天；HSTS 存在；Cookie 缺 Secure 标志。

### 4.5 robots.txt 与 Sitemap
- robots.txt 存在但 sitemap 仅 19 URL，12 个稳定 500 未清理。

## 5. 页面级 SEO 诊断
- **5.5 内容厚度**：正文直接进 HTML（SSR），非 JS 空壳，可读性良好。

## 6. 内容与多语言诊断
- **6.3 英文/多语言版**：仅 ?l=en 参数切换不可索引，无独立英文 URL。

## 7. 结构化数据与 GEO 基础
- **7.1 JSON-LD 覆盖**：全站零 JSON-LD。
- **7.2 llms.txt**：未部署 /llms.txt。
- **7.3 AI 爬虫可达性**：GPTBot/Googlebot 均 200 拿到完整内容，robots 未屏蔽。

## 8. GEO 专项（CITE 框架 + AI 可见性）

| 维度 | 现状 | 评分 |
|---|---|---|
| Crawlable（可抓取） | 内容可抓取 | 7 / 10 |
| Identifiable（可识别实体） | 零 JSON-LD | 2 / 10 |
| Trustworthy（可信） | 老域名 + 认证 | 6 / 10 |
| Extractable（可抽取） | 无可抽取结构化 | 1 / 10 |

**GEO 就绪度 ≈ 4 / 10**

## 9. 关键词策略与可见度（外部观察）
- SERP 抽样结论：品牌词可见，品类词零排名。

## 11. 问题汇总与优先级

| 优先级 | 问题 | 类别 | 修复成本 |
|---|---|---|---|
| P0 | sitemap 全量补全 | 索引架构 | 低 |
| P0 | 500 软错误清理 | 索引架构 | 低 |
| P1 | 英文独立版 + hreflang | 国际化 | 中 |
`;

const HEADER_LINE = `# fixture.example.com GEO/SEO 优化实施方案`;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-solution-'));
  site.setSitesRoot(TMP);
  site.initSite({ key: SITE_KEY, domain: 'fixture.example.com' });
  const reportsDir = path.join(TMP, SITE_KEY, 'data', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, '20261001-fixture_site-diagnosis.md'), REPORT, 'utf8');
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('geo_solution: 19 chapters, no quote by default, fail items mapped, lands in data/plans', async () => {
  const res = await geo.generateSolution({ site: SITE_KEY });
  assert.equal(res.ok, true);
  assert.equal(res.chapters, 19, 'default plan = 19 top-level chapters (no pricing)');
  assert.equal(res.quote_included, false);

  const content = fs.readFileSync(res.path, 'utf8');
  assert.ok(content.startsWith(HEADER_LINE), 'plan header present');
  assert.ok(res.path.includes(path.join('data', 'plans', `${res.filename}`)), 'lands under data/plans/');
  assert.ok(fs.existsSync(res.path), 'plan file exists on disk');
  assert.ok(res.filename.endsWith('-geo-solution.md'));

  // diagnosis P0 items surface in §一 problem list
  assert.ok(content.includes('sitemap 仅 19 URL 漏报约 46 页') || content.includes('sitemap 全量补全'), 'P0 mapped into plan');
  assert.ok(content.includes('12 个稳定 500') || content.includes('500 软错误清理'), 'P0 mapped into plan');
  // evidence-driven strategy: SSR keeps the current stack (no rebuild branch)
  assert.ok(!content.includes('重建服务端渲染'), 'SSR evidence → repair, not rebuild');
  // evidence lines surface in the matching chapters
  assert.ok(content.includes('llms.txt'), 'llms evidence referenced');
  assert.ok(content.includes('AI 爬虫'), 'AI reachability evidence referenced');
  // no pricing by default
  assert.ok(!content.includes('人日单价'), 'quote chapter absent by default');
});

test('geo_solution: quote:true appends the 2 pricing chapters (21 total)', async () => {
  const res = await geo.generateSolution({
    site: SITE_KEY,
    quote: true,
    unitRates: { 'SEO 策略师': 2200 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.chapters, 21, 'quote plan = 21 top-level chapters');
  assert.equal(res.quote_included, true);

  const content = fs.readFileSync(res.path, 'utf8');
  assert.ok(content.includes('人日单价'), 'pricing chapter present');
  assert.ok(content.includes('¥2200'), 'unit_rates override applied');
  assert.ok(content.includes('年度例行费用') || content.includes('维保'), 'annual budget chapter present');
});

test('geo_solution: sites without a diagnosis report fail loudly', async () => {
  const key = 'empty_site';
  site.initSite({ key, domain: 'empty.example.com' });
  await assert.rejects(
    () => geo.generateSolution({ site: key }),
    /No diagnosis report found/,
    'must refuse to invent a plan without diagnosis evidence',
  );
});
