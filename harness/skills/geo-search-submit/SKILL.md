---
name: geo-search-submit
description: 文章发布后向搜索引擎提交收录，并按 T+3/T+7/T+14 节奏复推。当用户要求提交收录、推送 sitemap、查 GSC/Bing 收录状态、或处理"发了但搜不到"时使用。
---

# 收录提交

## 用途

把已发布 URL 推给搜索引擎，并读回**真实的**收录状态。

## 前置条件

- 文章已发布且有可访问 URL。
- 站长平台凭据已配置（GSC / Bing / 百度），由站点补充文件提供。

## 流程

1. `standards_read('search-engine-integration')` —— 读收录→排名→引用链路、
   推送渠道架构、配额与节奏、复推时间表。
2. 读基线：`search_gsc_stats`、`search_gsc_inspect`、`webmaster_bing_status`
   —— **以站长后台真实数据为准，不用 `site:` 查询数**。
3. 提交：`search_submit_indexnow`（IndexNow，覆盖 Bing 系）、
   `search_submit_gsc`（Google）、`search_submit_baidu`（百度）、
   `webmaster_bing_submit`（Bing）。
4. 复推：按 **T+3 / T+7 / T+14** 节奏对未收录 URL 重复提交。
5. `diagnose_site` 排查站点层面的收录障碍（sitemap、robots、规范化、死链等）。
6. `report_write` 输出提交结果报告。

## 关键参数

| 参数 | 说明 |
|---|---|
| URL 列表 | 已发布文章的规范 URL，需与 canonical 一致 |
| 渠道 | IndexNow / GSC / 百度 / Bing，按目标市场选择 |
| 配额 | 各渠道有配额与频率限制，详见标准文档 |

## 硬性要求

- **不承诺"提交即收录"**：提交是请求抓取，不等于收录保证。
- 只用站长后台读数做基线报告。
- 批量提交前必须确认条数与域名。
- URL 必须与 canonical 一致，避免重复提交变体。

## 示例

```
用户：昨天发的三篇文章提交一下收录
→ standards_read('search-engine-integration')
→ search_gsc_stats 读当前基线
→ search_submit_indexnow（3 条 URL）
→ 报告：已提交 3 条，当前收录基线 X，建议 T+3 复推
```

## 错误处理

| 现象 | 处理 |
|---|---|
| 提交返回配额错误 | 降低频率，按 T+3/T+7/T+14 分批 |
| 长期不收录 | `diagnose_site` 查 sitemap/robots/canonical/死链 |
| 凭据失效 | 提示用户重新配置站长平台凭据，不臆造状态 |

## 高风险确认规则

- **批量提交（>10 条）**：先复述条数、渠道、目标域名并确认。
- 修改 robots.txt / sitemap：属站点级变更，须确认。

## 边界

不撰写、不发布。收录问题若源于稿件质量，退回 `writing-gate`。
