import assert from 'node:assert/strict';
import { createBackgroundPatrolOutputGate } from '../src/core/background-patrol-output.mjs';
import { BACKGROUND_REPORT_PROBABILITIES, backgroundReportProbability, decideBackgroundReport } from '../src/core/background-patrol-report-policy.mjs';

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`✅ ${name}`);
}

test('后台 requestId 只能经外部已验证的精确 turn 绑定并在 turn/end 一次性消费', () => {
  const gate = createBackgroundPatrolOutputGate({ now: () => 1_000 });
  gate.registerPrompt({ sessionId: 'admin', requestId: 'patrol-1' });
  assert.equal(gate.bindTurn({ sessionId: 'admin', requestId: 'patrol-1', turn: 7 }), true);
  assert.equal(gate.consumeTurn({ sessionId: 'admin', turn: 7 }), true);
  assert.equal(gate.consumeTurn({ sessionId: 'admin', turn: 7 }), false);
  assert.deepEqual(gate.snapshot(), { pending: 0, markedTurns: 0 });
});

test('不匹配的 requestId、会话或 turn 永远 fail-open，绝不按事件顺序猜测', () => {
  const gate = createBackgroundPatrolOutputGate({ now: () => 1_000 });
  gate.registerPrompt({ sessionId: 'admin', requestId: 'patrol-1' });
  assert.equal(gate.bindTurn({ sessionId: 'admin', requestId: 'ordinary', turn: 7 }), false);
  assert.equal(gate.bindTurn({ sessionId: 'other', requestId: 'patrol-1', turn: 7 }), false);
  assert.equal(gate.consumeTurn({ sessionId: 'admin', turn: 7 }), false);
  assert.equal(gate.consumeTurn({ sessionId: 'other', turn: 7 }), false);
});

test('多个会话与多个已精确标记的后台回合互不串线', () => {
  const gate = createBackgroundPatrolOutputGate({ now: () => 1_000 });
  gate.registerPrompt({ sessionId: 'a', requestId: 'a-1' });
  gate.registerPrompt({ sessionId: 'b', requestId: 'b-1' });
  gate.bindTurn({ sessionId: 'b', requestId: 'b-1', turn: 3 });
  gate.bindTurn({ sessionId: 'a', requestId: 'a-1', turn: 3 });
  assert.equal(gate.consumeTurn({ sessionId: 'a', turn: 3 }), true);
  assert.equal(gate.consumeTurn({ sessionId: 'b', turn: 3 }), true);
});

test('拒绝或重置可以撤销后台标记，过期标记不能影响未来正常回合', () => {
  let now = 1_000;
  const gate = createBackgroundPatrolOutputGate({ now: () => now, ttlMs: 10 });
  gate.registerPrompt({ sessionId: 'a', requestId: 'cancel-me' });
  assert.equal(gate.cancelPrompt({ requestId: 'cancel-me' }), true);
  assert.equal(gate.bindTurn({ sessionId: 'a', requestId: 'cancel-me', turn: 1 }), false);
  gate.registerPrompt({ sessionId: 'a', requestId: 'old' });
  now = 1_011;
  assert.equal(gate.bindTurn({ sessionId: 'a', requestId: 'old', turn: 1 }), false);
  assert.equal(gate.consumeTurn({ sessionId: 'a', turn: 1 }), false);
});

test('清理单会话不会触碰其他会话标记', () => {
  const gate = createBackgroundPatrolOutputGate({ now: () => 1_000 });
  gate.registerPrompt({ sessionId: 'a', requestId: 'a-1' });
  gate.registerPrompt({ sessionId: 'b', requestId: 'b-1' });
  gate.clearSession('a');
  assert.equal(gate.bindTurn({ sessionId: 'a', requestId: 'a-1', turn: 1 }), false);
  assert.equal(gate.bindTurn({ sessionId: 'b', requestId: 'b-1', turn: 1 }), true);
  assert.equal(gate.consumeTurn({ sessionId: 'b', turn: 1 }), true);
});

test('概率表冻结且严格对应读取第 1 至 7 次（七档）', () => {
  assert.equal(Object.isFrozen(BACKGROUND_REPORT_PROBABILITIES), true);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(backgroundReportProbability), [0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0]);
  assert.deepEqual([0, -1, 1.5, NaN, Infinity, '1', null].map(backgroundReportProbability), [0, 0, 0, 0, 0, 0, 0]);
});

test('概率判定使用 [0,p) 半开区间，且不触碰全局随机源', () => {
  assert.equal(decideBackgroundReport(1, 0).shouldReport, true);
  assert.equal(decideBackgroundReport(1, 0.599999).shouldReport, true);
  assert.equal(decideBackgroundReport(1, 0.6).shouldReport, false);
  assert.equal(decideBackgroundReport(2, 0.5).shouldReport, false);
  assert.equal(decideBackgroundReport(7, 0).shouldReport, false);
  const original = Math.random;
  Math.random = () => { throw new Error('不得调用全局随机源'); };
  try { assert.equal(decideBackgroundReport(3, 0.1).shouldReport, true); }
  finally { Math.random = original; }
});

test('随机数无效即抛错，即使读取次数已经没有概率', () => {
  for (const random of [-0.1, 1, NaN, Infinity, undefined, '0.5']) {
    assert.throws(() => decideBackgroundReport(7, random), TypeError);
  }
});

console.log(`\n🎉 后台巡逻输出隔离与汇报策略 ${passed}/8 通过`);
