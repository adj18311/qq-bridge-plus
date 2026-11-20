// Pins the reachability of the write gate that `scripts/qzone-publish-gate-probe.mjs`
// established, so a future change cannot quietly move `publish`'s refusal point.
//
// The finding: `WRITE_TOOLS` (`src/core/qzone-runtime-wiring.mjs:32`) lists four
// actions, but only `comment` / `reply` / `like` actually reach the `write-not-wired`
// line. `publish` is refused EARLIER, by the origin check, because its MCP schema
// (`src/core/qzone-mcp-contract.mjs`) allows only `target_uins` and `normalizeTarget`
// (`src/core/qzone-runtime-wiring.mjs:52-60`) requires a single `target_uin`.
//
// That distinction is load-bearing: a future `target_uins`-aware normalizer would move
// publish's refusal from `origin-unverified` onto the `WRITE_TOOLS` line, and a test
// that only asserted "publish is refused" would stay green through that change. These
// assertions use the exact error string for that reason — they are deliberately
// brittle about WHERE the refusal happens, not just THAT it happens.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { QZONE_MCP_TOOLS } from '../src/core/qzone-mcp-contract.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const SESSION = 'session-write-gate';
const BOT = 123;
const WRITE_TOOLS = ['publish', 'comment', 'reply', 'like'];

function makeStore() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [],
  };
  return {
    read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return structuredClone(state); },
  };
}

// One dispatch needs its own registered request, a step that cites it, and a
// `tool/call` in that same step — the ledger only binds inside the claiming step.
function harness() {
  const platformCalls = [];
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'epoch-1', trackingLimit: 8 });
  const runtime = createQzoneRuntime({
    store: makeStore(), botQq: BOT, mode: 'enabled', trackingLimit: 8,
    getConnectionEpoch: () => 1, sourceEpoch: 'epoch-1',
    authorizeSource: () => true,
    clock: () => NOW,
    call: async (action, params) => {
      platformCalls.push({ action, params });
      return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
    },
    getBridgeSessions: () => ledger,
  });
  let turn = 0;
  const dispatch = async (action, input, toolName = `qzone_${action}`) => {
    turn += 1;
    const requestId = `req-${action}-${turn}`;
    const callId = `call-${action}-${turn}`;
    ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
    ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [{ role: 'user', source: { rpcId: requestId } }] });
    ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn, step: 1, callId, name: toolName } } });
    const before = platformCalls.length;
    const result = await runtime.dispatch(action, input, { sessionId: SESSION, callId });
    // Both the COUNT and the ACTION NAMES, so a test can tell "one friendship probe"
    // from "one page read" instead of treating any non-zero count as "wired".
    const seenActions = platformCalls.slice(before).map((entry) => entry.action);
    const platformBefore = seenActions.length;
    ledger.endTurn({ sessionId: SESSION, turn });
    return { result, platformCalls: platformBefore, seenActions };
  };
  return { dispatch, platformCalls };
}

test('四类写调用都不得到达平台：comment/reply/like 由 WRITE_TOOLS 拦，publish 更早由源校验拦', async () => {
  const { dispatch, platformCalls } = harness();
  const inputs = {
    comment: { tid: 'p1', target_uin: 456, content: 'hi' },
    reply: { tid: 'p1', target_uin: 456, content: 'hi', comment_id: 'c1', comment_uin: 789 },
    like: { tid: 'p1', target_uin: 456 },
  };
  for (const [action, input] of Object.entries(inputs)) {
    const { result, platformCalls: calls } = await dispatch(action, input);
    assert.deepEqual(result, { ok: false, error: 'write-not-wired' }, `${action} 必须在写闸被拒`);
    assert.equal(calls, 0, `${action} 不得发出任何平台调用`);
  }
  assert.equal(platformCalls.length, 0, '三类写调用累计平台调用必须为零');
});

test('publish 的拒绝点在源校验而不是写闸：错误码必须是 origin-unverified', async () => {
  const { dispatch, platformCalls } = harness();
  // The legal publish input from the contract: no single `target_uin` exists.
  const { result, platformCalls: calls } = await dispatch('publish', { content: 'hello', ugc_right: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'origin-unverified',
    'publish 撞不到 WRITE_TOOLS：它更早被源校验拒绝。若这里变成 write-not-wired，说明归一化改了，必须显式评估而不是静默通过');
  assert.equal(calls, 0, 'publish 不得发出平台调用');
  assert.equal(platformCalls.length, 0);
});

test('带 target_uins 的 publish 也仍被源校验拒绝：不因为多给了定向参数就改变拒绝点', async () => {
  const { dispatch, platformCalls } = harness();
  const { result, platformCalls: calls } = await dispatch('publish', { content: 'hello', ugc_right: 16, target_uins: [456] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'origin-unverified',
    'target_uins 不是 normalizeTarget 认的单一目标，拒绝点不得移动');
  assert.equal(calls, 0);
  assert.equal(platformCalls.length, 0);
});

test('两个读工具都接线：read_posts 与 read_comments 都在工具闸之后，写工具仍被拦', async () => {
  const { dispatch, platformCalls } = harness();
  // WHAT THIS USED TO PIN: `read_posts` was the ONLY read tool on the wired side of
  // the tool gate; `read_comments` was refused there with `tool-not-wired` and
  // issued zero platform calls, because it demanded
  // `exceptionReads.fetchCommentPage` — an adapter no host injects.
  //
  // WHAT IT PINS NOW (t42): the tool gate admits BOTH read tools, so the
  // discriminator can no longer be "did it reach the platform" — in THIS fixture
  // neither read gets that far, and for two independent reasons:
  //   · `get_friend_list` here answers with a msg-list envelope, so the friendship
  //     proof fails and the reader refuses with `read-denied` / `unverified`;
  //   · a plain-comments read additionally needs `get_qzone_msg_detail`, which the
  //     assembled runtime's bound transport does not provide yet.
  // The single platform call below is therefore the FRIENDSHIP PROBE
  // (`get_login_info`), not a page read. It is asserted exactly, so the test cannot
  // drift into claiming more than it proves.
  //
  // WHAT STILL MUST HOLD, and is what this test now guards: the refusal for
  // `read_comments` must NOT be `tool-not-wired` any more. That is the one fact
  // that separates "gate open" from "gate closed", and it is independent of how far
  // the read later gets. Write tools are unaffected and stay pinned above.
  const readPosts = await dispatch('read_posts', { target_uin: 456 });
  assert.equal(readPosts.result.ok, false, '非好友目标仍必须被拒');
  assert.equal(readPosts.result.error, 'read-denied', 'read_posts 的拒绝来自读取闸，不是工具闸');
  assert.equal(readPosts.result.reason, 'unverified', 'read_posts 的拒绝原因是好友证明失败');
  assert.deepEqual(readPosts.seenActions, ['get_login_info'],
    'read_posts 在好友证明失败时只发一次 get_login_info（好友探测），不发页面读取');
  assert.equal(platformCalls.length, 1);

  const readComments = await dispatch('read_comments', { tid: 'p1', target_uin: 456 });
  assert.equal(readComments.result.ok, false, '非好友目标仍必须被拒');
  assert.notEqual(readComments.result.error, 'tool-not-wired',
    'read_comments 不得再被工具闸拒绝：t42 已把 plain-comments 放进普通读路径');
  assert.equal(readComments.result.error, 'read-denied',
    'read_comments 的拒绝来自读取层（当前是好友证明），与 read_posts 同一层');
  assert.equal(readComments.result.reason, 'unverified');
  assert.deepEqual(readComments.seenActions, ['get_login_info'],
    '同样只发好友探测；页面读取在此之前就被拒了（见上方两条原因）');
  assert.equal(platformCalls.length, 2, '两个读工具各一次好友探测，累计两次');
});

test('契约里 publish 只有 target_uins：单一 target_uin 不在 schema 中，这正是拒绝更早的原因', () => {
  const publish = QZONE_MCP_TOOLS.publish.inputSchema;
  assert.ok(!Object.hasOwn(publish.properties, 'target_uin'),
    'publish 的 schema 不得出现单一 target_uin；若出现了，本文件的 refusal-point 断言就要重新推导');
  assert.ok(Object.hasOwn(publish.properties, 'target_uins'), 'publish 只允许 target_uins');
  assert.deepEqual(Object.keys(QZONE_MCP_TOOLS).sort(),
    ['comment', 'like', 'publish', 'read_comments', 'read_posts', 'reply'],
    '工具面必须是这六个动作');
  assert.deepEqual([...WRITE_TOOLS].sort(), ['comment', 'like', 'publish', 'reply']);
});
