#!/usr/bin/env node
/**
 * Database initialization script (dual driver)
 * Usage: tengence-geo db-init.js [--drop] [--site <key>]
 *
 * - DB_DRIVER=sqlite (default): auto-initializes ~/.tengence/geo.sqlite (or DB_PATH).
 *   SQLite normally lazy-creates tables on first touch; this command is for explicit
 *   init / diagnostics / --drop rebuild.
 * - DB_DRIVER=mysql: runs the MySQL DDL (INFORMATION_SCHEMA idempotent column backfill
 *   + table-list verification).
 */

const t = require('@tengence/geo-sdk');

// Load site config (--site <key>): reads DB credentials / APP_ID from <site>/.env
const SITE = t.site.loadSite();

const APP_ID = parseInt(process.env.APP_ID || '1');
const DRIVER = t.db.driver();

async function initSqlite({ shouldDrop }) {
  console.log('Database config:');
  console.log(`  Driver: sqlite`);
  console.log(`  DB path: ${t.db.sqliteDbStatus().dbPath}`);
  console.log(`  App ID: ${APP_ID}\n`);

  if (shouldDrop) {
    console.log('Rebuilding SQLite (delete the existing file, then auto-init)...');
    const sqlite = require('@tengence/geo-sdk/db/sqlite');
    const fs = require('fs');
    sqlite.resetDb();
    const p = sqlite.resolveDbPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    sqlite.getDb();
    console.log('✓ rebuilt\n');
  } else {
    console.log('Initializing (idempotent: skips when already present)...');
    const st = t.db.sqliteDbStatus();
    console.log(`  user_version=${st.schemaVersion}, ${st.tableCount} tables\n`);
  }

  const st = t.db.sqliteDbStatus();
  console.log(`✓ SQLite ready: ${st.dbPath}`);
  console.log(`  version ${st.schemaVersion}, ${st.tableCount} tables:`);
  for (const name of st.tables) console.log(`  · ${name}`);
}

async function initMysql({ shouldDrop }) {
  const dbConfig = t.db.configFromEnv({ multipleStatements: true });
  if (!dbConfig.host || !dbConfig.user || !dbConfig.password || !dbConfig.database) {
    console.error(`✗ Missing database credentials: set DB_HOST / DB_USER / DB_PASSWORD / DB_DATABASE in ${SITE.siteDir}/.env`);
    process.exit(1);
  }

  console.log('Database config:');
  console.log(`  Driver: mysql`);
  console.log(`  Host: ${dbConfig.host}`);
  console.log(`  Port: ${dbConfig.port}`);
  console.log(`  Database: ${dbConfig.database}`);
  console.log(`  App ID: ${APP_ID}\n`);

  const connection = await t.db.createConnection({ multipleStatements: true });
  console.log('✓ connected\n');
  try {
    if (shouldDrop) {
      console.log('Dropping existing tables...');
      await connection.query(t.db.dropTablesSQL);
      console.log('✓ tables dropped\n');
    }

    console.log('Creating tables...');
    await connection.query(t.db.createTablesSQL);
    console.log('✓ tables created\n');

    // Idempotent column backfill: add entity_match to the monitor tables that already
    // exist in the production DB
    const { TABLES } = t.db;
    const alterPairs = [
      [TABLES.geoMonitorResults, 'entity_match'],
    ];
    for (const [table, col] of alterPairs) {
      const [[colRow]] = await connection.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [dbConfig.database, table, col]
      );
      if (!colRow) {
        console.log(`Adding column ${table}.${col} ...`);
        await connection.query(
          `ALTER TABLE ${table} ADD COLUMN ${col} VARCHAR(10) NOT NULL DEFAULT 'none' COMMENT 'entity disambiguation: ours/ambiguous/none'`
        );
        console.log(`✓ ${table}.${col} added\n`);
      }
    }

    // Verify tables: confirm every table this script owns exists
    console.log('Verifying table structure...');
    const [rows] = await connection.query(
      `SELECT TABLE_NAME
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME LIKE 'tengence_geo_%'
       ORDER BY TABLE_NAME`,
      [dbConfig.database]
    );

    const existing = new Set(rows.map((r) => r.TABLE_NAME));
    const expected = t.db.CREATED_BY_DB_INIT;
    const missing = expected.filter((n) => !existing.has(n));
    const extra = rows.map((r) => r.TABLE_NAME).filter((n) => !expected.includes(n));

    console.log(`\nTables owned by this script (${expected.length}):`);
    for (const name of expected) console.log(`  ${existing.has(name) ? '✓' : '✗'} ${name}`);

    if (extra.length) {
      console.log(`\n${extra.length} platform-side tables also present (not created by this script, kept):`);
      for (const name of extra) console.log(`  · ${name}`);
    }

    if (missing.length === 0) {
      console.log('\n✓ All tables created!');
    } else {
      console.log(`\n⚠ Missing ${missing.length} tables: ${missing.join(', ')}`);
    }
  } finally {
    await connection.end();
  }
}

async function main() {
  const { flags } = t.cli.args.parse({ drop: { type: 'boolean', alias: ['d'] } });
  try {
    if (DRIVER === 'sqlite') {
      await initSqlite({ shouldDrop: flags.drop });
    } else {
      await initMysql({ shouldDrop: flags.drop });
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
