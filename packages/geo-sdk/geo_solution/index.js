/**
 * geo_solution domain — GEO/SEO 优化实施方案生成器
 * ============================================================================
 * Consumes the site's latest diagnosis report (produced by diagnose_site +
 * report_write) and deterministically assembles a full implementation plan
 * covering the union of the Junteng / Greatmat optimization plan structures:
 *
 *   上篇 技术修复/重建（§1–§9）   中篇 关键词矩阵与内容（§10–§12）
 *   价值桥接（§13）             下篇 实施保障（§14–§18）＋附录（§19）
 *   quote=true 时追加 报价方案（§20）＋年度例行费用（§21）
 *
 * Design principles (mirroring diagnose):
 *   - deterministic, auditable, no LLM dependency;
 *   - every claim is anchored to evidence parsed from the diagnosis report;
 *     where the report has no evidence a "待验证/待补充" placeholder is emitted
 *     (never invented numbers);
 *   - plan lands at <SITES_ROOT>/<site>/data/plans/<YYYYMMDD>-<site>-geo-solution.md
 *
 * Exposed externally as t.geo_solution (lazy domain, see ../../index.js).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// report discovery + parsing
// ---------------------------------------------------------------------------

/** Latest diagnosis report in <siteDir>/data/reports (name-based, newest first). */
function findLatestReport(siteDir) {
  const reportsDir = path.join(siteDir, 'data', 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => b.localeCompare(a));
  if (!files.length) return null;
  return { name: files[0], fullPath: path.join(reportsDir, files[0]) };
}

/** Extract the first markdown table cell (inline code / plain text trimmed). */
function cell(text) {
  return String(text || '').replace(/^`+|`+$/g, '').trim();
}

/** Split a markdown table row into cells. */
function rowCells(line) {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((s) => cell(s));
}

/**
 * Parse a diagnosis report markdown into the evidence object the plan builder
 * needs. The report follows references/report-template.md (14 sections), so
 * section-level line scans are reliable.
 */
function parseReport(md, siteKey) {
  const lines = md.split(/\r?\n/);
  const firstLine = (lines[0] || '').trim();
  const titleM = firstLine.match(/^#\s+(.+?)\s+GEO\/SEO/);
  const out = {
    siteKey,
    domain: (titleM && titleM[1]) || siteKey.replace(/_/g, '.'),
    diagTime: '',
    dimensions: [], // { name, score, note }
    p0: [], // { id, evidence, impact, fix }
    fails: [], // { dim, name, detail }
    warns: [],
    passes: [],
    cite: {}, // Crawlable/Identifiable/Trustworthy/Extractable scores
    geoReady: '',
    scaleRows: [], // { type, sitemap, reachable, finding }
    llms: '', // §7.2 verdict line
    aiReach: '', // §7.3 verdict line
    jsonld: '', // §7.1 verdict line
    multilang: '', // §6.3 verdict line
    renderMode: '', // SSR / JS 空壳 judgement
    security: '', // §4.4 verdict
    robotsSitemap: '', // §4.5 verdict
    keywordGap: '', // §9 keywords gap
  };

  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // header metadata
    const diagM = line.match(/诊断时间：([^\s　]+)/);
    if (diagM && !out.diagTime) out.diagTime = diagM[1];
    const domainM = line.match(/站点 key：([a-z0-9_]+)/);
    if (domainM) out.siteKey = domainM[1];

    // track section by heading
    const hM = line.match(/^##{1,3} (.*)$/);
    if (hM) {
      section = hM[1].trim();
      continue;
    }

    // -- §1 健康度总评 table (dimension | score | note) --
    if (section.startsWith('健康度总评') && line.startsWith('|') && !line.includes('维度 | 评分')) {
      const c = rowCells(line);
      if (c.length >= 3 && /\/\s*10/.test(c[1]) && !c.every((x) => /^-+$/.test(x))) {
        out.dimensions.push({ name: cell(c[0]), score: cell(c[1]), note: cell(c[2]) });
      }
    }
    // GEO 就绪度 line (either §1 "GEO 就绪度：" or §8 "GEO 就绪度 ≈")
    {
      const gm = line.match(/GEO 就绪度[：≈][^*。]*/);
      if (gm && !out.geoReady) out.geoReady = gm[0];
    }

    // -- §1 "必须立刻处理的问题" numbered list: "1. **<name>** —— <evidence> + <impact>" --
    if (/^\d+\. \*\*/.test(line) && /影响/.test(line)) {
      const body = line.replace(/^\d+\.\s*/, '');
      out.p0.push(body);
    }

    // -- §2 规模盘点 table --
    if (section.startsWith('2.1 URL 规模实测') && line.startsWith('|') && !line.includes('页面类型 | sitemap')) {
      const c = rowCells(line);
      if (c.length >= 4 && c[0] !== '**合计**' && !c.every((x) => /^[-:\s]+$/.test(x))) {
        out.scaleRows.push({ type: c[0], sitemap: c[1], reachable: c[2], finding: c[3] });
      }
    }

    // -- §4 verdict lines. Headings may be h3 ("4.4 安全响应头与 Cookie") OR flat
    //    list items ("- **4.4 …**") depending on the report template used — accept both. --
    if ((section.startsWith('4.4') || /^- \*\*4\.4/.test(line.trim())) && line.trim().startsWith('- ')) out.security += line.trim().slice(2) + ' ';
    if ((section.startsWith('4.5') || /^- \*\*4\.5/.test(line.trim())) && line.trim().startsWith('- ')) out.robotsSitemap += line.trim().slice(2) + ' ';

    // -- §5 渲染判定 (JS 空壳 / SSR) --
    if ((section.startsWith('5.5') || /^- \*\*5\.5/.test(line.trim())) && !out.renderMode && (line.includes('SSR') || line.includes('空壳'))) {
      out.renderMode = line.trim();
    }

    // -- §6.3 多语言 --
    if ((section.startsWith('6.3') || /^- \*\*6\.3/.test(line.trim())) && line.trim().startsWith('- ')) out.multilang += line.trim().slice(2) + ' ';

    // -- §7 verdicts --
    if ((section.startsWith('7.1') || /^- \*\*7\.1/.test(line.trim())) && line.trim().startsWith('- ')) out.jsonld += line.trim().slice(2) + ' ';
    if ((section.startsWith('7.2') || /^- \*\*7\.2/.test(line.trim())) && line.trim().startsWith('- ')) out.llms += line.trim().slice(2) + ' ';
    if ((section.startsWith('7.3') || /^- \*\*7\.3/.test(line.trim())) && line.trim().startsWith('- ')) out.aiReach += line.trim().slice(2) + ' ';

    // -- §8 CITE table --
    if (section.includes('GEO 专项') && line.startsWith('|') && !line.includes('维度 | 现状')) {
      const c = rowCells(line);
      if (c.length >= 3 && /\/\s*10/.test(c[2]) && !c.every((x) => /^-+$/.test(x))) out.cite[cell(c[0])] = cell(c[2]);
    }

    // -- §9 keyword gap --
    if (section.startsWith('9. 关键词') && line.trim().startsWith('- SERP')) out.keywordGap = line.trim();

    // -- §11 problem table rows (优先级 | 问题 | 类别 | 成本) --
    if (section.startsWith('11. 问题汇总') && line.startsWith('|') && !line.includes('优先级 | 问题')) {
      const c = rowCells(line);
      if (c.length >= 3 && /^P[0-2]$/.test(cell(c[0]))) {
        const bucket = c[0] === 'P0' ? out.fails : out.warns;
        bucket.push({ pri: cell(c[0]), problem: cell(c[1]), category: cell(c[2]), cost: cell(c[3] || '') });
      }
    }

    // -- CITE conclusion line under §8 table --
    if (line.includes('GEO 就绪度 ≈') && !out.geoReady.includes('CITE')) {
      if (!out.geoReady) out.geoReady = line.replace(/^\*?\*?|[*>\s]*$/g, '').trim();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// plan assembly
// ---------------------------------------------------------------------------

const DEFAULT_UNIT_RATES = {
  '项目经理': 1260,
  'UI/视觉设计师': 1400,
  '前端开发工程师': 1490,
  '服务器运维': 1150,
  'SEO 策略师': 1830,
  'SEO 运营专员': 970,
};

/** Present evidence with a clear "待验证" fallback when the report has none. */
function ev(text, fallback = '待验证/待补充（诊断报告中无此证据，需人工核实）') {
  return (text && text.trim()) ? text.trim() : fallback;
}

/** Judge whether the diagnosis flagged the site as a JS shell (true) vs SSR (false).
 *  "疑似 JS 空壳（失真）…非空壳" must resolve to FALSE (the verdict says NOT a shell). */
function isShellMode(rm) {
  if (!rm) return false;
  const norm = String(rm).replace(/\s+/g, '');
  if (/(非js空壳|非空壳|不是空壳|无空壳|非壳)/i.test(norm)) return false;
  return /(js空壳|服务端.*空壳|html.*空壳|空壳)/i.test(norm);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

/** Count top-level h2 chapters, ignoring ``` code blocks (llms.txt/article samples contain ## lines). */
function countChapters(content) {
  let inCode = false;
  let n = 0;
  for (const line of content.split('\n')) {
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (!inCode && /^## /.test(line)) n++;
  }
  return n;
}

function buildPlan(parsed, opts) {
  const { lang = 'zh', brandName = '', industry = '', quote = false, unitRates = {} } = opts;
  const zh = lang !== 'en';
  const rates = { ...DEFAULT_UNIT_RATES, ...unitRates };
  const dims = parsed.dimensions || [];
  const shell = isShellMode(parsed.renderMode);
  const host = parsed.domain.startsWith('www.') ? parsed.domain : `www.${parsed.domain}`;
  const dim = (kw) => {
    const hit = dims.find((d) => d.name.includes(kw));
    return hit ? { score: hit.score, note: hit.note } : { score: '—', note: '—' };
  };
  const cite = (k) => {
    const v = (parsed.cite && parsed.cite[k]) || '—';
    if (v === '—') return '—';
    const m = String(v).match(/(\d+(?:\.\d+)?)\s*\/\s*10/);
    return m ? m[1] : v;
  };
  const scale = parsed.scaleRows || [];

  const L = (zhTxt, enTxt) => (zh ? zhTxt : enTxt);

  const md = [];
  md.push(`# ${parsed.domain} GEO/SEO 优化实施方案`);
  md.push('');
  md.push(`> 方案性质：基于《${parsed.domain} GEO/SEO 全面诊断报告》（诊断时间：${parsed.diagTime || '待补充'}）的落地实施计划`);
  md.push(`> 站点 key：${parsed.siteKey}　方案路径：data/plans/${todayStamp()}-${parsed.siteKey}-geo-solution.md`);
  if (brandName) md.push(`> 品牌：${brandName}`);
  if (industry) md.push(`> 行业：${industry}`);
  md.push(`> 生成方式：确定性组装（读取诊断报告证据；无证据处标注"待验证/待补充"，不编造数值）`);
  md.push('');
  md.push('---');
  md.push('');

  // ============================ 上篇：技术修复/重建 ============================
  md.push(`## 一、方案总览与核心策略`);
  md.push('');
  md.push(`### 1.1 方案背景`);
  md.push('');
  md.push(`基于诊断报告实测，${parsed.domain} 存在一组根因问题（诊断 fail 项）：`);
  md.push('');
  for (const f of parsed.fails) {
    md.push(`- **${f.pri}·${f.problem}**（${f.category}，修复成本 ${f.cost}）`);
  }
  if (!parsed.fails.length) md.push('- （诊断报告未提供明确 fail 项清单，以下策略基于 warn/待验证项，需人工复核）');
  md.push('');
  md.push(`诊断健康度：${dims.length ? dims.map((d) => `${d.name} ${d.score}`).join('；') : '待补充'}。`);
  if (parsed.geoReady) md.push(`${parsed.geoReady.replace(/^GEO 就绪度[：≈]\s*/, '')}。`);
  md.push('');
  md.push(`### 1.2 核心策略：${shell ? '重建服务端渲染（SSR）' : '在现有渲染方式上修复与加固（不推倒重建）'}`);
  md.push('');
  md.push(shell
    ? `诊断判定 ${parsed.domain} 为 JS 空壳/服务端输出不足（${ev(parsed.renderMode)}），朴素爬虫与 AI 爬虫默认不执行 JavaScript。正确路径是**重建服务端渲染（SSR）的公开官网**，让产品、文章、认证的实体与正文直接进入 HTML 与 JSON-LD。`
    : `诊断判定 ${parsed.domain} 内容可被朴素爬虫与 AI 爬虫直接读取（${ev(parsed.renderMode)}）。无需推倒重建，正确路径是**在现有模板上做服务端配置与输出修复**，把"可读但不可索引 / 不可引用"的现状，改为"全量可索引 + 结构化可引用"。`);
  md.push('');
  md.push(`- **索引层**：补全 sitemap 至全量真实 URL、清理异常状态路由、junk 页 noindex、全站加 canonical；`);
  md.push(`- **呈现层**：每页唯一 Title / Meta、图片补 alt、修混合内容、补语义化面包屑；`);
  md.push(`- **GEO 层**：服务端输出 Organization / Product / Article / BreadcrumbList / FAQPage 的 JSON-LD，部署 /llms.txt；`);
  md.push(`- **国际化层**：独立 /en/ URL 体系 + hreflang，让英文站可被索引（若诊断确认存在多语言需求）；`);
  md.push(`- **性能/安全层**：接入 CDN、合理缓存头、HTTP/2、补齐安全头，Cookie 加 Secure / HttpOnly / SameSite。`);
  md.push('');
  md.push(`### 1.3 方案两大重点`);
  md.push('');
  md.push(`| 重点 | 目标 | 对应篇章 |`);
  md.push(`|---|---|---|`);
  md.push(`| 重点一：技术修复/重建 | 让全量内容可索引、可规范化、可被 AI 引用（sitemap 补全 + 异常清理 + Schema + llms.txt + 独立英文 URL + CDN） | 上篇（一~九章） |`);
  md.push(`| 重点二：关键词矩阵与内容 | 用结构化关键词矩阵 + ≤200 篇中英文章，占领品类词 / 长尾 / 国际采购词 | 中篇（十~十二章） |`);
  md.push('');
  md.push(`### 1.4 方案预期目标（对照诊断评分）`);
  md.push('');
  md.push(`| 维度 | 诊断评分 | 交付目标 |`);
  md.push(`|---|---|---|`);
  const TARGETS = [
    ['技术基础设施', 'HTTP/2、HTTPS、证书、gzip 达标；补缓存头/IPv6'],
    ['内容可抓取性', '渲染方式修复后全量页面进入 sitemap，AI 可读取'],
    ['页面 SEO 基础', '差异化 Title / Description / Canonical 全站覆盖'],
    ['索引架构', '有效 Sitemap + 统一 www 规范 + 异常状态清零'],
    ['结构化数据', 'Organization / Product / Article / FAQPage / BreadcrumbList 全站化'],
    ['多语言 / 国际化', '中英双语独立 URL 上线，hreflang 正确'],
    ['性能与 CDN', '前置 CDN，LCP / CLS / INP 达标'],
    ['安全', '安全头补齐、Cookie 安全标志、apex TLS 可用'],
    ['GEO / AI 可引用性', 'llms.txt + JSON-LD + FAQ，进入 AI 引用池'],
  ];
  for (const [name, target] of TARGETS) {
    const d = dim(name);
    md.push(`| ${name} | ${d.score} | ${target} |`);
  }
  md.push('');
  md.push(`### 1.5 过渡期策略：零重构 GEO 快速止血`);
  md.push('');
  md.push(`在完整改造上线前，先行在现有站做**零内容改动的低成本止血**，数天内释放 GEO 价值：`);
  md.push('');
  md.push(`- 在服务端把核心实体（Organization + Product / Article）的 JSON-LD 直接注入现有页面 \`<head>\`，AI 爬虫即便仅读 HTML 也能抽取实体与要点；`);
  md.push(`- 部署 \`/llms.txt\`，列明站点定位、核心产品/服务、认证资质、重点页面，作为 AI 的"站点说明书"；`);
  md.push(`- robots.txt 补 Sitemap 指令并放行 AI 爬虫（GPTBot / ClaudeBot / PerplexityBot / Applebot / Google-Extended）；`);
  md.push(`- sitemap 先行补全至全量真实 URL，让搜索引擎立即拿到完整清单；`);
  md.push(`- 止血层与后续模板改造自然衔接，不重复投入。`);
  md.push('');

  // 二、技术栈选型
  md.push(`## 二、技术栈选型与处置建议`);
  md.push('');
  md.push(`依据诊断的渲染方式判定（${ev(parsed.renderMode)}）：`);
  md.push('');
  if (shell) {
    md.push(`### 2.1 选型：重建 SSR（推荐 WordPress + 手写前端）`);
    md.push('');
    md.push(`- CMS 选服务端渲染方案（如 WordPress + 手写主题），内容直接进 HTML，解决"机器读不到"的根因；`);
    md.push(`- 现有 API/结构化数据（若有）迁移进 CMS（产品用自定义文章类型 + 字段，文章用文章库），一次性盘活已有资产；`);
    md.push(`- SEO 插件（如 Rank Math）覆盖 Sitemap / Canonical / Schema；多语言插件（如 Polylang）输出 hreflang；`);
    md.push(`- 旧路由全量 301 到新语义 URL（见第五章映射表）。`);
  } else {
    md.push(`### 2.1 选型：维持现有渲染 + 服务端配置修复`);
    md.push('');
    md.push(`- 保留现有服务端渲染栈，仅修复模板输出（Title/Meta/canonical/面包屑/JSON-LD/alt）；`);
    md.push(`- 服务器层接入边缘 CDN、补安全头、修缓存头；`);
    md.push(`- 多语言若为查询参数切换，改为独立 /en/ URL 体系 + hreflang；`);
    md.push(`- 统计代码升级为 GA4 + 百度统计（若诊断确认旧代码已停用）。`);
  }
  md.push('');
  md.push(`### 2.2 服务端修复技术规范（通用）`);
  md.push('');
  md.push(`- 模板层为每个页面产出**唯一 \`<title>\` + 唯一 Meta Description**，杜绝全站堆砌同一串关键词；`);
  md.push(`- 每个页面自指 \`<link rel="canonical">\`，英文版用 \`hreflang\` 互链、互不 canonical；`);
  md.push(`- 图片强制 \`width\` / \`height\` + \`loading="lazy"\` + \`alt\`；`);
  md.push(`- 语义化标签（\`<header>\` / \`<main>\` / \`<article>\` / \`<section>\` / \`<nav>\`），每页唯一 \`<h1>\`、层级不跳级；`);
  md.push(`- 服务端统一输出 JSON-LD（Organization / Product / NewsArticle / BreadcrumbList / FAQPage）。`);
  md.push('');

  // 三、业务页面架构
  md.push(`## 三、业务页面架构方案`);
  md.push('');
  md.push(`### 3.1 业务页面架构建议（第一期，一个半月）`);
  md.push('');
  md.push(`聚焦 7 类业务页面，**默认展示中文内容**，英文版由 AI 翻译生成、经人工审核，不引入第三方专业翻译；其余页面类型暂不在本期范围：`);
  md.push('');
  md.push(`| 页面类型 | 数量 | 说明 | 默认语言 | 英文处理 |`);
  md.push(`|---|---|---|---|---|`);
  md.push(`| 首页 | 1 | 定位 + 产品/服务入口 + 认证条 + 文库入口 | 中文 | AI 翻译 |`);
  md.push(`| 产品/服务列表页 | 按系列 | 系列列表，参数表 + 图文 | 中文 | AI 翻译 |`);
  md.push(`| 产品/服务详情页 | 按型号 | 具体型号，含参数表 + 产品 FAQ | 中文 | AI 翻译 |`);
  md.push(`| 文库列表页 | 1 | 文章归档、分类、分页 | 中文 | AI 翻译 |`);
  md.push(`| 文库详情页 | 按现有 | 现有文章重构改写，每篇含 H 层级 / Meta / NewsArticle Schema / 内链 | 中文 | AI 翻译 |`);
  md.push(`| 品牌信任页 | 4 | 关于我们 / 认证资质 / 可持续发展或行业 / 联系我们 | 中文 | AI 翻译 |`);
  md.push(`| FAQ 页 | 1+ | 采购参数 + 选型问答（结构化 FAQPage） | 中文 | AI 翻译 |`);
  md.push('');
  md.push(`### 3.2 内链架构方案（hub-and-spoke）`);
  md.push('');
  md.push(`- 产品/服务系列页为枢纽，卫星文章 / 型号页正文插入 2–3 个指向同簇系列页 / 应用页的内链；`);
  md.push(`- 详情页互链同系列其他型号与应用方案页；`);
  md.push(`- 首页与导航集中导出权重到系列与支柱页，形成可爬、可引用的主题闭环。`);
  md.push('');

  // 四、HTTPS/SSL
  md.push(`## 四、HTTPS / SSL 安全配置方案`);
  md.push('');
  md.push(`### 4.1 现状与目标`);
  md.push('');
  md.push(`- 诊断证据：${ev(parsed.security, '安全响应头/Cookie/apex TLS 状态详见诊断报告 §4.4')}`);
  md.push(`- 目标：A+ 配置——HSTS、TLS 1.2+/1.3、OCSP Stapling、证书自动续期（Let's Encrypt，覆盖 apex 与 www）；http/https × 非 www/www 均一步 301 至 \`https://www\`。`);
  md.push('');
  md.push(`### 4.2 Nginx HTTPS 完整配置模板（按实际站点替换域名）`);
  md.push('');
  md.push('```nginx');
  md.push('# HTTP → HTTPS 301（含 apex 与 www，一步到位）');
  md.push('server {');
  md.push(`    listen 80;`);
  const serverNames = [parsed.domain, host].filter((v, i, a) => a.indexOf(v) === i).join(' ');
  md.push(`    server_name ${serverNames};`);
  md.push(`    return 301 https://${host}$request_uri;`);
  md.push('}');
  md.push('');
  md.push('# HTTPS 主服务（A+ 配置）');
  md.push('server {');
  md.push('    listen 443 ssl http2;');
  md.push(`    server_name ${host};`);
  md.push('    ssl_certificate     /etc/ssl/certs/<site>.fullchain.pem;');
  md.push('    ssl_certificate_key /etc/ssl/private/<site>.key;');
  md.push('    ssl_protocols       TLSv1.2 TLSv1.3;');
  md.push('    ssl_session_cache   shared:SSL:10m;');
  md.push('    ssl_session_timeout 1d;');
  md.push('    ssl_stapling        on;');
  md.push('    ssl_stapling_verify on;');
  md.push('    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;');
  md.push('    add_header X-Content-Type-Options "nosniff" always;');
  md.push('    add_header X-Frame-Options "SAMEORIGIN" always;');
  md.push('    add_header Referrer-Policy "strict-origin-when-cross-origin" always;');
  md.push('    add_header Cache-Control "public, max-age=300, stale-while-revalidate=600" always;');
  md.push('    location / { try_files $uri $uri/ /index.php?$args; }');
  md.push('}');
  md.push('```');
  md.push('');
  md.push(`### 4.3 混合内容与验证清单`);
  md.push('');
  md.push(`- 全站资源统一 https，消除 http 引用资源的混合内容拦截；`);
  md.push(`- [ ] apex 与 www 证书均有效且自动续期　[ ] HSTS 生效　[ ] 全站 https 无混合内容　[ ] 重定向一步到位　[ ] 外部评测达 A+。`);
  md.push('');

  // 五、URL 语义化
  md.push(`## 五、URL 语义化与站点架构方案`);
  md.push('');
  md.push(`### 5.1 URL 架构设计原则`);
  md.push('');
  md.push(`- 语义化、可读、含核心词（英文 URL 含产品词，利于国际收录）；`);
  md.push(`- 扁平结构，层级 ≤ 3；`);
  md.push(`- 旧参数 URL 全量 301 到新语义 URL（映射表见 5.3）。`);
  md.push('');
  md.push(`### 5.2 新 URL 架构设计（示例，按实际站点调整）`);
  md.push('');
  md.push(`| 类型 | 中文 URL 示例 | 英文 URL 示例 |`);
  md.push(`|---|---|---|`);
  md.push(`| 首页 | \`/\` | \`/en/\` |`);
  md.push(`| 产品系列 | \`/products/<series>/\` | \`/en/products/<series>/\` |`);
  md.push(`| 产品型号 | \`/products/<series>-<model>/\` | \`/en/products/<series>-<model>/\` |`);
  md.push(`| 文库 | \`/library/<slug>/\` | \`/en/library/<slug>/\` |`);
  md.push(`| 支柱页 | \`/topics/<topic>/\` | \`/en/topics/<topic>/\` |`);
  md.push(`| 认证 | \`/about/certifications/\` | \`/en/about/certifications/\` |`);
  md.push('');
  md.push(`### 5.3 旧路由 → 新 URL 301 映射表（实施时逐条核对）`);
  md.push('');
  md.push(`| 旧 URL（现状） | 新 URL（语义化） |`);
  md.push(`|---|---|`);
  md.push(`| \`/list/<id>\` 等参数路由 | \`/products/<series>/\` |`);
  md.push(`| \`/show/<id>\` 等 ID 路由 | \`/library/<slug-化标题>/\` |`);
  md.push(`| \`?l=en\` / \`?lang=en\` 参数 | \`/en/\`（独立英文首页） |`);
  md.push(`| 非 www / 明文 | \`https://${host}\`（统一规范） |`);
  md.push('');
  md.push(`### 5.4 URL 规范化检查清单`);
  md.push('');
  md.push(`- [ ] 全站自指 canonical　[ ] 旧参数 URL 301 完成　[ ] 无 \`?id=\` 重复变体　[ ] 英文版 URL 独立且带 hreflang。`);
  md.push('');

  // 六、技术 SEO 基础
  md.push(`## 六、技术 SEO 基础工程方案`);
  md.push('');
  md.push(`### 6.1 robots.txt 配置`);
  md.push('');
  md.push('```text');
  md.push('# 允许 AI 爬虫');
  md.push('User-agent: GPTBot');
  md.push('Allow: /');
  md.push('');
  md.push('User-agent: ClaudeBot');
  md.push('Allow: /');
  md.push('');
  md.push('User-agent: PerplexityBot');
  md.push('Allow: /');
  md.push('');
  md.push('User-agent: Applebot');
  md.push('Allow: /');
  md.push('');
  md.push('User-agent: Google-Extended');
  md.push('Allow: /');
  md.push('');
  md.push('# 禁止后台与低质');
  md.push('User-agent: *');
  md.push('Disallow: /admin/');
  md.push('Disallow: /cart/');
  md.push('Disallow: /checkout/');
  md.push('Allow: /');
  md.push('');
  md.push('# llms.txt 供 AI 助手读取');
  md.push(`# 详见 https://${host}/llms.txt`);
  md.push(`Sitemap: https://${host}/sitemap_index.xml`);
  md.push('```');
  md.push('');
  md.push(`### 6.2 Sitemap 配置（P0 核心）`);
  md.push('');
  md.push(`- 诊断证据：${ev(parsed.robotsSitemap, '详见诊断报告 §4.5')}`);
  md.push(`- 重建 XML Sitemap 至全量真实 URL（${scale.length ? `诊断实测：${scale.map((r) => `${r.type} 收录 ${r.sitemap}/实测 ${r.reachable}`).join('；')}` : '规模数据见诊断报告 §2'}）；`);
  md.push(`- 统一 https + www 规范；在 robots.txt 声明并提交 GSC / Bing Webmaster；`);
  md.push(`- sitemap_index.xml 分语言（zh-hans / en）输出，删除冗余 sitemap.txt（若有）。`);
  md.push('');
  md.push(`### 6.3 Canonical / 内链 / 面包屑`);
  md.push('');
  md.push(`- 每页自指 canonical；英文版用 hreflang 互链，不互相 canonical；`);
  md.push(`- 内链见 3.2 hub-and-spoke；导航与页脚集中导出权重到系列与支柱页；`);
  md.push(`- 全站面包屑（首页 > 系列 > 型号），输出 BreadcrumbList Schema。`);
  md.push('');

  // 七、多语言
  md.push(`## 七、多语言 SEO（hreflang）方案（中文 + 英文）`);
  md.push('');
  md.push(`### 7.1 现状与部署`);
  md.push('');
  md.push(`- 诊断证据：${ev(parsed.multilang, '多语言现状详见诊断报告 §6.3（待验证）')}`);
  md.push(`- 本方案多语言范围：**仅中文（zh-hans）与英文（en）**；英文版承担国际采购流量，其他语种列入后续路线图。`);
  md.push('');
  md.push('```html');
  md.push(`<link rel="alternate" hreflang="zh-Hans"   href="https://${host}/" />`);
  md.push(`<link rel="alternate" hreflang="en"       href="https://${host}/en/" />`);
  md.push(`<link rel="alternate" hreflang="x-default" href="https://${host}/" />`);
  md.push('```');
  md.push('');
  md.push(`### 7.2 独立英文 URL 工程`);
  md.push('');
  md.push(`- 将现有语言切换（参数/cookie）重写为**独立 \`/en/\` URL 体系**，英文正文作为独立可索引页面；`);
  md.push(`- 菜单、导航、页脚、产品、文章同步建英译版本，URL 带 \`/en/\` 前缀；`);
  md.push(`- Sitemap 多语言条目（xhtml:link 互链）；每篇英译页在源语言页用 hreflang 回链。`);
  md.push('');
  md.push(`> 英文版是打开国际与英文采购词的最低成本杠杆——诊断显示英文词当前${parsed.multilang.includes('零收录') || parsed.multilang.includes('不可索引') ? '零收录/不可索引' : '承接不足（待验证）'}，独立 URL 上线后即可承接。`);
  md.push('');

  // 八、性能与 CWV
  md.push(`## 八、性能优化与 Core Web Vitals 方案`);
  md.push('');
  md.push(`### 8.1 Core Web Vitals 目标`);
  md.push('');
  md.push(`| 指标 | 目标 |`);
  md.push(`|---|---|`);
  md.push(`| LCP | ≤ 2.5s（移动） |`);
  md.push(`| CLS | ≤ 0.1 |`);
  md.push(`| INP | ≤ 200ms |`);
  md.push('');
  md.push(`### 8.2 性能优化技术栈`);
  md.push('');
  md.push(`- 前置 CDN（如 Cloudflare）：解决海外延迟高与单源问题；`);
  md.push(`- 合理缓存头：动态 HTML 短时缓存（\`stale-while-revalidate\`），静态资源长缓存；`);
  md.push(`- 升级 HTTP/2（若诊断显示 HTTP/1.1），启用多路复用；`);
  md.push(`- 图片 WebP / AVIF，补 \`width/height\` 防 CLS，修混合内容；`);
  md.push(`- 关键 CSS 内联，JS 异步加载，首屏不阻塞。`);
  md.push('');
  md.push(`### 8.3 CDN 配置`);
  md.push('');
  md.push(`- 开启 CDN + 自动压缩（Brotli）；放行搜索引擎与 AI 爬虫（不对其触发挑战）；静态资源长缓存，HTML 短时缓存。`);
  md.push('');

  // 九、结构化数据
  md.push(`## 九、结构化数据（Schema.org）部署方案`);
  md.push('');
  md.push(`### 9.1 部署清单与现状`);
  md.push('');
  md.push(`- 诊断证据：${ev(parsed.jsonld, 'JSON-LD 覆盖详见诊断报告 §7.1')}`);
  md.push('');
  md.push(`| 类型 | 页面 | 来源 |`);
  md.push(`|---|---|---|`);
  md.push(`| Organization | 全站（页脚 / 关于） | 公司名、地址、电话、资质 |`);
  md.push(`| Product | 产品/服务详情页 | 产品字段（名称 / 型号 / 材料 / 应用） |`);
  md.push(`| Article / NewsArticle | 文库 | 标题 / 正文 / 日期 / 作者 |`);
  md.push(`| FAQPage | FAQ 页 / 产品页 | 采购问答 |`);
  md.push(`| BreadcrumbList | 全站 | 导航层级 |`);
  md.push('');
  md.push(`### 9.2 Organization Schema 示例`);
  md.push('');
  md.push('```json');
  md.push('{');
  md.push('  "@context": "https://schema.org",');
  md.push('  "@type": "Organization",');
  md.push(`  "name": "${brandName || parsed.domain}",`);
  md.push(`  "url": "https://${host}/",`);
  md.push(`  "logo": "https://${host}/logo.png",`);
  md.push('  "address": { "@type": "PostalAddress", "addressLocality": "待补充", "addressCountry": "CN" }');
  md.push('}');
  md.push('```');
  md.push('');
  md.push(`### 9.3 Product / FAQPage Schema 示例（按实际产品字段替换）`);
  md.push('');
  md.push('```json');
  md.push('{ "@context": "https://schema.org", "@type": "Product",');
  md.push('  "name": "<产品名>", "brand": { "@type": "Brand", "name": "<品牌>" },');
  md.push('  "description": "<一句话描述>", "material": "<材质>", "application": ["<应用1>", "<应用2>"] }');
  md.push('```');
  md.push('');
  md.push('```json');
  md.push('{ "@context": "https://schema.org", "@type": "FAQPage",');
  md.push('  "mainEntity": [{ "@type": "Question", "name": "<问题>",');
  md.push('    "acceptedAnswer": { "@type": "Answer", "text": "<答案>" } }] }');
  md.push('```');
  md.push('');
  md.push(`### 9.4 Schema 验证`);
  md.push('');
  md.push(`- 上线前用 Rich Results 测试逐类验证；监控 GSC 结构化数据覆盖率报告。`);
  md.push('');

  // ============================ 中篇 ============================
  md.push(`## 十、关键词矩阵规划`);
  md.push('');
  md.push(`### 10.1 矩阵规模与分类框架`);
  md.push('');
  md.push(`- 全量关键词矩阵：**约 200 个**（核心 + 长尾 + 信息研究 + 品牌 + 参数信任 + 地区供应商），中英文合计，英文词（国际采购词）约占 45%；`);
  md.push(`- 关键词缺口（诊断 §9，外部观察）：${ev(parsed.keywordGap, '待补充关键词分层表')}`);
  md.push('');
  md.push(`| 类别 | 说明 | 示例 |`);
  md.push(`|---|---|---|`);
  md.push(`| 核心商业词 | 高购买意图品类词 | <品类>、<品类>厂家 |`);
  md.push(`| 长尾商业词 | 材质/用途 + 参数组合 | <品类> + <应用> + <参数> |`);
  md.push(`| 信息研究型词 | 选型 / 对比 / 指南 | <品类> vs <品类>、选型指南 |`);
  md.push(`| 品牌词 | 品牌 + 变体 | ${brandName || '<品牌>'}<品牌变体> |`);
  md.push(`| 参数信任词 | MOQ / 认证 / 牌号 | <认证> certified <品类> |`);
  md.push(`| 地区供应商词 | 地域 + 供应商 | <品类> manufacturer China |`);
  md.push('');
  md.push(`### 10.2 关键词优先级矩阵`);
  md.push('');
  md.push(`| 优先级 | 标准 | 处置 |`);
  md.push(`|---|---|---|`);
  md.push(`| P0 | 高意图 + 可快速占位（中文品类 + 核心系列） | 产品页 + 支柱页 + 首批文章 |`);
  md.push(`| P1 | 中意图 + 竞争适中（英文采购词 / 长尾） | 英文版 + 长尾文章矩阵 |`);
  md.push(`| P2 | 低意图 / 高竞争（大词、地区泛词） | 长期外链 + 权威建设 |`);
  md.push('');
  md.push(`> 完整词表在实施交付时以 Excel / 在线表格提供。`);
  md.push('');

  md.push(`## 十一、文章生成策略与 Header 元信息规划`);
  md.push('');
  md.push(`### 11.1 文章数量建议（总计 ≤ 200 篇）`);
  md.push('');
  md.push(`| 语言 | 来源 | 数量 |`);
  md.push(`|---|---|---|`);
  md.push(`| 中文 | 现有文章重构改写 + 新写（材料 / 应用 / 选型 / 认证 / FAQ） | 55–110 篇（按站点规模） |`);
  md.push(`| 英文 | 高价值精选翻译 + 本地化 | 45–60 篇 |`);
  md.push(`| **合计** | | **100–170 篇（≤ 200）** |`);
  md.push('');
  md.push(`### 11.2 每篇文章规范`);
  md.push('');
  md.push(`- 每篇聚焦 1 个核心词 + 2–3 个长尾词，自然分布于 H1 / H2 / 首段 / 正文 / 结语；`);
  md.push(`- Header 层级：H1 文章主标题（含核心词）→ H2 核心小节（含长尾词）→ H3 子点 → H2 FAQ（FAQPage Schema）→ H2 结论 / CTA；每页仅 1 个 H1，避免跳级；`);
  md.push(`- Meta：Title 核心词前置 ≤ 60 字符；Description 含价值点 + 关键词 ≤ 155 字符；OG / Twitter 配图与摘要；`);
  md.push(`- 撰写量：中文 1,500–3,500 字；英文 1,000–2,000 词，含数据 / 对比 / 清单；`);
  md.push(`- 质量清单：[ ] 唯一 H1　[ ] 核心/长尾词自然分布　[ ] FAQPage Schema 通过　[ ] ≥2 条内链、≥1 张带 alt 图　[ ] Meta 合规　[ ] 英文版带 hreflang 回链。`);
  md.push('');
  md.push(`### 11.3 文章生成 SOP`);
  md.push('');
  md.push(`1. 选题（关键词矩阵 P0 / P1）→ 2. 大纲（H2/H3 + FAQ）→ 3. 撰写 → 4. 结构化（Article + FAQPage Schema、内链、图片 alt）→ 5. 校验（Rich Results + 可读性）→ 6. 发布 + 提交索引（中英文分别提交）。`);
  md.push('');
  md.push(`### 11.4 内容集群规划（hub-and-spoke）`);
  md.push('');
  md.push(`| 支柱页 | 聚合卫星文章 | 目标词 |`);
  md.push(`|---|---|---|`);
  md.push(`| <支柱主题 1> | <卫星文章主题> | <目标词 1> |`);
  md.push(`| <支柱主题 2> | <卫星文章主题> | <目标词 2> |`);
  md.push(`| <支柱主题 3> | <卫星文章主题> | <目标词 3> |`);
  md.push(`| <选型与认证> | <选型指南 / 认证解读 / MOQ 交期 FAQ> | <品类 supplier> |`);
  md.push('');
  md.push(`> 支柱页数量与主题以实际业务为准（可参考诊断 §9 关键词缺口）。`);
  md.push('');

  md.push(`## 十二、GEO 生成式引擎优化方案`);
  md.push('');
  md.push(`### 12.1 GEO 核心策略`);
  md.push('');
  md.push(`把"已存在但未被结构化"的答案（型号、认证编号、MOQ、交期、应用）转化为 AI 可抽取、可引用的确定数据；用对比 / 选型 / 原创数据制造被引用素材。`);
  md.push('');
  md.push(`### 12.2 GEO 优化要素（CITE）`);
  md.push('');
  md.push(`| 要素 | 诊断现状 | 目标动作 |`);
  md.push(`|---|---|---|`);
  md.push(`| C Crawlable（可抓取） | ${cite('Crawlable（可抓取）')}/10 | ${ev(parsed.aiReach).includes('fail') || parsed.aiReach.includes('被拦') ? '解除 WAF/robots 对 AI 爬虫的拦截，保证真实内容可达' : '保持可达，纳入全量 sitemap' } |`);
  md.push(`| I Identifiable（可识别实体） | ${cite('Identifiable（可识别实体）')}/10 | 首页 H 层级、FAQ H2、产品/系列实体化（Organization/Product） |`);
  md.push(`| T Trustworthy（可信） | ${cite('Trustworthy（可信）')}/10 | 认证文字化 + Organization sameAs + 内容矩阵 |`);
  md.push(`| E Extractable（可抽取） | ${cite('Extractable（可抽取）')}/10 | 型号 / 认证 / MOQ 字段化（Schema + 正文双写出） |`);
  md.push('');
  md.push(`### 12.3 GEO 内容模板（AI 最易引用）`);
  md.push('');
  md.push(`- **定义型**：> 什么是<品类>？<品类>是……（一句话定义 + 关键属性 + 应用场景）。`);
  md.push(`- **FAQ 型（引用率最高）**：> Q：<产品>通过了哪些认证？A：具备<认证清单>，编号与范围在证书页公开。　> Q：最小起订量（MOQ）多少？A：按系列/牌号与颜色起订，支持试样小批量。`);
  md.push(`- 配合 FAQPage Schema，AI Overview 可直接引用。`);
  md.push('');
  md.push(`### 12.4 GEO 优化检查清单与 AI 引用测试`);
  md.push('');
  md.push(`- [ ] 部署 /llms.txt　[ ] 关键页 FAQPage / Product / Article Schema 通过　[ ] 采购参数在正文 + Schema 双写出　[ ] 对比 / 选型内容覆盖高转化长尾。`);
  md.push(`- **AI 引用测试**：建立 20 题固定 Prompt 集（中文 + 英文），上线前后各跑一轮，记录 ChatGPT / Claude / Perplexity / 豆包 / 文心是否引用（问题示例："推荐几家<品类>制造商"、"<品类> supplier China"）。`);
  md.push('');

  // ============================ 价值桥接 ============================
  md.push(`## 十三、询盘转化与业务价值模型`);
  md.push('');
  md.push(`- **核心命题**：每一项技术措施都在为询盘服务——站点核心转化目标是询盘（inquiry / RFQ），让采购方在搜索 / AI 回答中看到本站并进入询盘漏斗。`);
  md.push(`- **漏斗模型**：\`曝光（搜索/AI 引用）→ 点击（标题/摘要/富媒体）→ 信任（认证/案例/内容）→ 询盘（表单/邮箱/电话）→ 成交\`；`);
  md.push(`- **各模块询盘贡献**：sitemap 补全 + 异常清理 → 全量内容进索引扩大曝光；差异化 Title/Meta → 提升点击；认证透明化 + Schema → 提高询盘转化率；英文版 + hreflang → 承接国际采购词；文库 + 对比选型 → 抢占长尾、筛选高意图询盘；FAQ + MOQ/交期 → 降低决策门槛、直接催生询盘；`);
  md.push(`- **信任体系**：认证资质页文字化（编号公开）、应用案例与行业落地、作者 / 品牌 E-E-A-T（文库标注出处与日期）。`);
  md.push('');

  // ============================ 下篇 ============================
  md.push(`## 十四、搜索引擎收录与提交方案`);
  md.push('');
  md.push(`- **目标**：内容上线后第一时间提交主流搜索引擎，缩短收录周期；中文站提交百度，英文站提交 Google / Bing（覆盖国际 AI / Copilot 来源）；`);
  md.push(`- **GSC**：验证站点所有权、提交全量 Sitemap、监测索引覆盖率与富媒体，修复抓取异常；`);
  md.push(`- **Bing Webmaster**：同步提交 Sitemap，启用 URL 提交接口对新文章即时推送；`);
  md.push(`- **百度搜索资源平台**：提交中文站 Sitemap，善用主动推送 / 快速收录接口。`);
  md.push(`- 外链建设不在本期范围，列入后续扩张期。`);
  md.push('');

  md.push(`## 十五、项目实施计划与时间规划`);
  md.push('');
  md.push(`| 阶段 | 周期 | 主要动作 |`);
  md.push(`|---|---|---|`);
  md.push(`| 第 1 阶段（止血 + 基建） | 第 1–2 周 | 过渡期 JSON-LD + llms.txt、sitemap 全量补全、异常路由清理、www 规范、差异化 Title、分析基线、CDN |`);
  md.push(`| 第 2 阶段（${shell ? '重建上线' : '模板修复上线'}） | 第 3–5 周 | ${shell ? 'SSR 重建、设计、前端、数据迁移、技术 SEO/GEO' : '模板修复（Title/Meta/canonical/面包屑/JSON-LD/alt）、独立英文 URL、证书结构化'} |`);
  md.push(`| 第 3 阶段（内容 + 多语） | 第 4–7 周 | 关键词矩阵、中英文章（现有改写 + 新写 + 英文 AI 翻译）、搜索引擎提交 |`);
  md.push('');
  md.push(`- **里程碑**：M1（第 2 周）AI 可读取实体（JSON-LD + llms.txt）+ 全量 sitemap 提交 + 基线建立；M2（第 5 周）中文站上线 / 修复完成，异常清零；M3（第 7 周）文章发布 + 英文独立版上线 + 内容提交搜索引擎。`);
  md.push(`- **关键路径**：${shell ? '数据迁移是前端与内容并行的前提，须优先；SSR 上线后方可谈收录与 GEO 成效。' : 'sitemap 补全与异常清理是索引生效的前提，须优先；模板修复上线后方可谈收录与 GEO 成效。'}`);
  md.push('');
  md.push(`> 内容生成与英文版可与后期并行，缩短整体周期。`);
  md.push('');

  md.push(`## 十六、团队分工与资源需求`);
  md.push('');
  md.push(`- **团队角色**：${shell ? '项目经理、UI/视觉设计师、前端开发工程师、服务器运维、SEO 策略师、SEO 运营专员。' : '项目经理、前端开发工程师（现有栈）、服务器运维、SEO 策略师、SEO 运营专员。'}`);
  md.push(`- **品牌方需提供**：服务器 / 主机 / CDN 账户（品牌方承担费用）、域名持有与续费、现有产品 / 文章数据导出（尽量）、认证证书 / 工厂图 / 应用案例素材、企业邮箱。`);
  md.push(`- **工具费用**：优先免费版本（Let's Encrypt / GSC / Bing / 百度资源平台 / GA4）；付费服务由品牌方承担。`);
  md.push('');

  md.push(`## 十七、KPI 体系`);
  md.push('');
  md.push(`### 17.1 技术 KPI`);
  md.push('');
  md.push(`- 已索引页面数（GSC）：sitemap 全量补全后显著上升；`);
  md.push(`- 异常状态码（500/软 404）：诊断清单清零；`);
  md.push(`- 结构化数据覆盖率：Product / Article / FAQPage 通过率 ≥ 95%；`);
  md.push(`- Core Web Vitals：LCP / CLS / INP 达标；`);
  md.push(`- 重复内容：www 规范 + canonical + 301 后零重复。`);
  md.push('');
  md.push(`### 17.2 内容 KPI`);
  md.push('');
  md.push(`- 发布文章数：≤ 200 篇（中英合计）；`);
  md.push(`- 文章收录数：被搜索引擎索引的文章数量（中文 + 英文）。`);
  md.push('');

  md.push(`## 十八、风险识别与应对方案`);
  md.push('');
  md.push(`| 风险 | 影响 | 应对 |`);
  md.push(`|---|---|---|`);
  md.push(`| 异常路由修复不彻底 | 仍消耗抓取预算 | 全量回归测试 + GSC 覆盖率持续监测 |`);
  md.push(`| 英文独立 URL 质量不足 | 国际转化低 | 本地化而非机翻，关键页母语校对 |`);
  md.push(`| CDN 缓存导致更新延迟 | 内容不同步 | 配置缓存刷新与 stale-while-revalidate |`);
  md.push(`| AI 爬虫被误挡 | GEO 失效 | CDN/WAF 放行爬虫，过渡期持续验证 |`);
  md.push(`| 文章产出节奏滞后 | 内容 KPI 不达标 | SOP + 模板量产，现有文章优先改写 |`);
  md.push(`| 混合内容残留 | 浏览器拦截资源 | 全站资源 https 化，上线前巡检 |`);
  md.push('');

  // 附录
  md.push(`## 附录`);
  md.push('');
  md.push(`### 附录 A：llms.txt 示例`);
  md.push('');
  md.push('```text');
  md.push(`# ${brandName || parsed.domain}`);
  md.push('## 产品/服务');
  md.push('- <系列 1>：/products/<series1>/');
  md.push('- <系列 2>：/products/<series2>/');
  md.push('');
  md.push('## 文库（精选）');
  md.push('- <文章 1>：/library/<slug1>/');
  md.push('- <文章 2>：/library/<slug2>/');
  md.push('');
  md.push('## 认证与信任');
  md.push('- <认证 1> / <认证 2> / <认证 3>');
  md.push('');
  md.push('## 关键采购信息');
  md.push('- MOQ：按系列/牌号与颜色起订，支持试样');
  md.push('- 应用：<行业 1> / <行业 2>');
  md.push('```');
  md.push('');
  md.push(`### 附录 B：文章模板与 Header 规范`);
  md.push('');
  md.push('```markdown');
  md.push('# H1：文章主标题（含核心词）');
  md.push('');
  md.push('导语：100–150 字，含核心词与价值点。');
  md.push('');
  md.push('## H2：核心小节 1（含长尾词）');
  md.push('正文……（数据 / 对比 / 清单）');
  md.push('');
  md.push('### H3：子点');
  md.push('正文……');
  md.push('');
  md.push('## H2：常见问题（FAQPage Schema）');
  md.push('**Q：……** A：……');
  md.push('');
  md.push('## H2：结论 / 联系我们');
  md.push('结语 + CTA（询盘入口）');
  md.push('```');
  md.push('');
  md.push(`- Meta Title ≤ 60 字符；Meta Description ≤ 155 字符；≥ 2 条内链、≥ 1 张带 alt 图；英文版带 hreflang 回链。`);
  md.push('');

  // ---- quote-only chapters ----
  if (quote) {
    const roleRows = [
      ['项目经理', 2],
      ['UI/视觉设计师', 5],
      ['前端开发工程师', 6],
      ['服务器运维', 3],
      ['SEO 策略师', 4],
      ['SEO 运营专员', 9],
    ];
    const totals = roleRows.map(([name, days]) => ({ name, days, rate: rates[name] || 0, sub: Math.round((rates[name] || 0) * days) }));
    const sumDays = totals.reduce((a, r) => a + r.days, 0);
    const sumPrice = totals.reduce((a, r) => a + r.sub, 0);

    md.push(`## 报价方案（quote:true 追加章节）`);
    md.push('');
    md.push(`> 基于 2026 年一线城市外包市场口径（人日单价为非整数以贴合实际用工成本）；单价可用 unit_rates 参数覆盖。报价为第一期（基础建设 + 内容上线 / Phase 1，一个半月约 7 周）人力小计口径。`);
    md.push('');
    md.push(`### 人日单价标准（默认参考值，可覆盖）`);
    md.push('');
    md.push(`| 角色 | 人日单价（RMB） |`);
    md.push(`|---|---|`);
    for (const [name, rate] of Object.entries(rates)) md.push(`| ${name} | ¥${rate} |`);
    md.push('');
    md.push(`### 第一期工作量与报价（按角色拆分）`);
    md.push('');
    md.push(`| 角色 | 人日数 | 小计 |`);
    md.push(`|---|---|---|`);
    for (const r of totals) md.push(`| ${r.name} | ${r.days} | ¥${r.sub} |`);
    md.push(`| **人力小计** | **${sumDays}** | **¥${sumPrice}** |`);
    md.push('');
    md.push(`**总价：¥${sumPrice}** ｜ **交付周期：一个半月（约 7 周）**`);
    md.push('');
    md.push(`> 说明：验收标准（页面类型可访问、sitemap 全量提交、异常清零、Schema 验证通过、llms.txt 部署、关键词矩阵交付、文章发布、全站提交搜索引擎）；报价含税；预付 50% / 验收后 50%；变更管理、知识产权与售后保障按合同约定。`);
    md.push('');

    md.push(`## 年度例行费用（品牌方自担，合同建设费之外）`);
    md.push('');
    md.push(`| 项目 | 估算 | 备注 |`);
    md.push(`|---|---|---|`);
    md.push(`| 服务器 / 主机 | ¥2,000–6,000 / 年 | 依配置 |`);
    md.push(`| 域名续费 | ¥100–300 / 年 | 按注册局 |`);
    md.push(`| CDN（如 Cloudflare） | 免费–付费计划 | 品牌方账户 |`);
    md.push(`| 维保（安全更新 + 巡检 + 紧急修复） | 按建设费 10% / 年 | 不含新功能与内容 |`);
    md.push('');
    md.push(`> 管理模式：模式 A 品牌方自管（成本最低）；模式 B 承建方托管（响应更及时）。建议建设期由承建方托管维保，后续内容扩张按增量另行报价。`);
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push(`*本方案由 tengence geo-agent 的 geo_solution 确定性组装生成，基于诊断报告证据；标注"待验证/待补充"处需人工核实后落地。*`);
  md.push('');
  return md.join('\n');
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Generate the optimization plan for a site.
 * @param {object} opts { site (site key, required), lang, brandName, industry,
 *                       quote, unitRates }
 * @returns {{ok:boolean, site:string, domain:string, path:string, filename:string,
 *            chapters:number, quote_included:boolean, source_report:string}}
 */
async function generateSolution(opts = {}) {
  const { site, lang = 'zh', brandName = '', industry = '', quote = false, unitRates = {} } = opts;
  if (!site) throw new Error('geo_solution requires a site key (the site must have a diagnosis report first)');

  const t = require('..'); // eslint-disable-line
  const S = t.site.loadSite(site, { autoInit: true, domain: site });

  const latest = findLatestReport(S.siteDir);
  if (!latest) {
    throw new Error(
      `No diagnosis report found for site "${site}" (expected <site>/data/reports/<...>.md). ` +
        'Run diagnose_site + report_write first.'
    );
  }

  const md = fs.readFileSync(latest.fullPath, 'utf8');
  const parsed = parseReport(md, site);

  // unit_rates keys may come as Chinese role names; normalize common aliases
  const rates = { ...DEFAULT_UNIT_RATES };
  for (const [k, v] of Object.entries(unitRates || {})) {
    const alias = {
      pm: '项目经理',
      ux: 'UI/视觉设计师',
      design: 'UI/视觉设计师',
      dev: '前端开发工程师',
      ops: '服务器运维',
      seo: 'SEO 策略师',
      writer: 'SEO 运营专员',
    }[String(k).toLowerCase()];
    const key = alias || k;
    if (typeof v === 'number') rates[key] = v;
  }

  const content = buildPlan(parsed, { lang, brandName, industry, quote, unitRates: rates });

  const plansDir = path.join(S.siteDir, 'data', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const filename = `${todayStamp()}-${site}-geo-solution.md`;
  const dest = path.resolve(plansDir, filename);
  if (!dest.startsWith(path.resolve(plansDir) + path.sep)) {
    throw new Error(`unsafe plan filename: ${filename}`);
  }
  fs.writeFileSync(dest, content, 'utf8');

  return {
    ok: true,
    site,
    domain: parsed.domain,
    path: dest,
    filename,
    chapters: countChapters(content),
    quote_included: !!quote,
    source_report: latest.fullPath,
  };
}

module.exports = { generateSolution, buildPlan, parseReport, findLatestReport };
