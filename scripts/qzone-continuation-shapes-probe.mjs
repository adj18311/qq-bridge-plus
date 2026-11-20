// Codex m05450：「该限制仍非最终产品需求；不允许仅通过复用 requestId 放宽，继续只读研究
// 可信续步、混源与撤销。」
//
// 这一支只做**测量**，不提出、也不实施任何放宽。
//
// 关键语义（先读出来，否则会把「拒绝」和「接受但绑不上」混为一谈）：
// `observeStep` 的返回值是 `requestId !== null`，不是「这个 step 被记录了吗」。
// 所以 false 有两种完全不同的原因：
//   a) step 被**拒绝**（回合不连续 / step 重复或跳号 / 回合已关闭）—— 没有任何状态写入
//   b) step 被**接受但绑不上**（记录在 steps 里，requestId 为 null）—— 空续步、tool-result 续步、
//      一条以上消息、消息没有对应登记
// 两者对调用方的可观测后果一样（都绑不出绑定），但机制不同，混起来会得出错误的放宽方向。
//
// 因此每一形状都做三件事：看返回值、看该 step 上的 tool/call 能不能绑、看后续回合还活不活。
//
// 只读：直接调 `src/core/qzone-origin-ledger-offline.mjs`，假 session、假 rpcId。
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const SESSION = 'sess-cont';
const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });
const toolResultMessage = (callId) => ({ role: 'tool', source: { callId } });

const fresh = () => createQzoneOriginLedger({ sessionId: SESSION, epoch: 'ep-cont', trackingLimit: 64 });

// 在一个 (turn, step) 上试绑一个 callId，回答「这一步到底能不能授出绑定」。
function bindability(ledger, turn, step, callId) {
  const observed = ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn, step, callId } } });
  const peek = ledger.peekCall(callId);
  const consumed = ledger.consume({ sessionId: SESSION, turn, step, callId });
  return { observed, peek, consumed: consumed ? { turn: consumed.turn, step: consumed.step, requestId: consumed.requestId } : null };
}

// 账本在事后还能不能接新回合（区分「这一步被拒」与「整本账本被毒化」）。
//
// 必须先 `endTurn` 关掉在飞回合：`observeStep` 只接受 `maxTurn + 1`，而回合没结束前
// `activeTurn` 仍占着，直接跳到下一个 turn 会被当成「向前跳跃 = 证据丢失」，把账本打成
// `continuityLost` —— 那是我的测量错误，不是形状的代价。第一版就是这样得到
// 「shape1..5 全部 aliveAfter.stepAccepted=false」的假结论。
function stillAlive(ledger, { closeTurn, turn, requestId }) {
  ledger.endTurn({ sessionId: SESSION, turn: closeTurn });
  try {
    ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  } catch (error) {
    return { canRegister: false, reason: error.message };
  }
  const accepted = ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [userMessage(requestId)] });
  const probe = bindability(ledger, turn, 1, `call-alive-${turn}`);
  return { canRegister: true, stepAccepted: accepted, binds: probe.consumed !== null };
}

const out = {};

// ---- 0 基准：第一步认领消息 → 应当能绑 ----
{
  const ledger = fresh();
  ledger.registerBridgeRequest({ requestId: 'rpc-0', origin: 'qq-inbound' });
  const step1 = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1, messages: [userMessage('rpc-0')] });
  out.shape0_baseline = { step1Returned: step1, atStep1: bindability(ledger, 1, 1, 'call-0'), verdict: 'CLAIMING_STEP_BINDS' };
}

// ---- 1 同回合空续步 ----
{
  const ledger = fresh();
  ledger.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
  const step1 = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1, messages: [userMessage('rpc-1')] });
  const bind1 = bindability(ledger, 1, 1, 'call-1a');
  const step2 = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 2, messages: [] });
  const bind2 = bindability(ledger, 1, 2, 'call-1b');
  out.shape1_emptyContinuation = {
    step1Returned: step1, atStep1: bind1,
    step2Returned: step2, atStep2: bind2,
    aliveAfter: stillAlive(ledger, { closeTurn: 1, turn: 2, requestId: 'rpc-1b' }),
    verdict: bind2.consumed === null ? 'STEP_ACCEPTED_BUT_CALL_UNBOUND' : 'BINDS',
  };
}

// ---- 2 带 tool/result 的续步 ----
{
  const ledger = fresh();
  ledger.registerBridgeRequest({ requestId: 'rpc-2', origin: 'qq-inbound' });
  const step1 = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1, messages: [userMessage('rpc-2')] });
  const bind1 = bindability(ledger, 1, 1, 'call-2a');
  const step2 = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 2, messages: [toolResultMessage('call-2a')] });
  const bind2 = bindability(ledger, 1, 2, 'call-2b');
  out.shape2_toolResultContinuation = {
    step1Returned: step1, atStep1: bind1,
    step2Returned: step2, atStep2: bind2,
    aliveAfter: stillAlive(ledger, { closeTurn: 1, turn: 2, requestId: 'rpc-2b' }),
    verdict: bind2.consumed === null ? 'TOOL_RESULT_STEP_CANNOT_BIND' : 'BINDS',
  };
}

// ---- 3 同一步两条 QQ 用户消息（混源 / 多消息）----
{
  const ledger = fresh();
  ledger.registerBridgeRequest({ requestId: 'rpc-3a', origin: 'qq-inbound' });
  ledger.registerBridgeRequest({ requestId: 'rpc-3b', origin: 'qq-inbound' });
  const step1 = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1, messages: [userMessage('rpc-3a'), userMessage('rpc-3b')] });
  const bind1 = bindability(ledger, 1, 1, 'call-3');
  out.shape3_twoMessagesOneStep = {
    step1Returned: step1, atStep1: bind1,
    aliveAfter: stillAlive(ledger, { closeTurn: 1, turn: 2, requestId: 'rpc-3c' }),
    verdict: bind1.consumed === null ? 'TWO_MESSAGES_KILL_THE_STEP' : 'BINDS',
  };
}

// ---- 3b 混源：一条 QQ 用户消息 + 一条非 QQ 消息 ----
{
  const ledger = fresh();
  ledger.registerBridgeRequest({ requestId: 'rpc-3d', origin: 'qq-inbound' });
  const step1 = ledger.observeStep({
    sessionId: SESSION, turn: 1, step: 1,
    messages: [userMessage('rpc-3d'), { role: 'system', content: 'injected' }],
  });
  const bind1 = bindability(ledger, 1, 1, 'call-3d');
  out.shape3b_mixedSource = {
    step1Returned: step1, atStep1: bind1,
    aliveAfter: stillAlive(ledger, { closeTurn: 1, turn: 2, requestId: 'rpc-3e' }),
    verdict: bind1.consumed === null ? 'MIXED_SOURCE_KILLS_THE_STEP' : 'BINDS',
  };
}

// ---- 4 消息在回合中途再出现（新消息插队）----
{
  const ledger = fresh();
  ledger.registerBridgeRequest({ requestId: 'rpc-4', origin: 'qq-inbound' });
  const step1 = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1, messages: [userMessage('rpc-4')] });
  const bind1 = bindability(ledger, 1, 1, 'call-4a');
  const step2 = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 2, messages: [] });
  const step3 = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 3, messages: [userMessage('rpc-4')] });
  const bind3 = bindability(ledger, 1, 3, 'call-4b');
  out.shape4_messageReturnsLaterInTurn = {
    step1Returned: step1, atStep1: bind1,
    step2Returned: step2, step3Returned: step3, atStep3: bind3,
    aliveAfter: stillAlive(ledger, { closeTurn: 1, turn: 2, requestId: 'rpc-4c' }),
    verdict: bind3.consumed === null ? 'MESSAGE_REAPPEARANCE_CANNOT_BIND' : 'BINDS',
  };
}

// ---- 5 迟到 / 重放：旧回合的 pre-step 在新回合之后才到 ----
{
  const ledger = fresh();
  ledger.registerBridgeRequest({ requestId: 'rpc-5a', origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1, messages: [userMessage('rpc-5a')] });
  bindability(ledger, 1, 1, 'call-5a');
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  ledger.registerBridgeRequest({ requestId: 'rpc-5b', origin: 'qq-inbound' });
  const turn2 = ledger.observeStep({ sessionId: SESSION, turn: 2, step: 1, messages: [userMessage('rpc-5b')] });
  const late = ledger.observeStep({ sessionId: SESSION, turn: 1, step: 2, messages: [] });
  const lateBind = bindability(ledger, 1, 2, 'call-5-late');
  out.shape5_lateReplay = {
    turn2Returned: turn2, lateTurn1Step2Returned: late, lateBind,
    aliveAfter: stillAlive(ledger, { closeTurn: 2, turn: 3, requestId: 'rpc-5c' }),
    verdict: late === false && lateBind.consumed === null ? 'LATE_STEP_REFUSED_WITHOUT_POISONING' : 'UNEXPECTED',
  };
}

// ---- 6 结束撤销：endTurn 之后同回合的 tool/call ----
{
  const ledger = fresh();
  ledger.registerBridgeRequest({ requestId: 'rpc-6', origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1, messages: [userMessage('rpc-6')] });
  const before = bindability(ledger, 1, 1, 'call-6a');
  ledger.endTurn({ sessionId: SESSION, turn: 1 });
  const after = bindability(ledger, 1, 1, 'call-6b');
  out.shape6_afterEndTurn = {
    beforeEnd: before, afterEnd: after,
    aliveAfter: stillAlive(ledger, { closeTurn: 1, turn: 2, requestId: 'rpc-6b' }),
    verdict: after.consumed === null ? 'ENDED_TURN_REFUSES_NEW_CALLS' : 'BINDS',
  };
}

// ---- 汇总 ----
{
  const shapes = [
    ['0 认领 step（基准）', out.shape0_baseline.atStep1],
    ['1 同回合空续步', out.shape1_emptyContinuation.atStep2],
    ['2 带 tool/result 续步', out.shape2_toolResultContinuation.atStep2],
    ['3 同 step 两条 QQ 消息', out.shape3_twoMessagesOneStep.atStep1],
    ['3b 混源（QQ + 非 QQ）', out.shape3b_mixedSource.atStep1],
    ['4 消息回合中途再出现', out.shape4_messageReturnsLaterInTurn.atStep3],
    ['5 迟到 / 重放', out.shape5_lateReplay.lateBind],
    ['6 endTurn 之后同回合', out.shape6_afterEndTurn.afterEnd],
  ];
  const rows = shapes.map(([shape, r]) => ({ shape, binds: r?.consumed !== null && r?.consumed !== undefined, peek: r?.peek ?? null }));
  out.summary = {
    rows,
    shapesThatBind: rows.filter((r) => r.binds).map((r) => r.shape),
    shapesThatCannotBind: rows.filter((r) => !r.binds).map((r) => r.shape),
    onlyClaimingStepBinds: rows.filter((r) => r.binds).length === 1 && rows[0].binds === true,
    note: '「只有认领了 QQ 用户消息的那个 step 能授出绑定」是这八条读数共同的结果。'
      + '注意 3b：只要 messages 长度不是 1，requestId 就解析不出来 —— 连「一条 QQ 消息 + 一条系统注入」也不行，'
      + '而且它按 :212 会把整个回合投毒（`aliveAfter` 逐条印证）。'
      + '所以「靠消息形状推出可信 requestId」这条路本身走不通，放宽必须先有独立来源，'
      + '而不是把 requestId 从上一个 step 继承下来（那正是 Codex 明确不批的复用）。',
  };
}

console.log(JSON.stringify(out, null, 2));
