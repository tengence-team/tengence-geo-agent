---
name: geo-usage
description: 使用 Tengence GEO Agent MCP 完成 GEO/SEO 内容生产流水线：选题规划 → 撰写 → 门禁校验 → 发布 → 搜索提交 → AI 可见性监测。当用户要求写 GEO 文章、做 SEO 内容、发布到微信/CSDN/掘金、或监测 AI 搜索可见性时使用。
---

# GEO 内容生产流水线（Tengence GEO Agent）

## 适用工具集
本连接器提供 56 个工具，覆盖整条流水线。核心分组：

- **工作区与站点**：`workspace_use`、`site_init`、`site_list`、`site_status`
- **规划与选题**：`channel_plan_next`、`plan_list`、`plan_import`、`plan_mark_status`
- **撰写与抓取**：`article_draft`、`article_ingest`、`article_list`、`image_acquire`
- **质量门禁**：`check_article`、`standards_list`、`standards_read`
- **发布**：`publish_draft`、`publish_from_db`、`channel_publish`、微信 `wechat_draft_publish` / `wechat_mass_send`
- **搜索提交**：`search_submit_gsc`、`search_submit_baidu`、`search_submit_indexnow`
- **监测**：`monitor_run`、`monitor_report`、`search_gsc_stats`

## 标准流程（严格按顺序）

1. **选定工作区与站点**
   先 `workspace_use` 绑定工作区，再 `site_list` 确认目标站点；站点不存在则 `site_init`。

2. **选题**
   `channel_plan_next` 取下一个待写选题，或 `plan_list` 浏览全部。

3. **撰写（必须走 skeleton + brief）**
   `article_draft { type, topic }` 会返回该文章类型的 **T1–T7 骨架**、**research-brief 模板**和完整写作标准（G1–G14）。
   **不要凭空写**——按返回的骨架与标准写 Markdown 正文。

4. **质量门禁（不可跳过）**
   `article_ingest` 提交正文与研究简报后，必须 `check_article`。
   它强制校验：引用双通道、按类型的字数、禁用词、四个必选区块（Key Takeaways / FAQ / Data Sources / Related Reading 等）、research-brief 硬校验。
   **校验不通过就回到第 3 步修改，不得发布。**

5. **发布**
   `publish_draft` 发布草稿；确认无误后再走 `channel_publish` 发到各渠道。
   ⚠️ 微信 `wechat_mass_send` / `channel_publish` 是**对外真实发布动作**，执行前必须向用户复述渠道、标题、正文摘要并**取得明确确认**。

6. **提交与监测**
   发布后 `search_submit_indexnow` / `search_submit_gsc` / `search_submit_baidu` 提交收录；
   定期 `monitor_run` + `monitor_report` 输出 AI 可见性报告。

## 关键约定

- **GEO 区块标题必须精确**：引擎按固定词解析。中英文对照见下，写法以 `standards_read('block-conventions')` 为准。
  - 摘要 `> **摘要**：` / `> **Summary**:`
  - `## 关键要点` / `## Key Takeaways`
  - `## 常见问题` / `## FAQ`
  - `## 数据来源` / `## Data Sources`
  - `## 相关阅读` / `## Related Reading`
- **高风险操作需二次确认**：群发、投稿、删除已发布文章（`wechat_article_delete` / `csdn_article_delete` / `juejin_article_delete`）属不可逆动作，必须先征得用户确认。
- **引用双通道**：正文中的事实性陈述必须同时具备可核验来源与文内标注，否则门禁不通过。
- **数据落盘**：默认使用 `~/.tengence/geo-mcp`（`TENGENCE_GEO_HOME`），SQLite（`DB_DRIVER`）。发布记录与监测数据持久化，可跨会话追溯。

## 排错速查

| 现象 | 排查 |
|---|---|
| `site_list` 返回空 | 工作区绑定错了。不要设 `SITES_ROOT`，让 SDK 回退 `state.json` 里的工作区；或用 `workspace_use` 重新绑定 |
| `check_article` 反复不过 | 用 `standards_read('article-writing-standards')` 逐条对照 G1–G14 |
| 工具报 "Server not initialized" | 客户端未正确处理 MCP 会话握手，重连即可，非服务端故障 |
