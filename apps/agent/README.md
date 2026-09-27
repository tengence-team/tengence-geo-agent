# @tengence/geo-agent

Tengence GEO Agent 的可插拔运行环启动器（DeepSeek Harness / opencode / Pi）。设置 API Key 后即可作为独立 Agent 运行，并通过 MCP 桥接 `@tengence/geo-mcp` 的全部能力。

## 安装与运行
```bash
npm i -g @tengence/geo-agent
DEEPSEEK_API_KEY=sk-xxx tengence-geo-agent
# 或
npx -y @tengence/geo-agent
```

## 环境变量

| 变量 | 说明 | 必填 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek Harness 运行所需 API Key | 是 |
| `SITES_ROOT` / `TENGENCE_GEO_HOME` / `DB_DRIVER` | 同 `@tengence/geo-mcp` | 否 |

## 许可

MIT © Tengence Team
