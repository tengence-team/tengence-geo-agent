# @tengence/geo-mcp

GEO 内容引擎的 MCP 服务：**56 个工具**，覆盖内容生产、发布、搜索引擎收录提交、AI 可见性监测与多平台分发。支持 **stdio**（本地客户端）与 **Streamable HTTP**（远程/自托管）两种传输。

这是 `@tengence/geo-sdk` 的 MCP 桥接层；底层存储默认使用 Node 22.5+ 内置的 `node:sqlite`（零原生依赖），旧版 Node 或禁用内置模块时回退到可选的 `better-sqlite3`。

> 命名空间：`io.github.tengence-team/geo` · 官方 Registry：`registry.modelcontextprotocol.io`

## 安装与运行

### 方式一：npx 直装（推荐）
```bash
npx -y @tengence/geo-mcp              # stdio 模式，无需本地仓库
```

### 方式二：作为客户端 MCP server 配置
```jsonc
{
  "mcpServers": {
    "tengence-geo": {
      "command": "npx",
      "args": ["-y", "@tengence/geo-mcp"]
      // 可选环境变量：
      // "env": { "SITES_ROOT": "~/tengence/sites", "DB_DRIVER": "sqlite" }
    }
  }
}
```

工作台目录在运行时由客户端决定（通过 `workspace_use` 工具），内部数据落在 `~/.tengence/geo-mcp`。**无需**设置 `SITES_ROOT` / `DB_PATH` / `APP_ID` 即可启动。

### 方式三：Streamable HTTP（自托管）
```bash
GEO_MCP_PORT=8787 GEO_MCP_TOKEN=sk-xxx SITES_ROOT=~/tengence/sites \
  npx -y @tengence/geo-mcp-http
# Base URL = http://127.0.0.1:8787/    Auth = Bearer <GEO_MCP_TOKEN>
```
> 远程模式目前仅有静态 Bearer 鉴权（无 OAuth 2.1 / 动态客户端注册），适用于单用户自托管；多租户公开托管需待授权层补齐。

## 环境变量

| 变量 | 说明 | 必填 | 默认 |
| --- | --- | --- | --- |
| `SITES_ROOT` | 各站点配置 / `.env` 的根目录 | 否 | — |
| `TENGENCE_GEO_HOME` | 内部运行时数据目录 | 否 | `~/.tengence/geo-mcp` |
| `DB_DRIVER` | `sqlite`（默认）\| `mysql` | 否 | `sqlite` |
| `DB_PATH` | SQLite 文件路径（`~` 展开） | 否 | `$TENGENCE_GEO_HOME/geo.sqlite` |
| `GEO_SQLITE_DRIVER` | `builtin`\|`native` 显式选择 SQLite 驱动（测试/排错用） | 否 | 自动（优先 builtin） |
| `GEO_MCP_PORT` | HTTP 模式监听端口 | 否 | `8787` |
| `GEO_MCP_TOKEN` | HTTP 模式 Bearer 令牌；未设置则无鉴权（仅本地调试） | 否 | 空 |

## Node 版本与可选依赖

- **Node ≥ 22.5**：默认走内置 `node:sqlite`，`npx` 安装体积最小、无原生编译。
- **Node 20 / 21** 或禁用内置模块：需先 `npm i better-sqlite3`（可选依赖，已随包声明）。
- **图片处理**（缩略图/裁剪）需要可选的 `sharp`：未安装时调用图片命令会给出明确的安装提示，不影响其余工具。
- 生产环境可使用 MySQL：设 `DB_DRIVER=mysql` 并提供 `MYSQL_*` 连接变量。

## 工具概览（按域）

内容（ingest/draft/check/publish/standards/plan）、WordPress 发布、搜索引擎收录（GSC/Bing/IndexNow/Baidu）、AI 监测、微信/掘金/Dev.to 等分发、站点诊断与图片采集。完整清单以 `tools/registry.js` 导出为准。

## 许可

MIT © Tengence Team
