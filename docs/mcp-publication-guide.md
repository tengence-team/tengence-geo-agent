# 发布 @tengence/geo-mcp 到公共平台的操作指引

> 适用仓库：`tengence-geo-agent` · 目标平台：MCP Registry（官方）、Coze（扣子）、豆包
> 更新日期：2026-09-28 · 基于 0.1.1 版本现状编写
> v2 修订：更正「VS Code 可从 Registry 搜索安装」的错误表述（见 3.5 节）

---

## 0. 现状盘点（哪些已就绪、哪些还差）

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| `@tengence/geo-sdk` / `geo-cli` / `geo-mcp` / `geo-agent` 发布 npm | ✅ 已发布（0.1.1） | `npm view @tengence/geo-mcp version` 返回 0.1.1 |
| 发布到官方 MCP Registry | ✅ 已发布 | `io.github.tengence-team/geo`，0.1.0 + 0.1.1 并存，0.1.1 为 latest |
| `server.json`（MCP Registry 元数据） | ✅ 已就绪 | 根目录，2025-12-11 schema |
| 锁步发布脚本 | ✅ 已有 | `scripts/release.js` |
| 公网 HTTPS 部署 | ❌ 待做 | 仅 Coze / 豆包连接器需要 |
| OAuth / 多租户授权层 | ❌ 待做 | 目前仅静态 Bearer token |
| VS Code @mcp gallery 收录 | ❌ 未做 | VS Code 搜索源，与官方 Registry **不同步** |

**结论：官方 MCP Registry 已发布；但只有「消费该 Registry 的工具」能直接搜到安装（VS 2022 / mcpm / getmcp 等）。VS Code 的 @mcp gallery、豆包、Coze 都不消费它，需各自走对应通道。**

---

## 1. 三条路径怎么选

| 路径 | 面向用户 | 是否需要公网部署 | 上架审核 | 适合场景 |
| --- | --- | --- | --- | --- |
| **A. 官方 MCP Registry** | 仅**消费该 Registry 的工具/客户端**（VS 2022「MCP 注册表」= GitHub MCP Registry、mcpm、getmcp 等）；**VS Code 的 @mcp gallery、豆包、Coze 均不消费它** | 否（stdio 包） | 命名空间校验，即时生效 | 开发者/极客，推荐首选 |
| **B. Coze 插件商店** | 扣子生态用户 | 是（HTTPS 域名） | 平台审核 | 中文公共分发、低代码用户 |
| **C1. 豆包自定义插件** | 你指定的豆包用户 | 否（stdio）或 是（HTTP） | 无 | 私有/定向分发，最快落地 |
| **C2. 豆包连接器市场** | 豆包全网用户 | 是 | 官方审核/商务渠道 | 公开上架（非自助） |

---

## 2. 共同前置：公网 HTTPS 部署（路径 B / C2 必需）

geo-mcp 的 HTTP 传输是 **MCP Streamable HTTP**（`POST /messages`，JSON-RPC 2.0），
入口 `packages/geo-mcp/bin/geo-mcp-http.js`。已内置：多会话隔离、Bearer 鉴权、
CORS 全开、Accept 头归一化（兼容豆包连接器）、`GET /` 健康检查。

### 2.1 部署到云主机（以 Linux + systemd 为例）

```bash
# 1) 安装 Node 22.13+（生产建议 24 LTS）
# 2) 安装依赖并启动
npm i -g @tengence/geo-mcp
mkdir -p /opt/tengence/geo-sites /opt/tengence/geo-home

GEO_MCP_PORT=8787 \
GEO_MCP_TOKEN=sk-geo-<强随机串> \
SITES_ROOT=/opt/tengence/geo-sites \
TENGENCE_GEO_HOME=/opt/tengence/geo-home \
  tengence-geo-mcp-http
```

systemd 单元（`/etc/systemd/system/tengence-geo-mcp.service`）：

```ini
[Unit]
Description=Tengence GEO MCP (Streamable HTTP)
After=network.target

[Service]
ExecStart=/usr/bin/env GEO_MCP_PORT=8787 GEO_MCP_TOKEN=sk-geo-xxx SITES_ROOT=/opt/tengence/geo-sites TENGENCE_GEO_HOME=/opt/tengence/geo-home tengence-geo-mcp-http
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 2.2 HTTPS 反向代理（nginx 示例）

```nginx
server {
    listen 443 ssl;
    server_name mcp.tengence.io;          # 你的域名，必须为 HTTPS 域名（Coze 不支持 IP）

    ssl_certificate     /etc/letsencrypt/live/mcp.tengence.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.tengence.io/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;              # SSE / Streamable HTTP 需要
        proxy_read_timeout 300s;
    }
}
```

> 修改服务器/nginx 配置属于你的既定偏好：方案见上，确认后再执行。证书可用
> certbot（Let's Encrypt）免费签发。

### 2.3 上线前验证

```bash
curl https://mcp.tengence.io/                      # 期望 {"ok":true,"server":"tengence-geo-mcp","version":"0.1.1"}
curl -H "Authorization: Bearer sk-geo-xxx" -H "Content-Type: application/json" \
  https://mcp.tengence.io/messages -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
# 期望 JSON-RPC 响应含 serverInfo；再发 tools/list 应返回 56 个工具
```

---

## 3. 路径 A：发布到官方 MCP Registry（已完成）

MCP Registry 只存元数据，制品仍托管在 npm。发布要求：npm 账号 + GitHub 账号
（**必须能控制 `tengence-team` 组织**，因为 `mcpName` 前缀是 `io.github.tengence-team/`）。

### 3.1～3.4 发布流程（已完成，留档）

```bash
brew install mcp-publisher
cd /Users/tim/tengence/tengence-geo-agent
mcp-publisher login github       # 用拥有 tengence-team 组织权限的账号
mcp-publisher publish            # 发布到 registry.modelcontextprotocol.io
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.tengence-team/geo"
```

后续版本升级（每次发版固定流程）：

```bash
node scripts/release.js 0.2.0 --tag   # 同步 4 包版本 + 重写内部依赖 + 同步 server.json
npm test
npm publish -w packages/geo-sdk
npm publish -w packages/geo-cli
npm publish -w packages/geo-mcp
npm publish -w apps/agent
mcp-publisher publish                 # 重新发布新版本元数据
```

### 3.5 用户安装方式（对外宣传文案）

```bash
# 方式一：支持 MCP Registry 的工具（mcpm / getmcp / VS 2022「MCP 注册表」）
mcpm install io.github.tengence-team/geo

# 方式二：任意支持 stdio MCP 的客户端
npx -y -p @tengence/geo-mcp tengence-geo-mcp
```

```jsonc
// 客户端 mcpServers 配置（VS Code / Claude / Cursor 通用）
{
  "mcpServers": {
    "tengence-geo": {
      "command": "npx",
      "args": ["-y", "-p", "@tengence/geo-mcp", "tengence-geo-mcp"]
    }
  }
}
```

### ⚠ 关于「搜索安装」的重要说明（2026-09-28 实测）

1. **官方 Registry 的搜索是 server 名称前缀匹配，不是全文搜索**：
   实测 `search=tengence` 命中 0，只有 `search=io.github.tengence-team/geo`（完整名称）才命中。
   即使客户端接了官方 Registry，也必须搜完整名称。
2. **VS Code 的 `@mcp` 搜索 ≠ 官方 Registry**：VS Code 的 MCP 列表来自微软
   **人工策划的 MCP server gallery**（code.visualstudio.com/mcp 页面明确写着
   "curated list… if you don't see an MCP server you're looking for, please suggest it here"），
   与 modelcontextprotocol.io **无自动同步**。因此在 VS Code 扩展视图搜不到是正常的。
3. **Visual Studio 2022 的「MCP 注册表」≠ 官方 Registry**：那是 **GitHub MCP Registry**
   （GitHub 2025 年推出的独立 registry，基于 GitHub 仓库元数据收录），同样不会自动同步。
4. 想让 VS Code 用户「被搜到」：走 code.visualstudio.com/mcp 页面的 suggest 渠道提交收录
   （微软审核的 curated 列表）；想让用户「直接用」：发上面那段 `mcp.json` 配置即可，无需任何收录。

---

## 4. 路径 B：发布到 Coze（扣子）插件商店

前置：第 2 节的公网 HTTPS 端点已就绪，记为 `https://mcp.tengence.io/`，Bearer token 记为 `sk-geo-xxx`。

### 4.1 创建 MCP 插件（扣子编程）

1. 登录 [扣子开发平台 / 扣子编程](https://code.coze.cn/)（旧版入口：首页右上角「回到旧版」）。
2. 顶部选择目标工作空间 → 左侧导航 **资源库** → 右上角 **+资源 → 插件**。
3. 填写配置并确认：

| 配置项 | 填写 |
| --- | --- |
| 插件名称 | `Tengence GEO Agent`（建议清晰、利于 LLM 识别） |
| 一句话介绍 | GEO/SEO 内容生产与发布引擎（56 个 MCP 工具） |
| 插件描述 | 覆盖内容规划、撰写、质检、发布、收录提交、AI 可见性监测 |
| 插件图标 | 上传 PNG（可选） |
| 类型 | **MCP** |
| 插件 URL | `https://mcp.tengence.io/`（必须 HTTPS 域名，**不支持 IP**） |
| Header / 授权 | `Authorization: Bearer sk-geo-xxx`（或选择 Service → token） |

4. 确认后系统**自动同步**全部 MCP 工具到工具列表。

### 4.2 试运行

在插件页对任一工具（如 `workspace_use` / `util_ping`）填写参数试运行，
`Response` 正常返回即调试成功。

### 4.3 发布插件 → 上架商店

1. 插件页面单击 **发布**，确认个人信息收集后发布（发布后才能在智能体/工作流中使用）。
2. 上架：左侧导航 **更多 → 社区 → 插件市场** → 右上角 **上架插件** → 选择刚发布的插件；
   或从资源库插件页直接点 **上架插件**。
3. 填写插件描述、使用说明、分类 → 提交 → 等待平台审核。
4. 维护：插件详情页可 **提交更新**（改描述/分类/同步配置变更）或 **下架**。

> 上架渠道二选一：扣子插件商店（公开）或企业插件商店（企业旗舰版内部），不可同时。

### 4.4 对外的安装说明（写进插件描述）

> 安装后在扣子插件商店搜索「Tengence GEO Agent」→ 添加到 Bot / 工作流。
> 工具依赖一个工作区目录（`workspace_use` 绑定），首次使用请按提示提供目录。

---

## 5. 路径 C：豆包

### 5.1 方式一：豆包工作客户端「自定义插件」（私有/定向分发，最快）

豆包工作客户端支持 **HTTP** 与 **STDIO** 两种自定义插件，无需审核即可分发。
注意：豆包工作文档注明**自定义连接器仅支持在本地电脑中使用**。

**HTTP 模式**（需要公网 HTTPS 端点）：
1. 打开豆包客户端 → 左侧 **插件·技能·伙伴** → **插件** → 右上角 **+ 添加** → **新建自定义插件**。
2. 填写：服务器名称 `tengence-geo`；传输类型 `HTTP`；服务器 URL `https://mcp.tengence.io/`；
   自定义 Headers `token: sk-geo-xxx`（或 `Authorization: Bearer sk-geo-xxx`）。
3. 保存后工具列表自动出现 56 个工具，可直接对话调用。

**STDIO 模式**（用户机器需 Node 20+，无需公网部署）：
```jsonc
// 同上入口，传输类型选 STDIO
// command: npx
// args:    ["-y", "-p", "@tengence/geo-mcp", "tengence-geo-mcp"]
```

分发方式：把上述配置截图/文字发给目标用户，让其手动添加；或把仓库
`docs/mcp-platforms.md` 的配置片段一并分享。

### 5.2 方式二：豆包「连接器市场」公开上架（官方审核制）

- 现状：豆包客户端内有「连接器市场/广场」，已有第三方 MCP（如通联数据 Datayes）上架，
  用户搜索即可添加授权使用。
- 入口：**目前没有公开的自助上架入口**，为官方审核/商务渠道。申请路径：
  1. [豆包开发者平台](https://developer.doubao.com/)（提供 MCP 端点注册相关能力）；
  2. 通过豆包/火山引擎商务或开发者社区渠道提交入驻申请；
  3. 上架前必须：公网 HTTPS 端点稳定可访问、有明确鉴权方案、通过平台内容与安全审核。
- 建议：先用 5.1 的自定义插件跑通分发与口碑，再走官方入驻。

---

## 6. 鉴权与多租户风险（上架前必须了解）

当前 HTTP 模式**仅有静态 Bearer token 鉴权**（`GEO_MCP_TOKEN`），无 OAuth 2.1 / 动态客户端注册：

| 风险 | 说明 |
| --- | --- |
| 共享 token | 所有安装者共用同一个 token 和后端数据目录（`SITES_ROOT` / `TENGENCE_GEO_HOME`） |
| 数据互相可见 | 用户 A 创建的文章/站点，用户 B 也能读到、改到 |
| 安全暴露面 | token 泄露即等于完全控制该实例 |

缓解方案（按推荐顺序）：
1. **短期**：以「演示版 / 体验版」姿态上架，明示单租户限制；或每个付费用户独立实例 + 独立 token（运维成本高）。
2. **中期**：为 HTTP 入口补充 OAuth 2.1 / 动态客户端注册（README 已注明待做），再开放多租户公开托管。
3. 若面向开发者：引导用户**自行部署**（`npx -y -p @tengence/geo-mcp tengence-geo-mcp-http` + 自己的 token），
   你只分发部署说明——这也正是路径 A 的天然形态，无此风险。

---

## 7. 发布后验证清单

- [ ] `curl https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.tengence-team/geo` 返回元数据（路径 A；注意必须用完整名称搜索）
- [ ] `npm view @tengence/geo-mcp version` 与 server.json 版本一致
- [ ] 空机执行 `npx -y -p @tengence/geo-mcp tengence-geo-mcp` 能启动并完成 `initialize`（路径 A）
- [ ] `mcpm search io.github.tengence-team/geo` / `mcpm install io.github.tengence-team/geo` 可用（路径 A，mcpm 客户端）
- [ ] VS Code 用户侧：提供 `.vscode/mcp.json` 配置后能列出 56 个工具（路径 A 补充）
- [ ] `curl https://<域名>/` 返回 `{ok:true,...}`，`initialize` + `tools/list` 返回 56 个工具（路径 B/C）
- [ ] 扣子插件商店搜索到「Tengence GEO Agent」且工具可试运行（路径 B）
- [ ] 豆包自定义插件添加后对话能触发工具调用（路径 C）
- [ ] 用无头浏览器/真实客户端截图确认线上连接器页面显示正常（若有页面）

---

## 8. 参考资料

- MCP Registry Quickstart（官方发布教程）：https://modelcontextprotocol.io/registry/quickstart
- MCP Registry 支持的包类型：https://modelcontextprotocol.io/registry/package-types
- MCP Registry 说明：https://modelcontextprotocol.io/registry/about
- VS Code·Add and manage MCP servers：https://code.visualstudio.com/docs/copilot/chat/mcp-servers
- VS Code·MCP Servers curated list（suggest 入口）：https://code.visualstudio.com/mcp
- GitHub Blog·GitHub MCP Registry：https://github.blog/ai-and-ml/generative-ai/how-to-find-install-and-manage-mcp-servers-with-the-github-mcp-registry/
- 扣子·基于 MCP 服务创建插件：https://docs.coze.cn/guides_create_a_plugin_based_on_mcp.md
- 扣子·将插件上架到插件市场：https://docs.coze.cn/guides/publish_plugin_to_store
- 豆包工作·使用插件（自定义插件）：https://www.doubao.com/work/docs/zh-cn/articles/705018132598-plugins
- 豆包开发者平台：https://developer.doubao.com/
- 本仓库接入说明：docs/mcp-platforms.md
- 本仓库发版流程：docs/release.md · scripts/release.js
