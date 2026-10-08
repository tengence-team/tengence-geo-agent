# CLI 命令参考 —— 24 条命令

> 中文版。英文版见 [cli-commands.en.md](cli-commands.en.md)。
>
> 权威来源：`packages/geo-cli/bin/`。所有命令统一 `tengence-geo-` 前缀（bin 名），并沿用 `@tengence/geo-mcp` 的环境（`SITES_ROOT` / `TENGENCE_GEO_HOME` / `DB_DRIVER` …）。依赖站点的命令接受 `--site <key>`（默认 `tengence`）。
>
> 参数语法：`--flag`、`--key=value`、或 `--key value`。CLI 是 **规范化的编排入口**，MCP 工具正是委托它执行——下表每条命令都对应一个或多个 MCP 工具。

| # | 命令 | 作用 | 对应 MCP |
| --- | --- | --- | --- |
| 1 | `tengence-geo-article-ingest` | 把一篇源文章摄取进内容库 | `article_ingest` |
| 2 | `tengence-geo-article-export` | 导出为发布包（front matter + 正文） | `article_export` |
| 3 | `tengence-geo-article-save` | 保存/更新文章草稿 | `publish_update_fields` |
| 4 | `tengence-geo-check-article` | 运行 G1–G14 编辑门禁 | `check_article` |
| 5 | `tengence-geo-plan` | 选题规划与排期 | `plan_list` / `plan_import` / `plan_mark_status` |
| 6 | `tengence-geo-channel-plan` | 每平台发布日历 | `channel_plan_*` |
| 7 | `tengence-geo-channel-publish` | 发布到某个外部平台 | `channel_publish` |
| 8 | `tengence-geo-publish-draft` | 发布草稿（WordPress） | `publish_draft` |
| 9 | `tengence-geo-publish-from-db` | 从内容库按 slug/id 批量发布 | `publish_from_db` |
| 10 | `tengence-geo-publish-update-article` | 更新已发布文章 | `publish_update_article` |
| 11 | `tengence-geo-publish-wechat` | 发布到微信 | `channel_publish`(wechat) |
| 12 | `tengence-geo-publish-juejin` | 发布到掘金 | `channel_publish`(juejin) |
| 13 | `tengence-geo-publish-devto` | 发布到 Dev.to | `channel_publish`(devto) |
| 14 | `tengence-geo-promote-daily` | 每日定时提升（草稿 → 正式发布） | `publish_daily` |
| 15 | `tengence-geo-submit-gsc` | 提交到 Google Search Console | `search_submit_gsc` / `search_gsc_*` |
| 16 | `tengence-geo-submit-bing` | 提交到 Bing Webmaster | `webmaster_bing_submit` |
| 17 | `tengence-geo-bing-webmaster` | Bing Webmaster API 查询 | `webmaster_bing_status` |
| 18 | `tengence-geo-submit-indexnow` | IndexNow 即时收录 | `search_submit_indexnow` |
| 19 | `tengence-geo-submit-baidu` | 提交到百度 | `search_submit_baidu` |
| 20 | `tengence-geo-geo-monitor` | 运行 AI 可见性监测 | `monitor_run` |
| 21 | `tengence-geo-geo-monitor-report` | 生成监测报告 | `monitor_report` |
| 22 | `tengence-geo-image-acquire` | 图片采集流水线 | `image_acquire` |
| 23 | `tengence-geo-taxonomy` | 分类/标签管理 | `article_terms_sync` / `term_*` |
| 24 | `tengence-geo-db-init` / `tengence-geo-db-query` | 数据库初始化与查询 | `db_init` / `db_status` / `db-query` |

## 命令明细

### 1. `tengence-geo-article-ingest`
把一篇源文章摄取进内容库。
```
tengence-geo-article-ingest.js <slug> [<md-path>] [--lang zh-hans] [--research <path>] [--no-archive]
```
| 选项 | 说明 |
| --- | --- |
| `<slug>` | 文章 slug |
| `<md-path>` | 正文 Markdown 路径（从 stdin 读时可省略） |
| `--lang` | 语言（默认 `zh-hans`） |
| `--research <path>` | research brief 路径 |
| `--no-archive` | 摄取后不归档源文件 |

### 2. `tengence-geo-article-export`
把文章 + brief 导出到 `data/inbox`（用于改写/翻译）。
```
tengence-geo-article-export.js <slug> [--lang zh-hans] [--out <dir>]
```

### 3. `tengence-geo-article-save`
保存/更新文章草稿。
```
tengence-geo-article-save.js <article_id> <file_path> [--title] [--site <key>]
```

### 4. `tengence-geo-check-article`
运行编辑门禁。
```
tengence-geo-check-article.js <slug> [<dir=industry-insights>] [--type=T1..T7]
```

### 5. `tengence-geo-plan`
选题规划与排期。选项：`--batch`、`--category`、`--cluster`、`--dry-run`、`--limit`、`--matrix`、`--node`、`--queue`、`--set`、`--status`。

### 6. `tengence-geo-channel-plan`
每平台发布日历。子命令：
```
channel-plan.js mark <id> <todo|draft|published|paused>
channel-plan.js import-wechat <issues.json>
```
其它选项：`--platform`、`--status`、`--published`、`--all`、`--kind`、`--name`、`--prefix`、`--limit`、`--category`、`--tags`、`--keywords`、`--dry-run`。

### 7. `tengence-geo-channel-publish`
发布/导出到某个外部平台。
```
channel-publish.js --platform=<key> --slugs=a,b,c [--publish] [--dry-run] [--keep-order] [--from-md <path>]
```

### 8. `tengence-geo-publish-draft`
一键把本地草稿发布到 WordPress。
```
tengence-geo publish-draft.js <draft-path> [options]
  --meta=<path>       geo meta JSON 路径（默认 <draft>.meta.json）
  --status=draft|publish  发布状态（默认 draft）
  --no-move           发布后不移动文件
  --auto-image        发布前自动 检索→过滤→下载→WebP→上传 为头图
  --site <key>        站点 key（默认 tengence）
```

### 9. `tengence-geo-publish-from-db`
从内容库按 slug/id 批量发布。
```
tengence-geo publish-from-db.js <article_id> [options]
  --status=draft|publish        （默认 draft）
  --force                       强制更新已有
  --dry-run
  --batch <ids>                 多个 id
  --all                         全部 queued
  --featured-media <id>         强制指定媒体 id（跳过 URL 下载/上传）
  --translation-group <uuid>
  --no-sync-dates               不继承 zh-hans 源时间
  --skip-gsc / --skip-indexnow / --skip-baidu   发布后跳过收录提交
  --site <key>
```

### 10. `tengence-geo-publish-update-article`
更新已发布文章。
```
tengence-geo publish-update-article.js <markdown_file> [options]
  --slug <s> / --post-id <id>    目标
  --status=publish
  --meta-only                   只更新 meta 字段
  --meta-title <t> / --meta-desc <d> / --post-title <t>
  --no-upload
  --dry-run
  --lang <lang>（默认 zh-hans）
  --site <key>
```

### 11. `tengence-geo-publish-wechat`
发布到微信。
```
node publish-wechat.js <slug> [--publish] [--dry-run]
```
（`--publish` 推送粉丝——高风险操作；默认只建草稿。）

### 12. `tengence-geo-publish-juejin`
发布到掘金。
```
node publish-juejin.js <markdown_file> [--title "标题"] [--draft] [--publish]
```

### 13. `tengence-geo-publish-devto`
发布到 Dev.to。
```
tengence-geo publish-devto.js <md-file-path> [--dry-run]
```

### 14. `tengence-geo-promote-daily`
每日定时提升——把 queued 草稿转为已发布文章。
```
tengence-geo promote-daily.js [--site <key>] [--date <YYYY-MM-DDTHH:MM:SS>] [--slug <s>] [--count <n>] [--dry-run]
```
- 队列模式（默认）：按 `publish_order` 提升接下来 `count` 个 queued 行（遵循 `wordpress.yaml` 的 `per_day`/`skip_dates`）。
- `--slug` 模式：把该 slug 的每种语言版本都发布。
- `--date`：设置被提升文章的发布/修改时间（站点时区）——即定时正式发布。

### 15. `tengence-geo-submit-gsc`
提交到 Google Search Console。
```
tengence-geo submit-gsc.js [options]
  --site <key>  --dry-run  --sitemap  --status  --all  --limit  --indexing <url>  --url <url>
```

### 16. `tengence-geo-submit-bing`
提交到 Bing Webmaster。选项：`--site`、`--dry-run`、`--all`、`--limit`、`--submit <url>`。

### 17. `tengence-geo-bing-webmaster`
Bing Webmaster API 查询。选项：`--site`、`--dry-run`、`--sites`、`--status`、`--stats`、`--issues`、`--all`、`--resubmit`、`--limit`、`--submit <url>`。

### 18. `tengence-geo-submit-indexnow`
IndexNow 即时收录。
```
tengence-geo submit-indexnow.js [options]
  --site <key>  --dry-run  --all  --limit（默认 1000）  --url <url>
```

### 19. `tengence-geo-submit-baidu`
提交到百度普通收录。
```
tengence-geo submit-baidu.js [options]
  --site <key>  --dry-run  --all  --resubmit  --limit  --url <url>
```
`--all` 增量推送 sitemap（最多 `limit` 条，默认 10，遵守日配额）。

### 20. `tengence-geo-geo-monitor`
运行 GEO 监测。
```
tengence-geo geo-monitor.js run --run-id=20260921 [--site <key>] [--dry-run] [--mock] [--models <m>] [--layer <l>]
```

### 21. `tengence-geo-geo-monitor-report`
生成监测报告。选项：`--mock`、`--models <m>`。

### 22. `tengence-geo-image-acquire`
图片采集流水线（检索 → 红线 → 下载 → WebP 裁剪 → 上传）。
```
tengence-geo image-acquire.js [options]
  --query <kw>  --slug <slug>  --keywords <k>  --count <n>  --format <fmt>
  --out-json <path>  --dry-run  --site <key>
```

### 23. `tengence-geo-taxonomy`
分类/标签管理。
```
tengence-geo taxonomy.js <db-register|wp-cleanup|verify> [--slugs=a,b,c] [--site <key>]
```

### 24. `tengence-geo-db-init` / `tengence-geo-db-query`
数据库初始化与查询。
```
tengence-geo db-init.js [--drop] [--site <key>]
tengence-geo db-query.js [--list] [--slug=xxx] [--category=xxx] [--status=xxx]
                 [--lang <l>] [--limit <n>] [--categories] [--tags] [--plan] [--site <key>]
```

## 说明

- 多数命令需要 `tengence-geo-db-init`（或首次使用自动初始化），并在 `SITES_ROOT` 下有站点目录。
- `publish-wechat --publish`、外部正式发布、删除等为**高风险**操作——先核实目标，确认后再执行。
