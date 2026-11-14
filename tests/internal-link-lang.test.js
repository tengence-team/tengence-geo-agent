/**
 * Internal-link language gate (2026-11-14)
 * ============================================================================
 * One rule, three call sites: check_article (authoring + publish), translation T10,
 * and the historical repair CLI. These tests pin the rule itself so the three can
 * never drift: a body's on-site links must carry the BODY's own language prefix.
 */
const test = require('node:test');
const assert = require('node:assert');
const md = require('../packages/geo-sdk/content/md');

const URL = (lang, slug) => `https://www.tengence.com/${lang ? lang + '/' : ''}blog/article/${slug}/`;

test('article links: bare URL and foreign-language prefix are both hard violations', () => {
  const body = `[a](${URL(null, 'what-is-geo')}) [b](${URL('en', 'geo-trends')}) [c](${URL('zh-hans', 'ok-one')})`;
  const r = md.internalLinkLanguageIssues(body, 'zh-hans');
  assert.equal(r.hard.length, 2);
  assert.deepEqual(r.hard.map((x) => x.kind), ['article-missing-lang', 'article-wrong-lang']);
  assert.deepEqual(r.hard.map((x) => x.found), ['(none)', 'en']);
});

test('en / zh-hant bodies are judged against their own prefix', () => {
  assert.equal(md.internalLinkLanguageIssues(`[a](${URL('en', 'x')})`, 'en').hard.length, 0);
  assert.equal(md.internalLinkLanguageIssues(`[a](${URL('zh-hans', 'x')})`, 'en').hard.length, 1);
  assert.equal(md.internalLinkLanguageIssues(`[a](${URL('zh-hant', 'x')})`, 'zh-hant').hard.length, 0);
});

test('other on-site pages: foreign prefix is hard, bare path is advisory only', () => {
  const r = md.internalLinkLanguageIssues('[a](https://www.tengence.com/en/pricing) [b](https://www.tengence.com/contact-us)', 'zh-hans');
  assert.equal(r.hard.length, 1);
  assert.equal(r.hard[0].kind, 'page-wrong-lang');
  assert.equal(r.soft.length, 1);
});

test('assets, admin paths and fenced examples are not judged', () => {
  const body = [
    '![img](https://www.tengence.com/wp-content/uploads/2026/01/a.png)',
    '```',
    URL('en', 'an-example-inside-code'),
    '```',
    '`' + URL('en', 'inline-example') + '`',
  ].join('\n');
  const r = md.internalLinkLanguageIssues(body, 'zh-hans');
  assert.equal(r.hard.length, 0);
});

test('rewriteInternalArticleLinks: correct prefix, idempotent, keeps anchor/query', () => {
  const body = [
    `[a](${URL(null, 'one')})`,
    `[b](${URL('en', 'two')})`,
    '<a href="https://www.tengence.com/zh-hant/blog/article/three/">c</a>',
    'https://www.tengence.com/blog/article/four/#sec',
  ].join('\n');
  const once = md.rewriteInternalArticleLinks(body, 'zh-hans');
  assert.match(once, /zh-hans\/blog\/article\/one\//);
  assert.match(once, /zh-hans\/blog\/article\/two\//);
  assert.match(once, /zh-hans\/blog\/article\/three\//);
  assert.match(once, /zh-hans\/blog\/article\/four\/#sec/);
  assert.equal(md.internalLinkLanguageIssues(once, 'zh-hans').hard.length, 0);
  assert.equal(md.rewriteInternalArticleLinks(once, 'zh-hans'), once); // idempotent
});

test('articlePrefixIssues (T10) is the same rule, article links only', () => {
  const body = `[a](${URL(null, 'x')}) [b](https://www.tengence.com/en/pricing)`;
  const issues = md.articlePrefixIssues(body, 'zh-hans');
  assert.equal(issues.length, 1); // the /en/pricing page link is not a T10 concern
  assert.equal(issues[0].slug, 'x');
});

test('relative article links are judged and rewritten too (site-root href, no domain)', () => {
  const body = ['[a](/blog/article/bare-rel/)', '[b](/en/blog/article/wrong-rel/)', '[c](/zh-hans/blog/article/ok-rel/)'].join('\n');
  const r = md.internalLinkLanguageIssues(body, 'zh-hans');
  assert.equal(r.hard.length, 2);
  assert.deepEqual(r.hard.map((h) => h.kind).sort(), ['article-missing-lang', 'article-wrong-lang']);
  const once = md.rewriteInternalArticleLinks(body, 'zh-hans');
  assert.equal(md.internalLinkLanguageIssues(once, 'zh-hans').hard.length, 0);
  assert.match(once, /\/zh-hans\/blog\/article\/bare-rel\//);
  assert.equal(once.includes('//'), false, 'no doubled slash');
  assert.equal(md.rewriteInternalArticleLinks(once, 'zh-hans'), once);
});

test('relative rewrite never touches an absolute URL twice', () => {
  const body = '[a](https://www.tengence.com/blog/article/abs/)';
  const once = md.rewriteInternalArticleLinks(body, 'en');
  assert.equal(once, '[a](https://www.tengence.com/en/blog/article/abs/)');
  assert.equal(md.internalLinkLanguageIssues(once, 'en').hard.length, 0);
});

// ---------------------------------------------------------------------------
// malformed Markdown links (2026-11-15)
// Live incident: `了解[通智搜索]( https://www.tengence.com/tengence-search）。` publishes
// as a link whose TEXT is the raw English URL and whose href still carries "）。",
// so a zh-hans article shows readers an English URL link to a 404.
// ---------------------------------------------------------------------------
test('malformed link syntax is detected: space after "(", Chinese close, nested garbage', () => {
  const spaceCase = '了解[通智搜索]( https://www.tengence.com/tengence-search\uFF09\u3002';
  const cnCase = '了解[通智搜索](https://www.tengence.com/tengence-search\uFF09\u3002';
  const nestedCase = '控制台 ([https://console.tengence.com)\uFF0C\u8BF4\u660E](https://console.tengence.com\\)x) \u83B7\u53D6';
  assert.equal(md.malformedLinkSyntax(spaceCase).length, 1);
  assert.equal(md.malformedLinkSyntax(cnCase).length, 1);
  assert.equal(md.malformedLinkSyntax(nestedCase).length, 1);
  // healthy shapes must stay clean
  assert.equal(md.malformedLinkSyntax('了解[通智搜索](https://www.tengence.com/zh-hans/tengence-search)\u3002').length, 0);
  assert.equal(md.malformedLinkSyntax('[a](https://x.com/y)\uFF09\u3002').length, 0);
  // code fences are exempt
  assert.equal(md.malformedLinkSyntax(['```', '[a]( https://x.com)', '```'].join('\n')).length, 0);
});

test('fixMalformedLinks repairs every shape and keeps the article language prefix', () => {
  const fixed = md.fixMalformedLinks('了解[通智搜索](https://www.tengence.com/tengence-search\uFF09\u3002', 'zh-hans');
  assert.match(fixed, /\]\(https:\/\/www\.tengence\.com\/zh-hans\/tengence-search\)/);
  assert.equal(md.malformedLinkSyntax(fixed).length, 0);
  // dead truncated product URL: unlink, keep the words (no live page exists)
  assert.equal(md.fixMalformedLinks('了解[通智睿见](https://www.tengence.com/tengence\uFF09\u3002', 'zh-hans'), '了解通智睿见\u3002');
  // nested garbage collapses to a bare URL
  const nested = '控制台 ([https://console.tengence.com)\uFF0C\u8BF4\u660E](https://console.tengence.com\\)x) \u83B7\u53D6';
  assert.equal(md.fixMalformedLinks(nested, 'zh-hans'), '控制台 (https://console.tengence.com) \u83B7\u53D6');
  // idempotent
  const once = md.fixMalformedLinks('了解[通智搜索]( https://www.tengence.com/tengence-search\uFF09\u3002', 'zh-hans');
  assert.equal(md.fixMalformedLinks(once, 'zh-hans'), once);
});

test('bodyLanguageIssue flags the language of the body, not the declared language', () => {
  const zh = '这是一篇简体中文文章，正文用中文写成。'.repeat(120);
  const en = 'This is an English body written for the English edition. '.repeat(120);
  assert.equal(md.bodyLanguageIssue(zh, 'zh-hans').ok, true);
  assert.equal(md.bodyLanguageIssue(en, 'en').ok, true);
  // the incident: a zh-hans row carrying the English copy
  assert.equal(md.bodyLanguageIssue(en, 'zh-hans').ok, false);
  assert.equal(md.bodyLanguageIssue(zh, 'en').ok, false);
  // traditional body on a zh-hans row (accented chars are the tell)
  assert.equal(md.bodyLanguageIssue('這篇文章的內容與關於實踐的實現方法'.repeat(80), 'zh-hans').ok, false);
  // code fences must not trip the check
  assert.equal(md.bodyLanguageIssue(zh + '\n```\n' + en + '\n```', 'zh-hans').ok, true);
});
