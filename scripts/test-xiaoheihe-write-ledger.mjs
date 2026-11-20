import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  createXhhWriteLedger,
  beijingXhhDayKey,
} from '../src/core/xiaoheihe-write-ledger.mjs';

const execFileAsync = promisify(execFile);

/**
 * 错误码契约：本测试按字符串断言（契约的一部分），实现必须导出同名常量。
 * · NOT_LOADED / LOAD_FAILED / FAILED / CLOSED / OWNED / DEGRADED 属于致命路径，必须 throw；
 * · invalid-id / invalid-bucket / duplicate / daily-cap / min-interval / write-paused /
 *   clock-rollback / persist-failed 属于业务拒绝，返回 { ok:false, reason }。
 */
const ERR = Object.freeze({
  NOT_LOADED: 'XHH_WRITE_LEDGER_NOT_LOADED',
  LOAD_FAILED: 'XHH_WRITE_LEDGER_LOAD_FAILED',
  FAILED: 'XHH_WRITE_LEDGER_FAILED',
  CLOSED: 'XHH_WRITE_LEDGER_CLOSED',
  OWNED: 'XHH_WRITE_LEDGER_OWNED',
  DEGRADED: 'XHH_WRITE_LEDGER_DEGRADED',
});

// 全部测试使用模拟时钟与 mkdtemp 临时账本文件，不触达真实平台、真实凭据或生产文件。
// 跨进程用例只会 spawn 一个立即退出的 Node 子进程去争抢锁文件，不启动任何服务。

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BEIJING_OFFSET = 8 * HOUR;

// 2026-01-15 09:00（北京时间）
const T0 = Date.UTC(2026, 0, 15, 1, 0, 0);

const bjDayIndex = (ms) => Math.floor((ms + BEIJING_OFFSET) / DAY);
const bjDayStart = (index) => index * DAY - BEIJING_OFFSET;
const bjTimeAt = (ms, hour) => bjDayStart(bjDayIndex(ms)) + hour * HOUR;
const nextBjMorning = (ms) => bjDayStart(bjDayIndex(ms) + 1) + 9 * HOUR;

const tempDirs = [];
const activeRigs = [];

after(async () => {
  for (const rig of activeRigs) await rig.closeAll();
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * 测试夹具：模拟时钟 + 临时目录 + 所有权生命周期。
 * `newLedger()` 会先 close 当前实例再新建，用来模拟「重启」；
 * 想构造「并存实例」时用 `createRaw()`（不 load、不 close 旧的）。
 */
async function makeRig(startMs, { ledgerOptions = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-write-ledger-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'ledger.json');
  let now = startMs;
  const clock = () => now;
  const created = [];
  let active = null;

  const rig = {
    dir,
    filePath,
    lockPath: `${filePath}.lock`,
    clock,
    ledgerOptions,
    setNow(ms) {
      now = ms;
    },
    now() {
      return now;
    },
    createRaw(options = {}) {
      return createXhhWriteLedger({ filePath, clock, ...ledgerOptions, ...options });
    },
    async newLedger(options = {}) {
      if (active !== null) {
        const previous = active;
        active = null;
        await previous.close().catch(() => {});
      }
      const ledger = rig.createRaw(options);
      await ledger.load();
      active = ledger;
      created.push(ledger);
      return ledger;
    },
    async closeAll() {
      active = null;
      for (const ledger of created.reverse()) {
        try {
          await ledger.close();
        } catch {
          // 已关闭 / 从未加载的实例忽略
        }
      }
    },
  };
  activeRigs.push(rig);
  return rig;
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

function expectThrowCode(promiseFactory, code, label = '') {
  return assert.rejects(promiseFactory, (error) => {
    assert.equal(
      error?.code,
      code,
      `${label} 期望错误码 ${code}，实际 ${error?.code}（${error?.message}）`,
    );
    return true;
  });
}

async function readLedgerState(rig) {
  return JSON.parse(await fs.readFile(rig.filePath, 'utf8'));
}

/** 找一个当前不存在的进程号，用来伪造 stale 锁。 */
function findDeadPid() {
  for (let pid = 999_983; pid > 1_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return pid;
    }
  }
  throw new Error('找不到可用的死进程号');
}

test('begin：首次返回 ok:true，同一 id 并发与重复只发放一次许可', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  const results = await Promise.all([
    ledger.begin({ id: 'op-dup', bucket: 'post' }),
    ledger.begin({ id: 'op-dup', bucket: 'post' }),
    ledger.begin({ id: 'op-dup', bucket: 'post' }),
  ]);
  assert.equal(results.filter((item) => item?.ok === true).length, 1, '同一 id 只应有一次获准');
  assert.equal(results.filter((item) => item?.ok === false && item.reason === 'duplicate').length, 2, '其余应返回 duplicate');
  expectRejected(await ledger.begin({ id: 'op-dup', bucket: 'post' }), 'duplicate', 'pending 后重复 begin');
});

test('begin：已 success / failure 结束的 id 不再发放', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'done-success', bucket: 'post' }), 'begin success 笔');
  expectOk(await ledger.finish({ id: 'done-success', outcome: 'success' }), 'finish success 笔');
  expectRejected(await ledger.begin({ id: 'done-success', bucket: 'post' }), 'duplicate', 'success 后重复 begin');

  rig.setNow(T0 + 3 * HOUR);
  expectOk(await ledger.begin({ id: 'done-failure', bucket: 'post' }), 'begin failure 笔');
  expectOk(await ledger.finish({ id: 'done-failure', outcome: 'failure' }), 'finish failure 笔');
  expectRejected(await ledger.begin({ id: 'done-failure', bucket: 'post' }), 'duplicate', 'failure 后重复 begin');
});

test('begin：拒绝无效 id 与 bucket，且不消耗当日配额', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  for (const badId of ['', null, undefined]) {
    const result = await ledger.begin({ id: badId, bucket: 'post' });
    assert.equal(result?.ok, false, '无效 id 应被拒绝');
  }
  for (const badBucket of ['reply', 'POST', '', null, undefined]) {
    const result = await ledger.begin({ id: `invalid-bucket-${String(badBucket)}`, bucket: badBucket });
    assert.equal(result?.ok, false, '无效 bucket 应被拒绝');
  }
  expectOk(await ledger.begin({ id: 'after-invalid', bucket: 'post' }), '拒绝无效请求后正常 begin');
});

test('begin：许可后立即把 pending 与限额一起落盘', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'persisted-pending', bucket: 'post' }), '首次 begin');
  const stat = await fs.stat(rig.filePath);
  assert.ok(stat.size > 0, 'begin 返回后账本文件应已写入');
  const raw = await fs.readFile(rig.filePath, 'utf8');
  assert.ok(raw.trim().length > 0, '账本文件内容不应为空');

  const reopened = await rig.newLedger();
  expectRejected(await reopened.begin({ id: 'persisted-pending', bucket: 'post' }), 'duplicate', '重启后 pending 不重发');
  rig.setNow(T0 + 3 * HOUR);
  expectOk(await reopened.begin({ id: 'after-pending', bucket: 'post' }), '重启后第二笔 post');
});

test('begin：并发不同桶互不阻塞，同桶同一时刻只放一笔', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  const parallel = await Promise.all([
    ledger.begin({ id: 'par-post', bucket: 'post' }),
    ledger.begin({ id: 'par-comment', bucket: 'comment' }),
  ]);
  expectOk(parallel[0], '并发 post');
  expectOk(parallel[1], '并发 comment');

  rig.setNow(T0 + 3 * MINUTE);
  const race = await Promise.all([
    ledger.begin({ id: 'race-comment-a', bucket: 'comment' }),
    ledger.begin({ id: 'race-comment-b', bucket: 'comment' }),
  ]);
  assert.equal(race.filter((item) => item?.ok === true).length, 1, '同一时刻同桶只应放行一笔');
  assert.equal(race.filter((item) => item?.ok === false && item.reason === 'min-interval').length, 1, '其余一笔应为 min-interval');
});

test('post：每北京时间日 2 次、相邻至少 3 小时，次日重置', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'post-1', bucket: 'post' }), '首笔 post');
  expectOk(await ledger.finish({ id: 'post-1', outcome: 'success' }));

  rig.setNow(T0 + 3 * HOUR - 1);
  expectRejected(await ledger.begin({ id: 'post-2-early', bucket: 'post' }), 'min-interval', '只过 2 小时 59 分 59.999 秒');

  rig.setNow(T0 + 3 * HOUR);
  expectOk(await ledger.begin({ id: 'post-2', bucket: 'post' }), '恰好满 3 小时');
  expectOk(await ledger.finish({ id: 'post-2', outcome: 'success' }));

  rig.setNow(T0 + 6 * HOUR);
  expectRejected(await ledger.begin({ id: 'post-3', bucket: 'post' }), 'daily-cap', '当日第 3 笔 post');

  rig.setNow(nextBjMorning(T0));
  expectOk(await ledger.begin({ id: 'post-next-day', bucket: 'post' }), '次日配额重置');
});

test('post：跨北京时间日仍受 3 小时间隔约束', async () => {
  const lateNight = bjTimeAt(T0, 23);
  const rig = await makeRig(lateNight);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'cross-1', bucket: 'post' }), '23:00 首笔');
  expectOk(await ledger.finish({ id: 'cross-1', outcome: 'success' }));

  rig.setNow(lateNight + 1.5 * HOUR);
  expectRejected(await ledger.begin({ id: 'cross-2', bucket: 'post' }), 'min-interval', '次日 00:30 仍不足 3 小时');

  rig.setNow(lateNight + 3 * HOUR);
  expectOk(await ledger.begin({ id: 'cross-3', bucket: 'post' }), '次日 02:00 已满 3 小时');
});

test('comment：每北京时间日 12 次、相邻至少 3 分钟，次日重置', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'comment-1', bucket: 'comment' }), '首笔 comment');
  expectOk(await ledger.finish({ id: 'comment-1', outcome: 'success' }));

  rig.setNow(T0 + 3 * MINUTE - 1);
  expectRejected(await ledger.begin({ id: 'comment-2-early', bucket: 'comment' }), 'min-interval', '只过 2 分 59.999 秒');

  rig.setNow(T0 + 3 * MINUTE);
  expectOk(await ledger.begin({ id: 'comment-2', bucket: 'comment' }), '恰好满 3 分钟');
  expectOk(await ledger.finish({ id: 'comment-2', outcome: 'success' }));

  for (let i = 3; i <= 12; i += 1) {
    rig.setNow(T0 + (i - 1) * 3 * MINUTE);
    expectOk(await ledger.begin({ id: `comment-${i}`, bucket: 'comment' }), `第 ${i} 笔 comment`);
    expectOk(await ledger.finish({ id: `comment-${i}`, outcome: 'success' }), `finish 第 ${i} 笔`);
  }

  rig.setNow(T0 + 12 * 3 * MINUTE);
  expectRejected(await ledger.begin({ id: 'comment-13', bucket: 'comment' }), 'daily-cap', '当日第 13 笔 comment');

  rig.setNow(nextBjMorning(T0));
  expectOk(await ledger.begin({ id: 'comment-next-day', bucket: 'comment' }), '次日配额重置');
});

test('finish：幂等，并发重复 finish 只生效一次', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'finish-1', bucket: 'post' }));
  const [first, second] = await Promise.all([
    ledger.finish({ id: 'finish-1', outcome: 'success' }),
    ledger.finish({ id: 'finish-1', outcome: 'success' }),
  ]);
  assert.equal([first, second].filter((item) => item?.ok === true).length, 1, '并发 finish 只应生效一次');
  assert.equal([first, second].filter((item) => item?.ok === false && item.reason === 'already-finished').length, 1, '其余应为 already-finished');
  expectRejected(await ledger.finish({ id: 'finish-1', outcome: 'failure' }), 'already-finished', '已结束后换 outcome 再 finish');
  expectRejected(await ledger.begin({ id: 'finish-1', bucket: 'post' }), 'duplicate', '已结束后再 begin');
});

test('unknown：持久保留、不重发，重启后仍为 duplicate', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'unknown-persist', bucket: 'post' }));
  expectOk(await ledger.finish({ id: 'unknown-persist', outcome: 'unknown' }));
  expectRejected(await ledger.finish({ id: 'unknown-persist', outcome: 'unknown' }), 'already-finished', '重复 finish unknown');
  expectRejected(await ledger.begin({ id: 'unknown-persist', bucket: 'post' }), 'duplicate', 'unknown 后重发');

  const reopened = await rig.newLedger();
  expectRejected(await reopened.begin({ id: 'unknown-persist', bucket: 'post' }), 'duplicate', '重启后 unknown 仍不重发');
});

test('unknown：既不清零也不累计连续 failure', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  for (let i = 0; i < 2; i += 1) {
    rig.setNow(T0 + i * 3 * MINUTE);
    expectOk(await ledger.begin({ id: `unknown-failure-${i}`, bucket: 'comment' }));
    expectOk(await ledger.finish({ id: `unknown-failure-${i}`, outcome: 'failure' }));
  }

  rig.setNow(T0 + 6 * MINUTE);
  expectOk(await ledger.begin({ id: 'unknown-middle', bucket: 'comment' }));
  expectOk(await ledger.finish({ id: 'unknown-middle', outcome: 'unknown' }));

  rig.setNow(T0 + 9 * MINUTE);
  expectOk(await ledger.begin({ id: 'unknown-third-failure', bucket: 'comment' }), 'unknown 不累计：第三次 failure 仍可 begin');
  expectOk(await ledger.finish({ id: 'unknown-third-failure', outcome: 'failure' }));

  rig.setNow(T0 + 12 * MINUTE);
  expectRejected(await ledger.begin({ id: 'unknown-after-pause', bucket: 'comment' }), 'write-paused', 'unknown 不清零：前后 failure 构成连续三次');
});

test('failure：连续三次进入当天写暂停并持久化，次日解除', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  for (let i = 0; i < 3; i += 1) {
    rig.setNow(T0 + i * 3 * MINUTE);
    expectOk(await ledger.begin({ id: `pause-failure-${i}`, bucket: 'comment' }), `第 ${i + 1} 次 begin`);
    expectOk(await ledger.finish({ id: `pause-failure-${i}`, outcome: 'failure' }), `第 ${i + 1} 次 failure`);
  }

  rig.setNow(T0 + 12 * MINUTE);
  expectRejected(await ledger.begin({ id: 'pause-blocked', bucket: 'comment' }), 'write-paused', '连续三次 failure 后写暂停');

  const reopened = await rig.newLedger();
  expectRejected(await reopened.begin({ id: 'pause-blocked-restart', bucket: 'comment' }), 'write-paused', '重启后写暂停仍持久');

  rig.setNow(T0 + 8 * HOUR);
  expectRejected(await reopened.begin({ id: 'pause-later-today', bucket: 'comment' }), 'write-paused', '当天稍后仍暂停');

  rig.setNow(nextBjMorning(T0));
  expectOk(await reopened.begin({ id: 'pause-next-day', bucket: 'comment' }), '次日解除写暂停');
});

test('success：清除连续失败计数', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  for (let i = 0; i < 2; i += 1) {
    rig.setNow(T0 + i * 3 * MINUTE);
    expectOk(await ledger.begin({ id: `reset-failure-${i}`, bucket: 'comment' }));
    expectOk(await ledger.finish({ id: `reset-failure-${i}`, outcome: 'failure' }));
  }

  rig.setNow(T0 + 6 * MINUTE);
  expectOk(await ledger.begin({ id: 'reset-success', bucket: 'comment' }));
  expectOk(await ledger.finish({ id: 'reset-success', outcome: 'success' }));

  for (let i = 0; i < 2; i += 1) {
    rig.setNow(T0 + (9 + i * 3) * MINUTE);
    expectOk(await ledger.begin({ id: `reset-failure-after-${i}`, bucket: 'comment' }));
    expectOk(await ledger.finish({ id: `reset-failure-after-${i}`, outcome: 'failure' }));
  }

  rig.setNow(T0 + 15 * MINUTE);
  expectOk(await ledger.begin({ id: 'reset-allowed', bucket: 'comment' }), 'success 之后两次连续 failure 不应暂停');
});

test('重启：pending、已用配额与日计数从文件恢复', async () => {
  const rig = await makeRig(T0);
  const first = await rig.newLedger();
  expectOk(await first.begin({ id: 'restart-pending', bucket: 'post' }), '重启前 pending');

  const second = await rig.newLedger();
  expectRejected(await second.begin({ id: 'restart-pending', bucket: 'post' }), 'duplicate', '重启后 pending 不重发');

  rig.setNow(T0 + 3 * HOUR);
  expectOk(await second.begin({ id: 'restart-second', bucket: 'post' }), '重启后第二笔 post');
  expectOk(await second.finish({ id: 'restart-second', outcome: 'success' }));

  rig.setNow(T0 + 6 * HOUR);
  const third = await rig.newLedger();
  expectRejected(await third.begin({ id: 'restart-third', bucket: 'post' }), 'daily-cap', '重启后当日配额仍为 2');
});

test('时钟回退：不得绕过最小间隔，恢复后正常发放', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'rollback-1', bucket: 'post' }));
  expectOk(await ledger.finish({ id: 'rollback-1', outcome: 'success' }));

  rig.setNow(T0 - HOUR);
  const rolledBack = await ledger.begin({ id: 'rollback-2', bucket: 'post' });
  assert.equal(rolledBack?.ok, false, '时钟回退到上次许可之前不得放宽最小间隔');

  rig.setNow(T0 + 3 * HOUR);
  expectOk(await ledger.begin({ id: 'rollback-3', bucket: 'post' }), '时钟恢复后正常发放');
});

test('snapshot：返回可 JSON 序列化的对象', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'snapshot-1', bucket: 'post' }));
  const snapshot = await ledger.snapshot();
  assert.equal(typeof snapshot, 'object');
  assert.notEqual(snapshot, null);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test('结果回执遇到时钟回退时拒绝写入，时钟恢复后仍可完成', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'finish-clock-rollback', bucket: 'post' }));
  rig.setNow(T0 - 1);
  expectRejected(await ledger.finish({ id: 'finish-clock-rollback', outcome: 'failure' }), 'clock-rollback');
  rig.setNow(T0 + 1);
  expectOk(await ledger.finish({ id: 'finish-clock-rollback', outcome: 'failure' }));
});

test('账本计数与已记录操作矛盾时拒绝加载并保留原文件', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'inconsistent-counter', bucket: 'post' }));
  const state = JSON.parse(await fs.readFile(rig.filePath, 'utf8'));
  state.buckets.post.count = 0;
  const corrupted = JSON.stringify(state);
  await fs.writeFile(rig.filePath, corrupted);
  await assert.rejects(() => rig.newLedger());
  assert.equal(await fs.readFile(rig.filePath, 'utf8'), corrupted);
});

// ─────────────────────────────────────────────────────────────────────────────
// 审计加固回归（2026-10-25）：所有权 / 临时文件 / 迟到结果 / 不变量 /
// 持久化失败 / 父目录 / ID 规范化 / 记录上限 / 错误契约
// 每一条都对应 stage6b-ledger-review.response.json 里可复现的 finding。
// ─────────────────────────────────────────────────────────────────────────────

test('所有权：同进程同 filePath 的第二实例不得加载，close 后可重新加载并看到前实例状态', async () => {
  const rig = await makeRig(T0);
  const first = await rig.newLedger();
  expectOk(await first.begin({ id: 'owner-post-a', bucket: 'post' }), '首实例 begin');

  const second = rig.createRaw();
  await expectThrowCode(() => second.load(), ERR.OWNED, '第二实例 load 必须被所有权拒绝');
  await second.close();

  // 陈旧覆盖场景：旧实例已经落盘的内容不能被第二个实例用旧快照覆盖。
  await first.close();
  const third = await rig.newLedger();
  expectRejected(await third.begin({ id: 'owner-post-a', bucket: 'post' }), 'duplicate', '重新加载后仍去重');
  rig.setNow(T0 + 3 * HOUR);
  expectOk(await third.begin({ id: 'owner-post-b', bucket: 'post' }), '新实例继续写');
  const state = await readLedgerState(rig);
  assert.ok(state.operations['owner-post-a'], '旧实例写入的记录不得被覆盖丢失');
  assert.ok(state.operations['owner-post-b'], '新实例写入的记录必须落盘');
});

test('所有权：跨进程独占锁阻止第二个进程加载，释放后另一进程可接管', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'cross-process-a', bucket: 'post' }));

  const moduleUrl = new URL('../src/core/xiaoheihe-write-ledger.mjs', import.meta.url).href;
  const scriptPath = path.join(rig.dir, 'child-load.mjs');
  await fs.writeFile(
    scriptPath,
    [
      `import { createXhhWriteLedger } from ${JSON.stringify(moduleUrl)};`,
      `const ledger = createXhhWriteLedger({ filePath: ${JSON.stringify(rig.filePath)}, clock: () => ${T0} });`,
      'try {',
      '  await ledger.load();',
      '  await ledger.close();',
      '  console.log(JSON.stringify({ ok: true }));',
      '} catch (error) {',
      '  console.log(JSON.stringify({ ok: false, code: error?.code ?? null }));',
      '}',
    ].join('\n'),
  );

  const locked = await execFileAsync(process.execPath, [scriptPath], { timeout: 30_000, cwd: rig.dir });
  const lockedResult = JSON.parse(locked.stdout.trim().split('\n').at(-1));
  assert.equal(lockedResult.ok, false, '第二个进程不应获得所有权');
  assert.equal(lockedResult.code, ERR.OWNED, '第二个进程应以 OWNED 失败');

  await ledger.close();
  const free = await execFileAsync(process.execPath, [scriptPath], { timeout: 30_000, cwd: rig.dir });
  const freeResult = JSON.parse(free.stdout.trim().split('\n').at(-1));
  assert.equal(freeResult.ok, true, '释放锁后另一进程应可加载');
});

test('stale 锁：占有者进程已死时自动接管，close 后锁文件被移除', async () => {
  const rig = await makeRig(T0);
  const deadPid = findDeadPid();
  await fs.writeFile(
    rig.lockPath,
    JSON.stringify({ pid: deadPid, token: 'stale-token', createdAt: T0 }),
    'utf8',
  );

  const ledger = await rig.newLedger();
  const lock = JSON.parse(await fs.readFile(rig.lockPath, 'utf8'));
  assert.equal(lock.pid, process.pid, '接管后锁应归本进程所有');
  expectOk(await ledger.begin({ id: 'stale-takeover', bucket: 'post' }));
  await ledger.close();
  await assert.rejects(() => fs.stat(rig.lockPath), (error) => error?.code === 'ENOENT', 'close 后应删除锁文件');
});

test('临时文件：randomUUID 命名且 rename 失败不覆盖旧账本、清理残留并进入 degraded', async () => {
  const rig = await makeRig(T0);
  const first = await rig.newLedger();
  expectOk(await first.begin({ id: 'before-rename-failure', bucket: 'post' }));
  const beforeText = await fs.readFile(rig.filePath, 'utf8');

  const writtenTempPaths = [];
  const fsOps = {
    writeFileExclusive: async (target, data) => {
      writtenTempPaths.push(target);
      const handle = await fs.open(target, 'wx', 0o600);
      try {
        await handle.writeFile(data, 'utf8');
      } finally {
        await handle.close();
      }
    },
    rename: async () => {
      throw Object.assign(new Error('模拟 rename EACCES'), { code: 'EACCES' });
    },
  };

  const second = await rig.newLedger({ fsOps });
  expectRejected(await second.begin({ id: 'rename-failure', bucket: 'comment' }), 'persist-failed', 'rename 失败');
  assert.equal(await fs.readFile(rig.filePath, 'utf8'), beforeText, '失败时旧账本字节不得被覆盖');
  assert.equal(writtenTempPaths.length, 1, '应只写一次临时文件');
  assert.match(
    path.basename(writtenTempPaths[0]),
    /^ledger\.json\.[0-9a-f-]{36}\.tmp$/,
    '临时文件名必须带 randomUUID，不能是 PID+实例序号',
  );
  const leftover = (await fs.readdir(rig.dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftover, [], '失败后必须清理临时文件');
  const snapshot = await second.snapshot();
  assert.equal(snapshot.operations['rename-failure'], undefined, '未提交的预留不得出现在内存快照');
  await expectThrowCode(() => second.begin({ id: 'after-rename-failure', bucket: 'comment' }), ERR.DEGRADED, 'degraded 后拒绝后续写');
});

test('持久化失败：ENOSPC 进入 degraded，后续 begin/finish 抛 DEGRADED 而不是放行', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger({
    fsOps: {
      writeFileExclusive: async () => {
        throw Object.assign(new Error('模拟 ENOSPC'), { code: 'ENOSPC' });
      },
    },
  });
  expectRejected(await ledger.begin({ id: 'enospc-1', bucket: 'post' }), 'persist-failed', 'ENOSPC 写盘失败');
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.operations['enospc-1'], undefined, '写盘失败时不得提交内存状态');
  await expectThrowCode(() => ledger.begin({ id: 'enospc-2', bucket: 'post' }), ERR.DEGRADED);
  await expectThrowCode(() => ledger.finish({ id: 'enospc-1', outcome: 'failure' }), ERR.DEGRADED);
});

test('第三次 failure 落盘失败不得放宽暂停：degraded 拒绝后续写且旧账本不变', async () => {
  const rig = await makeRig(T0);
  const first = await rig.newLedger();
  for (let i = 0; i < 2; i += 1) {
    rig.setNow(T0 + i * 3 * MINUTE);
    expectOk(await first.begin({ id: `pre-failure-${i}`, bucket: 'comment' }));
    expectOk(await first.finish({ id: `pre-failure-${i}`, outcome: 'failure' }));
  }

  let renameCalls = 0;
  const failing = await rig.newLedger({
    fsOps: {
      rename: async (from, to) => {
        renameCalls += 1;
        if (renameCalls >= 2) throw Object.assign(new Error('模拟第三次 rename EPERM'), { code: 'EPERM' });
        await fs.rename(from, to);
      },
    },
  });
  rig.setNow(T0 + 6 * MINUTE);
  expectOk(await failing.begin({ id: 'third-failure', bucket: 'comment' }), '第三次 failure 的 begin 仍可落盘');
  const afterBegin = await fs.readFile(rig.filePath, 'utf8');
  expectRejected(await failing.finish({ id: 'third-failure', outcome: 'failure' }), 'persist-failed', '第三次 failure 的 finish 写盘失败');
  assert.equal(await fs.readFile(rig.filePath, 'utf8'), afterBegin, '失败时旧账本不得被覆盖');
  await expectThrowCode(() => failing.begin({ id: 'after-third-failure', bucket: 'comment' }), ERR.DEGRADED, '存储故障不得放宽写权限');
});

test('父目录缺失：load 可 ready，persist 前自动 mkdir 且能写入', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-write-ledger-mkdir-'));
  tempDirs.push(base);
  const filePath = path.join(base, 'nested', 'deeper', 'ledger.json');
  let now = T0;
  const ledger = createXhhWriteLedger({ filePath, clock: () => now });
  try {
    await ledger.load();
    expectOk(await ledger.begin({ id: 'mkdir-1', bucket: 'post' }));
    const stat = await fs.stat(filePath);
    assert.ok(stat.size > 0, '父目录应被自动创建并写入账本');
  } finally {
    await ledger.close();
  }
});

test('跨字段不变量：矛盾状态一律 fail-closed 且保留原文件字节', async () => {
  const rig = await makeRig(T0);
  const base = await (async () => {
    const ledger = await rig.newLedger();
    expectOk(await ledger.begin({ id: 'inv-post', bucket: 'post' }));
    expectOk(await ledger.finish({ id: 'inv-post', outcome: 'success' }));
    rig.setNow(T0 + 3 * HOUR);
    expectOk(await ledger.begin({ id: 'inv-pending', bucket: 'post' }));
    await ledger.close();
    return readLedgerState(rig);
  })();

  const variants = [
    ['pausedDay 为未来日期', (state) => { state.pausedDay = '2099-01-01'; }],
    ['pausedDay 为更早日期', (state) => { state.pausedDay = beijingXhhDayKey(state.lastSeenAt - DAY); }],
    ['连续失败链达到 3 但 pausedDay 为 null', (state) => { state.consecutiveFailures = 3; state.pausedDay = null; }],
    ['pausedDay 非空但连续失败链达到 3', (state) => { state.pausedDay = state.day; state.consecutiveFailures = 3; }],
    ['finishedAt 早于 startedAt', (state) => { state.operations['inv-post'].finishedAt = state.operations['inv-post'].startedAt - 1; }],
    ['startedAt 晚于 lastSeenAt', (state) => { state.operations['inv-post'].startedAt = state.lastSeenAt + 1; }],
    ['lastSeenAt 早于当天北京零点', (state) => {
      state.lastSeenAt = Date.parse(`${state.day}T00:00:00.000Z`) - BEIJING_OFFSET - 1;
    }],
    ['bucket.lastActionAt 晚于 lastSeenAt', (state) => { state.buckets.post.lastActionAt = state.lastSeenAt + 1; }],
    ['count 小于当天已记录操作数', (state) => { state.buckets.post.count = 0; }],
    ['late 标记与日键不一致', (state) => { state.operations['inv-post'].late = true; }],
    ['操作 id 未规范化（首尾空白）', (state) => {
      state.operations[' padded-id '] = { ...state.operations['inv-post'] };
    }],
    ['连续失败链为负数', (state) => { state.consecutiveFailures = -1; }],
    ['schemaVersion 未知', (state) => { state.schemaVersion = 999; }],
    ['pausedDay 类型非法', (state) => { state.pausedDay = 123; }],
    ['pending 条目带 finishedAt', (state) => { state.operations['inv-pending'].finishedAt = state.operations['inv-pending'].startedAt; }],
    ['bucket.count 不是整数', (state) => { state.buckets.comment.count = 1.5; }],
    ['lastSeenAt 不是有限时间戳', (state) => { state.lastSeenAt = 'yesterday'; }],
  ];

  for (const [label, mutate] of variants) {
    const state = structuredClone(base);
    mutate(state);
    const text = JSON.stringify(state);
    await fs.writeFile(rig.filePath, text, 'utf8');
    const ledger = rig.createRaw();
    await expectThrowCode(() => ledger.load(), ERR.LOAD_FAILED, label);
    assert.equal(await fs.readFile(rig.filePath, 'utf8'), text, `${label}：拒绝加载时必须保留原字节`);
    await ledger.close();
  }
});

test('坏文件：空文件 / 坏 JSON / 根不是对象 / 未知版本一律 fail-closed 并保留原字节', async () => {
  const cases = [
    ['空文件', ''],
    ['坏 JSON', '{"schemaVersion":'],
    ['根是数组', '[]'],
    ['根是字符串', '"ledger"'],
    [
      '未知 schemaVersion',
      JSON.stringify({
        schemaVersion: 999,
        day: '2026-01-15',
        lastSeenAt: T0,
        buckets: { post: { count: 0, lastActionAt: null }, comment: { count: 0, lastActionAt: null } },
        operations: {},
        consecutiveFailures: 0,
        pausedDay: null,
      }),
    ],
  ];
  for (const [label, text] of cases) {
    const rig = await makeRig(T0);
    await fs.writeFile(rig.filePath, text, 'utf8');
    const ledger = rig.createRaw();
    await expectThrowCode(() => ledger.load(), ERR.LOAD_FAILED, label);
    assert.equal(await fs.readFile(rig.filePath, 'utf8'), text, `${label}：拒绝加载时必须保留原字节`);
    await ledger.close();
  }
});

test('迟到 success：不得清除新日失败链，也不得先推进日键再记旧结果', async () => {
  // day1 21:00 留一个 pending；day2 先累计 2 次 failure，再把 day1 的 pending finish 为 success。
  const day1 = bjTimeAt(T0, 21);
  const rig = await makeRig(day1);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'late-day1-pending', bucket: 'comment' }), 'day1 的 pending');

  const day2 = nextBjMorning(day1);
  for (let i = 0; i < 2; i += 1) {
    rig.setNow(day2 + i * 3 * MINUTE);
    expectOk(await ledger.begin({ id: `day2-failure-${i}`, bucket: 'comment' }));
    expectOk(await ledger.finish({ id: `day2-failure-${i}`, outcome: 'failure' }));
  }

  rig.setNow(day2 + 10 * MINUTE);
  expectOk(await ledger.finish({ id: 'late-day1-pending', outcome: 'success' }), 'day1 的 success 迟到到 day2');
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.consecutiveFailures, 2, '迟到 success 不得清除当天失败链');
  assert.equal(snapshot.pausedDay, null, '迟到 success 不得解除/制造暂停');
  assert.equal(snapshot.operations['late-day1-pending'].status, 'success');
  assert.equal(snapshot.operations['late-day1-pending'].late, true, '跨日结果必须标记 late');

  // 当天第三次 failure 仍应正常触发暂停（说明失败链没被迟到 success 清掉）。
  rig.setNow(day2 + 13 * MINUTE);
  expectOk(await ledger.begin({ id: 'day2-failure-2', bucket: 'comment' }));
  expectOk(await ledger.finish({ id: 'day2-failure-2', outcome: 'failure' }));
  const paused = await ledger.snapshot();
  assert.equal(paused.pausedDay, beijingXhhDayKey(day2), '当天第三次 failure 应触发当天暂停');

  const reopened = await rig.newLedger();
  expectRejected(await reopened.begin({ id: 'after-late-success', bucket: 'comment' }), 'write-paused', '重启后当天暂停仍生效');
});

test('迟到 failure：不得累加新日失败链，也不得先推进日键', async () => {
  // day1 21:00/21:03/21:06 三个 pending 全部在 day2 才 finish 为 failure。
  const day1 = bjTimeAt(T0, 21);
  const rig = await makeRig(day1);
  const ledger = await rig.newLedger();
  for (let i = 0; i < 3; i += 1) {
    rig.setNow(day1 + i * 3 * MINUTE);
    expectOk(await ledger.begin({ id: `late-failure-${i}`, bucket: 'comment' }), `day1 pending ${i}`);
  }

  const day2 = nextBjMorning(day1);
  rig.setNow(day2);
  for (let i = 0; i < 3; i += 1) {
    expectOk(await ledger.finish({ id: `late-failure-${i}`, outcome: 'failure' }), `day2 迟到 failure ${i}`);
  }
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.day, beijingXhhDayKey(day1), 'finish 不得把日键推进到新日');
  assert.equal(snapshot.consecutiveFailures, 0, '迟到 failure 不得累加到新日失败链');
  assert.equal(snapshot.pausedDay, null, '迟到 failure 不得在新日触发暂停');
  for (let i = 0; i < 3; i += 1) {
    assert.equal(snapshot.operations[`late-failure-${i}`].late, true, `late ${i} 必须标记`);
  }

  // 新日第一次 begin 才推进日键并清空日计数；此时不应被昨日迟到 failure 暂停。
  expectOk(await ledger.begin({ id: 'day2-first-write', bucket: 'comment' }), '新日不应被迟到 failure 暂停');
  const afterBegin = await ledger.snapshot();
  assert.equal(afterBegin.day, beijingXhhDayKey(day2));
  assert.equal(afterBegin.pausedDay, null);
});

test('late finish 后重启：日键落后于 lastSeenAt 的合法状态必须可加载', async () => {
  const day1 = bjTimeAt(T0, 21);
  const rig = await makeRig(day1);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'late-reload-pending', bucket: 'comment' }));
  rig.setNow(nextBjMorning(day1));
  expectOk(await ledger.finish({ id: 'late-reload-pending', outcome: 'success' }));

  const reopened = await rig.newLedger();
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.day, beijingXhhDayKey(day1), '日键保持操作开始日');
  assert.equal(snapshot.operations['late-reload-pending'].late, true);
  expectOk(await reopened.begin({ id: 'next-day-after-late', bucket: 'comment' }), '新日写入正常');
});

test('ID 规范化：首尾空白/超长/控制字符拒绝，NFC 等价形式视为同一操作', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  for (const [label, id] of [
    ['首尾空白', '  padded  '],
    ['仅空白', '   '],
    ['超长', 'x'.repeat(201)],
    ['控制字符', 'id\u0001with-control'],
    ['非字符串', 42],
  ]) {
    expectRejected(await ledger.begin({ id, bucket: 'comment' }), 'invalid-id', label);
  }

  const nfc = 'caf\u00e9'; // é (NFC)
  const nfd = 'cafe\u0301'; // e + 组合重音符（NFD）
  expectOk(await ledger.begin({ id: nfc, bucket: 'comment' }), 'NFC id');
  expectRejected(await ledger.begin({ id: nfd, bucket: 'comment' }), 'duplicate', 'NFD 等价 id 必须视为同一操作');
});

test('lookup：按规范化 id 查询 pending/已结束记录，未知 id 返回 null', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'lookup-pending', bucket: 'post' }));
  const pending = await ledger.lookup('lookup-pending');
  assert.equal(pending?.found, true);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.bucket, 'post');
  assert.equal(pending.finishedAt, null);

  expectOk(await ledger.finish({ id: 'lookup-pending', outcome: 'success' }));
  const finished = await ledger.lookup('lookup-pending');
  assert.equal(finished.status, 'success');
  assert.equal(finished.late, false);

  assert.equal(await ledger.lookup('lookup-missing'), null, '未知 id 返回 null');
  assert.equal(await ledger.lookup('  lookup-pending  '), null, '非法 id 返回 null');
});

test('记录上限：保留全部 pending + 最近 N 条 finished，且额度计数不受裁剪影响', async () => {
  const rig = await makeRig(T0, { ledgerOptions: { maxFinishedOperations: 3 } });
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'limit-pending', bucket: 'post' }), 'pending 必须永久保留');

  for (let i = 0; i < 6; i += 1) {
    rig.setNow(T0 + (i + 1) * 3 * MINUTE + i);
    expectOk(await ledger.begin({ id: `limit-finished-${i}`, bucket: 'comment' }));
    expectOk(await ledger.finish({ id: `limit-finished-${i}`, outcome: 'success' }));
  }

  const snapshot = await ledger.snapshot();
  const ids = Object.keys(snapshot.operations).sort();
  assert.ok(ids.includes('limit-pending'), 'pending 记录不得被裁剪');
  assert.equal(ids.filter((id) => id.startsWith('limit-finished-')).length, 3, 'finished 只保留最近 3 条');
  assert.ok(ids.includes('limit-finished-5'), '保留最近的 finished');
  assert.ok(!ids.includes('limit-finished-0'), '最旧的 finished 应被裁剪');
  assert.equal(snapshot.buckets.comment.count, 6, '裁剪记录不得改变当天额度计数');
});

test('权限：账本与锁文件为 0600（POSIX）', { skip: process.platform === 'win32' }, async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'mode-1', bucket: 'post' }));
  for (const target of [rig.filePath, rig.lockPath]) {
    const stat = await fs.stat(target);
    assert.equal(stat.mode & 0o777, 0o600, `${target} 权限应为 0600`);
  }
});

test('错误契约：not-loaded / failed / closed 抛带 code 异常，业务拒绝才返回 ok:false', async () => {
  const rig = await makeRig(T0);

  const fresh = rig.createRaw();
  await expectThrowCode(() => fresh.begin({ id: 'fresh-begin', bucket: 'post' }), ERR.NOT_LOADED, '未 load 的 begin');
  await expectThrowCode(() => fresh.finish({ id: 'fresh-begin', outcome: 'success' }), ERR.NOT_LOADED, '未 load 的 finish');
  await expectThrowCode(() => fresh.snapshot(), ERR.NOT_LOADED, '未 load 的 snapshot');
  await fresh.close();

  const ledger = await rig.newLedger();
  expectRejected(await ledger.begin({ id: 'business-reject', bucket: 'reply' }), 'invalid-bucket', '业务拒绝仍是 ok:false');
  await ledger.close();
  await expectThrowCode(() => ledger.begin({ id: 'after-close', bucket: 'post' }), ERR.CLOSED, 'close 后的 begin');

  // 坏文件 -> failed 状态：load / begin / snapshot 都必须抛 LOAD_FAILED / FAILED，不得静默返回 ok:false。
  const brokenRig = await makeRig(T0);
  await fs.writeFile(brokenRig.filePath, '{', 'utf8');
  const broken = brokenRig.createRaw();
  await expectThrowCode(() => broken.load(), ERR.LOAD_FAILED, '坏文件 load');
  await expectThrowCode(() => broken.begin({ id: 'broken-begin', bucket: 'post' }), ERR.FAILED, 'failed 状态的 begin');
  await expectThrowCode(() => broken.snapshot(), ERR.FAILED, 'failed 状态的 snapshot');
  await broken.close();
});

test('北京时间零点边界：跨日只在真正落盘的写请求上推进日键并重置计数', async () => {
  const dayStart = bjDayStart(bjDayIndex(T0));
  const beforeMidnight = dayStart + DAY - 1; // 23:59:59.999
  const rig = await makeRig(beforeMidnight);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'midnight-before', bucket: 'comment' }), '零点前 1ms');
  expectOk(await ledger.finish({ id: 'midnight-before', outcome: 'success' }));

  rig.setNow(dayStart + DAY); // 00:00:00.000 整
  expectRejected(await ledger.begin({ id: 'midnight-exact', bucket: 'comment' }), 'min-interval', '零点整仍受跨日最小间隔约束');
  rig.setNow(dayStart + DAY + 3 * MINUTE);
  expectOk(await ledger.begin({ id: 'midnight-after', bucket: 'comment' }), '零点后满 3 分钟');

  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.day, beijingXhhDayKey(dayStart + DAY), '跨日写入后日键应为新的一天');
  assert.equal(snapshot.buckets.comment.count, 1, '新日计数应重置后只记 1 笔');
});

test('snapshot：是深拷贝，修改返回值不得影响内部状态', async () => {
  const rig = await makeRig(T0);
  const ledger = await rig.newLedger();
  expectOk(await ledger.begin({ id: 'deep-copy-1', bucket: 'post' }));

  const first = await ledger.snapshot();
  first.operations['deep-copy-1'].status = 'failure';
  first.operations['injected'] = { bucket: 'post', status: 'pending', startedAt: T0, finishedAt: null, late: false };
  first.buckets.post.count = 0;
  first.pausedDay = '1999-01-01';

  const second = await ledger.snapshot();
  assert.equal(second.operations['deep-copy-1'].status, 'pending', '修改快照不得改变内部操作状态');
  assert.equal(second.operations['injected'], undefined, '修改快照不得注入内部操作');
  assert.equal(second.buckets.post.count, 1, '修改快照不得改变额度计数');
  assert.equal(second.pausedDay, null, '修改快照不得改变暂停状态');
  expectOk(await ledger.begin({ id: 'deep-copy-2', bucket: 'comment' }), '深拷贝后仍可继续写入');
});

// ─────────────────────────────────────────────────────────────────────────────
// task-13（task-9 审查阻断项）：F1 并发 load 双 owner / F2 close 误删他人锁 /
// F5 OWNED 终态契约。均为回归测试：修复前必须失败。
// ─────────────────────────────────────────────────────────────────────────────

test('F1 并发 load（默认 fsOps）：同进程两个实例同时 load 只能有一个 owner', async () => {
  for (let round = 0; round < 6; round += 1) {
    const rig = await makeRig(T0);
    const first = rig.createRaw();
    const second = rig.createRaw();
    const settled = await Promise.allSettled([first.load(), second.load()]);
    const fulfilled = settled.filter((item) => item.status === 'fulfilled').length;
    const ownedRejected = settled.filter(
      (item) => item.status === 'rejected' && item.reason?.code === ERR.OWNED,
    ).length;
    await first.close().catch(() => {});
    await second.close().catch(() => {});
    assert.equal(fulfilled, 1, `round ${round}：并发 load 只应有一个 owner，实际 ${fulfilled} 个`);
    assert.equal(ownedRejected, 1, `round ${round}：另一个必须因 OWNED 失败，实际 ${ownedRejected} 个`);
  }
});

test('F1 并发 load（慢 mkdir 注入）：跨 await 交错下也只允许一个 owner', async () => {
  const slowMkdir = async (directory) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.mkdir(directory, { recursive: true });
  };
  for (let round = 0; round < 6; round += 1) {
    const rig = await makeRig(T0);
    const first = rig.createRaw({ fsOps: { mkdir: slowMkdir } });
    const second = rig.createRaw({ fsOps: { mkdir: slowMkdir } });
    const settled = await Promise.allSettled([first.load(), second.load()]);
    const fulfilled = settled.filter((item) => item.status === 'fulfilled').length;
    await first.close().catch(() => {});
    await second.close().catch(() => {});
    assert.equal(fulfilled, 1, `round ${round}：慢 mkdir 交错时也只应有一个 owner，实际 ${fulfilled} 个`);
  }
});

test('F1 复现：两实例争同一账本时同日 post 最多授权 2 笔（不是 4 笔）', async () => {
  const rig = await makeRig(T0);
  const a = rig.createRaw();
  const b = rig.createRaw();
  const settled = await Promise.allSettled([a.load(), b.load()]);
  const fulfilled = settled.filter((item) => item.status === 'fulfilled').length;
  assert.equal(fulfilled, 1, `并发 load 只应有一个 owner，实际 ${fulfilled} 个`);

  const attempts = [
    ['a', 'post-a1', 0],
    ['b', 'post-b1', 3 * HOUR],
    ['a', 'post-a2', 6 * HOUR],
    ['b', 'post-b2', 9 * HOUR],
  ];
  let granted = 0;
  for (const [which, id, offset] of attempts) {
    rig.setNow(T0 + offset);
    const instance = which === 'a' ? a : b;
    const result = await instance.begin({ id, bucket: 'post' }).catch((error) => ({
      ok: false,
      error: error?.code ?? null,
    }));
    if (result?.ok === true) granted += 1;
  }

  assert.equal(granted, 2, `同日 post 最多授权 2 笔（上限 2），实际 ${granted} 笔`);
  await a.close().catch(() => {});
  await b.close().catch(() => {});
});

test('F5 OWNED 是终态：失败实例重复 load 仍 OWNED，必须 close 后重建', async () => {
  const rig = await makeRig(T0);
  const first = await rig.newLedger();
  expectOk(await first.begin({ id: 'f5-owner-post', bucket: 'post' }));

  const second = rig.createRaw();
  await expectThrowCode(() => second.load(), ERR.OWNED, '第二实例首次 load');
  await expectThrowCode(() => second.load(), ERR.OWNED, 'OWNED 后重复 load 仍是终态 OWNED');
  await second.close();

  // 旧 owner 未 close 前，新建实例同样是 OWNED（终态语义一致）。
  const third = rig.createRaw();
  await expectThrowCode(() => third.load(), ERR.OWNED, '旧 owner 未 close 时重建仍 OWNED');
  await third.close();

  // 必须 close 旧 owner 之后再重建，才能取得所有权并看到旧状态。
  await first.close();
  const rebuilt = await rig.newLedger();
  expectRejected(await rebuilt.begin({ id: 'f5-owner-post', bucket: 'post' }), 'duplicate', '重建后旧 id 仍去重');
  rig.setNow(T0 + 3 * HOUR);
  expectOk(await rebuilt.begin({ id: 'f5-rebuilt-post', bucket: 'post' }), 'close 后重建可正常写');
});

test('F2 close 只删除自己 token 的锁，不得误删另一 owner 的锁', async () => {
  const rig = await makeRig(T0);
  const first = await rig.newLedger();
  expectOk(await first.begin({ id: 'f2-owner-post', bucket: 'post' }));

  // 模拟租约已被另一个活 owner 接管：锁文件内容换成别人的 token。
  const foreignToken = 'foreign-owner-token';
  await fs.writeFile(
    rig.lockPath,
    JSON.stringify({ pid: process.pid, token: foreignToken, createdAt: T0 }),
    'utf8',
  );

  await first.close();
  const lock = JSON.parse(await fs.readFile(rig.lockPath, 'utf8'));
  assert.equal(lock.token, foreignToken, 'close 不得删除不属于自己的锁');
  await fs.unlink(rig.lockPath);
});

