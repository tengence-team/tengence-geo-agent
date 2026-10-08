# 数据模型参考

> 中文版。英文版见 [data-model.en.md](data-model.en.md)。
>
> 权威来源：`packages/geo-sdk/db/sqlite-schema.js`（与 `db/schema.js` / MySQL 字段同构）。表前缀：`tengence_geo_`。

## 概览

共 18 张表：**16 张业务表**（与 MySQL 生产 schema 共享，命名空间 `tengence_geo_*`）+ **2 张工作区本地表**（仅 SQLite），分别存每平台发布日历与外部平台分类法词典。

关键设计：

- **多租户**：每张表都带 `app_id`；业务唯一键都含 `app_id`（单文件多租户隔离基础）。
- **`(app_id, slug, lang)` 是 `articles` 与 `article_plan` 的唯一键**——每种语言一行。
- SQLite 使用本地时间（`strftime ... 'localtime'`），与 MySQL `NOW()` 语义一致；ENUM 变为 TEXT，语义校验在应用层。
- Schema 版本记录在 `PRAGMA user_version`（当前 `SCHEMA_VERSION = 5`）。

## 业务表（16）

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `tengence_geo_articles` | 内容库，每 slug+lang 一行 | id、app_id、slug、title、content_path、content_longtext、content_html、research_md、excerpt、featured_image、target_keywords、lang、translation_group、region_market、status（draft…）、author、wp_post_id、published_at、created_at、updated_at |
| `tengence_geo_categories` | 分类 | id、app_id、name、slug |
| `tengence_geo_tags` | 标签 | id、app_id、name、slug |
| `tengence_geo_article_categories` | 文章 ↔ 分类关联 | article_id、category_id、app_id |
| `tengence_geo_article_tags` | 文章 ↔ 标签关联 | article_id、tag_id、app_id |
| `tengence_geo_seo` | 每篇文章的 SEO meta | article_id、title、meta_title、meta_description、keywords、canonical_url、og_*、noindex… |
| `tengence_geo_geo` | 每篇文章的 GEO meta | article_id、ai_summary、key_takeaways、qa（关联）、citations（关联）、schema_data、entity… |
| `tengence_geo_qa_pairs` | FAQ 问答行 | article_id、question、answer |
| `tengence_geo_citations` | 引用行（双通道证据） | article_id、title、url、channel… |
| `tengence_geo_social` | 社交/OG meta | article_id、og_* |
| `tengence_geo_vectors` | 内容向量 | article_id、embedding… |
| `tengence_geo_images` | 媒体库镜像 | id、app_id、url、file、format、width、height、alt、wp_media_id… |
| `tengence_geo_article_images` | 文章 ↔ 图片关联 | article_id、image_id、is_featured… |
| `tengence_geo_geo_monitor_answers` | 监测原始回答（提示词 × 模型 × 层级） | run_id、model、layer、prompt、answer… |
| `tengence_geo_geo_monitor_results` | 监测聚合结果（收录基线 + 可见性） | run_id、model、layer、score… |
| `tengence_geo_article_plan` | 发布计划/队列（`todo → written → queued → published`） | id、app_id、slug、node_type（spoke|hub）、hub_cluster、matrix_code、title、focus_keyword、keyword_volume、keyword_competition、search_intent、content_type、target_word_count、publish_batch、publish_order、category、tags、lang、article_id、wp_post_id、published_url、plan_status、queued_at、published_at |

## 工作区本地表（2，仅 SQLite）

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `tengence_geo_channel_plan` | 每平台发布日历（wechat/juejin/csdn…）——**工作区本地**，不在 MySQL | id、app_id、platform、period、topic、weekday、article_slugs、status（todo|draft|published|paused）、draft_ids、article_id、notes、schedule_at。唯一 `(app_id, platform, period)` |
| `tengence_geo_channel_taxonomy` | **外部**平台自身分类法词典（category/tag id+name），平台级共享给所有站点 | id、app_id、platform、kind（category|tag）、external_id、name、parent_id、extra、synced_at。唯一 `(app_id, platform, kind, external_id)`；name 以 `COLLATE NOCASE` 索引，支持精确/前缀/排序查询 |

## 计划状态机

`article_plan.plan_status` 驱动整个 SOP：

```
todo → written → queued → published   （archived/paused 为终态或暂停态）
```

- `todo` —— 已规划、未写。
- `written` —— 正文已写（配图可能未完成）。
- `queued` —— WordPress **草稿**已就位，等待排期槽位。
- `published` —— 已上线。

`publish_daily`/`promote-daily` 按 `publish_order`（`plan.nextDue`）取队列最前面的 `queued` 行，遵循 `wordpress.yaml` 的 `per_day`/`skip_dates`。

## 站点目录布局

```
<workspace>/<site>/
├── .env                    # 密钥（gitignore）
├── config/
│   ├── site.yaml           # 站点身份、默认语言
│   ├── wordpress.yaml      # WP 连接 + 发布日历（per_day/skip_dates）
│   └── monitor.yaml        # 监测模型/层级
├── data/
│   ├── inbox/              # 摄取的文章源（翻译放 <lang>/ 子目录）
│   ├── reports/            # 诊断与方案报告
│   └── channel-export/     # 每平台发布包
└── ...
```

WordPress 连接参数可在每站点的 `.env` 中覆盖（`WP_URL`、`WP_USERNAME`、`WP_PASSWORD` …），发布时解析。
