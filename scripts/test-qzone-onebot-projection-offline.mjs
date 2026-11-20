import test from 'node:test';
import assert from 'node:assert/strict';
import { projectQzoneOnebotMsgList } from '../src/core/qzone-onebot-projection-offline.mjs';

const now = Date.parse('2026-11-08T03:00:00.000Z');
const tid = '1127000000f1536501000000';

function envelope(msglist) {
  return { status: 'ok', retcode: 0, data: { total: msglist.length, msglist } };
}

test('requires total to be a non-negative safe integer', () => {
  const missingTotal = { status: 'ok', retcode: 0, data: { msglist: [] } };
  assert.throws(() => projectQzoneOnebotMsgList(9876543210, missingTotal, now));

  for (const total of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(() => projectQzoneOnebotMsgList(9876543210, { status: 'ok', retcode: 0, data: { total, msglist: [] } }, now));
  }
  for (const total of [0, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(projectQzoneOnebotMsgList(9876543210, { status: 'ok', retcode: 0, data: { total, msglist: [] } }, now), []);
  }
});

test('accepts at most 100 rows independently of total', () => {
  const row = { tid: 'post-1', content: 'hello', time: now / 1000 - 1 };
  const data = { total: 0, msglist: Array.from({ length: 100 }, () => ({ ...row })) };
  assert.equal(projectQzoneOnebotMsgList(9876543210, { status: 'ok', retcode: 0, data }, now).length, 100);
  data.msglist.push({ ...row });
  assert.throws(() => projectQzoneOnebotMsgList(9876543210, { status: 'ok', retcode: 0, data }, now));
});

test('rejects a nonzero retcode and missing data independently', () => {
  const raw = envelope([]);
  assert.throws(() => projectQzoneOnebotMsgList(9876543210, { ...raw, retcode: 1 }, now));
  assert.throws(() => projectQzoneOnebotMsgList(9876543210, { status: 'ok', retcode: 0 }, now));
});

test('projects the requested QQ and strict list fields; converts Unix seconds to milliseconds', () => {
  const raw = envelope([{
    tid,
    content: 'hello',
    time: Math.floor(now / 1000) - 1,
    secret: 1,
    token: 'credential-must-not-leak',
    cookie: 'cookie-must-not-leak',
    nested: { password: 'nested-secret' }
  }]);

  const result = projectQzoneOnebotMsgList('9876543210', raw, now);

  assert.deepEqual(result, [{ author: '9876543210', id: tid, time: now - 1000, content: 'hello', images: [] }]);
  // images joined the projected shape (t29): the platform returns photo-store URLs and the read
  // used to drop them entirely, so the model could never answer what is in a post.
  assert.deepEqual(Object.keys(result[0]).sort(), ['author', 'content', 'id', 'images', 'time']);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('nested-secret'), false);
});

test('projects application-safe post ids and rejects invalid symbols or lengths', () => {
  const row = { tid: 'post-1', content: 'hello', time: Math.floor(now / 1000) - 1 };
  assert.deepEqual(
    projectQzoneOnebotMsgList(9876543210, envelope([row]), now),
    [{ author: '9876543210', id: 'post-1', time: now - 1000, content: 'hello', images: [] }]
  );

  for (const invalidTid of ['', 'bad.id', 'bad/id', 'bad id', 'x'.repeat(129)]) {
    assert.throws(() => projectQzoneOnebotMsgList(9876543210, envelope([{ ...row, tid: invalidTid }]), now));
  }
  for (const boundaryTid of ['a', 'x'.repeat(128)]) {
    assert.equal(
      projectQzoneOnebotMsgList(9876543210, envelope([{ ...row, tid: boundaryTid }]), now)[0].id,
      boundaryTid
    );
  }
});

test('accepts a timestamp exactly equal to now and rejects future or millisecond-unit timestamps', () => {
  assert.equal(projectQzoneOnebotMsgList(9876543210, envelope([{ tid, content: '', time: now / 1000 }]), now)[0].time, now);
  for (const time of [now / 1000 + 1, now]) {
    assert.throws(() => projectQzoneOnebotMsgList(9876543210, envelope([{ tid, content: '', time }]), now));
  }
});

test('rejects invalid, unsafe, fractional, negative, and out-of-range timestamps', () => {
  for (const time of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER, 8_640_000_000_001, '1794106800', null]) {
    assert.throws(() => projectQzoneOnebotMsgList(9876543210, envelope([{ tid, content: 'private raw', time }]), now));
  }
});

test('fails closed on unsuccessful or malformed envelopes and rows without leaking raw values', () => {
  const malformed = [
    { status: 'failed', retcode: 1, data: { msglist: [{ tid, content: 'secret body', time: 1 }] } },
    { status: 'ok', retcode: 0, data: { total: 0, msglist: {} } },
    envelope([{ tid: 'bad.tid.secret', content: 'secret body', time: now / 1000 - 1 }]),
    envelope([{ tid, content: { secret: 'secret body' }, time: now / 1000 - 1 }]),
    envelope([{ tid, content: 'secret body', time: now / 1000 - 1 }, { tid: 'bad!', content: 'secret body', time: 1 }])
  ];

  for (const raw of malformed) {
    assert.throws(
      () => projectQzoneOnebotMsgList(9876543210, raw, now),
      (error) => !JSON.stringify(error).includes('secret body') && !JSON.stringify(error).includes('bad.tid.secret')
    );
  }
});

test('returns detached output unaffected by later input mutation', () => {
  const row = { tid, content: 'before', time: now / 1000 - 2 };
  const raw = envelope([row]);
  const result = projectQzoneOnebotMsgList('9876543210', raw, now);

  row.content = 'after';
  row.time = now / 1000;
  raw.data.msglist.push({ tid, content: 'later', time: now / 1000 });

  assert.deepEqual(result, [{ author: '9876543210', id: tid, time: now - 2000, content: 'before', images: [] }]);
});

test('rejects invalid target QQ and invalid explicit now', () => {
  const raw = envelope([]);
  for (const target of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '00123', 'qq-secret']) {
    assert.throws(() => projectQzoneOnebotMsgList(target, raw, now));
  }
  for (const invalidNow of [NaN, Infinity, 1.5, 8_640_000_000_000_001, -8_640_000_000_000_001]) {
    assert.throws(() => projectQzoneOnebotMsgList(9876543210, raw, invalidNow));
  }
});
