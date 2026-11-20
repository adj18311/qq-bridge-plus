import test from 'node:test';
import assert from 'node:assert/strict';

import * as policy from '../src/core/qzone-policy-offline.mjs';

test('北京时间零点划分自然日，不依赖宿主时区', () => {
  assert.equal(typeof policy.beijingDay, 'function');
  assert.equal(policy.beijingDay(Date.parse('2026-11-07T15:59:59Z')), '2026-11-07');
  assert.equal(policy.beijingDay(Date.parse('2026-11-07T16:00:00Z')), '2026-11-08');
});

test('每日额度零明确拒绝，允许 0 至 99', () => {
  assert.equal(typeof policy.checkDailyLimit, 'function');
  assert.equal(policy.checkDailyLimit(0, 0), false);
  assert.equal(policy.checkDailyLimit(24, 25), true);
  assert.equal(policy.checkDailyLimit(25, 25), false);
  assert.throws(() => policy.checkDailyLimit(0, 100));
  assert.throws(() => policy.checkDailyLimit(-1, 3));
});

test('权限拒绝不计熔断，其他真实失败分开累计', () => {
  assert.equal(typeof policy.nextFailureState, 'function');
  let state = { reads: 2, writes: 2, accessPaused: false, writePaused: false };
  state = policy.nextFailureState(state, 'read', 'not_accessible');
  assert.equal(state.reads, 2);
  state = policy.nextFailureState(state, 'read', 'failure');
  assert.equal(state.accessPaused, true);
  assert.equal(state.writePaused, false);
  state = policy.nextFailureState(state, 'write', 'failure');
  assert.equal(state.writePaused, true);
});

test('登录失效、验证码与网络不可用立即暂停全部访问', () => {
  const state = { reads: 0, writes: 0, accessPaused: false, writePaused: false };
  for (const reason of ['login_expired', 'captcha', 'network_unavailable']) {
    assert.equal(policy.nextFailureState(state, 'read', reason).accessPaused, true);
  }
});

test('成功只重置对应方向的失败计数，不自动解除暂停', () => {
  const state = { reads: 2, writes: 2, accessPaused: true, writePaused: true };
  assert.deepEqual(policy.nextFailureState(state, 'read', 'success'), {
    reads: 0, writes: 2, accessPaused: true, writePaused: true,
  });
});

test('好友默认只允许一周内内容，未知时间不得放行', () => {
  assert.equal(typeof policy.canReadPost, 'function');
  const now = Date.parse('2026-11-07T00:00:00Z');
  const post = { author: '123', id: 'post-1', time: now - 7 * 86400000 };
  const scope = { now, admin: false, friend: true, author: '123' };
  assert.equal(policy.canReadPost(post, scope), true);
  assert.equal(policy.canReadPost({ ...post, time: post.time - 1 }, scope), false);
  assert.equal(policy.canReadPost({ ...post, time: null }, scope), false);
  assert.equal(policy.canReadPost({ ...post, time: now + 1 }, scope), false);
});

test('分享仅允许所指定作者和说说，不能扩大到其他内容', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const scope = { now, admin: false, friend: false, author: '123', sharedPostId: 'p1' };
  assert.equal(policy.canReadPost({ author: '123', id: 'p1', time: now - 9 * 86400000 }, scope), true);
  assert.equal(policy.canReadPost({ author: '123', id: 'p2', time: now }, scope), false);
  assert.equal(policy.canReadPost({ author: '456', id: 'p1', time: now }, scope), false);
});

test('t47：admin 不再是特权 —— 带着 admin:true 也读不到历史，作者仍须一致', () => {
  // 用户裁决「取消管理员看全部」。这条测试**反向**钉住该裁决：
  // 旧行为（admin 可读任意历史）会让第一、二条断言红；那正是不允许再出现的行为。
  const scope = { now: 1000000000, admin: true, friend: false, author: '123' };
  assert.equal(policy.canReadPost({ author: '123', id: 'p1', time: null }, scope), false,
    '★ admin:true 不得再放行 time 未知的帖子（特权已取消）');
  assert.equal(policy.canReadPost({ author: '123', id: 'p1', time: 1 }, scope), false,
    '★ admin:true 不得再放行超期帖子');
  assert.equal(policy.canReadPost({ author: '456', id: 'p1', time: 1 }, scope), false,
    '作者不一致仍然拒绝（这一点没有变）');
  // 对照：真正还在的两条例外仍然有效。
  assert.equal(policy.canReadPost({ author: '123', id: 'p1', time: 1 },
    { now: 1000000000, author: '123', sharedPostId: 'p1' }), true, 'shared 仍然放行指定的那一条');
});

test('写操作间隔到边界才放行，时钟倒退拒绝', () => {
  assert.equal(typeof policy.checkInterval, 'function');
  assert.equal(policy.checkInterval(null, 1000, 7200000), true);
  assert.equal(policy.checkInterval(1000, 7200999, 7200000), false);
  assert.equal(policy.checkInterval(1000, 7201000, 7200000), true);
  assert.equal(policy.checkInterval(1000, 999, 0), false);
  assert.throws(() => policy.checkInterval(null, 1000, -1));
});

test('点赞去重按空间主人和说说共同识别', () => {
  assert.equal(typeof policy.wasLiked, 'function');
  const likes = [{ author: '123', id: 'p1' }];
  assert.equal(policy.wasLiked(likes, '123', 'p1'), true);
  assert.equal(policy.wasLiked(likes, '456', 'p1'), false);
  assert.equal(policy.wasLiked(likes, '123', 'p2'), false);
  assert.throws(() => policy.wasLiked(null, '123', 'p1'));
});

test('预留即消耗额度，结果未知不得退款且同一操作不得重复预留', () => {
  assert.equal(typeof policy.reserveWrite, 'function');
  const state = { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} };
  const input = { day: '2026-11-07', kind: 'comment', limit: 1, id: 'op-1' };
  const first = policy.reserveWrite(state, input);
  assert.equal(first.allowed, true);
  assert.equal(first.state.used.comment, 1);
  assert.equal(state.used.comment, 0);
  assert.equal(policy.reserveWrite(first.state, input).allowed, false);
  assert.equal(policy.reserveWrite(first.state, { ...input, id: 'op-2' }).allowed, false);
});

test('新的一天重置计数但保留历史预留，时间倒退不放行', () => {
  const state = { day: '2026-11-07', used: { post: 3, comment: 4, like: 5 }, reservations: { old: 'post' } };
  const result = policy.reserveWrite(state, { day: '2026-11-08', kind: 'post', limit: 3, id: 'new' });
  assert.deepEqual(result.state.used, { post: 1, comment: 0, like: 0 });
  assert.equal(result.state.reservations.old, 'post');
  assert.throws(() => policy.reserveWrite(state, { day: '2026-11-06', kind: 'post', limit: 3, id: 'x' }));
});

test('分别重置当日额度不清除冷却、暂停或已有预留', () => {
  assert.equal(typeof policy.resetDailyCounter, 'function');
  const state = { day: '2026-11-07', used: { post: 3, comment: 4, like: 5 }, reservations: { old: 'post' }, writePaused: true, lastPostAt: 123 };
  const next = policy.resetDailyCounter(state, 'post');
  assert.deepEqual(next.used, { post: 0, comment: 4, like: 5 });
  assert.equal(next.writePaused, true);
  assert.equal(next.lastPostAt, 123);
  assert.equal(next.reservations.old, 'post');
  assert.equal(state.used.post, 3);
});

test('危险属性名不能作为预留编号绕过去重', () => {
  const state = { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} };
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => policy.reserveWrite(state, { day: state.day, kind: 'post', limit: 3, id }));
  }
});

test('24小时探测必须启用、服务可用且处于主动时段，最多领取一次', () => {
  assert.equal(typeof policy.claimRecoveryProbe, 'function');
  const state = { accessPaused: true, writePaused: true, pausedAt: 1000, probe: 'waiting' };
  const options = { enabled: true, serviceReady: true, activeTime: true, now: 1000 + 86400000 };
  assert.equal(policy.claimRecoveryProbe(state, { ...options, now: options.now - 1 }).claimed, false);
  assert.equal(policy.claimRecoveryProbe(state, { ...options, enabled: false }).claimed, false);
  assert.equal(policy.claimRecoveryProbe(state, { ...options, serviceReady: false }).claimed, false);
  assert.equal(policy.claimRecoveryProbe(state, { ...options, activeTime: false }).claimed, false);
  const claimed = policy.claimRecoveryProbe(state, options);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.state.probe, 'claimed');
  assert.equal(policy.claimRecoveryProbe(claimed.state, options).claimed, false);
});

test('健康探测成功清除两层暂停但不改额度，失败只能手动恢复', () => {
  assert.equal(typeof policy.finishRecoveryProbe, 'function');
  const state = { accessPaused: true, writePaused: true, pausedAt: 1000, probe: 'claimed', used: { post: 2 },
    pauseCycles: { access: { id: 'a', operationId: 'r', cause: 'captcha' }, write: { id: 'w', operationId: 'w1', cause: 'failure' } } };
  const ok = policy.finishRecoveryProbe(state, 'success');
  assert.equal(ok.accessPaused, false);
  assert.equal(ok.writePaused, false);
  assert.equal(ok.used.post, 2);
  assert.deepEqual(ok.pauseCycles, { access: null, write: null });
  const failed = policy.finishRecoveryProbe(state, 'failure');
  assert.equal(failed.accessPaused, true);
  assert.equal(failed.writePaused, true);
  assert.equal(failed.probe, 'manual_only');
  assert.deepEqual(failed.pauseCycles, state.pauseCycles);
  assert.throws(() => policy.finishRecoveryProbe(failed, 'success'));
});

test('入口检查总开关、读写权限和对应暂停状态，默认拒绝不完整输入', () => {
  assert.equal(typeof policy.authorizeOperation, 'function');
  const context = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false };
  assert.equal(policy.authorizeOperation(context, 'read').allowed, true);
  assert.equal(policy.authorizeOperation(context, 'write').allowed, true);
  for (const key of ['enabled', 'readAllowed']) assert.equal(policy.authorizeOperation({ ...context, [key]: false }, 'read').allowed, false);
  for (const key of ['enabled', 'writeAllowed']) assert.equal(policy.authorizeOperation({ ...context, [key]: false }, 'write').allowed, false);
  assert.equal(policy.authorizeOperation({ ...context, writePaused: true }, 'read').allowed, true);
  assert.equal(policy.authorizeOperation({ ...context, writePaused: true }, 'write').allowed, false);
  assert.equal(policy.authorizeOperation({ ...context, accessPaused: true }, 'read').allowed, false);
  assert.equal(policy.authorizeOperation({ ...context, accessPaused: true }, 'write').allowed, false);
  assert.equal(policy.authorizeOperation({}, 'read').allowed, false);
  assert.equal(policy.authorizeOperation(context, 'other').allowed, false);
});

test('主动时段按北京时间，起点包含终点不包含，支持跨午夜', () => {
  assert.equal(typeof policy.isActiveTime, 'function');
  assert.equal(policy.isActiveTime(Date.parse('2026-11-06T23:00:00Z'), 420, 1380), true);
  assert.equal(policy.isActiveTime(Date.parse('2026-11-07T15:00:00Z'), 420, 1380), false);
  assert.equal(policy.isActiveTime(Date.parse('2026-11-07T15:30:00Z'), 1380, 420), true);
  assert.equal(policy.isActiveTime(Date.parse('2026-11-07T04:00:00Z'), 1380, 420), false);
  assert.throws(() => policy.isActiveTime(0, 420, 420));
});

test('写暂停时主动浏览遵守每小时一次和每日三次，请求查看不消耗主动预算', () => {
  assert.equal(typeof policy.checkBrowseBudget, 'function');
  const state = { enabled: true, readAllowed: true, accessPaused: false, writePaused: true,
    activeTime: true, lastBrowseAt: 1000, todayBrowses: 2, now: 3601000 };
  assert.equal(policy.checkBrowseBudget(state, 'proactive').allowed, true);
  assert.equal(policy.checkBrowseBudget({ ...state, now: 3600999 }, 'proactive').allowed, false);
  assert.equal(policy.checkBrowseBudget({ ...state, todayBrowses: 3 }, 'proactive').allowed, false);
  assert.equal(policy.checkBrowseBudget({ ...state, activeTime: false }, 'requested').allowed, true);
  assert.equal(policy.checkBrowseBudget({ ...state, enabled: false }, 'requested').allowed, false);
  assert.equal(policy.checkBrowseBudget({ ...state, accessPaused: true }, 'requested').allowed, false);
  assert.equal(policy.checkBrowseBudget({ ...state, activeTime: false }, 'proactive').allowed, false);
  assert.equal(policy.checkBrowseBudget({ ...state, lastBrowseAt: state.now + 1 }, 'proactive').allowed, false);
});

test('主动机会间隔至少十五分钟，只检查配置不启动计时器', () => {
  assert.equal(typeof policy.validatePatrolInterval, 'function');
  assert.equal(policy.validatePatrolInterval(15), true);
  assert.equal(policy.validatePatrolInterval(100), true);
  for (const value of [0, 14, -1, 15.5, NaN, '100']) assert.equal(policy.validatePatrolInterval(value), false);
});

test('审计保留北京时间最近七个自然日，只识别严格日期文件名', () => {
  assert.equal(typeof policy.auditRetentionDecision, 'function');
  const now = Date.parse('2026-11-07T16:00:00Z');
  assert.equal(policy.auditRetentionDecision('2026-11-02.jsonl', now), 'keep');
  assert.equal(policy.auditRetentionDecision('2026-11-01.jsonl', now), 'expired');
  assert.equal(policy.auditRetentionDecision('2026-11-09.jsonl', now), 'future');
  assert.equal(policy.auditRetentionDecision('../2026-11-01.jsonl', now), 'ignore');
  assert.equal(policy.auditRetentionDecision('2026-02-30.jsonl', now), 'ignore');
  assert.equal(policy.auditRetentionDecision('quota.json', now), 'ignore');
  assert.throws(() => policy.auditRetentionDecision('2026-11-01.jsonl', NaN));
});

test('手动恢复可分别解除两层，不改变额度和另一层暂停', () => {
  assert.equal(typeof policy.manualRestore, 'function');
  const state = { accessPaused: true, writePaused: true, reads: 3, writes: 3, probe: 'manual_only', used: { post: 3 },
    pauseCycles: { access: { id: 'a', cause: 'captcha', operationId: 'r' }, write: { id: 'w', cause: 'failure', operationId: 'w' } } };
  const read = policy.manualRestore(state, 'access');
  assert.equal(read.accessPaused, false);
  assert.equal(read.writePaused, true);
  assert.equal(read.reads, 0);
  assert.equal(read.writes, 3);
  assert.equal(read.pauseCycles.access, null);
  assert.equal(read.pauseCycles.write.id, 'w');
  assert.equal(read.used.post, 3);
  const write = policy.manualRestore(state, 'write');
  assert.equal(write.accessPaused, true);
  assert.equal(write.writePaused, false);
  assert.equal(write.writes, 0);
  assert.equal(write.pauseCycles.access.id, 'a');
  assert.equal(write.pauseCycles.write, null);
  const both = policy.manualRestore(state, 'both');
  assert.equal(both.accessPaused, false);
  assert.equal(both.writePaused, false);
  assert.equal(both.used.post, 3);
  assert.deepEqual(both.pauseCycles, { access: null, write: null });
  assert.throws(() => policy.manualRestore(state, 'invalid'));
});

test('旧内容一次性授权只匹配可信请求者本人、问题和具体说说', () => {
  assert.equal(typeof policy.consumeHistoryGrant, 'function');
  const grant = { requester: '100', author: '100', question: 'q1', postId: 'p1', status: 'ready' };
  const request = { requester: '100', author: '100', question: 'q1', postId: 'p1' };
  for (const change of [{ requester: '200' }, { author: '200' }, { question: 'q2' }, { postId: 'p2' }]) {
    assert.equal(policy.consumeHistoryGrant(grant, { ...request, ...change }).allowed, false);
  }
  const result = policy.consumeHistoryGrant(grant, request);
  assert.equal(result.allowed, true);
  assert.equal(result.grant.status, 'consumed');
  assert.equal(grant.status, 'ready');
  assert.equal(policy.consumeHistoryGrant(result.grant, request).allowed, false);
  assert.equal(policy.consumeHistoryGrant({ ...grant, author: '200' }, { ...request, author: '200' }).allowed, false);
});

test('未限定具体说说的历史授权仅属于相同问题，消费后不能重试', () => {
  const grant = { requester: '100', author: '100', question: 'q1', postId: null, status: 'ready' };
  const request = { requester: '100', author: '100', question: 'q1', postId: null };
  const result = policy.consumeHistoryGrant(grant, request);
  assert.equal(result.allowed, true);
  assert.equal(policy.consumeHistoryGrant(result.grant, request).allowed, false);
  assert.equal(policy.consumeHistoryGrant(grant, { ...request, question: '' }).allowed, false);
});

test('具体工具权限在每次调用时检查，未知工具和缺失权限默认拒绝', () => {
  assert.equal(typeof policy.authorizeTool, 'function');
  const context = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: false, publish: true, comment: true, reply: true, like: true } };
  assert.equal(policy.authorizeTool(context, 'read_posts').allowed, true);
  assert.equal(policy.authorizeTool(context, 'read_comments').allowed, false);
  assert.equal(policy.authorizeTool(context, 'publish').allowed, true);
  assert.equal(policy.authorizeTool({ ...context, writePaused: true }, 'publish').allowed, false);
  assert.equal(policy.authorizeTool({ ...context, enabled: false }, 'read_posts').allowed, false);
  assert.equal(policy.authorizeTool(context, 'unknown').allowed, false);
  assert.equal(policy.authorizeTool({ ...context, tools: {} }, 'publish').allowed, false);
});

test('新评论事件例外仅允许读取自己的指定说说和对应新评论', () => {
  assert.equal(typeof policy.canReadNewOwnComment, 'function');
  const event = { selfId: '100', author: '100', postId: 'p1', commentId: 'c1', isNew: true };
  const target = { author: '100', postId: 'p1', commentId: 'c1' };
  assert.equal(policy.canReadNewOwnComment(event, target), true);
  for (const change of [{ author: '200' }, { postId: 'p2' }, { commentId: 'c2' }, { commentId: null }]) {
    assert.equal(policy.canReadNewOwnComment(event, { ...target, ...change }), false);
  }
  assert.equal(policy.canReadNewOwnComment({ ...event, isNew: false }, target), false);
  assert.equal(policy.canReadNewOwnComment({ ...event, selfId: '200' }, target), false);
  assert.equal(policy.canReadNewOwnComment({ ...event, commentId: '' }, target), false);
});

test('离线模拟列表只向调用方返回授权范围内的条目', () => {
  assert.equal(typeof policy.filterOfflinePosts, 'function');
  const now = Date.parse('2026-11-07T00:00:00Z');
  const scope = { now, author: '123', friend: true, admin: false };
  const items = [
    { author: '123', id: 'ok', time: now - 1000, content: 'visible', comments: [{ content: 'NESTED SECRET' }], rawResponse: { cookie: 'RAW SECRET' } },
    { author: '123', id: 'old', time: now - 8 * 86400000, content: 'OLD SECRET' },
    { author: '456', id: 'other', time: now, content: 'OTHER SECRET' },
    { author: '123', id: 'unknown', time: null },
  ];
  const filtered = policy.filterOfflinePosts(items, scope);
  assert.deepEqual(filtered.map((post) => post.id), ['ok']);
  assert.equal(JSON.stringify(filtered).includes('SECRET'), false);
  assert.equal(filtered[0].content, 'visible');
  assert.equal(Object.hasOwn(filtered[0], 'comments'), false);
  assert.equal(Object.hasOwn(filtered[0], 'rawResponse'), false);
  assert.throws(() => policy.filterOfflinePosts(null, scope));
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 任务卡 §3「响应中其他内容的处理和过滤边界」—— 集合过滤层的边界补齐
// ════════════════════════════════════════════════════════════════════════════════════════
//
// 任务卡 §3 原文：「底层若只能按页返回内容，须先核实响应中其他内容的处理和过滤边界，
// 不得假定只接触到匹配结果。」
//
// ⚠️ 本文件能证明什么、不能证明什么 —— 必须分三层看，不能混为一谈：
//
//   第 1 层  上游实际返回了什么                        → **未验证**（需真实平台观测）
//   第 2 层  过滤前有没有把原始响应记进日志/审计         → **本文件不覆盖**（审计侧另有测试）
//   第 3 层  给定一批数据，过滤函数是否只放行应看内容   → **本文件测的就是这一层**
//
// 结论口径：**本测试只覆盖集合过滤逻辑，不证明上游只返回了应看内容。**
//
// 另一条必须说清的事实：`qzone-live-friend-read.mjs:181` 是**一次调用**
// `{ target_uin, pos: 0, num: 20 }`，**没有翻页循环** —— 当前实现只读一页、最多 20 条。
// 任务卡的「近 7 天」规定的是**可读范围**，不是「必须读满、保证查全」。
// 因此下面把两批数据「分别过滤后拼接」的用例，只断言**集合过滤语义**，
// 既不代表系统支持翻页，也不代表能读满 7 天。

// ── canReadPost：t47 之后**没有** admin 特权，只剩 sharedPostId 一条例外 ──────────────
//
// 用户裁决「取消管理员看全部」。现在的校验顺序（qzone-policy-offline.mjs:41-56）：
//   ① 五项前置（post/scope 存在、scope.author 非空串、post.author 必须相等、
//      post.id 必须是非空字符串、scope.now 必须是有限数）
//   ② sharedPostId 命中 → true             ← 唯一的「越过 7 天」例外
//   ③ friend !== true 或 post.time 非有限 → false
//   ④ 7 天窗口
//
// `scope.admin` **不再被读取**。带着 admin:true 的 scope 走的是第 ②-④ 步，
// 也就是说：它连「跳过好友关系」都做不到，更不用说读历史。

test('t47：admin 特权已取消 —— 带 admin:true 也不跳过好友关系、不跳过 7 天窗口', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const day = 86400000;
  const adminScope = { now, admin: true, friend: false, author: '123' };
  const thirtyDaysAgo = now - 30 * day;

  // ── 反控（旧正控的反面）：每一条旧行为现在都必须被拒 ─────────────────────────
  assert.equal(
    policy.canReadPost({ author: '123', id: 'p1', time: thirtyDaysAgo }, adminScope),
    false,
    '★ admin 不得再读 30 天前的帖子：特权已按用户裁决取消，若这条绿，旧的“管理员看全部”又回来了',
  );
  assert.equal(
    policy.canReadPost({ author: '123', id: 'p1', time: null }, adminScope),
    false,
    '★ admin 不得再读 time 未知的帖子：那正是绕过时间判断的入口',
  );
  assert.equal(
    policy.canReadPost({ author: '123', id: 'p1', time: now + 30 * day }, adminScope),
    false,
    '★ admin 不得再读未来时间戳的帖子',
  );
  // 对照：同一个 admin scope 换成 friend:true 后，窗口内的帖子仍然可读 —— 证明上面三条
  // 的拒绝来自“没有特权”，而不是 scope 本身坏掉。
  assert.equal(
    policy.canReadPost({ author: '123', id: 'p1', time: now - day },
      { now, admin: true, friend: true, author: '123' }),
    true,
    '好友 + 7 天内仍然可读：admin 字段既不加权也不减权，它只是不再被读取',
  );

  // ── 反控 1：作者不匹配 → 必须 false（admin 不是「跨作者通行证」）───────────────
  assert.equal(
    policy.canReadPost({ author: '456', id: 'p1', time: now }, adminScope),
    false,
    'admin 也必须作者匹配：若这条红，管理员授权会被放大成「可读任意他人内容」，'
    + '直接突破任务卡 §3 的「按 QQ 号查询指定作者」边界',
  );

  // ── 反控 2：post.id 为空串 / 非字符串 → 必须 false（§3 的「只读这一条」靠 id 定位）──
  for (const badId of ['', null, 42, undefined]) {
    assert.equal(
      policy.canReadPost({ author: '123', id: badId, time: now }, adminScope),
      false,
      `admin 也必须带合法 post.id（收到 ${JSON.stringify(badId)}）：若这条红，`
      + '「只授权读取指定那一条」就退化成「授权读取该作者的全部内容」，'
      + '任务卡 §3 的逐条例外授权被放大成范围授权',
    );
  }

  // ── 反控 3：scope.now 非有限 → 必须 false（无法判断时间范围就不放行）────────────
  for (const badNow of [NaN, Infinity, -Infinity, '1000', null]) {
    assert.equal(
      policy.canReadPost({ author: '123', id: 'p1', time: now }, { ...adminScope, now: badNow }),
      false,
      `admin 也要求 scope.now 是有限数（收到 ${String(badNow)}）：若这条红，`
      + '在时钟损坏时仍会放行读取，7 天/历史边界的判断失去依据',
    );
  }
});

// ── canReadPost：sharedPostId 同样只跳过 7 天窗口，前置校验照旧 ──────────────────────

test('任务卡 §3：sharedPostId 只跳过 7 天窗口，作者与 id 前置校验不放松', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const day = 86400000;
  // friend:false —— 证明放行来自 sharedPostId 而不是好友关系
  const sharedScope = { now, admin: false, friend: false, author: '123', sharedPostId: 'p1' };

  // ── 正控：远超 7 天 + time 未知 都放行（第 ④⑤ 步被跳过）────────────────────────
  assert.equal(
    policy.canReadPost({ author: '123', id: 'p1', time: now - 400 * day }, sharedScope),
    true,
    '显式分享的那一条必须能读超过 7 天：若这条红，任务卡 §3「即使超过 7 天」的例外失效',
  );
  assert.equal(
    policy.canReadPost({ author: '123', id: 'p1', time: null }, sharedScope),
    true,
    '显式分享的那一条 time 未知也放行：若这条红，分享例外被额外的时间要求挡住',
  );

  // ── 反控 1：命中范围内的其它 id → false（分享不得扩展成浏览主页/历史）───────────
  assert.equal(
    policy.canReadPost({ author: '123', id: 'p2', time: now }, sharedScope),
    false,
    '分享只能读指定那一条：若这条红，一次分享会变成该作者全部内容的读取授权，'
    + '正是任务卡 §3「不得扩展为浏览主页或历史内容」禁止的越权',
  );

  // ── 反控 2：作者不匹配（即使 id 相同）→ false ─────────────────────────────────
  assert.equal(
    policy.canReadPost({ author: '456', id: 'p1', time: now }, sharedScope),
    false,
    'sharedPostId 也必须作者匹配：若这条红，副 author 的相同 id 会被当成分享目标，'
    + '读到未授权作者的内容',
  );

  // ── 反控 3：前置校验不放松（空 id / 非法 now）─────────────────────────────────
  assert.equal(
    policy.canReadPost({ author: '123', id: '', time: now }, sharedScope),
    false,
    'sharedPostId 路径也必须校验 post.id 非空：sharedPostId 命中比较需要 id，空 id 不该放行',
  );
  assert.equal(
    policy.canReadPost({ author: '123', id: 'p1', time: now }, { ...sharedScope, now: NaN }),
    false,
    'sharedPostId 路径也要求 scope.now 有限：若这条红，时钟损坏时分享路径仍会放行',
  );
});

// ── canReadPost：friend 标志必须是显式 true ────────────────────────────────────────

test('任务卡 §3：friend 必须是显式 true，缺失或 false 一律拒绝（默认拒绝）', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const post = { author: '123', id: 'p1', time: now - 1000 };

  assert.equal(
    policy.canReadPost(post, { now, author: '123', friend: false, admin: false }),
    false,
    '非好友不得读取：若这条红，任务卡 §3「非好友不得按 QQ 号主动拉取」直接失效',
  );

  // friend 缺失（undefined）不得被当成 truthy/默认放行。
  assert.equal(
    policy.canReadPost(post, { now, author: '123', admin: false }),
    false,
    'friend 缺失时必须默认拒绝：若这条红，任何忘记传 friend 的调用点都会静默变成「好友放行」，'
    + '这是最危险的默认值方向',
  );

  // 非布尔真值也不得放行（'true'、1 都不是 true）。
  for (const notTrue of ['true', 1, {}, []]) {
    assert.equal(
      policy.canReadPost(post, { now, author: '123', friend: notTrue, admin: false }),
      false,
      `friend 必须是布尔 true（收到 ${JSON.stringify(notTrue)} 时必须拒绝）：`
      + '否则字符串/数字形式的配置值会被误当成好友授权',
    );
  }

  // 正控：显式 friend:true 且范围内必须放行，证明上面不是「一律拒绝」。
  assert.equal(
    policy.canReadPost(post, { now, author: '123', friend: true, admin: false }),
    true,
    '正控：显式 friend:true 且在一周内必须放行，否则上面的拒绝断言不构成「默认拒绝」的证据',
  );
});

// ── canReadPost：post.id 必须是非空字符串 ──────────────────────────────────────────

test('任务卡 §3：post.id 必须是合法非空字符串，否则一律拒绝', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const scope = { now, author: '123', friend: true, admin: false };

  for (const badId of ['', null, undefined, 0, 42, {}, [], true]) {
    assert.equal(
      policy.canReadPost({ author: '123', id: badId, time: now }, scope),
      false,
      `post.id 非法时必须拒绝（收到 ${JSON.stringify(badId)}）：任务卡 §3 的逐条授权靠 id 定位，`
      + 'id 缺失或类型错误时无法确认读的是「哪一条」，不得默认放行',
    );
  }

  // 正控：合法 id 放行，证明上面的拒绝不是「整个函数都返回 false」。
  assert.equal(
    policy.canReadPost({ author: '123', id: 'valid-id', time: now }, scope),
    true,
    '正控：合法非空字符串 id 必须放行，否则上面的拒绝断言无法区分「校验严」与「函数坏了」',
  );
});

// ── filterOfflinePosts：两批分别过滤后拼接（只测集合过滤语义，不代表支持翻页）─────────

test('任务卡 §3：两批数据分别过滤后拼接，第二批混入的他人内容同样被剔除', () => {
  // ⚠️ 这不是「多页」验证。当前实现只发一次 `pos:0, num:20` 的请求，没有翻页循环；
  //    这里只是把两批假数据分别交给 filter，证明**过滤是按条目重新判定的**，
  //    不依赖「第一批干净 → 第二批也干净」这种会漏掉混入内容的假设。
  const now = Date.parse('2026-11-07T00:00:00Z');
  const scope = { now, author: '42', friend: true, admin: false };

  const batchA = [{ author: '42', id: 'p1', time: now }];
  const batchB = [
    { author: '42', id: 'p2', time: now },
    { author: '84', id: 'other', time: now },   // ← 必须被剔除
  ];

  const filteredA = policy.filterOfflinePosts(batchA, scope);
  const filteredB = policy.filterOfflinePosts(batchB, scope);
  const merged = [...filteredA, ...filteredB];

  assert.deepEqual(
    merged.map((post) => post.id),
    ['p1', 'p2'],
    '第二批混入的他人内容必须被单独剔除：若这条红，说明过滤只对「第一批」生效/'
    + '或结果被整批短路，任务卡 §3「不得假定只接触到匹配结果」的要求就落空了',
  );
  assert.equal(
    merged.some((post) => post.author !== '42'),
    false,
    '合并结果里不得残留任何非本人作者的条目：若这条红，他人内容会随第二批一起进入后续处理',
  );

  // 直接对比：一次性整批过滤与分批过滤必须得到同一组 id（顺序一致）。
  assert.deepEqual(
    policy.filterOfflinePosts([...batchA, ...batchB], scope).map((post) => post.id),
    merged.map((post) => post.id),
    '整批过滤与分批过滤必须一致：若不一致，说明过滤结果依赖输入的分组方式，'
    + '上游换一种取数方式就可能漏掉混入内容',
  );
});

// ── filterOfflinePosts：空输入与全被过滤 ───────────────────────────────────────────

test('任务卡 §3：空批次返回空数组，全部被过滤时也返回空数组（不报错、不返回原数据）', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const scope = { now, author: '123', friend: true, admin: false };

  assert.deepEqual(
    policy.filterOfflinePosts([], scope),
    [],
    '空批次必须返回空数组：若这条红（例如抛出或返回 null），调用方会在「平台返回 0 条」这个'
    + '正常场景上崩掉，或把 undefined 当成「没有需要过滤的内容」而跳过后续判断',
  );

  // 全部不合格：他人内容 + 超期 + time 未知，一条都不该留下。
  const allRejected = policy.filterOfflinePosts([
    { author: '456', id: 'x1', time: now, content: 'OTHER' },
    { author: '123', id: 'x2', time: now - 8 * 86400000, content: 'OLD' },
    { author: '123', id: 'x3', time: null, content: 'UNKNOWN' },
  ], scope);

  assert.deepEqual(
    allRejected,
    [],
    '全部不合格时必须返回空数组：若这条红，说明某些不合格条目被放行 —— '
    + '他人内容/超期内容/无时间戳内容任意一类泄漏都违反任务卡 §3',
  );
  assert.equal(
    JSON.stringify(allRejected).includes('OTHER') || JSON.stringify(allRejected).includes('OLD'),
    false,
    '被过滤掉的正文不得出现在返回值里：若这条红，说明过滤只删了对象外壳却留下了内容',
  );
});

// ── filterOfflinePosts：投影字段白名单 ─────────────────────────────────────────────

test('任务卡 §3：投影只返回 author/id/time/content 四个字段，新增字段一律不返回', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const scope = { now, author: '123', friend: true, admin: false };

  const filtered = policy.filterOfflinePosts([{
    author: '123', id: 'p1', time: now, content: 'visible',
    // 以下都不在白名单里，任何一种泄漏都会把平台原始结构带到调用方/日志
    likeCount: 5,
    comments: [{ content: 'NESTED SECRET' }],
    rawResponse: { cookie: 'RAW SECRET', pskey: 'S' },
    isLiked: true,
    extras: { nested: { deep: 'DEEP SECRET' } },
    timeText: '2026-11-07',
  }], scope);

  assert.equal(filtered.length, 1, '前提：这条合格内容必须被放行，否则后面的字段断言无从谈起');
  assert.deepEqual(
    Object.keys(filtered[0]).sort(),
    ['author', 'content', 'id', 'time'],
    '投影必须只包含 author/id/time/content：若这条红，说明白名单被放宽，'
    + '平台返回的原始结构（可能含嵌套评论、原始响应、凭据）会直接流到调用方与日志里，'
    + '违反任务卡 §3「响应中其他内容的处理」与 §7 的审计最小化要求',
  );
  assert.equal(
    JSON.stringify(filtered).includes('SECRET'),
    false,
    '投影后不得残留任何嵌套内容：若这条红，嵌套的评论/原始响应正文会随对象一起返回',
  );

  // content 只在**字符串**时出现：非字符串不得被透传成对象。
  const noContent = policy.filterOfflinePosts([{ author: '123', id: 'p2', time: now, content: { a: 1 } }], scope);
  assert.equal(
    Object.hasOwn(noContent[0], 'content'),
    false,
    'content 非字符串时必须整个字段缺席（而不是原样透传对象）：若这条红，'
    + '非字符串 content 会把未经过滤的结构带出去',
  );

  // time 非有限时投影成 null 而不是原值 —— 保证下游拿到的是可判定的值。
  //
  // 注意（t47）：这条路必须用 `sharedPostId` 才走得到。从前这里靠 `admin: true` 把 time 为
  // null 的帖子放进来；特权取消后 friend 路径会在时间检查处直接拒绝，投影的 null 映射就永远
  // 执行不到。`sharedPostId` 是**唯一**仍能绕过时间判断的例外，用它测同一个投影行为：
  // 断言的仍然是「投影把不可判定的时间变成 null」，只是从还活着的那条入口进。
  const unknownTime = policy.filterOfflinePosts([{ author: '123', id: 'p3', time: null, content: 'c' }], {
    now, author: '123', sharedPostId: 'p3',
  });
  assert.equal(unknownTime.length, 1, '前提：shared 例外必须放行这一条，否则下面的断言无从谈起');
  assert.equal(
    unknownTime[0].time,
    null,
    'time 非有限时投影为 null：若这条红，NaN/undefined 会原样流到下游的时间判断里',
  );
});

// ── filterOfflinePosts：重复 id 不去重（记录实际行为，不判对错）─────────────────────

test('任务卡 §3：同一批里重复 id 不被去重 —— 记录实际行为（不判对错）', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const scope = { now, author: '123', friend: true, admin: false };

  const filtered = policy.filterOfflinePosts([
    { author: '123', id: 'dup', time: now, content: 'first' },
    { author: '123', id: 'dup', time: now, content: 'second' },
  ], scope);

  assert.equal(
    filtered.length,
    2,
    '现实现不去重：同一条内容出现两次就会返回两次。这里只**记录**该行为，不主张它正确 —— '
    + '若这条红（变成 1 条），说明新增了去重，需要同时确认「两次内容不同时保留哪一条」的语义',
  );
  assert.deepEqual(
    filtered.map((post) => post.content),
    ['first', 'second'],
    '重复 id 的两条都按原顺序保留：若这条红，说明去重/取首路径改变了内容顺序，'
    + '上游若依赖顺序会拿到错的那一条',
  );
  assert.equal(
    filtered.every((post) => post.id === 'dup' && post.author === '123'),
    true,
    '重复 id 的每一条仍必须各自通过作者校验：若这条红，说明去重时绕过了逐条校验',
  );
});
