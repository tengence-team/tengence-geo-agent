/**
 * CLI dynamic output (progress / success / failure / tables)
 * ============================================================================
 * New module added in batch A, no callers yet; later batches gradually replace the
 * scattered console.log calls in each script. Goal: unify the output style of the
 * scripts (emoji + step numbers + indentation) while keeping the ability to disable
 * decoration under "non-TTY / --quiet".
 * ============================================================================
 */

const EMOJI = {
  ok: '✅',
  fail: '❌',
  warn: '⚠️',
  info: 'ℹ️',
  doc: '📄',
  image: '🖼️',
  save: '💾',
  db: '🗄️',
  wp: '🌐',
  search: '🔍',
  list: '📋',
  step: '▶️',
};

let quiet = false;

/** Global silence (--quiet / CI scenarios) */
function setQuiet(v) {
  quiet = !!v;
}

function isQuiet() {
  return quiet;
}

function raw(...args) {
  if (!quiet) console.log(...args);
}

/** Step title: [2/7] Saving body */
function step(index, total, message) {
  raw(`\n[${index}/${total}] ${message}...`);
}

/** One success line */
function ok(message) {
  raw(`  ${EMOJI.ok} ${message}`);
}

/** One failure line */
function fail(message) {
  raw(`  ${EMOJI.fail} ${message}`);
}

/** One warning line */
function warn(message) {
  raw(`  ${EMOJI.warn} ${message}`);
}

/** One info line */
function info(message) {
  raw(`  ${EMOJI.info} ${message}`);
}

/** Generic line with an emoji */
function line(emoji, message) {
  raw(`  ${emoji || ''} ${message}`.replace(/^\s+/, '  '));
}

/** Blank line */
function blank() {
  raw('');
}

/** Indented key-value block */
function kv(pairs) {
  for (const [k, v] of Object.entries(pairs)) raw(`    ${k}: ${v}`);
}

/**
 * Minimal table (monospace alignment; CJK chars count as 2 columns)
 * @param {Array<Object>} rows
 * @param {Array<string>} [columns] default: keys of the first row
 */
function table(rows, columns) {
  if (!rows || rows.length === 0) {
    raw('  (empty)');
    return;
  }
  const cols = columns || Object.keys(rows[0]);
  const width = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - width(s)));

  const widths = cols.map((c) => Math.max(width(c), ...rows.map((r) => width(r[c] ?? ''))));
  raw('  ' + cols.map((c, i) => pad(c, widths[i])).join('  '));
  raw('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) raw('  ' + cols.map((c, i) => pad(r[c] ?? '', widths[i])).join('  '));
}

module.exports = {
  EMOJI,
  setQuiet,
  isQuiet,
  raw,
  step,
  ok,
  fail,
  warn,
  info,
  line,
  blank,
  kv,
  table,
};
