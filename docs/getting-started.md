# Getting Started

> Up and running in 5 minutes: copy the site template → initialize SQLite → complete the
> "ingest → gate" loop with the CLI or MCP.

## 0. Prerequisites

- Node.js ≥ 20 (verified during development on Node v22)
- Optional: a DeepSeek API key (required to run the `apps/agent` runtime loop)

```bash
git clone https://github.com/<org>/tengence-geo-agent.git
cd tengence-geo-agent
npm install
```

## 1. Create a site directory (runtime data, separate from code)

```bash
# Option A: copy the template to the SITES_ROOT convention
mkdir -p ~/tengence/sites
cp -R examples/site-template ~/tengence/sites/my-site
cd ~/tengence/sites/my-site
cp .env.example .env        # fill in WP credentials / submission tokens / image-library keys (do not commit)
```

Site directory layout:

```
~/tengence/sites/my-site/
├── .env                    # secrets (WP credentials / APP_ID / tokens)
├── config/
│   ├── site.yaml           # site identity (domain / languages / content dirs)
│   ├── wordpress.yaml      # publishing behavior
│   └── monitor.yaml        # GEO monitoring config
└── data/inbox/zh-CN/       # authoring workspace (md + research brief, auto-archived after ingest)
```

## 2. Initialize the database (SQLite is automatic, nothing to do)

With the default `DB_DRIVER=sqlite`, the first read/write automatically creates the file
(`~/.tengence/geo-mcp/geo.sqlite`) and all 16 tables. Optional explicit entry:

```bash
SITES_ROOT=~/tengence/sites tengence-geo-db-init --site my-site
#   → SQLite ready: version 1, 16 tables
```

## 3. Full CLI pipeline (ingest → gate)

```bash
cd ~/tengence/sites/my-site/data/inbox/zh-CN
# prepare the article body (md containing the "key takeaways / FAQ" blocks) + research brief

export SITES_ROOT=~/tengence/sites
tengence-geo-article-ingest hello-geo ./hello-geo.md --site my-site \
  --research ./hello-geo.research.md
tengence-geo-check-article hello-geo --site my-site      # gate: all ✅ before publishing
```

Publishing (requires WP credentials in the site `.env`; defaults to draft):

```bash
tengence-geo-publish-draft ./hello-geo.md --site my-site            # draft
tengence-geo-publish-from-db 1 --site my-site --status=publish      # publish directly
tengence-geo-promote-daily --site my-site                          # daily promotion
```

## 4. MCP integration (AI clients)

### stdio (any client that spawns a local process)

```json
{
  "mcpServers": {
    "tengence-geo": {
      "command": "node",
      "args": ["<absolute path to this repo>/packages/geo-mcp/bin/geo-mcp.js"]
    }
  }
}
```

No `env` is needed: internal data goes to `~/.tengence/geo-mcp/`, and the user workspace is
chosen at runtime via the `workspace_use` tool (remembered in `state.json` afterwards).

### HTTP (remote callers, Bearer-token protected)

```bash
GEO_MCP_PORT=8787 GEO_MCP_TOKEN=sk-xxx \
  node packages/geo-mcp/bin/geo-mcp-http.js
# health check GET / → { ok: true }
```

Platform-specific integration details: `docs/mcp-platforms.md`.

## 5. Set an API key and run the Agent directly (runtime loop)

```bash
export DEEPSEEK_API_KEY=sk-xxx
export SITES_ROOT=~/tengence/sites
npx -y @tengence/geo-agent              # HARNESS=dsh (DeepSeek Harness)
HARNESS=opencode npx -y @tengence/geo-agent
HARNESS=pi npx -y @tengence/geo-agent
```

## 6. Regression verification (development / CI)

```bash
npm run build          # workspace consistency check (SDK domains / CLI bins / MCP tools / launcher)
npm test               # 116 tests (all green on SQLite)
npm run geo:sdk-smoke  # SDK smoke test
```

## 7. Connecting an existing MySQL business database (optional)

```bash
export DB_DRIVER=mysql
# the site .env provides DB_HOST / DB_USER / DB_PASSWORD / DB_DATABASE
tengence-geo-db-init --site my-site    # creates tengence_geo_* tables (leaves tengence_omni_* untouched)
```

> ⚠️ Production DB is read-only by reference: this repo's table names are physically
> isolated from the production `tengence_omni_*`; migrate by explicit export then import.
