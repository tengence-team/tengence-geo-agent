/**
 * Database domain entry (tengence-geo-sdk/db)
 * ============================================================================
 * Aggregates "connection + table names/DDL + repositories":
 *   connection  withConn / createConnection / configFromEnv (the single place to open connections)
 *   schema      TABLES table-name constants + create/drop DDL
 *   articles    main article table read/write
 *   config      article config (SEO/GEO metadata source of truth)
 *   terms       category/tag terms and article-assignment registration
 *   images      image dedupe & registration (reuses the images domain)
 *
 * Usage:
 *   const t = require('../tengence-geo-sdk');
 *   await t.db.withConn(async (conn) => {
 *     const article = await t.db.articles.getById(conn, 318, 1);
 *   });
 * ============================================================================
 */

const schema = require('./schema');
const connection = require('./connection');
const sqlite = require('./sqlite');

module.exports = {
  schema,
  PREFIX: schema.PREFIX,
  TABLES: schema.TABLES,
  CREATED_BY_DB_INIT: schema.CREATED_BY_DB_INIT,
  MISSING_IN_DB_INIT: schema.MISSING_IN_DB_INIT,
  createTablesSQL: schema.createTablesSQL,
  dropTablesSQL: schema.dropTablesSQL,
  /** Dual driver: driver() / createConnection / withConn / configFromEnv (DB_DRIVER=sqlite|mysql) */
  driver: connection.driver,
  configFromEnv: connection.configFromEnv,
  createConnection: connection.createConnection,
  withConn: connection.withConn,
  /** SQLite-specific: idempotent init / status / dialect translation (not loaded in mysql mode) */
  sqliteSchemaVersion: sqlite.SCHEMA_VERSION,
  ensureSqliteSchema: sqlite.ensureSchema,
  sqliteDbStatus: sqlite.dbStatus,
  translateSql: sqlite.translateSql,
  articles: require('./articles'),
  config: require('./config'),
  terms: require('./terms'),
  /** External-platform taxonomy dictionary (category/tag id+name cache, e.g. juejin) */
  channelTaxonomy: require('./channel-taxonomy'),
  /** JSON column / JSON-string tolerant parsing (single source, converged in batch 6) */
  value: require('./value'),
  /** Image repository (all capabilities moved from the business repo) */
  images: require('../images'),
};
