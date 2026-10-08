# Environment & Configuration Reference

> English version. For 中文版 see [environment.zh.md](environment.zh.md).
>
> Authoritative sources: `packages/geo-sdk/paths.js`, `packages/geo-mcp/README.md`, and
> the site template `examples/site-template/.env.example`.

## Runtime & storage

| Variable | Description | Req. | Default |
| --- | --- | --- | --- |
| `SITES_ROOT` | Root directory holding every site's `config/` and `.env` | no | — |
| `TENGENCE_GEO_HOME` | Internal runtime data directory | no | `~/.tengence/geo-mcp` |
| `GEO_HOME` | Legacy alias of `TENGENCE_GEO_HOME` (kept until 0.2.0) | no | — |
| `DB_DRIVER` | `sqlite` (default) \| `mysql` | no | `sqlite` |
| `DB_PATH` | SQLite file path (`~` expanded) | no | `$TENGENCE_GEO_HOME/geo.sqlite` |
| `GEO_SQLITE_DRIVER` | `builtin` \| `native`: explicit SQLite driver (testing/debug) | no | auto (builtin preferred) |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | MySQL connection (when `DB_DRIVER=mysql`) | no | — |
| `APP_ID` | Tenant ID; SQLite single-file multi-tenancy & MySQL both isolate by `app_id` | no | `1` |
| `HTTPS_PROXY` / `NO_PROXY` | HTTP(S) proxy (GSC etc. needs a proxy on CN networks) | no | — |
| `DEBUG` / `GEO_DEBUG_DRAFT` | Debug logging switches | no | — |

## MCP transport

| Variable | Description | Req. | Default |
| --- | --- | --- | --- |
| `GEO_MCP_PORT` | HTTP-mode listen port | no | `8787` |
| `GEO_MCP_TOKEN` | HTTP-mode Bearer token; when unset, no auth (local debug only) | no | empty |

Transport: **stdio** (local client) or **Streamable HTTP** (remote/self-host, static
Bearer auth, single-user; multi-tenant public hosting needs the auth layer to be
completed). Base URL = `http://127.0.0.1:<port>/`, header `Authorization: Bearer <token>`.

## WordPress (per-site `.env`)

| Variable | Description |
| --- | --- |
| `WP_URL` | WordPress site URL |
| `WP_API_URL` | WP REST API base (optional; derived from `WP_URL` when absent) |
| `WP_USERNAME` / `WP_PASSWORD` | WP application credentials (REST auth) |
| `WP_ORIGIN_HOST` | Allowed origin host for plugin endpoints (optional) |

## Search inclusion (per-site `.env`, optional — missing values soft-fail without blocking publishing)

| Variable | Description |
| --- | --- |
| `GOOGLE_SA_JSON` | Absolute path to the GSC service-account JSON |
| `GSC_SITEMAP_URL` | GSC sitemap URL (optional; auto-derived) |
| `GOOGLE_INDEXING_API_ENABLED` | Enable the Google Indexing API (optional) |
| `BING_WEBMASTER_API_KEY` | Bing Webmaster API key |
| `BING_WEBMASTER_SITE_URL` | Bing Webmaster site URL (optional override) |
| `INDEXNOW_KEY` / `INDEXNOW_KEY_LOCATION` / `INDEXNOW_HOST` | IndexNow key, key-file location, and host |
| `BAIDU_TOKEN` / `BAIDU_SITE` | Baidu normal-inclusion token and site |

> Note: Bing trimmed its JSON API on 2026-08-31.

## Image pipeline (per-site `.env`, optional)

| Variable | Description |
| --- | --- |
| `PEXELS_API_KEY` | Pexels stock API key |
| `PIXABAY_API_KEY` | Pixabay stock API key |
| `UNSPLASH_ACCESS_KEY` / `UNSPLASH_APP_ID` / `UNSPLASH_SECRET_KEY` | Unsplash API keys |
| `IMAGE_FORMAT` | Output image format (default WebP) |
| `IMAGE_CANDIDATE_POOL` | Candidate pool size for search |
| `IMAGE_API_TIMEOUT` / `IMAGE_DL_TIMEOUT` | API / download timeouts (ms) |

## Syndication platforms (per-site `.env`, optional)

| Variable | Description |
| --- | --- |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | WeChat official-account credentials (outbound IP must be whitelisted) |
| `JUEJIN_COOKIE` / `JUEJIN_UID` / `JUEJIN_AID` | Juejin cookie / uid / aid |
| `JUEJIN_CATEGORY_ID` / `JUEJIN_TAG_ID` | Juejin default category / tag ids |
| `CSDN_COOKIE` / `CSDN_USERNAME` | CSDN cookie and username |
| `CSDN_TAGS` / `CSDN_CREATION_STATEMENT` / `CSDN_SOURCE` | CSDN default tags / creation statement / source |
| `DEVTO_API_KEY` | Dev.to API key |
| `TENCENT_COOKIE` / `TENCENT_SOURCE_TYPE` | Tencent cloud community cookie / source type |
| `TENCENT_CLASSIFY_IDS` / `TENCENT_COLUMN_IDS` / `TENCENT_TAG_IDS` | Tencent community classify / column / tag ids |
| `ALIYUN_COOKIE` / `ALIYUN_ARTICLE_TYPE` | Aliyun developer community cookie / article type |

## Tengence plugin endpoints (per-site `.env`)

| Variable | Description |
| --- | --- |
| `TENGENCE_SITE_ID` / `TENGENCE_SECRET` | Credentials driving the plugin term-name / author-name endpoints |
| `TENGENCE_API_URL` | Plugin API base (optional override) |
| `SITE_DOMAIN` | Site domain override (optional) |

## Agent runtime (harness)

| Variable | Description |
| --- | --- |
| `HARNESS` | Agent runtime loop: `dsh` \| `opencode` \| `pi` |
| `DEEPSEEK_API_KEY` | LLM API key used by the agent runtime loop |

## How `.env` is loaded

- **Global runtime vars** are read from the process environment.
- **Per-site secrets** live only in `<workspace>/<site>/.env` (gitignored). The SDK
  loads the site's `.env` when resolving a site, so never commit secrets.
- All internal paths derive from `TENGENCE_GEO_HOME` (single source of truth).
