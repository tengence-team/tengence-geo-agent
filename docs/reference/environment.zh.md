# 环境变量与配置参考

> 中文版。英文版见 [environment.en.md](environment.en.md)。
>
> 权威来源：`packages/geo-sdk/paths.js`、`packages/geo-mcp/README.md`、站点模板 `examples/site-template/.env.example`。

## 运行时与存储

| 变量 | 说明 | 必填 | 默认 |
| --- | --- | --- | --- |
| `SITES_ROOT` | 存放各站点 `config/` 与 `.env` 的根目录 | 否 | — |
| `TENGENCE_GEO_HOME` | 内部运行时数据目录 | 否 | `~/.tengence/geo-mcp` |
| `GEO_HOME` | `TENGENCE_GEO_HOME` 的旧别名（保留至 0.2.0） | 否 | — |
| `DB_DRIVER` | `sqlite`（默认）\| `mysql` | 否 | `sqlite` |
| `DB_PATH` | SQLite 文件路径（`~` 展开） | 否 | `$TENGENCE_GEO_HOME/geo.sqlite` |
| `GEO_SQLITE_DRIVER` | `builtin` \| `native`：显式选择 SQLite 驱动（测试/排错用） | 否 | 自动（优先 builtin） |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | MySQL 连接（`DB_DRIVER=mysql` 时） | 否 | — |
| `APP_ID` | 租户 ID；SQLite 单文件多租户与 MySQL 都按 `app_id` 隔离 | 否 | `1` |
| `HTTPS_PROXY` / `NO_PROXY` | HTTP(S) 代理（GSC 等在 CN 网络需代理） | 否 | — |
| `DEBUG` / `GEO_DEBUG_DRAFT` | 调试日志开关 | 否 | — |

## MCP 传输

| 变量 | 说明 | 必填 | 默认 |
| --- | --- | --- | --- |
| `GEO_MCP_PORT` | HTTP 模式监听端口 | 否 | `8787` |
| `GEO_MCP_TOKEN` | HTTP 模式 Bearer 令牌；未设置则无鉴权（仅本地调试） | 否 | 空 |

传输：**stdio**（本地客户端）或 **Streamable HTTP**（远程/自托管，静态 Bearer 鉴权，单用户；多租户公开托管需等鉴权层补齐）。Base URL = `http://127.0.0.1:<port>/`，请求头 `Authorization: Bearer <token>`。

## WordPress（每站点 `.env`）

| 变量 | 说明 |
| --- | --- |
| `WP_URL` | WordPress 站点 URL |
| `WP_API_URL` | WP REST API 基址（可选；缺省时从 `WP_URL` 推导） |
| `WP_USERNAME` / `WP_PASSWORD` | WP 应用凭据（REST 鉴权） |
| `WP_ORIGIN_HOST` | 插件端点的允许来源 host（可选） |

## 搜索引擎收录（每站点 `.env`，可选——缺失值软失败，不阻塞发布）

| 变量 | 说明 |
| --- | --- |
| `GOOGLE_SA_JSON` | GSC 服务账号 JSON 的绝对路径 |
| `GSC_SITEMAP_URL` | GSC sitemap URL（可选；自动推导） |
| `GOOGLE_INDEXING_API_ENABLED` | 启用 Google Indexing API（可选） |
| `BING_WEBMASTER_API_KEY` | Bing Webmaster API key |
| `BING_WEBMASTER_SITE_URL` | Bing Webmaster 站点 URL（可选覆盖） |
| `INDEXNOW_KEY` / `INDEXNOW_KEY_LOCATION` / `INDEXNOW_HOST` | IndexNow 密钥、密钥文件位置、host |
| `BAIDU_TOKEN` / `BAIDU_SITE` | 百度普通收录令牌与站点 |

> 注意：Bing 于 2026-08-31 缩减了其 JSON API。

## 图片流水线（每站点 `.env`，可选）

| 变量 | 说明 |
| --- | --- |
| `PEXELS_API_KEY` | Pexels 图库 API key |
| `PIXABAY_API_KEY` | Pixabay 图库 API key |
| `UNSPLASH_ACCESS_KEY` / `UNSPLASH_APP_ID` / `UNSPLASH_SECRET_KEY` | Unsplash API keys |
| `IMAGE_FORMAT` | 输出图片格式（默认 WebP） |
| `IMAGE_CANDIDATE_POOL` | 检索候选池大小 |
| `IMAGE_API_TIMEOUT` / `IMAGE_DL_TIMEOUT` | API / 下载超时（ms） |

## 分发平台（每站点 `.env`，可选）

| 变量 | 说明 |
| --- | --- |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 微信公众号凭据（出口 IP 需加白） |
| `JUEJIN_COOKIE` / `JUEJIN_UID` / `JUEJIN_AID` | 掘金 cookie / uid / aid |
| `JUEJIN_CATEGORY_ID` / `JUEJIN_TAG_ID` | 掘金默认分类 / 标签 id |
| `CSDN_COOKIE` / `CSDN_USERNAME` | CSDN cookie 与用户名 |
| `CSDN_TAGS` / `CSDN_CREATION_STATEMENT` / `CSDN_SOURCE` | CSDN 默认标签 / 创作声明 / 来源 |
| `DEVTO_API_KEY` | Dev.to API key |
| `TENCENT_COOKIE` / `TENCENT_SOURCE_TYPE` | 腾讯云社区 cookie / 来源类型 |
| `TENCENT_CLASSIFY_IDS` / `TENCENT_COLUMN_IDS` / `TENCENT_TAG_IDS` | 腾讯社区分类 / 专栏 / 标签 id |
| `ALIYUN_COOKIE` / `ALIYUN_ARTICLE_TYPE` | 阿里云开发者社区 cookie / 文章类型 |

## Tengence 插件端点（每站点 `.env`）

| 变量 | 说明 |
| --- | --- |
| `TENGENCE_SITE_ID` / `TENGENCE_SECRET` | 驱动插件术语名 / 作者名端点的凭据 |
| `TENGENCE_API_URL` | 插件 API 基址（可选覆盖） |
| `SITE_DOMAIN` | 站点域名覆盖（可选） |

## Agent 运行时（harness）

| 变量 | 说明 |
| --- | --- |
| `HARNESS` | Agent 运行时循环：`dsh` \| `opencode` \| `pi` |
| `DEEPSEEK_API_KEY` | Agent 运行时循环使用的 LLM API key |

## `.env` 如何加载

- **全局运行时变量**从进程环境读取。
- **每站点密钥**只存在于 `<workspace>/<site>/.env`（gitignore）。SDK 在解析站点时加载该站点的 `.env`，因此切勿提交密钥。
- 所有内部路径都从 `TENGENCE_GEO_HOME` 推导（唯一事实来源）。
