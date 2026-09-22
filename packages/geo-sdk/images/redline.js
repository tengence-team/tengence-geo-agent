/**
 * Image red-line rules and scoring (pure logic, no I/O)
 * ============================================================================
 * 2026-09-14 entry-layer refactor: sunk down verbatim from commands/image-acquire.js,
 * **logic unchanged to the letter**.
 *
 * This is the **single source of truth** for the "image red-lines"; the rules are
 * also codified in skills/wordpress/README.md "五之一、自动配图流水线".
 *
 * Contains only pure functions (given input → deterministic output), so unit tests
 * can lock the behavior directly:
 *   sanitizeQuery / shortenQuery / redLineCheck / scoreCandidate / buildFileName
 * ============================================================================
 */

// Third-party company / product names (incl. device brands) — any Logo / watermark
// visible in the frame is rejected
const BRAND_BLOCKLIST = [
  'google', 'apple', 'microsoft', 'dell', 'samsung', 'ibm', 'intel', 'hp', 'lenovo',
  'sony', 'amazon', 'meta', 'facebook', 'instagram', 'twitter', 'x.com', 'adobe',
  'nike', 'adidas', 'coca-cola', 'pepsi', 'mcdonald', 'bmw', 'mercedes', 'tesla',
  'oracle', 'sap', 'cisco', 'nvidia', 'amd', 'lg', 'huawei', 'xiaomi', 'oppo', 'vivo',
  'tencent', 'alibaba', 'baidu', 'bing', 'yahoo', 'linkedin', 'youtube', 'tiktok',
  '谷歌', '苹果', '微软', '戴尔', '三星', '英特尔', '惠普', '联想', '索尼', '亚马逊',
  '脸书', '推特', '耐克', '阿迪达斯', '可口可乐', '宝马', '奔驰', '特斯拉', '华为', '小米',
  '腾讯', '阿里巴巴', '百度', '必应', '雅虎', '领英',
  // 2026-09-14 supplement: social / design tools / e-commerce / mobility / content
  // platforms — frequently miscaptured brands
  'pinterest', 'reddit', 'quora', 'wikipedia', 'snapchat', 'whatsapp', 'wechat',
  'paypal', 'netflix', 'spotify', 'shopify', 'wordpress', 'github', 'gitlab',
  'figma', 'canva', 'notion', 'slack', 'zoom', 'discord', 'firefox', 'chrome',
  'safari', 'android', 'iphone', 'ipad', 'macbook', 'playstation', 'xbox',
  'nintendo', 'airbnb', 'uber', 'booking.com', 'ebay', 'walmart', 'starbucks',
  'ikea', 'zara', 'uniqlo', 'visa', 'mastercard', 'bilibili', 'skype', 'dropbox',
  'salesforce', 'atlassian', 'steam', 'pinterest.com',
  '拼多多', '京东', '淘宝', '天猫', '抖音', '小红书', '知乎', '微博', '哔哩哔哩',
  '微信', '支付宝', '滴滴', '美团', '网易', '新浪', '搜狐', '快手', '钉钉'
];

// Rejected style keywords (abstract / 3D / AI-generated / light effects / gradients etc.)
const REJECT_KEYWORDS = [
  'abstract', '3d', 'render', 'cgi', 'generative', 'ai generated', 'ai-generated',
  'midjourney', 'stable diffusion', 'dall-e', 'digital art', 'gradient', 'glow',
  'neon', 'light effect', 'lens flare', 'surreal', 'concept art',
  // 2026-09-14 supplement: software-UI screenshots (often contain third-party Logos /
  // interface brands and aren't commercial-business style)
  'user interface', 'ui design', 'screenshot', 'screen capture', 'wireframe',
  'search results page', 'web page', 'webpage', 'browser window'
];

const MIN_WIDTH = 1200;
const ASPECT_MIN = 1.3; // landscape preferred
const ASPECT_MAX = 2.5;
const WEBP_WIDTH = 1600;
const WEBP_HEIGHT = 900; // 16:9 center crop
const WEBP_QUALITY = 82;
// 2026-09-19 image format configurable: default JPG (quality 85, hard-coded, not
// sharp's default 80).
// External content platforms (WeChat/ Zhihu / Xiaohongshu / Toutiao etc.) all reject
// WebP, so JPG is the default to cover every channel.
const JPG_QUALITY = 85;

/**
 * Sanitize a query: strip punctuation (incl. full-width), collapse whitespace.
 * Measured: Unsplash returns 410 "Content removed" for long queries with full-width
 * punctuation; sanitizing makes them return normally.
 */
function sanitizeQuery(q) {
  return String(q || '')
    .replace(/[，。？！、；：（）【】《》"'‘’“”·\-–—/\\|?!,.;:()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Take the first N words, for degraded retries */
function shortenQuery(q, words = 5) {
  const parts = sanitizeQuery(q).split(' ').filter(Boolean);
  return parts.slice(0, words).join(' ');
}

/** Red-line check: reject on brand block-list / rejected style / insufficient size / wrong aspect */
function redLineCheck(cand) {
  const text = `${cand.alt} ${cand.author} ${cand.sourceUrl}`.toLowerCase();

  for (const brand of BRAND_BLOCKLIST) {
    if (text.includes(brand)) {
      return { ok: false, reason: `brand/Logo block-list hit: ${brand}` };
    }
  }
  for (const kw of REJECT_KEYWORDS) {
    if (text.includes(kw)) {
      return { ok: false, reason: `rejected style hit: ${kw}` };
    }
  }
  if (!cand.width || !cand.height) {
    return { ok: false, reason: 'missing size info' };
  }
  if (cand.width < MIN_WIDTH) {
    return { ok: false, reason: `width insufficient ${cand.width}<${MIN_WIDTH}` };
  }
  const aspect = cand.width / cand.height;
  if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) {
    return { ok: false, reason: `aspect not landscape ${aspect.toFixed(2)}` };
  }
  return { ok: true };
}

/** Score: size + platform weight (Unsplash preferred) + relevance + complete credit */
function scoreCandidate(cand, query) {
  let score = 0;
  // size
  score += cand.width >= 1920 ? 20 : cand.width >= 1280 ? 14 : 8;
  // platform weight (Unsplash preferred)
  score += cand.platform === 'unsplash' ? 20 : cand.platform === 'pexels' ? 14 : 10;
  // relevance: query terms hit in alt/author
  const q = (query || '').toLowerCase();
  if (q && (cand.alt.toLowerCase().includes(q) || cand.author.toLowerCase().includes(q))) {
    score += 20;
  }
  // complete credit
  if (cand.author) score += 6;
  return score;
}

/**
 * Generate the featured-image file name: the article slug is preferred (semantic,
 * doesn't expose the stock source); falls back to `img-<image-id>.webp` without a
 * slug (no platform name, avoiding exposing the stock source; already-published
 * `featured-*` legacy images are unaffected — only future naming changes).
 */
function buildFileName(slug, chosen, ext) {
  if (slug) {
    const safe = String(slug).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (safe) return `${safe}.${ext}`;
  }
  return `img-${chosen.id}.${ext}`;
}

module.exports = {
  sanitizeQuery,
  shortenQuery,
  redLineCheck,
  scoreCandidate,
  buildFileName,
  BRAND_BLOCKLIST,
  REJECT_KEYWORDS,
  MIN_WIDTH,
  ASPECT_MIN,
  ASPECT_MAX,
  WEBP_WIDTH,
  WEBP_HEIGHT,
  WEBP_QUALITY,
  JPG_QUALITY,
};
