# Release & Distribution (npm / Docker)

## Conclusion: prefer npm package distribution; Docker is an optional supplement

This repository is a monorepo (4 workspace packages). **The recommended default
distribution form is npm registry packages**:

- Consumers use `npm i -D @tengence/geo-cli` or `npx -y @tengence/geo-mcp` directly — no
  source build needed;
- MCP/CLI are "start-and-use" runtimes, not static packages — `npx` spawns the process and
  the MCP protocol drives it;
- Site data (`SITES_ROOT`) lives on the consumer's machine, a natural fit for
  "npm package + the user's own site directories".

## 1. Publishing to npm (per-package from the monorepo)

```bash
npm login

# publish per package (sdk first, then cli/mcp, agent last)
npm publish -w packages/geo-sdk
npm publish -w packages/geo-cli
npm publish -w packages/geo-mcp
npm publish -w apps/agent
```

Conventions:

- All versions start at `0.1.0`; bump per package with `npm version patch -w <pkg>`,
  keeping all 4 packages on the same version.
- The `files` field per package limits published content (geo-sdk: all source; geo-cli: bin/
  only; geo-mcp: bin + server + tools; geo-agent: launcher + presets). `data/`, `.env`,
  `examples/`, and `tests/` are **not** published.
- `@tengence/geo-mcp`'s `@modelcontextprotocol/sdk` is a runtime dependency (not peer) and
  installs with the package.

## 2. Consumer perspective (no source needed)

```bash
# CLI
npx -y @tengence/geo-cli tengence-geo-db-init --site my-site

# MCP (stdio — put in the command field of mcp.json)
"command": "npx", "args": ["-y", "@tengence/geo-mcp"]

# MCP (HTTP)
npx -y @tengence/geo-mcp-http

# Agent (runs once the API key is set)
npx -y @tengence/geo-agent
```

## 3. Docker (optional: for the remote HTTP form)

If you need to deploy the MCP service to an intranet/cloud (for Doubao Work connectors or
shared multi-tenant use), add a `Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci && npm run build
EXPOSE 8787
ENV DB_DRIVER=sqlite GEO_MCP_PORT=8787
# mount the site directory as a volume
VOLUME ["/sites"]
ENV SITES_ROOT=/sites
CMD ["node", "packages/geo-mcp/bin/geo-mcp-http.js"]
```

```bash
docker build -t tengence-geo-mcp .
docker run -d -p 8787:8787 \
  -e GEO_MCP_TOKEN=sk-geo-xxxx \
  -e DEEPSEEK_API_KEY=sk-xxx \
  -v ~/tengence/sites:/sites \
  tengence-geo-mcp
```

Key points:

- The site directory (`SITES_ROOT`) must be mounted into the container — it is runtime data
  (config + SQLite + workspace);
- Never bake any `.env` / tokens into the image (inject via `-e` or secrets);
- The Docker form only solves "remote deployment"; local use always goes through npm.

## 4. CI suggestions (to be added later)

- `npm ci && npm run build && npm test` (full SQLite regression)
- Semantic versioning + changeset auto-bump / CHANGELOG
- `npm publish` via GitHub Actions (`NODE_AUTH_TOKEN`)
- Optional: build and push a Docker image per tag to GHCR

## 5. Release checklist (before every release)

- [ ] `npm run build` passes (SDK domains / CLI bins / MCP tools / launcher consistency)
- [ ] `npm test` — all 116 tests green
- [ ] `git tag v0.1.x && git push --tags`
- [ ] Publish the 4 packages in order sdk → cli → mcp → agent
- [ ] Smoke-test stdio and HTTP once each with `npx -y @tengence/geo-mcp`
