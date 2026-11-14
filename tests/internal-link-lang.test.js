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
