#!/usr/bin/env node
// scripts/test-xiaoheihe-authorize-audit-adapter.mjs
//
// task-49：authorize/route 事件 → background-patrol-audit 固定字段适配器测试（TDD 先红后绿）。
//
// 被测：`src/core/xiaoheihe-authorize-audit-adapter.mjs`
//   createXhhAuthorizeAuditAdapter({ audit, clock? }) -> { record(event), recordMany(events) }
//   mapAuthorizeAuditEvent(event) -> audit.record payload | null
//
// 契约：
//  · 只把固定白名单事件字段映射为 audit 模块的记录：{at, platform:'xiaoheihe', action, result, reason}；
//    action ∈ read/write/skip；result ∈ allowed/denied/success/failure/unknown；
//  · 不复制 args/evidence/cookie/token/message 等任何原文；quota 恒为 null（事件里没有数值额度快照）；
//  · 非 authorize/complete 事件、缺 outcome/decision、at 与时钟都不可用 → 不写（返回 unsupported-event）。
//
// 纯离线：真实 audit 模块 + os.tmpdir() 临时目录；不联网、不访问平台、不读写真实 state。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  XHH_AUTHORIZE_AUDIT_ADAPTER_VERSION,
  mapAuthorizeAuditEvent,
  createXhhAuthorizeAuditAdapter,
} from '../src/core/xiaoheihe-authorize-audit-adapter.mjs';
import { createBackgroundPatrolAudit } from '../src/core/background-patrol-audit.mjs';

const BJT_OFFSET = 8 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 24, 2, 0, 0) - BJT_OFFSET;
const FULL = (short) => `mcp__xiaoheihe__${short}`;

async function makeAuditHarness(t, clock = { now: () => T0 }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-xhh-auth-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const audit = createBackgroundPatrolAudit({ filePath: dir, clock });
  await audit.load();
  return { dir, audit };
}

test('常量与工厂校验：audit 必须提供 record()', () => {
  assert.equal(XHH_AUTHORIZE_AUDIT_ADAPTER_VERSION, 1);
  assert.throws(() => createXhhAuthorizeAuditAdapter(), TypeError);
  assert.throws(() => createXhhAuthorizeAuditAdapter({}), TypeError);
  assert.throws(() => createXhhAuthorizeAuditAdapter({ audit: {} }), TypeError);
  assert.throws(() => createXhhAuthorizeAuditAdapter({ audit: { record: 'x' } }), TypeError);
  assert.throws(() => createXhhAuthorizeAuditAdapter({ audit: { record: async () => ({}) }, clock: 'now' }), TypeError);
});

test('读取完成的可信来源和序号只传内存回调，不写入审计字段', async () => {
  const received = [];
  const adapter = createXhhAuthorizeAuditAdapter({ audit: { async record(record, meta) { received.push({ record, meta }); return { ok: true }; } } });
  await adapter.record({ type: 'complete', at: T0, agentClass: 'background', tool: FULL('get_home_content'), outcome: 'success', readIndex: 2, readStartedAt: T0 - 1, args: { secret: 'do-not-forward' } });
  assert.deepEqual(received[0].meta, { agentClass: 'background', tool: 'get_home_content', readIndex: 2, readStartedAt: T0 - 1 });
  assert.equal('agentClass' in received[0].record, false);
  assert.equal('readIndex' in received[0].record, false);
});

test('纯映射：route/authorize/complete → 固定字段（无 args/token/agentClass 透传）', () => {
  assert.deepEqual(
    mapAuthorizeAuditEvent({ type: 'authorize', at: T0, tool: FULL('get_home_content'), decision: 'allow' }),
    { at: T0, platform: 'xiaoheihe', action: 'read', result: 'allowed', reason: null },
  );
  assert.deepEqual(
    mapAuthorizeAuditEvent({ type: 'authorize', at: T0, tool: FULL('publish_content'), decision: 'allow' }),
    { at: T0, platform: 'xiaoheihe', action: 'write', result: 'allowed', reason: null },
  );
  assert.deepEqual(
    mapAuthorizeAuditEvent({ type: 'authorize', at: T0, tool: FULL('get_home_content'), decision: 'deny', reason: 'read-daily-cap', agentClass: 'background' }),
    { at: T0, platform: 'xiaoheihe', action: 'skip', result: 'denied', reason: 'read-daily-cap' },
  );
  assert.deepEqual(
    mapAuthorizeAuditEvent({ type: 'authorize', at: T0, tool: FULL('post_comment'), decision: 'deny', error: 'unauthorized' }),
    { at: T0, platform: 'xiaoheihe', action: 'skip', result: 'denied', reason: 'unauthorized' },
  );
  assert.deepEqual(
    mapAuthorizeAuditEvent({ type: 'complete', at: T0, tool: FULL('publish_article'), outcome: 'success' }),
    { at: T0, platform: 'xiaoheihe', action: 'write', result: 'success', reason: null, opId: null },
  );
  assert.deepEqual(
    mapAuthorizeAuditEvent({ type: 'complete', at: T0, tool: FULL('post_comment'), outcome: 'failure' }),
    { at: T0, platform: 'xiaoheihe', action: 'write', result: 'failure', reason: null, opId: null },
  );
  assert.deepEqual(
    mapAuthorizeAuditEvent({ type: 'complete', at: T0, tool: FULL('get_post_detail'), outcome: 'unknown' }),
    { at: T0, platform: 'xiaoheihe', action: 'read', result: 'unknown', reason: null, opId: null },
  );
  // 敏感/未声明字段不透传。
  const mapped = mapAuthorizeAuditEvent({
    type: 'authorize',
    at: T0,
    tool: FULL('get_home_content'),
    decision: 'deny',
    reason: 'unknown-agent',
    args: { content: 'SENSITIVE_ARGS' },
    cookie: 'SENSITIVE_COOKIE',
    token: 'SENSITIVE_TOKEN',
    agentClass: 'unknown',
  });
  assert.deepEqual(Object.keys(mapped).sort(), ['action', 'at', 'platform', 'reason', 'result']);
});

test('纯映射：非法事件返回 null（不猜测、不写）、at 缺省用注入时钟', () => {
  for (const bad of [
    null,
    undefined,
    'authorize',
    [],
    {},
    { type: 'unknown', at: T0, tool: FULL('get_home_content') },
    { type: 'authorize', at: T0, tool: FULL('get_home_content') },
    { type: 'authorize', at: T0, tool: FULL('get_home_content'), decision: 'maybe' },
    { type: 'complete', at: T0, tool: FULL('get_home_content'), outcome: 'done' },
    { type: 'complete', at: T0, tool: 'qq_send_message', outcome: 'success' },
    { type: 'authorize', at: 'now', tool: FULL('get_home_content'), decision: 'allow' },
    { type: 'authorize', at: Number.NaN, tool: FULL('get_home_content'), decision: 'allow' },
  ]) {
    assert.equal(mapAuthorizeAuditEvent(bad, { now: () => T0 }), null, `bad=${JSON.stringify(bad)}`);
  }
  // 缺 at：使用注入时钟。
  const mapped = mapAuthorizeAuditEvent({ type: 'authorize', tool: FULL('get_home_content'), decision: 'allow' }, { now: () => T0 + 5 });
  assert.equal(mapped.at, T0 + 5);
  // 时钟不可用且缺 at → null。
  assert.equal(mapAuthorizeAuditEvent({ type: 'authorize', tool: FULL('get_home_content'), decision: 'allow' }, { now: () => Number.NaN }), null);
});

test('适配器写真实 audit 模块：固定字段 / action 白名单 / 无 args 与凭据原文', async (t) => {
  const harness = await makeAuditHarness(t);
  const adapter = createXhhAuthorizeAuditAdapter({ audit: harness.audit });
  const events = [
    { type: 'authorize', at: T0, tool: FULL('get_home_content'), decision: 'allow', args: { note: 'SENSITIVE_ARGS' } },
    { type: 'authorize', at: T0 + 1, tool: FULL('publish_content'), decision: 'deny', reason: 'write-paused', cookie: 'SENSITIVE_COOKIE' },
    { type: 'complete', at: T0 + 2, tool: FULL('publish_content'), outcome: 'success' },
    { type: 'complete', at: T0 + 3, tool: FULL('post_comment'), outcome: 'failure' },
    { type: 'complete', at: T0 + 4, tool: FULL('get_post_detail'), outcome: 'unknown' },
  ];
  for (const event of events) {
    const result = await adapter.record(event);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const unrecorded = await adapter.record({ type: 'misc', at: T0 });
  assert.equal(unrecorded.ok, false);
  assert.equal(unrecorded.reason, 'unsupported-event');
  const invalid = await adapter.record(null);
  assert.equal(invalid.ok, false);

  const read = await harness.audit.readDay('2026-10-24');
  assert.equal(read.ok, true);
  assert.equal(read.records.length, events.length);
  const FIXED_KEYS = ['action', 'at', 'day', 'opId', 'platform', 'quota', 'reason', 'result', 'v'];
  for (const record of read.records) {
    assert.deepEqual(Object.keys(record).sort(), FIXED_KEYS);
    assert.equal(record.platform, 'xiaoheihe');
    assert.equal(record.quota, null);
    assert.equal(record.opId, null);
    assert.ok(['read', 'write', 'skip'].includes(record.action));
    assert.ok(['allowed', 'denied', 'success', 'failure', 'unknown'].includes(record.result));
  }
  const raw = await fs.readFile(path.join(harness.dir, 'background-patrol-audit-2026-10-24.jsonl'), 'utf8');
  for (const secret of ['SENSITIVE_ARGS', 'SENSITIVE_COOKIE', 'SENSITIVE_TOKEN']) {
    assert.equal(raw.includes(secret), false, `审计文件不得包含 ${secret}`);
  }
});

test('recordMany：批量写入并返回 written/skipped 计数；不可写事件只跳过', async (t) => {
  const harness = await makeAuditHarness(t);
  const adapter = createXhhAuthorizeAuditAdapter({ audit: harness.audit, clock: { now: () => T0 } });
  const result = await adapter.recordMany([
    { type: 'authorize', at: T0, tool: FULL('search_content'), decision: 'allow' },
    { type: 'bogus' },
    { type: 'complete', at: T0, tool: FULL('reply_comment'), outcome: 'success' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.written, 2);
  assert.equal(result.skipped, 1);
  const read = await harness.audit.readDay('2026-10-24');
  assert.equal(read.records.length, 2);
  assert.equal(read.records[0].action, 'read');
  assert.equal(read.records[1].action, 'write');
});

test('audit 写失败时适配器暴露 ok:false（不吞掉、不崩溃）', async () => {
  let calls = 0;
  const adapter = createXhhAuthorizeAuditAdapter({
    audit: {
      async record() {
        calls += 1;
        return { ok: false, error: { code: 'AUDIT_WRITE_FAILED' } };
      },
    },
  });
  const result = await adapter.record({ type: 'authorize', at: T0, tool: FULL('get_home_content'), decision: 'allow' });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUDIT_WRITE_FAILED');
});
