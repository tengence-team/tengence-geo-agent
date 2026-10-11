---
name: geo-site-diagnosis
description: 对目标站点执行一次性、只读、全面的 GEO/SEO 技术诊断（115 项检查，12 维度），输出结构化诊断报告与 0–100 整体评分。当用户要求"诊断这个站点""检查网站 SEO/GEO 问题""审计域名/CDN/多语言/性能"时使用。诊断必须通过 MCP 的 diagnose_site 工具执行（走 API，不直接运行诊断代码），所有探测为 GET/HEAD 只读请求且受请求预算约束。
---

# 站点 GEO/SEO 诊断

## 用途

对站点做一次完整的技术可见性体检：从域名/CDN/传输层，到爬取/内容/多语言，再到 GEO（生成式引擎优化）信号与暴露面，共 **115 项检查 / 12 维度**，并给出整体评分（0–100 + 等级 + 分维度）。

## 前置条件

- MCP 服务已运行（`diagnose_site` 工具可用），工作区已绑定目标站点。
- 用户给出目标 URL（如 `https://www.example.com`）。站点会自动 bootstrap。

## 流程

1. `workspace_use` —— 绑定工作区（首次调用）。
2. `diagnose_site({url, max_pages?, deep?, max_requests?})` —— 执行完整诊断。
3. 解析返回：`checks[]`（115 项）、`score`（总分/等级/5 组权重）、`evidence`（原始证据）。
4. 按维度汇总问题 → 生成报告（HTML 或 Markdown），含：
   - KPI：总分大数字 + 等级徽章 + 分维度雷达/条形图；
   - 12 维度明细表（每项状态 pass/info/warn/fail + 详情）；
   - 问题清单与修复建议（按影响排序）。
5. 交付报告并说明：覆盖维度、检查数、验证方式。**请求预算用量是内部约束，默认不写入报告**——只有预算被耗尽/触发降级（deep 被跳过、部分探测未跑）时才在报告中说明，作为"本次覆盖范围的限制"而非常规指标。

## 检查清单（115 项 / 12 维度）

| 维度 | 检查数 | 覆盖内容 |
|---|---|---|
| domain | 10 | A/AAAA/NS/MX/TXT、证书有效期、CNAME 链、apex/www 规范化 |
| tech | 13 | HTTPS 强制、HTTP 版本、状态码、重定向链、压缩、缓存头、TTFB、HTML 体积、HTTP/3、重定向类型、移动端子域、TTFB 稳定性 |
| security | 7 | HSTS/CSP/Referrer-Policy/安全头基线、Cookie 标志、apex TLS、SAN 使用核对、SRI |
| platform | 4 | 服务器/CDN/CMS/前端框架识别 |
| crawl | 14 | robots 可用/引用/冲突、sitemap 可用/域一致/协议一致/语言分布/新鲜度/收录可访问性/软错误、404 处理、WAF、分页规范 |
| content | 29 | Title/Meta/跨页唯一性、正文重复、Canonical、H1/标题层级、图片 alt/格式/尺寸/格式一致性、正文量/词数、内链、viewport/lang/charset、统计代码、OG/Twitter、分享图片、OG/Twitter 一致性、文章日期可见性、本地资源 404、第三方域名 |
| geo | 24 | JSON-LD 站点/文章/FAQPage/Breadcrumb/Product 实体、可引用内容、robots meta/指令一致性、llms.txt、SEO/GEO 爬虫可达性×2、多语言独立版本、数据引用密度、日期信号、作者署名、权威来源引用、实体一致性、llms.txt 结构规范、静态 HTML 内容、AI 生成内容标识、问答块 |
| i18n | 5 | 首页 hreflang 对称性、404 本地化、语言切换器、hreflang 大小写统一、多语言文章覆盖度 |
| perf | 6 | 首屏资源量（按唯一 URL 去重：script/css/img 的 srcs 合集 Set 计数，复用资源合并）、渲染阻塞脚本、图片懒加载、资源预连接、LCP 候选、静态资源缓存策略 |
| cdn | 1 | CDN 缓存命中率抽样 |
| subdomains | 1 | 子域健康巡检（www/m/static/api 等） |
| exposure | 1 | 后台/隐藏路径暴露面 |

## 评分模型（已确认口径）

- **5 组加权**：GEO 30%（geo+i18n）· SEO 25%（content+crawl）· 技术 20%（domain+tech+security+platform）· 性能 15%（perf+cdn）· 暴露面/子域 10%（subdomains+exposure）。
- **单项权重**：pass=1 · info=0.5 · warn=0.3 · fail=0。
- **组得分** = Σ(单项权重)/组内检查数 × 100；**总分** = Σ(组得分 × 组权重)。
- **等级**：A ≥90 · B ≥75 · C ≥60 · D <60。
- 报告须输出：总分大数字 + 等级徽章 + 分维度雷达/条形图 + 分组明细表。

## 硬性要求

- **只读与压力约束**：全部探测 GET/HEAD 只读；默认请求预算 700（`max_requests`），并发 ≤8，单请求超时兜底；`deep=false` 可跳过一切新增请求的探测（保留零请求解析检查）。**预算为内部限制，不默认写入报告**；仅当预算耗尽、deep 被跳过或部分探测因预算未执行时，报告中才注明"本次覆盖范围受限"，并说明哪些维度缺失。
- **不直接运行诊断代码**：诊断必须通过 MCP `diagnose_site` 工具（API）执行；SDK 本地运行仅限开发排障，不作为交付路径。
- **报告要给出整体评分**：总分、等级、分维度必须齐全，评分口径与上述模型一致。
- 状态区分：fail=明确缺陷（阻断/失真）、warn=需优化、info=中性事实、pass=达标。
- **判定口径（v3 修正，2026-10-11）**：
  - 图片 alt：仅「无 alt 属性」计缺失；`alt=""` 是装饰/图标图的合法语义（WCAG 1.1.1），不计缺失。
  - 重定向类型：302 + `Vary: Accept-Language` 的**语言协商重定向**（多语言首页按 Accept-Language/Cookie 302 到语言前缀）为设计内正确实践，豁免 warn；非协商 302 仍 warn。
  - 移动端子域：首跳 302 指向 www 或语言前缀、且全链均为 302 的 m 站协商/引导链（如 m→www→/zh-hans），判 info；出现非 302 跳或异常语义才 warn。
  - 日期信号：无 datePublished/dateModified 的纯营销/静态官网判 info（无"文章"语义属正常）；内容型站点的日期可见性由「文章日期可见性」检查覆盖。
  - robots Allow/Disallow 冲突：**WordPress 官方默认模板组合豁免**（`Allow /wp-admin/admin-ajax.php` vs `Disallow /wp-admin/` 属 admin-ajax 前端接口放行的刻意设计；`Allow /wp-content/themes/*/assets/images/` vs `Disallow /wp-content/themes/` 属文章图片可收录的刻意设计），不判 warn；其余真实冲突（如 Allow 长于 Disallow 覆盖管理路径）仍 warn。
- 软失败：单探测失败不中断整个诊断；异常在 evidence/check 中标注。
- 多语言站点须分别核对各语言首页与 sitemap 语言分布；hreflang 对称性单独成检。

## 示例

```
用户：诊断一下 www.example.com
→ workspace_use({path: "~/geo-workspace"})
→ diagnose_site({url: "https://www.example.com", max_pages: 6})
→ 解析 115 项 + score → 生成 HTML/MD 报告（KPI + 维度明细 + 问题清单）
→ 交付并说明覆盖与预算用量
```

## 错误处理

| 现象 | 处理 |
|---|---|
| 返回 `Invalid URL` | 核对 URL 格式（协议/主机名）；检查 args 传递是否为合法 JSON |
| 预算耗尽（deepSkipped） | 提高 `max_requests` 或接受零请求检查结果 |
| 单维度全 info | 该站点无对应资产（如无文章页），属正常，报告中说明 |
| 请求超时/软失败 | 重试一次；仍失败则标注未覆盖项并继续其余维度 |
