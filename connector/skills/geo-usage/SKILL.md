---
name: geo-usage
description: 使用 Tengence GEO Agent MCP 完成 GEO/SEO 内容生产流水线：选题规划 → 撰写 → 门禁校验 → 发布 → 搜索提交 → AI 可见性监测。当用户要求写 GEO 文章、做 SEO 内容、发布到微信/CSDN/掘金、或监测 AI 搜索可见性时使用。
---

# Tengence GEO Agent — 工具用法

本连接器提供 **56 个 MCP 工具**，覆盖 GEO 内容生产全流水线。
**具体的工作流程、规则与最佳实践不在这里** —— 详见 `harness/`（随 Buddy 应用 / 各平台智能体配置分发，不在本连接器包内）：

| 你要做的事 | 去这里 |
|---|---|
| 角色、流程、约束（System Prompt） | `harness/work-modes/`（选题规划 / 撰写门禁 / 发布投稿 / 监测优化） |
| 可复用的分步任务指令 | `harness/skills/`（geo-article-writing / geo-search-submit / geo-visibility-monitor） |
| 专家人设与高风险确认规则 | `harness/expert/geo-expert.md` |

> 若你只装了本连接器、没有 `harness/`，按下方「三条不可违反的约定」+
> `standards_read()` 取回的规则执行即可，规则本身由 MCP 服务随包提供。

## 核心工具分组

- **工作区与站点**：`workspace_use`、`site_init`、`site_list`、`site_status`
- **选题**：`plan_list`、`plan_import`、`plan_mark_status`、`channel_plan_next`、`channel_plan_mark`
- **撰写与门禁**：`article_draft`、`article_ingest`、`check_article`、`standards_list`、`standards_read`
- **发布**：`publish_draft`、`publish_from_db`、`channel_publish`、`wechat_draft_publish`、`wechat_mass_send`
- **搜索提交**：`search_submit_gsc`、`search_submit_baidu`、`search_submit_indexnow`、`webmaster_bing_submit`
- **监测**：`monitor_run`、`monitor_report`、`search_gsc_stats`、`diagnose_site`

## 三条不可违反的约定

1. **先读标准再动手**：`standards_read('<文件名>')` 取回规则，不凭记忆复述。
   `standards_list` 可列出全部标准文档。
2. **门禁不可跳过**：`article_ingest` 后必须 `check_article`（G1–G14），
   未全绿一律不得发布。
3. **不可逆动作须确认**：`wechat_mass_send`、`channel_publish`、
   `wechat_article_delete` / `csdn_article_delete` / `juejin_article_delete`
   执行前必须向用户复述渠道、标题、摘要并取得明确确认。

> 数据默认落在 `~/.tengence/geo-mcp`（`TENGENCE_GEO_HOME`，SQLite），可跨会话追溯。
