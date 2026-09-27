# @tengence/geo-cli

`@tengence/geo-sdk` 的命令行入口层。提供内容摄取、质检门禁、发布、收录提交、AI 监测、图片采集、选题规划等全部单条命令，命令名统一前缀 `tengence-geo-*`。

## 安装
```bash
npm i -g @tengence/geo-cli
# 或随 SDK 一起使用，无需单独安装：
npx -y @tengence/geo-cli <command>
```

## 可用命令

| 命令 | 作用 |
| --- | --- |
| `tengence-geo-article-ingest` | 摄取一篇源文章到内容库 |
| `tengence-geo-article-save` | 保存/更新文章草稿 |
| `tengence-geo-article-export` | 导出为发布包（front matter + 正文） |
| `tengence-geo-check-article` | 运行 G1–G14 质检门禁 |
| `tengence-geo-plan` | 选题规划与排期 |
| `tengence-geo-publish-draft` | 发布草稿（WordPress freepublish） |
| `tengence-geo-publish-from-db` | 从内容库按 slug 批量发布 |
| `tengence-geo-publish-update-article` | 更新已发布文章 |
| `tengence-geo-publish-wechat` | 发布到微信 |
| `tengence-geo-publish-juejin` | 发布到掘金 |
| `tengence-geo-publish-devto` | 发布到 Dev.to |
| `tengence-geo-promote-daily` | 每日分发编排 |
| `tengence-geo-submit-gsc` | 提交 URL 到 Google Search Console |
| `tengence-geo-submit-bing` | 提交到 Bing Webmaster |
| `tengence-geo-submit-indexnow` | IndexNow 即时收录 |
| `tengence-geo-submit-baidu` | 提交到百度 |
| `tengence-geo-bing-webmaster` | Bing Webmaster API 查询 |
| `tengence-geo-geo-monitor` | 运行 AI 可见性监测 |
| `tengence-geo-geo-monitor-report` | 生成监测报告 |
| `tengence-geo-image-acquire` | 图片采集五步流水线 |
| `tengence-geo-taxonomy` | 分类/标签管理 |
| `tengence-geo-db-init` | 初始化数据库 |
| `tengence-geo-db-query` | 直接查询数据库 |

> 大多数命令需要先 `tengence-geo-db-init` 或在站点目录下运行。环境变量与 `@tengence/geo-mcp` 一致（`SITES_ROOT` / `TENGENCE_GEO_HOME` / `DB_DRIVER` 等）。

## 许可

MIT © Tengence Team
