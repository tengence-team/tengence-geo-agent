# Tengence GEO Agent

GEO/SEO content production & publishing engine — full-pipeline automation from
**content planning → writing & ingest → gate checks → WordPress publishing →
search submission → GEO monitoring**. Three usage modes: **CLI / MCP (AI clients) /
built-in agent runtime loop**. Default storage is a single-file multi-tenant SQLite
(auto-initialized) with optional MySQL; designed for open source and multi-site use.

```
  AI clients (any MCP-capable harness)
        │  MCP (stdio or Streamable HTTP + Bearer)
        ▼
  @tengence/geo-mcp     29 tools (workspace/site/article/check/publish/plan/image/monitor/db/search/diagnose/util/standards)
        ▼
  @tengence/geo-cli     21 tengence-geo-* commands
        ▼
  @tengence/geo-sdk     15-domain capability layer (site/db/wp/content/images/search/…)
        ▼
  SQLite (auto-init)  or  MySQL (tengence_geo_*, isolated from prod tengence_omni_*)
```

## Packages (monorepo)

| Package | Form | Description |
| --- | --- | --- |
| `@tengence/geo-sdk` | Library | 15-domain capability layer, lazy-loaded, single require entry |
| `@tengence/geo-cli` | CLI | 21 bins (ingest / gate / publish / images / submission / monitor / plan) |
| `@tengence/geo-mcp` | MCP Server | 29 tools, stdio + HTTP dual transport, Bearer auth |
| `@tengence/geo-agent` | Agent launcher | Runs once `DEEPSEEK_API_KEY` is set (HARNESS=dsh\|opencode\|pi) |

## Quick start

```bash
npm install
cp -R examples/site-template ~/tengence/sites/my-site
cd ~/tengence/sites/my-site && cp .env.example .env   # fill in WP credentials / tokens

# Full CLI pipeline
export SITES_ROOT=~/tengence/sites
tengence-geo-article-ingest hello-geo ./hello-geo.md --site my-site --research ./hello-geo.research.md
tengence-geo-check-article hello-geo --site my-site

# MCP (any MCP-capable client; see docs/mcp-platforms.md)
node packages/geo-mcp/bin/geo-mcp.js                          # stdio
GEO_MCP_TOKEN=sk-xxx node packages/geo-mcp/bin/geo-mcp-http.js  # HTTP

# Agent (runs once the API key is set)
export DEEPSEEK_API_KEY=sk-xxx
npx -y @tengence/geo-agent
```

Full onboarding: [docs/getting-started.md](docs/getting-started.md).

## Documentation

- [Architecture & design decisions](docs/architecture.md) (layering / multi-tenancy / init model / why MCP bridging)
- [Generic writing & GEO standards](packages/geo-sdk/standards/INDEX.md) — shipped in `@tengence/geo-sdk`, consumed via the `standards_list` / `standards_read` / `article_draft` MCP tools (the requirements an article must satisfy)
- [Getting started](docs/getting-started.md)
- [MCP integration (stdio / HTTP, any client)](docs/mcp-platforms.md)
- [Release & distribution (npm / Docker)](docs/release.md)

## Development & verification

```bash
npm run build          # workspace consistency check
npm test               # 138 tests (all green on SQLite)
npm run geo:sdk-smoke  # SDK smoke test
```

## Security boundaries

- Secrets live only in `SITES_ROOT/<site>/.env` (gitignored); the repo ships only the `.env.example` template.
- The production MySQL (`tengence_omni_*`) is never written by this repo; the new repo uniformly uses `tengence_geo_*`.
- The MCP HTTP transport requires `GEO_MCP_TOKEN` (Bearer).

## License

MIT
