import test from 'node:test';
import assert from 'node:assert/strict';
import { qzoneOfflineStatus } from '../src/core/qzone-status-offline.mjs';

const now = Date.parse('2026-11-08T03:00:00Z');
const state = () => ({ enabled: true, readAllowed: true, writeAllowed: false, accessPaused: true, writePaused: false,
  tools: { read_posts: true, read_comments: false, publish: false, comment: false, reply: false, like: false },
  limits: { post: 3, comment: 25, like: 30 }, ledger: { day: '2026-11-08', used: { post: 2, comment: 26, like: 0 }, reservations: {} },
  intervalMinutes: 100, activeStart: 420, activeEnd: 1380, token: 'must-not-leak', audit: [{ content: 'private' }] });

test('离线状态只显示允许的控制信息，不暴露私有状态', () => {
  const original = state();
  const result = qzoneOfflineStatus(original, now);
  assert.equal(result.enabled, true);
  assert.equal(result.accessPaused, true);
  assert.deepEqual(result.quota.comment, { used: 26, limit: 25, remaining: 0 });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(original.ledger.used.comment, 26);
});

test('状态按北京时间展示今日额度，旧日计数视为零但不改持久数据', () => {
  const original = state(); original.ledger.day = '2026-11-07';
  const result = qzoneOfflineStatus(original, now);
  assert.equal(result.day, '2026-11-08');
  assert.deepEqual(result.quota.post, { used: 0, limit: 3, remaining: 3 });
  assert.equal(original.ledger.used.post, 2);
});

test('未来日期、无效权限和损坏额度不返回正常状态', () => {
  const future = state(); future.ledger.day = '2026-11-09';
  assert.throws(() => qzoneOfflineStatus(future, now));
  const corrupt = state(); corrupt.ledger.used.post = -1;
  assert.throws(() => qzoneOfflineStatus(corrupt, now));
  const invalid = state(); delete invalid.tools.reply;
  assert.throws(() => qzoneOfflineStatus(invalid, now));
});
