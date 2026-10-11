/**
 * diagnose/checks.js — GEO/SEO diagnostic check engine
 * ============================================================================
 * Turns collected evidence into a uniform checks[] list. Each check:
 *   { id, dimension, name, status: pass|warn|fail|info, detail }
 * Thresholds follow mainstream SEO/GEO best practice (title length, alt coverage,
 * TTFB, redirect chains, security headers, structured data presence, …).
 * "info" items carry observations with no pass/fail judgement.
 */

const { normLang } = require('./i18n');
const {
  dataPointDensity, dateSignals, authorByline, authoritativeCitations,
  entityConsistency, llmsStructure, staticHtmlContent, aigcDisclosure, qaBlocks,
} = require('./geo-extra');

function check(dimension, name, status, detail, id) {
  const suffix = id || `${dimension}-${name}`.replace(/[\/\\]/g, '-');
  return { id: suffix, dimension, name, status, detail };
}

/** Well-known third-party hosts (analytics/CDN/fonts/embeds) — presence is not a risk. */
const KNOWN_THIRD_PARTY = [
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'googlesyndication.com',
  'googleapis.com', 'gstatic.com', 'doubleclick.net', 'google.com', 'google.cn', 'gstatic.cn',
  'jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'cloudflare.com', 'bootstrapcdn.com',
  'alicdn.com', 'aliyuncs.com', 'taobao.com', 'tmall.com', 'bytedance.com', 'byteimg.com', 'pstatp.com',
  'baidu.com', 'bdstatic.com', 'hm.baidu.com', 'cnzz.com', 'qq.com', 'gtimg.com', 'gtimg.cn',
  'qcloud.com', 'myqcloud.com', 'weixin.qq.com', 'woa.com', '51.la', 'cnzz.mochiji.com',
  'matomo.cloud', 'hotjar.com', 'sentry.io', 'amplitude.com', 'mixpanel.com', 'segment.com',
  'intercom.io', 'crisp.chat', 'tawk.to', 'zendesk.com', 'freshchat.com', 'fullstory.com',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'ajax.googleapis.com', 'yandex.ru', 'yandex.com',
  'bing.com', 'microsoft.com', 'microsoftonline.com', 'facebook.net', 'fbcdn.net', 'facebook.com',
  'tiktok.com', 'douyin.com', 'youtube.com', 'youtube-nocookie.com', 'vimeo.com', 'twitter.com',
  'x.com', 'twimg.com', 'instagram.com', 'linkedin.com', 'pinterest.com', 'medium.com',
  'notion.so', 'vercel.app', 'netlify.app', 'squarespace.com', 'shopify.com', 'myshopify.com',
  'wordpress.org', 'wordpress.com', 'wp.com', 'gravatar.com', 'automattic.com',
  'cloudinary.com', 'imgix.net', 'unsplash.com', 'images.unsplash.com', 'pixabay.com',
  'freepik.com', 'flaticon.com', 'icons8.com', 'fontawesome.com', 'fontawesome.cn',
  'vuejs.org', 'reactjs.org', 'nextjs.org', 'nuxtjs.org', 'astro.build', 'webflow.com',
  'zoho.com', 'hubspot.com', 'salesforce.com', 'sfccstatic.com', 'marketo.com', 'klaviyo.com',
  'mailchimp.com', 'sendgrid.net', 'stripe.com', 'paypal.com', 'paypalobjects.com', 'alipay.com',
  'wechat.com', 'tenpay.com', 'jpush.cn', 'getui.com', 'umeng.com', 'umengcloud.com', 'cnzz.com',
];
function isKnownThirdParty(host) {
  const h = String(host || '').toLowerCase();
  return KNOWN_THIRD_PARTY.some((k) => h === k || h.endsWith('.' + k));
}

function buildChecks(ev) {
  const C = [];
  const r = ev.root || {};
  const rp = ev.rootPage || {};
  const fp = ev.fingerprint || {};
  const dns = ev.dns || {};
  const rob = ev.robots || {};
  const sm = ev.sitemap || {};
  const smLang = ev.sitemapLangDist || {};
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
  const geoX = ev.geoExtra || {};
  const locRes = ev.localResources || {};

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

  // ---- CNAME chain expansion (CDN/GSLB detection from DNS alone) ----
  const cc = ev.cnameChain || (dns.cnameChain) || null;
  if (cc && !cc.error && cc.chain && cc.chain.length) {
    const kinds = cc.chain.map((h) => h.kind).filter((k) => k && k !== 'cname');
    C.push(check('domain', 'CNAME 链（CDN 路由）', 'pass',
      `${cc.chain.map((h) => h.from).join(' → ')} → ${cc.terminal} | A: ${(cc.a || []).slice(0, 2).join(', ')}${kinds.length ? `｜CDN/GSLB 特征: ${kinds.join(', ')}` : ''}`));
  } else if (cc && !cc.error && (!cc.chain || !cc.chain.length)) {
    C.push(check('domain', 'CNAME 链', 'info', '无 CNAME（直接 A 记录解析）'));
  } else {
    C.push(check('domain', 'CNAME 链', 'info', cc && cc.error ? `解析失败: ${cc.error}` : '未探测'));
  }

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

  // ---- HTTP/3 readiness (alt-svc header; ALPN h3 cannot be negotiated over TLS 1.3) ----
  const http3Info = ev.http3 || {};
  C.push(check('tech', 'HTTP/3 (QUIC)', http3Info.h3 ? 'pass' : 'info',
    http3Info.h3 ? `已宣告 h3（alt-svc: ${String(http3Info.altSvc || '').slice(0, 60)}）` : '未宣告 alt-svc/h3（HTTP/3 未启用，国际链路弱网下传输优化空间）'));

  // ---- TTFB stability across repeated samples (CDN edge vs origin revalidation) ----
  const ttfbS = ev.ttfbSamples || [];
  if (ttfbS.length >= 2) {
    const sorted = [...ttfbS].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const maxV = sorted[sorted.length - 1];
    const st = maxV < 2 * Math.max(median, 100) ? 'pass' : maxV < 2000 ? 'warn' : 'fail';
    C.push(check('tech', 'TTFB 稳定性', st,
      `样本 ${ttfbS.length} 次: min=${sorted[0]}ms median=${median}ms max=${maxV}ms${maxV >= 2000 ? '（存在回源长尾，见 cdn 缓存命中率）' : ''}`));
  } else {
    C.push(check('tech', 'TTFB 稳定性', 'info', ttfbS.length === 1 ? `仅 1 次采样 ${ttfbS[0]}ms` : '未采样'));
  }

  // ---- redirect type audit: 302 is temporary and uncacheable for crawlers ----
  // 语言协商重定向（302 + Vary: Accept-Language，多语言首页按 Accept-Language/Cookie
  // 302 到语言前缀）是设计内正确实践（RFC 协商 + Google 支持），不视为缺陷。
  const langNeg = (x) => (x.vary || '').includes('accept-language');
  const tempRedirs = redirs.filter((x) => x.status === 302 || x.status === 303 || x.status === 307);
  const hardTemp = tempRedirs.filter((x) => !langNeg(x));
  let redirTypeEv = '无重定向';
  if (redirs.length) {
    const chain = redirs.map((x) => x.status).join(' → ');
    if (!tempRedirs.length) {
      redirTypeEv = `${chain}（全 301/308 永久重定向）`;
    } else {
      const hard = hardTemp.length ? hardTemp.map((x) => `${x.status} ${x.location}`).join(', ') : '';
      const neg = tempRedirs.length - hardTemp.length;
      redirTypeEv = `${chain}｜${tempRedirs.length} 个临时重定向${hard ? `：${hard}` : ''}${neg ? `；${neg} 个为语言协商 302（Vary: Accept-Language，设计内）` : ''}`;
    }
  }
  C.push(check('tech', '重定向类型', redirs.length === 0 ? 'pass' : hardTemp.length === 0 ? 'pass' : 'warn', redirTypeEv));

  // ---- mobile (m.) subdomain redirect semantics ----
  // m 子域的 302 多为设计内行为：语言协商（302 /zh-hans|/zh-hant）或桌面 UA 302 回主站；
  // 回主站后主站自身再做语言协商 302，构成全 302 链（m→www→/zh-hans）。只要首跳语义正确
  // （to www 或语言前缀）且全链均为 302，判 info；出现非 302 跳或语义异常才 warn。
  const mob = ev.mobileRedirect;
  const mRedir = mob && mob.redirects && mob.redirects.length ? mob.redirects[0].status : null;
  const mFirst = mob && mob.redirects && mob.redirects[0] || null;
  const mRedirToWww = !!mFirst && /^https:\/\/www\./i.test(mFirst.location);
  const mRedirLang = !!mFirst && /^\/(?:zh-hans|zh-hant|en)(?:[/?]|$)/.test(mFirst.location);
  const mAll302 = mRedir === 302 && (mob.redirects || []).every((x) => x.status === 302);
  C.push(check('tech', '移动端子域 (m.)',
    mob === null ? 'info' : mRedir === 301 ? 'pass' : mAll302 && (mRedirToWww || mRedirLang) ? 'info' : mRedir === 302 ? 'warn' : mob && mob.error ? 'warn' : 'info',
    mob === null ? '无 m. 子域（未部署独立移动端域名）' : mob && mob.status
      ? `${mob.host || 'm. 子域'} 返回 ${mob.status}${mRedir ? `，首跳 ${mRedir} → ${mFirst ? mFirst.location : ''}（链长 ${(mob.redirects || []).length}）` : ''}${mRedir === 302 ? (mAll302 && (mRedirToWww || mRedirLang) ? '（全 302 链，m 站协商/引导设计内）' : '（临时重定向，建议评估 301）') : ''}`
      : (mob && mob.error) || '探测失败'));

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

  // ---- CSP policy parse: report-only is a rollout stage; can it go live? ----
  const csp = ev.csp || {};
  if (csp && (csp.enforced || csp.reportOnly)) {
    C.push(check('security', 'CSP 策略',
      csp.enforced ? 'pass' : csp.enforceReady ? 'warn' : 'info',
      csp.enforced
        ? 'Content-Security-Policy 已生效（enforce）'
        : csp.reportOnly
          ? `CSP 仍为 Report-Only${csp.enforceReady ? '，指令无硬阻塞，可转 enforce' : `，${csp.blockers.join('、')} 阻碍转 enforce`}`
          : '未配置'));
  } else {
    C.push(check('security', 'CSP 策略', 'info', '未配置 CSP（含 Report-Only）'));
  }

  // ---- certificate SAN usage: hostnames covered by the cert that are not served ----
  const san = ev.sanUsage;
  if (san && san.sans && san.sans.length) {
    C.push(check('security', '证书 SAN 使用核对', san.unused.length === 0 ? 'pass' : 'info',
      `SAN: ${san.sans.slice(0, 6).join(', ')}${san.unused.length ? `｜${san.unused.length} 个 SAN 主机无服务: ${san.unused.join(', ')}` : ''}`));
  } else {
    C.push(check('security', '证书 SAN 使用核对', 'info', '未获取 SAN 列表'));
  }

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

  // ---- Subresource Integrity (SRI) — script/link integrity attribute ----
  const sriTotal = (rp.sri && (rp.sri.scripts + rp.sri.links)) || 0;
  if (sriTotal > 0) {
    C.push(check('security', '子资源完整性 (SRI)', rp.sri.scriptsWithIntegrity > 0 ? 'pass' : 'warn',
      `带 integrity 的资源 ${sriTotal} 个（脚本 ${rp.sri.scriptsWithIntegrity}/${rp.sri.scripts} · 样式 ${rp.sri.linksWithIntegrity}/${rp.sri.links}）${rp.sri.scriptsWithIntegrity > 0 ? '' : '（外部脚本均未启用 SRI，供应链篡改风险）'}`));
  } else {
    C.push(check('security', '子资源完整性 (SRI)', rp.scripts && rp.scripts.count ? 'warn' : 'info',
      rp.scripts && rp.scripts.count ? `${rp.scripts.count} 个脚本均无 integrity（子资源完整性缺失，建议对第三方脚本启用 SRI）` : '无外部脚本（SRI 不适用）'));
  }

  // ============ 爬取可达性 ============
  C.push(check('crawl', 'robots.txt', rob.exists ? 'pass' : 'fail', rob.exists ? '已提供' : '缺失/空'));
  if (rob.exists) {
    C.push(check('crawl', 'robots 引用 sitemap', rob.sitemaps.length ? 'pass' : 'warn',
      rob.sitemaps.length ? rob.sitemaps.join(', ') : '未在 robots 中声明 sitemap'));
    const blocks = rob.groups.map((g) => `UA=${g.userAgents.join(',')} Disallow=[${g.disallow.join(';')}]`).join(' | ');
    C.push(check('crawl', 'robots 规则概览', 'info', blocks || '无规则'));
    // ---- Allow/Disallow same-path conflict detection (specificity trap) ----
    const rc = ev.robotsConflicts || [];
    C.push(check('crawl', 'robots 规则冲突', rc.length === 0 ? 'pass' : 'warn',
      rc.length ? `${rc.length} 处 Allow 与 Disallow 同路径冲突: ${rc.slice(0, 4).map((x) => `Allow ${x.allow} vs Disallow ${x.disallow}`).join('；')}（按“最长匹配优先”，Allow 更长时静默放行）` : '无同路径 Allow/Disallow 冲突'));
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

    // ---- sitemap language distribution: does the declared i18n show up in the inventory? ----
    if (smLang && smLang.total > 0 && smLang.missing && smLang.missing.length) {
      C.push(check('crawl', 'sitemap 语言分布', 'warn',
        `声明语言 ${smLang.byLang ? Object.keys(smLang.byLang).join('/') : ''}，sitemap 中缺失 ${smLang.missing.join(', ')}（${smLang.noPrefix} 个无语言前缀 URL 未被语言化收录）`));
    } else if (smLang && smLang.total > 0) {
      C.push(check('crawl', 'sitemap 语言分布', 'pass',
        `${Object.entries(smLang.byLang || {}).map(([k, v]) => `${k}×${v}`).join(' ')}｜无前缀 ${smLang.noPrefix || 0}`));
    }

    // ---- sitemap freshness (lastmod coverage & recency) ----
    const lastmods = sm.lastmods || [];
    if (lastmods.length) {
      const dates = lastmods.map((d) => new Date(d).getTime()).filter(Number.isFinite);
      const recent = dates.length ? Math.max(...dates) : 0;
      const daysSince = recent ? Math.max(0, Math.floor((Date.now() - recent) / 86400000)) : null;
      const coverage = Math.round((lastmods.length / Math.max(1, urls.length)) * 100);
      C.push(check('crawl', 'sitemap 新鲜度', daysSince !== null && daysSince <= 30 ? 'pass' : 'warn',
        `lastmod 覆盖 ${coverage}% 的 URL${daysSince !== null ? `｜最近更新 ${daysSince} 天前` : '｜无有效日期'}`));
    } else {
      C.push(check('crawl', 'sitemap 新鲜度', 'warn', 'sitemap 未提供 lastmod（搜索引擎难判断内容更新节奏）'));
    }

    // sitemap inventory: what share of sitemap URLs actually resolve (200)
    if (sc.total > 0) {
      const pct = Math.round((sc.ok200 / sc.total) * 100);
      const pathOf = (f) => {
        try {
          return new URL(f.url).pathname || f.url;
        } catch {
          return String(f.url || '?').slice(0, 40);
        }
      };
      C.push(check('crawl', 'sitemap 收录页可访问性', sc.failures.length === 0 ? 'pass' : sc.failures.length <= sc.total * 0.1 ? 'warn' : 'fail',
        `${sc.ok200}/${sc.total} 个 sitemap URL 返回 200（${pct}%）| 异常: ${sc.failures.slice(0, 6).map((f) => `${pathOf(f)}:${f.status}`).join(' ') || '无'}`));
      C.push(check('crawl', 'sitemap 500/异常软错误', sc.abnormal.length === 0 ? 'pass' : 'fail',
        sc.abnormal.length ? `发现 ${sc.abnormal.length} 个稳定 ${[...new Set(sc.abnormal.map((f) => f.status))].join('/')} 页: ${sc.abnormal.slice(0, 8).map(pathOf).join(', ')}` : '无 5xx/403/429 软错误'));
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

  // ---- pagination markup (rel prev/next) ----
  const pn = (rp.relPrevNext || []).length;
  C.push(check('crawl', '分页/翻页规范', pn > 0 ? 'pass' : 'info',
    pn ? `已声明分页: ${rp.relPrevNext.map((x) => `${x.rel}→${(() => { try { return new URL(x.href).pathname; } catch { return x.href; } })()}`).slice(0, 4).join(' | ')}` : '未发现 rel=prev/next 分页标记（若存在列表分页，搜索引擎可能合并/漏收录）'));


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

  // ---- social share image completeness (og:image + twitter:image) ----
  const twImg = rp.twitter && rp.twitter.image;
  const ogImg = og.image;
  C.push(check('content', '社交分享图片', ogImg && twImg ? 'pass' : ogImg || twImg ? 'warn' : 'fail',
    `og:image=${!!ogImg} twitter:image=${!!twImg}${ogImg && !twImg ? '｜缺 twitter:image（Twitter/X 分享无图）' : !ogImg && twImg ? '｜缺 og:image（Facebook/微信等无图）' : !ogImg && !twImg ? '｜两者均缺失，社交分享卡片将无图' : ''}`));

  // ---- OG vs Twitter metadata consistency ----
  const ogM = rp.og || {};
  const twM = rp.twitter || {};
  const ogTwMismatch = [];
  if (ogM.title && twM.title && String(ogM.title).trim() !== String(twM.title).trim()) ogTwMismatch.push('标题');
  if (ogM.description && twM.description && String(ogM.description).trim() !== String(twM.description).trim()) ogTwMismatch.push('描述');
  C.push(check('content', 'OG/Twitter 元数据一致性', !ogM.title && !twM.title ? 'info' : ogTwMismatch.length ? 'warn' : 'pass',
    ogM.title || twM.title
      ? ogTwMismatch.length
        ? `og 与 twitter ${ogTwMismatch.join('、')}不一致（分享卡片两平台呈现不同内容）`
        : `og 与 twitter 标题/描述一致（分享卡片统一）`
      : '未配置分享元数据'));

  // ---- article date visibility in rendered content ----
  const pageDateRe = /\b(19|20)\d{2}[-/年]\d{1,2}(?:[-/月]\d{1,2})?日?\b|发布于|更新于|时间：/;
  const dateVisible = pages.some((p) => p.parsed && p.parsed.bodyText && pageDateRe.test(p.parsed.bodyText.slice(0, 3000)));
  const hasArticlePages = pages.some((p) => /blog|article|news|post|news/i.test(p.url));
  C.push(check('content', '文章日期可见性', !hasArticlePages ? 'info' : dateVisible ? 'pass' : 'warn',
    hasArticlePages
      ? dateVisible ? '文章页正文可见日期（读者与 AI 均可判断时效）' : '文章页未在正文显示日期（时效信号弱）'
      : '未发现文章类页面'));

  // ---- local page resources: do the referenced css/js actually resolve? ----
  const localRes = (locRes.probes || []).slice(0, 2);
  if (localRes.length) {
    const bad = localRes.filter((x) => x.status === 404);
    C.push(check('content', '页面本地资源 404', bad.length === 0 ? 'pass' : 'warn',
      `${localRes.map((x) => `${x.path} → ${x.status}`).join(' | ')}${bad.length ? `｜${bad.length} 个本地资源返回 404（页面功能/样式可能残缺）` : ''}`));
  } else {
    C.push(check('content', '页面本地资源 404', 'info', '未抽样本地 css/js 资源'));
  }


  // ---- image real format: declared extension vs served Content-Type ----
  const imgTypes = ev.imgTypes || { mismatches: [], probes: [] };
  C.push(check('content', '图片格式一致性', imgTypes.mismatches && imgTypes.mismatches.length === 0 ? 'pass' : 'warn',
    imgTypes.probes && imgTypes.probes.length
      ? `抽样 ${imgTypes.probes.length} 个资源${imgTypes.mismatches && imgTypes.mismatches.length ? `｜${imgTypes.mismatches.length} 个扩展名与 Content-Type 不符: ${imgTypes.mismatches.map((m) => `${new URL(m.url).pathname} (${m.declared}→${m.contentType})`).join(' ').slice(0, 100)}` : '，扩展名与 Content-Type 一致'}`
      : '未抽样'));

  // ---- third-party host audit (privacy / supply-chain signal) ----
  const tp = rp.thirdPartyHosts || [];
  const unknownTp = tp.filter((h) => !isKnownThirdParty(h));
  C.push(check('content', '第三方域名', tp.length === 0 ? 'pass' : unknownTp.length === 0 ? 'pass' : 'warn',
    tp.length
      ? `页面引用 ${tp.length} 个外域: ${tp.join(', ').slice(0, 120)}${unknownTp.length ? `｜${unknownTp.length} 个未识别外域（隐私/供应链审查）: ${unknownTp.join(', ').slice(0, 80)}` : ''}`
      : '无第三方外域资源'));

  // ---- external resource reachability (HEAD probes against third-party hosts) ----
  const extHealth = ev.externalHealth || { probes: [], failed: [] };
  C.push(check('content', '外链资源可用性', extHealth.failed && extHealth.failed.length === 0 ? 'pass' : 'warn',
    extHealth.probes && extHealth.probes.length
      ? `抽样 ${extHealth.probes.length} 个外域资源${extHealth.failed && extHealth.failed.length ? `｜${extHealth.failed.length} 个不可达: ${extHealth.failed.slice(0, 3).join(', ')}` : '全部可达'}`
      : '未抽样'));

  // ---- duplicate no-prefix URLs (same content served twice: /path and /en/path) ----
  if (smLang && smLang.total > 0 && smLang.noPrefix > 0 && smLang.byLang && Object.values(smLang.byLang).some((v) => v > 0)) {
    C.push(check('content', '无前缀重复 URL', 'warn',
      `sitemap 中 ${smLang.noPrefix} 个无语言前缀 URL 与带前缀版本并存（双 URL 均 200，靠 canonical 缓解，建议统一收录规范语言版）`));
  } else if (smLang && smLang.total > 0) {
    C.push(check('content', '无前缀重复 URL', 'pass', 'sitemap URL 语言前缀规整，无无前缀与带前缀并存'));
  }

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

  // ---- meta robots vs X-Robots-Tag header consistency (two crawl directives) ----
  const xRobots = lower['x-robots-tag'] || null;
  const metaRobots = rp.robotsMeta || null;
  if (xRobots && metaRobots) {
    const same = String(xRobots).toLowerCase().replace(/\s+/g, '') === String(metaRobots).toLowerCase().replace(/\s+/g, '');
    C.push(check('geo', 'robots 指令一致性', same ? 'pass' : 'warn',
      `meta robots=${metaRobots} 与 X-Robots-Tag=${xRobots} 不一致（爬虫判定可能冲突）`));
  } else {
    C.push(check('geo', 'robots 指令一致性', xRobots ? 'pass' : 'info',
      xRobots ? `X-Robots-Tag: ${xRobots}` : '无 X-Robots-Tag 头（HTTP 层未下发抓取指令）'));
  }

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

  // ---- GEO extended signals (best-practice additions, zero extra requests) ----
  const dens = geoX.dataDensity || { points: 0, per500: 0, wordCount: 0 };
  C.push(check('geo', '数据引用密度', dens.wordCount ? (dens.per500 >= 3 ? 'pass' : dens.per500 >= 1 ? 'warn' : 'fail') : 'info',
    dens.wordCount
      ? `正文 ${dens.wordCount} 词 · 具体数据点 ${dens.points} 个 · 每 500 词 ${dens.per500} 个${dens.per500 >= 3 ? '（≥3，符合 Princeton 可引用密度）' : dens.per500 >= 1 ? '（低于 3/500 词，AI 引用证据不足）' : '（几乎无具体数据，AI 难以引用）'}`
      : '无正文可统计'));

  const ds = geoX.dateSignals || {};
  // 无 datePublished 在纯营销/静态官网属正常（无"文章"语义），判 info 而非 warn；
  // 内容型站点（有文章页）的日期可见性由「文章日期可见性」检查单独覆盖。
  const dateSt = ds.published ? (ds.gapDays !== null && ds.gapDays <= 365 ? 'pass' : 'warn') : 'info';
  C.push(check('geo', '日期信号', dateSt,
    ds.published
      ? `published=${String(ds.published).slice(0, 10)}${ds.modified ? ` modified=${String(ds.modified).slice(0, 10)}` : ''}${ds.gapDays !== null ? ` · 更新间隔 ${ds.gapDays} 天${ds.gapDays > 365 ? '（超 12 个月，陈旧）' : ''}` : ''}（来源: ${ds.source}）`
      : '未发现 datePublished/dateModified（静态营销页可接受；文章页应有日期，由「文章日期可见性」覆盖）'));

  const ab = geoX.authorByline || {};
  C.push(check('geo', '作者署名 (E-E-A-T)', ab.author ? 'pass' : 'info',
    ab.author ? `作者: ${ab.author}（来源: ${ab.source}）` : '未发现作者署名（AI 引用缺少 E-E-A-T 锚点）'));

  const cites = geoX.authoritativeCitations || { total: 0, authoritative: 0, hosts: [], authoritativeHosts: [] };
  C.push(check('geo', '权威来源引用', cites.total ? (cites.authoritative > 0 ? 'pass' : 'warn') : 'info',
    cites.total
      ? `外链 ${cites.total} 个 · 权威域 ${cites.authoritative} 个${cites.authoritative ? `: ${cites.authoritativeHosts.join(', ')}` : '（无政府/学术/标准机构来源，可信度信号弱）'}`
      : '页面无外部引用链接'));

  const ec = geoX.entityConsistency || { declared: false };
  const ecSt = !ec.declared ? 'info' : ec.nameConsistent === null ? 'info' : ec.nameConsistent ? 'pass' : 'warn';
  C.push(check('geo', '实体一致性', ecSt,
    ec.declared
      ? `Organization schema name=${ec.name || '?'} vs 页面标题「${(ec.title || '').slice(0, 30)}」${ec.nameConsistent === null ? '（无法比对，标题过短/不同）' : ec.nameConsistent ? '（一致）' : '（不一致，AI 实体识别可能错乱）'}${ec.logo ? ` · logo ${ec.logoOnPage ? '页面可见' : '页面未见'}` : ''}`
      : '未声明 Organization 实体（无一致性可核）'));

  const ls = geoX.llmsStructure || { specCompliant: false, langVersions: 0, langIndex: false };
  // 多语言站点口径：站点有独立语言路径时要求「根合规 + 三语索引 + ≥2 语言版」→ pass；
  // 根合规但语言版/索引不完整 → warn；单语站点根合规即 pass（不误伤）。
  const isMultilingual = lang200.length > 0 || (rp.hreflang || []).length > 1;
  const multilingualOk = ls.specCompliant && (!isMultilingual || (ls.langIndex && (ls.langVersions || 0) >= 2));
  C.push(check('geo', 'llms.txt 结构规范', multilingualOk ? 'pass' : ls.specCompliant ? 'warn' : (llms.found ? 'warn' : 'info'),
    llms.found
      ? `H1${ls.h1 ? ' ✓' : ' ✗'} · blockquote${ls.blockquote ? ' ✓' : ' ✗'} · H2 分区 ${ls.sections} · 链接 ${ls.links} 个${ls.described ? `（${ls.described} 带描述）` : ''} · 语言版 ${ls.langVersions || 0} 个${isMultilingual ? (ls.langIndex ? ' · 根含三语索引 ✓' : ' · 根无三语索引 ✗') : ''}${multilingualOk ? (isMultilingual ? '（三语 llms.txt 体系符合规范）' : '（符合 llms.txt 规范）') : ls.specCompliant ? '（根文件合规，但多语言版本/索引不完整）' : '（未完全符合规范：需 H1 品牌名 + blockquote 描述 + H2 分类 + 链接带描述）'}`
      : '未发现 /llms.txt'));

  const sh = geoX.staticHtmlContent || { textLength: 0, h1s: 0, staticOk: false };
  C.push(check('geo', '关键内容静态 HTML', sh.staticOk ? 'pass' : sh.textLength > 0 ? 'warn' : 'fail',
    sh.staticOk
      ? `正文 ${sh.textLength} 字符 + H1 ${sh.h1s} 个，均以静态 HTML 呈现（AI 爬虫无需执行 JS 即可读）`
      : `正文 ${sh.textLength} 字符 · H1 ${sh.h1s} 个${sh.textLength < 800 ? '（核心内容疑似依赖 JS 渲染，AI 爬虫可能读不到）' : ''}`));

  const aigc = geoX.aigcDisclosure || { declared: false };
  C.push(check('geo', 'AI 生成内容标识', aigc.declared ? 'info' : 'warn',
    aigc.declared ? `已声明 AI 生成内容: 「${aigc.match}」（GB 45438 标识方向）` : '未发现 AI 生成内容声明（若含 AI 生成内容，建议按 GB 45438 做标识）'));

  const qa = geoX.qaBlocks || { count: 0 };
  C.push(check('geo', '问答块 (答案块)', qa.count > 0 ? 'pass' : 'info',
    qa.count
      ? `问答信号 ${qa.count} 处${qa.questionHeadings ? `（问句标题 ${qa.questionHeadings}）` : ''}${qa.details ? `（details/summary ${qa.details}）` : ''}${qa.faqText ? '（FAQ 文本）' : ''}${qa.samples && qa.samples.length ? `｜示例: ${qa.samples.slice(0, 2).join('; ')}` : ''}`
      : '未发现问答/答案块结构（AI 直接回答时缺少可引用的 Q&A 片段）'));


  // ============ 性能 ============
  const cssCount = (rp.stylesheets && rp.stylesheets.count) || 0;
  const resCount = (rp.scripts ? rp.scripts.count : 0) + cssCount + (rp.images ? rp.images.count : 0);
  C.push(check('perf', '首屏资源量', resCount < 50 ? 'pass' : resCount < 100 ? 'warn' : 'fail',
    `script×${rp.scripts ? rp.scripts.count : 0} + css×${cssCount} + img×${rp.images ? rp.images.count : 0} = ${resCount}`));
  C.push(check('perf', '渲染阻塞脚本', (rp.scripts && rp.scripts.blocking) || 0 <= 3 ? 'pass' : 'warn',
    `${rp.scripts ? rp.scripts.blocking : 0} 个无 defer/async 的外部脚本`));
  C.push(check('perf', '图片懒加载', rp.images && rp.images.lazy > 0 ? 'pass' : 'info',
    `${rp.images ? rp.images.lazy : 0}/${rp.images ? rp.images.count : 0} 张图启用懒加载`));

  // ---- resource hints (preconnect/preload/dns-prefetch) ----
  const hints = (rp.resourceHints || []).length;
  C.push(check('perf', '资源预连接提示', hints > 0 ? 'pass' : 'info',
    hints ? `${rp.resourceHints.map((x) => `${x.rel}→${(() => { try { return new URL(x.href).hostname || x.href; } catch { return x.href; } })()}`).slice(0, 5).join(' | ')}（共 ${hints} 条）` : '未发现 preconnect/preload/dns-prefetch（第三方资源握手未预热）'));

  // ---- LCP candidate: biggest first-viewport element as a rough Web-Vitals proxy ----
  const lcp = ev.lcpCandidate || null;
  C.push(check('perf', 'LCP 候选元素', 'info',
    lcp ? lcp.detail : '未识别（首页资源样本不足以判定最大首屏元素）'));

  // ---- static asset cache policy (immutable long-lived assets reduce repeat TTFB) ----
  const cpol = ev.cachePolicy || { probes: [] };
  if (cpol.probes && cpol.probes.length) {
    const good = cpol.probes.filter((p) => p.immutable || (p.cacheControl && /max-age=(\d{7,})/.test(p.cacheControl)));
    C.push(check('perf', '静态资源缓存策略', good.length === cpol.probes.length ? 'pass' : good.length > 0 ? 'warn' : 'fail',
      `${cpol.probes.map((p) => `${new URL(p.url).pathname.slice(-24)}: ${p.cacheControl || '无 Cache-Control'}${p.immutable ? ' (immutable)' : ''}`).join(' | ')}`));
  } else {
    C.push(check('perf', '静态资源缓存策略', 'info', '未抽样静态资源'));
  }

  // ============ 多语言 (i18n) ============
  const i18nProbes = (ev.i18n && ev.i18n.probes) || [];
  if (i18nProbes.length) {
    const ok = i18nProbes.filter((p) => p.status === 200);
    const zero = ok.filter((p) => p.hreflangCount === 0);
    const partial = ok.filter((p) => p.hreflangCount > 0 && (p.hreflangCount < 3 || !p.hasXDefault));
    const st = ok.length && zero.length === 0 && partial.length === 0 ? 'pass' : zero.length ? 'fail' : 'warn';
    C.push(check('i18n', '首页 hreflang 对称性', st,
      ok.length
        ? `${ok.map((p) => `${p.lang}: ${p.hreflangCount} 条${p.hasXDefault ? '' : '（缺 x-default）'}`).join(' ｜ ')}${zero.length ? `｜${zero.map((p) => p.lang).join(', ')} 首页 hreflang=0（语言版本间无互认，搜索会视为独立单语站）` : partial.length ? `｜${partial.map((p) => p.lang).join(', ')} 组不完整` : ''}`
        : '语言首页不可达'));
  } else {
    C.push(check('i18n', '首页 hreflang 对称性', 'info', '未探测语言首页'));
  }

  const l404 = ev.lang404 || {};
  C.push(check('i18n', '404 页本地化',
    l404.consistent === true ? 'pass' : l404.consistent === false ? 'warn' : 'info',
    l404.note || '未探测 404 页语言一致性'));

  const switcher = rp.langSwitcher || {};
  C.push(check('i18n', '语言切换器', switcher.found ? 'pass' : 'info',
    switcher.found ? `页面内提供 ${switcher.links.length} 个语言切换链接（与 hreflang 互证）` : '页面内未见语言切换链接（用户只能靠 URL 猜语言版）'));

  // ---- hreflang casing consistency across pages (zh-hans vs zh-Hans) ----
  {
    const allTags = [];
    for (const p of i18nProbes) if (p.tags) allTags.push(...p.tags);
    const rootTags = (rp.hreflang || []).map((x) => x.hreflang);
    const merged = [...rootTags, ...allTags];
    const variants = new Map();
    for (const t of merged) {
      const n = normLang(t);
      if (!variants.has(n)) variants.set(n, new Set());
      variants.get(n).add(t);
    }
    const mixed = [...variants.values()].filter((s) => s.size > 1);
    C.push(check('i18n', 'hreflang 大小写统一', mixed.length === 0 ? 'pass' : 'info',
      mixed.length
        ? `同语言存在大小写变体（如 ${[...mixed[0]].join(' / ')}），建议统一 BCP47 规范写法`
        : `hreflang 写法统一（${[...variants.keys()].slice(0, 6).join(', ')}）`));
  }

  const cov = ev.i18nCoverage || {};
  C.push(check('i18n', '多语言文章覆盖度', cov.total ? (cov.gapPct <= 10 ? 'pass' : 'warn') : 'info',
    cov.total ? `文章级 URL ${cov.total} 个，三语齐全 ${cov.covered} 个，缺口 ${cov.gapPct}%${cov.gaps && cov.gaps.length ? `（如 ${cov.gaps.slice(0, 2).map((g) => g.slug).join(', ')}）` : ''}` : 'sitemap 无文章 URL，无法计算'));

  // ============ CDN / 缓存 ============
  const hits = ev.cdnHits || {};
  if (hits.samples && hits.samples.length) {
    const st = hits.hitRate >= 2 / 3 ? 'pass' : hits.hitRate > 0 ? 'warn' : 'fail';
    C.push(check('cdn', 'CDN 缓存命中率', st,
      `采样 ${hits.samples.length} 次: 命中 ${hits.hit} / 未命中 ${hits.miss} / 其他 ${hits.other}（命中率 ${Math.round((hits.hitRate || 0) * 100)}%）${hits.miss >= hits.hit ? '｜连续 MISS 表明回源频繁，边缘缓存形同虚设' : '｜缓存工作正常'}`));
  } else {
    C.push(check('cdn', 'CDN 缓存命中率', 'info', '未采样缓存头'));
  }

  // ============ 子域 ============
  const subs = ev.subdomains || { probes: [] };
  const served = (subs.probes || []).filter((p) => p.hasDns);
  if (served.length) {
    const bad = served.filter((p) => p.status >= 400 || p.error);
    C.push(check('subdomains', '子域健康巡检', bad.length === 0 ? 'pass' : 'warn',
      `${served.map((p) => `${p.name}: ${p.status || 'ERR'}${p.error ? `(${p.error})` : ''}`).join(' | ')}${bad.length ? `｜${bad.length} 个子域异常（403/502 等，见证书 SAN 与部署核对）` : ''}`));
  } else {
    C.push(check('subdomains', '子域健康巡检', 'info', '未发现解析的子域（仅主域提供服务）'));
  }

  // ============ 暴露面 ============
  const exp = ev.exposure || { probes: [] };
  const reachable = (exp.probes || []).filter((p) => p.status === 200 || p.status === 302 || p.status === 301);
  C.push(check('exposure', '后台/隐藏路径', reachable.length === 0 ? 'pass' : 'warn',
    reachable.length
      ? `可访问 ${reachable.length} 个非公开路径: ${reachable.map((p) => `${p.path}(${p.status})`).join(' ')}${
          reachable.some((p) => /wp-(json|admin|content|login)|xmlrpc/i.test(p.path))
            ? '｜识别为 WordPress 后端，建议核对补丁版本并收紧访问'
            : ''
        }`
      : '全部非公开路径返回 4xx（暴露面收敛）'));

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

/** Weighted overall score (0–100) + per-group breakdown + letter grade.
 *  Groups follow the GEO-first positioning of this engine:
 *    GEO 30% · SEO 25% · 技术 20% · 性能 15% · 暴露面/子域 10%
 *  Per-item weight: pass=1 · info=0.5 · warn=0.3 · fail=0. */
function computeScore(checks) {
  const GROUPS = [
    { key: 'geo', name: 'GEO', weight: 0.3, dims: ['geo', 'i18n'] },
    { key: 'seo', name: 'SEO', weight: 0.25, dims: ['content', 'crawl'] },
    { key: 'tech', name: '技术', weight: 0.2, dims: ['domain', 'tech', 'security', 'platform'] },
    { key: 'perf', name: '性能', weight: 0.15, dims: ['perf', 'cdn'] },
    { key: 'edge', name: '暴露面/子域', weight: 0.1, dims: ['subdomains', 'exposure'] },
  ];
  const w = { pass: 1, info: 0.5, warn: 0.3, fail: 0 };
  const groups = GROUPS.map((g) => {
    const items = (checks || []).filter((c) => g.dims.includes(c.dimension));
    const total = items.length;
    const sum = items.reduce((a, c) => a + (w[c.status] !== undefined ? w[c.status] : 0.5), 0);
    return {
      key: g.key, name: g.name, weight: g.weight, total,
      score: total ? Math.round((sum / total) * 1000) / 10 : null,
      pass: items.filter((c) => c.status === 'pass').length,
      info: items.filter((c) => c.status === 'info').length,
      warn: items.filter((c) => c.status === 'warn').length,
      fail: items.filter((c) => c.status === 'fail').length,
    };
  });
  const weighted = groups.filter((g) => g.score !== null);
  const total = Math.round(weighted.reduce((a, g) => a + g.score * g.weight, 0) * 10) / 10;
  const grade = total >= 90 ? 'A' : total >= 75 ? 'B' : total >= 60 ? 'C' : 'D';
  return { total, grade, groups, covered: weighted.reduce((a, g) => a + g.total, 0) };
}

module.exports = { buildChecks, computeScore };
