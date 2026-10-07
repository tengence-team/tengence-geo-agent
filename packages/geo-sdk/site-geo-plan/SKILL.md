---
name: site-geo-plan
description: 站点 GEO/SEO 优化实施方案生成。当用户要求"优化方案/实施方案/改造方案/整改方案/落地计划"（如"给 xxx.com 出优化方案""结合诊断报告做实施方案"）时使用。调用 MCP 工具 geo_solution，读取该站点已有诊断报告（diagnose_site + report_write 产物），确定性组装完整实施方案（技术修复/重建、关键词矩阵与内容、价值桥接、实施保障、附录；quote:true 时追加报价与年度费用），并通过 MCP 落盘到站点 data/plans/ 目录。也适用于改版规划、买站后整改、GEO 专项落地等场景。前提：站点必须先完成诊断（有 data/reports/ 下的诊断报告），否则工具会明确报错。
---

> **权威来源**：本文件是 site-geo-plan skill 的规范权威版本，随 tengence-geo-agent 工程在 `packages/geo-sdk/site-geo-plan/` 内版本管理，并可由 MCP 工具 `site_geo_plan_skill` 直接读取。运行时安装副本（DoubaoWork `.user_skills/site-geo-plan/`）仅为部署拷贝，内容以本文件为准。

# 站点 GEO/SEO 优化实施方案

## 执行流程

1. **确认目标站点**：从用户输入提取站点（域名或 site key）。方案基于诊断报告，若该站点还没有诊断报告，先走 site-diagnosis 流程（diagnose_site + report_write）生成报告，再回来生成方案。
2. **生成方案**：调用 MCP 工具 `geo_solution`，参数 `site` 传站点 key（如 `www_icdeal_com`）。可选参数：
   - `lang`：zh / en（默认 zh）；
   - `brand_name`：品牌名（写入方案头部与 Schema 示例）；
   - `industry`：行业/业务定位（写入方案头部）；
   - `quote`：是否纳入报价章节（默认 false——报价默认不纳入；仅当用户明确要求报价时才传 true）；
   - `unit_rates`：人日单价覆盖（仅在 quote:true 时有意义，如 `{"SEO 策略师": 2000}`）。
3. **核对输出**：工具返回结构化结果（site / domain / path / filename / chapters / quote_included / source_report）。chapters 默认 19（不含报价），quote:true 时为 21。若返回错误（如"没有诊断报告"），按错误提示补齐诊断再重试。
4. **汇报**：向用户概括——方案落盘路径、章节结构、基于诊断的核心问题映射（P0 清单）、以及方案中标注"待验证/待补充"的项（这些需要人工核实后再落地）。

## 方案基本原则

- 方案是**诊断报告的落地实施计划**：每一项结论都来自诊断证据；诊断报告里没有的证据，方案输出"待验证/待补充"占位，绝不编造数值（如 sitemap 规模、500 数量、报价）。
- 渲染方式判定自动完成：诊断判定为 JS 空壳 → 方案走"重建 SSR"路线；判定为 SSR/可读 → 方案走"现有栈修复加固"路线（不用人工指定）。
- 报价章节（§报价方案 + §年度例行费用）默认不生成；用户明确要求报价时才以 quote:true 生成，单价可覆盖。
- 章节结构与默认口径以 `references/plan-template.md` 为准；与模型直觉冲突时以文件为准。

## 与 site-diagnosis 的衔接

- **先诊断、后方案**：geo_solution 的输入是站点 `data/reports/` 下最新的诊断报告。诊断缺失 → 先调用 site-diagnosis 流程。
- 诊断报告的 14 节结构与方案的 19+2 章一一映射（健康度总评→预期目标表、问题汇总→方案问题清单、CITE 评分→GEO 专项、规模盘点→sitemap 章节等），映射关系见 `references/plan-template.md`。

## 参考文件

- `references/plan-template.md`：方案章节结构模板、各章与诊断维度的映射、默认参数口径（生成方案时必读）。
