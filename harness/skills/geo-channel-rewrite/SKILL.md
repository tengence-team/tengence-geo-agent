---
name: geo-channel-rewrite
description: 渠道分发标准链路——取下一期、读原文、按渠道规则改写（由 agent/harness 执行）、硬校验、推送草稿、回写发布日历。适用于所有分发渠道（wechat / juejin / csdn / aliyun / tencent / baijiahao 等），platform 是参数。触发词：发公众号、发掘金、发 CSDN、发阿里云、渠道分发、下一期发布。
---

# 渠道改写发布

## 用途

把发布日历中下一期的文章，按**渠道特定规则**改写后推送到对应渠道（草稿或发布，
取决于渠道的发布边界），并回写日历。

## 核心分工（不可协商）

1. **改写由 agent/harness 执行**。MCP server 只负责：供原文（`article_export`）、
   供规则（`channel_style_get`）、硬校验（`channel_check`）、推送（`channel_publish`）。
   server 从不改写内容。
2. **规则运行时获取，禁止硬编码**。所有渠道差异（标题 hooks、违禁词、removeBlocks、
   **链接策略**、CTA、审核红线）都来自 `channel_style_get(platform)` 返回的 yaml 规格，
   不在提示词里复制任何规则文本。
3. **`channel_check` 是发布前硬门禁**：errors 不清零，严禁调用 `channel_publish`。

## 前置条件

- MCP 服务在线（`util_ping`；不可用则拉起后重试 1 次）。
- 发布日历（channel plan）中该渠道存在待发布期次。
- 渠道凭据已配置（由站点配置提供）。

## 流程（八步）

1. **取下一期**：`channel_plan_next(platform)` → `next`
   （id / period / topic / article_slugs，第 1 篇为头条）。
   `next` 为 null 或 status 已是 `published`/`draft` → 汇报"无待发布期次"并结束。
2. **读原文**：对每个 slug 调 `article_export(slug, site)`，原文 md 落到
   `<site>/data/inbox/`，读取正文与研究简报。
3. **取渠道规则**：`channel_style_get(platform)` → rewrite 规格：
   strategy、标题 hooks / forbidden、structure、removeBlocks / keepBlocks、
   **链接策略**（哪些渠道删内链/删外链）、CTA、发布边界（asDraft / 审核门禁）。
4. **改写（每篇独立）**：严格按第 3 步返回的规格执行——标题按 hooks 模板生成并规避
   forbidden；正文按 structure 重组；删除 removeBlocks 命中的块；保留 keepBlocks；
   链接按渠道策略处理；口语化/短段落/字数下限按 yaml。
   **事实红线**：只允许重组与换表达，不允许编造数据、案例、结论。
   **格式红线（2026-09-29 事故教训）**：改写稿必须是**结构完整的 markdown**——
   保留原文的标题层级（`##`/`###`）、表格、有序/无序列表、
   **加粗**；严禁把标题/列表/表格压平成纯文本段落（压平后 md→HTML 转换即丢失格式）。
   md→HTML 转换一律由 MCP server 完成，agent 只交 markdown：禁止自己产 HTML。
   **emoji 红线（2026-09-29 新增）**：渠道规则含 `noEmoji: true` 时，标题与正文
   **禁用一切 emoji/表情符号**（含标题内的装饰 emoji、⚠️/✅ 类符号、1️⃣ 类键帽数字），
   分隔与强调用编号、小标题和**加粗**实现；`channel_check` 会对命中项报 error。
5. **硬校验**：`channel_check(platform, title, body)`。
   errors 非空 → 按错误修正重跑，最多 2 轮；仍不过 → 该篇标失败上报，不得发布。
6. **推送**：`channel_publish(platform, site, articles=[{slug,title,contentMd,
   rewrite:'harness',mode:'harness'}], asDraft/keepOrder 按渠道规格)`。
   articles 顺序 = 头条顺序；一次 ≤8 篇。
   返回 `media_id`/发布结果；`action=skip-empty`（全部已发布被去重）→ 跳第 7 步
   把该期标 `published`。
7. **回写日历**：`channel_plan_mark(id, status=draft|published, draftIds=[...])`。
8. **核对**：按渠道调用状态工具（如 `wechat_status`）确认草稿/发布结果与顺序一致。

## 发布边界（渠道差异，以 yaml 为准）

不同渠道的"推送到哪一步"不同，**不把 wechat 的边界套到其它渠道**：

| 渠道类型 | 边界示例 |
|---|---|
| 公众号 wechat | 只到草稿箱；严禁 `wechat_mass_send` / `wechat_draft_publish`，群发人工完成 |
| 有审核门禁的渠道（如 aliyun `publishGated`） | 推送后进入平台审核，按 `publish_update_article` 处理审核反馈 |
| 直接发布渠道 | `asDraft=false` 直接发布，发布后跑收录提交（`geo-search-submit`） |

## 落盘审计（推荐）

改写稿保存到 `<site>/data/channel-export/<platform>-rewrite/<日期>-<slug>.md`
（首行 `# 标题`，正文为 contentMd），供人工抽查、复用与追溯。

## 错误处理

| 现象 | 处理 |
|---|---|
| 缺封面 | 原样上报失败 slug，不得改数据 |
| check 反复不过 | 该篇标失败上报，不阻塞同批其它篇目 |
| skip-empty | 全部文章此前已发布，日历标 published，不重复推送 |
| 草稿重复 | 提示用户在渠道后台手动删除旧稿（MCP 无删稿接口） |
| 任何一步失败 | 最多重试 1 次，仍失败上报工具原始输出，不得绕过 MCP 直改数据 |

## 边界

- 不修改文章原文、站点配置、数据库记录（改写只进草稿/发布与导出文件）。
- 不做跨平台内容搬运决策（选哪篇文章进哪期）——那是发布日历（channel plan）的职责。
- 收录提交、可见性监控分别走 `geo-search-submit` / `geo-visibility-monitor`。
