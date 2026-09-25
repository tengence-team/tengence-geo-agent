'use strict';
/**
 * External-platform taxonomy dictionary repository (db domain)
 * — table tengence_geo_channel_taxonomy
 * ============================================================================
 * Stores the EXTERNAL platform's own taxonomy (category / tag id + name), e.g.
 * Juejin's 8 categories and ~725 tags. This is PLATFORM-scoped, not site-scoped:
 * every site publishing to the platform shares one copy, so no site needs its own
 * taxonomy mapping file (the portability requirement).
 *
 * This table is WORKSPACE-LOCAL state only (never part of the MySQL production
 * schema); see db/sqlite-schema.js. Raw SQL against it is forbidden elsewhere.
 *
 * Lookup shapes and the index that serves each (see the DDL comment for evidence):
 *   findByName     name = ? COLLATE NOCASE          → idx_channel_taxonomy_name
 *   findByPrefix   name LIKE ? ('kw%')              → idx_channel_taxonomy_name
 *   list           ORDER BY name COLLATE NOCASE     → idx_channel_taxonomy_name
 *   findByExternalId / upsert                       → UNIQUE (app,platform,kind,external_id)
 * Infix ("contains") matching is intentionally NOT offered here: no index can serve
 * it, and the resolver does it in memory over the small dictionary.
 * ============================================================================
 */

const { CHANNEL_TAXONOMY } = require('./sqlite-schema');

const KINDS = ['category', 'tag'];

/** Normalize a row (decode the JSON extra column). */
function normalizeRow(row) {
  if (!row) return null;
  let extra = row.extra;
  if (typeof extra === 'string' && extra) {
    try {
      extra = JSON.parse(extra);
    } catch (e) {
      extra = null;
    }
  }
  return { ...row, extra: extra && typeof extra === 'object' ? extra : null };
}

/** Guard: only the two known kinds reach the SQL layer. */
function assertKind(kind) {
  if (!KINDS.includes(kind)) {
    throw new Error(`Invalid taxonomy kind "${kind}" (allowed: ${KINDS.join(', ')})`);
  }
}

/**
 * List dictionary rows (optional kind filter), name-ordered.
 * ORDER BY name COLLATE NOCASE reuses idx_channel_taxonomy_name (no temp b-tree).
 * @param {object} filters { platform, kind, limit }
 */
async function list(conn, appId, filters = {}) {
  if (filters.kind) assertKind(filters.kind);
  let sql = `SELECT * FROM ${CHANNEL_TAXONOMY} WHERE app_id = ? AND platform = ?`;
  const params = [appId, filters.platform || 'juejin'];
  if (filters.kind) {
    sql += ' AND kind = ?';
    params.push(filters.kind);
  }
  sql += ' ORDER BY name COLLATE NOCASE ASC';
  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }
  const [rows] = await conn.query(sql, params);
  return rows.map(normalizeRow);
}

/** Count rows for a platform (optionally one kind) — drives the "is the cache empty" check. */
async function count(conn, appId, platform, kind) {
  if (kind) assertKind(kind);
  let sql = `SELECT COUNT(*) AS c FROM ${CHANNEL_TAXONOMY} WHERE app_id = ? AND platform = ?`;
  const params = [appId, platform];
  if (kind) {
    sql += ' AND kind = ?';
    params.push(kind);
  }
  const [rows] = await conn.query(sql, params);
  return Number((rows[0] || {}).c || 0);
}

/**
 * Exact name lookup, case-insensitive. The explicit COLLATE NOCASE on the
 * comparison is required for the name key of idx_channel_taxonomy_name to be used
 * (a BINARY comparison against a NOCASE index degrades to a range scan).
 */
async function findByName(conn, appId, platform, kind, name) {
  assertKind(kind);
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_TAXONOMY}
      WHERE app_id = ? AND platform = ? AND kind = ? AND name = ? COLLATE NOCASE
      LIMIT 1`,
    [appId, platform, kind, String(name || '')]
  );
  return normalizeRow(rows[0] || null);
}

/** Direct lookup by the platform's own id (the upsert key). */
async function findByExternalId(conn, appId, platform, kind, externalId) {
  assertKind(kind);
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_TAXONOMY}
      WHERE app_id = ? AND platform = ? AND kind = ? AND external_id = ?
      LIMIT 1`,
    [appId, platform, kind, String(externalId)]
  );
  return normalizeRow(rows[0] || null);
}

/**
 * Prefix search by name (index-accelerated). Pass a bare prefix, not a pattern —
 * the '%' is appended here so the query keeps the prefix-LIKE optimization.
 * NOTE: only PREFIX matches can use an index; use the resolver's in-memory
 * matching for infix/contains semantics.
 */
async function findByPrefix(conn, appId, platform, kind, prefix, limit = 20) {
  assertKind(kind);
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_TAXONOMY}
      WHERE app_id = ? AND platform = ? AND kind = ? AND name LIKE ?
      ORDER BY name COLLATE NOCASE ASC
      LIMIT ?`,
    [appId, platform, kind, `${String(prefix || '')}%`, limit]
  );
  return rows.map(normalizeRow);
}

/** First row in name order — the last-resort fallback when nothing else resolves. */
async function firstByName(conn, appId, platform, kind) {
  assertKind(kind);
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_TAXONOMY}
      WHERE app_id = ? AND platform = ? AND kind = ?
      ORDER BY name COLLATE NOCASE ASC LIMIT 1`,
    [appId, platform, kind]
  );
  return normalizeRow(rows[0] || null);
}

/**
 * Upsert a batch of dictionary rows keyed by (app_id, platform, kind, external_id).
 * Portable SQL (INSERT/UPDATE only, no dialect-specific upsert clause), executed
 * inside one transaction so a sync is all-or-nothing.
 * @param {Array<{external_id:string, name:string, parent_id?:string, extra?:object}>} items
 * @returns {Promise<{inserted:number, updated:number}>}
 */
async function upsertMany(conn, appId, platform, kind, items, syncedAt) {
  assertKind(kind);
  const list_ = Array.isArray(items) ? items.filter((i) => i && i.external_id && i.name) : [];
  if (!list_.length) return { inserted: 0, updated: 0 };

  // preload existing ids in one query (avoids N point lookups)
  const [existingRows] = await conn.query(
    `SELECT id, external_id FROM ${CHANNEL_TAXONOMY} WHERE app_id = ? AND platform = ? AND kind = ?`,
    [appId, platform, kind]
  );
  const idByExt = new Map(existingRows.map((r) => [String(r.external_id), r.id]));

  let inserted = 0;
  let updated = 0;
  await conn.beginTransaction();
  try {
    for (const item of list_) {
      const extraJson = item.extra ? JSON.stringify(item.extra) : null;
      const parentId = item.parent_id != null ? String(item.parent_id) : null;
      const existingId = idByExt.get(String(item.external_id));
      if (existingId) {
        await conn.query(
          `UPDATE ${CHANNEL_TAXONOMY}
              SET name = ?, parent_id = ?, extra = ?, synced_at = ?, updated_at = NOW()
            WHERE app_id = ? AND id = ?`,
          [item.name, parentId, extraJson, syncedAt || null, appId, existingId]
        );
        updated += 1;
      } else {
        await conn.query(
          `INSERT INTO ${CHANNEL_TAXONOMY}
             (app_id, platform, kind, external_id, name, parent_id, extra, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [appId, platform, kind, String(item.external_id), item.name, parentId, extraJson, syncedAt || null]
        );
        inserted += 1;
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  }
  return { inserted, updated };
}

/** Drop every row for a platform (full refresh / teardown). */
async function removePlatform(conn, appId, platform) {
  const [result] = await conn.query(
    `DELETE FROM ${CHANNEL_TAXONOMY} WHERE app_id = ? AND platform = ?`,
    [appId, platform]
  );
  return result.affectedRows || 0;
}

module.exports = {
  KINDS,
  list,
  count,
  findByName,
  findByExternalId,
  findByPrefix,
  firstByName,
  upsertMany,
  removePlatform,
};
