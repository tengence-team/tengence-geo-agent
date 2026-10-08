'use strict';
/**
 * Translation gate (T1–T9) unit tests — packages/geo-sdk/translate/gate.js
 * Run: node --test tests/translation-gate.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { checkTranslation } = require('../packages/geo-sdk/translate/gate');

// ---- fixtures -------------------------------------------------------------

const SOURCE_MD = `---
seo:
  meta_title: "GEO 与 SEO 的区别"
  meta_description: "生成式引擎优化 GEO 与 SEO 在机制、目标与数据来源上的五大区别，帮助企业双引擎获客。"
  slug: geo-vs-seo
  og_image: "https://tengence.com/assets/images/geo-vs-seo-og.png"
featured_image: "https://tengence.com/assets/images/geo-vs-seo-hero.png"
---

# GEO 与 SEO 的区别

> **摘要**：GEO 与 SEO 是双引擎获客的两条腿，机制互补、目标一致。

## 一、定义与目标

GEO（生成式引擎优化）与 SEO（搜索引擎优化）服务于不同引擎。GEO 面向 AI 搜索引擎，SEO 面向传统搜索。2026 年预计 12.5% 的流量来自 AI 回答。

## 二、五大区别

1. 机制不同：GEO 优化实体认领，SEO 优化关键词。
2. 数据来源不同：GEO 看重引用密度，SEO 看重外链。

## Key Takeaways

- GEO 与 SEO 互补而非替代
- 双引擎策略覆盖两类引擎

## 常见问题

> **问：GEO 会取代 SEO 吗？**
>
> 答：不会，两者服务于不同引擎。

## 数据来源

- [GEO 行业报告 2026](https://example.com/geo-report-2026)
- [SEO 官方指南](https://example.com/seo-guide)

## 相关阅读

- [双引擎策略详解](/blog/dual-engine-strategy/)

## 立即行动

联系通智 GEO 获取 AI 可见性评估。
`;

const EN_MD = `---
seo:
  meta_title: "GEO vs. SEO: 5 Key Differences"
  meta_description: "Generative Engine Optimization (GEO) and SEO differ in mechanism, goal, and data sources. Learn the five key differences for a dual-engine acquisition strategy."
  slug: geo-vs-seo
  og_image: "https://tengence.com/assets/images/geo-vs-seo-og.png"
featured_image: "https://tengence.com/assets/images/geo-vs-seo-hero.png"
---

# GEO vs. SEO: Key Differences

> **Summary:** GEO and SEO serve different engines: GEO targets AI search, SEO targets traditional search.

## 1. Definition and Goals

GEO (Generative Engine Optimization) and SEO (search engine optimization) serve different engines. GEO optimizes entity claiming, SEO optimizes keywords. In 2026, 12.5% of traffic is expected to come from AI answers.

## 2. Five Key Differences

1. Mechanism differs: GEO optimizes entity signals, SEO optimizes keywords.
2. Data sources differ: GEO values citation density, SEO values backlinks.

## Key Takeaways

- GEO and SEO complement, not replace, each other
- A dual-engine strategy covers both engine families

## FAQ

> **Q: Will GEO replace SEO?**
>
> A: No, they serve different engines.

## Data Sources

- [GEO Industry Report 2026](https://example.com/geo-report-2026)
- [Official SEO Guide](https://example.com/seo-guide)

## Related Reading

- [Dual-engine strategy deep dive](/blog/dual-engine-strategy/)

## Get Started

Contact Tengence GEO for an AI visibility assessment.
`;

// ---- tests ----------------------------------------------------------------

test('T1–T8 all pass for a faithful en translation', () => {
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: EN_MD, targetLang: 'en' });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

test('T1: missing block fails', () => {
  const bad = EN_MD.replace(/^## Key Takeaways[\s\S]*?(?=^## )/m, '');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T1' && /Key Takeaways|takeaways/.test(e.message)));
});

test('T1: broken H2 numbering fails', () => {
  const bad = EN_MD.replace('## 2. Five Key Differences', '## 3. Five Key Differences');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T1' && /numbering|sequence/.test(e.message)));
});

test('T2: dropped source link fails', () => {
  const bad = EN_MD.replace('](https://example.com/seo-guide)', ']()');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T2' && /seo-guide/.test(e.message)));
});

test('T2: invented target link fails', () => {
  const bad = EN_MD.replace('## Get Started', '## Get Started\n\nSee [extra](https://example.com/extra).');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T2' && /extra/.test(e.message)));
});

test('T3: dropped image fails (incl. featured_image)', () => {
  const bad = EN_MD.replace('https://tengence.com/assets/images/geo-vs-seo-hero.png', '');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T3'));
});

test('T4: drifted number fails', () => {
  const bad = EN_MD.replace('12.5%', '13.5%');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T4'));
});

test('T5: CJK residue in en fails', () => {
  const bad = EN_MD.replace('GEO optimizes entity claiming', 'GEO 優化实体认领');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T5' && /CJK/.test(e.message)));
});

test('T5: Chinese punctuation in en fails', () => {
  const bad = EN_MD.replace('serve different engines.', 'serve different engines。');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T5' && /punctuation/.test(e.message)));
});

test('T5: simplified terms in zh-hant fail', () => {
  // HK-style body with a simplified-only term ("用户") smuggled into the FAQ answer
  const hk = `---
seo:
  meta_title: "GEO 與 SEO 的區別"
  meta_description: "生成式引擎優化（GEO）與 SEO 在機制、目標與資料來源上的五大區別，協助企業雙引擎獲客。"
  slug: geo-vs-seo
featured_image: "https://tengence.com/assets/images/geo-vs-seo-hero.png"
---

# GEO 與 SEO 的區別

## 一、定義與目標

GEO（生成式引擎優化）與 SEO 服務於不同引擎。

## 二、五大區別

1. 機制不同。
2. 資料來源不同。

## 關鍵要點

- 互補

## 常見問題

> **問：GEO 會取代 SEO 嗎？**
>
> 答：不會，兩者服務於不同引擎。用户 需要更佳方案。

## 資料來源

- [報告](https://example.com/geo-report-2026)

## 相關閱讀

- [詳解](/blog/dual-engine-strategy/)

## 立即行動

聯絡通智 GEO。
`;
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: hk, targetLang: 'zh-hant' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T5' && /simplified term/.test(e.message)));
});

test('zh-hant: faithful translation passes', () => {
  const hk = `---
seo:
  meta_title: "GEO 與 SEO 的區別"
  meta_description: "生成式引擎優化（GEO）與 SEO 在機制、目標與資料來源上的五大區別，協助企業雙引擎獲客。本指南並比較兩者的適用場景與落地步驟。"
  slug: geo-vs-seo
  og_image: "https://tengence.com/assets/images/geo-vs-seo-og.png"
featured_image: "https://tengence.com/assets/images/geo-vs-seo-hero.png"
---

# GEO 與 SEO 的區別

> **摘要**：GEO 與 SEO 是雙引擎獲客的兩條腿，機制互補、目標一致。

## 一、定義與目標

GEO（生成式引擎優化）與 SEO（搜尋引擎優化）服務於不同引擎。GEO 面向 AI 搜尋引擎，SEO 面向傳統搜尋。2026 年預計 12.5% 的流量來自 AI 回答。

## 二、五大區別

1. 機制不同：GEO 優化實體認領，SEO 優化關鍵字。
2. 資料來源不同：GEO 看重引用密度，SEO 看重外部連結。
- 排序機制不同：語義檢索的演算法與倒排索引的統計模型各有所長。

## 關鍵要點

- GEO 與 SEO 互補而非替代
- 雙引擎策略覆蓋兩類引擎

## 常見問題

> **問：GEO 會取代 SEO 嗎？**
>
> 答：不會，兩者服務於不同引擎。

## 資料來源

- [GEO 行業報告 2026](https://example.com/geo-report-2026)
- [SEO 官方指南](https://example.com/seo-guide)

## 相關閱讀

- [雙引擎策略詳解](/blog/dual-engine-strategy/)

## 立即行動

聯絡通智 GEO 獲取 AI 可見性評估。
`;
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: hk, targetLang: 'zh-hant' });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

test('T6: forbidden direct-translation term in en fails', () => {
  const bad = EN_MD.replace('GEO (Generative Engine Optimization) and SEO', 'GEO (Generated Engine Optimization) and SEO');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T6'));
});

test('T8: meta_description out of range fails', () => {
  const bad = EN_MD.replace('meta_description: "Generative Engine Optimization (GEO) and SEO differ in mechanism, goal, and data sources. Learn the five key differences for a dual-engine acquisition strategy."', 'meta_description: "Too short"');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T8'));
});

test('T7: truncated section fails', () => {
  const bad = EN_MD.replace(/## 2\. Five Key Differences[\s\S]*?(?=^## )/m, '## 2. Five Key Differences\n\nToo short.\n\n');
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T7'));
});

// ---- T9: mermaid label syntax (2026-10-06) --------------------------------

test('T9: bare parens in a target mermaid label fail', () => {
  const bad = EN_MD.replace('## Get Started', [
    '## Get Started', '', '```mermaid', 'graph TD', '    A[Node 1 (phone)] --> B', '```',
  ].join('\n'));
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T9' && /bare parens/.test(e.message)), JSON.stringify(r.errors));
});

test('T9: bare parens in a source mermaid diagram fail too', () => {
  const badSrc = SOURCE_MD.replace('## 立即行动', [
    '## 立即行动', '', '```mermaid', 'graph TD', '    subgraph sg1 [World (real)]', '        A', '    end', '```',
  ].join('\n'));
  const r = checkTranslation({ sourceMd: badSrc, targetMd: EN_MD, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T9' && /\(source\)/.test(e.message)), JSON.stringify(r.errors));
});

test('T9: quoted labels and prose parens pass', () => {
  const withFences = EN_MD.replace('## Get Started', [
    '## Get Started', '', '```mermaid',
    'graph TD', '    A["Node 1 (phone)"] -->|"linked (strong)"| B', '    subgraph "World (real)"', '        A', '    end', '```',
  ].join('\n'));
  const r = checkTranslation({ sourceMd: SOURCE_MD, targetMd: withFences, targetLang: 'en' });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
  assert.ok(!r.errors.some((e) => e.id === 'T9'));
});

// ---- 2026-10-06: T2 normalization / T10 internal-link prefix / T11 CTA layout ----

const LINKED_SRC = SOURCE_MD.replace(
  '- [双引擎策略详解](/blog/dual-engine-strategy/)',
  '- [双引擎策略详解](https://www.tengence.com/zh-hans/blog/article/dual-engine-strategy/)'
);

const LINKED_EN = EN_MD.replace(
  '- [Dual-engine strategy deep dive](/blog/dual-engine-strategy/)',
  '- [Dual-engine strategy deep dive](https://www.tengence.com/en/blog/article/dual-engine-strategy/)'
);

test('T2: language-prefixed internal links are the same target (normalized)', () => {
  // source links /zh-hans/..., target links /en/... — same article, must NOT be drift
  const r = checkTranslation({ sourceMd: LINKED_SRC, targetMd: LINKED_EN, targetLang: 'en' });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
  assert.ok(!r.errors.some((e) => e.id === 'T2'));
});

test('T2: normalized comparison still catches a genuinely dropped link', () => {
  const bad = LINKED_EN.replace('](https://www.tengence.com/en/blog/article/dual-engine-strategy/)', ']()');
  const r = checkTranslation({ sourceMd: LINKED_SRC, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T2' && /dual-engine-strategy/.test(e.message)));
});

test('T10: bare internal article link in en target fails', () => {
  const bad = EN_MD.replace(
    '- [Dual-engine strategy deep dive](/blog/dual-engine-strategy/)',
    '- [Dual-engine strategy deep dive](https://www.tengence.com/blog/article/dual-engine-strategy/)'
  );
  const r = checkTranslation({ sourceMd: LINKED_SRC, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T10' && /expected \/en\//.test(e.message)), JSON.stringify(r.errors));
});

test('T10: wrong-language prefix in en target fails', () => {
  const bad = EN_MD.replace(
    '- [Dual-engine strategy deep dive](/blog/dual-engine-strategy/)',
    '- [Dual-engine strategy deep dive](https://www.tengence.com/zh-hans/blog/article/dual-engine-strategy/)'
  );
  const r = checkTranslation({ sourceMd: LINKED_SRC, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T10' && /found \/zh-hans\//.test(e.message)), JSON.stringify(r.errors));
});

test('T10: zh-hant target accepts /zh-hant/ prefix, rejects /en/', () => {
  const good = EN_MD.replace(
    '- [Dual-engine strategy deep dive](/blog/dual-engine-strategy/)',
    '- [Dual-engine strategy deep dive](https://www.tengence.com/zh-hant/blog/article/dual-engine-strategy/)'
  );
  const r1 = checkTranslation({ sourceMd: LINKED_SRC, targetMd: good, targetLang: 'zh-hant' });
  assert.ok(r1.checks.T10 && r1.checks.T10.ok === true, JSON.stringify(r1.errors, null, 2));
  const bad = good.replace('https://www.tengence.com/zh-hant/', 'https://www.tengence.com/en/');
  const r2 = checkTranslation({ sourceMd: LINKED_SRC, targetMd: bad, targetLang: 'zh-hant' });
  assert.equal(r2.checks.T10.ok, false);
  assert.ok(r2.errors.some((e) => e.id === 'T10' && /expected \/zh-hant\//.test(e.message)), JSON.stringify(r2.errors));
});

// source CTA gains the same two links the T11 fixtures use, so T2 link fidelity stays green
const LINKED_CTA_SRC = SOURCE_MD.replace(
  '联系通智 GEO 获取 AI 可见性评估。',
  '- [免费试用](https://console.tengence.com/register)\n- [预约咨询](https://www.tengence.com/contact-us)'
);

test('T11: CTA links joined with | fail', () => {
  const bad = EN_MD.replace(
    'Contact Tengence GEO for an AI visibility assessment.',
    '[Free trial](https://console.tengence.com/register) | [Book a call](https://www.tengence.com/contact-us)'
  );
  const r = checkTranslation({ sourceMd: LINKED_CTA_SRC, targetMd: bad, targetLang: 'en' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.id === 'T11' && /\|/.test(e.message)), JSON.stringify(r.errors));
});

test('T11: CTA as a bulleted list passes', () => {
  const good = EN_MD.replace(
    'Contact Tengence GEO for an AI visibility assessment.',
    '- [Free trial](https://console.tengence.com/register)\n- [Book a call](https://www.tengence.com/contact-us)'
  );
  const r = checkTranslation({ sourceMd: LINKED_CTA_SRC, targetMd: good, targetLang: 'en' });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
  assert.ok(!r.errors.some((e) => e.id === 'T11'));
});

// ---- 2026-10-08: T4 magnitude / month-name normalization (idiomatic equivalents) ----

const NUM_SRC = `---
seo:
  meta_title: "数字一致性测试"
  meta_description: "测试翻译门禁对中文万、亿与年份月份的数字归一化是否准确，避免误报。"
featured_image: "https://tengence.com/assets/images/hero.png"
---

# 数字一致性测试

2026 年预计 8 亿用户，2300 万新增。

该版本于 2022 年 9 月发布，2020 年 5 月修订。
`;

const NUM_EN = `---
seo:
  meta_title: "Number Consistency Test"
  meta_description: "Generative engine optimization rewards evidence density over keywords; allow AI crawlers, publish llms.txt, cite data, and build off-site authority for it."
featured_image: "https://tengence.com/assets/images/hero.png"
---

# Number Consistency Test

In 2026 the platform reached 800 million users, with 23 million added.

The release shipped in September 2022 and was revised in May 2020.
`;

test('T4: Chinese 万/亿 match English million wording (no drift)', () => {
  const r = checkTranslation({ sourceMd: NUM_SRC, targetMd: NUM_EN, targetLang: 'en' });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
  assert.ok(!r.errors.some((e) => e.id === 'T4'));
});

test('T4: English month name + year matches Chinese month (no drift)', () => {
  const r = checkTranslation({ sourceMd: NUM_SRC, targetMd: NUM_EN, targetLang: 'en' });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
  assert.ok(!r.errors.some((e) => e.id === 'T4'));
});

// A bare "may" (verb, no adjacent year) must NOT be read as the number 5.
const MAY_SRC = `---
seo:
  meta_title: "May Safety Test"
  meta_description: "验证门禁不会把英文 may 动词误判为数字。"
featured_image: "https://tengence.com/assets/images/hero.png"
---

# May Safety Test

我们计划 12 个案例。
`;

const MAY_EN = `---
seo:
  meta_title: "May Safety Test"
  meta_description: "Generative engine optimization rewards evidence density over keywords; allow AI crawlers, publish llms.txt, cite data, and build off-site authority for it."
featured_image: "https://tengence.com/assets/images/hero.png"
---

# May Safety Test

You may want to review the 12 cases we planned.
`;

test('T4: bare "may" (verb) is not read as 5', () => {
  const r = checkTranslation({ sourceMd: MAY_SRC, targetMd: MAY_EN, targetLang: 'en' });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
  assert.ok(!r.errors.some((e) => e.id === 'T4' && /5/.test(e.message)));
});

// Chinese "千" (×1e3) must normalize like 万/亿, so "8 千美元" ↔ "$8,000"
// and "5 万美元" ↔ "$50,000" without false drift.
const QIAN_SRC = `---
seo:
  meta_title: "千量级测试"
  meta_description: "验证中文千字头数字能与英文等值写法归一化，避免把 8 千美元误报为数字漂移。"
featured_image: "https://tengence.com/assets/images/hero.png"
---

# 千量级测试

月营收 8 千美元时花了 5 万美元建分析基础设施。
`;

const QIAN_EN = `---
seo:
  meta_title: "Thousand Magnitude Test"
  meta_description: "Generative engine optimization rewards evidence density over keywords; allow AI crawlers, publish llms.txt, cite data, and build off-site authority for it."
featured_image: "https://tengence.com/assets/images/hero.png"
---

# Thousand Magnitude Test

It spent $50,000 building analytics infrastructure when monthly revenue was only $8,000.
`;

test('T4: Chinese 千 matches English thousand wording (no drift)', () => {
  const r = checkTranslation({ sourceMd: QIAN_SRC, targetMd: QIAN_EN, targetLang: 'en' });
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
  assert.ok(!r.errors.some((e) => e.id === 'T4'));
});
