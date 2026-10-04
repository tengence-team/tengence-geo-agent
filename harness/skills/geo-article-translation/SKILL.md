---
name: geo-article-translation
description: 多语言翻译标准链路——把已过门禁的中文文章经 AI 翻译为英文（en-us）或繁体（zh-hk，香港风格），经机械门禁后入库发布。翻译与 AI 审校由 agent/harness 执行（LLM 调用发生在 agent 侧），geo-mcp 只提供原文、规则与术语表、机械门禁（check_translation）、入库与发布。触发词：翻译文章、生成英文版、生成繁体版、多语言、i18n、translate article。
---

# 文章多语言翻译与发布

## 用途

把站点中**已通过 check_article 门禁**的中文文章（lang=zh-cn）翻译为
`en-us` / `zh-hk` 独立文章（同 slug、同 translation_group），机械门禁全绿后
入库并发布为 WordPress 独立文章。目标语言规范与术语表见
`standards_read('translation-standards')` 与站点级
`config/translation-glossary.yaml`。

## 核心分工（不可协商）

1. **翻译与 AI 审校由 agent/harness 执行**。MCP server 不调用任何 LLM：
   只负责供原文（`article_export --lang`）、供规则与术语表
   （`standards_read('translation-standards')` + `translation_glossary_get`）、
   机械门禁（`check_translation`）、入库（`article_ingest --lang`）、发布
   （`publish_from_db`）。server 从不翻译内容。
2. **规则运行时获取，禁止硬编码**。所有语言规范、术语表、门禁规则都来自
   standards 文件与 glossary，不在提示词里复制规则文本。
3. **`check_translation` 是入库前硬门禁**：errors 不清零，严禁调用
   `article_ingest` / `publish_from_db`。

## 前置条件

- 中文原文已入库且**通过 check_article**（未过门禁的稿不翻译）。
- MCP 服务在线（`util_ping`；不可用则拉起后重试 1 次）。
- 目标语言属于站点 `site.yaml languages.available`（en-us / zh-hk）。

## 流程

1. **取原文**：`article_export { slug, lang: 'zh-cn', site }` → 中文 md 落
   `<site>/data/inbox/zh-cn/<slug>.md`，读取正文与研究简报。
2. **取规则与术语表**：`standards_read('translation-standards')` +
   `translation_glossary_get { site, target_lang }`（合并全局与站点级，
   返回目标语言术语 + 禁用词）。繁体用香港风格（軟件/資訊/網絡/優化…）。
3. **翻译（agent 执行）**：按标准的三条红线执行——
   - 事实红线：数字、年份、百分比、版本号、引用 URL、图片 URL、
     `featured_image` **一律不变**；不增删案例与结论。
   - 结构红线：H1/H2、表格、列表、加粗、引用块、GEO 区块完整保留；
     区块标题用目标语言规范写法（`## Key Takeaways` / `## 關鍵要點`…）；
     H2 编号连续（英文阿拉伯数字、中文数字）。
   - 表达红线：英文 en-us 母语表达、无翻译腔；繁体香港风格、无简体词、
     **严禁 OpenCC 式纯字形转换**。
   - 标题红线：H1/H2 与 meta_title/meta_description 按目标语言 SEO 习惯
     本地化再创作（保留核心关键词与结论；英文 meta_description 150–160 字符）。
4. **AI 审校（agent 执行）**：自审通顺性（native/无翻译腔）、合理性
   （结论/逻辑/数字与原文一致）、术语一致性（命中术语表）；不合格先自行
   修订（≤2 轮）再提交。
5. **机械门禁**：`check_translation { site, slug, source_lang: 'zh-cn',
   target_lang, md_path }` → T1–T8 明细。errors 非空 → 按错误修正重跑，
   最多 2 轮；仍不过 → 该篇标失败上报，不得入库。
6. **入库**：`article_ingest { slug, md_path, lang: target_lang, site,
   research: <原文简报路径或目标语言简报> }`。入库后该 (slug, lang) 行与
   中文行同 `translation_group`。
7. **发布**：`publish_from_db { article_id, site, status, force }`。
   发布链路自动写语言 taxonomy、翻译组、目标语言 SEO/GEO meta，并复用
   同一张特色图片（featured_image 与正文图片 URL 与中文一致）。
8. **收录**：发布成功后自动提交——GSC 全站 sitemap、IndexNow（三语 URL）、
   Baidu 仅简体（zh-cn）。核对发布 URL 与 hreflang。

## 落盘审计（推荐）

翻译稿与审校记录保存到 `<site>/data/inbox/<lang>/<slug>.md`
（article_export / article_ingest 的默认目录），供人工抽查与追溯。

## 错误处理

| 现象 | 处理 |
|---|---|
| `check_translation` 反复不过 | 对照 `translation-standards` T1–T8 逐条修正，最多 2 轮；仍不过标失败上报 |
| 术语表缺失 | 确认 `standards_read` 返回 translation-standards、站点 glossary 存在 |
| 目标语言不在 site.yaml | 先更新 `languages.available` 再执行 |
| 原文未过门禁 | 先走 `geo-article-writing` 使中文稿全绿，再翻译 |
| 任一工具失败 | 最多重试 1 次，仍失败上报工具原始输出，不得绕过 MCP 直改数据 |

## 边界

- 不修改中文原文；不覆盖已发布的译文（源文更新后由命令/人工触发重译）。
- 渠道分发（微信/CSDN/掘金）保持 zh-cn；**dev.to 允许英文**（走
  `geo-channel-rewrite` 的 devto 渠道，目标语言 en-us）。
- 术语/分类/标签翻译不在本 skill 范围（插件 v1.1）。
