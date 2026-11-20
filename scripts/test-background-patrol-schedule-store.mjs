// scripts/test-background-patrol-schedule-store.mjs
// task-29：调度器持久衔接纯模块测试（TDD 先红后绿）。
// 覆盖：schedule store load/save（坏文件 fail-closed、原子写 randomUUID+rename+目录 sync、
// 并发串行、单实例）、planNext（区间均匀可注入、跨日/跨平台独立、过期不补队列）、
// markOpportunity（持久 lastSkip/lastRun、同代次幂等、时钟回拨拒绝）、与现有
// background-patrol-scheduler.mjs 语义对齐、重启后 nextAt 不丢、代次单调、旧回调不可重入。
// 纯离线：只用 mkdtemp 临时文件与注入时钟/随机源；不启调度器、不联网、不读凭据、不写 state/。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BACKGROUND_PATROL_SCHEDULE_VERSION,
  BACKGROUND_PATROL_SCHEDULE_ERROR_CODES,
  SCHEDULE_PLATFORMS,
  BACKGROUND_PATROL_INTERVALS,
  isBackgroundPatrolActiveTime,
  planNextOpportunity,
  classifyPersistedOpportunity,
  parseScheduleState,
  createBackgroundPatrolScheduleStore,
} from '../src/core/background-patrol-schedule-store.mjs';
import {
  PATROL_INTERVALS,
  isPatrolActiveTime,
  createBackgroundPatrolScheduler,
} from '../src/core/background-patrol-scheduler.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 2026-01-15 09:00（北京时间）
const T0 = Date.UTC(2026, 0, 15, 1, 0, 0);

const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeClock(startMs) {
  let now = startMs;
  return {
    clock: () => now,
    setNow(ms) {
      now = ms;
    },
    now() {
      return now;
    },
  };
}

async function makeRig(startMs = T0, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-schedule-store-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'schedule.json');
  const clock = makeClock(startMs);
  let current = null;
  return {
    dir,
    filePath,
    ...clock,
    async open(overrides = {}) {
      const store = createBackgroundPatrolScheduleStore({
        filePath,
        clock: clock.clock,
        ...options,
        ...overrides,
      });
      await store.load();
      current = store;
      return store;
    },
    createRaw(overrides = {}) {
      return createBackgroundPatrolScheduleStore({ filePath, clock: clock.clock, ...options, ...overrides });
    },
    async closeAll() {
      if (current) await current.close().catch(() => {});
      current = null;
    },
  };
}

const ERR = BACKGROUND_PATROL_SCHEDULE_ERROR_CODES;

test('recordPlan 保存已计算的机会时间而不把未来时间当成当前时间', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  const result = await store.recordPlan({ platform: 'tieba', at: T0, nextAt: T0 + HOUR });
  assert.equal(result.ok, true);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.lastSeenAt, T0);
  assert.equal(snapshot.platforms.tieba.nextAt, T0 + HOUR);
  await rig.closeAll();
  const restarted = await rig.open();
  assert.equal((await restarted.advanceGeneration({ at: T0 + 1 })).ok, true);
  assert.equal((await restarted.snapshot()).platforms.tieba.nextAt, T0 + HOUR);
  await rig.closeAll();
});

// ── task-53：recordPlan 边界加固（TDD 先红后绿） ─────────────────────────────

test('task-53 recordPlan 边界：非法平台/非法时间/nextAt<=at 一律拒绝且不写盘', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  for (const platform of ['unknown', null, undefined, 123]) {
    expectRejected(await store.recordPlan({ platform, at: T0, nextAt: T0 + HOUR }), 'invalid-platform');
  }
  // 显式非法 at（undefined 表示“用注入时钟”，属合法缺省，不在本组）
  for (const at of [NaN, Infinity, -Infinity, 'T0', {}]) {
    expectRejected(await store.recordPlan({ platform: 'tieba', at, nextAt: T0 + HOUR }), 'invalid-time');
  }
  for (const nextAt of [NaN, Infinity, -Infinity, String(T0 + HOUR), undefined, null, {}]) {
    expectRejected(await store.recordPlan({ platform: 'tieba', at: T0, nextAt }), 'invalid-time');
  }
  // 边界（F6）：nextAt 必须严格晚于记录时间，等于/早于都拒绝。
  expectRejected(await store.recordPlan({ platform: 'tieba', at: T0, nextAt: T0 }), 'invalid-time');
  expectRejected(await store.recordPlan({ platform: 'tieba', at: T0, nextAt: T0 - 1 }), 'invalid-time');
  const snapshot = await store.snapshot();
  assert.equal(snapshot.lastSeenAt, T0);
  assert.equal(snapshot.platforms.tieba.planCount, 0);
  assert.equal(snapshot.platforms.tieba.nextAt, null);
  await assert.rejects(fs.stat(rig.filePath), (error) => error.code === 'ENOENT', '全被拒绝时不得落盘');
  await rig.closeAll();
});

test('task-53 recordPlan clock-rollback：记录时间早于 lastSeenAt → 拒绝且旧文件字节不变', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  expectOk(await store.recordPlan({ platform: 'tieba', at: T0, nextAt: T0 + HOUR }));
  const before = await fs.readFile(rig.filePath, 'utf8');
  expectRejected(
    await store.recordPlan({ platform: 'tieba', at: T0 - 1, nextAt: T0 + 2 * HOUR }),
    'clock-rollback',
  );
  assert.equal(await fs.readFile(rig.filePath, 'utf8'), before);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.platforms.tieba.nextAt, T0 + HOUR);
  assert.equal(snapshot.platforms.tieba.planCount, 1);
  await rig.closeAll();
});

test('task-53 recordPlan persist-failed：注入落盘失败带 causeCode，内存与旧文件均不变', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  expectOk(await store.recordPlan({ platform: 'tieba', at: T0, nextAt: T0 + HOUR }));
  const before = await fs.readFile(rig.filePath, 'utf8');
  await rig.closeAll();
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  const failing = rig.createRaw({ fsOps: { writeFileExclusive: async () => { throw denied; } } });
  await failing.load();
  const result = expectRejected(
    await failing.recordPlan({ platform: 'tieba', at: T0 + 1, nextAt: T0 + 2 * HOUR }),
    'persist-failed',
  );
  assert.equal(result.causeCode, 'EACCES');
  const snapshot = await failing.snapshot();
  assert.equal(snapshot.lastSeenAt, T0);
  assert.equal(snapshot.platforms.tieba.nextAt, T0 + HOUR);
  assert.equal(snapshot.platforms.tieba.planCount, 1);
  assert.equal(await fs.readFile(rig.filePath, 'utf8'), before);
  await failing.close();
});

test('task-53 recordPlan 两平台交错：互不影响、planCount 各自递增、lastSeenAt 单调', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  const first = expectOk(await store.recordPlan({ platform: 'tieba', at: T0, nextAt: T0 + HOUR }));
  assert.equal(first.at, T0);
  assert.equal(first.nextAt, T0 + HOUR);
  expectOk(await store.recordPlan({ platform: 'xiaoheihe', at: T0 + MINUTE, nextAt: T0 + 2 * HOUR }));
  const snapshot = await store.snapshot();
  assert.equal(snapshot.lastSeenAt, T0 + MINUTE);
  assert.equal(snapshot.platforms.tieba.nextAt, T0 + HOUR);
  assert.equal(snapshot.platforms.tieba.planCount, 1);
  assert.equal(snapshot.platforms.xiaoheihe.nextAt, T0 + 2 * HOUR);
  assert.equal(snapshot.platforms.xiaoheihe.planCount, 1);
  // 再登记 tieba 不得覆盖 xiaoheihe 的机会或计数。
  expectOk(await store.recordPlan({ platform: 'tieba', at: T0 + 2 * MINUTE, nextAt: T0 + 3 * HOUR }));
  const after = await store.snapshot();
  assert.equal(after.platforms.tieba.planCount, 2);
  assert.equal(after.platforms.xiaoheihe.planCount, 1);
  assert.equal(after.platforms.xiaoheihe.nextAt, T0 + 2 * HOUR);
  assert.equal(after.lastSeenAt, T0 + 2 * MINUTE);
  await rig.closeAll();
});

test('task-53 recordPlan 过期不补：previousNextAt<=at 只记 lastExpiredAt，不回填旧机会', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  expectOk(await store.recordPlan({ platform: 'tieba', at: T0, nextAt: T0 + HOUR }));
  const later = T0 + 3 * HOUR;
  rig.setNow(later);
  const recorded = expectOk(await store.recordPlan({ platform: 'tieba', at: later, nextAt: later + HOUR }));
  assert.equal(recorded.at, later);
  assert.equal(recorded.nextAt, later + HOUR);
  assert.equal(recorded.planCount, 2);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.platforms.tieba.nextAt, later + HOUR);
  assert.equal(snapshot.platforms.tieba.lastExpiredAt, later, '过期机会必须记为过期而不是执行');
  assert.equal(snapshot.platforms.tieba.planCount, 2);
  await rig.closeAll();
});

test('task-53 recordPlan 重启恢复：close→open 后逐字段不漂移，generation 递增后仍可登记', async () => {
  const rig = await makeRig();
  let store = await rig.open();
  expectOk(await store.recordPlan({ platform: 'tieba', at: T0, nextAt: T0 + HOUR }));
  const first = await store.snapshot();
  await rig.closeAll();
  store = await rig.open();
  assert.deepEqual(await store.snapshot(), first, '重启后 nextAt/lastSeenAt 不得漂移');
  const gate = expectOk(await store.advanceGeneration({ at: T0 + MINUTE }));
  assert.equal(gate.generation, 1);
  expectOk(await store.recordPlan({ platform: 'tieba', at: T0 + 2 * MINUTE, nextAt: T0 + 2 * HOUR }));
  const after = await store.snapshot();
  assert.equal(after.generation, 1);
  assert.equal(after.lastSeenAt, T0 + 2 * MINUTE);
  assert.equal(after.platforms.tieba.nextAt, T0 + 2 * HOUR);
  assert.equal(after.platforms.tieba.planCount, 2);
  await rig.closeAll();
  store = await rig.open();
  assert.deepEqual(await store.snapshot(), after, '二次重启仍须一致');
  await rig.closeAll();
});

test('task-53 recordPlan 不改变 state schema / SCHEDULE_VERSION（不新增 limit 类持久字段）', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  expectOk(await store.recordPlan({ platform: 'xiaoheihe', at: T0, nextAt: T0 + 2 * HOUR }));
  const raw = JSON.parse(await fs.readFile(rig.filePath, 'utf8'));
  assert.equal(raw.schemaVersion, BACKGROUND_PATROL_SCHEDULE_VERSION);
  assert.deepEqual(Object.keys(raw).sort(), ['generation', 'lastSeenAt', 'platforms', 'schemaVersion']);
  const platformKeys = [
    'lastExpiredAt', 'lastRunAt', 'lastRunGeneration',
    'lastSkipAt', 'lastSkipGeneration', 'lastSkipReason', 'nextAt', 'planCount',
  ];
  for (const platform of SCHEDULE_PLATFORMS) {
    assert.deepEqual(Object.keys(raw.platforms[platform]).sort(), platformKeys, `${platform} 字段集不得变化`);
  }
  await rig.closeAll();
});

function expectCode(fn, code, label = '') {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code, `${label} 期望 code ${code}，实际 ${error?.code}（${error?.message}）`);
    return true;
  });
}

function expectOk(result, label = '') {
  assert.equal(result?.ok, true, `${label} 期望 ok:true，实际 ${JSON.stringify(result)}`);
  return result;
}

function expectRejected(result, reason, label = '') {
  assert.equal(result?.ok, false, `${label} 期望 ok:false，实际 ${JSON.stringify(result)}`);
  assert.equal(result?.reason, reason, `${label} 期望 reason:${reason}，实际 ${JSON.stringify(result)}`);
  return result;
}

test('exports: version, platform list and interval/window semantics align with existing scheduler', () => {
  assert.equal(BACKGROUND_PATROL_SCHEDULE_VERSION, 1);
  assert.deepEqual([...SCHEDULE_PLATFORMS], ['tieba', 'xiaoheihe']);
  // 与现有 scheduler 对齐（不改它）：区间表与 07:00–23:00 窗口逐项一致。
  assert.deepEqual(BACKGROUND_PATROL_INTERVALS, PATROL_INTERVALS);
  for (const hour of [0, 6, 7, 12, 22, 23]) {
    const at = Date.UTC(2026, 0, 15, hour - 8, 0, 0); // 北京时间整点
    assert.equal(isBackgroundPatrolActiveTime(at), isPatrolActiveTime(at), `hour=${hour} 的窗口判定必须一致`);
  }
  assert.equal(isBackgroundPatrolActiveTime(Date.UTC(2026, 0, 14, 22, 59, 59, 999)), false); // 06:59:59.999
  assert.equal(isBackgroundPatrolActiveTime(Date.UTC(2026, 0, 14, 23, 0, 0, 0)), true); // 07:00
  assert.equal(isBackgroundPatrolActiveTime(Date.UTC(2026, 0, 15, 14, 59, 59, 999)), true); // 22:59:59.999
  assert.equal(isBackgroundPatrolActiveTime(Date.UTC(2026, 0, 15, 15, 0, 0, 0)), false); // 23:00
  assert.equal(typeof planNextOpportunity, 'function');
  assert.equal(typeof classifyPersistedOpportunity, 'function');
  assert.equal(typeof parseScheduleState, 'function');
  assert.equal(typeof createBackgroundPatrolScheduleStore, 'function');
});

test('planNextOpportunity: uniform delay inside [min,max] with injectable random (scheduler-compatible)', () => {
  const tieba = PATROL_INTERVALS.tieba;
  assert.equal(planNextOpportunity({ platform: 'tieba', now: T0, random: () => 0 }).delayMs, tieba.minMs);
  assert.equal(planNextOpportunity({ platform: 'tieba', now: T0, random: () => 1 }).delayMs, tieba.maxMs);
  const mid = planNextOpportunity({ platform: 'tieba', now: T0, random: () => 0.5 });
  expectOk(mid);
  assert.equal(mid.delayMs, tieba.minMs + Math.floor(0.5 * (tieba.maxMs - tieba.minMs)));
  assert.equal(mid.at, T0 + mid.delayMs);
  // 与 scheduler 一样夹紧越界随机值（非有限/<0 → 0，>1 → 1）。
  assert.equal(planNextOpportunity({ platform: 'tieba', now: T0, random: () => Number.NaN }).delayMs, tieba.minMs);
  assert.equal(planNextOpportunity({ platform: 'tieba', now: T0, random: () => -5 }).delayMs, tieba.minMs);
  assert.equal(planNextOpportunity({ platform: 'tieba', now: T0, random: () => 9 }).delayMs, tieba.maxMs);
  // 非法输入拒绝。
  expectRejected(planNextOpportunity({ platform: 'weibo', now: T0, random: () => 0 }), 'invalid-platform');
  expectRejected(planNextOpportunity({ platform: 'tieba', now: 'now', random: () => 0 }), 'invalid-time');
  expectRejected(planNextOpportunity({ platform: 'tieba', now: T0, random: 'x' }), 'invalid-random');
});

test('planNextOpportunity: platforms are independent and cross-day opportunities are allowed (window checked at fire time)', () => {
  const tieba = planNextOpportunity({ platform: 'tieba', now: T0, random: () => 0.25 });
  const xiaoheihe = planNextOpportunity({ platform: 'xiaoheihe', now: T0, random: () => 0.25 });
  expectOk(tieba);
  expectOk(xiaoheihe);
  const t = BACKGROUND_PATROL_INTERVALS.tieba;
  const x = BACKGROUND_PATROL_INTERVALS.xiaoheihe;
  assert.equal(tieba.at, T0 + t.minMs + Math.floor(0.25 * (t.maxMs - t.minMs)));
  assert.equal(xiaoheihe.at, T0 + x.minMs + Math.floor(0.25 * (x.maxMs - x.minMs)));
  assert.notEqual(tieba.at, xiaoheihe.at);

  // 23:30 规划：机会落在次日（不在规划时把时间夹到早窗口；现有 scheduler 在触发时判定窗口）。
  const lateNight = Date.UTC(2026, 0, 15, 15, 30, 0); // 23:30 北京
  const crossDay = planNextOpportunity({ platform: 'tieba', now: lateNight, random: () => 0.5 });
  expectOk(crossDay);
  assert.ok(crossDay.at > lateNight, '机会必须晚于当前时刻');
  assert.ok(crossDay.at > Date.UTC(2026, 0, 15, 16, 0, 0), '23:30 规划的 1~2 小时机会应落到次日');
});

test('classifyPersistedOpportunity: expired opportunities are never treated as due/queued', () => {
  assert.equal(classifyPersistedOpportunity({ nextAt: null, now: T0 }), 'none');
  assert.equal(classifyPersistedOpportunity({ nextAt: T0 + 1, now: T0 }), 'future');
  assert.equal(classifyPersistedOpportunity({ nextAt: T0 - 1, now: T0 }), 'expired');
  assert.equal(classifyPersistedOpportunity({ nextAt: T0, now: T0 }), 'expired');
  expectRejected(classifyPersistedOpportunity({ nextAt: 'x', now: T0 }), 'invalid-time');
  expectRejected(classifyPersistedOpportunity({ nextAt: T0, now: Number.NaN }), 'invalid-time');
});

test('store: load ENOENT -> ready with generation 0 and empty platforms; snapshot is a deep copy', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  const snapshot = await store.snapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generation, 0);
  for (const platform of SCHEDULE_PLATFORMS) {
    assert.equal(snapshot.platforms[platform].nextAt, null);
    assert.equal(snapshot.platforms[platform].planCount, 0);
  }
  snapshot.platforms.tieba.nextAt = 123;
  const again = await store.snapshot();
  assert.equal(again.platforms.tieba.nextAt, null, 'snapshot 必须是深拷贝');
  await rig.closeAll();
});

test('store: planNext persists nextAt and planCount; survives restart', async () => {
  const rig = await makeRig();
  const first = await rig.open();
  const planned = expectOk(await first.planNext({ platform: 'tieba', random: () => 0.25 }));
  assert.equal(planned.expired, false);
  const snapshot = await first.snapshot();
  assert.equal(snapshot.platforms.tieba.nextAt, planned.at);
  assert.equal(snapshot.platforms.tieba.planCount, 1);
  await first.close();

  const second = await rig.open();
  const restored = await second.snapshot();
  assert.equal(restored.platforms.tieba.nextAt, planned.at, '重启后 nextAt 不得丢失');
  assert.equal(restored.platforms.tieba.planCount, 1);
  // 其它平台不受影响（跨平台独立）。
  assert.equal(restored.platforms.xiaoheihe.nextAt, null);
  await rig.closeAll();
});

test('store: expired nextAt is re-planned from now and recorded, never executed/backfilled', async () => {
  const rig = await makeRig();
  const first = await rig.open();
  const planned = expectOk(await first.planNext({ platform: 'tieba', random: () => 0 }));
  await first.close();

  // 把持久文件改成「nextAt 已过期」的合法状态（模拟长时间停机）。
  const raw = JSON.parse(await fs.readFile(rig.filePath, 'utf8'));
  raw.platforms.tieba.nextAt = T0 - 10 * MINUTE;
  raw.lastSeenAt = T0;
  await fs.writeFile(rig.filePath, JSON.stringify(raw), 'utf8');

  rig.setNow(T0);
  const second = await rig.open();
  const before = await second.snapshot();
  assert.equal(before.platforms.tieba.nextAt, T0 - 10 * MINUTE, '过期状态应如实加载');
  assert.equal(classifyPersistedOpportunity({ nextAt: before.platforms.tieba.nextAt, now: T0 }), 'expired');

  const replanned = expectOk(await second.planNext({ platform: 'tieba', random: () => 0 }));
  assert.equal(replanned.expired, true, '过期机会必须被标记为 expired');
  assert.ok(replanned.at > T0, '必须从 now 重新规划，不得把过期时间当 due 执行');
  assert.equal(replanned.at, T0 + BACKGROUND_PATROL_INTERVALS.tieba.minMs);
  const after = await second.snapshot();
  assert.equal(after.platforms.tieba.nextAt, replanned.at);
  assert.equal(after.platforms.tieba.lastExpiredAt, T0, '过期事件必须被记录（不补队列）');
  assert.equal(after.platforms.tieba.planCount, 2);
  await rig.closeAll();
  assert.equal(planned.at > T0, true);
});

test('store: concurrent planNext calls are serialized (no lost increments)', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  const [a, b] = await Promise.all([
    store.planNext({ platform: 'tieba', random: () => 0 }),
    store.planNext({ platform: 'tieba', random: () => 0.5 }),
  ]);
  expectOk(a);
  expectOk(b);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.platforms.tieba.planCount, 2);
  assert.equal(snapshot.platforms.tieba.nextAt, b.at, '串行执行后最后落入的状态必须是第二次规划');
  assert.ok([a.at, b.at].includes(snapshot.platforms.tieba.nextAt));
  await rig.closeAll();
});

test('store: atomic write uses randomUUID temp + rename + directory sync (0600 on POSIX)', async () => {
  const rig = await makeRig();
  const tempPaths = [];
  const renamed = [];
  let synced = 0;
  const store = await rig.open({
    fsOps: {
      writeFileExclusive: async (target, payload) => {
        tempPaths.push(target);
        const handle = await fs.open(target, 'wx', 0o600);
        try {
          await handle.writeFile(payload, 'utf8');
        } finally {
          await handle.close();
        }
      },
      rename: async (from, to) => {
        renamed.push({ from, to });
        await fs.rename(from, to);
      },
      syncDirectory: async () => {
        synced += 1;
      },
    },
  });
  expectOk(await store.planNext({ platform: 'tieba', random: () => 0 }));
  assert.equal(tempPaths.length, 1);
  assert.match(path.basename(tempPaths[0]), /^schedule\.json\.[0-9a-f-]{36}\.tmp$/, '临时名必须是 randomUUID');
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].to, rig.filePath);
  assert.ok(synced >= 1, 'rename 后必须 best-effort 同步目录');
  if (process.platform !== 'win32') {
    const stat = await fs.stat(rig.filePath);
    assert.equal(stat.mode & 0o777, 0o600, '账本文件权限应为 0600');
  }
  await rig.closeAll();
});

test('store: persist failure (rename EACCES) keeps old file unchanged and returns persist-failed', async () => {
  const rig = await makeRig();
  const first = await rig.open();
  expectOk(await first.planNext({ platform: 'tieba', random: () => 0 }));
  await first.close();
  const before = await fs.readFile(rig.filePath, 'utf8');

  const broken = await rig.open({ fsOps: { rename: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } } });
  const result = await broken.planNext({ platform: 'tieba', random: () => 0.5 });
  expectRejected(result, 'persist-failed', 'rename 失败');
  assert.equal(await fs.readFile(rig.filePath, 'utf8'), before, '失败时旧文件字节不得变化');
  const snapshot = await broken.snapshot();
  assert.equal(snapshot.platforms.tieba.planCount, 1, '失败时内存也不得提交');
  await broken.close();
});

test('store: bad state files are fail-closed (STATE_INVALID/LOAD_FAILED) and bytes are preserved', async () => {
  const rig = await makeRig();
  const valid = await rig.open();
  expectOk(await valid.planNext({ platform: 'tieba', random: () => 0 }));
  const validText = await fs.readFile(rig.filePath, 'utf8');
  await valid.close();
  const validState = JSON.parse(validText);

  const variants = [
    ['空文件', ''],
    ['坏 JSON', '{'],
    ['根是数组', '[]'],
    ['未知版本', JSON.stringify({ ...validState, schemaVersion: 999 })],
    ['未知字段', JSON.stringify({ ...validState, extra: 1 })],
    ['generation 为负', JSON.stringify({ ...validState, generation: -1 })],
    ['generation 非整数', JSON.stringify({ ...validState, generation: 1.5 })],
    ['lastSeenAt 非法', JSON.stringify({ ...validState, lastSeenAt: 'now' })],
    ['缺少平台', JSON.stringify({ ...validState, platforms: { tieba: validState.platforms.tieba } })],
    ['nextAt 非法', JSON.stringify({ ...validState, platforms: { ...validState.platforms, tieba: { ...validState.platforms.tieba, nextAt: 'later' } } })],
    ['planCount 为负', JSON.stringify({ ...validState, platforms: { ...validState.platforms, tieba: { ...validState.platforms.tieba, planCount: -1 } } })],
    ['lastRunAt 晚于 lastSeenAt', JSON.stringify({ ...validState, platforms: { ...validState.platforms, tieba: { ...validState.platforms.tieba, lastRunAt: validState.lastSeenAt + 1, lastRunGeneration: 0 } } })],
    ['skip 原因与时间矛盾', JSON.stringify({ ...validState, platforms: { ...validState.platforms, tieba: { ...validState.platforms.tieba, lastSkipAt: null, lastSkipReason: 'qq-busy', lastSkipGeneration: 0 } } })],
    ['代次计数大于 generation', JSON.stringify({ ...validState, generation: 1, platforms: { ...validState.platforms, tieba: { ...validState.platforms.tieba, lastRunAt: validState.lastSeenAt, lastRunGeneration: 5 } } })],
  ];
  for (const [label, text] of variants) {
    await fs.writeFile(rig.filePath, text, 'utf8');
    const store = rig.createRaw();
    await assert.rejects(() => store.load(), (error) => {
      assert.equal(error?.code, ERR.LOAD_FAILED, `${label} 期望 LOAD_FAILED，实际 ${error?.code}`);
      return true;
    }, label);
    assert.equal(await fs.readFile(rig.filePath, 'utf8'), text, `${label}：拒绝加载时必须保留原字节`);
    await store.close();
  }
  // 纯解析函数单独校验 code。
  expectCode(() => parseScheduleState('{'), ERR.STATE_INVALID, 'parse 坏 JSON');
  expectCode(() => parseScheduleState({}), ERR.STATE_INVALID, 'parse 空对象');
  assert.equal(parseScheduleState(validText).generation, validState.generation);
});

test('store: single instance per filePath; close releases; load requires load()', async () => {
  const rig = await makeRig();
  const first = await rig.open();
  expectCode(() => rig.createRaw(), ERR.SINGLETON_CONFLICT, '同路径第二实例');
  await first.close();

  // 未 load 就调用 -> NOT_LOADED（致命契约，不返回 ok:false）。
  const neverLoaded = rig.createRaw();
  await assert.rejects(() => neverLoaded.planNext({ platform: 'tieba' }), (error) => {
    assert.equal(error?.code, 'BACKGROUND_PATROL_SCHEDULE_NOT_LOADED');
    return true;
  });
  await neverLoaded.close();

  const second = await rig.open();
  await second.close();
});

test('store: markOpportunity persists lastRun/lastSkip; generation idempotent and monotonic', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  const gen1 = expectOk(await store.advanceGeneration({ at: T0 }));
  assert.equal(gen1.generation, 1);

  expectOk(await store.markOpportunity({ platform: 'tieba', generation: 1, kind: 'run', at: T0 + 1000 }));
  expectOk(await store.markOpportunity({
    platform: 'tieba', generation: 1, kind: 'skip', at: T0 + 2000, reason: 'qq-busy',
  }));
  const after = await store.snapshot();
  assert.equal(after.platforms.tieba.lastRunAt, T0 + 1000);
  assert.equal(after.platforms.tieba.lastSkipAt, T0 + 2000);
  assert.equal(after.platforms.tieba.lastSkipReason, 'qq-busy');

  // 同代次重复 run：幂等，不覆盖首次时间/不重复落盘语义。
  const duplicate = expectOk(await store.markOpportunity({
    platform: 'tieba', generation: 1, kind: 'run', at: T0 + 5000,
  }));
  assert.equal(duplicate.duplicate, true);
  assert.equal((await store.snapshot()).platforms.tieba.lastRunAt, T0 + 1000, '同代次幂等：首次记录保留');

  // 代次递增后，旧回调必须失效（不可重入）。
  const gen2 = expectOk(await store.advanceGeneration({ at: T0 + 10_000 }));
  assert.equal(gen2.generation, 2);
  expectRejected(
    await store.markOpportunity({ platform: 'tieba', generation: 1, kind: 'run', at: T0 + 11_000 }),
    'stale-generation',
    '旧代次回调',
  );
  expectRejected(
    await store.markOpportunity({ platform: 'tieba', generation: 3, kind: 'run', at: T0 + 12_000 }),
    'unknown-generation',
    '未来代次',
  );
  expectOk(await store.markOpportunity({ platform: 'tieba', generation: 2, kind: 'run', at: T0 + 13_000 }));
  assert.equal((await store.snapshot()).platforms.tieba.lastRunAt, T0 + 13_000);
  await store.close();

  // 重启后 lastRun/lastSkip 与 generation 都还在。
  const reopened = await rig.open();
  const restored = await reopened.snapshot();
  assert.equal(restored.generation, 2);
  assert.equal(restored.platforms.tieba.lastRunAt, T0 + 13_000);
  assert.equal(restored.platforms.tieba.lastSkipAt, T0 + 2000);
  assert.equal(restored.platforms.tieba.lastSkipReason, 'qq-busy');
  await rig.closeAll();
});

test('store: clock rollback rejected for planNext/markOpportunity/advanceGeneration without state change', async () => {
  const rig = await makeRig(T0 + HOUR);
  const store = await rig.open();
  const before = await store.snapshot();
  const beforeText = await store.serialize();
  rig.setNow(T0);
  expectRejected(await store.planNext({ platform: 'tieba', random: () => 0 }), 'clock-rollback', 'planNext 回拨');
  expectRejected(
    await store.markOpportunity({ platform: 'tieba', generation: 0, kind: 'run', at: T0 }),
    'clock-rollback',
    'markOpportunity 回拨',
  );
  expectRejected(await store.advanceGeneration({ at: T0 }), 'clock-rollback', 'advanceGeneration 回拨');
  assert.deepEqual(await store.snapshot(), before, '拒绝时状态不得变化');
  assert.equal(await store.serialize(), beforeText);
  await rig.closeAll();
});

test('store: markOpportunity input validation (platform/kind/generation/reason)', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  expectRejected(await store.markOpportunity({ platform: 'weibo', generation: 0, kind: 'run' }), 'invalid-platform');
  expectRejected(await store.markOpportunity({ platform: 'tieba', generation: 0, kind: 'explode' }), 'invalid-kind');
  expectRejected(await store.markOpportunity({ platform: 'tieba', generation: -1, kind: 'run' }), 'invalid-generation');
  expectRejected(await store.markOpportunity({ platform: 'tieba', generation: 0, kind: 'skip' }), 'invalid-reason');
  expectRejected(
    await store.markOpportunity({ platform: 'tieba', generation: 0, kind: 'skip', reason: 'x'.repeat(300) }),
    'invalid-reason',
  );
  // 合法 skip 原因落盘。
  expectOk(await store.markOpportunity({ platform: 'tieba', generation: 0, kind: 'skip', at: T0 + 1, reason: 'paused' }));
  assert.equal((await store.snapshot()).platforms.tieba.lastSkipReason, 'paused');
  await rig.closeAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// task-38（task-36 复核 low findings）：load 错误码 / persist causeCode /
// request.random 契约 / markOpportunity 判断顺序 / scheduler 随机夹紧差分。
// 以下测试在修复前应失败（或固定契约）。
// ─────────────────────────────────────────────────────────────────────────────

test('F1 load：非 ENOENT 读失败抛带 code=LOAD_FAILED 的错误（不再是无 code 的普通 Error）', async () => {
  const rig = await makeRig();
  const store = rig.createRaw({
    fsOps: {
      readFile: async () => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      },
    },
  });
  await assert.rejects(() => store.load(), (error) => {
    assert.equal(error?.code, ERR.LOAD_FAILED, `期望 LOAD_FAILED，实际 ${error?.code}`);
    assert.match(String(error.message), /读取失败/);
    return true;
  });
  // failed 之后所有操作沿用同一 coded 错误（不再偶发无 code）。
  await assert.rejects(() => store.load(), (error) => error?.code === ERR.LOAD_FAILED);
  await assert.rejects(() => store.snapshot(), (error) => error?.code === ERR.LOAD_FAILED);
  await store.close();
});

test('F1 load：注入 clock 抛错或返回 NaN 时（缺文件路径）抛 LOAD_FAILED', async () => {
  for (const label of ['throws', 'nan']) {
    const rig = await makeRig();
    const clock = label === 'throws'
      ? () => { throw new Error('clock exploded'); }
      : () => Number.NaN;
    const store = rig.createRaw({ clock });
    await assert.rejects(() => store.load(), (error) => {
      assert.equal(error?.code, ERR.LOAD_FAILED, `${label} 期望 LOAD_FAILED，实际 ${error?.code}`);
      return true;
    }, label);
    await store.close();
  }
});

test('F5 persist-failed 携带 causeCode（rename EACCES / writeFileExclusive ENOSPC）', async () => {
  // rename 失败 → EACCES
  {
    const rig = await makeRig();
    const store = rig.createRaw({ fsOps: { rename: async () => { const error = new Error('simulated'); error.code = 'EACCES'; throw error; } } });
    await store.load();
    const result = await store.planNext({ platform: 'tieba', random: () => 0 });
    expectRejected(result, 'persist-failed');
    assert.equal(result.causeCode, 'EACCES', 'persist-failed 必须带 causeCode');
    assert.equal((await store.snapshot()).platforms.tieba.planCount, 0, '失败时内存不得提交');
    await store.close();
  }
  // 临时文件写入失败 → ENOSPC（advanceGeneration 路径同样带 causeCode）
  {
    const rig = await makeRig();
    const store = rig.createRaw({ fsOps: { writeFileExclusive: async () => { const error = new Error('no space'); error.code = 'ENOSPC'; throw error; } } });
    await store.load();
    const result = await store.advanceGeneration({ at: T0 });
    expectRejected(result, 'persist-failed');
    assert.equal(result.causeCode, 'ENOSPC');
    assert.equal((await store.snapshot()).generation, 0, '失败时代次不得推进');
    await store.close();
  }
});

test('F6 planNext：非函数 request.random 明确拒绝 invalid-random 且状态不变', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  const before = await store.serialize();
  for (const random of ['x', 42, null, {}]) {
    expectRejected(await store.planNext({ platform: 'tieba', random }), 'invalid-random', `random=${JSON.stringify(random)}`);
  }
  assert.equal(await store.serialize(), before, '非法 random 不得改变状态');
  await rig.closeAll();
  // 省略 random 时仍使用构造注入的随机源（0.5 → 区间中点取整）。
  const rig2 = await makeRig(T0, { random: () => 0.5 });
  const withRandom = await rig2.open();
  const planned = expectOk(await withRandom.planNext({ platform: 'tieba' }));
  const { minMs, maxMs } = PATROL_INTERVALS.tieba;
  assert.equal(planned.delayMs, minMs + Math.floor(0.5 * (maxMs - minMs)));
  await rig2.closeAll();
});

test('F7 markOpportunity：时间回拨优先于代次（顺序稳定），合法时间下才报 stale/unknown', async () => {
  const rig = await makeRig();
  const store = await rig.open();
  expectOk(await store.advanceGeneration({ at: T0 })); // generation 1
  const before = await store.serialize();

  // 回拨 + 旧代次同时出现 → 固定返回 clock-rollback（时间不可信优先 fail-closed）。
  expectRejected(
    await store.markOpportunity({ platform: 'tieba', generation: 0, kind: 'run', at: T0 - 1 }),
    'clock-rollback',
    '回拨优先于 stale',
  );
  assert.equal(await store.serialize(), before, '被拒绝时状态不得变化');

  // 时间合法时：旧代次 → stale-generation；未来代次 → unknown-generation；当前代次 → ok。
  expectRejected(
    await store.markOpportunity({ platform: 'tieba', generation: 0, kind: 'run', at: T0 + 1 }),
    'stale-generation',
  );
  expectRejected(
    await store.markOpportunity({ platform: 'tieba', generation: 2, kind: 'run', at: T0 + 2 }),
    'unknown-generation',
  );
  expectOk(await store.markOpportunity({ platform: 'tieba', generation: 1, kind: 'run', at: T0 + 3 }));
  await rig.closeAll();
});

test('F4 差分：随机夹紧/取整与现有 scheduler 逐输入一致（不修改 scheduler）', () => {
  const ratios = [0, 0.25, 0.5, 0.75, 0.9999999, 1, -5, 9, Number.NaN];
  for (const ratio of ratios) {
    const delays = [];
    const scheduler = createBackgroundPatrolScheduler({
      clock: {
        now: () => T0,
        setTimeout: (callback, delay) => {
          delays.push(delay);
          return { callback, delay };
        },
        clearTimeout: () => {},
      },
      random: () => ratio,
      getAvailability: () => ({ qqBusy: false, dshAvailable: true, paused: false, modeAllowed: true }),
      run: () => {},
    });
    scheduler.start();
    scheduler.stop();
    assert.equal(delays.length, 2, 'scheduler 应各平台各排一次');
    for (const [index, platform] of SCHEDULE_PLATFORMS.entries()) {
      const planned = planNextOpportunity({ platform, now: T0, random: () => ratio });
      expectOk(planned);
      assert.equal(planned.delayMs, delays[index], `ratio=${String(ratio)} platform=${platform} 必须与 scheduler 一致`);
      const { minMs, maxMs } = PATROL_INTERVALS[platform];
      assert.ok(planned.delayMs >= minMs && planned.delayMs <= maxMs, '必须落在区间内');
    }
  }
});

