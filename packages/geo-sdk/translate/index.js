'use strict';
/**
 * translate domain — mechanical translation gate (T1–T9).
 * Pure code, no LLM. The harness performs the actual translation with its own
 * model; this domain only judges whether a translation is structurally sound.
 */
const gate = require('./gate');
const glossary = require('./glossary');

module.exports = { ...gate, glossary };
