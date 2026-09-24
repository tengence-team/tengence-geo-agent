/**
 * WeChat mass-send / preview / delete capabilities (offline, injected request)
 * ============================================================================
 * Locks in the push-capability functions added on top of the draft pipeline:
 *   - massSend: sendall (all / tag) vs send (openids), clientmsgid dedupe,
 *     send_ignore_reprint, dryRun builds the payload without sending
 *   - massPreview: touser / towxname
 *   - massStatus: message/mass/get shape
 *   - massDelete / deletePublished: payload shape (index optional)
 * All calls use an injected fake token + fake request — no network, no env.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { massSend, massPreview, massStatus, massDelete, deletePublished } = require('../packages/geo-sdk/syndicate/wechat');

const FAKE_TOKEN = 'fake-token';
const calls = [];
const okRequest = async (url, _opts, body) => {
  calls.push({ url, body: JSON.parse(body) });
  return { statusCode: 200, json: { errcode: 0, errmsg: 'ok', msg_id: 777, msg_data_id: 888 } };
};

test('massSend: dryRun builds payload without sending', async () => {
  const r = await massSend('MEDIA_1', { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(r.payload);
  assert.deepEqual(r.payload.filter, { is_to_all: true });
  assert.equal(r.payload.mpnews.media_id, 'MEDIA_1');
  assert.equal(r.payload.send_ignore_reprint, 1);
});

test('massSend: all / tag / openids route to the right endpoint with clientmsgid', async () => {
  calls.length = 0;
  await massSend('MEDIA_1', { accessToken: FAKE_TOKEN, request: okRequest });
  assert.match(calls[0].url, /\/message\/mass\/sendall\?access_token=fake-token$/);
  assert.deepEqual(calls[0].body.filter, { is_to_all: true });

  calls.length = 0;
  await massSend('MEDIA_1', { tagId: 42, clientMsgId: 'uniq-1', accessToken: FAKE_TOKEN, request: okRequest });
  assert.match(calls[0].url, /\/message\/mass\/sendall/);
  assert.deepEqual(calls[0].body.filter, { is_to_all: false, tag_id: 42 });
  assert.equal(calls[0].body.clientmsgid, 'uniq-1');

  calls.length = 0;
  await massSend('MEDIA_1', { toUsers: ['open_a', 'open_b'], accessToken: FAKE_TOKEN, request: okRequest });
  assert.match(calls[0].url, /\/message\/mass\/send\?access_token=fake-token$/);
  assert.deepEqual(calls[0].body.touser, ['open_a', 'open_b']);
  assert.equal(calls[0].body.msgtype, 'mpnews');
  const r = await massSend('MEDIA_1', { toUsers: ['open_a'], accessToken: FAKE_TOKEN, request: okRequest });
  assert.equal(r.msgId, 777);
});

test('massPreview: touser vs towxname payload', async () => {
  calls.length = 0;
  await massPreview('MEDIA_1', { openid: 'open_x', accessToken: FAKE_TOKEN, request: okRequest });
  assert.match(calls[0].url, /\/message\/mass\/preview/);
  assert.equal(calls[0].body.touser, 'open_x');
  assert.equal(calls[0].body.mpnews.media_id, 'MEDIA_1');

  calls.length = 0;
  await massPreview('MEDIA_1', { wxname: 'someuser', accessToken: FAKE_TOKEN, request: okRequest });
  assert.equal(calls[0].body.towxname, 'someuser');
  assert.equal(calls[0].body.touser, undefined);

  await assert.rejects(() => massPreview('MEDIA_1', { accessToken: FAKE_TOKEN, request: okRequest }), /openid or wxname/);
});

test('massStatus: queries message/mass/get with msg_id', async () => {
  calls.length = 0;
  const st = await massStatus(777, {
    accessToken: FAKE_TOKEN,
    request: async (url, _o, body) => {
      calls.push({ url, body: JSON.parse(body) });
      return { statusCode: 200, json: { errcode: 0, msg_id: 777, msg_status: 'send success', total_count: 3, filter_count: 3, sent_count: 2, error_count: 1 } };
    },
  });
  assert.match(calls[0].url, /\/message\/mass\/get/);
  assert.equal(calls[0].body.msg_id, 777);
  assert.equal(st.status, 'send success');
  assert.deepEqual(st.counts, { total: 3, filter: 3, sent: 2, error: 1 });
});

test('massDelete: payload shape', async () => {
  calls.length = 0;
  await massDelete(777, { accessToken: FAKE_TOKEN, request: okRequest });
  assert.match(calls[0].url, /\/message\/mass\/delete/);
  assert.deepEqual(calls[0].body, { msg_id: 777 });
});

test('deletePublished: whole message vs single index; dryRun', async () => {
  const dr = await deletePublished('ARTICLE_1', { dryRun: true });
  assert.equal(dr.dryRun, true);
  assert.deepEqual(dr.payload, { article_id: 'ARTICLE_1' });

  calls.length = 0;
  await deletePublished('ARTICLE_1', { index: 2, accessToken: FAKE_TOKEN, request: okRequest });
  assert.match(calls[0].url, /\/freepublish\/delete/);
  assert.deepEqual(calls[0].body, { article_id: 'ARTICLE_1', index: 2 });
});
