/**
 * diagnose domain — extended probe pack (26 new checks) tests
 * ============================================================================
 * Covers the v2 additions:
 *   - pure functions: languageDistribution / detectRobotsConflicts /
 *     check404Localization / i18nCoverage / classifyCacheValue / classifyCname
 *   - integration against a local trilingual mock site (wp paths, x-cache,
 *     sitemap index, per-language homepages, cache headers, CJK 404):
 *       checks[] reaches the full 100 items, the four new dimensions exist,
 *       the request budget is respected and GET/HEAD are accounted.
 * All network happens against 127.0.0.1 — zero external load.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = require('../packages/geo-sdk/site');
const diagnose = require('../packages/geo-sdk/diagnose');
const { languageDistribution } = require('../packages/geo-sdk/diagnose/sitemap');
const { detectRobotsConflicts } = require('../packages/geo-sdk/diagnose/robots');
const { check404Localization, i18nCoverage } = require('../packages/geo-sdk/diagnose/i18n');
const { classifyCacheValue, classifyCacheValue: _c2 } = require('../packages/geo-sdk/diagnose/cdn');
const { classifyCname } = require('../packages/geo-sdk/diagnose/dns');

let TMP;
let server;
let BASE;
let homeHits = 0; // alternates x-cache HIT/MISS so hit-rate sampling sees both

const LANG_HOME = (lang, hreflang) => `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title>${lang} 首页 | 示例站点</title>
  <meta name="description" content="${lang} 首页描述，用于多语言首页 hreflang 对称性检查的测试样本数据。">
  <link rel="canonical" href="__BASE__/${lang}/">
  ${hreflang}
</head>
<body>
  <h1>${lang} 首页</h1>
  <a href="__BASE__/zh-hans/">简体中文</a>
  <a href="__BASE__/zh-hant/">繁體中文</a>
  <a href="__BASE__/en/">English</a>
  <p>首页正文，用于正文量与词数统计的测试文本，保证页面不是空壳。</p>
</body>
</html>`;

const HOMEPAGE_ZH = `<!doctype html>
<html lang="zh-hans">
<head>
  <meta charset="utf-8">
  <title>示例站点 - GEO/SEO 诊断测试</title>
  <meta name="description" content="这是一个用于诊断测试的示例站点描述，长度足够满足 meta description 的最佳实践要求。">
  <meta property="og:title" content="示例站点">
  <meta property="og:description" content="用于诊断测试的示例站点。">
  <meta property="og:image" content="__BASE__/img/og.png">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="__BASE__/zh-hans/">
  <link rel="alternate" hreflang="zh-Hans" href="__BASE__/zh-hans/">
  <link rel="alternate" hreflang="zh-Hant" href="__BASE__/zh-hant/">
  <link rel="alternate" hreflang="en" href="__BASE__/en/">
  <link rel="alternate" hreflang="x-default" href="__BASE__/en/">
  <link rel="stylesheet" href="/css/app.css">
  <script src="/js/app.js"></script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"示例站点","url":"__BASE__/"}</script>
</head>
<body>
  <h1>示例站点首页</h1>
  <h2>关于我们</h2>
  <p>首页正文内容第一段，用于测试正文量与词数统计的稳定性与准确性，同时包含足够文本避免判定为空壳页面。</p>
  <h2>产品与服务</h2>
  <h3>产品一</h3>
  <img src="/img/a.jpg" alt="产品图A">
  <a href="/zh-hans/">简体中文</a>
  <a href="/zh-hant/">繁體中文</a>
  <a href="/en/">English</a>
</body>
</html>`;

const ROBOTS = `User-agent: *
Allow: /public/
Disallow: /admin/
Disallow: /private/
Allow: /private/panel/
Sitemap: __BASE__/sitemap.xml
`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>__BASE__/post-sitemap.xml</loc></sitemap>
  <sitemap><loc>__BASE__/page-sitemap.xml</loc></sitemap>
</sitemapindex>
`;

function postSitemap(prefix, n) {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (let i = 1; i <= n; i++) {
    const p = prefix ? `/${prefix}/article/${i}` : `/article/${i}`;
    out += `  <url><loc>__BASE__${p}</loc><lastmod>2026-09-${String((i % 28) + 1).padStart(2, '0')}</lastmod></url>\n`;
  }
  return out + '</urlset>';
}

const PAGE_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>__BASE__/zh-hans/</loc></url>
  <url><loc>__BASE__/zh-hant/</loc></url>
  <url><loc>__BASE__/blog/</loc></url>
</urlset>
`;

function articlePage(i) {
  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <title>文章 ${i} | 示例站点</title>
  <meta name="description" content="文章 ${i} 的描述内容，用于代表页面诊断的结构化数据与标题层级测试。">
  <link rel="canonical" href="__BASE__/zh-hans/article/${i}">
  <link rel="alternate" hreflang="zh-Hans" href="__BASE__/zh-hans/article/${i}">
  <link rel="alternate" hreflang="zh-Hant" href="__BASE__/zh-hant/article/${i}">
  <link rel="alternate" hreflang="en" href="__BASE__/en/article/${i}">
  <link rel="alternate" hreflang="x-default" href="__BASE__/en/article/${i}">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"文章 ${i}","author":{"@type":"Person","name":"张三"},"datePublished":"2026-09-01"}</script>
</head>
<body>
  <h1>文章 ${i}</h1>
  <p>这是文章 ${i} 的正文，包含足够的文本内容供诊断程序抽取与分析，并验证代表页面抓取与解析流程的稳定性。</p>
  <h2>章节一</h2>
  <p>章节一的内容文本。</p>
</body>
</html>`;
}

before(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-diagnose-extra-'));
  site.setSitesRoot(TMP);

  server = http.createServer((req, res) => {
    const url = req.url || '/';
    const headers = (extra = {}) => ({
      'Content-Type': 'text/html; charset=utf-8',
      // deterministic: the mock always misses the cache (deliberate failure scenario)
      'x-cache': 'MISS from geo-test-cdn',
      ...extra,
    });
    // trilingual homepages: zh-hans complete hreflang, en/zh-hant ZERO (the finding)
    if (url === '/zh-hans/') {
      res.writeHead(200, headers());
      res.end(HOMEPAGE_ZH.replaceAll('__BASE__', BASE));
    } else if (url === '/zh-hant/' || url === '/zh-hant') {
      res.writeHead(200, headers());
      res.end(LANG_HOME('zh-hant', '').replaceAll('__BASE__', BASE));
    } else if (url === '/en/' || url === '/en') {
      res.writeHead(200, headers());
      res.end(LANG_HOME('en', '').replaceAll('__BASE__', BASE));
    } else if (url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(ROBOTS.replaceAll('__BASE__', BASE));
    } else if (url === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(SITEMAP_INDEX.replaceAll('__BASE__', BASE));
    } else if (url === '/post-sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      // zh-hans 102 + zh-hant 102 + no-prefix 102, and NO /en/ prefix —
      // mirrors the real tengence.com finding: the canonical English section is
      // absent from the sitemap while no-prefix duplicates are present.
      res.end(postSitemap('zh-hans', 102) + postSitemap('zh-hant', 102) + postSitemap('', 102));
    } else if (url === '/page-sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(PAGE_SITEMAP.replaceAll('__BASE__', BASE));
    } else if (/^\/zh-hans\/article\/\d+$/.test(url) || /^\/zh-hant\/article\/\d+$/.test(url) || /^\/en\/article\/\d+$/.test(url) || /^\/article\/\d+$/.test(url)) {
      res.writeHead(200, headers());
      res.end(articlePage(parseInt(url.split('/').pop(), 10)).replaceAll('__BASE__', BASE));
    } else if (url === '/css/app.css') {
      res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=2592000, immutable', ETag: '"css1"' });
      res.end('body { color: #333; }');
    } else if (url === '/js/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=2592000', ETag: '"js1"' });
      res.end('console.log(1);');
    } else if (url === '/img/a.jpg' || url === '/img/og.png') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' });
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic (not that we sniff it)
    } else if (url === '/wp-json/' || url === '/wp-content/' || url === '/wp-admin/' || url === '/feed/' || url === '/xmlrpc.php') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    } else if (url === '/broken') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server Error');
    } else if (url === '/') {
      res.writeHead(200, headers());
      res.end(HOMEPAGE_ZH.replaceAll('__BASE__', BASE));
    } else if (/^\/__geo_probe_/.test(url)) {
      // CJK 404 page with a mismatch: lang=en but a Chinese title → the 404-localization finding
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="en"><head><title>未找到页面 - 示例站点</title></head><body><h1>404</h1></body></html>');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------- pure-function unit tests ----------------

test('computeScore: weighted groups, bounded total, letter grade', () => {
  const { computeScore } = require('../packages/geo-sdk/diagnose/checks');
  const mk = (dimension, status) => ({ dimension, status });
  const checks = [
    // GEO 组 (geo + i18n): 10 项 — 5 pass / 2 info / 2 warn / 1 fail
    mk('geo', 'pass'), mk('geo', 'pass'), mk('geo', 'pass'), mk('geo', 'pass'), mk('geo', 'pass'),
    mk('geo', 'info'), mk('geo', 'info'), mk('geo', 'warn'), mk('geo', 'warn'), mk('geo', 'fail'),
    mk('i18n', 'pass'),
    // SEO 组 (content + crawl): 10 项 — 6 pass / 1 info / 2 warn / 1 fail
    mk('content', 'pass'), mk('content', 'pass'), mk('content', 'pass'), mk('content', 'pass'),
    mk('content', 'pass'), mk('content', 'pass'), mk('content', 'info'), mk('content', 'warn'),
    mk('crawl', 'warn'), mk('crawl', 'fail'),
    // 技术 组: 10 项 — 7 pass / 2 warn / 1 fail
    mk('domain', 'pass'), mk('tech', 'pass'), mk('tech', 'pass'), mk('tech', 'pass'),
    mk('security', 'pass'), mk('security', 'pass'), mk('security', 'pass'), mk('platform', 'pass'),
    mk('tech', 'warn'), mk('tech', 'warn'), mk('domain', 'fail'),
    // 性能 组 (perf + cdn): 6 项 — 4 pass / 1 warn / 1 fail
    mk('perf', 'pass'), mk('perf', 'pass'), mk('perf', 'pass'), mk('perf', 'pass'),
    mk('cdn', 'warn'), mk('cdn', 'fail'),
    // 暴露 组 (subdomains + exposure): 5 项 — 3 pass / 1 warn / 1 fail
    mk('subdomains', 'pass'), mk('subdomains', 'pass'), mk('subdomains', 'pass'),
    mk('exposure', 'warn'), mk('exposure', 'fail'),
    // 未分组项 (应被排除但占比微小)
    mk('whois', 'fail'),
  ];
  const sc = computeScore(checks);
  assert.equal(sc.groups.length, 5);
  // GEO: (6×1 + 2×0.5 + 2×0.3 + 1×0) / 11 = 7.6/11 → 69.1
  assert.equal(sc.groups.find((g) => g.key === 'geo').score, 69.1);
  // SEO: (6×1 + 1×0.5 + 2×0.3 + 1×0) / 10 = 7.1 → 71
  assert.equal(sc.groups.find((g) => g.key === 'seo').score, 71);
  // tech: (8×1 + 2×0.3 + 1×0) / 11 = 8.6/11 → 78.2
  assert.equal(sc.groups.find((g) => g.key === 'tech').score, 78.2);
  assert.ok(sc.total > 60 && sc.total < 80, `total ${sc.total} should sit in C/B range`);
  assert.equal(sc.groups.reduce((a, g) => a + g.weight, 0), 1);
});

test('languageDistribution: counts prefixes and reports missing declared languages', () => {
  const urls = [
    'https://x.com/zh-hans/a', 'https://x.com/zh-hans/b', 'https://x.com/zh-hant/a',
    'https://x.com/article/x', 'https://x.com/en/a', 'https://x.com/EN/b',
  ];
  const d = languageDistribution(urls, ['zh-hans', 'zh-hant', 'en']);
  assert.equal(d.total, 6);
  assert.equal(d.byLang['zh-hans'], 2);
  assert.equal(d.byLang['zh-hant'], 1);
  assert.equal(d.byLang.en, 1); // case-insensitive path match? no — /EN/ is a different prefix
  assert.equal(d.noPrefix, 2);
  assert.deepEqual(d.missing, []); // all declared have ≥1 (en has 1 via /en/a)
});

test('languageDistribution: en entirely missing is reported', () => {
  const d = languageDistribution(['https://x.com/zh-hans/a', 'https://x.com/zh-hant/a'], ['zh-hans', 'zh-hant', 'en']);
  assert.deepEqual(d.missing, ['en']);
  assert.equal(d.noPrefix, 0);
});

test('detectRobotsConflicts: Allow/Disallow same-path conflict detected', () => {
  const robots = {
    groups: [{ userAgents: ['*'], disallow: ['/private/', '/admin/'], allow: ['/private/panel/', '/public/'] }],
  };
  const c = detectRobotsConflicts(robots);
  assert.equal(c.length, 1);
  assert.equal(c[0].allow, '/private/panel/');
  assert.equal(c[0].disallow, '/private/');
  assert.equal(detectRobotsConflicts({ groups: [] }).length, 0);
});

test('check404Localization: CJK title + zh lang consistent, en lang + CJK title not', () => {
  assert.equal(check404Localization({ title: '未找到页面', lang: 'zh-hans' }).consistent, true);
  assert.equal(check404Localization({ title: '未找到页面', lang: 'en' }).consistent, false);
  assert.equal(check404Localization(null).consistent, null);
});

test('i18nCoverage: slugs grouped across language prefixes', () => {
  const urls = [
    'https://x.com/zh-hans/article/1', 'https://x.com/zh-hant/article/1', 'https://x.com/en/article/1',
    'https://x.com/zh-hans/article/2', 'https://x.com/zh-hant/article/2', // en missing
    'https://x.com/article/3',
  ];
  const cov = i18nCoverage(urls, ['zh-hans', 'zh-hant', 'en']);
  assert.equal(cov.total, 3);
  assert.equal(cov.covered, 1); // article/1 full, article/2 partial, article/3 no-prefix-only
  assert.equal(cov.gapPct, 67);
});

test('classifyCacheValue + classifyCname: vendor tagging', () => {
  assert.equal(classifyCacheValue('HIT from cdn'), 'hit');
  assert.equal(classifyCacheValue('TCP_MISS'), 'miss');
  assert.equal(classifyCacheValue('BYPASS'), 'miss');
  assert.equal(classifyCacheValue(''), 'unknown');
  assert.equal(classifyCname('www.x.com.w.cdngslb.com'), 'aliyun-cdn-gslb');
  assert.equal(classifyCname('edge.x.cloudfront.net'), 'aws-cloudfront');
  assert.equal(classifyCname('plain.example.com'), 'cname');
});

// ---------------- integration: full run against the trilingual mock ----------------

test('diagnose_site (deep): 111 checks, four new dimensions + GEO pack + score, budget respected', async () => {
  const res = await diagnose.runDiagnosis({ url: `${BASE}/`, deep: true, maxRequests: 700 });
  assert.equal(res.ok, true);
  const checks = res.checks;
  // new dimensions present
  const dims = new Set(checks.map((c) => c.dimension));
  for (const d of ['i18n', 'cdn', 'subdomains', 'exposure']) assert.ok(dims.has(d), `missing dimension ${d}`);
  // key new checks with their expected findings
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.ok(byName['首页 hreflang 对称性'], 'i18n homepage hreflang symmetry missing');
  assert.equal(byName['首页 hreflang 对称性'].status, 'fail', 'en/zh-hant homepages carry no hreflang');
  assert.equal(byName['CDN 缓存命中率'].status, 'fail', 'mock always MISS → 0/3 hits');
  assert.equal(byName['后台/隐藏路径'].status, 'warn', 'wp-json etc are reachable on the mock');
  assert.equal(byName['robots 规则冲突'].status, 'warn', '/private/panel/ Allow vs /private/ Disallow');
  assert.equal(byName['404 页本地化'].status, 'warn', 'CJK title on an en 404 page');
  assert.equal(byName['sitemap 语言分布'].status, 'warn', 'en prefix missing in post-sitemap');
  assert.ok(byName['子域健康巡检'], 'subdomain sweep present');
  assert.ok(byName['证书 SAN 使用核对'], 'SAN usage present');
  assert.ok(byName['HTTP/3 (QUIC)'], 'HTTP/3 present');
  assert.ok(byName['TTFB 稳定性'], 'TTFB stability present');
  // all 26 new checks are present (names), and the total count matches the
  // expected contract. 96 in this mock: 70 classic (74 minus 4 whois/redirect-
  // dependent ones that can't trigger locally) + 26 new. On a real site with
  // WHOIS + redirects the total is 100.
  const NEW_NAMES = [
    'CNAME 链', 'HTTP/3 (QUIC)', 'TTFB 稳定性', '重定向类型', '移动端子域 (m.)',
    'CSP 策略', '证书 SAN 使用核对', 'robots 规则冲突', 'sitemap 语言分布', 'sitemap 新鲜度',
    '社交分享图片', '图片格式一致性', '第三方域名', '外链资源可用性', '无前缀重复 URL',
    'robots 指令一致性', 'LCP 候选元素', '静态资源缓存策略', '首页 hreflang 对称性',
    '404 页本地化', '语言切换器', 'hreflang 大小写统一', '多语言文章覆盖度',
    'CDN 缓存命中率', '子域健康巡检', '后台/隐藏路径',
  ];
  for (const n of NEW_NAMES) {
    assert.ok(byName[n], `missing new check: ${n}`);
  }
  // ---- v3 GEO/SEO extended pack (15 additional checks) ----
  const GEO_NAMES = [
    '数据引用密度', '日期信号', '作者署名 (E-E-A-T)', '权威来源引用', '实体一致性',
    'llms.txt 结构规范', '关键内容静态 HTML', 'AI 生成内容标识', '问答块 (答案块)',
    '子资源完整性 (SRI)', '资源预连接提示', '文章日期可见性', '页面本地资源 404',
    '分页/翻页规范', 'OG/Twitter 元数据一致性',
  ];
  for (const n of GEO_NAMES) {
    assert.ok(byName[n], `missing GEO/SEO check: ${n}`);
  }
  assert.equal(checks.length, 111, `expected 111 checks on the mock site, got ${checks.length}`);
  // ---- overall score: present, bounded, graded, grouped ----
  const sc = res.score;
  assert.ok(sc && typeof sc.total === 'number', 'score.total missing');
  assert.ok(sc.total >= 0 && sc.total <= 100, `score out of range: ${sc.total}`);
  assert.ok(['A', 'B', 'C', 'D'].includes(sc.grade), `bad grade ${sc.grade}`);
  assert.equal(sc.groups.length, 5, 'score must have 5 weighted groups');
  assert.equal(sc.groups.reduce((a, g) => a + g.weight, 0), 1, 'group weights must sum to 1');
  assert.ok(sc.groups.every((g) => g.total > 0), 'every group must cover checks');
  assert.ok(sc.covered >= checks.length - 15, 'covered groups must account for nearly all checks');
  assert.ok(res.evidence.geoExtra && res.evidence.geoExtra.dataDensity, 'geoExtra evidence missing');
  // budget accounting
  assert.ok(res.evidence.budget, 'budget evidence missing');
  assert.ok(res.evidence.budget.used <= 700, `budget blown: ${res.evidence.budget.used}`);
  assert.equal(res.evidence.budget.deepRan, true);
  const stats = res.evidence.requestStats;
  assert.ok(typeof stats.get === 'number' && typeof stats.head === 'number', 'request stats must be tracked');
});

test('diagnose_site (deep=false): no deep probes, zero-request checks still present', async () => {
  const res = await diagnose.runDiagnosis({ url: `${BASE}/`, deep: false, maxRequests: 700 });
  const checks = res.checks;
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(res.evidence.budget.deepRan, false);
  assert.equal(res.evidence.budget.deepSkipped, 'deep=false');
  // parsing-only checks still run
  assert.ok(byName['robots 规则冲突']);
  assert.ok(byName['sitemap 语言分布']);
  assert.ok(byName['404 页本地化']);
  // network-adding probes report as not-sampled / info
  assert.ok(byName['CDN 缓存命中率']);
  assert.equal(byName['CDN 缓存命中率'].status, 'info');
});
