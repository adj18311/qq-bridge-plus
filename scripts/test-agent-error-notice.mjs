#!/usr/bin/env node
// 上游错误提示的纯函数回归：错误分类、固定人话文案、5 分钟冷却门控。
//
// 事故背景：529 overloaded_error 时桥接把原始 JSON（含 request_id）连发三条到群里，
// 机器人被禁言 12 小时。所以这里除了分类正确，还要反向断言「QQ 文案里不可能出现原文」。
//
// 运行：node scripts/test-agent-error-notice.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERROR_NOTICE_COOLDOWN_MS,
  ERROR_NOTICE_TEXTS,
  classifyAgentError,
  createErrorNoticeGate,
  defaultErrorNoticeGate
} from '../src/error-notice.js';

const ALLOWED_TEXTS = new Set(Object.values(ERROR_NOTICE_TEXTS));

// 这些片段一旦出现在 QQ 文案里就是事故复现：原始 JSON 结构、请求号、上游错误名、状态码。
const FORBIDDEN_IN_QQ = ['request_id', '{', '}', '[', ']', 'overloaded', 'type":"error"', '"error"', '529', '429', '401', '403'];

function assertNoticeSafe(notice) {
  assert.equal(typeof notice.text, 'string', '文案必须是字符串');
  assert.ok(ALLOWED_TEXTS.has(notice.text), `文案必须来自内置固定表：${notice.text}`);
  assert.ok(notice.kind === 'rate' || notice.text.startsWith('⚠️'), `非限流文案应是 ⚠️ 开头：${notice.text}`);
  for (const fragment of FORBIDDEN_IN_QQ) {
    assert.ok(!notice.text.includes(fragment), `QQ 文案不得包含原始错误片段 ${JSON.stringify(fragment)}：${notice.text}`);
  }
}

function manualClock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms) { at += ms; return at; }
  };
}

test('busy：529 overloaded_error 归为模型拥挤，并给出固定文案', () => {
  const notice = classifyAgentError('529 overloaded_error');
  assert.equal(notice.kind, 'busy');
  assert.equal(notice.text, ERROR_NOTICE_TEXTS.busy);
  assertNoticeSafe(notice);
});

test('busy：中文「集群 / 负载较高」同样归为拥挤', () => {
  const notice = classifyAgentError('模型服务集群负载较高，请稍后重试');
  assert.equal(notice.kind, 'busy');
  assert.equal(notice.text, '⚠️ 模型服务这会儿有点挤，我过一会儿再试。');
});

test('rate：429 携带明确耗尽码也统一按限流处理', () => {
  const failure = { status: 429, code: 'insufficient_quota', message: '429 quota exhausted' };
  const notice = classifyAgentError(failure.message, failure);
  assert.equal(notice.kind, 'rate');
  assert.equal(notice.text, ERROR_NOTICE_TEXTS.rate);
  assertNoticeSafe(notice);
});

test('rate：普通 429 返回精确限流文案，不称额度用完', () => {
  const notice = classifyAgentError('429 Too Many Requests');
  assert.equal(notice.kind, 'rate');
  assert.equal(notice.text, '请求过于频繁，请稍后再试');
  assertNoticeSafe(notice);
});

test('rate：结构化 429 不依赖 message 中重复出现状态码', () => {
  const failure = { status: 429, message: 'Too Many Requests' };
  const notice = classifyAgentError(failure.message, failure);
  assert.equal(notice.kind, 'rate');
  assert.equal(notice.text, '请求过于频繁，请稍后再试');
});

test('rate：request_id 中的 429 不当作 HTTP 状态', () => {
  assert.equal(classifyAgentError('request_id=429; unexpected failure').kind, 'other');
});

test('rate：序列化错误中的429与模糊quota字段仍是限流', () => {
  const message = JSON.stringify({ error: { status: 429, message: 'quota_limit reached' } });
  const notice = classifyAgentError(message, { code: 'SERVER', message });
  assert.equal(notice.kind, 'rate');
  assert.equal(notice.text, '请求过于频繁，请稍后再试');
});

test('rate：明确429前缀与带前缀JSON不能回落旧额度文案', () => {
  const detail = 'Quota exceeded for Requests per minute';
  const json = JSON.stringify({ error: { status: 429, message: detail } });
  for (const message of [`[429] ${detail}`, `Error: 429 ${detail}`,
    `APIError: 429 ${detail}`, `HTTP status 429 ${detail}`,
    'Request failed with status code 429', `APIError: ${json}`,
    `APIError: ${JSON.stringify([{ status: 429, message: detail }])}`,
    `[Provider] ${json}`, `[Provider] 429 ${detail}`]) {
    const notice = classifyAgentError(message, { code: 'SERVER', message });
    assert.equal(notice.kind, 'rate', message);
    assert.equal(notice.text, '请求过于频繁，请稍后再试');
  }
});

test('rate：带前缀JSON中的明确429状态统一按限流处理', () => {
  const message = 'APIError: ' + JSON.stringify({ error: { status: 429, code: 'credit_balance_too_low' } });
  const notice = classifyAgentError(message, { code: 'SERVER', message });
  assert.equal(notice.kind, 'rate');
  assert.equal(notice.text, ERROR_NOTICE_TEXTS.rate);
});

test('rate：状态提取不读取request/body里的伪造429', () => {
  const message = JSON.stringify({ message: 'unexpected failure', request: { status: 429 }, body: { status: 429 } });
  assert.equal(classifyAgentError(message, { message }).kind, 'other');
});

test('other：额度类文本不再单独识别，统一落兜底文案', () => {
  assert.equal(classifyAgentError('当前额度已用完').kind, 'other');
  assert.equal(classifyAgentError('insufficient balance').kind, 'other');
});

test('auth：401 unauthorized 归为鉴权问题', () => {
  const notice = classifyAgentError('401 Unauthorized');
  assert.equal(notice.kind, 'auth');
  assert.equal(notice.text, ERROR_NOTICE_TEXTS.auth);
  assertNoticeSafe(notice);
});

test('auth：403 与中文「鉴权」都命中', () => {
  assert.equal(classifyAgentError('HTTP 403 Forbidden').kind, 'auth');
  assert.equal(classifyAgentError('鉴权失败：token 无效').kind, 'auth');
});

test('other：未知文本落到兜底文案', () => {
  for (const raw of ['TypeError: Cannot read properties of undefined', 'ECONNRESET: socket hang up', '']) {
    const notice = classifyAgentError(raw);
    assert.equal(notice.kind, 'other', `未知文本应归 other：${raw}`);
    assert.equal(notice.text, ERROR_NOTICE_TEXTS.other);
    assertNoticeSafe(notice);
  }
  assert.equal(classifyAgentError(undefined).kind, 'other', '缺省文本也必须安全降级');
});

test('QQ 文案：四类错误都只返回固定文案，原始 JSON / request_id 不可能出现', () => {
  const rawSamples = [
    '529 overloaded_error {"type":"error","request_id":"req_01J9ZK8Q","message":"cluster overloaded"}',
    '429 quota exceeded {"type":"error","request_id":"req_quota_42"}',
    '401 unauthorized {"type":"error","request_id":"req_auth_7","detail":"invalid api key"}',
    '{"type":"error","request_id":"req_unknown_9","message":"boom"}'
  ];
  for (const raw of rawSamples) {
    const notice = classifyAgentError(raw);
    // 双重保险：① 只允许内置文案；② 逐片段反向断言不含原始内容。
    assertNoticeSafe(notice);
    assert.ok(!notice.text.includes(raw), 'QQ 文案不得包含原始错误全文');
    assert.ok(!/request_id|"type"|overloaded/i.test(notice.text), 'QQ 文案不得含 JSON 字段名或上游错误名');
  }
});

test('门控：同一 key + 同一 kind 首次放行', () => {
  const clock = manualClock();
  const gate = createErrorNoticeGate({ now: clock.now });
  assert.equal(gate.shouldSend('group:456', 'busy'), true);
  assert.equal(typeof defaultErrorNoticeGate.shouldSend, 'function', '桥接用的共享闸门必须提供 shouldSend');
});

test('门控：同一 key + 同一 kind 冷却内只放行一次', () => {
  const clock = manualClock();
  const gate = createErrorNoticeGate({ now: clock.now });
  assert.equal(gate.shouldSend('group:456', 'busy'), true);
  assert.equal(gate.shouldSend('group:456', 'busy'), false, '同一时刻重复调用应被吞掉');
  clock.advance(1);
  assert.equal(gate.shouldSend('group:456', 'busy'), false, '1ms 后仍在冷却内');
  clock.advance(ERROR_NOTICE_COOLDOWN_MS - 2); // 共 299999ms
  assert.equal(gate.shouldSend('group:456', 'busy'), false, '299999ms 仍在冷却内');
});

test('门控：超过 5 分钟重新放行（边界 300000ms 也算到期）', () => {
  const clock = manualClock();
  const gate = createErrorNoticeGate({ now: clock.now });
  assert.equal(gate.shouldSend('group:456', 'quota'), true);
  clock.advance(ERROR_NOTICE_COOLDOWN_MS);
  assert.equal(gate.shouldSend('group:456', 'quota'), true, '恰好 5 分钟应已解除冷却');
  assert.equal(gate.shouldSend('group:456', 'quota'), false, '放行后重新开始计时');
  clock.advance(ERROR_NOTICE_COOLDOWN_MS + 1);
  assert.equal(gate.shouldSend('group:456', 'quota'), true, '超过 5 分钟应再次放行');
});

test('门控：不同 kind 互不影响', () => {
  const clock = manualClock();
  const gate = createErrorNoticeGate({ now: clock.now });
  assert.equal(gate.shouldSend('group:456', 'busy'), true);
  assert.equal(gate.shouldSend('group:456', 'busy'), false);
  assert.equal(gate.shouldSend('group:456', 'auth'), true, '同一 key 的另一类错误应独立放行');
  assert.equal(gate.shouldSend('group:456', 'auth'), false);
  assert.equal(gate.shouldSend('group:456', 'busy'), false, '放行 auth 不应重置 busy 的冷却');
});

test('门控：不同 key 互不影响', () => {
  const clock = manualClock();
  const gate = createErrorNoticeGate({ now: clock.now });
  assert.equal(gate.shouldSend('group:456', 'busy'), true);
  assert.equal(gate.shouldSend('group:456', 'busy'), false);
  assert.equal(gate.shouldSend('private:789', 'busy'), true, '另一个会话应独立计时');
  assert.equal(gate.shouldSend('private:789', 'busy'), false);
});

test('门控：cooldownMs 可注入，且只看注入时钟不看真实时间', () => {
  const clock = manualClock(0);
  const gate = createErrorNoticeGate({ now: clock.now, cooldownMs: 1000 });
  assert.equal(gate.shouldSend('group:456', 'other'), true);
  clock.advance(999);
  assert.equal(gate.shouldSend('group:456', 'other'), false);
  clock.advance(1);
  assert.equal(gate.shouldSend('group:456', 'other'), true, '注入的 1000ms 冷却应生效');
  assert.equal(ERROR_NOTICE_COOLDOWN_MS, 300_000, '默认冷却必须仍是 5 分钟');
});
