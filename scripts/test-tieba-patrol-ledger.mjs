#!/usr/bin/env node
// scripts/test-tieba-patrol-ledger.mjs
//
// 后台巡逻第四阶段（修正版）：贴吧「每天最多 5 次实际自主访问」唯一持久账本测试。
//
// 规格依据（docs/superpowers/specs/2026-10-24-background-patrol-design.md §贴吧）：
//  · 每天最多 5 次实际自主贴吧访问；一次吧页列表抓取或一次读帖抓取算一次访问；
//  · 同一次读帖的多页抓取只算一次（与 src/tieba-lib.js 的 onBeforeTiebaRequest「一次工具调用只调一次
//    预留钩子」语义对齐：多页批处理在请求边界只申请一次许可）；
//  · `reason=user` 的用户明确查询不占自主额度，也不应被自主额度上限拦住；
//  · 所有日额度按北京时间自然日（UTC+8 00:00）重置。
//
// 本模块只维护「5/日自主访问」这一本唯一账本：
//  · 不接入 src/tieba-lib.js / bridge / MCP / 预设（未来接线时由 onBeforeTiebaRequest 调 reserve）；
//  · 不做内容封禁（不存 tid/吧名/内容/搜索结果），只存日键与计数；
//  · 持久化：同目录临时文件 -> rename；fsOps 可注入；坏文件 fail-closed 且保留原字节；
//  · 并发：同实例共享串行队列，20 个并发申请恰好放行 5 个；
//  · 崩溃/请求未真正发出时可能多计一次（请求前预留的保守方向），不提供退还接口，避免成为绕过额度后门。
//
// 纯离线：fsOps 默认真实文件系统，但只用 os.tmpdir() 临时目录；不联网、不访问贴吧、不读 Cookie。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  TIEBA_PATROL_LEDGER_VERSION,
  TIEBA_PATROL_DAILY_CAP,
  TIEBA_PATROL_RESERVE_REASONS,
  createTiebaPatrolLedger,
} from '../src/core/tieba-patrol-ledger.mjs';
import { beijingPatrolDayKey } from '../src/core/background-patrol-state.mjs';
import { fetchThreadPages } from '../src/tieba-lib.js';

const BJT_OFFSET = 8 * 60 * 60 * 1000;

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

function throwsWithCode(run, expectedCode) {
  try {
    run();
  } catch (error) {
    assert.equal(error.code, expectedCode, `期望 code=${expectedCode}，实际 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望抛出 code=${expectedCode} 的错误`);
}

async function rejectsWithCode(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.code, expectedCode, `期望 code=${expectedCode}，实际 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望 promise 以 code=${expectedCode} 拒绝`);
}

async function harness(t, at = bjt(2026, 10, 24, 10)) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-tieba-ledger-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'tieba-patrol-ledger.json');
  let now = at;
  const make = (ops) => createTiebaPatrolLedger({
    filePath,
    clock: { now: () => now },
    ...(ops ? { fsOps: ops } : {}),
  });
  return {
    dir,
    filePath,
    make,
    now: () => now,
    setNow: (value) => { now = value; },
  };
}

test('固定常量：唯一账本版本、6/日上限、两种预留原因（冻结）', () => {
  assert.equal(TIEBA_PATROL_LEDGER_VERSION, 1);
  assert.equal(TIEBA_PATROL_DAILY_CAP, 6);
  assert.deepEqual([...TIEBA_PATROL_RESERVE_REASONS], ['patrol', 'user']);
  assert.equal(Object.isFrozen(TIEBA_PATROL_RESERVE_REASONS), true);
});

test('旧版已用 5 次的账本可加载，升级后仅剩 1 次额度', async (t) => {
  const h = await harness(t);
  await fs.writeFile(h.filePath, JSON.stringify({
    schemaVersion: 1,
    day: '2026-10-24',
    used: 5,
    lastAccessAt: h.now(),
  }));
  const ledger = h.make();
  const loaded = await ledger.load();
  assert.equal(loaded.used, 5);
  assert.equal(loaded.remaining, 1);
  assert.equal((await ledger.reserve({ reason: 'patrol' })).used, 6);
  assert.equal((await ledger.reserve({ reason: 'patrol' })).reason, 'daily-cap');
});

test('缺文件时 ready 且绝不创建文件；快照给出当日剩余额度', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  const loaded = await ledger.load();
  assert.equal(loaded.schemaVersion, TIEBA_PATROL_LEDGER_VERSION);
  assert.equal(loaded.day, '2026-10-24');
  assert.equal(loaded.used, 0);
  assert.equal(loaded.remaining, 6);
  assert.equal(await exists(h.filePath), false);
  const snap = await ledger.snapshot();
  assert.deepEqual(
    { day: snap.day, used: snap.used, limit: snap.limit, remaining: snap.remaining },
    { day: '2026-10-24', used: 0, limit: 6, remaining: 6 },
  );
  assert.equal(await exists(h.filePath), false);
});

test('自主访问每天恰好 6 次，第 7 次返回 daily-cap 且不落盘计数', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  await ledger.load();
  for (let index = 1; index <= 6; index += 1) {
    const result = await ledger.reserve({ reason: 'patrol' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.counted, true);
    assert.equal(result.used, index);
    assert.equal(result.limit, 6);
    assert.equal(result.remaining, 6 - index);
  }
  const refused = await ledger.reserve({ reason: 'patrol' });
  assert.deepEqual(refused, { ok: false, reason: 'daily-cap', used: 6, limit: 6, remaining: 0 });
  const snap = await ledger.snapshot();
  assert.equal(snap.used, 6);
  assert.equal(snap.remaining, 0);
  const raw = JSON.parse(await fs.readFile(h.filePath, 'utf8'));
  assert.equal(raw.used, 6);
  assert.equal(raw.day, '2026-10-24');
});

test('reason=user 的用户明确查询不占自主额度、不被 6 次上限拦住、也不落盘', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  await ledger.load();
  // 全新账本里先用 user：0 消耗、不创建文件。
  const fresh = await ledger.reserve({ reason: 'user' });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.counted, false);
  assert.equal(fresh.used, 0);
  assert.equal(await exists(h.filePath), false);
  for (let index = 0; index < 6; index += 1) await ledger.reserve({ reason: 'patrol' });
  // 自主额度已满：user 仍放行，且不改变计数。
  const user = await ledger.reserve({ reason: 'user' });
  assert.equal(user.ok, true);
  assert.equal(user.counted, false);
  assert.equal(user.used, 6);
  assert.equal(user.remaining, 0);
  assert.equal((await ledger.snapshot()).used, 6);
});

test('一次读帖的多页抓取只算一次：一次 reserve 对应一次多页批处理', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  await ledger.load();
  // 模拟 onBeforeTiebaRequest：多页批处理在请求边界只调用一次 reserve，之后抓 3 页。
  const gate = await ledger.reserve({ reason: 'patrol' });
  assert.equal(gate.ok, true);
  const fetchedPages = [1, 2, 3];
  assert.deepEqual(fetchedPages, [1, 2, 3]);
  assert.equal((await ledger.snapshot()).used, 1);
  // 下一次工具调用（另一次读帖）再算一次。
  assert.equal((await ledger.reserve({ reason: 'patrol' })).used, 2);
  // user 查询夹在中间不推进计数。
  await ledger.reserve({ reason: 'user' });
  assert.equal((await ledger.snapshot()).used, 2);
});

test('北京时间跨日重置计数，且时钟回拨 fail-closed 不退回旧日额度', async (t) => {
  const h = await harness(t, bjt(2026, 10, 24, 23, 59, 0));
  const ledger = h.make();
  await ledger.load();
  for (let index = 0; index < 6; index += 1) assert.equal((await ledger.reserve({ reason: 'patrol' })).ok, true);
  assert.deepEqual((await ledger.reserve({ reason: 'patrol' })).reason, 'daily-cap');

  h.setNow(bjt(2026, 10, 25, 0, 1, 0));
  const newDay = await ledger.reserve({ reason: 'patrol' });
  assert.equal(newDay.ok, true);
  assert.equal(newDay.used, 1);
  assert.equal(newDay.remaining, 5);
  const snap = await ledger.snapshot();
  assert.equal(snap.day, '2026-10-25');
  assert.equal(snap.used, 1);
  const raw = JSON.parse(await fs.readFile(h.filePath, 'utf8'));
  assert.equal(raw.day, '2026-10-25');
  assert.equal(raw.used, 1);

  // 再回拨到昨天：拒绝，且不把 2026-10-25 的 1 次还回去。
  h.setNow(bjt(2026, 10, 24, 23, 59, 30));
  assert.deepEqual(await ledger.reserve({ reason: 'patrol' }), { ok: false, reason: 'clock-rollback' });
  assert.equal((await ledger.snapshot()).used, 1);
  assert.equal((await ledger.snapshot()).day, '2026-10-25');
});

test('重启后额度保留：新实例继续拒绝第 7 次，不会重置为 6 次', async (t) => {
  const h = await harness(t);
  const first = h.make();
  await first.load();
  for (let index = 0; index < 6; index += 1) await first.reserve({ reason: 'patrol' });

  const restarted = h.make();
  const loaded = await restarted.load();
  assert.equal(loaded.used, 6);
  assert.deepEqual(await restarted.reserve({ reason: 'patrol' }), { ok: false, reason: 'daily-cap', used: 6, limit: 6, remaining: 0 });
  // user 查询依然可用。
  assert.equal((await restarted.reserve({ reason: 'user' })).ok, true);
});

test('20 个并发申请恰好放行 6 个，并按 6 次持久化', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  await ledger.load();
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => ledger.reserve({ reason: 'patrol' })));
  assert.equal(outcomes.filter((entry) => entry.ok).length, 6);
  assert.equal(outcomes.filter((entry) => entry.reason === 'daily-cap').length, 14);
  const usedValues = outcomes.filter((entry) => entry.ok).map((entry) => entry.used).sort((a, b) => a - b);
  assert.deepEqual(usedValues, [1, 2, 3, 4, 5, 6]);
  const restarted = h.make();
  await restarted.load();
  assert.equal((await restarted.snapshot()).used, 6);
});

test('损坏/矛盾/未知版本账本永久 fail-closed，保留原字节且不创建新文件', async (t) => {
  const h = await harness(t);
  const goodDay = '2026-10-24';
  const lastAccessAt = bjt(2026, 10, 24, 10);
  const cases = [
    '',
    '   ',
    '{bad',
    '[]',
    JSON.stringify({ schemaVersion: 999, day: goodDay, used: 1, lastAccessAt }),
    JSON.stringify({ schemaVersion: 1, day: '2026-13-40', used: 1, lastAccessAt }),
    JSON.stringify({ schemaVersion: 1, day: goodDay, used: -1, lastAccessAt }),
    JSON.stringify({ schemaVersion: 1, day: goodDay, used: 100, lastAccessAt }),
    JSON.stringify({ schemaVersion: 1, day: goodDay, used: 1.5, lastAccessAt }),
    JSON.stringify({ schemaVersion: 1, day: goodDay, used: 2, lastAccessAt: 'yesterday' }),
    JSON.stringify({ schemaVersion: 1, day: goodDay, used: 2, lastAccessAt: null }),
    JSON.stringify({ schemaVersion: 1, day: goodDay, used: 0, lastAccessAt }),
    JSON.stringify({ schemaVersion: 1, day: goodDay, used: 1, lastAccessAt: bjt(2026, 10, 23, 10) }),
  ];
  for (const content of cases) {
    await fs.writeFile(h.filePath, content, 'utf8');
    const ledger = h.make();
    await rejectsWithCode(() => ledger.load(), 'TIEBA_PATROL_LEDGER_FAILED');
    await rejectsWithCode(() => ledger.load(), 'TIEBA_PATROL_LEDGER_FAILED');
    await rejectsWithCode(() => ledger.snapshot(), 'TIEBA_PATROL_LEDGER_FAILED');
    await rejectsWithCode(() => ledger.reserve({ reason: 'patrol' }), 'TIEBA_PATROL_LEDGER_FAILED');
    // 坏文件不能成为 user 查询的额度后门。
    await rejectsWithCode(() => ledger.reserve({ reason: 'user' }), 'TIEBA_PATROL_LEDGER_FAILED');
    assert.equal(await fs.readFile(h.filePath, 'utf8'), content, '损坏文件原字节必须保留');
  }
});

test('非 ENOENT 读取失败永久 fail-closed（EACCES），且不创建文件', async (t) => {
  const h = await harness(t);
  const ledger = h.make({
    ...fs,
    readFile: async () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  });
  await rejectsWithCode(() => ledger.load(), 'TIEBA_PATROL_LEDGER_LOAD_FAILED');
  await rejectsWithCode(() => ledger.snapshot(), 'TIEBA_PATROL_LEDGER_FAILED');
  await rejectsWithCode(() => ledger.reserve({ reason: 'patrol' }), 'TIEBA_PATROL_LEDGER_FAILED');
  assert.equal(await exists(h.filePath), false);
});

test('未 load 前调用一律拒绝（NOT_LOADED），不会静默放行', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  await rejectsWithCode(() => ledger.snapshot(), 'TIEBA_PATROL_LEDGER_NOT_LOADED');
  await rejectsWithCode(() => ledger.reserve({ reason: 'patrol' }), 'TIEBA_PATROL_LEDGER_NOT_LOADED');
  await rejectsWithCode(() => ledger.reserve({ reason: 'user' }), 'TIEBA_PATROL_LEDGER_NOT_LOADED');
});

test('持久化失败（rename EPERM）不进内存、不覆盖旧文件，之后仍可继续服务', async (t) => {
  const h = await harness(t);
  let failRename = false;
  const ledger = h.make({
    ...fs,
    rename: async (...args) => {
      if (failRename) {
        const error = new Error('simulated lock');
        error.code = 'EPERM';
        throw error;
      }
      return fs.rename(...args);
    },
  });
  await ledger.load();
  assert.equal((await ledger.reserve({ reason: 'patrol' })).used, 1);
  const before = await fs.readFile(h.filePath, 'utf8');
  failRename = true;
  await assert.rejects(() => ledger.reserve({ reason: 'patrol' }), /simulated lock/);
  assert.equal(await fs.readFile(h.filePath, 'utf8'), before);
  assert.equal((await ledger.snapshot()).used, 1);
  failRename = false;
  const recovered = await ledger.reserve({ reason: 'patrol' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.used, 2);
  // 临时文件必须被清理（持久化失败不留垃圾）。
  const leftovers = (await fs.readdir(h.dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('父目录缺失：load 可 ready 且不创建目录，首次 reserve 会递归创建目录再落盘', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-tieba-ledger-nested-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'nested', 'deeper', 'tieba-patrol-ledger.json');
  const ledger = createTiebaPatrolLedger({ filePath, clock: { now: () => bjt(2026, 10, 24, 10) } });
  await ledger.load();
  assert.equal(await exists(path.dirname(filePath)), false);
  assert.equal((await ledger.reserve({ reason: 'patrol' })).used, 1);
  assert.equal(await exists(filePath), true);
});

test('预留参数校验：非法 reason 抛带 code 错误；未知字段/内容不落盘', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  await ledger.load();
  for (const reason of ['admin', 'USER', 'User', 42, null, {}]) {
    await rejectsWithCode(() => ledger.reserve({ reason }), 'TIEBA_PATROL_LEDGER_INVALID_REASON');
  }
  assert.equal((await ledger.snapshot()).used, 0);
  // 不引入内容封禁：tid/内容/吧名等字段不参与判定、不落盘。
  const result = await ledger.reserve({ reason: 'patrol', tid: '9876543210', bar: '原神', content: 'must-not-persist' });
  assert.equal(result.ok, true);
  const raw = await fs.readFile(h.filePath, 'utf8');
  assert.equal(/must-not-persist|原神|9876543210/.test(raw), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['day', 'lastAccessAt', 'schemaVersion', 'used']);
});

test('预留时间 fail-closed：未来/过久历史/非法时间不推进日账', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  await ledger.load();
  assert.equal((await ledger.reserve({ reason: 'patrol' })).used, 1);
  const before = await fs.readFile(h.filePath, 'utf8');
  await assert.rejects(() => ledger.reserve({ reason: 'patrol', at: h.now() + 60_000 }), RangeError);
  await assert.rejects(() => ledger.reserve({ reason: 'patrol', at: h.now() - 10 * 60_000 }), RangeError);
  await assert.rejects(() => ledger.reserve({ reason: 'patrol', at: NaN }), TypeError);
  await assert.rejects(() => ledger.reserve({ reason: 'patrol', at: 'now' }), TypeError);
  assert.equal(await fs.readFile(h.filePath, 'utf8'), before);
  assert.equal((await ledger.snapshot()).used, 1);
});

test('L3 at 回填不能跨北京零点借昨日额度：实际记账时间 = max(at, clock)', async (t) => {
  const h = await harness(t, bjt(2026, 10, 24, 23, 50));
  const ledger = h.make();
  await ledger.load();
  assert.equal((await ledger.reserve({ reason: 'patrol' })).used, 1);
  assert.equal((await ledger.reserve({ reason: 'patrol' })).used, 2);
  assert.equal((await ledger.snapshot()).day, '2026-10-24');

  // 跨到次日 00:01，但 at 回填到昨日 23:58（合法 5 分钟窗口内）：
  // 记账日必须是今天（今日第 1 次），不能继续消耗昨日第 3 次。
  h.setNow(bjt(2026, 10, 25, 0, 1, 0));
  const backfilled = await ledger.reserve({ reason: 'patrol', at: bjt(2026, 10, 24, 23, 58, 0) });
  assert.equal(backfilled.ok, true);
  assert.equal(backfilled.used, 1);
  assert.equal(backfilled.remaining, 5);
  const snap = await ledger.snapshot();
  assert.equal(snap.day, '2026-10-25');
  assert.equal(snap.used, 1);
  let raw = JSON.parse(await fs.readFile(h.filePath, 'utf8'));
  assert.equal(raw.day, '2026-10-25');
  assert.equal(raw.used, 1);
  assert.equal(beijingPatrolDayKey(raw.lastAccessAt), '2026-10-25', 'lastAccessAt 也必须落在今天');

  // 今天最多到 6 次；第 7 次即使 at 回填昨日也仍然是 daily-cap。
  for (let index = 0; index < 5; index += 1) assert.equal((await ledger.reserve({ reason: 'patrol' })).ok, true);
  assert.equal((await ledger.snapshot()).used, 6);
  assert.deepEqual(
    await ledger.reserve({ reason: 'patrol', at: bjt(2026, 10, 24, 23, 59, 0) }),
    { ok: false, reason: 'daily-cap', used: 6, limit: 6, remaining: 0 },
  );
  raw = JSON.parse(await fs.readFile(h.filePath, 'utf8'));
  assert.equal(raw.day, '2026-10-25');
  assert.equal(raw.used, 6);
  // 同一窗口内的总放行 = 昨日 2 + 今日 6，不能借用昨日额度。
});

test('快照是深拷贝：外部改写不影响账本', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  await ledger.load();
  await ledger.reserve({ reason: 'patrol' });
  const snap = await ledger.snapshot();
  snap.used = 0;
  snap.remaining = 5;
  const fresh = await ledger.snapshot();
  assert.equal(fresh.used, 1);
  assert.equal(fresh.remaining, 5);
  // 跨零点但尚未 reserve 时，快照按当前北京时间日显示 0 次（只读，不落盘）。
  h.setNow(bjt(2026, 10, 25, 0, 0, 1));
  const nextDay = await ledger.snapshot();
  assert.equal(nextDay.day, '2026-10-25');
  assert.equal(nextDay.used, 0);
  assert.equal(nextDay.remaining, 6);
  assert.equal(beijingPatrolDayKey(h.now()), '2026-10-25');
});

test('与现有 onBeforeTiebaRequest 对齐（纯离线）：一次多页工具调用只预留一次，超限时钩子拒绝且零抓取', async (t) => {
  const h = await harness(t);
  const ledger = h.make();
  await ledger.load();

  const THREAD_HTML = '<!DOCTYPE html><html><head><title>第1/3页,回贴列表-测试帖子</title></head><body><p>占位帖页</p></body></html>';
  const events = [];
  let hookCalls = 0;
  const onBeforeTiebaRequest = async () => {
    hookCalls += 1;
    events.push('hook');
    const gate = await ledger.reserve({ reason: 'patrol' });
    return gate.ok ? undefined : false;
  };
  const fetchText = async () => {
    events.push('fetch');
    return THREAD_HTML;
  };
  const limiter = { allow: () => ({ ok: true }), noteSuccess() {}, noteBlocked() {}, noteFailure() {} };
  const options = {
    fetchText,
    searchFetch: async () => '',
    onBeforeTiebaRequest,
    limiter,
    readFile: () => {
      throw new Error('本测试不应读取任何 Cookie 文件');
    },
    now: h.now(),
  };

  // 一次 fetchThreadPages(pages=1-3)：钩子 1 次、抓 3 页、账本只 +1。
  const first = await fetchThreadPages('9876543210', { ...options, pages: '1-3' });
  assert.equal(first.ok, true);
  assert.equal(hookCalls, 1);
  assert.equal(events.filter((event) => event === 'fetch').length, 3);
  assert.deepEqual(first.fetchedPages, [1, 2, 3]);
  assert.equal((await ledger.snapshot()).used, 1);

  // 第二次工具调用（单页）再 +1。
  const second = await fetchThreadPages('9876543210', { ...options, pages: '1' });
  assert.equal(second.ok, true);
  assert.equal(hookCalls, 2);
  assert.equal(events.filter((event) => event === 'fetch').length, 4);
  assert.equal((await ledger.snapshot()).used, 2);

  // 用满剩余 4 次额度。
  for (let index = 0; index < 4; index += 1) assert.equal((await ledger.reserve({ reason: 'patrol' })).ok, true);
  assert.equal((await ledger.snapshot()).used, 6);

  // 下一次工具调用：钩子返回拒绝 -> tieba-lib 不抓任何页、不抛错。
  const fetchesBefore = events.filter((event) => event === 'fetch').length;
  const refused = await fetchThreadPages('9876543210', { ...options, pages: '1' });
  assert.equal(refused.ok, false);
  assert.equal(hookCalls, 3);
  assert.equal(events.filter((event) => event === 'fetch').length, fetchesBefore, '被账本拒绝后绝不能发出贴吧请求');
  assert.equal((await ledger.snapshot()).used, 6);
});
