/**
 * article-state / derive — pure state derivation (no SQL, no IO)
 * ============================================================================
 * One article = one `state`. The truth has exactly ONE source per phase:
 *
 *   article row exists  -> articles.status is the source of truth
 *                          draft + no wp_post_id  -> written
 *                          draft +    wp_post_id  -> queued
 *                          publish|future|private -> published
 *
 *   no article row      -> plan_status is the source of truth, and ONLY the
 *                          pre-writing values are allowed (todo | paused)
 *
 * Anything else (a plan row claiming queued/published while the article row is
 * still draft) is exactly the 2026-11-13 drift, and it is DERIVED AWAY here: the
 * article row always wins. That is what makes the drift structurally impossible
 * once every reader goes through this module.
 * ============================================================================
 */

const STATE = {
  TODO: 'todo',
  PAUSED: 'paused',
  WRITTEN: 'written',
  QUEUED: 'queued',
  PUBLISHED: 'published',
};

/** articles.status values that mean "live on the platform" */
const PUBLISHED_ARTICLE_STATUSES = ['publish', 'future', 'private'];

/** plan_status values that are legal ONLY while no article row exists */
const PLAN_ONLY_STATUSES = ['todo', 'paused'];

/** plan_status values a writer may request */
const REQUESTABLE_STATES = ['todo', 'paused', 'written', 'queued', 'published'];

function normalizeLang(lang) {
  return lang ? String(lang).trim().toLowerCase() : null;
}

function isPublishedArticleStatus(status) {
  return PUBLISHED_ARTICLE_STATUSES.includes(String(status || '').toLowerCase());
}

function hasWpPost(wpPostId) {
  return Number(wpPostId) > 0;
}

/**
 * Derive the single state for one (plan, article) pair.
 * @param {{ planStatus?: string|null, article?: {status?: string, wp_post_id?: number|string|null}|null }} input
 * @returns {'todo'|'paused'|'written'|'queued'|'published'}
 */
function derive({ planStatus, article } = {}) {
  if (article) {
    const st = String(article.status || '').toLowerCase();
    if (isPublishedArticleStatus(st)) return STATE.PUBLISHED;
    return hasWpPost(article.wp_post_id) ? STATE.QUEUED : STATE.WRITTEN;
  }
  const ps = String(planStatus || '').toLowerCase();
  if (ps === STATE.PAUSED) return STATE.PAUSED;
  return STATE.TODO;
}

/**
 * Validate a requested transition before any write happens.
 * Throws an ArticleStateError — never silently "fixes" the request.
 *
 * @param {{ to: string, planStatus?: string|null, article?: object|null, allowDowngrade?: boolean }} input
 */
function validateTransition({ to, planStatus, article, allowDowngrade = false }) {
  const { invalidTransition } = require('./errors');
  const target = String(to || '').toLowerCase();

  if (!REQUESTABLE_STATES.includes(target)) {
    throw invalidTransition(`unknown state "${to}" (expected one of ${REQUESTABLE_STATES.join(', ')})`, { to });
  }

  const current = derive({ planStatus, article });

  // pre-writing states exist only while there is no article row
  if (target === STATE.TODO || target === STATE.PAUSED) {
    if (article) {
      throw invalidTransition(
        `cannot set state "${target}" while an article row exists (article ${article.id}); delete/reset the article row first`,
        { to: target, current, articleId: article.id }
      );
    }
    return current;
  }

  // post-writing states require the article row: writing plan_status instead is the
  // exact bug that produced "plan=published / articles=draft" on 54 rows.
  if (!article) {
    throw invalidTransition(
      `cannot set state "${target}" without an article row (writing plan_status here is forbidden)`,
      { to: target, current }
    );
  }

  if (current === STATE.PUBLISHED && target !== STATE.PUBLISHED && !allowDowngrade) {
    throw invalidTransition(
      `refusing to downgrade published -> ${target} without allowDowngrade (platform truth must be checked first)`,
      { to: target, current }
    );
  }

  return current;
}

/** Map a state to the exact article row patch it implies */
function toArticlePatch({ to, wpPostId, publishedAt }) {
  const target = String(to || '').toLowerCase();
  if (target === STATE.WRITTEN) return { status: 'draft', wp_post_id: null, touchPublishedAt: false };
  if (target === STATE.QUEUED) return { status: 'draft', wp_post_id: wpPostId || null, touchPublishedAt: false };
  if (target === STATE.PUBLISHED) {
    return { status: 'publish', wp_post_id: wpPostId || null, touchPublishedAt: true, publishedAt: publishedAt || null };
  }
  throw new Error(`toArticlePatch: "${to}" is not an article-level state`);
}

module.exports = {
  STATE,
  PUBLISHED_ARTICLE_STATUSES,
  PLAN_ONLY_STATUSES,
  REQUESTABLE_STATES,
  normalizeLang,
  isPublishedArticleStatus,
  hasWpPost,
  derive,
  validateTransition,
  toArticlePatch,
};
