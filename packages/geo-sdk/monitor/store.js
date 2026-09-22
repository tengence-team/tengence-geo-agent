/**
 * Monitor result storage (monitor domain)
 * ============================================================================
 * Default storage is the DB (via t.db.withConn; run_id+model rows are deleted then
 * inserted → idempotent re-runs overwrite). The CLI passes store=noopStore and tests
 * pass a fake store, so the orchestration logic is verifiable without the DB.
 *
 * ⚠️ Repositories don't open connections (SDK convention): writeRun receives an
 *    external conn or borrows one via withConn — here the simplified
 *    "borrow inside the function via withConn" version is chosen, because callers
 *    (run.js/CLI) don't hold a connection anyway; unit tests bypass this file with
 *    an injected fake store.
 * ============================================================================
 */

const { withConn } = require('../db/connection');
const { TABLES } = require('../db/schema');

/** Current tenant (default 1): SQLite single-file multi-tenant isolation by app_id */
const APP_ID = parseInt(process.env.APP_ID || '1', 10);

/**
 * Persist one model's full answers and aggregated results for one run
 * @param {Object} arg
 * @param {string} arg.runId  YYYYMMDD
 * @param {string} arg.model  model key
 * @param {Array}  arg.answers  [{modelVersion,promptId,layer,variant,attempt,question,text,promptTokens,completionTokens}]
 * @param {Array}  arg.results  [{promptId,layer,mentioned,mentionType,position,sentiment,citedTengence,citedAny,accuracy,score,competitors,flags}]
 */
async function writeRun({ runId, model, answers, results }) {
  return withConn(async (conn) => {
    await conn.query(
      `DELETE FROM ${TABLES.geoMonitorAnswers} WHERE app_id = ? AND run_id = ? AND model = ?`,
      [APP_ID, runId, model]
    );
    await conn.query(
      `DELETE FROM ${TABLES.geoMonitorResults} WHERE app_id = ? AND run_id = ? AND model = ?`,
      [APP_ID, runId, model]
    );

    for (const a of answers) {
      await conn.query(
        `INSERT INTO ${TABLES.geoMonitorAnswers}
         (app_id, run_id, model, model_version, prompt_id, layer, variant, attempt, question, answer_text, prompt_tokens, completion_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [APP_ID, runId, model, a.modelVersion || null, a.promptId, a.layer, a.variant, a.attempt, a.question, a.text, a.promptTokens || 0, a.completionTokens || 0]
      );
    }
    for (const r of results) {
      await conn.query(
        `INSERT INTO ${TABLES.geoMonitorResults}
         (app_id, run_id, model, prompt_id, layer, mentioned, entity_match, mention_type, \`position\`, sentiment,
          cited_tengence, cited_any, accuracy, score, competitors, flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [APP_ID, runId, model, r.promptId, r.layer, r.mentioned, r.entityMatch || 'none', r.mentionType, r.position, r.sentiment,
         r.citedTengence, r.citedAny, r.accuracy, r.score, JSON.stringify(r.competitors || []), JSON.stringify(r.flags || [])]
      );
    }
    return { answers: answers.length, results: results.length };
  });
}

/**
 * Idempotent clearing at the start of a model loop: delete the model's old data for
 * this run.
 * Works with writeQuestion incremental writes — each finished question appends one
 * row, so the whole run only needs a single clearing.
 */
async function beginModelRun({ runId, model }) {
  return withConn(async (conn) => {
    await conn.query(
      `DELETE FROM ${TABLES.geoMonitorAnswers} WHERE app_id = ? AND run_id = ? AND model = ?`,
      [APP_ID, runId, model]
    );
    await conn.query(
      `DELETE FROM ${TABLES.geoMonitorResults} WHERE app_id = ? AND run_id = ? AND model = ?`,
      [APP_ID, runId, model]
    );
  });
}

/**
 * Incremental persist: one question's (multi-attempt variants) answers + aggregated
 * result, written question by question.
 * @param {Object} arg {runId, model, answers:[{...}], result:{...}}
 */
async function writeQuestion({ runId, model, answers, result }) {
  return withConn(async (conn) => {
    // idempotent: delete this question's old rows first (both answers and result),
    // then insert. Avoids "DB error mid-write → question-level retry → re-INSERT hits
    // the unique key" Duplicate-entry issues.
    await conn.query(
      `DELETE FROM ${TABLES.geoMonitorAnswers} WHERE app_id = ? AND run_id = ? AND model = ? AND prompt_id = ?`,
      [APP_ID, runId, model, result.promptId]
    );
    await conn.query(
      `DELETE FROM ${TABLES.geoMonitorResults} WHERE app_id = ? AND run_id = ? AND model = ? AND prompt_id = ?`,
      [APP_ID, runId, model, result.promptId]
    );
    for (const a of answers) {
      await conn.query(
        `INSERT INTO ${TABLES.geoMonitorAnswers}
         (app_id, run_id, model, model_version, prompt_id, layer, variant, attempt, question, answer_text, prompt_tokens, completion_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [APP_ID, runId, model, a.modelVersion || null, a.promptId, a.layer, a.variant, a.attempt, a.question, a.text, a.promptTokens || 0, a.completionTokens || 0]
      );
    }
    await conn.query(
      `INSERT INTO ${TABLES.geoMonitorResults}
       (app_id, run_id, model, prompt_id, layer, mentioned, entity_match, mention_type, \`position\`, sentiment,
        cited_tengence, cited_any, accuracy, score, competitors, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [APP_ID, runId, model, result.promptId, result.layer, result.mentioned, result.entityMatch || 'none', result.mentionType, result.position, result.sentiment,
       result.citedTengence, result.citedAny, result.accuracy, result.score, JSON.stringify(result.competitors || []), JSON.stringify(result.flags || [])]
    );
    return { answers: answers.length, result: 1 };
  });
}

/** Read a run's (or the latest run's) aggregated results (for reporting) */
async function readResults({ runId } = {}) {
  return withConn(async (conn) => {
    let id = runId;
    if (!id) {
      const [rows] = await conn.query(
        `SELECT run_id FROM ${TABLES.geoMonitorResults} WHERE app_id = ? ORDER BY run_id DESC LIMIT 1`,
        [APP_ID]
      );
      if (rows.length === 0) return { runId: null, rows: [] };
      id = rows[0].run_id;
    }
    const [rows] = await conn.query(
      `SELECT * FROM ${TABLES.geoMonitorResults} WHERE app_id = ? AND run_id = ? ORDER BY model, layer, prompt_id`,
      [APP_ID, id]
    );
    return { runId: id, rows };
  });
}

/** noop storage: for --mock mode, returns empty writes */
const noopStore = {
  writeRun: async (arg) => ({ answers: arg.answers.length, results: arg.results.length }),
  readResults: async () => ({ runId: null, rows: [] }),
  readTokenTotals: async () => [],
};

/**
 * Read a run's per-model token-usage totals (SUM over the answers table).
 * @returns {Promise<Array<{model,promptTokens,completionTokens}>>}
 */
async function readTokenTotals({ runId } = {}) {
  return withConn(async (conn) => {
    const [rows] = await conn.query(
      `SELECT model, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens
       FROM ${TABLES.geoMonitorAnswers} WHERE app_id = ? AND run_id = ? GROUP BY model`,
      [APP_ID, runId]
    );
    return rows.map((r) => ({
      model: r.model,
      promptTokens: Number(r.prompt_tokens) || 0,
      completionTokens: Number(r.completion_tokens) || 0,
    }));
  });
}

module.exports = { writeRun, beginModelRun, writeQuestion, readResults, readTokenTotals, noopStore };
