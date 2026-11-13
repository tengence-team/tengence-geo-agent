/**
 * channel-state / repo — the ONLY place allowed to touch tengence_geo_channel_plan.status
 * ============================================================================
 * C I rule: `markStatus` may be called from here and nowhere else in packages/.
 * A guard test enforces it (tests/status-single-entry.test.js).
 *
 * Everything below just forwards to db/channel-plan.js with the caller's connection;
 * no business rules live here (they live in states.js and index.js).
 * ============================================================================
 */

const rowRepo = require('../db/channel-plan');

async function selectOne(conn, appId, id) {
  return rowRepo.getById(conn, appId, Number(id));
}

async function selectByKey(conn, appId, platform, slug, lang) {
  return rowRepo.getByKey(conn, appId, platform, slug, lang);
}

async function selectList(conn, appId, filters = {}) {
  return rowRepo.list(conn, appId, filters);
}

/** Raw status write — status + optional draft ids in one statement. */
async function writeStatus(conn, appId, id, status, draftIds) {
  return rowRepo.markStatus(conn, appId, Number(id), status, draftIds);
}

async function writeArticleId(conn, appId, id, articleId) {
  return rowRepo.setArticleId(conn, appId, Number(id), articleId);
}

async function writeNotes(conn, appId, id, note) {
  return rowRepo.appendNotes(conn, appId, Number(id), note);
}

/** Create-or-update non-status fields. `status` is stripped — see index.record(). */
async function writeRow(conn, appId, row) {
  return rowRepo.upsert(conn, appId, row);
}

module.exports = { selectOne, selectByKey, selectList, writeStatus, writeArticleId, writeNotes, writeRow };
