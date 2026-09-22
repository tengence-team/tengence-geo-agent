/**
 * diagnose/checks.js — GEO/SEO diagnostic check engine
 * ============================================================================
 * Turns collected evidence into a uniform checks[] list. Each check:
 *   { id, dimension, name, status: pass|warn|fail|info, detail }
 * Thresholds follow mainstream SEO/GEO best practice (title length, alt coverage,
 * TTFB, redirect chains, security headers, structured data presence, …).
 * "info" items carry observations with no pass/fail judgement.
 */

function check(dimension, name, status, detail, id) {
  const suffix = id || `${dimension}-${name}`.replace(/[\/\\]/g, '-');
  return { id: suffix, dimension, name, status, detail };
}

function buildChecks(ev) {
  const C = [];
  const r = ev.root || {};
  const rp = ev.rootPage || {};
  const fp = ev.fingerprint || {};
  const dns = ev.dns || {};
  const rob = ev.robots || {};
  const sm = ev.sitemap || {};
  const h = rp.headers || {};

  const lower = {};
  for (const [k, v] of Object.entries(h)) lower[k.toLowerCase()] = String(v || '');

  // ============ 域名与服务器 ============
  C.push(check('domain', 'A 记录', dns.a && dns.a.length ? 'pass' : 'fail',
    dns.a && dns.a.length ? `IPv4: ${dns.a.join(', ')}` : '无 A 记录解析'));
  C.push(check('domain', 'IPv6 (AAAA)', dns.aaaa && dns.aaaa.length ? 'info' : 'warn',
    dns.aaaa && dns.aaaa.length ? `IPv6: ${dns.aaaa.join(', ')}` : '未配置 AAAA 记录'));
  C.push(check('domain', 'NS 记录', dns.ns && dns.ns.length ? 'pass' : 'fail',
    dns.ns && dns.ns.length ? `NS: ${dns.ns.join(', ')}` : '无 NS 记录'));
  C.push(check('domain', 'MX 记录', dns.mx && dns.mx.length ? 'info' : 'info',
    dns.mx && dns.mx.length ? dns.mx.map((m) => `${m.exchange} (prio ${m.priority})`).join(', ') : '未配置 MX（无邮件）'));
  C.push(check('domain', 'TXT/SPF/DMARC', dns.txt && dns.txt.length ? 'info' : 'info',
    dns.txt && dns.txt.length ? `TXT: ${dns.txt.map((t) => t.join('')).join(' | ').slice(0, 200)}` : '无 TXT 记录'));

  const cert = dns.certificate;
  if (cert && cert.error) {
    C.push(check('domain', 'HTTPS 证书', 'fail', `无法获取证书: ${cert.error}`));
  } else if (cert && cert.daysLeft !== null && cert.daysLeft !== undefined) {
    const st = cert.daysLeft > 30 ? 'pass' : cert.daysLeft > 7 ? 'warn' : 'fail';
    C.push(check('domain', 'HTTPS 证书有效期', st,
      `剩余 ${cert.daysLeft} 天 | 颁发者: ${cert.issuer?.O || cert.issuer?.CN || '未知'} | TLS: ${cert.protocol}`));
  } else {
    C.push(check('domain', 'HTTPS 证书', 'warn', '站点未通过 HTTPS 暴露或证书不可达'));
  }

  const who = dns.whois;
  if (who && who.created) {
    const ageY = Math.max(0, Math.floor((Date.now() - new Date(who.created).getTime()) / 31536000000));
    C.push(check('domain', '域名年龄', 'pass', `${who.created}（约 ${ageY} 年）`));
  } else {
    C.push(check('domain', '域名 WHOIS', 'info',
      who ? (who.error ? `WHOIS 查询不可用: ${who.error}` : 'WHOIS 字段缺失（注册局限制）') : '未查询'));
  }
  if (who && who.expires) {
    const days = Math.floor((new Date(who.expires).getTime() - Date.now()) / 86400000);
    C.push(check('domain', '域名到期', days > 90 ? 'pass' : days > 30 ? 'warn' : 'fail',
      `${who.expires}（剩余 ${days} 天）`));
  }
  if (who && who.registrar) C.push(check('domain', '注册商', 'info', who.registrar));

  // ============ 技术/传输 ============
  const finalUrl = rp.finalUrl || r.url;
  let proto = '';
  try {
    proto = new URL(finalUrl).protocol;
  } catch {
    proto = '';
  }
  C.push(check('tech', 'HTTPS 强制', proto === 'https:' ? 'pass' : 'fail',
    `最终协议: ${proto || '未知'}`));
  C.push(check('tech', '首页状态码', rp.status === 200 ? 'pass' : 'fail',
    `HTTP ${rp.status} ${rp.statusText || ''}`));
  const redirs = rp.redirects || [];
  C.push(check('tech', '重定向链', redirs.length === 0 ? 'pass' : redirs.length <= 2 ? 'warn' : 'fail',
    redirs.length ? redirs.map((x) => `${x.status} ${x.from} → ${x.location}`).join(' | ') : '无重定向'));
  if (redirs.length) {
    try {
      const from = new URL(redirs[0].from);
      const to = new URL(finalUrl);
      const norm =
        (from.protocol !== to.protocol || from.hostname !== to.hostname)
          ? `（${from.protocol}//${from.hostname} → ${to.protocol}//${to.hostname}）`
          : '';
      C.push(check('tech', '规范化', 'info', `www/协议规范化: ${norm || '一致'}`));
    } catch {
      /* noop */
    }
  }
  C.push(check('tech', '压缩传输', lower['content-encoding'] ? 'pass' : 'warn',
    `Content-Encoding: ${lower['content-encoding'] || '未压缩'}`));
  C.push(check('tech', '缓存头', lower['cache-control'] ? 'pass' : 'warn',
    `Cache-Control: ${lower['cache-control'] || '未设置'}`));
  C.push(check('tech', 'TTFB', rp.ttfbMs < 600 ? 'pass' : rp.ttfbMs < 2000 ? 'warn' : 'fail',
    `${rp.ttfbMs} ms`));
  C.push(check('tech', 'HTML 体积', rp.bodyLength < 512 * 1024 ? 'pass' : rp.bodyLength < 1024 * 1024 ? 'warn' : 'fail',
    `${(rp.bodyLength / 1024).toFixed(1)} KB`));

  // ============ 安全 ============
  const secHdrs = {
    'strict-transport-security': 'HSTS',
    'x-content-type-options': 'X-Content-Type-Options',
    'x-frame-options': 'X-Frame-Options',
    'content-security-policy': 'CSP',
    'referrer-policy': 'Referrer-Policy',
    'permissions-policy': 'Permissions-Policy',
  };
  const present = [];
  const missing = [];
  for (const [hk, label] of Object.entries(secHdrs)) {
    if (lower[hk]) present.push(label);
    else missing.push(label);
  }
  C.push(check('security', '安全响应头', present.length >= 2 ? 'pass' : missing.length ? 'warn' : 'pass',
    `已配置: ${present.join(', ') || '无'} | 缺失: ${missing.join(', ') || '无'}`));
  C.push(check('security', '混合内容', rp.mixedContent === 0 ? 'pass' : 'warn',
    `页面引用了 ${rp.mixedContent} 个 http:// 资源`));

  // ============ 爬取可达性 ============
  C.push(check('crawl', 'robots.txt', rob.exists ? 'pass' : 'fail', rob.exists ? '已提供' : '缺失/空'));
  if (rob.exists) {
    C.push(check('crawl', 'robots 引用 sitemap', rob.sitemaps.length ? 'pass' : 'warn',
      rob.sitemaps.length ? rob.sitemaps.join(', ') : '未在 robots 中声明 sitemap'));
    const blocks = rob.groups.map((g) => `UA=${g.userAgents.join(',')} Disallow=[${g.disallow.join(';')}]`).join(' | ');
    C.push(check('crawl', 'robots 规则概览', 'info', blocks || '无规则'));
  }
  C.push(check('crawl', 'sitemap 可用', sm.found ? 'pass' : 'warn',
    sm.found ? `${sm.type} · ${sm.urlCount} 个 URL` : '未发现可访问的 sitemap'));
  if (sm.found) {
    const host = (() => {
      try {
        return new URL(finalUrl).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();
    const urls = sm.urls || [];
    const other = urls.filter((u) => {
      try {
        return new URL(u).hostname.toLowerCase() !== host;
      } catch {
        return true;
      }
    });
    C.push(check('crawl', 'sitemap 域一致性', other.length === 0 ? 'pass' : 'warn',
      `${urls.length} 个样本中 ${other.length} 个指向站外域名`));
  }
  const p404 = ev.probe404;
  C.push(check('crawl', '404 处理', p404 && p404.status === 404 ? 'pass' : p404 && p404.status === 200 ? 'fail' : 'info',
    p404 ? `随机路径返回 HTTP ${p404.status}` : '未探测'));

  // ============ 内容 SEO ============
  const t = (rp.title || '').length;
  C.push(check('content', 'Title', t >= 10 && t <= 70 ? 'pass' : t > 0 ? 'warn' : 'fail',
    rp.title ? `「${rp.title.slice(0, 60)}」 (${t} 字符)` : '缺失'));
  const d = (rp.meta && (rp.meta.description || '')) || '';
  C.push(check('content', 'Meta Description', d.length >= 50 && d.length <= 160 ? 'pass' : d.length > 0 ? 'warn' : 'fail',
    d ? `${d.slice(0, 80)}… (${d.length} 字符)` : '缺失'));
  C.push(check('content', 'Canonical', rp.canonical ? 'pass' : 'warn',
    rp.canonical ? rp.canonical : '缺失 canonical'));
  const h1 = rp.headings && rp.headings.h1;
  C.push(check('content', 'H1 唯一性', h1 && h1.count === 1 ? 'pass' : h1 && h1.count > 1 ? 'warn' : 'fail',
    h1 ? `${h1.count} 个 H1（${h1.nonEmpty} 个非空）${h1.samples[0] ? ' | 「' + h1.samples[0].slice(0, 40) + '」' : ''}` : '无 H1'));
  const h2 = rp.headings && rp.headings.h2;
  const h3 = rp.headings && rp.headings.h3;
  const jump = h3 && h3.count > 0 && h2 && h2.count === 0;
  C.push(check('content', '标题层级', jump ? 'warn' : 'pass',
    `H2×${h2 ? h2.count : 0} H3×${h3 ? h3.count : 0}${jump ? '（存在 H3 无 H2 的层级跳跃）' : ''}`));
  const altPct = (rp.images && rp.images.missingAltPct) || 0;
  C.push(check('content', '图片 alt 覆盖', altPct <= 5 ? 'pass' : altPct <= 20 ? 'warn' : 'fail',
    `共 ${rp.images ? rp.images.count : 0} 张图，${altPct}% 缺 alt`));
  C.push(check('content', '正文量', rp.textLength >= 200 ? 'pass' : rp.textLength > 0 ? 'warn' : 'fail',
    `正文约 ${rp.textLength} 字符`));
  C.push(check('content', '内链数量', rp.links && rp.links.internal >= 10 ? 'pass' : 'info',
    `${rp.links ? rp.links.internal : 0} 个站内链接`));
  C.push(check('content', 'viewport', rp.viewport ? 'pass' : 'fail', rp.viewport ? rp.viewport : '缺失 viewport'));
  C.push(check('content', 'lang 属性', rp.lang ? 'pass' : 'warn', rp.lang ? `<html lang="${rp.lang}">` : '缺失'));
  C.push(check('content', 'charset', rp.charset ? 'pass' : 'warn', rp.charset ? rp.charset : '未声明'));

  const og = rp.og || {};
  const ogScore = [og.title, og.description, og.image].filter(Boolean).length;
  C.push(check('content', 'Open Graph', ogScore === 3 ? 'pass' : ogScore > 0 ? 'warn' : 'info',
    ogScore === 3 ? 'title/description/image 完整' : `og:title=${!!og.title} og:description=${!!og.description} og:image=${!!og.image}`));
  C.push(check('content', 'Twitter Card', rp.twitter && rp.twitter.card ? 'info' : 'info',
    rp.twitter && rp.twitter.card ? `card=${rp.twitter.card}` : '未配置 twitter:card'));

  // ============ 结构化数据 / GEO ============
  const types = rp.jsonld ? rp.jsonld.types : [];
  C.push(check('geo', 'JSON-LD 结构化数据', rp.jsonld && rp.jsonld.count > 0 ? 'pass' : 'warn',
    rp.jsonld && rp.jsonld.count > 0 ? `发现 ${rp.jsonld.count} 个，类型: ${types.slice(0, 8).join(', ')}` : '未发现 JSON-LD'));
  C.push(check('geo', '站点实体 (Organization/WebSite)', types.includes('Organization') || types.includes('WebSite') ? 'pass' : 'warn',
    types.includes('Organization') ? 'Organization 已声明' : types.includes('WebSite') ? 'WebSite 已声明' : '未声明站点级实体'));
  C.push(check('geo', '文章实体 (Article/BlogPosting)', types.includes('Article') || types.includes('BlogPosting') || types.includes('NewsArticle') ? 'pass' : 'info',
    types.includes('Article') || types.includes('BlogPosting') || types.includes('NewsArticle') ? '文章级实体已声明' : '首页未见文章级实体（文章页单独评估）'));
  C.push(check('geo', 'FAQPage (直接回答信号)', types.includes('FAQPage') ? 'pass' : 'info',
    types.includes('FAQPage') ? 'FAQ 结构化已声明' : '未发现 FAQPage'));
  C.push(check('geo', 'BreadcrumbList', types.includes('BreadcrumbList') ? 'pass' : 'info',
    types.includes('BreadcrumbList') ? '面包屑结构化已声明' : '未发现'));
  C.push(check('geo', '可引用内容信号', rp.blockquotes > 0 || rp.lists > 0 ? 'info' : 'info',
    `blockquote×${rp.blockquotes} · 列表×${rp.lists}`));
  C.push(check('geo', 'robots meta', rp.robotsMeta ? 'info' : 'info',
    rp.robotsMeta ? `robots=${rp.robotsMeta}` : '未设置 robots meta（默认可索引）'));

  // ============ 性能 ============
  const resCount = (rp.scripts ? rp.scripts.count : 0) + (rp.stylesheets || 0) + (rp.images ? rp.images.count : 0);
  C.push(check('perf', '首屏资源量', resCount < 50 ? 'pass' : resCount < 100 ? 'warn' : 'fail',
    `script×${rp.scripts ? rp.scripts.count : 0} + css×${rp.stylesheets || 0} + img×${rp.images ? rp.images.count : 0} = ${resCount}`));
  C.push(check('perf', '渲染阻塞脚本', (rp.scripts && rp.scripts.blocking) || 0 <= 3 ? 'pass' : 'warn',
    `${rp.scripts ? rp.scripts.blocking : 0} 个无 defer/async 的外部脚本`));
  C.push(check('perf', '图片懒加载', rp.images && rp.images.lazy > 0 ? 'pass' : 'info',
    `${rp.images ? rp.images.lazy : 0}/${rp.images ? rp.images.count : 0} 张图启用懒加载`));

  // ============ CDN / 平台 ============
  C.push(check('platform', '服务器', 'info', fp.server ? fp.server : '未识别（可能已隐藏）'));
  if (fp.cdn) C.push(check('platform', 'CDN', 'info', fp.cdn));
  else C.push(check('platform', 'CDN', 'info', '未识别到 CDN 特征'));
  if (fp.cms) C.push(check('platform', 'CMS 识别', 'info', `${fp.cms}${fp.generator ? ` (${fp.generator})` : ''}`));
  else C.push(check('platform', 'CMS 识别', 'info', '未识别到常见 CMS 特征'));
  if (fp.framework) C.push(check('platform', '前端框架', 'info', fp.framework));
  if (fp.platform) C.push(check('platform', '托管平台', 'info', fp.platform));

  return C;
}

module.exports = { buildChecks };
