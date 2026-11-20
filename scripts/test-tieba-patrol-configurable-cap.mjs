#!/usr/bin/env node
// scripts/test-tieba-patrol-configurable-cap.mjs
//
// task-15 行为级回归：贴吧自主访问日上限可配置 0..99（默认 6）。
//
// 覆盖（与 task-15 契约逐条对应）：
//  1) ledger 常量：TIEBA_PATROL_DEFAULT_DAILY_CAP=6（TIEBA_PATROL_DAILY_CAP 为兼容别名）、
//     MIN=0、MAX=99；schemaVersion 仍为 1。
//  2) createTiebaPatrolLedger({limit?})：0..99 整数合法、缺省 6；非法（-1/100/1.5/'6'/NaN/null…）抛 TypeError。
//  3) reserve({limit?})：每次调用可覆盖实例上限；非法 limit 抛带 code 的错误且不写盘；返回的 limit 一律是
//     effectiveLimit；used>=effectiveLimit → daily-cap（used 原样返回，可大于 limit）；limit=0 首次即拒绝且不写盘。
//  4) snapshot()：limit=当前实例 effectiveLimit、remaining=max(0,limit-used)（used 可能大于 limit）。
//  5) 调上限不清空/不改写当天 used、不产生额外写盘：3@6 → limit 10（used 3 / remaining 7 / 文件字节不变）
//     → limit 2（下次 daily-cap、used 仍 3）→ 改回 6（used 仍 3）。
//  6) 旧状态兼容：used=5 / 6 / 50（limit 6 时越界）可加载且不重置；used=99 可加载；used=100 坏状态
//     fail-closed 且原字节绝不覆盖；limit 永远不写盘。
//  7) adapter：固定 limit 与动态 limitOf（每次 reserve 求值）都透传；非法 limit fail-closed 为
//     {ok:false, reason:'invalid-limit'} 且**不调用 ledger**；ledger 故障仍 ledger-unavailable；
//     reason='user' 完全不调用 ledger（非法 limit 也不影响）；limit=0 时首次 patrol 即 daily-cap 且不写盘。
//
// 纯离线：只用 os.tmpdir() 临时目录 + 注入时钟；不写真实 state/、不联网、不访问贴吧/QQ、不读 Cookie。
// 运行：node scripts/test-tieba-patrol-configurable-cap.mjs（失败进程非 0）。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  TIEBA_PATROL_LEDGER_VERSION,
  TIEBA_PATROL_DEFAULT_DAILY_CAP,
  TIEBA_PATROL_DAILY_CAP,
  TIEBA_PATROL_MIN_DAILY_CAP,
  TIEBA_PATROL_MAX_DAILY_CAP,
  createTiebaPatrolLedger,
} from '../src/core/tieba-patrol-ledger.mjs';
import { createTiebaPatrolAdapter } from '../src/core/tieba-patrol-adapter.mjs';

const BJT_OFFSET = 8 * 60 * 60 * 1000;
const T0 = bjtTimestamp(2026, 10, 27, 10, 0, 0);

function bjtTimestamp(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
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

async function rejectsWithCode(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.code, expectedCode, `期望 code=${expectedCode}，实际 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望 promise 以 code=${expectedCode} 拒绝`);
}

async function dirHarness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-tieba-cap-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, filePath: path.join(dir, 'tieba-patrol-ledger.json') };
}

/** 账本 harness：同一文件 + 可控时钟；make(opts) 可注入 limit（不传则沿用缺省）。 */
async function ledgerHarness(t, at = T0) {
  const { dir, filePath } = await dirHarness(t);
  let now = at;
  const clock = { now: () => now };
  const make = (opts = {}) => createTiebaPatrolLedger({ filePath, clock, ...opts });
  return { dir, filePath, make, clock, now: () => now, setNow: (value) => { now = value; } };
}

function writeState(filePath, { used, day = '2026-10-27', lastAccessAt = T0, extra = {} }) {
  return fs.writeFile(filePath, JSON.stringify({ schemaVersion: 1, day, used, lastAccessAt, ...extra }), 'utf8');
}

function dayKeyOf(epochMs) {
  // 测试内独立计算北京日键，避免与被测模块共享实现。
  return new Date(epochMs + BJT_OFFSET).toISOString().slice(0, 10);
}

/** 假账本：记录每次 reserve 的请求；handler 决定返回值/抛错。 */
function fakeLedger(handler) {
  const calls = [];
  return {
    calls,
    async reserve(request) {
      calls.push(request);
      return handler(request, calls.length);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 常量
// ---------------------------------------------------------------------------

test('常量：默认 6、兼容别名、0..99 边界、schemaVersion=1', () => {
  assert.equal(TIEBA_PATROL_DEFAULT_DAILY_CAP, 6);
  assert.equal(TIEBA_PATROL_DAILY_CAP, 6, 'TIEBA_PATROL_DAILY_CAP 必须保留为默认值 6 的兼容别名');
  assert.equal(TIEBA_PATROL_DAILY_CAP, TIEBA_PATROL_DEFAULT_DAILY_CAP);
  assert.equal(TIEBA_PATROL_MIN_DAILY_CAP, 0);
  assert.equal(TIEBA_PATROL_MAX_DAILY_CAP, 99);
  assert.equal(TIEBA_PATROL_LEDGER_VERSION, 1);
});

// ---------------------------------------------------------------------------
// 2. 构造 limit：合法/非法/缺省
// ---------------------------------------------------------------------------

test('构造 limit：缺省 6；0..99 合法；非法值一律 TypeError', async (t) => {
  const h = await ledgerHarness(t);
  const byDefault = h.make();
  await byDefault.load();
  assert.equal((await byDefault.snapshot()).limit, 6, '缺省 limit 必须是 6');
  // 显式 undefined 等同于缺省。
  const explicitUndefined = h.make({ limit: undefined });
  await explicitUndefined.load();
  assert.equal((await explicitUndefined.snapshot()).limit, 6);

  for (const valid of [0, 1, 6, 50, 99]) {
    const ledger = h.make({ limit: valid });
    await ledger.load();
    const snap = await ledger.snapshot();
    assert.equal(snap.limit, valid, `limit=${valid} 必须生效`);
    assert.equal(snap.remaining, valid, `limit=${valid} 且 used=0 时 remaining 必须等于 limit`);
  }

  const invalidLimits = [-1, 100, 1.5, '6', Number.NaN, null, true, {}, [], 6.0001, Infinity, -Infinity];
  for (const bad of invalidLimits) {
    assert.throws(
      () => h.make({ limit: bad }),
      TypeError,
      `limit=${String(bad)} 必须在构造时抛 TypeError（绝不静默降级）`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. limit=0：首次即 daily-cap、不写盘；user 仍放行
// ---------------------------------------------------------------------------

test('limit=0：patrol 首次即 daily-cap、used=0、不写盘；user 仍放行', async (t) => {
  const h = await ledgerHarness(t);
  const ledger = h.make({ limit: 0 });
  await ledger.load();

  const snap = await ledger.snapshot();
  assert.equal(snap.limit, 0);
  assert.equal(snap.used, 0);
  assert.equal(snap.remaining, 0);

  const refused = await ledger.reserve({ reason: 'patrol' });
  assert.deepEqual(refused, { ok: false, reason: 'daily-cap', used: 0, limit: 0, remaining: 0 });
  assert.equal(await exists(h.filePath), false, 'limit=0 的拒绝绝不能写盘');

  const user = await ledger.reserve({ reason: 'user' });
  assert.deepEqual(user, { ok: true, counted: false, used: 0, limit: 0, remaining: 0 });
  assert.equal(await exists(h.filePath), false, 'user 查询不落盘');
});

// ---------------------------------------------------------------------------
// 4. 默认 6 行为（回归保护）
// ---------------------------------------------------------------------------

test('默认 6：前 6 次放行且 limit 透传，第 7 次 daily-cap', async (t) => {
  const h = await ledgerHarness(t);
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
  assert.deepEqual(
    await ledger.reserve({ reason: 'patrol' }),
    { ok: false, reason: 'daily-cap', used: 6, limit: 6, remaining: 0 },
  );
  const raw = JSON.parse(await fs.readFile(h.filePath, 'utf8'));
  assert.equal(raw.used, 6);
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'limit'), false, 'limit 不得写盘');
});

// ---------------------------------------------------------------------------
// 5. 0..99 边界（99 次真实落盘）
// ---------------------------------------------------------------------------

test('边界 limit=99：恰好放行 99 次，第 100 次 daily-cap', async (t) => {
  const h = await ledgerHarness(t);
  const ledger = h.make({ limit: 99 });
  await ledger.load();
  let last = null;
  for (let index = 1; index <= 99; index += 1) {
    last = await ledger.reserve({ reason: 'patrol' });
    assert.equal(last.ok, true, `第 ${index} 次必须放行`);
    assert.equal(last.used, index);
    assert.equal(last.limit, 99);
    assert.equal(last.remaining, 99 - index);
  }
  assert.deepEqual(
    await ledger.reserve({ reason: 'patrol' }),
    { ok: false, reason: 'daily-cap', used: 99, limit: 99, remaining: 0 },
  );
  const raw = JSON.parse(await fs.readFile(h.filePath, 'utf8'));
  assert.equal(raw.used, 99);
  assert.deepEqual(Object.keys(raw).sort(), ['day', 'lastAccessAt', 'schemaVersion', 'used']);
});

// ---------------------------------------------------------------------------
// 6. 调上限不清空 used、不产生额外写盘（契约主链）
// ---------------------------------------------------------------------------

test('调整上限保留当天 used：3@6 → 10（used 3 / remaining 7 / 字节不变）→ 2（daily-cap，used 3）→ 6（used 3）', async (t) => {
  const h = await ledgerHarness(t);
  const original = h.make({ limit: 6 });
  await original.load();
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await original.reserve({ reason: 'patrol' })).ok, true);
  }
  assert.equal((await original.snapshot()).used, 3);
  const bytesAfterReserves = await fs.readFile(h.filePath, 'utf8');

  // 调高到 10：load 只读，used=3 保留，remaining=7，文件字节不变。
  const widened = h.make({ limit: 10 });
  const widenedLoaded = await widened.load();
  assert.equal(widenedLoaded.used, 3, '调高上限绝不能清空当天 used');
  assert.equal(widenedLoaded.limit, 10);
  assert.equal(widenedLoaded.remaining, 7);
  assert.equal(await fs.readFile(h.filePath, 'utf8'), bytesAfterReserves, '调整上限不得产生额外写盘');
  // 新上限下继续计数：used=4/limit=10/remaining=6。
  const nextUnder10 = await widened.reserve({ reason: 'patrol' });
  assert.deepEqual(
    { ok: nextUnder10.ok, used: nextUnder10.used, limit: nextUnder10.limit, remaining: nextUnder10.remaining },
    { ok: true, used: 4, limit: 10, remaining: 6 },
  );
  // 回退到 3 次的状态继续验证「调低」链（模拟 3@6 场景，避免上面的 +1 干扰断言）。
  const threeUsed = { schemaVersion: 1, day: dayKeyOf(T0), used: 3, lastAccessAt: T0 };
  await fs.writeFile(h.filePath, JSON.stringify(threeUsed), 'utf8');
  const bytesAtThree = await fs.readFile(h.filePath, 'utf8');

  // 调低到 2：used=3 > limit=2，可加载、remaining=0、下次 reserve 仍 daily-cap 且 used 保持 3。
  const narrowed = h.make({ limit: 2 });
  const narrowedLoaded = await narrowed.load();
  assert.equal(narrowedLoaded.used, 3, '调低上限绝不清空/重置当天 used');
  assert.equal(narrowedLoaded.limit, 2);
  assert.equal(narrowedLoaded.remaining, 0, 'used > limit 时 remaining 必须取 0');
  assert.deepEqual(
    await narrowed.reserve({ reason: 'patrol' }),
    { ok: false, reason: 'daily-cap', used: 3, limit: 2, remaining: 0 },
  );
  assert.equal(await fs.readFile(h.filePath, 'utf8'), bytesAtThree, 'daily-cap 与调低上限都不得写盘');
  assert.equal((await narrowed.snapshot()).used, 3);

  // 改回 6：used 仍是 3，remaining 3，下一次 reserve 得到 used=4。
  const restored = h.make({ limit: 6 });
  const restoredLoaded = await restored.load();
  assert.equal(restoredLoaded.used, 3);
  assert.equal(restoredLoaded.limit, 6);
  assert.equal(restoredLoaded.remaining, 3);
  const next = await restored.reserve({ reason: 'patrol' });
  assert.equal(next.ok, true);
  assert.equal(next.used, 4);
  assert.equal(next.remaining, 2);
  assert.equal((await restored.snapshot()).used, 4);
});

// ---------------------------------------------------------------------------
// 7. reserve 每次 limit 覆盖
// ---------------------------------------------------------------------------

test('reserve({limit}) 每次覆盖：10 → 0 → 99；非法 limit 抛带 code 错误且不写盘', async (t) => {
  const h = await ledgerHarness(t);
  const ledger = h.make({ limit: 6 });
  await ledger.load();

  const wide = await ledger.reserve({ reason: 'patrol', limit: 10 });
  assert.deepEqual(
    { ok: wide.ok, used: wide.used, limit: wide.limit, remaining: wide.remaining },
    { ok: true, used: 1, limit: 10, remaining: 9 },
  );

  // 单次覆盖为 0：立即拒绝，且不推进 used。
  assert.deepEqual(
    await ledger.reserve({ reason: 'patrol', limit: 0 }),
    { ok: false, reason: 'daily-cap', used: 1, limit: 0, remaining: 0 },
  );

  const huge = await ledger.reserve({ reason: 'patrol', limit: 99 });
  assert.deepEqual(
    { ok: huge.ok, used: huge.used, limit: huge.limit, remaining: huge.remaining },
    { ok: true, used: 2, limit: 99, remaining: 97 },
  );

  // 实例值不受单次覆盖影响：snapshot 用实例 limit=6。
  const snap = await ledger.snapshot();
  assert.equal(snap.limit, 6);
  assert.equal(snap.used, 2);
  assert.equal(snap.remaining, 4);

  const bytesAfterHuge = await fs.readFile(h.filePath, 'utf8');
  const invalidLimits = [-1, 100, 1.5, '6', Number.NaN, null, true, {}, [], Infinity, -Infinity];
  for (const bad of invalidLimits) {
    const error = await rejectsWithCode(
      () => ledger.reserve({ reason: 'patrol', limit: bad }),
      'TIEBA_PATROL_LEDGER_INVALID_LIMIT',
    );
    assert.equal(typeof error.message, 'string');
  }
  // 非法值全部拒绝：used 未推进、文件字节不变。
  assert.equal((await ledger.snapshot()).used, 2);
  assert.equal(await fs.readFile(h.filePath, 'utf8'), bytesAfterHuge, '非法 limit 绝不允许写盘');

  // 显式 limit=undefined 表示“未覆盖”，必须等价于缺省 limit=6。
  const plain = await ledger.reserve({ reason: 'patrol', limit: undefined });
  assert.deepEqual(
    { ok: plain.ok, used: plain.used, limit: plain.limit, remaining: plain.remaining },
    { ok: true, used: 3, limit: 6, remaining: 3 },
  );
  assert.equal((await ledger.snapshot()).used, 3);
});

// ---------------------------------------------------------------------------
// 8. 旧状态兼容：used 0..99
// ---------------------------------------------------------------------------

test('旧状态 used=5/6/50 均可加载且不重置（limit 6 时 used 可大于 limit）', async (t) => {
  const h = await ledgerHarness(t);

  for (const used of [5, 6, 50]) {
    await writeState(h.filePath, { used });
    const bytes = await fs.readFile(h.filePath, 'utf8');
    const ledger = h.make({ limit: 6 });
    const loaded = await ledger.load();
    assert.equal(loaded.used, used, `旧状态 used=${used} 必须原样加载`);
    assert.equal(loaded.limit, 6);
    assert.equal(loaded.remaining, Math.max(0, 6 - used));
    assert.equal(await fs.readFile(h.filePath, 'utf8'), bytes, 'load 不得改写旧状态文件');
  }

  // used=5：还能放行 1 次。
  await writeState(h.filePath, { used: 5 });
  const fifth = h.make({ limit: 6 });
  assert.equal((await fifth.load()).used, 5);
  const allowed = await fifth.reserve({ reason: 'patrol' });
  assert.deepEqual(
    { ok: allowed.ok, used: allowed.used, limit: allowed.limit, remaining: allowed.remaining },
    { ok: true, used: 6, limit: 6, remaining: 0 },
  );

  // used=6：直接 daily-cap，used 保持 6。
  await writeState(h.filePath, { used: 6 });
  const sixth = h.make({ limit: 6 });
  await sixth.load();
  assert.deepEqual(
    await sixth.reserve({ reason: 'patrol' }),
    { ok: false, reason: 'daily-cap', used: 6, limit: 6, remaining: 0 },
  );

  // used=50（旧文件不写 limit，当前默认 6）：可加载、不重置，audit 视图 remaining=0。
  await writeState(h.filePath, { used: 50 });
  const over = h.make({ limit: 6 });
  const overLoaded = await over.load();
  assert.equal(overLoaded.used, 50);
  assert.equal(overLoaded.remaining, 0);
  assert.deepEqual(
    await over.reserve({ reason: 'patrol' }),
    { ok: false, reason: 'daily-cap', used: 50, limit: 6, remaining: 0 },
  );
});

test('used=99 可加载；used=100 坏状态 fail-closed 且原字节绝不覆盖', async (t) => {
  const h = await ledgerHarness(t);

  await writeState(h.filePath, { used: 99 });
  const boundary = h.make({ limit: 99 });
  const loaded = await boundary.load();
  assert.equal(loaded.used, 99);
  assert.equal(loaded.limit, 99);
  assert.equal(loaded.remaining, 0);
  assert.deepEqual(
    await boundary.reserve({ reason: 'patrol' }),
    { ok: false, reason: 'daily-cap', used: 99, limit: 99, remaining: 0 },
  );

  await writeState(h.filePath, { used: 100 });
  const badBytes = await fs.readFile(h.filePath, 'utf8');
  const corrupted = h.make({ limit: 99 });
  await rejectsWithCode(() => corrupted.load(), 'TIEBA_PATROL_LEDGER_FAILED');
  await rejectsWithCode(() => corrupted.load(), 'TIEBA_PATROL_LEDGER_FAILED');
  await rejectsWithCode(() => corrupted.snapshot(), 'TIEBA_PATROL_LEDGER_FAILED');
  await rejectsWithCode(() => corrupted.reserve({ reason: 'patrol' }), 'TIEBA_PATROL_LEDGER_FAILED');
  await rejectsWithCode(() => corrupted.reserve({ reason: 'user' }), 'TIEBA_PATROL_LEDGER_FAILED');
  assert.equal(await fs.readFile(h.filePath, 'utf8'), badBytes, '坏状态文件原字节必须保留');
  const leftovers = (await fs.readdir(h.dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('limit 不持久化：状态文件永远只有四个字段，JSON 文本里不出现 limit', async (t) => {
  const h = await ledgerHarness(t);
  const ledger = h.make({ limit: 42 });
  await ledger.load();
  await ledger.reserve({ reason: 'patrol' });
  await ledger.reserve({ reason: 'patrol', limit: 99 });
  const text = await fs.readFile(h.filePath, 'utf8');
  assert.equal(/limit/i.test(text), false, `状态文件不得包含 limit：${text}`);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['day', 'lastAccessAt', 'schemaVersion', 'used']);
});

// ---------------------------------------------------------------------------
// 9. adapter：固定 limit
// ---------------------------------------------------------------------------

async function adapterLedgerHarness(t, limit) {
  const h = await ledgerHarness(t);
  const ledger = h.make(limit === undefined ? {} : { limit });
  await ledger.load();
  return { ...h, ledger };
}

test('adapter 固定 limit=2：透传决策的 used/limit/remaining，第 3 次 daily-cap，账本实例视图不变', async (t) => {
  const h = await adapterLedgerHarness(t, 6);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger, limit: 2 });

  const first = await adapter();
  assert.deepEqual(
    { ok: first.ok, counted: first.counted, used: first.used, limit: first.limit, remaining: first.remaining },
    { ok: true, counted: true, used: 1, limit: 2, remaining: 1 },
  );
  const second = await adapter();
  assert.deepEqual(
    { ok: second.ok, used: second.used, limit: second.limit, remaining: second.remaining },
    { ok: true, used: 2, limit: 2, remaining: 0 },
  );
  const third = await adapter();
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'daily-cap');
  assert.equal(typeof third.message, 'string');

  const snap = await h.ledger.snapshot();
  assert.equal(snap.used, 2, 'adapter 覆盖 limit 不应改变账本的实际计数');
  assert.equal(snap.limit, 6, '账本实例自身 limit 不变');
  assert.equal(snap.remaining, 4);
  const raw = JSON.parse(await fs.readFile(h.filePath, 'utf8'));
  assert.equal(raw.used, 2);
});

test('adapter limit 透传：配置固定 limit 时 request.limit 存在；未配置时 request 不含 limit 键', async (t) => {
  void t;
  const calls = [];
  const ledger = {
    async reserve(request) {
      calls.push(request);
      return { ok: true, counted: true, used: 1, limit: 3, remaining: 2 };
    },
  };
  const withLimit = createTiebaPatrolAdapter({ ledger, limit: 3 });
  const decision = await withLimit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 3);
  assert.deepEqual(
    { used: decision.used, limit: decision.limit, remaining: decision.remaining },
    { used: 1, limit: 3, remaining: 2 },
  );

  const callsWithout = [];
  const plainLedger = {
    async reserve(request) {
      callsWithout.push(request);
      return { ok: true, counted: true, used: 1, limit: 6, remaining: 5 };
    },
  };
  const withoutLimit = createTiebaPatrolAdapter({ ledger: plainLedger });
  await withoutLimit();
  assert.equal(Object.prototype.hasOwnProperty.call(callsWithout[0], 'limit'), false, '未配置 limit 时不能给 ledger 传 limit');
});

// ---------------------------------------------------------------------------
// 10. adapter：动态 limitOf
// ---------------------------------------------------------------------------

test('adapter 动态 limitOf：每次 reserve 重新求值（1 → 1 → 3 → 0）', async (t) => {
  const h = await adapterLedgerHarness(t, 6);
  let currentLimit = 1;
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger, limitOf: () => currentLimit });

  const first = await adapter();
  assert.deepEqual(
    { ok: first.ok, used: first.used, limit: first.limit, remaining: first.remaining },
    { ok: true, used: 1, limit: 1, remaining: 0 },
  );
  const second = await adapter();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'daily-cap');
  assert.equal(second.used, 1);
  assert.equal(second.limit, 1);

  currentLimit = 3;
  const third = await adapter();
  assert.deepEqual(
    { ok: third.ok, used: third.used, limit: third.limit, remaining: third.remaining },
    { ok: true, used: 2, limit: 3, remaining: 1 },
  );

  currentLimit = 0;
  const fourth = await adapter();
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, 'daily-cap');
  assert.equal(fourth.used, 2);
  assert.equal(fourth.limit, 0);

  // 账本自身 limit 一直是 6，动态上限只影响适配器决策。
  const snap = await h.ledger.snapshot();
  assert.equal(snap.limit, 6);
  assert.equal(snap.used, 2);
});

// ---------------------------------------------------------------------------
// 11. adapter：非法 limit fail-closed
// ---------------------------------------------------------------------------

test('adapter 非法 limit fail-closed：返回 invalid-limit 且绝不调用 ledger', async (t) => {
  void t;
  const invalidValues = [-1, 100, 1.5, '6', Number.NaN, null, undefined, true, {}, Infinity];
  for (const bad of invalidValues) {
    const calls = [];
    const ledger = {
      async reserve(request) {
        calls.push(request);
        return { ok: true, counted: true, used: 1, limit: 6, remaining: 5 };
      },
    };
    const adapter = createTiebaPatrolAdapter({ ledger, limitOf: () => bad });
    const decision = await adapter();
    assert.equal(decision.ok, false, `limitOf 返回 ${String(bad)} 必须 fail-closed`);
    assert.equal(decision.reason, 'invalid-limit', `limitOf 返回 ${String(bad)} 的 reason 必须是 invalid-limit`);
    assert.equal(typeof decision.message, 'string');
    assert.equal(calls.length, 0, `非法 limit 时绝不能调用 ledger（${String(bad)}）`);
    // 重试仍拒绝且仍不调用 ledger（不缓存放行、不消耗额度）。
    const retried = await adapter();
    assert.equal(retried.ok, false);
    assert.equal(retried.reason, 'invalid-limit');
    assert.equal(calls.length, 0);
  }

  // limitOf 抛错也必须 fail-closed 为 invalid-limit，且不调用 ledger。
  const throwingCalls = [];
  const throwingAdapter = createTiebaPatrolAdapter({
    ledger: {
      async reserve(request) {
        throwingCalls.push(request);
        return { ok: true };
      },
    },
    limitOf: () => {
      const error = new Error('boom');
      error.code = 'EPERM';
      throw error;
    },
  });
  const thrown = await throwingAdapter();
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, 'invalid-limit');
  assert.equal(throwingCalls.length, 0);
});

test('adapter 构造校验：固定 limit 非法 / limit 与 limitOf 并用 / limitOf 非函数 → TypeError', () => {
  const ledger = { reserve: async () => ({ ok: true, counted: true, used: 1, limit: 6, remaining: 5 }) };
  for (const bad of [-1, 100, 1.5, '6', Number.NaN, null, true, {}]) {
    assert.throws(() => createTiebaPatrolAdapter({ ledger, limit: bad }), TypeError, `limit=${String(bad)}`);
  }
  assert.throws(() => createTiebaPatrolAdapter({ ledger, limit: 6, limitOf: () => 6 }), TypeError);
  assert.throws(() => createTiebaPatrolAdapter({ ledger, limitOf: 6 }), TypeError);
});

// ---------------------------------------------------------------------------
// 12. adapter：故障与 user 语义
// ---------------------------------------------------------------------------

test('adapter 配置 limit 时账本故障仍 fail-closed（ledger-unavailable）', async (t) => {
  void t;
  const failing = {
    async reserve() {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    },
  };
  const adapter = createTiebaPatrolAdapter({ ledger: failing, limit: 5 });
  const decision = await adapter();
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'ledger-unavailable');

  const malformed = { reserve: async () => null };
  const malformedAdapter = createTiebaPatrolAdapter({ ledger: malformed, limitOf: () => 5 });
  const malformedDecision = await malformedAdapter();
  assert.equal(malformedDecision.ok, false);
  assert.equal(malformedDecision.reason, 'ledger-unavailable');
  // fail-closed 决策可审计，但绝不能出现 ok:true。
  assert.equal(malformedAdapter.lastDecision().ok, false);
});

test('adapter reason=user：不调用 ledger、不受非法 limit 影响', async (t) => {
  void t;
  const calls = [];
  const ledger = {
    async reserve(request) {
      calls.push(request);
      return { ok: true, counted: true, used: 1, limit: 6, remaining: 5 };
    },
  };
  const adapter = createTiebaPatrolAdapter({ ledger, reasonOf: () => 'user', limitOf: () => 100 });
  const decision = await adapter();
  assert.deepEqual(decision, { ok: true, counted: false, reason: 'user' });
  assert.equal(calls.length, 0, 'user 查询绝不能调用 ledger');
  assert.equal(adapter.snapshot().decisions.user, 1);
});

// ---------------------------------------------------------------------------
// 13. adapter limit=0：首次 patrol 即 daily-cap 且不写盘
// ---------------------------------------------------------------------------

test('adapter limit=0：真实账本首次 patrol 即 daily-cap，且不写盘；user 仍放行', async (t) => {
  const h = await adapterLedgerHarness(t, 6);
  const adapter = createTiebaPatrolAdapter({ ledger: h.ledger, limit: 0 });
  const decision = await adapter();
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'daily-cap');
  assert.equal(await exists(h.filePath), false, 'limit=0 的拒绝不得写盘');
  assert.equal((await h.ledger.snapshot()).used, 0);

  const userAdapter = createTiebaPatrolAdapter({ ledger: h.ledger, limit: 0, reasonOf: () => 'user' });
  const user = await userAdapter();
  assert.equal(user.ok, true);
  assert.equal(user.counted, false);
  assert.equal(Number.isInteger(decision.used ?? NaN) || decision.used === undefined, true);
});
