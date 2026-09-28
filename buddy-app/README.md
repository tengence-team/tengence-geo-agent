# Buddy 应用 · 配置填写指引

> 对照本文件在 open.workbuddy.cn 逐模块填写。内容全部来自仓库已有文件，
> 直接复制粘贴即可，不需要再创作。

## 总流程

```
创建应用(模块1) → 创建审核通过 → 草稿态分模块配置 → 导出配置JSON备份
→ 预览调试(模块5) → 提交配置审核 → 发布上线
```

官方最佳实践：**每次退出配置前导出配置文件**，下次进入时导入即可还原。

## 模块 1 · 创建应用

| 字段 | 填什么 | 来源 |
|---|---|---|
| 应用 ID | 系统自动生成 | — |
| **应用头像** | 256×256 PNG | `assets/avatar-256.png` |
| **应用 icon** | 16×16 线稿 SVG | `assets/app-icon-16.svg` |
| 应用名称 | 通智GEO内容工作台 / Tengence GEO Content Workspace | `app-profile.md` |
| 应用简介 | 见该文件（中英双份） | `app-profile.md` |
| 授权列表 / 回调 URL / 可信 Origin | **留空** | 无 OAuth，见 `app-profile.md` |

> 创建后生成的 **Client Secret 仅展示一次**，务必当场保存。
> 已下发的 Client ID / Client Secret 记录在本目录 `credentials.local.md`
> （该文件已被 `.gitignore` 排除，**不会进版本库**；另请自行存入密码管理器）。

## 模块 2 · 首页配置

| 字段 | 来源 |
|---|---|
| 首页标题（Slogan） | `harness/ui-copy.md` → Slogan |
| 场景胶囊 | `harness/scenario-capsules.md`（中英各 5 条） |
| 工作模式（建议 3–5 个，最佳实践 2–4） | `harness/work-modes/{topic-planning,writing-gate,publishing,monitoring}.md`，每个文件内的 System Prompt 代码块直接粘贴 |
| 内置连接器 | **不配**（需 OAuth MCP，本次跳过） |

## 模块 3 · 市场配置

| 板块 | 来源 |
|---|---|
| 专家 | `harness/expert/geo-expert.md`（人设 + 能力边界 + 高风险确认规则）；分类标签见 `app-profile.md` |
| 技能 | `harness/skills/geo-article-writing/SKILL.md`、`geo-search-submit/SKILL.md`、`geo-visibility-monitor/SKILL.md`（含 frontmatter，可直接作为独立 Skill 资产） |
| 连接器 | 等 `tengence-geo-mcp` 连接器审核通过后引用；未通过前可先不配 |
| 精选场景 | **不开**（本次决策，避免 1000×910 日夜两套背景图的工作量） |

## 模块 4 · 其他配置

| 字段 | 填写 |
|---|---|
| 跳过首次绑定应用授权 | ✅ 勾选 |
| 绑定应用授权文案 | `harness/ui-copy.md` → 绑定授权文案（中英） |
| 输入框占位符 | `harness/ui-copy.md` → 输入框占位符（中英，必填两种） |
| 模型配置 | 平台 UI 从模型池勾选 → 拖动排序 → 指定默认模型（内容创作场景建议优先生成质量高的模型） |

## 模块 5 · 预览调试

下载对应版本的 WorkBuddy 端，用预览链接打开，逐项验证：工作模式切换、场景胶囊点击、
专家/Skill 是否生效、连接器工具能否调用。**提交审核前务必过一遍。**

## 已决策事项（本次）

1. **跳过首次绑定授权** —— 无 OAuth 内置连接器。
2. **不开精选场景** —— 省去 1000×910 日夜两套背景图。
3. 连接器走「市场配置引用」而非「内置连接器」，等审核结果。

## 依赖关系

```
连接器审核通过  →  可在模块3「连接器」板块引用（否则用户需自行从市场安装）
后续若做 OAuth  →  才能开「内置连接器」，届时需回头填模块1的授权三项
```

## 后续更新

已发布应用如需变更，修改后**需重新提交审核**。

## 安全约定

- `credentials.local.md` 是本目录唯一存放平台凭据的文件，已被 `.gitignore` 排除。
- **禁止**把 Client ID / Client Secret 写入 `app-profile.md`、本 README、commit message、
  文档或截图。仓库中若出现明文凭据，视为事故，需到平台重置 Secret。
