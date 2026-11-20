// Pins Codex ruling 5 (first half): the coordinator facade carries a controlled
// single-holder `claim` / `release`, not an implicit "whoever assembled it first wins".
//
// What this file proves, and what it deliberately does NOT:
//   · It proves the MECHANISM: atomic occupancy, refusal of a second holder, refusal of
//     a repeat claim, token-checked release, clean `dispose()`, and no leaked occupancy
//     on the throwing path.
//   · It does NOT prove production enforcement. Nothing on the production path calls
//     `claim()`; the assembly entry that must mandate it is a separate wiring task. The
//     check was deliberately kept out of `createQzonePluginHandle` (that would change the
//     plugin handshake and break the offline suites without adding security here).
//
// Why a repeat claim by the same token is REJECTED rather than made idempotent:
//   `claim` is meant to be paired with `release` in a `finally`. If a second claim by the
//   same token succeeded, the first `release()` would free the coordinator while the
//   second claimant still believed it held it — the exact overlap this mechanism exists
//   to prevent. Failing loudly turns a lost `release()` into a visible bug.
//
// Offline only: fake client, no network, no QQ calls.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createQzoneConnectionSourceCoordinator } from '../src/core/qzone-connection-source-coordinator-offline.mjs';

class Client extends EventEmitter {
  replies = []; calls = 0; middlewares = [];
  getLoginInfo() { this.calls++; return this.replies.shift()(); }
  ok(id = 123) { this.replies.push(() => Promise.resolve({ user_id: id })); }
  use() { return () => {}; }
}

function make() {
  const client = new Client();
  const coordinator = createQzoneConnectionSourceCoordinator({ client, expectedUserId: 123 });
  return { client, coordinator };
}

test('首个 claim 成功并占住协调器；holder() 如实报告持有人', () => {
  const { coordinator } = make();
  assert.equal(coordinator.holder(), null, '前提：还没人占用');
  assert.deepEqual(coordinator.claim('assembler-A'), { ok: true });
  assert.equal(coordinator.holder(), 'assembler-A');
  coordinator.dispose();
});

test('第二个不同 token 的 claim 必须失败，且不得挤掉先到的持有人', () => {
  const { coordinator } = make();
  assert.deepEqual(coordinator.claim('assembler-A'), { ok: true });
  assert.deepEqual(coordinator.claim('assembler-B'), { ok: false, reason: 'held-by-another-holder' },
    '同一协调器同时只允许一个持有人');
  assert.equal(coordinator.holder(), 'assembler-A', '失败的 claim 不得改写持有人');
  // And the loser's release must not free the winner's claim.
  assert.deepEqual(coordinator.release('assembler-B'), { ok: false, reason: 'held-by-another-holder' },
    'release 必须校验 token，否则任何拿到 facade 的人都能替别人解锁');
  assert.equal(coordinator.holder(), 'assembler-A', '外部 token 的 release 不得生效');
  coordinator.dispose();
});

test('同一 token 重复 claim 被拒（不是幂等成功），reason 与真正的二主争用可区分', () => {
  const { coordinator } = make();
  assert.deepEqual(coordinator.claim('assembler-A'), { ok: true });
  assert.deepEqual(coordinator.claim('assembler-A'), { ok: false, reason: 'already-held-by-same-token' },
    '同 token 再来一次说明有一次 release 丢了；静默成功会让一次 release 打开别人以为还锁着的门');
  assert.deepEqual(coordinator.claim('assembler-B'), { ok: false, reason: 'held-by-another-holder' });
  assert.equal(coordinator.holder(), 'assembler-A');
  coordinator.dispose();
});

test('release 之后可以再次 claim，且换人也能成功', () => {
  const { coordinator } = make();
  assert.deepEqual(coordinator.claim('assembler-A'), { ok: true });
  assert.deepEqual(coordinator.release('assembler-A'), { ok: true });
  assert.equal(coordinator.holder(), null);
  assert.deepEqual(coordinator.claim('assembler-A'), { ok: true }, '同一 token 释放后必须能重新占用');
  assert.deepEqual(coordinator.release('assembler-A'), { ok: true });
  assert.deepEqual(coordinator.claim('assembler-B'), { ok: true }, '换一个持有人也必须能占用');
  assert.equal(coordinator.holder(), 'assembler-B');
  // Releasing when nothing is held must be reported, not silently "successful".
  assert.deepEqual(coordinator.release('assembler-B'), { ok: true });
  assert.deepEqual(coordinator.release('assembler-B'), { ok: false, reason: 'not-held' });
  coordinator.dispose();
});

test('非法 token（非字符串 / 空串）必须被拒，不得让 undefined 占住协调器', () => {
  const { coordinator } = make();
  for (const token of [undefined, null, '', 0, 123, {}, []]) {
    assert.deepEqual(coordinator.claim(token), { ok: false, reason: 'invalid-token' },
      `claim(${JSON.stringify(token)}) 必须是 invalid-token`);
    assert.deepEqual(coordinator.release(token), { ok: false, reason: 'invalid-token' },
      `release(${JSON.stringify(token)}) 必须是 invalid-token`);
  }
  assert.equal(coordinator.holder(), null, '非法 token 不得占住协调器');
  coordinator.dispose();
});

test('dispose 后状态干净：占位被清空，之后的 claim 明确拒绝', () => {
  const { coordinator } = make();
  assert.deepEqual(coordinator.claim('assembler-A'), { ok: true });
  coordinator.dispose();
  assert.equal(coordinator.holder(), null, 'dispose 必须清掉占用状态，不得留下一个"已占用"的墓碑');
  assert.deepEqual(coordinator.claim('assembler-B'), { ok: false, reason: 'coordinator-disposed' });
  coordinator.dispose(); // idempotent
  assert.equal(coordinator.holder(), null);
});

test('claim 是同步原子的：两个调用之间不存在可被抢占的 await 窗口', () => {
  const { coordinator } = make();
  // A synchronous double-claim is the shape a race reduces to once the await is removed:
  // both calls run to completion in one tick, in order, with no yield between the
  // "is it free" read and the write.
  const first = coordinator.claim('assembler-A');
  const second = coordinator.claim('assembler-B');
  assert.deepEqual([first.ok, second.ok], [true, false], '同一 tick 内的两个 claim 只能成功一个');
  assert.equal(coordinator.holder(), 'assembler-A');
  // The source refuses an async implementation: an `await` between check and assignment
  // is not observable here, so this also guards against a refactor that inserts one.
  const descriptor = Object.getOwnPropertyDescriptor(coordinator, 'claim');
  assert.equal(typeof descriptor.value, 'function');
  assert.equal(coordinator.claim.constructor.name, 'Function', 'claim 必须是普通同步函数，不得被包成 async');
  coordinator.dispose();
});

test('异常路径不泄漏占用：claim 之后抛错也必须能 release', async () => {
  const { coordinator } = make();
  assert.deepEqual(coordinator.claim('assembler-A'), { ok: true });
  let threw = null;
  try {
    throw new Error('assembly blew up after claiming');
  } catch (error) {
    threw = error;
    // The caller's `finally` is what releases; the point is that a throw must not make
    // the occupancy unreleasable.
    assert.deepEqual(coordinator.release('assembler-A'), { ok: true });
  }
  assert.equal(threw?.message, 'assembly blew up after claiming');
  assert.equal(coordinator.holder(), null, '抛错路径走完 finally 之后不得仍被占用');
  assert.deepEqual(coordinator.claim('assembler-B'), { ok: true }, '失败清理之后必须能换人占用');
  coordinator.dispose();
});

test('withClaim 结构性兜底：正常返回释放、抛错也释放、被拒时抛带 code 的错误', async () => {
  const { coordinator } = make();
  assert.equal(await coordinator.withClaim('assembler-A', async () => 'done'), 'done');
  assert.equal(coordinator.holder(), null, '正常返回必须释放');

  const boom = new Error('owner failed');
  await assert.rejects(() => coordinator.withClaim('assembler-A', async () => { throw boom; }), /owner failed/);
  assert.equal(coordinator.holder(), null, '抛错也必须释放，否则一次异常就永久锁死协调器');

  // A second holder is refused, and the refusal carries the machine-readable reason.
  assert.deepEqual(coordinator.claim('assembler-B'), { ok: true });
  await assert.rejects(() => coordinator.withClaim('assembler-A', async () => 'never'),
    (error) => error.code === 'held-by-another-holder' && /coordinator claim refused/.test(error.message));
  assert.equal(coordinator.holder(), 'assembler-B', '被拒的 withClaim 不得动别人的占用');
  assert.deepEqual(coordinator.release('assembler-B'), { ok: true });
  coordinator.dispose();
});

test('claim/release 不改变既有协调器行为：verify/getLedger/ownsConsumption 照旧工作', async () => {
  const { client, coordinator } = make();
  assert.deepEqual(coordinator.claim('assembler-A'), { ok: true });
  client.emit('open');
  client.ok();
  assert.equal(await coordinator.verify(), true, '占位不得影响身份核验');
  const ledger = coordinator.getLedger('s');
  ledger.registerBridgeRequest({ requestId: 'r', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({ sessionId: 's', turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r' } }] }), true);
  assert.equal(ledger.observeToolCall({ sessionId: 's', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c' } } }), true);
  const value = ledger.consume({ sessionId: 's', turn: 1, step: 1, callId: 'c' });
  assert.equal(coordinator.ownsConsumption(value), true);
  assert.deepEqual(coordinator.release('assembler-A'), { ok: true });
  assert.equal(coordinator.isReady(), true, '释放占用不是拆装配：协调器仍必须是 ready 的');
  coordinator.dispose();
});
