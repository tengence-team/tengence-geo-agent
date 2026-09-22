/**
 * Content domain entry (tengence-geo-sdk/content)
 * ============================================================================
 * Aggregates "content processing" capabilities: Markdown → HTML / plain text,
 * SEO/GEO meta construction, taxonomy.yaml read/write. These used to be private
 * functions of publish-from-db.js and publish-draft.js; batch B converged them into
 * this domain so both sides share one implementation.
 * ============================================================================
 */

module.exports = {
  md: require('./md'),
  meta: require('./meta'),
  http: require('./http'),

};
