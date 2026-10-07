# Release & Distribution（npm 单包 + CI 通道）

> 更新日期：2026-10-07 · 基于 0.1.3 实跑经验
> 发布形态：**根单包 `tengence-geo-agent`**（bundle 四个 @tengence/* workspace 包），不再按四包分别发

## 0. 发布形态（为什么是单包）

根 `package.json`：

- `name: tengence-geo-agent`（2026-10-07 起，旧形态是 @tengence 四包分开发）
- `workspaces: ["packages/*", "apps/*"]` + `bundleDependencies: [4 个 @tengence/* 包]` → 单包 tarball 内含全部源码
- `files`: packages / apps / examples / scripts / mcp.json / README.md / LICENSE
- `bin`: 25 个 `tengence-geo-*` CLI + `tengence-geo-mcp` / `tengence-geo-mcp-http` / `tengence-geo-agent`
- `mcpName: "com.tengence/geo-agent"` —— **必填**（MCP Registry 硬校验，缺了报 `missing required 'mcpName' field`）

消费者用法（对外文案）：

```bash
npx -y -p tengence-geo-agent tengence-geo-mcp          # MCP stdio（两 bin 必须 -p + bin 名）
npx -y -p tengence-geo-agent tengence-geo-plan         # 任意 CLI
npx -y -p tengence-geo-agent tengence-geo-mcp-http     # MCP HTTP
```

## 1. 发布通道：只用 CI（tag 触发），不要本地 publish

**本机 npm 10.9.8、无任何 npm token（账号 tengence 的凭据不在本机/不在仓库）**。历史上唯一可行通道是 GitHub Actions：

`.github/workflows/release.yml`（2026-10-07 改为单包版）：

```yaml
on: { push: { tags: ['v*'] } }
permissions: { contents: write, id-token: write }   # id-token 供 provenance/OIDC
jobs:
  test: npm ci && npm run build && npm test
  npm:  npm ci && npm publish --provenance --access public   # 根包单发
        env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- `NPM_TOKEN` 是仓库 secret（Automation token，2026-09-27 设置，有效）。
- 已删除旧的 registry job：com.tengence/* 需要本地 HTTP 私钥，CI 的 GitHub OIDC 只覆盖 io.github.* 命名空间 → **MCP Registry 发布走本地**（见 docs/mcp-publication-guide.md §3）。

发版三步（git 改动先展示 diff 再提交，用户偏好硬约束）：

```bash
# 1) bump 版本（package.json + package-lock.json 顶层 version 同步）
# 2) git commit && git push origin main
# 3) git tag vX.Y.Z && git push origin vX.Y.Z   # 触发 CI
```

**tag 版本占用（重要）**：v0.1.0 / v0.1.1 已被旧 @tengence 四包发布占用（2026-09-27）。
单包版本从 **v0.1.2 起**；tag 冲突报 `fatal: tag 'vX.Y.Z' already exists` 时按序递增，不要 force 覆盖旧 tag。

## 2. npm Staged Publishing（2026-05-29 GA，绕不开，必须知道）

npm 对新包/CI 可信发布引入 staging 审核：`npm publish` 提交后，包先以占位版 **`0.0.0-stage`** 出现在 registry（可查），**真实版本要 maintainer 在 npmjs.com 批准（需 2FA）后才上线**。

实测规律（tengence-geo-agent）：

| 发布 | 是否 staging | 说明 |
| --- | --- | --- |
| 0.1.2（首版新包） | ✅ 是 | 必须批准：npmjs.com → 左侧 **Staged Packages** → 找到包 → **Approve**（2FA） |
| 0.1.3（同包后续版本） | ❌ 否 | 直接上线，免批准 |

判定 staging 是否完成：

```bash
curl -s https://registry.npmjs.org/tengence-geo-agent | python3 -c "import json,sys;d=json.load(sys.stdin);print(sorted(d.get('versions',{}).keys()),d.get('dist-tags',{}).get('latest'))"
# 出现真实版本号即已上线；只有 0.0.0-stage 则还需批准
```

- 本机 npm 10.9.8 无 `npm stage` 子命令（需 npm ≥11.15），批准只能在 npmjs.com 网页完成（2FA 我无法代做，必须用户操作）。
- CI 发布后到版本可见有 **CDN 传播延迟**（0.1.2 曾 404，几分钟后可见）；不要立即判定失败。

## 3. 发布后验证清单

```bash
# npm 上线
npm view tengence-geo-agent version --registry=https://registry.npmjs.org/   # 期望 0.1.x
# 冒烟（空机可启动）
npx -y -p tengence-geo-agent tengence-geo-mcp    # initialize 返回 serverInfo: tengence-geo-mcp
# MCP Registry 见 docs/mcp-publication-guide.md §3（本机 login+publish 背靠背）
```

- [ ] `npm run build` + `npm test` 全绿（CI test job）
- [ ] tag 推送后 CI Release run 全绿（`gh run watch`）
- [ ] npm 版本可见（含 staging 批准 + CDN 传播）
- [ ] registry 官网搜索 `com.tengence/geo-agent` 命中（前缀匹配，搜 `tengence` 会命中）
- [ ] `npx -y -p tengence-geo-agent tengence-geo-mcp` 空机启动冒烟

## 4. 历史存档（旧四包形态，勿回退）

2026-09-27 的发布是 @tengence/{geo-sdk,geo-cli,geo-mcp,geo-agent} 四包分开发（0.1.0 → 0.1.1），
registry 条目 io.github.tengence-team/geo。这些包仍在 npm 上、条目仍在 registry，**保留不动**（不覆盖、不删除），
不影响已安装用户；新版本一律走单包 `tengence-geo-agent` + `com.tengence/geo-agent`。
