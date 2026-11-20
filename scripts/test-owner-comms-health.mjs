// task-77（GPT 复核 #2）：「QQ 通信已恢复」必须现算当前连接事实，不能只看「过去 10 分钟有过回执」。
//
// 背景：手动恢复第三前置条件的原文是「QQ 通信已恢复」。旧实现只查 lastSendReceiptAt 窗口，
// 链路此刻已断也返回 true，等价于把「曾经通过」当成「现在通」。本套件钉住收敛后的口径。
import test from 'node:test';
import assert from 'node:assert/strict';

import { ownerCommsCurrentlyUp, describeOwnerComms, OWNER_COMMS_RECEIPT_WINDOW_MS } from '../src/core/owner-comms-health.mjs';

const NOW = 1_800_000_000_000;

/** 一份「一切正常」的事实基线；每个用例只改它关心的那一项。 */
function healthy(overrides = {}) {
  return {
    lastSendReceiptAt: NOW - 60_000,
    now: NOW,
    connected: true,
    good: true,
    accountOnline: true,
    lastPacketAt: NOW - 30_000,
    silent: false,
    ...overrides,
  };
}

test('基线：刚收到回执 + WS 连着 + 上游正常 + 事件包在流动 ⇒ 通信已恢复', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy()), true);
});

test('窗口口径：默认 10 分钟', () => {
  assert.equal(OWNER_COMMS_RECEIPT_WINDOW_MS, 10 * 60 * 1000);
});

test('WS 已断开 ⇒ 未恢复（过去有过回执不算现在的连接）', () => {
  // 这是本任务的核心回归：旧实现只看回执窗口，这里返回 true 就说明退化回旧行为。
  assert.equal(ownerCommsCurrentlyUp(healthy({ connected: false })), false);
});

test('WS 连接状态未知（null/undefined）⇒ 未恢复（未知 ≠ 成功）', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy({ connected: null })), false);
  assert.equal(ownerCommsCurrentlyUp(healthy({ connected: undefined })), false);
});

test('上游自报接收链路坏（good=false）⇒ 未恢复', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy({ good: false })), false);
});

test('good 未知（null）不拦：它只是缺少正向证据，不构成「确认坏了」', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy({ good: null })), true);
});

test('账号明确离线 ⇒ 未恢复', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy({ accountOnline: false })), false);
});

test('静默（长时间无事件包）⇒ 未恢复', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy({ silent: true })), false);
});

test('从未收到过任何事件包 ⇒ 未恢复', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy({ lastPacketAt: 0 })), false);
  assert.equal(ownerCommsCurrentlyUp(healthy({ lastPacketAt: null })), false);
});

test('回执过窗口 / 从未有过回执 ⇒ 未恢复', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy({ lastSendReceiptAt: NOW - 10 * 60 * 1000 - 1 })), false);
  assert.equal(ownerCommsCurrentlyUp(healthy({ lastSendReceiptAt: 0 })), false);
  assert.equal(ownerCommsCurrentlyUp(healthy({ lastSendReceiptAt: null })), false);
});

test('回执恰在窗口边界 ⇒ 仍有通信证据', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy({ lastSendReceiptAt: NOW - 10 * 60 * 1000 })), true);
});

test('回执时间戳在未来（时钟回拨）⇒ 保守判未恢复', () => {
  assert.equal(ownerCommsCurrentlyUp(healthy({ lastSendReceiptAt: NOW + 60_000 })), false);
});

test('入参缺失/抛异常 ⇒ 一律未恢复（未知 ≠ 成功）', () => {
  assert.equal(ownerCommsCurrentlyUp(), false);
  assert.equal(ownerCommsCurrentlyUp({}), false);
  const poisoned = healthy();
  Object.defineProperty(poisoned, 'connected', { get() { throw new Error('boom'); } });
  assert.equal(ownerCommsCurrentlyUp(poisoned), false);
});

// ── task-78（GPT 第三轮 #4）：必须能区分「确认在线」与「容忍未知」──────
// GPT 的原话：good/accountOnline 未明确报 false 的未知值允许通过，「属可用性折中
// 而非确认账号一定在线」。上面的布尔通过本身没错，但**只有布尔**就会被读成「确认在线」。
// 这里把两种语义钉死，防止将来有人拿 ownerCommsCurrentlyUp()===true 去写「账号正常」。
test('task-78：全部字段都明确为好 ⇒ evidence=confirmed（这才是「确认」）', () => {
  const d = describeOwnerComms(healthy());
  assert.equal(d.up, true);
  assert.equal(d.evidence, 'confirmed');
  assert.deepEqual(d.unknownTolerated, []);
  assert.equal(d.failedOn, null);
});

test('task-78：good 未知 ⇒ 放行但必须标成 tolerated-unknown，不得算 confirmed', () => {
  const d = describeOwnerComms(healthy({ good: null }));
  assert.equal(d.up, true, '可用性折中：未知不拦');
  assert.equal(d.evidence, 'tolerated-unknown', '放行 ≠ 确认在线');
  assert.deepEqual(d.unknownTolerated, ['good']);
});

test('task-78：accountOnline 未知 ⇒ 同样 tolerated-unknown（老运行时不上报）', () => {
  const d = describeOwnerComms(healthy({ accountOnline: undefined }));
  assert.equal(d.up, true);
  assert.equal(d.evidence, 'tolerated-unknown');
  assert.deepEqual(d.unknownTolerated, ['accountOnline']);
});

test('task-78：两项都未知 ⇒ 两个都要列出来（审计文案需要知道折中在哪）', () => {
  const d = describeOwnerComms(healthy({ good: null, accountOnline: null }));
  assert.equal(d.up, true);
  assert.equal(d.evidence, 'tolerated-unknown');
  assert.deepEqual(d.unknownTolerated.sort(), ['accountOnline', 'good']);
});

test('task-78：拒绝时必须给出一条可读的 failedOn（控制台据此说清缺哪条）', () => {
  assert.equal(describeOwnerComms(healthy({ connected: false })).failedOn, 'ws-not-connected');
  assert.equal(describeOwnerComms(healthy({ lastSendReceiptAt: null })).failedOn, 'no-send-receipt');
  assert.equal(describeOwnerComms(healthy({ good: false })).failedOn, 'upstream-good-false');
  assert.equal(describeOwnerComms(healthy({ accountOnline: false })).failedOn, 'account-offline');
  assert.equal(describeOwnerComms(healthy({ silent: true })).failedOn, 'silent');
  const r = describeOwnerComms(healthy({ connected: false }));
  assert.equal(r.up, false);
  assert.equal(r.evidence, 'insufficient');
  assert.deepEqual(r.unknownTolerated, [], '拒绝时不再谈「容忍了哪些未知」');
});

test('task-78：布尔口径必须与 detailed 口径完全一致（不许两套判定漂移）', () => {
  const cases = [
    healthy(),
    healthy({ good: null }),
    healthy({ accountOnline: undefined }),
    healthy({ connected: null }),
    healthy({ good: false }),
    healthy({ silent: true }),
    {},
  ];
  for (const facts of cases) {
    assert.equal(
      ownerCommsCurrentlyUp(facts),
      describeOwnerComms(facts).up,
      `ownerCommsCurrentlyUp 与 describeOwnerComms(...).up 不一致：${JSON.stringify(facts)}`,
    );
  }
});

// ── 接线断言：bridge 必须用现算口径，不能退回「只看窗口」──────────────
test('bridge 接线：qqCommsProvider 必须走现算装配函数，且不得再直接比 lastSendReceiptAt', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/core\/owner-comms-health\.mjs'/, 'bridge 必须 import 现算模块');
  // provider 走 bridge 本地的装配函数（它把 snowlumaHealthSnapshot 的事实喂给纯函数）。
  assert.match(source, /qqCommsProvider:\s*\(\)\s*=>\s*ownerCommsUpNow\(\)/, 'qqCommsProvider 必须调用现算装配函数');
  // 装配函数必须真的调用纯函数，而不是自己重写一套判定。
  // task-78：事实收集抽到 snowlumaCommsFacts()，装配函数只做一次委托（不再内联 facts 字面量）。
  assert.match(
    source,
    /function ownerCommsUpNow\(\)\s*\{\s*return ownerCommsCurrentlyUp\(snowlumaCommsFacts\(\)\);/,
    '装配函数必须委托给纯函数',
  );
  assert.match(
    source,
    /function snowlumaCommsFacts\(\)[\s\S]{0,600}?connected:\s*snap\.connected[\s\S]{0,300}?silent:\s*snap\.silent/,
    '事实收集必须把连接事实（connected/good/accountOnline/lastPacketAt/silent）全部喂进判定',
  );
  // 禁止退回旧写法：直接把窗口比较塞进 qqCommsProvider。
  assert.doesNotMatch(
    source,
    /qqCommsProvider:\s*\(\)\s*=>\s*lastSendReceiptAt\s*>\s*0/,
    'qqCommsProvider 不得退回「只看回执窗口」的旧口径',
  );
  // 窗口常量必须来自同一处定义，避免两处漂移。
  assert.match(source, /const OWNER_RECEIPT_WINDOW_MS = OWNER_COMMS_RECEIPT_WINDOW_MS;/, '窗口常量必须复用模块导出');
});

// ── task-78：控制台被拒时必须能说清「确认断了」还是「只有未知证据」──────
test('task-78 接线：qq-comms 被拒时 recover 端点必须返回 commsEvidence', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  // 只认 describeOwnerComms 的详细口径，不许自己从布尔反推「账号在线」。
  assert.match(
    source,
    /failed\.includes\('qq-comms'\)\s*\?\s*describeOwnerComms\(snowlumaCommsFacts\(\)\)/,
    'qq-comms 被拒时必须取详细判定（evidence/unknownTolerated/failedOn）',
  );
  assert.match(source, /commsEvidence:\s*commsDetail/, '被拒响应必须把 commsEvidence 透给控制台');
  // 反向：不得声称「账号在线」这类事实性结论（判定只到门禁与证据强度）。
  assert.doesNotMatch(source, /accountIsOnline|accountConfirmedOnline/, '控制台不得把容忍未知说成账号在线');
});
