import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as decision from '../../src/core/xhh-tool-surface-decision.mjs';
import { parseOwnerNoticeInboxEntry } from '../../src/core/owner-notice-bridge-wiring.mjs';
import { createInboxProducer } from './inbox-producer.mjs';

const NOW = 1793360000000;
const TMP_PREFIX = 'owner-notice-producer-';

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  return { dir, inboxDir: path.join(dir, 'inbox') };
}

// 判定模块自带 12 个预期工具名；测试不得自造名字（否则 classify 会把它们当"未知"）。
const EXPECTED = decision.classifyToolSurface({ observedNames: [] }).missing;

test('notifyMissing：写出的条目能过 bridge 的解析器（契约一致）', async () => {
  const { inboxDir } = await tempDir();
  const producer = createInboxProducer({ inboxDir, clock: () => NOW, fs });
  const result = await producer.notifyMissing({ missingCount: 3, consecutiveMisses: 3, lastSeenAt: NOW - 1000 });
  assert.equal(result.outcome, 'unknown', '写文件只是入队，不是送达');
  assert.equal(result.code, 'inbox-queued');

  const names = await fs.readdir(inboxDir);
  assert.equal(names.filter((n) => n.endsWith('.json')).length, 1);
  assert.equal(names.filter((n) => n.endsWith('.tmp')).length, 0, '临时文件必须被 rename 掉');
  const raw = JSON.parse(await fs.readFile(path.join(inboxDir, names[0]), 'utf8'));
  const parsed = parseOwnerNoticeInboxEntry(raw, { now: NOW });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.value.kind, 'tool-surface-missing');
  assert.equal(parsed.value.missingCount, 3);
  assert.equal(parsed.value.noticeId, result.noticeId);
});

test('notifyMissing：正文不会进收件箱（只有计数与时间）', async () => {
  const { inboxDir } = await tempDir();
  const producer = createInboxProducer({ inboxDir, clock: () => NOW, fs });
  await producer.notifyMissing({ missingCount: 2, consecutiveMisses: 3, lastSeenAt: NOW });
  const names = await fs.readdir(inboxDir);
  const text = await fs.readFile(path.join(inboxDir, names[0]), 'utf8');
  for (const key of ['message', 'path', 'token', 'cookie', 'toolNames']) {
    assert.ok(!text.includes(key), `收件箱不得包含 ${key}`);
  }
});

test('notifyMissing：非法计数不写文件', async () => {
  const { inboxDir } = await tempDir();
  const logs = [];
  const producer = createInboxProducer({ inboxDir, clock: () => NOW, fs, log: (l, m) => logs.push(`${l}:${m}`) });
  for (const bad of [0, 65, -1, 1.5, null, undefined, '3']) {
    const r = await producer.notifyMissing({ missingCount: bad, consecutiveMisses: 3 });
    assert.equal(r.outcome, 'unknown');
    assert.equal(r.noticeId, null);
  }
  await assert.rejects(fs.readdir(inboxDir), /ENOENT/);
  assert.ok(logs.length >= 1);
});

test('publishRecovered：写出的恢复条目也能过 bridge 解析器（计数允许 0）', async () => {
  const { inboxDir } = await tempDir();
  const producer = createInboxProducer({ inboxDir, clock: () => NOW, fs });
  const r = await producer.publishRecovered();
  assert.equal(r.ok, true);
  const names = (await fs.readdir(inboxDir)).filter((n) => n.endsWith('.json'));
  const raw = JSON.parse(await fs.readFile(path.join(inboxDir, names[0]), 'utf8'));
  const parsed = parseOwnerNoticeInboxEntry(raw, { now: NOW });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.value.kind, 'tool-surface-recovered');
});

test('写盘失败：返回 unknown 且不抛出（调用方按失败处理，不假称已入队）', async () => {
  const { inboxDir } = await tempDir();
  const logs = [];
  const failingFs = { ...fs, rename: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } };
  const producer = createInboxProducer({ inboxDir, clock: () => NOW, fs: failingFs, log: (l, m) => logs.push(`${l}:${m}`) });
  const r = await producer.notifyMissing({ missingCount: 3, consecutiveMisses: 3 });
  assert.equal(r.outcome, 'unknown');
  assert.equal(r.noticeId, null);
  assert.equal(r.code, 'EPERM');
  assert.ok(logs.some((m) => m.includes('写入收件箱失败')));
});

test('生成器可注入：noticeId 非法时拒绝写入（防止写出 bridge 解析不了的条目）', async () => {
  const { inboxDir } = await tempDir();
  const producer = createInboxProducer({ inboxDir, clock: () => NOW, fs, makeNoticeId: () => 'not-a-valid-id' });
  const r = await producer.notifyMissing({ missingCount: 3, consecutiveMisses: 3 });
  assert.equal(r.noticeId, null);
  assert.equal(r.code, 'invalid-notice-id');
});

test('与判定模块共存：产生的缺失计数与判定模块的 expected 名称数量一致', async () => {
  const { inboxDir } = await tempDir();
  const producer = createInboxProducer({ inboxDir, clock: () => NOW, fs });
  let state = decision.createToolSurfaceState();
  const observed = EXPECTED.slice(0, 9); // 缺 3 个
  const result = decision.recordToolSurfaceObservation(state, { observedNames: observed, at: NOW, source: 'scheduled', intervalMs: 60000 });
  state = result.state ?? state;
  const classified = decision.classifyToolSurface({ observedNames: observed });
  assert.equal(classified.state, 'absent');
  assert.equal(classified.missing.length, 3);
  const queued = await producer.notifyMissing({ missingCount: classified.missing.length, consecutiveMisses: state.consecutiveMisses ?? 1, lastSeenAt: NOW });
  assert.ok(queued.noticeId);
  const names = (await fs.readdir(inboxDir)).filter((n) => n.endsWith('.json'));
  const raw = JSON.parse(await fs.readFile(path.join(inboxDir, names[0]), 'utf8'));
  assert.equal(raw.missingCount, 3);
});