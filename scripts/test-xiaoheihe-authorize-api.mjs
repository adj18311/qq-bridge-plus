// scripts/test-xiaoheihe-authorize-api.mjs
// task-71（B3）：授权链 **reserve / commit / abort / complete** 纯处理器测试。
// 纯离线：注入假 controller / audit / persist；不接线、不发 QQ、不读写 config/state。
//
// 契约：authorize=reserve（不计数）；commit 才计数（controller.commitTicket）；abort 释放/回滚；
// complete 只接受 started 票据（reserved → not-started）；unknown 不重放；任何异常 fail-closed。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  XHH_AUTHORIZE_TOOL_NAMES,
  XHH_AUTHORIZE_READ_TOOLS,
  XHH_AUTHORIZE_WRITE_TOOLS,
  XHH_AUTHORIZE_CREDENTIAL_TOOLS,
  XHH_AUTHORIZE_CREDENTIAL_COOLDOWN_MS,
  XHH_AUTHORIZE_CREDENTIAL_DENY_HINT,
  createXhhAuthorizeApi,
} from '../src/core/xiaoheihe-authorize-api.mjs';
import { createXhhOperationController } from '../src/core/xiaoheihe-operation-controller.mjs';
import { createXhhAuthorizeRoutes } from '../src/core/xiaoheihe-authorize-route.mjs';
import { createXhhAuthorizeServer } from '../src/core/xiaoheihe-authorize-server.mjs';
import { apply as applyXhhQuotaGuard } from '../plugins/xhh-quota-guard/index.mjs';
import { startOnFetchablePort } from './test-port-safe.mjs';

const T0 = Date.UTC(2026, 9, 24, 2, 0, 0);
const BG = 'patrol:background';
const USER = 'private:123456789';
const FULL = (short) => `mcp__xiaoheihe__${short}`;

function makeFakeController(options = {}) {
  const calls = { status: 0, reserveRead: [], reserveWrite: [], commit: [], abort: [], finish: [] };
  let seq = 0;
  const issued = new Map();
  const readQueue = [...(options.readResults ?? [])];
  const writeQueue = [...(options.writeResults ?? [])];
  const commitQueue = [...(options.commitResults ?? [])];
  const abortQueue = [...(options.abortResults ?? [])];
  const finishQueue = [...(options.finishResults ?? [])];
  let pause = { accessPaused: false, writePaused: false };
  return {
    calls,
    setPause(next) { pause = { ...pause, ...next }; },
    async status() { calls.status += 1; return { ...pause }; },
    async reserveRead(request) {
      calls.reserveRead.push(request);
      if (readQueue.length > 0) return readQueue.shift();
      seq += 1;
      const counted = request.forceCount === true ? true : request.tool !== FULL('search_content');
      const ticket = { state: 'reserved', ticketId: `rt-${seq}`, kind: 'read', opId: request.id ?? null, now: request.now, counted };
      issued.set(ticket.ticketId, ticket);
      return { ok: true, counted, ticket, remaining: 9 };
    },
    async reserveWrite(request) {
      calls.reserveWrite.push(request);
      if (writeQueue.length > 0) return writeQueue.shift();
      seq += 1;
      const ticket = { state: 'reserved', ticketId: `rt-${seq}`, kind: request.kind, opId: request.id, now: request.now, counted: true };
      issued.set(ticket.ticketId, ticket);
      return { ok: true, ticket, used: 1, limit: 2 };
    },
    async commitTicket(ticket) {
      calls.commit.push(ticket);
      if (commitQueue.length > 0) return commitQueue.shift();
      if (!issued.has(ticket?.ticketId)) return { ok: false, reason: 'invalid-ticket' };
      issued.get(ticket.ticketId).state = 'started';
      return {
        ok: true,
        started: true,
        ticket: { kind: ticket.kind, id: ticket.opId, at: ticket.now, ticketId: ticket.ticketId, started: true },
        used: 1,
        limit: 2,
      };
    },
    async abortTicket(ticket) {
      calls.abort.push(ticket);
      if (abortQueue.length > 0) return abortQueue.shift();
      if (!issued.has(ticket?.ticketId)) return { ok: false, reason: 'invalid-ticket' };
      issued.delete(ticket.ticketId);
      return { ok: true, aborted: true, rolledBack: true };
    },
    async finish(ticket, rest) {
      calls.finish.push({ ticket, rest });
      if (finishQueue.length > 0) return finishQueue.shift();
      return { ok: true, id: ticket?.id ?? null, outcome: rest?.outcome ?? null };
    },
  };
}

function makeApi({ controller = makeFakeController(), audit = null, backgroundSessionKeys = [BG], userExemptAgents = [USER], clock = () => T0, persist, readOnly = false, writeBlocker, provenanceClassifier, credentialNotify, degrade, consoleSettings } = {}) {
  const events = [];
  const api = createXhhAuthorizeApi({
    controller,
    backgroundSessionKeys,
    userExemptAgents,
    clock,
    ...(readOnly ? { readOnly: true } : {}),
    audit: (event) => { events.push(event); if (typeof audit === 'function') audit(event); },
    ...(persist === undefined ? {} : { persist }),
    ...(writeBlocker === undefined ? {} : { writeBlocker }),
    ...(provenanceClassifier === undefined ? {} : { provenanceClassifier }),
    ...(credentialNotify === undefined ? {} : { credentialNotify }),
    ...(degrade === undefined ? {} : { degrade }),
    ...(consoleSettings === undefined ? {} : { consoleSettings }),
  });
  return { api, controller, events };
}

function expectAllow(result, label = '') {
  assert.equal(result?.decision, 'allow', `${label} 期望 allow，实际 ${JSON.stringify(result)}`);
  return result;
}
function expectOk(result, label = '') {
  assert.equal(result?.ok, true, `${label} 期望 ok:true，实际 ${JSON.stringify(result)}`);
  return result;
}
function expectDeny(result, reason, label = '') {
  assert.equal(result?.decision, 'deny', `${label} 期望 deny，实际 ${JSON.stringify(result)}`);
  if (reason !== undefined) assert.equal(result?.reason, reason, `${label} 期望 reason:${reason}，实际 ${JSON.stringify(result)}`);
  return result;
}

test('读取完成回执重复提交不能把失败改写为成功', async () => {
  const { api } = makeApi();
  const authorized = expectAllow(await api.authorize({ agentKey: BG, tool: FULL('get_home_content'), args: {}, now: T0 }));
  const started = expectOk(await api.commit({ ticket: authorized.ticket, agentKey: BG, now: T0 + 1 }));
  const first = await api.complete({ ticket: started.ticket, agentKey: BG, outcome: 'failure', now: T0 + 2 });
  assert.equal(first.ok, true);
  const repeated = await api.complete({ ticket: started.ticket, agentKey: BG, outcome: 'success', now: T0 + 3 });
  assert.equal(repeated.already, true);
  assert.equal(repeated.outcome, 'failure');
});

test('自主读取完成必须带对应派发序号，倒序完成不可用全局最新值代替', async () => {
  const controller = createXhhOperationController({ clock: () => T0 });
  const { api } = makeApi({ controller });
  const first = expectAllow(await api.authorize({ agentKey: BG, tool: FULL('get_home_content'), args: {}, now: T0 }));
  const a = expectOk(await api.commit({ ticket: first.ticket, agentKey: BG, now: T0 + 1 }));
  const second = expectAllow(await api.authorize({ agentKey: BG, tool: FULL('get_post_detail'), args: {}, now: T0 + 2 }));
  const b = expectOk(await api.commit({ ticket: second.ticket, agentKey: BG, now: T0 + 3 }));
  const doneB = await api.complete({ ticket: b.ticket, agentKey: BG, outcome: 'success', now: T0 + 4 });
  const doneA = await api.complete({ ticket: a.ticket, agentKey: BG, outcome: 'success', now: T0 + 5 });
  assert.equal(doneB.readIndex, 2);
  assert.equal(doneA.readIndex, 1);
  assert.equal(doneB.readStartedAt, T0 + 3);
  assert.equal(doneA.readStartedAt, T0 + 1);
});

test('exports / 工厂校验：controller 必须提供 reserveRead/reserveWrite/commitTicket/abortTicket/finish/status', () => {
  assert.equal(XHH_AUTHORIZE_TOOL_NAMES.length, 12);
  assert.deepEqual([...XHH_AUTHORIZE_READ_TOOLS].sort(), ['get_home_content', 'get_post_detail']);
  assert.deepEqual([...XHH_AUTHORIZE_WRITE_TOOLS].sort(), ['post_comment', 'publish_article', 'publish_content', 'publish_video', 'reply_comment']);
  assert.equal(typeof createXhhAuthorizeApi, 'function');
  assert.throws(() => createXhhAuthorizeApi({}), TypeError);
  assert.throws(() => createXhhAuthorizeApi({ controller: makeFakeController() }), TypeError);
  const valid = makeFakeController();
  for (const key of ['status', 'reserveRead', 'reserveWrite', 'commitTicket', 'abortTicket', 'finish']) {
    assert.throws(() => createXhhAuthorizeApi({ controller: { ...valid, [key]: undefined }, backgroundSessionKeys: [BG] }), TypeError, key);
  }
});

test('未知/错名工具 fail-closed deny，不调 controller', async () => {
  const { api, controller } = makeApi();
  for (const tool of ['mcp__xiaoheihe__delete_post', 'mcp__xiaoheihe__', 'qq_send_message', 'get_home_content_typo', '', 42]) {
    expectDeny(await api.authorize({ agentKey: BG, tool, args: {}, now: T0 }), 'unknown-tool');
  }
  assert.equal(controller.calls.reserveRead.length, 0);
  assert.equal(controller.calls.reserveWrite.length, 0);
});

test('authorize=reserve：12 工具 allow 但 counted:false / ticket.state=reserved；读 search 与写分别走 reserve', async () => {
  // 凭据门禁按来源判定（A-2）：本用例验证工具路由，故把来源声明为 owner。
  const { api, controller } = makeApi({ provenanceClassifier: () => 'owner' });
  for (const short of XHH_AUTHORIZE_TOOL_NAMES) {
    const tool = short === 'get_home_content' || short === 'check_login_status' ? FULL(short) : short;
    const result = expectAllow(await api.authorize({
      agentKey: BG,
      tool,
      args: { operationId: `op-${short}`, id: `id-${short}` },
      now: T0,
    }), short);
    assert.equal(result.exemption, 'quota');
    assert.equal(result.counted, false, 'reserve 阶段不计数');
    if (result.ticket.kind === 'exempt' || result.ticket.kind === 'misc') continue;
    assert.equal(result.ticket.state, 'reserved');
  }
  assert.deepEqual(controller.calls.reserveRead.map((call) => call.tool).sort(), [
    FULL('get_home_content'), FULL('search_content'), FULL('get_post_detail'),
  ].sort());
  assert.deepEqual(controller.calls.reserveWrite.map((call) => call.kind).sort(), ['comment', 'comment', 'post', 'post', 'post'].sort());
  assert.equal(controller.calls.commit.length, 0, 'authorize 不得自动 commit');
});

test('未知 agentKey deny unknown-agent，不读 controller.status', async () => {
  const { api, controller, events } = makeApi();
  expectDeny(await api.authorize({ agentKey: 'someone-else', tool: 'get_home_content', args: {}, now: T0 }), 'unknown-agent');
  assert.equal(controller.calls.status, 0);
  assert.equal(controller.calls.reserveRead.length, 0);
  assert.equal(events.find((event) => event.agentClass === 'unknown')?.decision, 'deny');
});

test('用户例外：allow/user、不打 controller 票据（exempt ticket）；暂停仍拒', async () => {
  const { api, controller } = makeApi();
  const read = expectAllow(await api.authorize({ agentKey: USER, tool: 'get_home_content', args: {}, now: T0 }));
  assert.equal(read.exemption, 'user');
  assert.equal(read.counted, false);
  assert.equal(read.ticket.kind, 'exempt');
  const write = expectAllow(await api.authorize({ agentKey: USER, tool: 'publish_content', args: { operationId: 'u1' }, now: T0 }));
  assert.equal(write.ticket.kind, 'exempt');
  assert.equal(controller.calls.reserveRead.length, 0);
  assert.equal(controller.calls.reserveWrite.length, 0);

  controller.setPause({ writePaused: true });
  expectDeny(await api.authorize({ agentKey: USER, tool: 'publish_content', args: { operationId: 'u2' }, now: T0 }), 'write-paused');
  expectAllow(await api.authorize({ agentKey: USER, tool: 'get_home_content', args: {}, now: T0 }), '写暂停不影响用户读');
  controller.setPause({ accessPaused: true });
  expectDeny(await api.authorize({ agentKey: USER, tool: 'get_home_content', args: {}, now: T0 }), 'access-paused');
});

test('后台读 reserve：home/detail counted ticket；search counted:false；accessPaused deny、writePaused 不影响读', async () => {
  const { api, controller } = makeApi();
  const home = expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: { id: 'r1' }, now: T0 }));
  assert.equal(home.counted, false);
  assert.equal(home.ticket.counted, true);
  assert.deepEqual(controller.calls.reserveRead[0], { tool: FULL('get_home_content'), id: 'r1', now: T0 });

  const search = expectAllow(await api.authorize({ agentKey: BG, tool: 'search_content', args: {}, now: T0 }));
  assert.equal(search.counted, false);
  assert.equal(search.ticket.counted, false);
  assert.equal(controller.calls.reserveRead[1].tool, FULL('search_content'));

  controller.setPause({ accessPaused: true });
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: T0 }), 'access-paused');
  controller.setPause({ accessPaused: false, writePaused: true });
  expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: T0 }));
});

test('F-A 用户豁免写入：无 operationId 也 allow exempt（暂停仍最前），后台写仍要求 operationId', async () => {
  const built = makeApi();
  const exempt = expectAllow(await built.api.authorize({ agentKey: USER, tool: 'publish_content', args: { text: 'hello' }, now: T0 }));
  assert.equal(exempt.decision, 'allow');
  assert.equal(exempt.exemption, 'user');
  assert.equal(exempt.counted, false);
  assert.equal(built.controller.calls.reserveWrite.length, 0, '用户豁免不得 reserve/计数');
  // 暂停仍优先于用户豁免
  built.controller.setPause({ accessPaused: true });
  expectDeny(await built.api.authorize({ agentKey: USER, tool: 'publish_content', args: { text: 'x' }, now: T0 }), 'access-paused');
  built.controller.setPause({ accessPaused: false, writePaused: true });
  expectDeny(await built.api.authorize({ agentKey: USER, tool: 'publish_content', args: { text: 'x' }, now: T0 }), 'write-paused');
  // 后台写无 opId 仍 fail-closed
  built.controller.setPause({ writePaused: false });
  expectDeny(await built.api.authorize({ agentKey: BG, tool: 'publish_content', args: { text: 'x' }, now: T0 }), 'invalid-args');
});

test('后台写 reserve：post/comment 映射、operationId 必填；controller 拒绝 reason 透传且不返回 ticket', async () => {
  const { api, controller } = makeApi();
  const post = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_article', args: { operationId: 'post-1' }, now: T0 }));
  assert.equal(post.ticket.kind, 'post');
  assert.equal(controller.calls.reserveWrite[0].kind, 'post');
  expectAllow(await api.authorize({ agentKey: BG, tool: 'reply_comment', args: { operationId: 'c1' }, now: T0 }));
  assert.equal(controller.calls.reserveWrite[1].kind, 'comment');

  const before = controller.calls.reserveWrite.length;
  expectDeny(await api.authorize({ agentKey: BG, tool: 'publish_content', args: {}, now: T0 }), 'invalid-args');
  expectDeny(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 42 }, now: T0 }), 'invalid-args');
  assert.equal(controller.calls.reserveWrite.length, before);

  for (const reason of ['post-daily-cap', 'min-interval', 'unknown-not-replayable']) {
    const fake = makeFakeController({ writeResults: [{ ok: false, reason }] });
    const built = makeApi({ controller: fake });
    const result = await built.api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'cap' }, now: T0 });
    expectDeny(result, reason);
    assert.equal(result.controllerReason, reason);
    assert.equal(result.ticket, undefined);
  }
});

test('misc 工具：allow counted:false、ticket.kind=misc；accessPaused deny、writePaused 不影响', async () => {
  // 含两个凭据工具：来源必须能判定为 owner，否则凭据门禁会先拒（A-2）。
  const { api, controller } = makeApi({ provenanceClassifier: () => 'owner' });
  for (const tool of ['check_login_status', 'get_user_profile', 'interactive_login', 'get_login_qr_code']) {
    const result = expectAllow(await api.authorize({ agentKey: BG, tool, args: {}, now: T0 }));
    assert.equal(result.counted, false);
    assert.equal(result.ticket.kind, 'misc');
  }
  assert.equal(controller.calls.reserveRead.length, 0);
  assert.equal(controller.calls.reserveWrite.length, 0);
  controller.setPause({ writePaused: true });
  expectAllow(await api.authorize({ agentKey: BG, tool: 'check_login_status', args: {}, now: T0 }));
  controller.setPause({ accessPaused: true });
  expectDeny(await api.authorize({ agentKey: BG, tool: 'check_login_status', args: {}, now: T0 }), 'access-paused');
});

test('参数/时钟校验 fail-closed；now 缺省使用注入时钟并传给 reserve', async () => {
  const clockValue = T0 + 12345;
  const { api, controller } = makeApi({ clock: () => clockValue });
  expectDeny(await api.authorize({ agentKey: BG, tool: 42, args: {}, now: T0 }), 'unknown-tool');
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: 'x', now: T0 }), 'invalid-args');
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: [], now: T0 }), 'invalid-args');
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: 'now' }), 'invalid-clock');
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: Number.NaN }), 'invalid-clock');
  expectDeny(await api.authorize({ agentKey: '', tool: 'get_home_content', args: {}, now: T0 }), 'unknown-agent');
  expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: undefined }));
  assert.equal(controller.calls.reserveRead.at(-1).now, clockValue);
});

test('commit：调用 controller.commitTicket；成功 started:true；重复 commit 幂等 already:true', async () => {
  const { api, controller } = makeApi();
  const reserved = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'c-op' }, now: T0 }));
  const committed = await api.commit({ ticket: reserved.ticket, now: T0 + 1 });
  assert.equal(committed.ok, true);
  assert.equal(committed.started, true);
  assert.equal(controller.calls.commit.length, 1);
  assert.equal(controller.calls.commit[0].ticketId, reserved.ticket.ticketId);
  const again = await api.commit({ ticket: reserved.ticket, now: T0 + 2 });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(controller.calls.commit.length, 1, '幂等：不重复调 controller');
});

test('commit 失败/未知/他人票据明确拒绝；persist 失败 fail-closed 并回滚', async () => {
  const fake = makeFakeController({ commitResults: [{ ok: false, reason: 'ticket-expired' }] });
  const { api } = makeApi({ controller: fake });
  const reserved = expectAllow(await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'exp' }, now: T0 }));
  const failed = await api.commit({ ticket: reserved.ticket, now: T0 + 1 });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'ticket-expired');
  assert.equal((await api.commit({ ticket: { ticketId: 'not-issued' }, now: T0 + 1 })).reason, 'invalid-ticket');
  expectDeny(await api.authorize({ agentKey: 'x', tool: 'publish_content', args: { operationId: 'x' }, now: T0 }), 'unknown-agent');
  // 他人（另一个 api 实例）的票据不可 commit。
  const other = makeApi();
  const foreign = expectAllow(await other.api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'f' }, now: T0 })).ticket;
  assert.equal((await api.commit({ ticket: foreign, now: T0 + 1 })).reason, 'invalid-ticket');

  // persist 失败：commit 不得放行，并尝试回滚 controller 刚提交的额度。
  const persistFake = makeFakeController();
  const persistApi = makeApi({ controller: persistFake, persist: async () => { throw new Error('disk full'); } });
  const t = expectAllow(await persistApi.api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'p-fail' }, now: T0 })).ticket;
  const persisted = await persistApi.api.commit({ ticket: t, now: T0 + 1 });
  assert.equal(persisted.ok, false);
  assert.equal(persisted.reason, 'persist-failed');
  assert.equal(persistFake.calls.abort.length, 1, 'persist 失败必须回滚刚提交的额度');
});

test('abort：reserved 释放 / started 回滚都委托 controller；幂等 already 透传', async () => {
  const { api, controller } = makeApi();
  const reserved = expectAllow(await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'a1' }, now: T0 }));
  const released = await api.abort({ ticket: reserved.ticket, now: T0 + 1 });
  assert.equal(released.ok, true);
  assert.equal(released.aborted, true);
  assert.equal(controller.calls.abort.length, 1);

  const fake = makeFakeController({ abortResults: [{ ok: true, aborted: true, already: true, rolledBack: false }] });
  const built = makeApi({ controller: fake });
  const committed = expectAllow(await built.api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'a2' }, now: T0 }));
  await built.api.commit({ ticket: committed.ticket, now: T0 + 1 });
  const again = await built.api.abort({ ticket: committed.ticket, now: T0 + 2 });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal((await built.api.abort({ ticket: { ticketId: 'nope' }, now: T0 + 2 })).reason, 'invalid-ticket');
});

test('complete：reserved → not-started；commit 后 write 才 finish；unknown 语义不变；重复 → already', async () => {
  const { api, controller } = makeApi();
  const reserved = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'cp' }, now: T0 }));
  const premature = await api.complete({ ticket: reserved.ticket, outcome: 'success', now: T0 + 1 });
  assert.equal(premature.ok, false);
  assert.equal(premature.reason, 'not-started');
  assert.equal(controller.calls.finish.length, 0);

  await api.commit({ ticket: reserved.ticket, now: T0 + 1 });
  const done = await api.complete({ ticket: reserved.ticket, outcome: 'unknown', now: T0 + 2 });
  assert.equal(done.ok, true);
  assert.equal(done.unknown, true);
  assert.equal(controller.calls.finish.length, 1);
  assert.equal(controller.calls.finish[0].rest.outcome, 'unknown');

  // read started 票据 complete 只做幂等确认，不调 finish。
  const read = expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: T0 }));
  await api.commit({ ticket: read.ticket, now: T0 + 1 });
  const readComplete = await api.complete({ ticket: read.ticket, outcome: 'success', now: T0 + 2 });
  assert.equal(readComplete.ok, true);
  assert.equal(readComplete.ignored, true);
  assert.equal(controller.calls.finish.length, 1);

  // exempt / misc 忽略。
  const exempt = expectAllow(await api.authorize({ agentKey: USER, tool: 'publish_content', args: { operationId: 'u' }, now: T0 })).ticket;
  assert.equal((await api.complete({ ticket: exempt, outcome: 'failure', now: T0 + 2 })).exempt, true);
  const misc = expectAllow(await api.authorize({ agentKey: BG, tool: 'check_login_status', args: {}, now: T0 })).ticket;
  assert.equal((await api.complete({ ticket: misc, outcome: 'success', now: T0 + 2 })).ignored, true);
});

test('complete 参数校验：outcome/now 非法返回 ok:false；外部 ticket → unknown-ticket', async () => {
  const { api } = makeApi();
  const reserved = expectAllow(await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'p' }, now: T0 }));
  for (const outcome of ['done', '', null, 42]) {
    const result = await api.complete({ ticket: reserved.ticket, outcome, now: T0 + 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-outcome');
  }
  assert.equal((await api.complete({ ticket: reserved.ticket, outcome: 'success', now: 'now' })).reason, 'invalid-clock');
  assert.equal((await api.complete({ ticket: { kind: 'write' }, outcome: 'success', now: T0 + 1 })).reason, 'unknown-ticket');
});

test('审计：authorize/complete 固定字段、无 args 原文；commit/abort 不新增敏感字段', async () => {
  const { api, events } = makeApi();
  expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'audit-op', text: 'SENSITIVE_TEXT' }, now: T0 }));
  expectDeny(await api.authorize({ agentKey: 'x', tool: 'get_home_content', args: {}, now: T0 }));
  const ticket = expectAllow(await api.authorize({ agentKey: USER, tool: 'get_home_content', args: {}, now: T0 })).ticket;
  await api.complete({ ticket, outcome: 'success', now: T0 + 1 });
  const allowedKeys = new Set(['type', 'at', 'tool', 'decision', 'reason', 'exemption', 'agentClass', 'outcome', 'controllerReason']);
  assert.ok(events.length >= 4);
  for (const event of events) {
    assert.ok(['authorize', 'complete'].includes(event.type));
    for (const key of Object.keys(event)) assert.ok(allowedKeys.has(key), `审计含未声明字段 ${key}`);
    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes('SENSITIVE_TEXT'));
    assert.ok(!/cookie|token|secret|password|evidence/i.test(serialized));
  }
});

test('persist：commit / abort(started) / complete 成功后才 await persist；deny/用户例外不 persist', async () => {
  const calls = [];
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake, persist: async () => { calls.push(Date.now()); } });
  const reserved = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'pr' }, now: T0 }));
  assert.equal(calls.length, 0, 'reserve 不改状态，不 persist');
  await api.commit({ ticket: reserved.ticket, now: T0 + 1 });
  assert.equal(calls.length, 1, 'commit 成功后 persist');
  await api.complete({ ticket: reserved.ticket, outcome: 'success', now: T0 + 2 });
  assert.equal(calls.length, 2, 'finish 成功后 persist');
  expectDeny(await api.authorize({ agentKey: BG, tool: 'publish_content', args: {}, now: T0 }), 'invalid-args');
  const exempt = expectAllow(await api.authorize({ agentKey: USER, tool: 'get_home_content', args: {}, now: T0 }));
  await api.complete({ ticket: exempt.ticket, outcome: 'success', now: T0 + 3 });
  assert.equal(calls.length, 2, 'deny/用户例外不 persist');
});

test('集成（真实 controller）：reserve 不计数、commit 计数；12 满后 deny；unknown 不重放；用户例外绕过额度', async () => {
  let now = T0;
  const controller = createXhhOperationController({ clock: () => now });
  const { api } = makeApi({ controller });

  // 12 次 reserved 不计数。
  const tickets = [];
  for (let i = 0; i < 14; i += 1) {
    const tool = i % 2 === 0 ? 'get_home_content' : 'get_post_detail';
    const result = expectAllow(await api.authorize({ agentKey: BG, tool, args: { id: `read-${i}` }, now }));
    tickets.push(result.ticket);
  }
  assert.equal((await controller.status()).read.used, 0, 'reserve 不计数');
  // 第 13 次在 reserved=12 时被 deny。
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: { id: 'read-over' }, now }), 'read-daily-cap');
  // 全部 commit → used=12。
  for (const ticket of tickets) assert.equal((await api.commit({ ticket, now })).started, true);
  assert.equal((await controller.status()).read.used, 14);
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: { id: 'read-over-2' }, now }), 'read-daily-cap');
  // search 不占额度。
  expectAllow(await api.authorize({ agentKey: BG, tool: 'search_content', args: {}, now }));

  // 写：post 2/日 + 3h；reserve 占间隔。
  const post1 = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'post-a' }, now }));
  await api.commit({ ticket: post1.ticket, now });
  expectDeny(await api.authorize({ agentKey: BG, tool: 'publish_article', args: { operationId: 'post-b' }, now }), 'min-interval');
  now += 3 * 60 * 60 * 1000;
  const post2 = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_video', args: { operationId: 'post-c' }, now }));
  await api.commit({ ticket: post2.ticket, now });
  now += 1;
  expectDeny(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'post-d' }, now }), 'post-daily-cap');

  // unknown 不重放。
  const unknownTicket = expectAllow(await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'c-unknown' }, now })).ticket;
  await api.commit({ ticket: unknownTicket, now });
  assert.equal((await api.complete({ ticket: unknownTicket, outcome: 'unknown', now })).ok, true);
  now += 1;
  expectDeny(await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'c-unknown' }, now }), 'unknown-not-replayable');

  // 用户例外不占额度。
  expectAllow(await api.authorize({ agentKey: USER, tool: 'publish_content', args: { operationId: 'user-post' }, now }));
  expectAllow(await api.authorize({ agentKey: USER, tool: 'get_home_content', args: {}, now }));
});

// ── task-82（B3-fix）：F1 complete→abort 退款 / F2 finish 后 commit / F3 persist 重试 / F4 agentKey 绑定 ──

test('F1 读 complete 后 abort 被拒 already-finished（不调 controller），used 不回退；同 id 再 reserve duplicate', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake });
  const reserved = expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: { id: 'f1-read' }, now: T0 })).ticket;
  await api.commit({ ticket: reserved, now: T0 });
  const completed = await api.complete({ ticket: reserved, outcome: 'success', now: T0 + 1 });
  assert.equal(completed.ok, true);
  assert.equal(completed.ignored, true);

  const abortAfterComplete = await api.abort({ ticket: reserved, now: T0 + 2 });
  assert.equal(abortAfterComplete.ok, false);
  assert.equal(abortAfterComplete.reason, 'already-finished');
  assert.equal(fake.calls.abort.length, 0, 'complete 后不得再调用 controller.abortTicket（禁止退款绕过）');

  // 注：fake controller 不实现 opId 去重；同 id 再 reserve 的 duplicate 语义由下方真实 controller 用例覆盖。
});

test('F1 真实 controller：读→commit→complete→abort 被拒，used 保持 1；不能循环退款绕过额度', async () => {
  const controller = createXhhOperationController({ clock: () => T0 });
  const { api } = makeApi({ controller });
  for (let i = 0; i < 14; i += 1) {
    const tool = i % 2 === 0 ? 'get_home_content' : 'get_post_detail';
    const ticket = expectAllow(await api.authorize({ agentKey: BG, tool, args: { id: `f1-real-${i}` }, now: T0 + i })).ticket;
    expectOk(await api.commit({ ticket, now: T0 + i }));
    expectOk(await api.complete({ ticket, outcome: 'success', now: T0 + i }));
    const aborted = await api.abort({ ticket, now: T0 + i + 1 });
    assert.equal(aborted.ok, false, `第 ${i + 1} 次读 complete 后 abort 必须拒绝`);
    assert.equal(aborted.reason, 'already-finished');
  }
  assert.equal((await controller.status()).read.used, 14, 'abort 不得回退已完成的读额度');
  // 已完成读的 opId 不得变成 aborted 后重来（controller 记录仍是 success → duplicate）。
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: { id: 'f1-real-0' }, now: T0 + 100 }), 'duplicate');
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: { id: 'f1-over' }, now: T0 + 100 }), 'read-daily-cap');
});

// ── 额度口径（m33778，最终定论）：以「是否已实际向平台发起调用」为界 ──
//  · 已经发起 —— 即使平台返回失败也计数（读的额度在 commit 时已扣，complete 绝不退还）；
//  · 发起前失败 —— 不计数，退还走 abort 路径。
//
// 历史：这里曾按 m31637「派发失败退还」实现过 complete(failure) → abortTicket 回滚
// （任务号 task-153），被 m33778 判定为违反口径并要求纠正。下面的用例是纠正后的契约。

test('task-153 读 complete=failure 不退还（已发起即计数，used 保持 1）', async () => {
  const controller = createXhhOperationController({ clock: () => T0 });
  const { api } = makeApi({ controller });
  const ticket = expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: { id: 'refund-read-1' }, now: T0 })).ticket;
  expectOk(await api.commit({ ticket, now: T0 }));
  assert.equal((await controller.status()).read.used, 1, 'commit 后先按既有语义扣 1');
  const done = await api.complete({ ticket, outcome: 'failure', now: T0 + 1 });
  assert.equal(done.ok, true);
  assert.equal(done.refunded, undefined, '已派发后失败不得退还');
  assert.equal((await controller.status()).read.used, 1, '平台失败仍计入额度');
  // 失败不得被退款绕过：再 abort 必须被拒（票据已 finished）。
  const aborted = await api.abort({ ticket, now: T0 + 2 });
  assert.equal(aborted.ok, false, 'complete 后 abort 必须拒绝');
  assert.equal(aborted.reason, 'already-finished');
  assert.equal((await controller.status()).read.used, 1, 'abort 被拒后额度不变');
});

test('task-153 读 complete=unknown 不退还（未知不等于没发生）', async () => {
  const controller = createXhhOperationController({ clock: () => T0 });
  const { api } = makeApi({ controller });
  const ticket = expectAllow(await api.authorize({ agentKey: BG, tool: 'get_post_detail', args: { id: 'refund-read-2' }, now: T0 })).ticket;
  expectOk(await api.commit({ ticket, now: T0 }));
  const done = await api.complete({ ticket, outcome: 'unknown', now: T0 + 1 });
  assert.equal(done.refunded, undefined, 'unknown 不得退还');
  assert.equal((await controller.status()).read.used, 1, 'unknown 仍计入额度');
});

test('task-153 发起前 abort 才退还（真实 controller：abort 后 used 回 0）', async () => {
  const controller = createXhhOperationController({ clock: () => T0 });
  const { api } = makeApi({ controller });
  const ticket = expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: { id: 'refund-read-4' }, now: T0 })).ticket;
  expectOk(await api.commit({ ticket, now: T0 }));
  assert.equal((await controller.status()).read.used, 1, 'commit 先扣 1');
  const aborted = await api.abort({ ticket, now: T0 + 1 });
  assert.equal(aborted.ok, true, '发起前中止必须能回滚');
  assert.equal((await controller.status()).read.used, 0, '发起前中止不计额度');
});

test('task-153 complete 全程不触碰 controller.abortTicket（failure/unknown 都不退款）', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake });
  const t1 = expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: { id: 'refund-read-3' }, now: T0 })).ticket;
  expectOk(await api.commit({ ticket: t1, now: T0 }));
  await api.complete({ ticket: t1, outcome: 'failure', now: T0 + 1 });
  const again = await api.complete({ ticket: t1, outcome: 'failure', now: T0 + 2 });
  assert.equal(again.ignored, true);
  const t2 = expectAllow(await api.authorize({ agentKey: BG, tool: 'get_post_detail', args: { id: 'refund-read-5' }, now: T0 + 3 })).ticket;
  expectOk(await api.commit({ ticket: t2, now: T0 + 3 }));
  await api.complete({ ticket: t2, outcome: 'unknown', now: T0 + 4 });
  assert.equal(fake.calls.abort.length, 0, 'complete 一律不得调用 abortTicket（禁止退款绕过）');
});

test('F2 finish / unknown 后 commit 拒绝（仅 started 幂等），不再 returned started', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake });
  const write = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'f2-write' }, now: T0 })).ticket;
  expectOk(await api.commit({ ticket: write, now: T0 }));
  expectOk(await api.complete({ ticket: write, outcome: 'success', now: T0 + 1 }));
  const afterFinish = await api.commit({ ticket: write, now: T0 + 2 });
  assert.equal(afterFinish.ok, false);
  assert.equal(afterFinish.reason, 'already-finished');
  assert.equal(fake.calls.commit.length, 1, 'finish 后不得再调 controller.commitTicket');

  const unknownTicket = expectAllow(await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'f2-unknown' }, now: T0 })).ticket;
  expectOk(await api.commit({ ticket: unknownTicket, now: T0 }));
  expectOk(await api.complete({ ticket: unknownTicket, outcome: 'unknown', now: T0 + 1 }));
  const unknownCommit = await api.commit({ ticket: unknownTicket, now: T0 + 2 });
  assert.equal(unknownCommit.ok, false);
  assert.equal(unknownCommit.reason, 'already-finished');

  // 仅 started 幂等 already:true。
  const started = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_article', args: { operationId: 'f2-started' }, now: T0 })).ticket;
  expectOk(await api.commit({ ticket: started, now: T0 }));
  const idempotent = await api.commit({ ticket: started, now: T0 + 1 });
  assert.equal(idempotent.ok, true);
  assert.equal(idempotent.already, true);
});

test('F3 complete persist 失败重试：重试仍 persist（不重复 finish），成功清 pending；持续失败仍 persist-failed', async () => {
  // 让 commit 的 persist 成功、complete 首次 persist 失败、重试成功。
  let persistCalls = 0;
  const fake = makeFakeController();
  const { api } = makeApi({
    controller: fake,
    persist: async () => {
      persistCalls += 1;
      if (persistCalls === 2) throw new Error('disk full');
    },
  });
  const ticket = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'f3-op' }, now: T0 })).ticket;
  expectOk(await api.commit({ ticket, now: T0 })); // persist #1 ok
  const firstComplete = await api.complete({ ticket, outcome: 'success', now: T0 + 1 }); // persist #2 fail
  assert.equal(firstComplete.ok, false);
  assert.equal(firstComplete.reason, 'persist-failed');
  const retried = await api.complete({ ticket, outcome: 'success', now: T0 + 2 }); // persist #3 ok
  assert.equal(retried.ok, true);
  assert.equal(retried.completed, true);
  assert.equal(persistCalls, 3, '重试必须再次 persist');
  assert.equal(fake.calls.finish.length, 1, '重试不得重复 controller.finish');

  // 持续失败：commit persist 成功后，complete 永远失败 → 每次都 persist-failed。
  let calls = 0;
  const alwaysFake = makeFakeController();
  const always = makeApi({
    controller: alwaysFake,
    persist: async () => {
      calls += 1;
      if (calls >= 2) throw new Error('disk full');
    },
  });
  const t2 = expectAllow(await always.api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'f3-always' }, now: T0 })).ticket;
  expectOk(await always.api.commit({ ticket: t2, now: T0 }));
  assert.equal((await always.api.complete({ ticket: t2, outcome: 'success', now: T0 + 1 })).reason, 'persist-failed');
  assert.equal((await always.api.complete({ ticket: t2, outcome: 'success', now: T0 + 2 })).reason, 'persist-failed');
  assert.equal(alwaysFake.calls.finish.length, 1, '持续失败也不得重复 finish');
});

test('F4 agentKey 绑定：commit/abort/complete 提供 agentKey 时必须与票据一致；不提供保持兼容', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake });
  const ticket = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'f4-op' }, now: T0 })).ticket;
  assert.equal(ticket.agentKey, BG);
  assert.equal((await api.commit({ ticket, agentKey: USER, now: T0 })).reason, 'invalid-ticket');
  assert.equal((await api.abort({ ticket, agentKey: USER, now: T0 })).reason, 'invalid-ticket');
  expectOk(await api.commit({ ticket, agentKey: BG, now: T0 }));
  assert.equal((await api.complete({ ticket, agentKey: USER, outcome: 'success', now: T0 + 1 })).reason, 'invalid-ticket');
  // 不提供 agentKey：向后兼容（文档化），仍可完成。
  const done = await api.complete({ ticket, outcome: 'success', now: T0 + 2 });
  assert.equal(done.ok, true);
  assert.equal(fake.calls.finish.length, 1);
});

// ── task-129：misc（登录/资料/二维码）票据必须带 ticketId，插件才能 commit/dispatch ──
// 缺陷背景：authorize 对 misc 返回无 ticketId 的票据；DSH 插件对非豁免 allow 强制要求
// ticketId 并 commit，否则 missing-ticket 拒绝 → 插件启用后 check_login_status /
// get_user_profile / get_login_qr_code 全不可用（fail-closed 方向安全但功能被误禁）。
// 修复语义：misc 票据签发 ticketId 并登记；commit/abort 对 misc 为空操作（不触 controller、
// 不计数、不 persist）；complete 维持幂等忽略。额度/pause/readOnly 边界不变。

const MISC_TOOLS = Object.freeze(['check_login_status', 'get_user_profile', 'get_login_qr_code']);
const CHAIN_TOKEN = 'isolated-task129-token';

test('task-129 misc 票据：签发 ticketId；commit/abort 空操作且零 controller 计数；complete 幂等忽略', async () => {
  const fake = makeFakeController();
  const { api, events } = makeApi({ controller: fake, provenanceClassifier: () => 'owner' });
  for (const tool of [...MISC_TOOLS, 'interactive_login']) {
    const allowed = expectAllow(await api.authorize({ agentKey: BG, tool, args: {}, now: T0 }), tool);
    assert.equal(allowed.counted, false);
    assert.equal(allowed.ticket.kind, 'misc');
    assert.equal(typeof allowed.ticket.ticketId, 'string', `${tool} 必须签发 ticketId`);
    assert.ok(allowed.ticket.ticketId.length > 0, `${tool} ticketId 不得为空`);

    const committed = await api.commit({ ticket: allowed.ticket, agentKey: BG, now: T0 + 1 });
    assert.equal(committed.ok, true, `${tool} commit 必须成功`);
    assert.equal(committed.started, true);
    assert.equal(committed.ticket.kind, 'misc');
    assert.equal(committed.ticket.ticketId, allowed.ticket.ticketId, 'started 票据必须保留 ticketId');

    const completed = await api.complete({ ticket: committed.ticket, agentKey: BG, outcome: 'success', now: T0 + 2 });
    assert.equal(completed.ok, true);
    assert.equal(completed.ignored, true);
  }
  assert.equal(fake.calls.reserveRead.length, 0);
  assert.equal(fake.calls.reserveWrite.length, 0);
  assert.equal(fake.calls.commit.length, 0, 'misc commit 不得触碰 controller');
  assert.equal(fake.calls.abort.length, 0, 'misc abort 不得触碰 controller');
  assert.equal(fake.calls.finish.length, 0, 'misc complete 不得触碰 controller');
  assert.ok(events.some((event) => event.type === 'complete' && event.tool === 'mcp__xiaoheihe__check_login_status'));
});

test('task-129 misc abort：空操作且不触 controller；abort 后 complete 仍幂等忽略', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake });
  const ticket = expectAllow(await api.authorize({ agentKey: BG, tool: 'check_login_status', args: {}, now: T0 })).ticket;
  const aborted = await api.abort({ ticket, agentKey: BG, now: T0 + 1 });
  assert.equal(aborted.ok, true);
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.rolledBack, false, 'misc 不占额度，无可回滚额度');
  assert.equal(fake.calls.abort.length, 0);
  const completed = await api.complete({ ticket, agentKey: BG, outcome: 'failure', now: T0 + 2 });
  assert.equal(completed.ignored, true);
});

test('task-129 readOnly：misc 放行、写工具 deny read-only-mode、零 controller reserve', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake, readOnly: true, provenanceClassifier: () => 'owner' });
  for (const tool of MISC_TOOLS) expectAllow(await api.authorize({ agentKey: BG, tool, args: {}, now: T0 }), tool);
  expectDeny(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'ro-bg' }, now: T0 }), 'read-only-mode');
  expectDeny(await api.authorize({ agentKey: USER, tool: 'post_comment', args: {}, now: T0 }), 'read-only-mode');
  assert.equal(fake.calls.reserveRead.length, 0);
  assert.equal(fake.calls.reserveWrite.length, 0);
});

/** 起真实 HTTP 授权链：route + authorize-server + 真实 authorize-api（controller 为假计数）。 */
function startChain(api) {
  const routes = createXhhAuthorizeRoutes({ consoleToken: CHAIN_TOKEN, backgroundSessionKeys: [BG], authorizeApi: api });
  return startOnFetchablePort(async (port) => {
    const server = createXhhAuthorizeServer({ routes, port });
    const info = await server.start();
    return { server, url: info.url };
  });
}

/** 真实插件（HTTP 模式），返回 tools/execute 钩子。 */
function startGuardThroughHttp(url) {
  const listeners = new Map();
  const warnings = [];
  const ctx = {
    on(name, fn) { listeners.set(name, fn); return () => {}; },
    tools: { guard(fn) { return () => {}; } },
    logger: { warn(message) { warnings.push(String(message)); } },
  };
  applyXhhQuotaGuard(ctx, { enabled: true, timeoutMs: 500, bridgeUrl: `${url}/api/xiaoheihe`, consoleToken: CHAIN_TOKEN });
  return { listeners, warnings };
}

function chainExec(short, agentKey = BG) {
  return { name: FULL(short), arguments: {}, agent: { id: agentKey, session: { id: agentKey } }, signal: { aborted: false } };
}

async function runChainExecute(listeners, execValue) {
  const hook = listeners.get('tools/execute');
  assert.equal(typeof hook, 'function', '插件必须注册 tools/execute');
  const dispatched = [];
  const result = await hook(execValue, async () => { dispatched.push(true); return { isError: false, content: [{ type: 'text', text: 'misc-tool-ok' }] }; });
  return { result, dispatched };
}

test('task-129 真实 HTTP 链：插件→route→authorize-api，misc 三类工具各 dispatch 一次、零额度、无 missing-ticket', async () => {
  const fake = makeFakeController();
  const { api, events } = makeApi({ controller: fake, provenanceClassifier: () => 'owner' });
  const { server, url } = await startChain(api);
  try {
    const { listeners, warnings } = startGuardThroughHttp(url);
    assert.deepEqual(warnings, [], 'active 模式不应降级 fallback');
    for (const tool of MISC_TOOLS) {
      const { result, dispatched } = await runChainExecute(listeners, chainExec(tool));
      assert.equal(dispatched.length, 1, `${tool} 必须 dispatch 一次（修复前 missing-ticket 会 0 次）`);
      assert.equal(result.isError, false, `${tool} 不得被 missing-ticket 拒绝：${JSON.stringify(result)}`);
    }
    assert.equal(fake.calls.reserveRead.length, 0);
    assert.equal(fake.calls.reserveWrite.length, 0);
    assert.equal(fake.calls.commit.length, 0, 'misc 不得计额度');
    assert.equal(fake.calls.finish.length, 0);
    const allows = events.filter((event) => event.type === 'authorize' && event.decision === 'allow');
    assert.ok(allows.length >= MISC_TOOLS.length);
    assert.ok(events.some((event) => event.type === 'complete'));
  } finally {
    await server.stop();
  }
});

test('task-129 真实 HTTP 链边界：accessPaused 拒绝 misc；writePaused 放行 misc', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake });
  const { server, url } = await startChain(api);
  try {
    const { listeners } = startGuardThroughHttp(url);
    fake.setPause({ accessPaused: true });
    const denied = await runChainExecute(listeners, chainExec('check_login_status'));
    assert.equal(denied.dispatched.length, 0, 'accessPaused 时 misc 不得 dispatch');
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /access-paused/);

    fake.setPause({ accessPaused: false, writePaused: true });
    const allowed = await runChainExecute(listeners, chainExec('get_user_profile'));
    assert.equal(allowed.dispatched.length, 1, 'writePaused 只暂停写，misc 应放行');
    assert.equal(allowed.result.isError, false);
  } finally {
    await server.stop();
  }
});

test('task-129 真实 HTTP 链只读：misc 放行、写工具 read-only-mode 拦截且不 dispatch', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake, readOnly: true, provenanceClassifier: () => 'owner' });
  const { server, url } = await startChain(api);
  try {
    const { listeners } = startGuardThroughHttp(url);
    const misc = await runChainExecute(listeners, chainExec('get_login_qr_code'));
    assert.equal(misc.dispatched.length, 1, '只读模式不得拦 misc');
    assert.equal(misc.result.isError, false);

    const write = await runChainExecute(listeners, { name: FULL('publish_content'), arguments: { operationId: 'ro-http' }, agent: { id: BG, session: { id: BG } }, signal: { aborted: false } });
    assert.equal(write.dispatched.length, 0);
    assert.equal(write.result.isError, true);
    assert.match(write.result.content[0].text, /read-only-mode/);
    assert.equal(fake.calls.reserveWrite.length, 0, 'read-only 拒绝必须在 reserve 之前');
  } finally {
    await server.stop();
  }
});

test('task-129 复审 P2-1：misc complete 后票据必须终结（可驱逐、重复 commit 拒绝），且全链绝不 persist', async () => {
  const fake = makeFakeController();
  const persistCalls = [];
  const { api } = makeApi({ controller: fake, persist: async () => { persistCalls.push(1); } });

  const allowed = expectAllow(await api.authorize({ agentKey: BG, tool: 'check_login_status', args: {}, now: T0 }));
  assert.equal(typeof allowed.ticket.ticketId, 'string');
  const committed = await api.commit({ ticket: allowed.ticket, agentKey: BG, now: T0 + 1 });
  assert.equal(committed.ok, true);
  assert.equal(committed.started, true);

  const completed = await api.complete({ ticket: committed.ticket, agentKey: BG, outcome: 'success', now: T0 + 2 });
  assert.equal(completed.ok, true);
  assert.equal(completed.ignored, true);

  // 复审 P2-1：complete 若不把票据推进终态，issuedTickets 驱逐（跳过 reserved/started）永远
  // 不会回收 misc 条目，512 上限对其失效；同时终态票据重复 commit 必须被拒绝（对齐 read/write）。
  const recommit = await api.commit({ ticket: committed.ticket, agentKey: BG, now: T0 + 3 });
  assert.equal(recommit.ok, false, 'misc complete 后重复 commit 必须拒绝');
  assert.equal(recommit.reason, 'already-finished');

  const recomplete = await api.complete({ ticket: committed.ticket, agentKey: BG, outcome: 'success', now: T0 + 4 });
  assert.equal(recomplete.ok, true);
  assert.equal(recomplete.ignored, true);

  assert.equal(persistCalls.length, 0, 'misc 全链不得 persist');
  assert.equal(fake.calls.commit.length, 0, 'misc commit 不得触碰 controller');
  assert.equal(fake.calls.finish.length, 0, 'misc complete 不得触碰 controller');
});

test('task-132 writeBlocker：阻塞时所有写工具 deny，读/搜索放行且零 reserveWrite', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake, writeBlocker: () => ({ blocked: true, reason: 'reconcile-blocked' }) });
  const write = await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'wb-1' }, now: T0 });
  expectDeny(write, 'reconcile-blocked', '阻塞时写必须 deny');
  const userWrite = await api.authorize({ agentKey: USER, tool: 'post_comment', args: { operationId: 'wb-2' }, now: T0 });
  expectDeny(userWrite, 'reconcile-blocked', '用户来源写也不得绕过');
  expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: T0 }), '读放行');
  expectAllow(await api.authorize({ agentKey: BG, tool: 'search_content', args: { keyword: 'x' }, now: T0 }), '搜索放行');
  assert.equal(fake.calls.reserveWrite.length, 0, '阻塞时不得占用写额度');
});

test('task-132 writeBlocker 抛错：fail-closed 为 write-block-query-failed', async () => {
  const fake = makeFakeController();
  const { api } = makeApi({ controller: fake, writeBlocker: () => { throw new Error('reconcile store unavailable'); } });
  expectDeny(await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'wb-3' }, now: T0 }), 'write-block-query-failed');
  assert.equal(fake.calls.reserveWrite.length, 0);
});

test('task-132 writeBlocker 非阻塞时写照常放行并占额度', async () => {
  const fake = makeFakeController();
  const calls = [];
  const { api } = makeApi({ controller: fake, writeBlocker: () => { calls.push(1); return { blocked: false }; } });
  const write = await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'wb-4' }, now: T0 });
  expectAllow(write, '未阻塞时写放行');
  assert.equal(calls.length, 1, '写工具必须查询一次门禁');
  assert.equal(fake.calls.reserveWrite.length, 1, '未阻塞必须占用写额度');
});

test('task-132 writeBlocker 类型非法时构造期 TypeError', () => {
  assert.throws(() => createXhhAuthorizeApi({ controller: makeFakeController(), backgroundSessionKeys: [BG], writeBlocker: 'nope' }), TypeError);
});

test('writeBlocker 非法返回值不能放行写操作', async () => {
  for (const value of [{}, { blocked: 'true' }, { blocked: 0 }, Promise.resolve({ blocked: false })]) {
    const { api } = makeApi({ controller: makeFakeController(), writeBlocker: () => value });
    const result = await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'invalid-blocker' }, now: T0 });
    expectDeny(result, 'write-blocked', '非法返回值必须拒绝');
  }
});

test('并发写 commit：第一笔尚未完成时第二笔不得越过门禁', async () => {
  const controller = makeFakeController();
  const originalCommit = controller.commitTicket.bind(controller);
  let releaseFirst;
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let pending = false;
  let calls = 0;
  controller.commitTicket = async (ticket) => {
    calls += 1;
    if (calls === 1) {
      firstEntered();
      await gate;
      pending = true;
    }
    return originalCommit(ticket);
  };
  const { api } = makeApi({ controller, writeBlocker: () => ({ blocked: pending, reason: 'unconfirmed-write' }) });
  const a = expectAllow(await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'race-a' }, now: T0 }));
  const b = expectAllow(await api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'race-b' }, now: T0 }));
  const first = api.commit({ ticket: a.ticket, agentKey: BG, now: T0 });
  await entered;
  const second = api.commit({ ticket: b.ticket, agentKey: BG, now: T0 });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, false);
  assert.equal(two.reason, 'unconfirmed-write');
  assert.equal(calls, 1);
});

// ── A-1 凭据桶（interactive_login / get_login_qr_code）────────────────────────
// 用户 2026-10-29 冻结规格：这两个工具既不是读也不是写（isWrite=false），readOnly 与后台
// 写门禁都管不到它们，必须独立成桶；patrol/unknown 拒并给可执行提示，owner 不限次，
// group 整机 30 分钟最多 1 次；未注入 provenanceClassifier 的旧调用方保持旧行为。
const GROUP = 'group:999888777';
const CREDENTIALS = [...XHH_AUTHORIZE_CREDENTIAL_TOOLS];

function credApi({ map = {}, options = {} } = {}) {
  const table = { [BG]: 'patrol', [GROUP]: 'group', [USER]: 'owner', ...map };
  return makeApi({
    backgroundSessionKeys: [BG, GROUP],
    provenanceClassifier: (agentKey) => table[agentKey] ?? 'unknown',
    ...options,
  });
}

test('A-1 规格冻结：凭据桶与读/写桶互不相交，冷却为 30 分钟且提示非空', () => {
  assert.deepEqual([...XHH_AUTHORIZE_CREDENTIAL_TOOLS].sort(), ['get_login_qr_code', 'interactive_login']);
  assert.equal(XHH_AUTHORIZE_CREDENTIAL_COOLDOWN_MS, 30 * 60 * 1000);
  assert.equal(typeof XHH_AUTHORIZE_CREDENTIAL_DENY_HINT, 'string');
  assert.ok(XHH_AUTHORIZE_CREDENTIAL_DENY_HINT.length > 0);
  const cred = new Set(XHH_AUTHORIZE_CREDENTIAL_TOOLS);
  assert.equal(XHH_AUTHORIZE_READ_TOOLS.some((tool) => cred.has(tool)), false, '凭据桶不得与读桶重叠');
  assert.equal(XHH_AUTHORIZE_WRITE_TOOLS.some((tool) => cred.has(tool)), false, '凭据桶不得与写桶重叠');
  // check_login_status 是读（免额度），绝不能滑进凭据桶
  assert.equal(cred.has('check_login_status'), false);
  assert.equal(XHH_AUTHORIZE_TOOL_NAMES.includes('check_login_status'), true);
  for (const tool of CREDENTIALS) {
    assert.equal(XHH_AUTHORIZE_TOOL_NAMES.includes(tool), true, `${tool} 必须是已知工具`);
  }
});

test('A-1 patrol 来源发起登录：deny credential-requires-user-present + 提示，提示不进审计', async () => {
  const { api, controller, events } = credApi();
  for (const tool of CREDENTIALS) {
    const result = await api.authorize({ agentKey: BG, tool, args: {}, now: T0 });
    expectDeny(result, 'credential-requires-user-present', tool);
    assert.equal(result.hint, XHH_AUTHORIZE_CREDENTIAL_DENY_HINT, `${tool} 必须带可执行提示`);
    assert.equal(result.retryAfterMs, undefined, '非冷却拒绝不带 retryAfterMs');
  }
  const denied = events.filter((event) => event.type === 'authorize' && event.decision === 'deny');
  assert.equal(denied.length, CREDENTIALS.length);
  for (const event of denied) {
    assert.equal(event.reason, 'credential-requires-user-present');
    assert.equal(event.hint, undefined, '提示文案不进审计白名单（审计只钉「为何拒绝」）');
    assert.equal(event.retryAfterMs, undefined);
  }
  assert.equal(controller.calls.reserveRead.length, 0);
  assert.equal(controller.calls.reserveWrite.length, 0);
});

test('A-1 unknown 来源发起登录：deny 且 reason 与 patrol 可区分', async () => {
  // 让一个合法 agentKey 产出 unknown provenance：来源不可判定，但 agentClass 仍能通过前置校验。
  const { api } = credApi({ map: { [GROUP]: 'unknown' } });
  const result = await api.authorize({ agentKey: GROUP, tool: 'get_login_qr_code', args: {}, now: T0 });
  expectDeny(result, 'credential-source-unknown');
  assert.equal(result.hint, XHH_AUTHORIZE_CREDENTIAL_DENY_HINT);

  const patrol = await api.authorize({ agentKey: BG, tool: 'get_login_qr_code', args: {}, now: T0 });
  expectDeny(patrol, 'credential-requires-user-present');
  assert.notEqual(patrol.reason, result.reason, 'patrol 与 unknown 必须可区分');
});

test('A-1 owner 发起登录：不限次放行，走可追踪的 misc 生命周期且不计额度', async () => {
  const { api, controller } = credApi();
  for (let index = 0; index < 3; index += 1) {
    const allowed = expectAllow(await api.authorize({
      agentKey: USER,
      tool: 'interactive_login',
      args: {},
      now: T0 + index * 1000,
    }), `owner 第 ${index + 1} 次`);
    assert.equal(allowed.counted, false);
    // 凭据类刻意不走「用户豁免」的提前返回：豁免票据在插件侧不经过 commit/complete，
    // 生命周期不存在 ⇒ 登录归属通知永远发不出（复审 P1）。改走 misc：同样不计额度，但可追踪。
    assert.equal(allowed.ticket.kind, 'misc', '凭据类必须走 misc 生命周期');
    assert.equal(allowed.ticket.credential, true);
    assert.equal(typeof allowed.ticket.ticketId, 'string');
  }
  assert.equal(controller.calls.reserveRead.length, 0);
  assert.equal(controller.calls.reserveWrite.length, 0, '凭据工具不得打 controller 写票据');
});

test('A-1 回归：owner 的普通写操作仍走用户豁免（不得被凭据改造带偏）', async () => {
  const { api, controller } = credApi();
  const allowed = expectAllow(await api.authorize({
    agentKey: USER,
    tool: 'post_comment',
    args: {},
    now: T0,
  }));
  assert.equal(allowed.exemption, 'user', '用户豁免的既有语义必须原样保留');
  assert.equal(allowed.counted, false);
  assert.equal(allowed.ticket.kind, 'exempt');
  assert.equal(allowed.ticket.credential, false);
  assert.equal(controller.calls.reserveWrite.length, 0);
});

test('A-1 group 发起登录：整机 30 分钟最多 1 次，超限 deny credential-cooldown 并给剩余时间', async () => {
  const otherGroup = 'group:111222333';
  const { api } = makeApi({
    backgroundSessionKeys: [BG, GROUP, otherGroup],
    provenanceClassifier: (agentKey) => (agentKey === BG ? 'patrol' : 'group'),
  });
  expectAllow(await api.authorize({ agentKey: GROUP, tool: 'get_login_qr_code', args: {}, now: T0 }), '首次');

  const blocked = await api.authorize({ agentKey: GROUP, tool: 'interactive_login', args: {}, now: T0 + 1000 });
  expectDeny(blocked, 'credential-cooldown');
  assert.equal(blocked.hint, XHH_AUTHORIZE_CREDENTIAL_DENY_HINT);
  assert.equal(blocked.retryAfterMs, XHH_AUTHORIZE_CREDENTIAL_COOLDOWN_MS - 1000, '剩余时间必须精确');

  // 冷却期内换一个群也不行：这是整机限制，不是按群计数
  const cross = await api.authorize({ agentKey: otherGroup, tool: 'interactive_login', args: {}, now: T0 + 2000 });
  expectDeny(cross, 'credential-cooldown');

  // 到点即放行（边界取 +1ms，验证不是「>= 30 分钟仍拒」的差一错误）
  expectAllow(await api.authorize({
    agentKey: GROUP,
    tool: 'interactive_login',
    args: {},
    now: T0 + XHH_AUTHORIZE_CREDENTIAL_COOLDOWN_MS + 1,
  }), '31 分钟后');
});

test('A-1/A-2 兼容与优先级：未注入 classifier 时凭据类按 unknown 拒绝、普通工具仍放行；readOnly 下凭据照常、写仍拒', async () => {
  // ① 用户 2026-10-29 口径：来源不可判定（provenance === null）不得再当放行依据。
  //    legacy 身份模式正落在这一条路径上 —— 凭据类必须和 patrol 一样被拒。
  const legacy = makeApi();
  expectDeny(
    await legacy.api.authorize({ agentKey: BG, tool: 'interactive_login', args: {}, now: T0 }),
    'credential-source-unknown',
    '旧调用方未注入 classifier ⇒ 来源不可判定 ⇒ 凭据类拒绝',
  );
  expectDeny(
    await legacy.api.authorize({ agentKey: BG, tool: 'get_login_qr_code', args: {}, now: T0 }),
    'credential-source-unknown',
  );
  // 但「旧兼容」对非凭据工具仍然成立（不破坏既有部署的读/写路径）。
  expectAllow(await legacy.api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: T0 }), '旧调用方读');
  expectAllow(
    await legacy.api.authorize({ agentKey: BG, tool: 'post_comment', args: { operationId: 'a1-legacy-write' }, now: T0 }),
    '旧调用方写（未被凭据门禁牵连）',
  );

  // ② readOnly 模板下：凭据工具不受 readOnly 影响（它们 isWrite=false），写操作用旧理由拒
  const { api } = credApi({ options: { readOnly: true } });
  expectAllow(await api.authorize({ agentKey: USER, tool: 'get_login_qr_code', args: {}, now: T0 }), 'readOnly 下');
  expectDeny(await api.authorize({
    agentKey: USER,
    tool: 'post_comment',
    args: { operationId: 'a1-readonly-write' },
    now: T0,
  }), 'read-only-mode', 'readOnly 的拒绝理由不得被凭据门禁改写');
});

test('A-1 归属通知：只在凭据类工具完成时调用一次，异常不影响回执', async () => {
  const notified = [];
  const { api } = credApi({ options: { credentialNotify: async (payload) => { notified.push(payload); } } });

  const credTicket = expectAllow(await api.authorize({ agentKey: USER, tool: 'interactive_login', args: {}, now: T0 })).ticket;
  const committed = await api.commit({ ticket: credTicket, agentKey: USER, now: T0 + 1 });
  const done = await api.complete({ ticket: committed.ticket, agentKey: USER, outcome: 'success', now: T0 + 2 });
  assert.equal(done.ok, true);
  assert.equal(notified.length, 1, '凭据工具完成必须通知一次');
  assert.equal(notified[0].tool, 'interactive_login');
  assert.equal(notified[0].outcome, 'success');

  // check_login_status 是读、走 misc 分支，但不是凭据类 ⇒ 不发通知
  const readTicket = expectAllow(await api.authorize({ agentKey: USER, tool: 'check_login_status', args: {}, now: T0 })).ticket;
  const readCommitted = await api.commit({ ticket: readTicket, agentKey: USER, now: T0 + 1 });
  await api.complete({ ticket: readCommitted.ticket, agentKey: USER, outcome: 'success', now: T0 + 2 });
  assert.equal(notified.length, 1, '非凭据工具不得触发归属通知');

  // 通知抛错：回执仍是 ok（票据已终结，通知是旁路）
  const throwing = credApi({ options: { credentialNotify: async () => { throw new Error('qq down'); } } });
  const t2 = expectAllow(await throwing.api.authorize({ agentKey: USER, tool: 'get_login_qr_code', args: {}, now: T0 })).ticket;
  const c2 = await throwing.api.commit({ ticket: t2, agentKey: USER, now: T0 + 1 });
  const d2 = await throwing.api.complete({ ticket: c2.ticket, agentKey: USER, outcome: 'unknown', now: T0 + 2 });
  assert.equal(d2.ok, true, '通知失败不得改变登录回执');
});

test('A-1 归属通知幂等：重复 complete 同一次登录只通知一次', async () => {
  const notified = [];
  const { api } = credApi({ options: { credentialNotify: async (payload) => { notified.push(payload); } } });
  const ticket = expectAllow(await api.authorize({ agentKey: USER, tool: 'interactive_login', args: {}, now: T0 })).ticket;
  const committed = await api.commit({ ticket, agentKey: USER, now: T0 + 1 });
  // 复审 P2-6：complete 被 await 且幂等分支也会走到 —— 同一次登录不能被报两遍。
  const first = await api.complete({ ticket: committed.ticket, agentKey: USER, outcome: 'success', now: T0 + 2 });
  const second = await api.complete({ ticket: committed.ticket, agentKey: USER, outcome: 'success', now: T0 + 3 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(notified.length, 1, '重复 complete 不得重复通知');
});

// ── A-2 降级只读层（xiaoheihe-degrade）─────────────────────────────────────────
// 用户 2026-10-29 口径：
//  · 守卫不可用/身份不可判定 ⇒ 降级只读：写全拒、读放行但必须计入额度、凭据类拒绝；
//  · 通知失败/未知 ⇒ 全停（模块负责），此处必须读写全拒；
//  · 降级快照查询失败 ⇒ 按全停 fail-closed（不能当没事发生）。
function fakeDegrade(level, extra = {}) {
  return {
    snapshot() {
      if (extra.throwOnSnapshot === true) throw new Error('degrade query failed');
      return {
        level,
        blockWrite: level !== 'normal',
        blockAll: level === 'paused',
        trigger: extra.trigger ?? null,
        notify: extra.notify ?? { status: null, attempts: 0 },
      };
    },
  };
}

test('A-2 降级全停：读/写/凭据一律 degrade-paused，且不 reserve', async () => {
  const { api, controller } = credApi({ options: { degrade: fakeDegrade('paused') } });
  expectDeny(await api.authorize({ agentKey: USER, tool: 'get_home_content', args: {}, now: T0 }), 'degrade-paused');
  expectDeny(await api.authorize({ agentKey: USER, tool: 'search_content', args: {}, now: T0 }), 'degrade-paused');
  expectDeny(await api.authorize({ agentKey: USER, tool: 'get_user_profile', args: {}, now: T0 }), 'degrade-paused');
  expectDeny(await api.authorize({ agentKey: USER, tool: 'post_comment', args: { operationId: 'a2-paused' }, now: T0 }), 'degrade-paused');
  expectDeny(await api.authorize({ agentKey: USER, tool: 'interactive_login', args: {}, now: T0 }), 'degrade-paused');
  expectDeny(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: T0 }), 'degrade-paused');
  assert.equal(controller.calls.reserveRead.length, 0, '全停时不得预占读额度');
  assert.equal(controller.calls.reserveWrite.length, 0, '全停时不得预占写额度');
});

test('A-2 降级只读：写拒 degrade-read-only、读放行、凭据按来源判定', async () => {
  const { api } = credApi({ options: { degrade: fakeDegrade('read-only') } });
  // 写：owner 也不例外（降级来自身份不可靠，不是人工开关）
  expectDeny(
    await api.authorize({ agentKey: USER, tool: 'post_comment', args: { operationId: 'a2-ro-owner' }, now: T0 }),
    'degrade-read-only',
  );
  expectDeny(
    await api.authorize({ agentKey: BG, tool: 'publish_content', args: { operationId: 'a2-ro-patrol' }, now: T0 }),
    'degrade-read-only',
  );
  // 读：放行（含平时免额的 search / get_user_profile / check_login_status）
  for (const tool of ['get_home_content', 'get_post_detail', 'search_content', 'get_user_profile', 'check_login_status']) {
    expectAllow(await api.authorize({ agentKey: USER, tool, args: {}, now: T0 }), `降级只读期读：${tool}`);
  }
  // 凭据：patrol / 来源不明 拒绝，owner 放行（扫码本身就是人工因子）
  expectDeny(
    await api.authorize({ agentKey: BG, tool: 'interactive_login', args: {}, now: T0 }),
    'credential-requires-user-present',
  );
  expectAllow(await api.authorize({ agentKey: USER, tool: 'interactive_login', args: {}, now: T0 }), 'owner 凭据');
});

test('A-2 降级只读：免额读被强制计入额度（forceCount），且凭据票据不计额', async () => {
  // 用 GROUP 来源：它属于 background（不触发「用户豁免」提前返回），但读路径仍走 reserveRead。
  const { api, controller } = credApi({ options: { degrade: fakeDegrade('read-only') } });
  for (const tool of ['search_content', 'get_user_profile', 'check_login_status']) {
    const allowed = expectAllow(await api.authorize({ agentKey: GROUP, tool, args: {}, now: T0 }), tool);
    assert.equal(allowed.ticket.kind, 'read', `${tool} 降级期必须走读票据（不再走 misc 免额）`);
    assert.equal(allowed.ticket.counted, true, `${tool} 降级期必须计入读额度`);
  }
  const forceFlags = controller.calls.reserveRead.map((call) => call.forceCount === true);
  assert.deepEqual(forceFlags, [true, true, true], '三个免额读都必须带 forceCount:true 交给 controller');
  // 非降级（normal）时同一批工具维持旧的免额语义
  const normal = credApi({ options: { degrade: fakeDegrade('normal') } });
  const misc = expectAllow(await normal.api.authorize({ agentKey: GROUP, tool: 'check_login_status', args: {}, now: T0 })).ticket;
  assert.equal(misc.kind, 'misc', 'normal 级下 check_login_status 仍是免额 misc');
  assert.equal(normal.controller.calls.reserveRead.length, 0, 'normal 级下免额读不得预占读额度');
});

test('A-2 降级快照查询抛错 ⇒ fail-closed 按全停拒绝', async () => {
  const { api } = credApi({ options: { degrade: fakeDegrade('normal', { throwOnSnapshot: true }) } });
  expectDeny(await api.authorize({ agentKey: USER, tool: 'get_home_content', args: {}, now: T0 }), 'degrade-paused');
  expectDeny(await api.authorize({ agentKey: USER, tool: 'interactive_login', args: {}, now: T0 }), 'degrade-paused');
});

test('A-2 未注入 degrade 时行为完全不变（旧调用方可回退）', async () => {
  const { api, controller } = makeApi();
  expectAllow(await api.authorize({ agentKey: BG, tool: 'get_home_content', args: {}, now: T0 }));
  assert.equal(controller.calls.reserveRead.length, 1);
  expectAllow(await api.authorize({ agentKey: USER, tool: 'post_comment', args: { operationId: 'a2-none' }, now: T0 }));
});

test('A-2 degrade 选项形状校验：非法注入立即抛 TypeError', () => {
  assert.throws(
    () => createXhhAuthorizeApi({
      controller: makeFakeController(),
      backgroundSessionKeys: [BG],
      degrade: { snapshot: 'nope' },
    }),
    /degrade 必须提供 snapshot\(\)/u,
  );
});

// ── 控制台专栏：四个能力总开关 + 只读模式（对所有来源生效） ──────────────────

function settingsOf(patch = {}) {
  const base = { capabilities: { browse: true, post: true, comment: true, reply: true }, readOnly: false };
  return { ...base, ...patch, capabilities: { ...base.capabilities, ...(patch.capabilities ?? {}) } };
}

test('专栏门禁：开关全开时读工具照旧放行（不改变默认行为）', async () => {
  const { api } = makeApi({ consoleSettings: () => settingsOf() });
  for (const tool of ['get_home_content', 'get_post_detail', 'search_content']) {
    expectAllow(await api.authorize({ agentKey: BG, tool: FULL(tool), args: {}, now: T0 }), tool);
  }
});

test('专栏门禁：浏览关闭 ⇒ 首页/详情/搜索全拒（搜索跟随浏览，无独立开关）', async () => {
  const { api } = makeApi({ consoleSettings: () => settingsOf({ capabilities: { browse: false } }) });
  for (const tool of ['get_home_content', 'get_post_detail', 'search_content']) {
    expectDeny(await api.authorize({ agentKey: BG, tool: FULL(tool), args: {}, now: T0 }), 'console-capability-off-browse', tool);
  }
  expectAllow(await api.authorize({ agentKey: BG, tool: FULL('publish_content'), args: { operationId: 'p1' }, now: T0 }), 'publish_content');
});

test('专栏门禁：发帖/评论/回复三个开关各自独立，关闭即拒对应工具', async () => {
  const cases = [
    ['post', 'publish_content'],
    ['post', 'publish_article'],
    ['post', 'publish_video'],
    ['comment', 'post_comment'],
    ['reply', 'reply_comment'],
  ];
  for (const [capability, tool] of cases) {
    const { api } = makeApi({ consoleSettings: () => settingsOf({ capabilities: { [capability]: false } }) });
    expectDeny(await api.authorize({ agentKey: BG, tool: FULL(tool), args: { operationId: 'op-x' }, now: T0 }), `console-capability-off-${capability}`, tool);
  }
  const { api } = makeApi({ consoleSettings: () => settingsOf({ capabilities: { post: false } }) });
  expectAllow(await api.authorize({ agentKey: BG, tool: FULL('post_comment'), args: { operationId: 'c1' }, now: T0 }), 'post_comment');
  expectAllow(await api.authorize({ agentKey: BG, tool: FULL('reply_comment'), args: { operationId: 'r1' }, now: T0 }), 'reply_comment');
});

test('专栏门禁：只读模式拒写三类（即使开关全开），浏览仍放行', async () => {
  const { api } = makeApi({ consoleSettings: () => settingsOf({ readOnly: true }) });
  expectAllow(await api.authorize({ agentKey: BG, tool: FULL('get_home_content'), args: {}, now: T0 }), 'browse');
  const writes = [['publish_content', { operationId: 'p1' }], ['post_comment', { operationId: 'c1' }], ['reply_comment', { operationId: 'r1' }]];
  for (const [tool, args] of writes) {
    expectDeny(await api.authorize({ agentKey: BG, tool: FULL(tool), args, now: T0 }), 'console-read-only', tool);
  }
});

test('专栏门禁：对所有来源一视同仁（后台会话与用户明确要求都被拒）', async () => {
  const { api } = makeApi({
    consoleSettings: () => settingsOf({ capabilities: { post: false } }),
    provenanceClassifier: () => 'owner',
  });
  expectDeny(await api.authorize({ agentKey: USER, tool: FULL('publish_content'), args: { operationId: 'o1' }, now: T0 }), 'console-capability-off-post', 'owner 发帖');
  expectDeny(await api.authorize({ agentKey: BG, tool: FULL('publish_content'), args: { operationId: 'o2' }, now: T0 }), 'console-capability-off-post', '后台发帖');
});

test('专栏门禁：读不到配置时写全拒、读保持可用（配置故障不拖垮只读观察）', async () => {
  const { api } = makeApi({ consoleSettings: () => { throw new Error('boom'); } });
  expectAllow(await api.authorize({ agentKey: BG, tool: FULL('get_home_content'), args: {}, now: T0 }), 'browse');
  expectDeny(await api.authorize({ agentKey: BG, tool: FULL('publish_content'), args: { operationId: 'p1' }, now: T0 }), 'console-settings-unavailable', 'write');
  expectDeny(await api.authorize({ agentKey: BG, tool: FULL('post_comment'), args: { operationId: 'c1' }, now: T0 }), 'console-settings-unavailable', 'comment');
});

test('专栏门禁：注入非法 consoleSettings 抛 TypeError（配置错误不当运行期错误）', () => {
  assert.throws(
    () => createXhhAuthorizeApi({
      controller: makeFakeController(),
      backgroundSessionKeys: [BG],
      userExemptAgents: [USER],
      clock: () => T0,
      consoleSettings: { capabilities: {} },
    }),
    (error) => error instanceof TypeError && /consoleSettings/.test(error.message),
  );
});
