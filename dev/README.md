# dev — Development Regression Baselines

A three-piece toolkit for "zero behavioral change" refactors. All three scripts are
**read-only**: they do not write to the database and do not modify any files.

| Script | Purpose | Command |
|---|---|---|
| `sdk-snapshot.js` | Captures an SDK behavior snapshot: exported symbols / types / **function arity** / pure-function outputs / `loadSite()` shape / WP upload target (credentials redacted) | `npm run sdk:snapshot > /tmp/before.json` |
| `sdk-require-probe.js` | Resolves every relative `require` under `packages/`, `apps/`, `dev/` and reports broken links | `npm run sdk:probe` |
| `sdk-smoke.js` | SDK entry smoke test + structural sanity assertions (all domain entries present, no legacy-name shells in the library) | `npm run sdk:smoke` |

## Typical usage (run once before and once after a change)

```bash
npm run sdk:snapshot > /tmp/before.json     # ① before the change
#   ... do the refactor ...
npm run sdk:snapshot > /tmp/after.json      # ② after the change
diff /tmp/before.json /tmp/after.json       # ③ expected: zero difference

npm run sdk:probe && npm run sdk:smoke      # ④ expected: exit code 0
```

> **This trio is "interface layer" evidence and cannot replace "logic layer" evidence.**
> If the same batch also sinks business logic, unit tests (`npm test`, see `tests/`) or
> end-to-end golden-sample diffs are also required.
> ⚠️ **"Newly added exports" in the snapshot are the expected result of an intentional
> change**: as long as the diff contains **only `+` lines and no `-` lines** (i.e. additive
> only), it passes; a `-` line means a symbol was removed or renamed.

## Three pitfalls already hit (do not revert)

1. **The probe must strip comments first**: `require(...)` examples in JSDoc are written for
   callers; without stripping they are misreported as broken links (8 false positives on the
   first run).
2. **The snapshot targets SDK implementation modules** (`site/config.js`, `images/index.js`,
   `wp/media.js`) — consumers require these paths directly; there is no compatibility layer.
3. **Re-baseline after every "intentional structural change"**: batch D renamed snapshot keys
   from old paths to SDK paths; the 2026-09-14 entry-layer refactor renamed `lib-*.js`
   to `sdk-*.js` / npm prefix `lib:` → `sdk:`; diffing against an old baseline only produces
   key-name noise.

## ⚠️ End-to-end "zero difference" does not always hold (measured this round)

Scripts like `image-acquire` that **depend on external image libraries** may return different
candidate sets between two runs for the same input (measured: "24 candidates, 17/18 passing
the filter" jumps back and forth between versions — and even the same version jumps when run
repeatedly). In that case do **not** use the entire output as the zero-difference criterion;
instead use:

- **Pure-function equivalence** (preferred): copy the pre-refactor implementation to `/tmp` as
  a reference and compare `sanitizeQuery` / `shortenQuery` / `redLineCheck` / `scoreCandidate` /
  `buildFileName` case by case with constructed inputs;
- **SQL / parameter-sequence comparison**: feed a stub `conn` and assert the emitted SQL and
  parameter sequences are byte-for-byte identical;
- **Key-result comparison**: e.g. "the selected image and its pHash" agree across all 12 runs
  (6 rounds × 2 versions interleaved).
