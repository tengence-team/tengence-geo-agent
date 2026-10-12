'use strict';
/**
 * Shared language-code constants (@tengence/geo-mcp/tools/languages)
 * ============================================================================
 * Single source of truth for the unified language identifiers (2026-10-07):
 * zh-hans | en | zh-hant. Consumed by the tool registry (entry gates) and the
 * glossary resources (enumerable languages). Do not redefine the list elsewhere.
 */

const LANG_LIST = ['zh-hans', 'en', 'zh-hant'];
const LANG_OK = new Set(LANG_LIST);
const LANG_LEGACY = new Set(['zh-cn', 'en-us', 'zh-hk', 'zh-tw', 'zh-sg', 'zh-mo']);

module.exports = { LANG_LIST, LANG_OK, LANG_LEGACY };
