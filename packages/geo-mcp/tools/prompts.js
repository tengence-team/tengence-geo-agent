'use strict';
/**
 * GEO content engine MCP Prompt templates (@tengence/geo-mcp/tools/prompts)
 * ============================================================================
 * Each prompt = { name, title, description, argsSchema, run(args) }.
 * run() returns { description, messages: [{ role, content: { type:'text', text } }] }
 * — the shape of GetPromptResult consumed by registerPrompt.
 *
 * Prompts are user-controlled: the client lists them via prompts/list and the
 * user explicitly invokes one (e.g. a slash command). They encode proven call
 * sequences for a task so an AI client doesn't reinvent the workflow each time.
 */

const { z } = require('zod');

/** site key; auto-selected when the workspace holds exactly one site */
const siteField = z
  .string()
  .optional()
  .describe('site key; auto-selected when the workspace holds exactly one site');

/** Build a single-message prompt payload. */
function msg(text) {
  return [{ role: 'user', content: { type: 'text', text } }];
}

/** Resource URI constants — single source of truth for template text. */
const RES = {
  articleWritingStandards: 'geo://standard/article-writing-standards',
  skeletonFor: (type) => `geo://standard/templates/skeletons/${type}`,
  researchBrief: 'geo://standard/templates/research-brief',
};

const prompts = [
  {
    name: 'write_geo_article',
    title: '撰写 GEO 文章',
    description:
      '产出一篇符合 T1–T7 骨架与 G1–G14 编辑门禁的 GEO 正文。先读标准/骨架，再按块写正文。',
    argsSchema: z.object({
      type: z
        .string()
        .optional()
        .describe('T1–T7 body type: definition|howto|product|case|industry|comparison|guide (default guide)'),
      topic: z.string().optional().describe('working topic / target keyword'),
      language: z
        .string()
        .optional()
        .describe('language code: zh-hans|en|zh-hant (default zh-hans)'),
      site: siteField,
    }).shape,
    run(args) {
      const type = args.type || 'guide';
      const language = args.language || 'zh-hans';
      return {
        description: '撰写一篇 GEO 文章的完整指引',
        messages: msg(
          `请产出一篇 GEO 文章。类型=article(${type})，语言=${language}，站点=${args.site || '(自动选择)'}。\n` +
            `步骤：1) 读取标准 resource ${RES.articleWritingStandards}，骨架 ${RES.skeletonFor(type)}，` +
            `以及前置 research brief ${RES.researchBrief}；` +
            `也可先调 article_draft(type=${type}, topic=${args.topic || ''}) 生成现成 brief。` +
            `2) 按骨架写 Markdown 正文，包含七个块：Summary、Key Takeaways、FAQ、Data Sources、Related Reading、Get Started、About。` +
            `3) 交付前内部先过 check_article 的 G1–G14 门禁，不通过就修订。` +
            `语言代码仅用 zh-hans | en | zh-hant。`
        ),
      };
    },
  },
  {
    name: 'run_content_pipeline',
    title: '一键内容流水线',
    description:
      '对给定站点跑完整内容流水线：article_draft → 写正文 → check_article → article_ingest → publish_draft。',
    argsSchema: z.object({
      topic: z.string().describe('working topic / target keyword'),
      type: z
        .string()
        .optional()
        .describe('T1–T7 body type (default guide)'),
      language: z
        .string()
        .optional()
        .describe('language code: zh-hans|en|zh-hant (default zh-hans)'),
      site: siteField,
    }).shape,
    run(args) {
      const type = args.type || 'guide';
      const language = args.language || 'zh-hans';
      return {
        description: '一条内容从选题到发布的完整流水线',
        messages: msg(
          `对站点=${args.site || '(自动选择)'} 跑一条内容流水线：topic=${args.topic}，type=${type}，language=${language}。\n` +
            `依次执行：\n` +
            `1) article_draft(type=${type}, topic="${args.topic}") 取写作 brief；\n` +
            `2) 按 brief 写 Markdown 正文；\n` +
            `3) check_article 跑 G1–G14 门禁，不通过则修订重跑直至通过；\n` +
            `4) article_ingest 入库；\n` +
            `5) publish_draft 发布。\n` +
            `每个步骤成功后简短汇报，最后给出成文 slug。发布属写操作，执行前先与用户确认。`
        ),
      };
    },
  },
  {
    name: 'publish_to_channel',
    title: '多平台分发发布',
    description:
      '把文章按平台改写规则分发到 wechat / juejin / csdn 等外部平台。先读平台规则，再改写并发布。',
    argsSchema: z.object({
      platform: z
        .string()
        .describe('target platform: wechat|juejin|csdn'),
      article: z.string().describe('article slug or identifier'),
      language: z
        .string()
        .optional()
        .describe('language code: zh-hans|en|zh-hant (default zh-hans)'),
      site: siteField,
    }).shape,
    run(args) {
      const language = args.language || 'zh-hans';
      return {
        description: '把文章分发到指定外部平台',
        messages: msg(
          `把站点=${args.site || '(自动选择)'} 的文章=${args.article}（语言=${language}）发布到平台=${args.platform}。\n` +
            `1) 先用 channel_list(platform=${args.platform}) 看平台状态/限额/能力；\n` +
            `2) 用 channel_style_get 读该平台的改写规则，按规则改写原文（原文用 article_export 取）；\n` +
            `3) channel_publish 发布（草稿或直发按平台状态）。\n` +
            `注意 ${args.platform} 的发布状态与限额；发布属写操作，执行前先与用户确认。`
        ),
      };
    },
  },
  {
    name: 'site_health_diagnosis',
    title: '站点健康诊断',
    description:
      '对站点做一次 GEO/SEO 健康诊断，输出 0-100 评分、分维度结果与修复优先级。',
    argsSchema: z.object({
      domain: z.string().optional().describe('domain to diagnose (defaults to site domain)'),
      site: siteField,
    }).shape,
    run(args) {
      return {
        description: '站点 GEO/SEO 健康诊断与可读报告',
        messages: msg(
          `对域名=${args.domain || '(站点默认)'}（站点=${args.site || '(自动选择)'}）做一次 GEO/SEO 健康诊断。\n` +
            `调用 diagnose_site，按 0-100 分与分维度结果整理成一份面向非技术读者的报告：` +
            `Top 问题、各维度得分、修复优先级。全部探测为只读，不修改任何站点。`
        ),
      };
    },
  },
  {
    name: 'multilingual_publish',
    title: '多语言发布',
    description:
      '把同一文章发布到 zh-hans/en/zh-hant，共享头图、语言前缀链接、过翻译门。',
    argsSchema: z.object({
      article: z.string().describe('article slug or identifier'),
      languages: z
        .string()
        .optional()
        .describe('comma-separated target languages, e.g. "en,zh-hant" (default: en,zh-hant)'),
      site: siteField,
    }).shape,
    run(args) {
      const languages = (args.languages || 'en,zh-hant').split(',').map((s) => s.trim()).filter(Boolean);
      return {
        description: '同一文章的多语言发布指引',
        messages: msg(
          `把站点=${args.site || '(自动选择)'} 的文章=${args.article} 发布到语言：${languages.join(', ')}。\n` +
            `规则：\n` +
            `1) 三种语言共享同一 featured image（不重复上传）；\n` +
            `2) 站内链接必须带各语言前缀（/zh-hans/ /en/ /zh-hant/），slug 不变；\n` +
            `3) 先调 translation_glossary_get 读术语表，再对目标语言跑 check_translation 过 T 系列门禁；\n` +
            `4) 语言代码仅用 zh-hans | en | zh-hant。`
        ),
      };
    },
  },
];

module.exports = { prompts };
