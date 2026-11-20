#!/usr/bin/env node
// scripts/test-background-patrol-audit.mjs
//
// 后台巡逻步骤 D：结构化审计纯模块测试（task-22）。
//
// 被测：`src/core/background-patrol-audit.mjs`
//   createBackgroundPatrolAudit({ filePath, clock?, fsOps? })
//   · `filePath` 是本模块审计文件所在**目录**（不是单个文件）；文件名按北京日生成
//     `background-patrol-audit-YYYY-MM-DD.jsonl`。
//
// 契约：
//  1) 记录只允许固定白名单字段：time(day+at)、platform、action、result、reason、quota、opId；
//     未知字段（message/cookie/token/path/qq/content/…）一律拒绝且不落盘；quota 只接受白名单数值键。
//  2) JSONL 追加；单实例串行。写入失败不崩溃（返回 ok:false），但必须暴露 lastWriteError/计数，
//     不得吞掉失败后声称完整记录。
//  3) 7 个自然日保留：只清理本模块目录中文件名匹配 `background-patrol-audit-*.jsonl` 的**普通文件**；
//     路径解析越界（../、绝对路径、子目录）与符号链接必须拒绝；不碰其它文件/目录。
//  4) 坏行容错：读取时跳过坏行并计数，不中断。
//
// 纯离线：只用 os.tmpdir() 临时目录 + 注入 fsOps/时钟；不联网、不访问平台、不读 state/Cookie/凭据。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BACKGROUND_PATROL_AUDIT_VERSION,
  AUDIT_PLATFORMS,
  AUDIT_ACTIONS,
  AUDIT_RESULTS,
  AUDIT_QUOTA_KEYS,
  AUDIT_RETENTION_DAYS,
  AUDIT_FILE_PREFIX,
  AUDIT_FILE_SUFFIX,
  createBackgroundPatrolAudit,
} from '../src/core/background-patrol-audit.mjs';

const BJT_OFFSET = 8 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function bjt(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - BJT_OFFSET;
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function auditFile(directory, dayKey) {
  return path.join(directory, `${AUDIT_FILE_PREFIX}${dayKey}${AUDIT_FILE_SUFFIX}`);
}

async function harness(t, at = bjt(2026, 10, 24, 10)) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-patrol-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'audit');
  let now = at;
  const make = (ops) => createBackgroundPatrolAudit({
    filePath: directory,
    clock: { now: () => now },
    ...(ops ? { fsOps: ops } : {}),
  });
  return {
    root,
    directory,
    make,
    now: () => now,
    setNow: (value) => { now = value; },
  };
}

async function rawLines(file) {
  return (await fs.readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
}

test('常量：schema 版本、字段枚举、额度键、7 天保留、文件名前缀（全部冻结）', () => {
  assert.equal(BACKGROUND_PATROL_AUDIT_VERSION, 1);
  // console：控制台专栏操作也写进同一本审计（复审 P2-1 要求「可查谁改了什么」）。
  assert.deepEqual([...AUDIT_PLATFORMS], ['tieba', 'xiaoheihe', 'console']);
  assert.deepEqual([...AUDIT_ACTIONS], ['read', 'write', 'skip', 'pause', 'resume', 'report', 'unknown']);
  // skipped/pending 为后续追加的封闭值：诚实区分「有意不处理」与「未送达待重试」。
  assert.deepEqual([...AUDIT_RESULTS], ['allowed', 'denied', 'success', 'failure', 'unknown', 'skipped', 'pending']);
  assert.equal(AUDIT_RETENTION_DAYS, 7);
  assert.equal(AUDIT_FILE_PREFIX, 'background-patrol-audit-');
  assert.equal(AUDIT_FILE_SUFFIX, '.jsonl');
  for (const list of [AUDIT_PLATFORMS, AUDIT_ACTIONS, AUDIT_RESULTS, AUDIT_QUOTA_KEYS]) {
    assert.equal(Object.isFrozen(list), true);
  }
  assert.ok(AUDIT_QUOTA_KEYS.includes('readUsed'));
  assert.ok(AUDIT_QUOTA_KEYS.includes('readLimit'));
});

test('构造参数：filePath 必须是显式目录路径（没有默认真实路径）', () => {
  assert.throws(() => createBackgroundPatrolAudit({}), TypeError);
  assert.throws(() => createBackgroundPatrolAudit({ filePath: '' }), TypeError);
  assert.throws(() => createBackgroundPatrolAudit({ filePath: '   ' }), TypeError);
});

// P2-1（复审）：控制台专栏操作要能查到「谁改的」——operator 只存会话指纹。
test('P2-1 operator：console 平台可带 operator 落盘；非法 operator 拒绝；巡逻行不带该字段', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const at = h.now();

  const withOperator = await audit.record({
    at,
    platform: 'console',
    action: 'write',
    result: 'success',
    reason: 'console-settings-apply',
    operator: 'col-0123456789ab',
  });
  assert.equal(withOperator.ok, true, JSON.stringify(withOperator));
  assert.equal(withOperator.record.platform, 'console');
  assert.equal(withOperator.record.operator, 'col-0123456789ab');

  // 巡逻行（不带 operator）字段集合必须保持旧形状 —— 审计是固定字段集合，不许静默膨胀。
  const patrol = await audit.record({ at, platform: 'xiaoheihe', action: 'read', result: 'allowed' });
  assert.equal(patrol.ok, true);
  assert.equal('operator' in patrol.record, false);

  // 非法 operator：含大写/空格/超长/非字符串一律拒绝（不许把昵称或令牌写进审计）。
  for (const bad of ['Col-0123456789ab', 'col 0123456789ab', 'x', 123, '', 'col-0123456789ab-', 'COL-' + 'a'.repeat(40)]) {
    const rejected = await audit.record({ at, platform: 'console', action: 'write', result: 'success', operator: bad });
    assert.equal(rejected.ok, false, `非法 operator 必须拒绝：${JSON.stringify(bad)}`);
    assert.equal(rejected.reason === undefined || typeof rejected.reason === 'string', true);
  }
});

test('记录只含固定白名单字段：一次 write 追加一行 JSONL，北京日键与毫秒时间正确', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const at = h.now();
  const result = await audit.record({
    at,
    platform: 'tieba',
    action: 'read',
    result: 'allowed',
    reason: 'daily-cap',
    quota: { readUsed: 5, readLimit: 5, readRemaining: 0 },
    opId: 'op-1',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.record).sort(), ['action', 'at', 'day', 'opId', 'platform', 'quota', 'reason', 'result', 'v']);
  assert.equal(result.record.v, 1);
  assert.equal(result.record.day, '2026-10-24');
  assert.equal(result.record.at, at);
  assert.deepEqual(result.record.quota, { readLimit: 5, readRemaining: 0, readUsed: 5 });

  const file = auditFile(h.directory, '2026-10-24');
  const lines = await rawLines(file);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, result.record);
  // quota 键排序固定，便于 diff/审计。
  assert.deepEqual(Object.keys(parsed.quota), ['readLimit', 'readRemaining', 'readUsed']);
  const raw = await fs.readFile(file, 'utf8');
  assert.equal(/cookie|token|secret|must-not-persist/i.test(raw), false);
});

test('北京日键边界：UTC 16:00 后属于次日；毫秒时间按北京时区换算', async (t) => {
  const h = await harness(t, bjt(2026, 10, 25, 0, 0, 0));
  const audit = h.make();
  await audit.load();
  assert.equal((await audit.record({
    at: Date.UTC(2026, 9, 24, 15, 59, 59, 999),
    platform: 'tieba', action: 'read', result: 'allowed',
  })).record.day, '2026-10-24');
  assert.equal((await audit.record({
    at: Date.UTC(2026, 9, 24, 16, 0, 0, 0),
    platform: 'tieba', action: 'read', result: 'allowed',
  })).record.day, '2026-10-25');
  assert.equal(await exists(auditFile(h.directory, '2026-10-24')), true);
  assert.equal(await exists(auditFile(h.directory, '2026-10-25')), true);
});

test('未知字段（message/cookie/token/path/qq/content/tid/url）一律拒绝且不落盘、不崩溃', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const base = { platform: 'xiaoheihe', action: 'read', result: 'success' };
  const sensitiveFields = ['message', 'cookie', 'token', 'path', 'qq', 'content', 'tid', 'url'];
  for (const field of sensitiveFields) {
    const result = await audit.record({ ...base, [field]: 'must-not-persist' });
    assert.equal(result.ok, false, `字段 ${field} 必须被拒绝`);
    assert.equal(result.error.code, 'AUDIT_UNKNOWN_FIELD');
  }
  const status = await audit.status();
  assert.equal(status.rejected, sensitiveFields.length);
  assert.equal(status.written, 0);
  assert.equal(await exists(h.directory), false);
  // 合法记录仍可写；被拒绝的敏感值绝不出现在文件里。
  assert.equal((await audit.record({ ...base, opId: 'op-1' })).ok, true);
  const raw = await fs.readFile(auditFile(h.directory, '2026-10-24'), 'utf8');
  assert.equal(/must-not-persist/.test(raw), false);
});

test('quota 只接受白名单数值键；未知键/字符串/负数/小数/超界都拒绝', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const base = { platform: 'xiaoheihe', action: 'report', result: 'success' };
  const badQuotas = [
    { note: 'secret' },
    { readUsed: '5' },
    { readUsed: -1 },
    { readUsed: 1.5 },
    { readUsed: 2_000_000_000 },
    { readUsed: 1, cookie: 'x' },
    { readIndex: null },
  ];
  for (const quota of badQuotas) {
    const result = await audit.record({ ...base, quota });
    assert.equal(result.ok, false, `quota ${JSON.stringify(quota)} 必须被拒绝`);
    assert.equal(result.error.code, 'AUDIT_INVALID_QUOTA');
  }
  assert.equal((await audit.record({
    ...base,
    quota: { readUsed: 6, readLimit: 12, readRemaining: 6, reportTier: 2, readIndex: 6 },
  })).ok, true);
  const parsed = JSON.parse((await rawLines(auditFile(h.directory, '2026-10-24')))[0]);
  assert.deepEqual(parsed.quota, { readIndex: 6, readLimit: 12, readRemaining: 6, readUsed: 6, reportTier: 2 });
});

test('枚举与原因码/opId 严格：平台/动作/结果/原因码/opId 非法都拒绝', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const ok = { platform: 'tieba', action: 'read', result: 'allowed' };
  assert.equal((await audit.record({ ...ok, platform: 'weibo' })).error.code, 'AUDIT_INVALID_ENUM');
  assert.equal((await audit.record({ ...ok, action: 'publish' })).error.code, 'AUDIT_INVALID_ENUM');
  assert.equal((await audit.record({ ...ok, result: 'maybe' })).error.code, 'AUDIT_INVALID_ENUM');
  for (const reason of ['用户说可以', 'Cookie=abc', 'UPPER', 'has space', 'x'.repeat(65), 42]) {
    assert.equal((await audit.record({ ...ok, reason })).error.code, 'AUDIT_INVALID_REASON', `reason ${String(reason)} 必须被拒绝`);
  }
  for (const opId of ['has space', 'path/../x', '中文', 'x'.repeat(129), '\\windows\\path']) {
    assert.equal((await audit.record({ ...ok, opId })).error.code, 'AUDIT_INVALID_OPID', `opId ${opId} 必须被拒绝`);
  }
  // 合法的原因码/opId 与缺省 null。
  const allowed = await audit.record({ ...ok, reason: 'write-paused', opId: 'op:2026-10-24:read-1' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.record.reason, 'write-paused');
  const bare = await audit.record(ok);
  assert.equal(bare.ok, true);
  assert.equal(bare.record.reason, null);
  assert.equal(bare.record.opId, null);
  assert.equal(bare.record.quota, null);
});

test('at 非法/未来时间被拒绝；有效输入不写文件', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const base = { platform: 'tieba', action: 'skip', result: 'denied' };
  for (const at of [NaN, Infinity, 'now', {}, h.now() + 10 * MINUTE_MS]) {
    const result = await audit.record({ ...base, at });
    assert.equal(result.ok, false, `at=${String(at)} 必须被拒绝`);
    assert.equal(result.error.code, 'AUDIT_INVALID_AT');
  }
  assert.equal(await exists(h.directory), false);
  assert.equal((await audit.status()).rejected, 5);
});

test('非对象入参不崩溃：按 rejected 计数返回 ok:false', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  for (const payload of [null, undefined, 'record', 42, []]) {
    const result = await audit.record(payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AUDIT_INVALID_RECORD');
  }
  assert.equal((await audit.status()).rejected, 5);
  assert.equal(await exists(h.directory), false);
});

test('跨北京日自动切换文件名：两天各一个文件，行内 day 与文件名一致', async (t) => {
  const h = await harness(t, bjt(2026, 10, 24, 23, 59));
  const audit = h.make();
  await audit.load();
  assert.equal((await audit.record({ platform: 'tieba', action: 'read', result: 'allowed' })).record.day, '2026-10-24');

  h.setNow(bjt(2026, 10, 25, 0, 1));
  assert.equal((await audit.record({ platform: 'xiaoheihe', action: 'read', result: 'success' })).record.day, '2026-10-25');

  const day24 = auditFile(h.directory, '2026-10-24');
  const day25 = auditFile(h.directory, '2026-10-25');
  assert.equal(await exists(day24), true);
  assert.equal(await exists(day25), true);
  assert.equal(JSON.parse((await rawLines(day24))[0]).day, '2026-10-24');
  assert.equal(JSON.parse((await rawLines(day25))[0]).day, '2026-10-25');
});

test('读取容错：坏行/非对象 JSON 跳过并计数，空行单独计数，不中断有效记录', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const file = auditFile(h.directory, '2026-10-24');
  await fs.mkdir(h.directory, { recursive: true });
  const good = (opId, action) => JSON.stringify({
    v: 1, day: '2026-10-24', at: bjt(2026, 10, 24, 10), platform: 'tieba', action, result: 'allowed', reason: null, quota: null, opId,
  });
  await fs.writeFile(file, [
    good('op-1', 'read'),
    '{bad json',
    '',
    'null',
    '   ',
    '[1,2,3]',
    good('op-2', 'write'),
    '',
  ].join('\n'), 'utf8');

  const result = await audit.readDay('2026-10-24');
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((record) => record.opId), ['op-1', 'op-2']);
  assert.equal(result.badLines, 3);
  assert.equal(result.blankLines, 3);
});

test('读取：文件不存在返回空；非法日期键拒绝', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const empty = await audit.readDay('2026-10-20');
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.records, []);
  assert.equal(empty.badLines, 0);
  for (const dayKey of ['2026-13-40', '2026-1-1', '', null, 20261024]) {
    const result = await audit.readDay(dayKey);
    assert.equal(result.ok, false, `dayKey ${String(dayKey)} 必须被拒绝`);
    assert.equal(result.error.code, 'AUDIT_INVALID_DAY');
  }
});

test('写入失败不崩溃：返回 ok:false 并暴露 lastWriteError/计数；恢复后仍可继续', async (t) => {
  const h = await harness(t);
  let failWrites = false;
  const audit = h.make({
    ...fs,
    appendFile: async (...args) => {
      if (failWrites) {
        const error = new Error('no space left on device');
        error.code = 'ENOSPC';
        throw error;
      }
      return fs.appendFile(...args);
    },
  });
  await audit.load();
  const record = { platform: 'xiaoheihe', action: 'write', result: 'success', opId: 'op-ok-1' };
  assert.equal((await audit.record(record)).ok, true);
  failWrites = true;
  const failed = await audit.record({ ...record, opId: 'op-fail' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'AUDIT_WRITE_FAILED');
  assert.match(failed.error.message, /no space left on device/);

  let status = await audit.status();
  assert.equal(status.ok, false);
  assert.equal(status.written, 1);
  assert.equal(status.failed, 1);
  assert.equal(status.lastWriteError.code, 'ENOSPC');
  assert.equal(Number.isFinite(status.lastWriteErrorAt), true);
  assert.equal(status.lastWriteOk, false);

  failWrites = false;
  assert.equal((await audit.record({ ...record, opId: 'op-ok-2' })).ok, true);
  status = await audit.status();
  assert.equal(status.written, 2);
  assert.equal(status.failed, 1);
  assert.equal(status.lastWriteOk, true);
  // 历史失败保持可见，避免“吞掉失败后声称完整记录”。
  assert.equal(status.lastWriteError.code, 'ENOSPC');
  const parsed = await audit.readDay('2026-10-24');
  assert.deepEqual(parsed.records.map((item) => item.opId), ['op-ok-1', 'op-ok-2']);
});

test('并发 20 条记录串行追加：全部成功、顺序稳定、JSON 完整', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => audit.record({
    platform: 'tieba',
    action: 'read',
    result: 'allowed',
    quota: { readUsed: index + 1, readLimit: 5 },
    opId: `op-${index}`,
  })));
  assert.equal(results.filter((result) => result.ok).length, 20);
  const status = await audit.status();
  assert.equal(status.written, 20);
  assert.equal(status.failed, 0);
  const read = await audit.readDay('2026-10-24');
  assert.equal(read.records.length, 20);
  assert.equal(read.badLines, 0);
  assert.deepEqual(read.records.map((record) => record.opId), Array.from({ length: 20 }, (_, index) => `op-${index}`));
  const raw = await fs.readFile(auditFile(h.directory, '2026-10-24'), 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.trim().split('\n').every((line) => JSON.parse(line).opId.startsWith('op-')), true);
});

test('7 个自然日保留：只删本模块目录内匹配前缀的过期文件，边界日保留', async (t) => {
  const h = await harness(t, bjt(2026, 10, 25, 10));
  const audit = h.make();
  await audit.load();
  await fs.mkdir(h.directory, { recursive: true });
  const days = ['2026-10-12', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-24', '2026-10-25'];
  for (const dayKey of days) await fs.writeFile(auditFile(h.directory, dayKey), '{}\n', 'utf8');
  const foreign = path.join(h.directory, 'other.log');
  const similarName = path.join(h.directory, 'background-patrol-audit-bad.jsonl');
  const otherModule = path.join(h.directory, 'xiaoheihe-audit-2026-10-01.jsonl');
  await fs.writeFile(foreign, 'keep\n', 'utf8');
  await fs.writeFile(similarName, 'keep\n', 'utf8');
  await fs.writeFile(otherModule, 'keep\n', 'utf8');

  const result = await audit.cleanup();
  assert.equal(result.ok, true);
  assert.equal(result.cutoffDay, '2026-10-19');
  assert.deepEqual([...result.removed].sort(), ['2026-10-12', '2026-10-17', '2026-10-18'].map((dayKey) => `${AUDIT_FILE_PREFIX}${dayKey}${AUDIT_FILE_SUFFIX}`));
  // 保留 10-19..10-25 共 7 天，以及所有不匹配本模块命名的文件。
  for (const dayKey of ['2026-10-19', '2026-10-20', '2026-10-24', '2026-10-25']) {
    assert.equal(await exists(auditFile(h.directory, dayKey)), true, `${dayKey} 必须保留`);
  }
  for (const dayKey of ['2026-10-12', '2026-10-17', '2026-10-18']) {
    assert.equal(await exists(auditFile(h.directory, dayKey)), false, `${dayKey} 必须被清理`);
  }
  assert.equal(await exists(foreign), true);
  assert.equal(await exists(similarName), true);
  assert.equal(await exists(otherModule), true);
});

test('清理安全：路径越界（../、绝对路径、子目录）与符号链接必须拒绝，绝不 unlink', async (t) => {
  const h = await harness(t, bjt(2026, 10, 25, 10));
  const unlinked = [];
  const lstatted = [];
  const entries = [
    '../background-patrol-audit-2020-01-01.jsonl',
    'C:\\outside\\background-patrol-audit-2020-01-02.jsonl',
    'sub/background-patrol-audit-2020-01-03.jsonl',
    'background-patrol-audit-2020-01-04.jsonl',
    'background-patrol-audit-2020-01-05.jsonl',
    'other.jsonl',
  ];
  const audit = h.make({
    ...fs,
    readdir: async () => entries,
    lstat: async (target) => {
      lstatted.push(path.basename(target));
      const name = path.basename(target);
      if (name === 'background-patrol-audit-2020-01-05.jsonl') {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
    },
    unlink: async (target) => {
      unlinked.push(target);
      return undefined;
    },
  });
  await audit.load();

  const result = await audit.cleanup();
  assert.equal(result.ok, true);
  assert.deepEqual(unlinked, [path.resolve(h.directory, 'background-patrol-audit-2020-01-04.jsonl')]);
  const refusedNames = result.refused.map((entry) => entry.name).sort();
  assert.deepEqual(refusedNames, [
    '../background-patrol-audit-2020-01-01.jsonl',
    'C:\\outside\\background-patrol-audit-2020-01-02.jsonl',
    'background-patrol-audit-2020-01-05.jsonl',
    'sub/background-patrol-audit-2020-01-03.jsonl',
  ].sort());
  assert.deepEqual([...new Set(result.refused.map((entry) => entry.reason))].sort(), ['path-escape', 'symlink']);
  // 越界/符号链接条目绝不能被 lstat 后再误删；other.jsonl 不匹配命名也不处理。
  assert.equal(lstatted.includes('other.jsonl'), false);
  assert.equal(lstatted.includes('background-patrol-audit-2020-01-01.jsonl'), false);
});

test('清理：目录不存在视为无过期文件（ok，不报错）', async (t) => {
  const h = await harness(t, bjt(2026, 10, 25, 10));
  const audit = h.make();
  await audit.load();
  const result = await audit.cleanup();
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, []);
  assert.equal(result.cutoffDay, '2026-10-19');
});

test('status 与实际写入一致：目录/当日文件/计数；写入后按当前北京时间给出今日文件', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  let status = await audit.status();
  assert.equal(status.directory, path.resolve(h.directory));
  assert.equal(status.day, '2026-10-24');
  assert.equal(status.filePath, path.resolve(auditFile(h.directory, '2026-10-24')));
  assert.equal(status.written, 0);
  assert.equal(status.failed, 0);
  assert.equal(status.rejected, 0);
  assert.equal(status.lastWriteError, null);
  await audit.record({ platform: 'tieba', action: 'read', result: 'allowed' });
  status = await audit.status();
  assert.equal(status.written, 1);
  assert.equal(status.lastWriteOk, true);
  h.setNow(bjt(2026, 10, 25, 0, 5));
  const nextDay = await audit.status();
  assert.equal(nextDay.day, '2026-10-25');
  assert.equal(nextDay.filePath, path.resolve(auditFile(h.directory, '2026-10-25')));
});

test('report 元数据：合法四字段整体落盘（固定键、无自由文本）', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const result = await audit.record({
    platform: 'xiaoheihe',
    action: 'report',
    result: 'success',
    reason: 'report-sent',
    quota: { readIndex: 1, reportTier: 60 },
    report: { contentSource: 'model', classification: 'non-sensitive', destination: 'group', reportBlockPresent: true },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.record.report, {
    contentSource: 'model', classification: 'non-sensitive', destination: 'group', reportBlockPresent: true,
  });
  const file = auditFile(h.directory, result.record.day);
  const lines = await rawLines(file);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed.report, result.record.report);
  assert.equal(parsed.report.contentSource, 'model');
});

test('report 元数据：未知内层键/非法枚举/非布尔/非对象一律拒绝且不落盘', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const base = { platform: 'xiaoheihe', action: 'report', result: 'success' };
  const badReports = [
    { ...{ contentSource: 'model', classification: 'non-sensitive', destination: 'owner', reportBlockPresent: true }, message: '正文' },
    { contentSource: 'model', classification: 'unknown', destination: 'owner', reportBlockPresent: true },
    { contentSource: 'llm', classification: 'non-sensitive', destination: 'owner', reportBlockPresent: true },
    { contentSource: 'model', classification: 'non-sensitive', destination: 'qq', reportBlockPresent: true },
    { contentSource: 'model', classification: 'non-sensitive', destination: 'owner', reportBlockPresent: 'true' },
    { contentSource: 'model', classification: 'non-sensitive', destination: 'owner' },
    'not-an-object',
  ];
  for (const report of badReports) {
    const result = await audit.record({ ...base, report });
    assert.equal(result.ok, false, JSON.stringify(report));
    assert.equal(result.error.code, 'AUDIT_INVALID_REPORT', JSON.stringify(report));
  }
  const files = await fs.readdir(h.directory).catch(() => []);
  assert.equal(files.filter((name) => name.startsWith(AUDIT_FILE_PREFIX)).length, 0, '被拒绝的记录不得落盘');
});

test('非 report 记录不追加 report 字段（兼容既有固定格式）', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const result = await audit.record({ platform: 'tieba', action: 'read', result: 'allowed' });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.record, 'report'), false);
  const file = auditFile(h.directory, result.record.day);
  const parsed = JSON.parse((await rawLines(file))[0]);
  assert.equal(Object.hasOwn(parsed, 'report'), false);
});

// ---------------------------------------------------------------------------
// 追加值契约 + 真落盘回归（task-190）
//
// 背景：`src/bridge.js` 曾有 12 处审计调用传了冻结枚举以外的值
// （result 'skipped'/'blocked'/'failed'、action 'memory'/'deny'、report.contentSource 'none'、
//  report.destination null），而整条记录被 validateRecordRequest 静默拒绝、不落盘 ——
// 即「本该可观察的事件」在生产里从未出现过。既有测试用的是假审计（直接 push），
// 完全绕过校验，反而把这些值当成契约钉住。
//
// 本组用例只用真实模块 + 真实写盘，断言：
//  1) 追加的封闭值（skipped/pending、contentSource 'none'、destination null、tooLongChars）能落盘；
//  2) 越界值仍被拒（不能让「扩枚举」变成「什么都收」）；
//  3) 既有合法行的字段集合与顺序不变（向后兼容）。
// ---------------------------------------------------------------------------

test('追加值契约：result 支持 skipped/pending，与 failure/unknown 语义分离，拼写错误仍被拒', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const at = h.now();

  for (const result of ['skipped', 'pending']) {
    const res = await audit.record({ at, platform: 'xiaoheihe', action: 'report', result, reason: 'report-in-flight' });
    assert.equal(res.ok, true, `result=${result} 应被接受`);
    assert.equal(res.record.result, result);
  }
  // 未追加的拼写错误必须继续被拒（防止扩枚举退化成「接受任意字符串」）。
  for (const bad of ['pendin', 'skiped', 'blocked', 'failed', '']) {
    const res = await audit.record({ at, platform: 'xiaoheihe', action: 'report', result: bad, reason: 'x' });
    assert.equal(res.ok, false, `result=${JSON.stringify(bad)} 必须被拒`);
    assert.equal(res.error.code, 'AUDIT_INVALID_ENUM');
  }
});

test('追加值契约：report.contentSource 接受 none、destination 接受 null（无内容产出的真实形状）', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const at = h.now();

  const res = await audit.record({
    at, platform: 'tieba', action: 'report', result: 'skipped', reason: 'report-too-long',
    report: { contentSource: 'none', classification: 'blocked', destination: null, reportBlockPresent: true },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.record.report.contentSource, 'none');
  assert.equal(res.record.report.destination, null);

  // 任意字符串仍不得冒充「未定去向」。
  const bad = await audit.record({
    at, platform: 'tieba', action: 'report', result: 'skipped', reason: 'x',
    report: { contentSource: 'none', classification: 'blocked', destination: 'admin', reportBlockPresent: true },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'AUDIT_INVALID_REPORT');
});

test('追加值契约：tooLongChars 只接受 0..1e9 安全整数；null 视为未提供', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const at = h.now();

  const ok = await audit.record({ at, platform: 'tieba', action: 'report', result: 'skipped', reason: 'report-too-long', tooLongChars: 1203 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.record.tooLongChars, 1203);

  for (const bad of [-1, 1.5, Number.NaN, 1e9 + 1, '1203']) {
    const res = await audit.record({ at, platform: 'tieba', action: 'report', result: 'skipped', reason: 'report-too-long', tooLongChars: bad });
    assert.equal(res.ok, false, `tooLongChars=${String(bad)} 必须被拒`);
    assert.equal(res.error.code, 'AUDIT_INVALID_TOOLONG');
  }

  const omitted = await audit.record({ at, platform: 'tieba', action: 'report', result: 'skipped', reason: 'report-skipped', tooLongChars: null });
  assert.equal(omitted.ok, true);
  assert.equal(Object.hasOwn(omitted.record, 'tooLongChars'), false);
});

test('真落盘：曾被静默拒绝的调用形状现在全部写进当日 JSONL，且不夹带正文', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const at = h.now();

  const shapes = [
    { action: 'report', result: 'skipped', reason: 'report-in-flight', quota: { readIndex: 3 } },
    { action: 'report', result: 'skipped', reason: 'report-skipped', quota: { readIndex: 1 } },
    { action: 'report', result: 'failure', reason: 'report-memory-unpersisted', quota: { readIndex: 2 } },
    { action: 'skip', result: 'denied', reason: 'identity-guard-state-invalid' },
    { action: 'skip', result: 'denied', reason: 'identity-guard-unavailable' },
    { action: 'skip', result: 'denied', reason: 'authorize-wiring-error' },
    { platform: 'console', action: 'skip', result: 'denied', reason: 'console-settings-unavailable' },
    { platform: 'console', action: 'skip', result: 'skipped', reason: 'console-outside-window' },
    { action: 'resume', result: 'pending', reason: 'identity-guard-resend-notify' },
    {
      action: 'report', result: 'skipped', reason: 'report-too-long', quota: { readIndex: 5 }, tooLongChars: 1500,
      report: { contentSource: 'none', classification: 'blocked', destination: null, reportBlockPresent: true },
    },
    {
      action: 'report', result: 'skipped', reason: 'report-declined', quota: { readIndex: 6 },
      report: { contentSource: 'none', classification: 'sensitive', destination: null, reportBlockPresent: true },
    },
  ];
  for (const shape of shapes) {
    const res = await audit.record({ at, platform: shape.platform ?? 'xiaoheihe', ...shape });
    assert.equal(res.ok, true, `shape ${shape.reason} 必须落盘而不是被静默拒绝：${JSON.stringify(res)}`);
  }

  const status = await audit.status();
  assert.equal(status.written, shapes.length);
  assert.equal(status.rejected, 0, '不得有任何一条被静默拒绝');

  const lines = await rawLines(auditFile(h.directory, status.day));
  assert.equal(lines.length, shapes.length);
  const byReason = new Map(lines.map((line) => JSON.parse(line)).map((row) => [row.reason, row]));
  for (const shape of shapes) assert.ok(byReason.has(shape.reason), `${shape.reason} 必须真的在文件里`);

  assert.equal(byReason.get('report-in-flight').result, 'skipped');
  assert.equal(byReason.get('identity-guard-unavailable').action, 'skip');
  assert.equal(byReason.get('identity-guard-unavailable').result, 'denied');
  assert.equal(byReason.get('console-outside-window').platform, 'console');
  assert.equal(byReason.get('console-settings-unavailable').platform, 'console');
  assert.equal(byReason.get('identity-guard-resend-notify').result, 'pending');
  assert.equal(byReason.get('report-too-long').tooLongChars, 1500);
  assert.equal(byReason.get('report-memory-unpersisted').result, 'failure');

  // 不夹带正文：整份文件里不得出现测试注入的自由文本。
  const joined = lines.join('|');
  for (const forbidden of ['正文', 'cookie', 'token=']) {
    assert.equal(joined.includes(forbidden), false, `审计不得夹带 ${forbidden}`);
  }
});

test('向后兼容：不带追加字段的记录，字段集合与顺序保持不变', async (t) => {
  const h = await harness(t);
  const audit = h.make();
  await audit.load();
  const plain = await audit.record({ at: h.now(), platform: 'tieba', action: 'read', result: 'allowed', reason: 'ok-read' });
  assert.equal(plain.ok, true);
  assert.deepEqual(Object.keys(plain.record), ['v', 'day', 'at', 'platform', 'action', 'result', 'reason', 'quota', 'opId']);
  assert.equal(Object.hasOwn(plain.record, 'tooLongChars'), false);
  assert.equal(Object.hasOwn(plain.record, 'report'), false);
  assert.equal(Object.hasOwn(plain.record, 'operator'), false);
});
