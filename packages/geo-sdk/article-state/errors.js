/**
 * article-state / errors — error codes for the single status entry point
 * ============================================================================
 * Every illegal status operation must fail loudly with a stable code, so callers
 * (MCP tools, CLI, agents) can branch on `err.code` instead of string matching.
 *
 * E_LANG_REQUIRED      a status write without `lang` would touch all three
 *                      language rows of one slug (the 2026-11-13 bug: 415 plan
 *                      rows ended up pointing at another language's article).
 * E_INVALID_TRANSITION the requested state cannot be derived / stored:
 *                        - writing plan_status while an article row exists
 *                        - writing written|queued|published while NO article row exists
 *                        - downgrading published -> queued without allowDowngrade
 * E_COVER_UNREACHABLE   featured image URL does not answer 200 + image/*
 * E_NOT_FOUND           neither a plan row nor an article row matched slug+lang
 * ============================================================================
 */

class ArticleStateError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ArticleStateError';
    this.code = code;
    this.details = details || null;
  }
}

function langRequired(slug) {
  return new ArticleStateError(
    'E_LANG_REQUIRED',
    `setState requires lang (slug "${slug}" has up to 3 language rows; writing without lang would hit all of them)`,
    { slug }
  );
}

function invalidTransition(message, details) {
  return new ArticleStateError('E_INVALID_TRANSITION', message, details);
}

function coverUnreachable(url, reason) {
  return new ArticleStateError(
    'E_COVER_UNREACHABLE',
    `featured image is not usable (${reason}): ${url}`,
    { url, reason }
  );
}

function notFound(slug, lang) {
  return new ArticleStateError('E_NOT_FOUND', `no plan/article row for ${slug} (${lang})`, { slug, lang });
}

module.exports = { ArticleStateError, langRequired, invalidTransition, coverUnreachable, notFound };
