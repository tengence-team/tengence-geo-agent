# Tengence GEO Agent — Documentation / 文档中心

The **Tengence GEO Agent** is a full-pipeline GEO/SEO content engine that any AI
client can drive through MCP, that runs standalone through a CLI, and that ships with
a built-in agent runtime loop. It covers the whole lifecycle from **site diagnosis →
implementation plan → keyword matrix → publishing plan → article drafting → multilingual
translation → image acquisition → editorial gate → draft publish → scheduled live
publish → search submission → AI-visibility monitoring**.

Tengence GEO Agent 是一个完整的 GEO/SEO 内容引擎，可通过 MCP 被任意 AI 客户端调用，也可通过 CLI 独立运行，并内置 Agent 运行时。它覆盖从**站点诊断 → 实施方案 → 关键词矩阵 → 发布计划 → 文章撰写 → 多语言翻译 → 配图 → 门禁检查 → 草稿发布 → 定时正式发布 → 收录提交 → AI 可见性监测**的完整生命周期。

## Guide / 指南

| Document / 文档 | EN | 中文 |
| --- | --- | --- |
| Overview · 产品概览与架构 | [overview.en.md](overview.en.md) | [overview.zh.md](overview.zh.md) |
| End-to-end Workflow / SOP · 端到端工作流 | [workflow/pipeline.en.md](workflow/pipeline.en.md) | [workflow/pipeline.zh.md](workflow/pipeline.zh.md) |

## Reference / 参考

| Document / 文档 | EN | 中文 |
| --- | --- | --- |
| MCP Tools (72) · MCP 工具全参考 | [reference/mcp-tools.en.md](reference/mcp-tools.en.md) | [reference/mcp-tools.zh.md](reference/mcp-tools.zh.md) |
| CLI Commands (24) · CLI 命令参考 | [reference/cli-commands.en.md](reference/cli-commands.en.md) | [reference/cli-commands.zh.md](reference/cli-commands.zh.md) |
| Environment & Config · 环境变量与配置 | [reference/environment.en.md](reference/environment.en.md) | [reference/environment.zh.md](reference/environment.zh.md) |
| Data Model · 数据模型 | [reference/data-model.en.md](reference/data-model.en.md) | [reference/data-model.zh.md](reference/data-model.zh.md) |

## Other repository docs / 仓库其它文档

- [architecture.md](architecture.md) — Repository architecture / 架构
- [getting-started.md](getting-started.md) — 5-minute quickstart / 快速开始
- [mcp-platforms.md](mcp-platforms.md) — MCP platform integration / 平台接入
- [mcp-publication-guide.md](mcp-publication-guide.md) — Publishing to MCP registry / MCP 发布指南
- [release.md](release.md) — Release & distribution / 发版与分发

## How these docs are organized / 文档组织方式

Each topic ships as a **pair of files** — one English, one Chinese — so both are clean
and single-language. The reference files group tools/commands by **capability domain**
(not by product form: MCP tool / CLI command / SDK function of the same capability are
described together), following the pattern the code itself uses.

每个主题以**一对文件**交付——一个英文、一个中文，各自干净单语。参考文档按**能力域分组**（同一能力的 MCP 工具 / CLI 命令 / SDK 函数放在一起描述），与代码自身的组织方式一致。

> **Source of truth:** the code. The MCP tool registry
> (`packages/geo-mcp/tools/registry.js`), the CLI bins (`packages/geo-cli/bin/`) and the
> SDK (`packages/geo-sdk/`) are authoritative. If a doc disagrees with code, the code wins.
>
> **信息来源：** 代码本身。MCP 工具注册表（`packages/geo-mcp/tools/registry.js`）、CLI 命令（`packages/geo-cli/bin/`）与 SDK（`packages/geo-sdk/`）为权威；如文档与代码不一致，以代码为准。
