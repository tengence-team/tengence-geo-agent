/**
 * JSON column / JSON-string tolerant parsing (db domain)
 * ============================================================================
 * Convergence note (batch 6): before the refactor, parseJsonValue existed as a copy
 * in three places
 *   - tengence-geo-sdk/db/terms.js (the correct implementation)
 *   - commands/taxonomy.js (a copy)
 *   - commands/db-query.js's safeParse (a broken implementation: JSON columns that
 *     were already objects were JSON.parse'd again → threw → always returned fallback)
 * Now converged into a single source; the other two copies were deleted and require
 * this module instead.
 *
 * Background: mysql2 returns objects for JSON columns and strings for TEXT/JSON-string
 * columns. So the parser must accept both "already an object" and "still a string".
 */

/**
 * Tolerant JSON column / JSON-string parsing
 * @param {*} value could be null / undefined / '' / an object (JSON column read back) / a JSON string
 * @param {*} fallback the fallback when parsing fails or the value is empty
 */
function parseJsonValue(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value; // JSON columns read back as objects; return as-is
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

module.exports = { parseJsonValue };
