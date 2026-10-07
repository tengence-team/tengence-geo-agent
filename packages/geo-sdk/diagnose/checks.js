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
  const sc = ev.scale || {};
  const ai = ev.aiBots || [];
  const llms = ev.llms || {};
  const langs = ev.langs || {};
  const alpn = ev.proto || {};
  const aiBlocksGeo = ev.aiBlocksGeo || { count: 0, blocked: [] };
  const aiBlocksSeo = ev.aiBlocksSeo || { count: 0, blocked: [] };
  const titleMeta = ev.titleMeta || {};
  const ck = ev.cookieFlags || {};
  const pages = ev.pages || [];
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
  C.push(check('tech', 'HTTP 协议版本',
    alpn && alpn.protocol === 'h2' || alpn && alpn.protocol === 'h3' ? 'pass' : alpn && alpn.protocol === 'http/1.1' ? 'warn' : 'info',
    alpn && alpn.protocol ? `协商协议: ${alpn.protocol}${alpn.alpn ? '（ALPN）' : ''}` : '无法探测（无 ALPN 或非标准 TLS）'));
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

  // ---- cookie security flags (Secure / HttpOnly / SameSite) ----
  if (ck.total && ck.total > 0) {
    const insecure = (ck.cookies || []).filter((c) => !c.secure || !c.httpOnly || !c.sameSite).length;
    const st = insecure === 0 ? 'pass' : insecure === ck.total ? 'fail' : 'warn';
    C.push(check('security', 'Cookie 安全标志', st,
      `共 ${ck.total} 个 Cookie：Secure×${ck.flags.secure} HttpOnly×${ck.flags.httpOnly} SameSite×${ck.flags.sameSite}${insecure ? `｜${insecure} 个缺标志: ${(ck.cookies || []).filter((c) => !c.secure || !c.httpOnly || !c.sameSite).map((c) => c.name).join(', ').slice(0, 80)}` : ''}`));
  } else {
    C.push(check('security', 'Cookie 安全标志', 'info', '未下发 Cookie（无可评）'));
  }

  // ---- apex HTTPS availability (direct example.com visits) ----
  const apexCert = dns.apexCertificate;
  if (apexCert && apexCert.error) {
    C.push(check('security', 'apex HTTPS 可用性', 'fail', `apex 443 无法建立 TLS: ${apexCert.error}`));
  } else if (apexCert && apexCert.daysLeft !== null && apexCert.daysLeft !== undefined) {
    C.push(check('security', 'apex HTTPS 可用性', 'pass',
      `apex 证书有效，剩余 ${apexCert.daysLeft} 天 | ${apexCert.issuer?.O || apexCert.issuer?.CN || '未知'}`));
  } else if (apexCert) {
    C.push(check('security', 'apex HTTPS 可用性', 'info', 'apex 与 www 同证书或未知'));
  } else {
    C.push(check('security', 'apex HTTPS 可用性', 'info', '未探测'));
  }

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
        return new URL(ev.probeBase || finalUrl).hostname.toLowerCase();
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

    // protocol / www consistency inside the sitemap itself
    const nonCanonical = urls.filter((u) => {
      try {
        const uu = new URL(u);
        return uu.protocol !== 'https:' || uu.hostname.toLowerCase() !== host;
      } catch {
        return true;
      }
    });
    C.push(check('crawl', 'sitemap 协议一致性', nonCanonical.length === 0 ? 'pass' : 'warn',
      `${urls.length} 个 URL 中 ${nonCanonical.length} 个非 https://${host} 规范形态（http/www 混用会重复收录）`));

    // sitemap inventory: what share of sitemap URLs actually resolve (200)
    if (sc.total > 0) {
      const pct = Math.round((sc.ok200 / sc.total) * 100);
      C.push(check('crawl', 'sitemap 收录页可访问性', sc.failures.length === 0 ? 'pass' : sc.failures.length <= sc.total * 0.1 ? 'warn' : 'fail',
        `${sc.ok200}/${sc.total} 个 sitemap URL 返回 200（${pct}%）| 异常: ${sc.failures.slice(0, 6).map((f) => `${new URL(f.url).pathname}:${f.status}`).join(' ') || '无'}`));
      C.push(check('crawl', 'sitemap 500/异常软错误', sc.abnormal.length === 0 ? 'pass' : 'fail',
        sc.abnormal.length ? `发现 ${sc.abnormal.length} 个稳定 ${[...new Set(sc.abnormal.map((f) => f.status))].join('/')} 页: ${sc.abnormal.slice(0, 8).map((f) => new URL(f.url).pathname).join(', ')}` : '无 5xx/403/429 软错误'));
    } else {
      C.push(check('crawl', 'sitemap 收录页可访问性', 'info', 'sitemap 未解析出 URL，无法盘点'));
    }
  }
  const p404 = ev.probe404;
  C.push(check('crawl', '404 处理', p404 && p404.status === 404 ? 'pass' : p404 && p404.status === 200 ? 'fail' : 'info',
    p404 ? `随机路径返回 HTTP ${p404.status}` : '未探测'));

  // ---- WAF / anti-bot interception ----
  C.push(check('crawl', 'WAF/反爬拦截', rp.wafIntercepted ? 'fail' : 'pass',
    rp.wafIntercepted
      ? `抓取被重定向到 ${rp.finalUrl}（离开目标域名）——无头客户端拿到 WAF 验证页而非真实内容，正文/Title/结构化等页面级检查以挑战页为准，须浏览器补充核实`
      : '普通抓取可直接获取内容（未被 WAF 挑战拦截）'));

  // ============ 内容 SEO ============
  const t = (rp.title || '').length;
  C.push(check('content', 'Title', t >= 10 && t <= 70 ? 'pass' : t > 0 ? 'warn' : 'fail',
    rp.title ? `「${rp.title.slice(0, 60)}」 (${t} 字符)` : '缺失'));

  // ---- cross-page title uniqueness (the "every page has the same title" failure) ----
  if (titleMeta.pagesCompared > 1) {
    const allSame = titleMeta.uniqueTitles === 1 && titleMeta.titles.length > 1;
    const st = allSame ? 'fail' : titleMeta.uniqueTitles === titleMeta.titles.length ? 'pass' : 'warn';
    C.push(check('content', '跨页 Title 唯一性', st,
      `比较 ${titleMeta.pagesCompared} 页：${titleMeta.uniqueTitles}/${titleMeta.titles.length} 个唯一 Title${allSame ? `（全站重复: ${(titleMeta.titles[0] || '').slice(0, 50)}…）` : ''}`));
  } else {
    C.push(check('content', '跨页 Title 唯一性', 'info', '仅首页，无法跨页比较'));
  }

  const d = (rp.meta && (rp.meta.description || '')) || '';
  C.push(check('content', 'Meta Description', d.length >= 50 && d.length <= 160 ? 'pass' : d.length > 0 ? 'warn' : 'fail',
    d ? `${d.slice(0, 80)}… (${d.length} 字符)` : '缺失'));

  // ---- cross-page meta description uniqueness ----
  if (titleMeta.descriptions.length > 1) {
    const allSame = titleMeta.uniqueDescs === 1;
    const st = allSame ? 'fail' : titleMeta.uniqueDescs === titleMeta.descriptions.length ? 'pass' : 'warn';
    C.push(check('content', '跨页 Meta 唯一性', st,
      `比较 ${titleMeta.descriptions.length} 个非空 description：${titleMeta.uniqueDescs} 个唯一${allSame ? '（相互复制）' : ''}`));
  } else {
    C.push(check('content', '跨页 Meta 唯一性', 'info', titleMeta.descriptions.length === 0 ? '各页均无 description' : '仅 1 个非空 description，无法比较'));
  }

  // ---- cross-page body near-duplicate detection (fingerprint; real-content pages only) ----
  const cd = ev.contentDup || { groups: [], duplicatePages: 0, pagesCompared: 0 };
  if (cd.pagesCompared > 1) {
    const dupPct = cd.pagesCompared ? (cd.duplicatePages / cd.pagesCompared) : 0;
    const st = cd.groups.length === 0 ? 'pass' : cd.groups.length <= 2 && dupPct <= 0.5 ? 'warn' : 'fail';
    C.push(check('content', '正文重复（近似重复页）', st,
      cd.groups.length === 0
        ? `抽样 ${cd.pagesCompared} 个真实内容页，正文指纹全部唯一`
        : `发现 ${cd.groups.length} 组近似重复：${cd.groups.map((g) => `[${g.pages.join(', ')}]（${g.wordCount} 词）`).join('；').slice(0, 160)}`));
  } else {
    C.push(check('content', '正文重复（近似重复页）', 'info', '真实内容页不足 2 个，无法比较'));
  }

  // ---- faceted / query-param internal links (filter/sort/pagination risk) ----
  const linksInfo = rp.links || {};
  const queryPct = linksInfo.internal ? Math.round(((linksInfo.queryParam || 0) / linksInfo.internal) * 100) : 0;
  C.push(check('content', '筛选参数 URL（faceted）', 'info',
    linksInfo.internal
      ? `站内 ${linksInfo.internal} 链接中带 query 参数 ${linksInfo.queryParam || 0} 个（${queryPct}%），hash 空链 ${linksInfo.hashOnly || 0} 个`
      : '无站内链接数据'));
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
  const modernPct = (rp.images && rp.images.modernPct) || 0;
  C.push(check('content', '图片格式 (WebP/AVIF)',
    rp.images && rp.images.count ? (modernPct >= 50 ? 'pass' : modernPct > 0 ? 'warn' : 'info') : 'info',
    rp.images && rp.images.count ? `WebP×${rp.images.webp} AVIF×${rp.images.avif}（${modernPct}% 现代格式）` : '无图'));
  const sizePct = (rp.images && rp.images.missingSizePct) || 0;
  C.push(check('content', '图片尺寸属性', sizePct <= 20 ? 'pass' : sizePct <= 50 ? 'warn' : 'fail',
    `${rp.images ? rp.images.missingSize : 0}/${rp.images ? rp.images.count : 0} 张图缺 width/height（${sizePct}%，CLS 风险）`));
  C.push(check('content', '正文量', rp.textLength >= 200 ? 'pass' : rp.textLength > 0 ? 'warn' : 'fail',
    `正文约 ${rp.textLength} 字符`));
  // ---- word count + JS-shell detection ----
  const wc = rp.wordCount || 0;
  const jsFramework = ['Next.js', 'Nuxt', 'Gatsby', 'React', 'Vue', 'Svelte', 'Astro'].includes(fp.framework || '');
  C.push(check('content', '正文词数', wc >= 300 ? 'pass' : wc >= 100 ? 'warn' : 'fail',
    `正文约 ${wc} 词（CJK ${rp.cjkChars || 0} + 拉丁 ${rp.latinWords || 0}）${wc < 100 && jsFramework ? '｜疑似 JS 渲染空壳（框架 ' + fp.framework + '，爬虫不执行 JS 将读到极少量文本）' : ''}`));
  C.push(check('content', '内链数量', rp.links && rp.links.internal >= 10 ? 'pass' : 'info',
    `${rp.links ? rp.links.internal : 0} 个站内链接`));
  C.push(check('content', 'viewport', rp.viewport ? 'pass' : 'fail', rp.viewport ? rp.viewport : '缺失 viewport'));
  C.push(check('content', 'lang 属性', rp.lang ? 'pass' : 'warn', rp.lang ? `<html lang="${rp.lang}">` : '缺失'));
  C.push(check('content', 'charset', rp.charset ? 'pass' : 'warn', rp.charset ? rp.charset : '未声明'));

  // ---- analytics stack (legacy UA- is a dead measurement signal since 2023-07) ----
  const analytics = (rp.analytics || []).map((a) => a.kind);
  if (analytics.includes('ga4')) {
    C.push(check('content', '统计代码', 'pass', `GA4/gtag 已部署（${rp.analytics.filter((a) => a.kind === 'ga4').map((a) => a.sample).join(' | ')}）`));
  } else if (analytics.includes('ua-legacy')) {
    C.push(check('content', '统计代码', 'warn', '仅 Universal Analytics（UA-），该版本已于 2023-07 停用——国际流量实质失盲，需升级 GA4'));
  } else if (analytics.length) {
    C.push(check('content', '统计代码', 'info', `${rp.analytics.map((a) => a.name).join('、')}（第三方统计）`));
  } else {
    C.push(check('content', '统计代码', 'info', '未检测到统计脚本（可观测性缺口）'));
  }

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

  // ---- llms.txt (generative-engine site map) ----
  C.push(check('geo', 'llms.txt', llms.found ? 'pass' : 'info',
    llms.found ? `发现 ${llms.probes.filter((p) => p.status === 200).map((p) => new URL(p.url).pathname).join(', ')}｜${(llms.content || '').slice(0, 60).replace(/\n/g, ' ')}…` : '未发现 /llms.txt（生成式引擎无结构化入口）'));

  // ---- crawler reachability: SEO (search engines) vs GEO (generative engines),
  //      probed and judged separately ----
  const seoBots = (ai || []).filter((a) => a.group === 'seo');
  const geoBots = (ai || []).filter((a) => a.group === 'geo');

  function crawlerSummary(b) {
    let hostNote = '';
    if (!b.hostSame && b.finalUrl) {
      try {
        hostNote = `（被重定向到 ${new URL(b.finalUrl).hostname}）`;
      } catch {
        hostNote = '（被重定向）';
      }
    }
    return `${b.bot}: HTTP ${b.status}${hostNote}，正文 ${b.wordCount} 词${b.full ? '（内容完整，可引用）' : b.status === 200 && !b.hostSame ? '（WAF 验证页，读不到真实内容）' : b.status === 200 ? '（疑似 JS 空壳或内容极少）' : `（${b.error || '被拦截'}）`}`;
  }

  if (seoBots.length) {
    const allFull = seoBots.every((b) => b.status === 200 && b.full);
    const any200 = seoBots.some((b) => b.status === 200);
    C.push(check('geo', 'SEO 爬虫可达性', allFull ? 'pass' : any200 ? 'warn' : 'fail',
      `搜索引擎组（Googlebot/Bingbot/Baiduspider）：${seoBots.map(crawlerSummary).join('；')}`));
  } else {
    C.push(check('geo', 'SEO 爬虫可达性', 'info', '未探测'));
  }

  if (geoBots.length) {
    const allFull = geoBots.every((b) => b.status === 200 && b.full);
    const any200 = geoBots.some((b) => b.status === 200);
    C.push(check('geo', 'GEO 爬虫可达性', allFull ? 'pass' : any200 ? 'warn' : 'fail',
      `生成式引擎组（GPTBot/ClaudeBot/PerplexityBot/Bytespider）：${geoBots.map(crawlerSummary).join('；')}`));
  } else {
    C.push(check('geo', 'GEO 爬虫可达性', 'info', '未探测'));
  }

  C.push(check('geo', 'SEO 爬虫 robots 屏蔽', aiBlocksSeo.count === 0 ? 'pass' : 'warn',
    aiBlocksSeo.count ? `robots.txt 对 ${aiBlocksSeo.count} 项规则涉及搜索爬虫: ${aiBlocksSeo.blocked.map((b) => `${b.ua} → ${b.rule}`).join('；').slice(0, 120)}` : 'robots 未屏蔽搜索引擎爬虫'));
  C.push(check('geo', 'GEO 爬虫 robots 屏蔽', aiBlocksGeo.count === 0 ? 'pass' : 'warn',
    aiBlocksGeo.count ? `robots.txt 对 ${aiBlocksGeo.count} 项规则涉及 AI/生成式爬虫: ${aiBlocksGeo.blocked.map((b) => `${b.ua} → ${b.rule}`).join('；').slice(0, 120)}` : 'robots 未屏蔽 AI/生成式爬虫'));

  // ---- independent language version (i18n) ----
  const lang200 = (langs.probes || []).filter((p) => p.is200);
  if (lang200.length) {
    C.push(check('geo', '多语言独立版本', 'pass', `独立语言路径可访问: ${lang200.map((p) => new URL(p.url).pathname).join(', ')}`));
  } else if (rp.hreflang && rp.hreflang.length) {
    C.push(check('geo', '多语言独立版本', 'warn', `声明了 hreflang（${rp.hreflang.map((x) => x.hreflang).join(', ')}）但无独立语言路径可访问（疑似查询参数切换）`));
  } else {
    C.push(check('geo', '多语言独立版本', 'info', '未发现独立语言版本（单语站点或仅查询参数切换）'));
  }

  // ---- Product/Offer structured entity on product-like pages ----
  const pageTypes = [];
  for (const p of pages) {
    if (p.parsed && p.parsed.jsonld) pageTypes.push(...p.parsed.jsonld.types);
  }
  const allTypes = [...types, ...pageTypes];
  const hasProduct = ['Product', 'Offer', 'ProductGroup', 'ItemList'].some((t) => allTypes.includes(t));
  const hasProductPage = pages.some((p) => /product|goods|case|item|service/i.test(new URL(p.url).pathname));
  C.push(check('geo', 'Product/Offer 实体', hasProduct ? 'pass' : hasProductPage ? 'warn' : 'info',
    hasProduct ? '已声明 Product/Offer 级实体' : hasProductPage ? '有产品类页面但未声明 Product 结构化实体' : '未发现产品类页面/实体'));

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
