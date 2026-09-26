'use strict';
/**
 * Drive the rewrite→validate→publish flow through the LIVE geo-mcp HTTP server.
 * Reads 3 rewritten markdown files, calls channel_check (validate) then
 * channel_publish (Mode B, pushes rewritten drafts to the WeChat draft box).
 * This is the same MCP interface the agent uses (Streamable HTTP / JSON-RPC 2.0).
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.MCP_BASE || 'http://127.0.0.1:8787/messages';
const TOKEN = process.env.MCP_TOKEN || 'sk-13e7ea6b5cb82ec6140180057284d86d';
const DIR = '/Users/tim/tengence/geo-workspace/www_tengence_com/data/channel-export/wechat-rewrite-2026-09-26';

const FILES = [
  'long-tail-keyword-strategy',
  'ai-era-link-building',
  'schema-markup-ai-era',
];

function parseSse(text) {
  // server may respond with JSON or text/event-stream; extract the data payload
  if (text.trim().startsWith('{')) return JSON.parse(text);
  let last = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) {
      const j = t.slice(5).trim();
      if (j) last = j;
    }
  }
  return last ? JSON.parse(last) : null;
}

async function rpc(method, params, id, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const body = { jsonrpc: '2.0', method, params: params || {}, id };
  const res = await fetch(BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const newSession = res.headers.get('mcp-session-id') || sessionId;
  const text = await res.text();
  const json = parseSse(text);
  return { json, sessionId: newSession, status: res.status };
}

function toolResult(json) {
  // unwrap MCP tool response -> inner {ok,...} object
  const r = json && json.result && json.result.content;
  if (Array.isArray(r)) {
    for (const c of r) {
      if (c.type === 'text') return JSON.parse(c.text);
    }
  }
  return json;
}

(async () => {
  // 1) initialize
  let { json, sessionId } = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'rewrite-publish-cli', version: '1.0' },
  }, 1, null);
  console.log('[init]', json && json.result ? 'session ' + sessionId : 'FAILED', '\n');

  // 2) initialized notification
  await rpc('notifications/initialized', {}, null, sessionId);

  // 3) load rewritten articles
  const articles = FILES.map((slug) => {
    const md = fs.readFileSync(path.join(DIR, slug + '.md'), 'utf8');
    const m = md.match(/^#\s+(.+)\n([\s\S]*)$/);
    const title = m ? m[1].trim() : slug;
    const body = m ? m[2].trim() : md;
    return { slug, title, contentMd: body, rewrite: 'harness', mode: 'harness' };
  });

  // 4) channel_check for each
  let allOk = true;
  for (const a of articles) {
    const { json: j } = await rpc('tools/call', {
      name: 'channel_check',
      arguments: { platform: 'wechat', title: a.title, body: a.contentMd },
    }, 2, sessionId);
    const res = toolResult(j);
    console.log(`\n=== channel_check: ${a.slug} ===`);
    console.log('title :', a.title);
    console.log('ok    :', res && res.ok);
    if (res && res.errors && res.errors.length) {
      allOk = false;
      console.log('ERRORS:', JSON.stringify(res.errors, null, 2));
    }
    if (res && res.warnings && res.warnings.length) {
      console.log('WARNINGS:', JSON.stringify(res.warnings, null, 2));
    }
  }

  if (!allOk) {
    console.log('\n✋ channel_check found HARD errors — aborting publish. Fix above and re-run.');
    process.exit(1);
  }

  // 5) channel_publish Mode B -> push rewritten drafts to WeChat draft box
  console.log('\n=== channel_publish (wechat, Mode B, asDraft) ===');
  const { json: pj } = await rpc('tools/call', {
    name: 'channel_publish',
    arguments: {
      platform: 'wechat',
      site: 'www_tengence_com',
      articles,
      asDraft: true,
      keepOrder: true,
    },
  }, 3, sessionId);
  const pres = toolResult(pj);
  console.log(JSON.stringify(pres, null, 2));

  if (pres && pres.ok) {
    console.log('\n✅ Rewritten drafts pushed to WeChat draft box.');
    if (pres.refs && pres.refs.mediaId) console.log('   mediaId:', pres.refs.mediaId);
  } else {
    console.log('\n❌ Publish returned not-ok:', JSON.stringify(pres));
    process.exit(2);
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(3);
});
