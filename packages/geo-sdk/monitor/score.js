/**
 * GEO Visibility Score scoring (monitor domain)
 * ============================================================================
 * Rubric (plan/2026 doc #10 §5, out of 100):
 *   mention 40 (not mentioned 0 / incidental 15 / listed 30 / active recommendation 40)
 *   citation 20 (cites tengence.com=20 / other external links only=5 / none=0)
 *   accuracy 20 (flagged=0 / complete=20 / basic=15)
 *   position 15 (1st=15 / top 3=10 / top 5=5 / else=0)
 *   sentiment 5 (negative 0 / neutral 3 / positive 5)
 * SOV is not part of the score; the report layer computes it separately.
 * ============================================================================
 */

/**
 * @param {Object} r extract() result (or the aggregated result), fields:
 *   mentionType, citedTengence, citedAny, accuracy, position, sentiment, entityMatch
 * @returns {{score:number, breakdown:{mention,citation,accuracy,position,sentiment}}}
 *
 * ⚠️ Entity-disambiguation gate: entityMatch !== 'ours' (same-name confusion
 *    ambiguous / unrecognized none) → brand visibility is not counted (mention /
 *    position / citation / accuracy / sentiment all zeroed), avoiding inflated
 *    scores from other same-name entities.
 */
function scoreResult(r) {
  if (r.entityMatch && r.entityMatch !== 'ours') {
    return { score: 0, breakdown: { mention: 0, citation: 0, accuracy: 0, position: 0, sentiment: 0 } };
  }
  const mention = r.mentionType >= 3 ? 40 : r.mentionType === 2 ? 30 : r.mentionType === 1 ? 15 : 0;
  const citation = r.citedTengence ? 20 : r.citedAny ? 5 : 0;
  const accuracy = r.accuracy === 'flagged' ? 0 : r.accuracy === 'complete' ? 20 : 15;
  const position = r.position === 1 ? 15 : r.position >= 2 && r.position <= 3 ? 10 : r.position >= 4 && r.position <= 5 ? 5 : 0;
  const sentiment = r.sentiment === 'positive' ? 5 : r.sentiment === 'negative' ? 0 : 3;
  const score = mention + citation + accuracy + position + sentiment;
  return { score, breakdown: { mention, citation, accuracy, position, sentiment } };
}

module.exports = { scoreResult };
