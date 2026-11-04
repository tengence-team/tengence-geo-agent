/**
 * Unified promote-to-publish core (tengence-geo-sdk/publish/promote)
 * ============================================================================
 * Created 2026-11-05 after the "plan says published / WordPress says future"
 * drift. Root cause: multiple entry points each flipped posts to `publish` with
 * their own (unverified) code, and some passed FUTURE post_dates — WordPress
 * core (wp_insert_post "Scheduled posts") silently coerces status=publish with
 * a future post_date into `future` (scheduled, hidden from the site), so a
 * "successful" REST call could leave the post invisible while the plan table
 * was already marked published.
 *
 * This module is THE single publish action. Every entry point that turns a WP
 * post into `publish` must go through promoteToPublish() (or, when it manages
 * its own REST call, at least through verifyPublished + confirmPlanPublished):
 *
 *   1. clamp    — publish slots may only be in the PAST or NOW. A future slot
 *                 is pulled back to the current moment, so WordPress never has
 *                 a reason to park the post as `future`.
 *   2. update   — wp.posts.update({ status: 'publish', date? }) — the only
 *                 place that performs the draft → publish flip.
 *   3. verify   — re-read the REAL status from WordPress after the write and
 *                 require `publish`. Never trust the request alone.
 *   4. plan     — only after confirmation, write the plan table back for THIS
 *                 language row (never slug-wide).
 *
 * Conventions (same as publish/index.js):
 *   - Lazy: requiring this file has zero side effects.
 *   - Dependencies are injected ({ wp, plan } SDK facades) — no state of its own.
 *   - Dates: naive "YYYY-MM-DDTHH:MM:SS" strings are interpreted in the site
 *     timezone (Asia/Shanghai, UTC+8 — same as the runtime), so naive-vs-local
 *     comparisons in Date.parse are valid.
 * ============================================================================
 */

/** Format a Date as a naive local "YYYY-MM-DDTHH:MM:SS" string. */
function formatLocalDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Parse a WP-style date string into an epoch ms value (or NaN). */
function parseWpDate(dateStr) {
  if (!dateStr) return NaN;
  const s = String(dateStr).trim().replace(' ', 'T');
  // Naive strings are site-local (Asia/Shanghai, UTC+8); explicit offsets/Z pass through.
  const iso = /[+Z]/.test(s) ? s : `${s}+08:00`;
  return Date.parse(iso);
}

/**
 * Clamp a publish slot to "past or now". Returns the (possibly replaced) date
 * string, or null for a null/falsy input. Future slots are logged + clamped.
 */
function clampToPastOrNow(dateStr, log = () => {}) {
  if (!dateStr) return null;
  const ts = parseWpDate(dateStr);
  if (Number.isNaN(ts)) return dateStr; // unparsable: pass through, WP validates
  if (ts <= Date.now()) return dateStr;
  const now = formatLocalDate(new Date());
  log(
    `    ⚠ publish slot ${dateStr} is in the future — WP would park the post as ` +
      `\`future\` (scheduled, hidden); clamped to now (${now})`,
  );
  return now;
}

/** True when a WP-style date string lies in the future. */
function isFutureDate(dateStr) {
  const ts = parseWpDate(dateStr);
  return !Number.isNaN(ts) && ts > Date.now();
}

/**
 * Re-read the REAL post status from WordPress. This is the verification step:
 * a status=publish request can still end up `future` (future-dated), so the
 * only trustworthy source is a fresh GET.
 * @returns {Promise<{status: string|null, link: string|null}>}
 */
async function verifyPublished(wp, postId, { siteKey } = {}) {
  const live = await wp.posts.get(postId, '?_fields=id,slug,status,link', { siteKey });
  return { status: (live && live.status) || null, link: (live && live.link) || null };
}

/**
 * Write the plan table back for ONE language row — only ever called after the
 * publish has been confirmed against the real WP status.
 */
async function confirmPlanPublished(plan, { slug, lang, wpPostId, link, log = () => {} }) {
  try {
    await plan.markPublished(slug, { wpPostId, publishedUrl: link }, { lang });
    log(`    ✓ Plan updated: ${slug} (${lang}) → published`);
    return true;
  } catch (e) {
    log(`    ⚠️ Plan write-back failed for ${lang}: ${e.message}`);
    return false;
  }
}

/**
 * THE single publish action: flip a WP post to `publish` with date clamping,
 * post-write verification and a per-language plan write-back.
 *
 * @param {object} deps   { wp, plan } — SDK facades (t.wp / t.plan)
 * @param {object} opts
 *   postId       WP post id to promote
 *   slug         article slug (plan table key)
 *   lang         language row to write back ('zh-hans' | 'en' | 'zh-hant')
 *   publishDate  optional "YYYY-MM-DDTHH:MM:SS" slot; future slots are clamped
 *                to now. When omitted, the post's OWN date is pre-read and
 *                clamped too — a bare status update on a future-dated post
 *                would otherwise be coerced straight back to `future`.
 *   siteKey      optional site key forwarded to the wp facade
 *   domain       optional site domain for the fallback plan URL
 *   log          optional logger (default: silent)
 * @returns {Promise<{ok: boolean, status?: string, link?: string, reason?: string}>}
 */
async function promoteToPublish(deps, opts) {
  const { wp, plan } = deps;
  const { postId, slug, lang, siteKey, domain, log = () => {} } = opts;

  // 1. clamp: explicit slot first; otherwise pre-read the post's own date —
  //    updating status only would leave a future date in place and WP would
  //    coerce the post straight back to `future`.
  let date = clampToPastOrNow(opts.publishDate, log);
  if (!date) {
    try {
      const cur = await wp.posts.get(postId, '?_fields=id,status,date,date_gmt', { siteKey });
      const candidate = (cur && (cur.date_gmt || cur.date)) || null;
      if (candidate) {
        const gmt = cur.date_gmt ? `${String(cur.date_gmt).trim().replace(' ', 'T')}Z` : null;
        const clamped = clampToPastOrNow(gmt || candidate, log);
        if (clamped !== (gmt || candidate)) date = clamped;
      }
    } catch (e) {
      log(`    ⚠ could not pre-read the post date (${e.message}); proceeding with a bare status update`);
    }
  }

  // 2. the flip (the only publish write in the codebase)
  const patch = { status: 'publish' };
  if (date) { patch.date = date; patch.modified = date; }
  try {
    await wp.posts.update(postId, patch, { siteKey });
  } catch (e) {
    return { ok: false, reason: `promote to publish failed: ${e.message}` };
  }

  // 3. verify the real status
  let live;
  try {
    live = await verifyPublished(wp, postId, { siteKey });
  } catch (e) {
    return { ok: false, reason: `WP status read-back failed: ${e.message}` };
  }
  if (live.status !== 'publish') {
    const why = live.status ? `WP status='${live.status}'` : 'post not found after update';
    log(`    ✗ publish not confirmed by WordPress (${why}); plan left untouched`);
    return { ok: false, status: live.status, reason: `WP publish not confirmed: ${why}` };
  }

  // 4. confirmed → per-language plan write-back
  const link = live.link || `https://www.${domain || 'tengence.com'}/blog/article/${slug}/`;
  await confirmPlanPublished(plan, { slug, lang, wpPostId: postId, link, log });
  return { ok: true, status: live.status, link };
}

module.exports = {
  formatLocalDate,
  parseWpDate,
  clampToPastOrNow,
  isFutureDate,
  verifyPublished,
  confirmPlanPublished,
  promoteToPublish,
};
