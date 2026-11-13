/**
 * channel-state / states — the pure vocabulary + transition table (no SQL, no IO)
 * ============================================================================
 * ONE fact: "where is this (platform, slug, lang) task in the publishing flow?"
 * It used to live in eight places (db/channel-plan upsert + markStatus, plan/channel
 * markStatus + reconcile, syndicate/wechat mass path + sync, MCP tool, CLI) with
 * no transition rules at all — `published -> todo` was silently accepted, and the
 * upsert path accepted any string whatsoever (`blocked` got in that way).
 *
 * Every writer goes through channel-state.setState; this file is the only place
 * that decides which moves are legal. Keeping it pure means the 8×8 matrix can be
 * unit-tested without a database.
 * ============================================================================
 */

const STATES = {
  TODO: 'todo',
  DRAFT: 'draft',
  REVIEWING: 'reviewing',
  PUBLISHED: 'published',
  FAILED: 'failed',
  REVIEW_FAILED: 'review_failed',
  DELETED: 'deleted',
  PAUSED: 'paused',
};

const ALL = Object.values(STATES);

/**
 * Legal moves. Same → same is always allowed (idempotent re-runs).
 *   published  → terminal: only metadata (draft ids / article id) may be attached
 *   deleted    → todo is the ONLY exit (human reset, must carry a reason)
 */
const TRANSITIONS = {
  todo: ['todo', 'draft', 'reviewing', 'failed', 'paused', 'deleted'],
  draft: ['draft', 'published', 'reviewing', 'failed', 'paused', 'deleted'],
  reviewing: ['reviewing', 'published', 'review_failed', 'failed', 'paused', 'deleted'],
  failed: ['failed', 'todo', 'paused', 'deleted'],
  review_failed: ['review_failed', 'todo', 'paused', 'deleted'],
  paused: ['paused', 'todo', 'deleted'],
  deleted: ['deleted', 'todo'],
  published: ['published'],
};

/** Moves that must explain themselves (they either hide content or revive it). */
const REASON_REQUIRED = new Set(['deleted', 'review_failed', 'todo']);

/**
 * "Already handed to the platform" — the dedup set used by nextDue / filterUnpublished.
 * Per platform, because a wechat draft box message is a real dispatch, while a
 * Juejin draft is not yet a live article.
 */
const DISPATCHED_BY_PLATFORM = {
  wechat: ['published', 'reviewing', 'draft'],
  // devto publishes live but legacy draft rows (before 2026-10-12) must stay
  // dispatched or they would be re-sent and duplicated.
  devto: ['published', 'reviewing', 'draft'],
};
const DEFAULT_DISPATCHED = ['published', 'reviewing'];

/**
 * Rows the auto-picker must never touch again without a human decision.
 * `draft` is here for single-article platforms (juejin/csdn) where a draft is not
 * a dispatch; on wechat it is already covered by the dispatched set.
 */
const NO_AUTO_RETRY = ['review_failed', 'deleted', 'paused', 'draft'];

/** Queue rows: known to be "not yet dispatched". syncStatuses may only downgrade these. */
const QUEUE_STATUSES = ['todo', 'failed'];

function normalize(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase();
  return s || null;
}

function isState(status) {
  return ALL.includes(normalize(status));
}

function canTransition(from, to) {
  const f = normalize(from);
  const t = normalize(to);
  if (!f) return isState(t); // a brand-new row may be created in any state
  if (!isState(t)) return false;
  const allowed = TRANSITIONS[f];
  if (!allowed) return false;
  return allowed.includes(t);
}

function reasonRequired(from, to) {
  const t = normalize(to);
  if (REASON_REQUIRED.has(t) && normalize(from) !== t) return true;
  return false;
}

function dispatchedFor(platform) {
  return DISPATCHED_BY_PLATFORM[platform] || DEFAULT_DISPATCHED;
}

function isDispatched(platform, status) {
  return dispatchedFor(platform).includes(normalize(status));
}

function isNoAutoRetry(status) {
  return NO_AUTO_RETRY.includes(normalize(status));
}

function isQueueStatus(status) {
  return QUEUE_STATUSES.includes(normalize(status));
}

module.exports = {
  STATES,
  ALL,
  TRANSITIONS,
  DISPATCHED_BY_PLATFORM,
  DEFAULT_DISPATCHED,
  NO_AUTO_RETRY,
  QUEUE_STATUSES,
  normalize,
  isState,
  canTransition,
  reasonRequired,
  dispatchedFor,
  isDispatched,
  isNoAutoRetry,
  isQueueStatus,
};
