---
name: geo-article-writing
description: 按 GEO 标准撰写文章并通过编辑门禁。当用户要求写一篇 GEO/SEO 文章、按 T1–T7 体裁产出正文、或需要让稿件通过 check_article 校验时使用。
---

# GEO 文章撰写与门禁

## 用途

把选题变成**一份通过全部编辑门禁的 Markdown 正文**。适用于 definition / howto /
product / case / industry / comparison / guide 七类体裁。

## 前置条件

- 已绑定工作区与站点（`workspace_use` → `site_list`）。
- 已确定体裁（T1–T7）。若未确定，先走 `topic-planning` 工作模式。

## 流程

1. `article_draft { type, topic }` —— 取回该体裁的骨架、research-brief 模板与写作标准。
2. `standards_read('article-writing-standards')` —— 读交付形态、引用规则、G1–G14 全表。
3. `standards_read('block-conventions')` —— 核对区块标题的中英精确写法。
4. 按 research-brief 模板完成研究简报（联网检索，落盘）。**缺此文件门禁直接失败。**
5. 按骨架写正文：每个 H2 开头先给 40–60 字自足结论。
6. `article_ingest` 提交正文与简报。
7. `check_article` —— **不可跳过**。
8. 失败则回到第 5 步修改，直至全绿。
9. `image_acquire` 配图（可选，需承载真实内容、不含第三方 logo）。

## 关键参数

| 参数 | 说明 |
|---|---|
| `type` | T1–T7 体裁，决定骨架与字数区间 |
| `topic` | 目标选题/关键词 |
| 字数区间 | 由站点补充文件定义，不在通用标准里 |

## 硬性要求（摘要，完整版以标准文档为准）

- **引用双通道**：文内可核验来源 + 数据来源区块，缺一不可。
- **无裸 URL**：引用一律做成文本超链接。
- **内链 ≥2** 指向中枢页，无死链。
- **不臆造**：无真实数据不写案例；案例须脱敏。
- **区块标题精确**：引擎按固定词解析，中英写法以 `block-conventions` 为准。
- **地理表述**：全球化优先，单一市场数据标注国别。

## 示例

```
用户：写一篇关于 GEO 与 SEO 区别的文章
→ article_draft { type: "comparison", topic: "GEO 与 SEO 的区别" }
→ 取回 T6 骨架 + 标准
→ 完成 research brief
→ 写正文（每个 H2 回答优先）
→ article_ingest → check_article
→ 若 G6（引用）失败：补齐来源与日期，重跑
→ 全绿后交付：路径 + 字数 + 门禁最后三行 + 引用清单
```

## 错误处理

| 现象 | 处理 |
|---|---|
| `check_article` 反复不过 | `standards_read('article-writing-standards')` 逐条对照 G1–G14 |
| research-brief 硬校验失败 | 确认简报文件已落盘到站点目录；缺失则补做 |
| 区块未被解析 | 对照 `block-conventions` 校正标题词（中英均可，但用词须精确） |
| `site_list` 为空 | 工作区绑定错误；`workspace_use` 重新绑定（不要设 `SITES_ROOT`） |

## 高风险确认规则

- 覆盖已存在的正文文件：先复述路径与影响并确认。
- 用户要求"跳过门禁先发布"：**拒绝**，并列出未通过项。

## 边界

不发布、不提交收录。门禁全绿后交 `publishing` 工作模式。
