/**
 * diagnose domain — end-to-end against a local HTTP server (no external network)
 * ============================================================================
 * Pins the GEO/SEO diagnosis contract:
 *   - bootstrap: diagnose_site(url) creates the site on first use (created:true)
 *   - homepage: meta / H1 / H2..H3 / JSON-LD / images / links / viewport / lang
 *   - robots.txt + sitemap discovery (urlset parsing)
 *   - representative page from the sitemap is fetched and parsed
 *   - checks[] carries dimensioned pass/warn/fail/info items
 *   - idempotent second run reports created:false
 *   - report_write confines writes to <site>/data/reports/ and rejects traversal
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = require('../packages/geo-sdk/site');
const diagnose = require('../packages/geo-sdk/diagnose');

let TMP;
let server;
let BASE;

const HOMEPAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>示例站点 - GEO/SEO 诊断测试</title>
  <meta name="description" content="这是一个用于诊断测试的示例站点描述，长度足够满足 meta description 的最佳实践要求。">
  <meta property="og:title" content="示例站点">
  <meta property="og:description" content="用于诊断测试的示例站点。">
  <meta property="og:image" content="https://img.example.com/og.png">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="__BASE__/">
  <link rel="stylesheet" href="/css/app.css">
  <script src="/js/app.js"></script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"示例站点","url":"__BASE__/"}</script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>
</head>
<body>
  <h1>示例站点首页</h1>
  <h2>关于我们</h2>
  <p>正文内容第一段，用于测试页面正文量是否足够，同时测试文本抽取的稳定性与长度统计的准确性。</p>
  <h2>产品与服务</h2>
  <h3>产品一</h3>
  <img src="/img/a.jpg" alt="产品图A">
  <img src="/img/b.jpg">
  <a href="/post/1">文章一</a>
  <a href="/about">关于我们</a>
  <a href="https://external.example.com/x" rel="nofollow">外部链接</a>
  <blockquote>可引用的观点。</blockquote>
</body>
</html>`;

const ROBOTS = `User-agent: *
Disallow: /admin/
Sitemap: __BASE__/sitemap.xml
`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>__BASE__/</loc></url>
  <url><loc>__BASE__/post/1</loc></url>
  <url><loc>__BASE__/post/2</loc></url>
  <url><loc>__BASE__/post/3</loc></url>
  <url><loc>__BASE__/category/seo</loc></url>
  <url><loc>__BASE__/about</loc></url>
</urlset>`;

const ARTICLE = `<!doctype html>
<html lang="zh-CN">
<head>
  <title>文章一 | 示例站点</title>
  <meta name="description" content="文章一的描述，用于诊断代表页面的结构化数据与标题层级。">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"文章一","author":{"@type":"Person","name":"张三"},"datePublished":"2026-09-01"}</script>
</head>
<body>
  <h1>文章一</h1>
  <p>这是文章一的正文，包含足够的文本内容供诊断程序抽取与分析，并验证代表页面抓取与解析流程。</p>
  <h2>章节一</h2>
  <p>章节一的内容。</p>
</body>
</html>`;

before(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-diagnose-'));
  site.setSitesRoot(TMP);

  server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/' || url === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(HOMEPAGE.replaceAll('__BASE__', BASE));
    } else if (url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(ROBOTS.replaceAll('__BASE__', BASE));
    } else if (url === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(SITEMAP.replaceAll('__BASE__', BASE));
    } else if (url === '/post/1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
    } else if (url === '/post/2' || url === '/post/3') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE.replace('<h1>文章一</h1>', '<h1>另一篇文章</h1>'));
    } else if (url === '/category/seo' || url === '/about') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE.replace('<h1>文章一</h1>', '<h1>栏目页</h1>'));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  BASE = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('diagnose_site: full diagnosis against local site (bootstrap + evidence + checks)', async () => {
  const res = await diagnose.runDiagnosis({ url: `${BASE}/` });

  assert.equal(res.ok, true);
  assert.equal(res.site_key, '127_0_0_1');
  assert.equal(res._bootstrap.created, true, 'first call should bootstrap the site');
  assert.ok(res.site_dir.startsWith(TMP));

  // homepage evidence
  const hp = res.evidence.homepage;
  assert.ok(hp, 'homepage should be parsed');
  assert.ok(hp.title.includes('示例站点'));
  assert.ok(hp.headings.h1.count === 1);
  assert.ok(hp.headings.h2.count === 2);
  assert.ok(hp.headings.h3.count === 1);
  assert.ok(hp.jsonld.count === 2, 'two JSON-LD blocks expected');
  assert.ok(hp.jsonld.types.includes('WebSite'));
  assert.ok(hp.jsonld.types.includes('FAQPage'));
  assert.equal(hp.images.count, 2);
  assert.equal(hp.images.missingAlt, 1);
  assert.ok(hp.links.internal >= 2);
  assert.ok(hp.links.external >= 1);
  assert.equal(hp.lang, 'zh-CN');
  assert.ok(hp.og.title);

  // robots + sitemap
  assert.equal(res.evidence.robots.exists, true);
  assert.ok(res.evidence.robots.sitemaps.length >= 1);
  assert.equal(res.evidence.sitemap.found, true);
  assert.equal(res.evidence.sitemap.type, 'urlset');
  assert.equal(res.evidence.sitemap.urlCount, 6);

  // representative pages: sampled by path-segment cluster, never the whole site
  assert.ok(res.evidence.pages.length === 3, `sampled 3 pages from 6 sitemap URLs, got ${res.evidence.pages.length}`);
  const samplePaths = res.evidence.pages.map((p) => new URL(p.url).pathname).sort();
  assert.deepEqual(samplePaths, ['/about', '/category/seo', '/post/1']);
  assert.ok(res.evidence.pages.every((p) => p.status === 200));

  // 404 probe
  assert.equal(res.evidence.probe404.status, 404);

  // checks
  const checks = res.checks;
  assert.ok(Array.isArray(checks) && checks.length > 20, `expected many checks, got ${checks.length}`);
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(byId['tech-首页状态码'].status, 'pass');
  assert.equal(byId['content-H1 唯一性'].status, 'pass');
  assert.equal(byId['crawl-robots.txt'].status, 'pass');
  assert.equal(byId['crawl-sitemap 可用'].status, 'pass');
  assert.equal(byId['crawl-404 处理'].status, 'pass');
  assert.equal(byId['content-Open Graph'].status, 'pass');
  assert.equal(byId['security-安全响应头'].status, 'warn', 'local server has no security headers');
});

test('diagnose_site: second run is idempotent (created:false)', async () => {
  const res = await diagnose.runDiagnosis({ url: `${BASE}/` });
  assert.equal(res.ok, true);
  assert.equal(res.site_key, '127_0_0_1');
  assert.equal(res._bootstrap.created, false);
});

test('report_write: writes into data/reports and rejects traversal', async () => {
  const { registry } = require('../packages/geo-mcp/tools/registry');
  const tool = registry.get('report_write');
  assert.ok(tool, 'report_write tool should be registered');

  const r1 = await tool.run({ site: '127_0_0_1', content: '# 测试报告\n\n内容。', filename: '2026-09-21-127_0_0_1-diagnosis.md' });
  const parsed = JSON.parse(r1.content[0].text);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.path.endsWith('data/reports/2026-09-21-127_0_0_1-diagnosis.md'));
  assert.ok(fs.existsSync(parsed.path));

  const r2 = await tool.run({ site: '127_0_0_1', content: 'x', filename: '../../evil.md' });
  const p2 = JSON.parse(r2.content[0].text);
  // path.basename confines the filename into the reports dir — no escape possible
  assert.equal(p2.ok, true);
  assert.ok(p2.path.endsWith('data/reports/evil.md'));
  assert.ok(!fs.existsSync(path.join(TMP, 'evil.md')), 'must not escape the reports dir');
});

test('linksFallback: uses links.samples array, never the numeric internal counter', () => {
  const { linksFallback } = require('../packages/geo-sdk/diagnose');
  const parsed = {
    links: {
      total: 2,
      internal: 2,
      samples: [{ href: '/post/1', text: 'a' }, { href: '/about', text: 'b' }],
    },
  };
  const out = linksFallback(parsed, 'http://127.0.0.1:1/', 2);
  assert.deepEqual(out, ['http://127.0.0.1:1/post/1', 'http://127.0.0.1:1/about']);

  // a numeric links.internal (a count, not URLs) must not crash the fallback
  const numericOnly = { links: { internal: 5, samples: undefined } };
  assert.deepEqual(linksFallback(numericOnly, 'http://127.0.0.1:1/', 1), []);
});
