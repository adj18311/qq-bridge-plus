import test from 'node:test';
import assert from 'node:assert/strict';
import * as audit from '../src/core/qzone-audit-offline.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';

test('格式化空间操作，只保留允许的字段并保留普通正文', () => {
  assert.equal(typeof audit.formatAuditRecord, 'function');
  const result = audit.formatAuditRecord({ time: 1000, source: 'qq', action: 'comment', target: '123', postId: 'p1', commentId: 'c1', content: '你好', result: 'success', reason: '', quota: 1, cookie: 'should-not-appear' });
  assert.equal(result.content, '你好');
  assert.equal(result.redacted, false);
  assert.equal(result.target, '123');
  assert.equal(JSON.stringify(result).includes('should-not-appear'), false);
});

test('内容中识别到的凭据整体遮蔽并显式标记，错误详情不进入记录', () => {
  assert.equal(typeof audit.formatAuditRecord, 'function');
  for (const content of ['Cookie: p_skey=secret', 'Authorization: Bearer sample', 'api_key=secret', 'https://x.test/?token=secret', 'qzonetoken=secret', '{"qzonetoken":"secret"}', 'https://x.test/?qzonetoken=secret']) {
    const record = audit.formatAuditRecord({ time: 1000, source: 'qq', action: 'comment', target: '123', content, result: 'failure', reason: 'network', rawResponse: { secret: 'response-secret' } });
    assert.equal(record.redacted, true);
    assert.equal(record.content, '[REDACTED]');
    assert.equal(JSON.stringify(record).includes('secret'), false);
  }
});

test('审计记录拒绝不可信来源、操作与结果，错误原因仅允许代码', () => {
  const base = { time: 1000, source: 'qq', action: 'comment', target: '123', content: '', result: 'failure', reason: 'network' };
  for (const change of [{ source: 'untrusted' }, { action: 'unknown' }, { result: 'maybe' }, { reason: 'Bearer secret' }, { time: NaN }]) {
    assert.throws(() => audit.formatAuditRecord({ ...base, ...change }));
  }
});

test('审计记录持久化且重复操作编号不重复写入', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-audit-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const path = join(dir, 'state.db');
  db = openOfflineStore(path, { audit: [] });
  assert.equal(typeof audit.appendOfflineAudit, 'function');
  const input = { time: 1000, source: 'qq', action: 'comment', target: '123', content: 'hi', result: 'success' };
  assert.equal(audit.appendOfflineAudit(db, 'op1', input).appended, true);
  assert.equal(audit.appendOfflineAudit(db, 'op1', input).appended, false);
  db.close(); db = openOfflineStore(path, { audit: [] });
  assert.equal(db.read().audit.length, 1);
  assert.equal(db.read().audit[0].record.content, 'hi');
  assert.throws(() => audit.appendOfflineAudit(db, 'op1', { ...input, content: 'different' }));
});

test('只清理北京时间七个自然日之前的审计项，不触碰额度和暂停', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-audit-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { audit: [], used: 3, writePaused: true });
  const make = (date) => ({ time: Date.parse(`${date}T04:00:00Z`), source: 'qq', action: 'comment', target: '123', content: 'hi', result: 'success' });
  audit.appendOfflineAudit(db, 'old', make('2026-11-01'));
  audit.appendOfflineAudit(db, 'keep', make('2026-11-02'));
  assert.equal(typeof audit.pruneOfflineAudit, 'function');
  assert.equal(audit.pruneOfflineAudit(db, Date.parse('2026-11-07T16:00:00Z')).removed, 1);
  assert.deepEqual(db.read().audit.map((x) => x.id), ['keep']);
  assert.equal(db.read().used, 3);
  assert.equal(db.read().writePaused, true);
});

test('管理恢复和额度重置必须包含可信操作者及原暂停范围', () => {
  const base = { time: 1000, source: 'admin_console', action: 'restore', target: '123', content: '', result: 'success', operator: '123', pauseScope: 'both' };
  const record = audit.formatAuditRecord(base);
  assert.equal(record.operator, '123');
  assert.equal(record.pauseScope, 'both');
  assert.throws(() => audit.formatAuditRecord({ ...base, operator: undefined }));
  assert.throws(() => audit.formatAuditRecord({ ...base, pauseScope: 'Bearer secret' }));
  assert.throws(() => audit.formatAuditRecord({ ...base, action: 'reset_quota', operator: undefined }));
});

test('凭据形状的标识符不得进入审计字段', async (t) => {
  const credential = 'sk-abcdefghijklmnop';
  const base = { time: 1000, source: 'qq', action: 'comment', target: '123', content: '普通内容', result: 'success' };
  assert.throws(() => audit.formatAuditRecord({ ...base, postId: credential }));
  assert.throws(() => audit.formatAuditRecord({ ...base, commentId: credential }));
  assert.throws(() => audit.formatAuditRecord({ ...base, action: 'restore', source: 'admin_console', operator: credential, pauseScope: 'both' }));
  const dir = await mkdtemp(join(tmpdir(), 'qzone-audit-id-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  assert.throws(() => audit.appendOfflineAudit(db, credential, base));
  assert.throws(() => audit.appendOfflineAudit(db, `intent_${credential}`, base));
  assert.equal(JSON.stringify(db.read()).includes(credential), false);
});
