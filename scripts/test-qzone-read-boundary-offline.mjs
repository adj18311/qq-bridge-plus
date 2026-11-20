import test from 'node:test';
import assert from 'node:assert/strict';
import * as boundary from '../src/core/qzone-read-boundary-offline.mjs';

test('评论读取前先核验目标说说的可信元数据，普通好友旧贴不放行', () => {
  assert.equal(typeof boundary.allowOfflineComments, 'function');
  const now = Date.parse('2026-11-07T00:00:00Z');
  const scope = { author: '123', friend: true, admin: false, now };
  const target = { author: '123', id: 'post1' };
  assert.equal(boundary.allowOfflineComments(target, null, scope), false);
  assert.equal(boundary.allowOfflineComments(target, { ...target, time: now - 8 * 86400000 }, scope), false);
  assert.equal(boundary.allowOfflineComments(target, { ...target, time: now - 1000 }, scope), true);
  assert.equal(boundary.allowOfflineComments(target, { author: '456', id: 'post1', time: now }, scope), false);
  assert.equal(boundary.allowOfflineComments(target, { author: '123', id: 'post2', time: now }, scope), false);
});

test('t47：只有精确分享能读指定旧贴评论 —— admin 不再放行，也不能借例外放行其他帖子', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const target = { author: '123', id: 'post1' };
  const evidence = { ...target, time: now - 30 * 86400000 };
  // 用户裁决取消「管理员看全部」：这条旧正控现在必须 **false**。
  assert.equal(boundary.allowOfflineComments(target, evidence, { now, author: '123', admin: true }), false,
    '★ admin 不得再读 30 天前帖子的评论：特权已取消');
  // 仍然活着的例外：别人把这一条分享给他。
  assert.equal(boundary.allowOfflineComments(target, evidence, { now, author: '123', sharedPostId: 'post1' }), true);
  assert.equal(boundary.allowOfflineComments({ ...target, id: 'post2' }, evidence, { now, author: '123', sharedPostId: 'post1' }), false);
  // 对照：好友 + 7 天内仍然放行，证明上面的拒绝来自「没有例外」而不是校验坏掉。
  assert.equal(boundary.allowOfflineComments(target, { ...target, time: now - 1000 },
    { now, author: '123', friend: true }), true);
});
