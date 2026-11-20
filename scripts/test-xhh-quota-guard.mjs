// scripts/test-xhh-quota-guard.mjs
// task-76（B4）：plugin execute-first 离线测试（fake ctx/waterfall）。
// task-108 修正：插件失效时 fail-closed（enabled!==true/配置非法/client 构造失败不再零注册，
//           fallback 下所有小黑盒工具（含只读）在 dispatch 前拒绝，避免绕过读取额度/暂停）。
// 覆盖：fail-closed fallback / 非 xhh 直通 / reserve→commit→next→complete / deny 不 next /
// commit 失败不 next / ABORTED_BEFORE_DISPATCH/UNKNOWN_TOOL → abort / 用户例外直通 /
// 异常与重复 post 不重复 complete / 日志不泄漏 / guard 同步预检 / later veto 已知风险。
// 全部离线：fake ctx + fake client；不连真实 DSH/HTTP/桥接，不安装插件。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  XHH_QUOTA_GUARD_TOOL_NAMES,
  XHH_QUOTA_TOOL_PREFIX,
  isXiaoheiheTool,
  normalizeToolName,
  isWriteTool,
  classifyToolResult,
  isKnownBusinessFailureText,
  resultText,
  classifyAgentKey,
  mapAuthorizeDecision,
  mapAuthorizeResponse,
  mapCommitResponse,
  mapAbortResponse,
  mapCompleteResponse,
  isPreDispatchAbort,
  makeExecuteDeniedResult,
  denyForAuthorizeFailure,
  outcomeForExec,
  xhhToolLogOutcome,
  resolveAgentKey,
} from '../plugins/xhh-quota-guard/decision.mjs';
import { apply, applyWithDeps, inject } from '../plugins/xhh-quota-guard/index.mjs';
import { XHH_AUTHORIZE_TOOL_NAMES, createXhhAuthorizeApi } from '../src/core/xiaoheihe-authorize-api.mjs';
import { createXhhAuthorizeRoutes } from '../src/core/xiaoheihe-authorize-route.mjs';

const FULL = (short) => `${XHH_QUOTA_TOOL_PREFIX}${short}`;

test('真实 DSH loader 契约：必须导出 inject 且包含 tools（否则插件不激活）', () => {
  assert.ok(Array.isArray(inject), 'inject 必须是数组');
  assert.ok(inject.includes('tools'), '必须注入 tools 服务（插件读取 ctx.tools.guard）');
});

function makeCtx() {
  const listeners = new Map();
  const warnings = [];
  const guards = [];
  const savedImages = [];
  const attachments = {
    async saveImages(inputs) {
      return inputs.map((input, index) => {
        savedImages.push({ mediaType: input?.mediaType, bytes: input?.data?.byteLength ?? 0 });
        return { attachmentId: `att-${index + 1}`, mediaType: input?.mediaType, bytes: input?.data?.byteLength ?? 0 };
      });
    },
  };
  return {
    listeners,
    warnings,
    guards,
    savedImages,
    get(name) {
      if (name === 'attachments') return attachments;
      if (name === 'llm') return { async resolveModelInfo() { return { inputModalities: ['image'] }; } };
      return undefined;
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    tools: {
      guard(fn) {
        guards.push(fn);
        return () => {};
      },
    },
    logger: {
      warn(message) { warnings.push(String(message)); },
    },
  };
}

function makeClient(overrides = {}) {
  const calls = { authorize: [], commit: [], abort: [], complete: [] };
  function invoke(name, fallback, request) {
    calls[name].push(request);
    return typeof overrides[name] === 'function' ? overrides[name](request) : fallback;
  }
  return {
    calls,
    async authorize(request) {
      return invoke('authorize', { ok: true, decision: 'allow', exemption: 'quota', ticket: { kind: 'read', ticketId: 'ticket-1' } }, request);
    },
    async commit(request) {
      return invoke('commit', { ok: true, started: true, ticket: { ...request.ticket, state: 'started' } }, request);
    },
    async abort(request) {
      return invoke('abort', { ok: true, aborted: true, rolledBack: true }, request);
    },
    async complete(request) {
      return invoke('complete', { ok: true, completed: true }, request);
    },
  };
}

function makeExec(overrides = {}) {
  return {
    name: FULL('get_home_content'),
    arguments: { id: 'post-1' },
    agent: {
      id: 'session-a',
      options: { provider: 'fixture-provider', model: 'fixture-vision-model' },
      session: { id: 'session-a', requestHeader: () => ({ config: { provider: 'fixture-provider', model: 'fixture-vision-model' } }) },
    },
    signal: { aborted: false },
    ...overrides,
  };
}

function makeNext(result = { isError: false, content: [{ type: 'text', text: 'tool-result' }] }) {
  const calls = [];
  const next = async () => { calls.push(true); return result; };
  next.calls = calls;
  return next;
}

function executeHook(ctx) {
  const listener = ctx.listeners.get('tools/execute');
  assert.ok(listener, '必须注册 tools/execute');
  return listener;
}

function postHook(ctx) {
  return ctx.listeners.get('tools/post-execute');
}

function startGuard(overrides = {}) {
  const ctx = makeCtx();
  const client = makeClient(overrides.client ?? {});
  const config = {
    enabled: true,
    timeoutMs: 500,
    authorize: client.authorize,
    commit: client.commit,
    abort: client.abort,
    complete: client.complete,
    ...(overrides.config ?? {}),
  };
  if (overrides.deps) applyWithDeps(ctx, config, overrides.deps);
  else apply(ctx, config);
  return { ctx, client };
}

/**
 * 走「execute → post-execute」两段：post 的 next() 默认 accept。
 * `result` 按宿主语义合并：decision 带 content 用 content，否则沿用 executed.content；
 * decision 为 block 时 result 即 decision（不存在正常结果）。
 */
async function runPipeline(ctx, exec, original, decision = { kind: 'accept' }) {
  const executed = await executeHook(ctx)(exec, makeNext(original));
  const post = postHook(ctx);
  assert.ok(post, '必须注册 tools/post-execute');
  const resolved = await post(exec, executed, async () => decision);
  const result = resolved?.kind === 'block'
    ? resolved
    : { ...executed, content: Array.isArray(resolved?.content) ? resolved.content : executed.content };
  return { executed, decision: resolved, result };
}

test('帖子详情成功后附图，保留原文并仅完成一次授权生命周期', async () => {
  const requests = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const { ctx, client } = startGuard({ deps: { fetchBuffer: async (url, _limit, options) => {
    requests.push({ url, options });
    return { buffer: png, contentType: 'image/png' };
  } } });
  const original = { isError: false, content: [{ type: 'text', text: JSON.stringify({ title: '离线测试', images: ['https://imgheybox.max-c.com/test.png'] }) }] };
  const { executed, result } = await runPipeline(ctx, makeExec({ name: FULL('get_post_detail') }), original);
  assert.equal(client.calls.complete.length, 1);
  assert.equal(client.calls.complete[0].outcome, 'success');
  // 旧落点回归钉：execute 阶段不得改写 content（宿主的 normalizeDispatchResult 会丢弃它）。
  assert.deepEqual(executed.content, original.content, 'execute 阶段不得追加图片');
  assert.equal(result.content[0].text, original.content[0].text);
  const imageBlocks = result.content.filter((item) => item.type === 'image');
  assert.equal(imageBlocks.length, 1);
  assert.ok(imageBlocks[0].attachment?.attachmentId, '图片块必须带 attachment 引用（宿主模型内容词汇）');
  assert.equal(imageBlocks[0].mimeType, undefined, '不得再产出 mimeType/data 形状');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.allowRedirect, false);
});

test('图片准入：视觉能力/路由/存储不可用时不产出图片块，如实说明并保留原文', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const original = { isError: false, content: [{ type: 'text', text: JSON.stringify({ images: ['https://imgheybox.max-c.com/test.png'] }) }] };
  const cases = [
    ['model-lacks-image', (ctx) => { ctx.get = (n) => (n === 'attachments' ? { async saveImages() { throw new Error('must not save'); } } : n === 'llm' ? { async resolveModelInfo() { return { inputModalities: ['text'] }; } } : undefined); }, '未声明支持图像输入'],
    ['no-llm', (ctx) => { ctx.get = (n) => (n === 'attachments' ? { async saveImages() { throw new Error('must not save'); } } : undefined); }, '无法确定当前模型路由'],
    ['route-unverified', (ctx) => { ctx.get = (n) => (n === 'attachments' ? { async saveImages() { throw new Error('must not save'); } } : n === 'llm' ? { async resolveModelInfo() { throw new Error('offline'); } } : undefined); }, '无法核实当前模型能力'],
    ['no-attachments', (ctx) => { ctx.get = () => undefined; }, '未提供附件存储'],
  ];
  for (const [label, customize, expected] of cases) {
    const { ctx } = startGuard({ deps: { fetchBuffer: async () => ({ buffer: png }) } });
    customize(ctx);
    const { result } = await runPipeline(ctx, makeExec({ name: FULL('get_post_detail') }), original);
    assert.equal(result.content.filter((item) => item.type === 'image').length, 0, `${label} 不得产出图片块`);
    assert.equal(result.content[0].text, original.content[0].text, `${label} 必须保留原文`);
    const note = result.content.filter((item) => item.type === 'text').map((item) => item.text).join(String.fromCharCode(10));
    assert.ok(note.includes(expected), `${label} 应如实说明（${expected}）`);
    assert.ok(!/已附上/u.test(note), `${label} 不得声称已附上`);
  }
});

test('图片准入：saveImages 抛错或返回数量不符时如实说明且不吞原文', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const original = { isError: false, content: [{ type: 'text', text: JSON.stringify({ images: ['https://imgheybox.max-c.com/a.png', 'https://imgheybox.max-c.com/b.png'] }) }] };
  for (const [label, saveImages, expected] of [
    ['throws', async () => { throw new Error('disk full'); }, '附件存储失败'],
    ['short', async () => [{ attachmentId: 'only-one' }], '附件存储返回异常'],
  ]) {
    const { ctx } = startGuard({ deps: { fetchBuffer: async () => ({ buffer: png }) } });
    const realGet = ctx.get.bind(ctx);
    ctx.get = (name) => (name === 'attachments' ? { saveImages } : realGet(name));
    const { result } = await runPipeline(ctx, makeExec({ name: FULL('get_post_detail') }), original);
    assert.equal(result.content.filter((item) => item.type === 'image').length, 0, `${label} 不得产出图片块`);
    assert.equal(result.content[0].text, original.content[0].text, `${label} 必须保留原文`);
    const note = result.content.filter((item) => item.type === 'text').map((item) => item.text).join(String.fromCharCode(10));
    assert.ok(note.includes(expected), `${label} 应如实说明`);
    assert.ok(!/已附上/u.test(note), `${label} 不得声称已附上`);
  }
});

test('失败、非详情及拒绝调用不下载图片', async () => {
  let downloads = 0;
  const deps = { fetchBuffer: async () => { downloads++; throw new Error('must not fetch'); } };
  const text = JSON.stringify({ images: ['https://imgheybox.max-c.com/test.png'] });
  for (const [name, isError] of [['get_post_detail', true], ['get_home_content', false]]) {
    const { ctx } = startGuard({ deps });
    const original = { isError, content: [{ type: 'text', text }] };
    const { executed, result } = await runPipeline(ctx, makeExec({ name: FULL(name) }), original);
    assert.deepEqual(executed.content, original.content);
    assert.deepEqual(result.content, original.content, '失败/非详情不得追加图片');
  }
  const { ctx } = startGuard({ deps, client: { authorize: () => ({ ok: true, decision: 'deny', reason: 'read-daily-cap' }) } });
  const next = makeNext({ isError: false, content: [{ type: 'text', text }] });
  await executeHook(ctx)(makeExec({ name: FULL('get_post_detail') }), next);
  assert.equal(next.calls.length, 0);
  assert.equal(downloads, 0);
});

test('不认识的工具返回形态保持原样', async () => {
  const { ctx } = startGuard({ deps: { fetchBuffer: async () => { throw new Error('must not fetch'); } } });
  const original = { content: '原始文本', structuredContent: { images: ['https://imgheybox.max-c.com/test.png'] } };
  const result = await executeHook(ctx)(makeExec({ name: FULL('get_post_detail') }), makeNext(original));
  assert.equal(result, original);
});

test('结构化帖子详情中的图片也能变成图片内容块（attachment 形状）', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const { ctx } = startGuard({ deps: { fetchBuffer: async () => ({ buffer: png }) } });
  const { result } = await runPipeline(ctx, makeExec({ name: FULL('get_post_detail') }), {
    isError: false,
    content: [{ type: 'text', text: '帖子详情' }],
    structuredContent: { images: ['https://imgheybox.max-c.com/test.png'] },
  });
  const imageBlocks = result.content.filter((item) => item.type === 'image');
  assert.equal(imageBlocks.length, 1);
  assert.ok(imageBlocks[0].attachment?.attachmentId, '必须带 attachment 引用');
});

test('无图帖子：结果原样返回，不给模型追加任何说明块', async () => {
  const { ctx } = startGuard({ deps: { fetchBuffer: async () => { throw new Error('must not fetch'); } } });
  const original = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ title: '无图帖', content: '正文', commentCount: 3, videoUrl: 'https://v.max-c.com/x.mp4' }) }],
  };
  const result = await executeHook(ctx)(makeExec({ name: FULL('get_post_detail') }), makeNext(original));
  assert.deepEqual(result.content, original.content, '无图时不得改动 content');
  assert.equal(result.content.length, 1);
  assert.equal(result.structuredContent, original.structuredContent);
});

test('post-execute 边界：block、value、下游自带 content、非本插件登记都不改', async () => {
  const text = JSON.stringify({ images: ['https://imgheybox.max-c.com/test.png'] });
  const original = { isError: false, content: [{ type: 'text', text }] };

  // 1) 下游 block：原样返回，且不抓图
  let downloads = 0;
  const { ctx: c1 } = startGuard({ deps: { fetchBuffer: async () => { downloads++; throw new Error('no'); } } });
  const exec1 = makeExec({ name: FULL('get_post_detail') });
  const executed1 = await executeHook(c1)(exec1, makeNext(original));
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: '被下游拦截' }] };
  const r1 = await postHook(c1)(exec1, executed1, async () => blocked);
  assert.deepEqual(r1, blocked, 'block decision 必须原样返回');
  assert.equal(downloads, 0, 'block 时不得抓图');

  // 2) 下游 accept 带 value：不能同时产出 content
  const { ctx: c2 } = startGuard({ deps: { fetchBuffer: async () => { downloads++; throw new Error('no'); } } });
  const exec2 = makeExec({ name: FULL('get_post_detail') });
  const executed2 = await executeHook(c2)(exec2, makeNext(original));
  const withValue = { kind: 'accept', value: [{ type: 'text', text: '替换值' }] };
  const r2 = await postHook(c2)(exec2, executed2, async () => withValue);
  assert.deepEqual(r2, withValue, '带 value 时不得追加 content');
  assert.equal(downloads, 0);

  // 3) 下游自带 content：不覆盖
  const { ctx: c3 } = startGuard({ deps: { fetchBuffer: async () => { downloads++; throw new Error('no'); } } });
  const exec3 = makeExec({ name: FULL('get_post_detail') });
  const executed3 = await executeHook(c3)(exec3, makeNext(original));
  const withContent = { kind: 'accept', content: [{ type: 'text', text: '下游已改写' }] };
  const r3 = await postHook(c3)(exec3, executed3, async () => withContent);
  assert.deepEqual(r3, withContent, '下游 content 不得被覆盖');
  assert.equal(downloads, 0);

  // 4) 没经过本插件登记（tickets 无记录）的 exec：post 阶段不得抓图
  const { ctx: c4 } = startGuard({ deps: { fetchBuffer: async () => { downloads++; throw new Error('no'); } } });
  const stranger = makeExec({ name: FULL('get_post_detail') });
  const decision = { kind: 'accept' };
  const r4 = await postHook(c4)(stranger, { isError: false, content: [{ type: 'text', text }] }, async () => decision);
  assert.deepEqual(r4, decision, '未登记的 exec 不得被追加图片');
  assert.equal(downloads, 0);
});

test('没有可用图片地址时不改动结果（说明块也不追加）', async () => {
  let downloads = 0;
  const { ctx } = startGuard({ deps: { fetchBuffer: async () => { downloads++; throw new Error('must not fetch'); } } });
  for (const text of ['不是 JSON 的详情文本', JSON.stringify({ images: [{ originUrl: 'https://imgheybox.max-c.com/x.png' }] })]) {
    const original = { isError: false, content: [{ type: 'text', text }] };
    const { result } = await runPipeline(ctx, makeExec({ name: FULL('get_post_detail') }), original);
    assert.deepEqual(result.content, original.content, '无有效地址时结果必须完全不变（含不追加诊断说明）');
  }
  assert.equal(downloads, 0, '无有效地址时不得抓图');
});

test('用户豁免读取也能看图，取图失败不改变原工具成功结果', async () => {
  const { ctx, client } = startGuard({ client: { authorize: () => ({ ok: true, decision: 'allow', exemption: 'user' }) }, deps: { fetchBuffer: async () => { throw new Error('secret diagnostic'); } } });
  const original = { isError: false, content: [{ type: 'text', text: JSON.stringify({ images: ['https://imgheybox.max-c.com/test.png'] }) }] };
  const { result } = await runPipeline(ctx, makeExec({ name: FULL('get_post_detail') }), original);
  assert.equal(result.isError, false);
  assert.equal(result.content[0].text, original.content[0].text);
  assert.equal(client.calls.complete.length, 0, '豁免路径不得 complete');
  assert.doesNotMatch(JSON.stringify(result), /secret diagnostic/);
  assert.ok(result.content.length > 1, '取图失败应提示，不静默');
});

test('凭据拒绝提示经真实 route 和插件传递，旧拒绝文案不变且审计不含提示', async () => {
  const token = 'offline-route-test-token-123456789';
  const events = [];
  let denial = { reason: 'credential-cooldown', hint: '请在私聊中重新登录', retryAfterMs: 120001, secret: 'must-not-leak' };
  const api = {
    async authorize() { return { ok: true, decision: 'deny', ...denial }; },
    async complete() { return { ok: true }; },
  };
  const routes = createXhhAuthorizeRoutes({ authorizeApi: api, consoleToken: token, backgroundSessionKeys: ['session-a'], audit: (event) => events.push(event) });
  const { ctx } = startGuard({ client: { authorize: (body) => routes.handleAuthorize({ headers: { 'x-console-token': token }, body }) } });
  const next = makeNext();
  const result = await executeHook(ctx)(makeExec({ name: FULL('interactive_login') }), next);
  assert.match(result.content[0].text, /请在私聊中重新登录/);
  assert.match(result.content[0].text, /3\s*分钟/);
  assert.equal(next.calls.length, 0);
  assert.ok(!JSON.stringify(events).includes('请在私聊中重新登录'));
  assert.ok(!JSON.stringify(result).includes('must-not-leak'));
  denial = { reason: 'access-paused' };
  const old = await executeHook(ctx)(makeExec({ name: FULL('interactive_login') }), next);
  assert.equal(old.content[0].text, 'Error: xhh-quota-guard: access-paused');
  for (const reason of ['access-paused', 'read-only-mode']) {
    for (const bad of [undefined, null, '', '  ', NaN, -1, 0, {}, []]) {
      denial = { reason, hint: bad, retryAfterMs: bad };
      const actual = await executeHook(ctx)(makeExec({ name: FULL('interactive_login') }), next);
      assert.equal(actual.content[0].text, `Error: xhh-quota-guard: ${reason}`);
    }
  }
});

test('真实 API 的 patrol 凭据拒绝提示通过 route 和插件到达调用方', async () => {
  const controller = {
    async status() { return { accessPaused: false, writePaused: false }; },
    async reserveRead() {}, async reserveWrite() {}, async commitTicket() {}, async abortTicket() {}, async finish() {},
  };
  const api = createXhhAuthorizeApi({ controller, backgroundSessionKeys: ['session-a'], provenanceClassifier: () => 'patrol' });
  const token = 'offline-route-test-token-123456789';
  const routes = createXhhAuthorizeRoutes({ authorizeApi: api, consoleToken: token, backgroundSessionKeys: ['session-a'] });
  const { ctx } = startGuard({ client: { authorize: (body) => routes.handleAuthorize({ headers: { 'x-console-token': token }, body }) } });
  const next = makeNext();
  const result = await executeHook(ctx)(makeExec({ name: FULL('interactive_login') }), next);
  assert.match(result.content[0].text, /credential-requires-user-present/);
  assert.match(result.content[0].text, /私聊/);
  assert.equal(next.calls.length, 0);
});

test('decision：工具名单单一来源；前缀归一/agentClass/agentKey 解析正确', () => {
  assert.deepEqual([...XHH_QUOTA_GUARD_TOOL_NAMES].sort(), [...XHH_AUTHORIZE_TOOL_NAMES].sort(), '工具名单不得漂移');
  assert.equal(XHH_QUOTA_TOOL_PREFIX, 'mcp__xiaoheihe__');
  assert.equal(isXiaoheiheTool(FULL('get_home_content')), true);
  assert.equal(isXiaoheiheTool('qq_send_message'), false);
  assert.equal(normalizeToolName(FULL('search_content')), 'search_content');
  assert.equal(normalizeToolName(FULL('delete_post')), null);
  assert.equal(classifyAgentKey('patrol:background', { backgroundSessionKeys: ['patrol:background'] }), 'background');
  assert.equal(classifyAgentKey('private:1', { userExemptAgents: ['private:1'] }), 'user');
  assert.equal(resolveAgentKey(makeExec()), 'session-a');
  assert.equal(resolveAgentKey({ agent: { session: { id: 's' } } }), 's');
  assert.equal(resolveAgentKey({}), null);
});

test('decision：authorize allow/deny、commit/abort/complete 的 200 body.ok 语义、pre-dispatch 码', () => {
  assert.deepEqual(mapAuthorizeDecision({ ok: true, decision: 'allow', ticket: { id: 't' } }), { kind: 'allow', ticket: { id: 't' }, exemption: null });
  assert.equal(mapAuthorizeDecision({ ok: true, decision: 'deny', reason: 'read-daily-cap' }).reason, 'read-daily-cap');
  assert.equal(mapAuthorizeDecision({ ok: false, decision: 'allow' }).kind, 'deny');
  assert.equal(mapAuthorizeResponse({ status: 200, body: { ok: true, decision: 'allow', ticket: { id: 't' } } }).kind, 'allow');
  assert.equal(mapAuthorizeResponse({ status: 500, body: { ok: true, decision: 'allow' } }).kind, 'deny');
  assert.deepEqual(mapCommitResponse({ ok: true, started: true, ticket: { id: 'started' } }), { ok: true, ticket: { id: 'started' } });
  assert.deepEqual(mapCommitResponse({ status: 200, body: { ok: true, started: true } }), { ok: true, ticket: undefined });
  assert.equal(mapCommitResponse({ status: 200, body: { ok: false, reason: 'persist-failed' } }).ok, false);
  assert.equal(mapCommitResponse({ status: 200, body: { ok: false, reason: 'persist-failed' } }).reason, 'persist-failed');
  assert.equal(mapCommitResponse({ status: 500, body: { ok: false, reason: 'x' } }).ok, false);
  assert.equal(mapAbortResponse({ status: 200, body: { ok: false, reason: 'invalid-ticket' } }).ok, false);
  assert.equal(mapAbortResponse({ ok: true, rolledBack: true }).rolledBack, true);
  assert.equal(mapCompleteResponse({ status: 200, body: { ok: false, reason: 'not-started' } }).ok, false);
  assert.equal(mapCompleteResponse({ status: 200, body: { ok: true } }).ok, true);
  assert.equal(isPreDispatchAbort({ isError: true, error: { code: 'ABORTED_BEFORE_DISPATCH' } }), true);
  assert.equal(isPreDispatchAbort({ isError: true, error: { code: 'UNKNOWN_TOOL' } }), true);
  assert.equal(isPreDispatchAbort({ isError: true, error: { code: 'EACCES' } }), false);
  assert.equal(isPreDispatchAbort({ isError: false }), false);
  const denied = makeExecuteDeniedResult('read-daily-cap');
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /^Error: xhh-quota-guard: read-daily-cap$/);
  assert.equal(denyForAuthorizeFailure({ name: 'TimeoutError' }).reason, 'authorize-timeout');
  assert.equal(outcomeForExec(makeExec(), { isError: false }), 'success');
  assert.equal(outcomeForExec(makeExec(), { isError: true, error: { code: 'TOOL_TIMEOUT' } }), 'unknown');
});

test('task-108 fail-closed：enabled!==true 仍注册钩子；所有小黑盒工具 dispatch 前拒绝', async () => {
  for (const config of [undefined, {}, { enabled: false }, { enabled: 'true' }, { enabled: 1 }]) {
    const ctx = makeCtx();
    apply(ctx, config);
    // 不再“零注册”：execute 门必须在，否则配置一坏就绕过授权。
    assert.equal(ctx.listeners.size, 2, '必须注册 tools/execute + tools/post-execute');
    assert.equal(typeof ctx.listeners.get('tools/execute'), 'function');
    assert.equal(typeof ctx.listeners.get('tools/post-execute'), 'function');
    assert.equal(ctx.guards.length, 1, '必须注册同步 guard');
    assert.ok(ctx.warnings.length >= 1, '必须告警进入 fail-closed 模式');
    for (const short of ['publish_content', 'get_home_content', 'search_content', 'interactive_login', 'future_unknown_tool']) {
      const next = makeNext();
      const denied = await executeHook(ctx)(makeExec({ name: FULL(short) }), next);
      assert.equal(next.calls.length, 0, `fallback ${short} 绝不 dispatch`);
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /fail-closed-no-authorization/);
    }
  }
});

test('配置 fail-closed：缺 commit/abort/complete 不抛错，降级 fallback 并在 dispatch 前拒绝写', async () => {
  const authorize = async () => ({ ok: true, decision: 'allow', ticket: { id: 't' } });
  const complete = async () => ({ ok: true });
  for (const config of [
    { enabled: true, authorize, complete },
    { enabled: true, authorize, commit: async () => ({}), complete },
  ]) {
    const ctx = makeCtx();
    assert.doesNotThrow(() => apply(ctx, config), 'apply 不得抛错（loader 可能卸载钩子）');
    assert.equal(typeof ctx.listeners.get('tools/execute'), 'function');
    assert.equal(ctx.guards.length, 1);
    assert.ok(ctx.warnings.length >= 1);
    const next = makeNext();
    const result = await executeHook(ctx)(makeExec({ name: FULL('publish_content') }), next);
    assert.equal(next.calls.length, 0);
    assert.match(result.content[0].text, /fail-closed-no-authorization/);
  }
});

test('非 xhh 工具：直接 next；不调用 authorize/commit/complete/abort', async () => {
  const { ctx, client } = startGuard();
  const next = makeNext({ isError: false, content: [] });
  const result = await executeHook(ctx)(makeExec({ name: 'qq_send_message' }), next);
  assert.deepEqual(result, { isError: false, content: [] });
  assert.equal(next.calls.length, 1);
  for (const calls of Object.values(client.calls)) assert.equal(calls.length, 0);
});

test('allow 顺序：authorize(reserve)→commit(started)→next→complete(success)；结果原样返回', async () => {
  const order = [];
  const { ctx, client } = startGuard({
    client: {
      authorize: (req) => { order.push('authorize'); assert.equal(req.agentKey, 'session-a'); return { ok: true, decision: 'allow', ticket: { kind: 'read', ticketId: 'ticket-1' } }; },
      commit: (req) => { order.push('commit'); return { ok: true, started: true, ticket: { ...req.ticket, state: 'started' } }; },
      complete: (req) => { order.push(`complete:${req.outcome}`); return { ok: true }; },
    },
  });
  const toolResult = { isError: false, content: [{ type: 'text', text: 'fake-body' }] };
  const next = makeNext(toolResult);
  const result = await executeHook(ctx)(makeExec(), next);
  assert.deepEqual(result, toolResult);
  assert.deepEqual(order, ['authorize', 'commit', 'complete:success']);
  assert.equal(next.calls.length, 1);
  assert.equal(client.calls.authorize[0].tool, FULL('get_home_content'));
  assert.deepEqual(client.calls.authorize[0].args, { id: 'post-1' });
  assert.deepEqual(client.calls.commit[0].ticket, { kind: 'read', ticketId: 'ticket-1' });
  assert.equal(client.calls.complete[0].agentKey, 'session-a', 'complete 必须透传 agentKey');
  assert.deepEqual(client.calls.complete[0].ticket, { kind: 'read', ticketId: 'ticket-1', state: 'started' });
});

test('authorize deny：返回合法 isError 结果，不 next、不 commit/complete', async () => {
  const { ctx, client } = startGuard({ client: { authorize: () => ({ ok: true, decision: 'deny', reason: 'read-daily-cap' }) } });
  const next = makeNext();
  const result = await executeHook(ctx)(makeExec(), next);
  assert.equal(next.calls.length, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /read-daily-cap/);
  assert.equal(client.calls.commit.length, 0);
  assert.equal(client.calls.complete.length, 0);
});

test('authorize 异常/超时 → deny 结果，不 next', async () => {
  const { ctx } = startGuard({ client: { authorize: () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); } } });
  const next = makeNext();
  const result = await executeHook(ctx)(makeExec(), next);
  assert.equal(next.calls.length, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /authorize-timeout/);
});

test('commit 失败（body.ok=false / HTTP 200 业务拒绝）→ deny 结果，不 next、不 complete', async () => {
  for (const commit of [
    () => ({ ok: false, reason: 'persist-failed' }),
    () => ({ status: 200, body: { ok: false, reason: 'persist-failed' } }),
    () => ({ status: 500, body: {} }),
  ]) {
    const { ctx, client } = startGuard({ client: { commit } });
    const next = makeNext();
    const result = await executeHook(ctx)(makeExec(), next);
    assert.equal(next.calls.length, 0, 'commit 失败不得 dispatch');
    assert.equal(result.isError, true);
    assert.equal(client.calls.commit.length, 1);
    assert.equal(client.calls.complete.length, 0);
  }
});

test('ABORTED_BEFORE_DISPATCH：调用 abort 回滚，不 complete；返回原结果', async () => {
  const { ctx, client } = startGuard();
  const aborted = { isError: true, error: { code: 'ABORTED_BEFORE_DISPATCH' }, content: [] };
  const next = makeNext(aborted);
  const result = await executeHook(ctx)(makeExec(), next);
  assert.deepEqual(result, aborted);
  assert.equal(client.calls.abort.length, 1);
  assert.equal(client.calls.complete.length, 0);
  assert.equal(client.calls.abort[0].agentKey, 'session-a');
});

test('UNKNOWN_TOOL：abort 回滚，不 complete', async () => {
  const { ctx, client } = startGuard();
  const unknown = { isError: true, error: { code: 'UNKNOWN_TOOL' } };
  const next = makeNext(unknown);
  const result = await executeHook(ctx)(makeExec(), next);
  assert.deepEqual(result, unknown);
  assert.equal(client.calls.abort.length, 1);
  assert.equal(client.calls.complete.length, 0);
});

test('正常失败结果：finish outcome=failure；工具结果不被改写', async () => {
  const { ctx, client } = startGuard();
  const failed = { isError: true, error: { code: 'EACCES' } };
  const result = await executeHook(ctx)(makeExec(), makeNext(failed));
  assert.deepEqual(result, failed);
  assert.equal(client.calls.abort.length, 0);
  assert.equal(client.calls.complete.length, 1);
  assert.equal(client.calls.complete[0].outcome, 'failure');
});

test('用户例外：authorize exemption:user 且无 ticket → 直接 next，不 commit/complete', async () => {
  const { ctx, client } = startGuard({ client: { authorize: () => ({ ok: true, decision: 'allow', exemption: 'user' }) } });
  const next = makeNext({ isError: false, content: [] });
  const result = await executeHook(ctx)(makeExec(), next);
  assert.deepEqual(result, { isError: false, content: [] });
  assert.equal(next.calls.length, 1);
  assert.equal(client.calls.commit.length, 0);
  assert.equal(client.calls.complete.length, 0);
});

test('fail-closed：authorize allow 但缺 ticket（非用户例外）→ 不得 next/commit，返回 missing-ticket', async () => {
  for (const authorize of [
    () => ({ ok: true, decision: 'allow', exemption: 'quota' }),
    () => ({ ok: true, decision: 'allow', exemption: 'quota', ticket: { kind: 'read' } }),
  ]) {
    const { ctx, client } = startGuard({ client: { authorize } });
    const next = makeNext();
    const result = await executeHook(ctx)(makeExec(), next);
    assert.equal(next.calls.length, 0);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /missing-ticket/);
    assert.equal(client.calls.commit.length, 0);
    assert.equal(client.calls.complete.length, 0);
  }
});

test('缺 agentKey：本地 fail-closed，不调用 authorize；guard 同步预检拒绝', async () => {
  const { ctx, client } = startGuard();
  const next = makeNext();
  const noAgent = makeExec({ agent: {} });
  const result = await executeHook(ctx)(noAgent, next);
  assert.equal(next.calls.length, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /missing-agent-key/);
  assert.equal(client.calls.authorize.length, 0);
  assert.equal(ctx.guards.length, 1);
  assert.equal(ctx.guards[0](noAgent), 'xhh-quota-guard: missing-agent-key');
  assert.equal(ctx.guards[0](makeExec()), undefined);
  assert.equal(ctx.guards[0]({ name: 'qq_send_message' }), undefined);
});

test('next 抛异常：不崩溃，返回 isError 结果；started 票据收尾', async () => {
  const { ctx, client } = startGuard();
  const next = async () => { throw Object.assign(new Error('dispatch boom'), { code: 'EACCES' }); };
  const result = await executeHook(ctx)(makeExec(), next);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /dispatch-error/);
  assert.equal(client.calls.complete.length, 1);
  assert.equal(client.calls.complete[0].outcome, 'failure');
});

test('同一 exec 重复 post-execute：execute 已 finish，post 不重复 complete', async () => {
  const { ctx, client } = startGuard();
  const exec = makeExec();
  await executeHook(ctx)(exec, makeNext());
  assert.equal(client.calls.complete.length, 1);
  await postHook(ctx)(exec, { isError: false }, async () => ({ kind: 'allow' }));
  await postHook(ctx)(exec, { isError: false }, async () => ({ kind: 'allow' }));
  assert.equal(client.calls.complete.length, 1, 'complete 只调用一次');
});

test('post-execute 无登记 ticket：直接 next，不调用 complete', async () => {
  const { ctx, client } = startGuard();
  const calls = [];
  await postHook(ctx)(makeExec(), { isError: false }, async () => { calls.push(true); return { kind: 'allow' }; });
  assert.equal(calls.length, 1);
  assert.equal(client.calls.complete.length, 0);
});

test('complete 失败：只告警、不崩溃、不泄漏 token/ticket/args；工具结果仍返回', async () => {
  const secretTicket = { ticketId: 'ticket-SECRET-DO-NOT-LOG', kind: 'read' };
  const { ctx } = startGuard({
    client: {
      authorize: () => ({ ok: true, decision: 'allow', ticket: secretTicket }),
      commit: () => ({ ok: true, started: true, ticket: secretTicket }),
      complete: () => { throw new Error('boom with token-SECRET and args-SENSITIVE'); },
    },
  });
  const exec = makeExec({ arguments: { id: 'args-SENSITIVE' } });
  const toolResult = { isError: false, content: [] };
  const result = await executeHook(ctx)(exec, makeNext(toolResult));
  assert.deepEqual(result, toolResult);
  assert.equal(ctx.warnings.length, 1);
  const joined = JSON.stringify(ctx.warnings);
  assert.doesNotMatch(joined, /token-SECRET|ticket-SECRET|args-SENSITIVE/);
  assert.match(joined, /complete 失败/);
});

test('complete 返回 invalid-ticket（错误/缺失 agentKey 服务端拒绝）：只告警，不假装成功', async () => {
  const { ctx } = startGuard({ client: { complete: () => ({ status: 200, body: { ok: false, reason: 'invalid-ticket' } }) } });
  const toolResult = { isError: false, content: [] };
  const result = await executeHook(ctx)(makeExec(), makeNext(toolResult));
  assert.deepEqual(result, toolResult, '工具结果不被改写');
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /complete 失败/);
});

test('later execute veto 残余风险：本插件 commit 后后置 listener 直接返回，仍会 finish（可能未执行但计数）', async () => {
  const { ctx, client } = startGuard();
  // 模拟真实 waterfall：插件调用 next，后置 listener 不继续 next 直接返回自定义结果。
  const laterVeto = { isError: false, content: [{ type: 'text', text: 'vetoed-without-dispatch' }] };
  const next = async () => laterVeto;
  const result = await executeHook(ctx)(makeExec(), next);
  assert.deepEqual(result, laterVeto);
  // 已知限制：不是已知 pre-dispatch 码 → 按 success 收尾（计数保留）。
  assert.equal(client.calls.complete.length, 1);
  assert.equal(client.calls.complete[0].outcome, 'success');
  assert.equal(client.calls.abort.length, 0);
});

test('decision F-A：写工具识别（完整/短名），读工具不误判', () => {
  for (const name of ['publish_content', 'publish_article', 'publish_video', 'post_comment', 'reply_comment']) {
    assert.equal(isWriteTool(name), true, name);
    assert.equal(isWriteTool(FULL(name)), true, name);
  }
  for (const name of ['get_home_content', 'get_post_detail', 'search_content', 'check_login_status']) {
    assert.equal(isWriteTool(name), false, name);
  }
  assert.equal(isWriteTool('qq_send_message'), false);
});

test('decision F-B：业务失败三态分类（只认已知标记，不用“成功/失败”字眼猜测）', () => {
  const success = { isError: false, content: [{ type: 'text', text: '发布成功，已同步到主页' }] };
  assert.equal(classifyToolResult(success).outcome, 'success');
  assert.equal(outcomeForExec(makeExec(), success), 'success');

  const filledButNotPublished = { isError: false, content: [{ type: 'text', text: '⚠️ 内容已填写，但未能自动点击发布按钮' }] };
  assert.equal(classifyToolResult(filledButNotPublished).outcome, 'failure');
  assert.equal(outcomeForExec(makeExec(), filledButNotPublished), 'failure');

  for (const text of ['❌ 发布失败', '未能自动发布', '建议：请手动点击发布按钮']) {
    assert.equal(isKnownBusinessFailureText(text), true, text);
    assert.equal(outcomeForExec(makeExec(), { isError: false, content: [{ type: 'text', text }] }), 'failure', text);
  }
  assert.equal(isKnownBusinessFailureText('发布成功'), false);
  assert.equal(classifyToolResult({ isError: true, content: [] }).outcome, 'failure');
  assert.equal(outcomeForExec(makeExec({ signal: { aborted: true } }), { isError: true }), 'unknown');
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
});

test('小黑盒明确超时正文为 unknown，不误归为确定失败或成功', () => {
  for (const isError of [false, true]) {
    const result = { isError, content: [{ type: 'text', text: '❌ 回复评论失败: Timeout 30000ms exceeded.' }] };
    assert.equal(outcomeForExec(makeExec(), result), 'unknown');
    assert.equal(classifyToolResult(result).outcome, 'unknown');
  }
  assert.equal(outcomeForExec(makeExec(), { isError: false, content: [{ type: 'text', text: '❌ 回复评论失败: 权限不足' }] }), 'failure');
  assert.equal(outcomeForExec(makeExec(), { isError: false, content: [{ type: 'text', text: '帖子讨论 Timeout 30000ms exceeded 问题' }] }), 'success');
});

test('小黑盒工具日志区分业务超时、失败和普通工具', () => {
  const timeout = { isError: false, content: [{ type: 'text', text: '❌ 回复评论失败: Timeout 30000ms exceeded.' }] };
  assert.deepEqual(xhhToolLogOutcome(FULL('reply_comment'), timeout), { ok: false, outcome: 'unknown' });
  assert.deepEqual(xhhToolLogOutcome(FULL('reply_comment'), { content: [{ type: 'text', text: '❌ 权限不足' }] }), { ok: false, outcome: 'failure' });
  assert.deepEqual(xhhToolLogOutcome(FULL('reply_comment'), { content: [{ type: 'text', text: '完成' }] }), { ok: true, outcome: 'success' });
  assert.equal(xhhToolLogOutcome('mcp__snowluma__qq_send_message', timeout), null);
});

test('真实插件执行时超时正文以 unknown 完成且不回滚票据', async () => {
  const { ctx, client } = startGuard();
  const result = { isError: false, content: [{ type: 'text', text: '❌ 回复评论失败: Timeout 30000ms exceeded.' }] };
  assert.deepEqual(await executeHook(ctx)(makeExec({ name: FULL('reply_comment') }), makeNext(result)), result);
  assert.equal(client.calls.complete.length, 1);
  assert.equal(client.calls.complete[0].outcome, 'unknown');
  assert.equal(client.calls.abort.length, 0);
});

test('小黑盒 HTTP 包装的提交后未知结果不能被认作成功', () => {
  for (const text of [
    '⚠️ 已尝试点击发送，但点击或提交后校验出现超时，无法确认是否已提交，结果未知，请勿自动重发（步骤: submit）。',
    '⚠️ 回复已点击提交，但 4 次校验均未确认到唯一的新增回复。结果未知，请勿自动重发；请先人工查看帖子确认。',
  ]) {
    const response = { isError: false, content: [{ type: 'text', text }] };
    assert.equal(outcomeForExec(makeExec(), response), 'unknown');
    const log = xhhToolLogOutcome(FULL('reply_comment'), response);
    assert.equal(log.ok, false);
    assert.equal(log.outcome, 'unknown');
  }
});

test('回复诊断仅把白名单步骤写入日志，拒绝伪造或敏感字段', () => {
  const result = { isError: false, content: [{ type: 'text', text: '❌ 回复评论失败: Timeout 30000ms exceeded.（步骤: network_idle，耗时: 30000ms；未提交）。' }] };
  assert.deepEqual(xhhToolLogOutcome(FULL('reply_comment'), result), { ok: false, outcome: 'unknown', diagnosticStep: 'network_idle' });
  const forged = { content: [{ type: 'text', text: '❌ 回复评论失败: Timeout 30000ms exceeded.（步骤: secret_value，耗时: 30000ms）' }] };
  assert.deepEqual(xhhToolLogOutcome(FULL('reply_comment'), forged), { ok: false, outcome: 'unknown' });
  const otherTimeout = { content: [{ type: 'text', text: '❌ 回复评论失败: 超时（步骤: navigate，耗时: 30000ms；未提交）。' }] };
  assert.deepEqual(xhhToolLogOutcome(FULL('reply_comment'), otherTimeout), { ok: false, outcome: 'unknown', diagnosticStep: 'navigate' });
  for (const suffix of ['SECRET', '2', '_extra']) {
    const text = `❌ 回复评论失败: Timeout 30000ms exceeded.（步骤: submit${suffix}，耗时: 30000ms）`;
    assert.deepEqual(xhhToolLogOutcome(FULL('reply_comment'), { content: [{ type: 'text', text }] }), { ok: false, outcome: 'unknown' });
  }
});

test('插件 F-A：后台写注入内部 operationId 仅到 authorize/commit，exec.arguments 不变；同一调用同 id', async () => {
  const { ctx, client } = startGuard();
  const exec = makeExec({ name: FULL('publish_content'), arguments: { text: 'hello', images: [] } });
  const originalArguments = JSON.parse(JSON.stringify(exec.arguments));
  const next = makeNext({ isError: false, content: [{ type: 'text', text: '发布成功' }] });
  const result = await executeHook(ctx)(exec, next);
  assert.deepEqual(result, { isError: false, content: [{ type: 'text', text: '发布成功' }] });
  const authorizeArgs = client.calls.authorize[0].args;
  const commitArgs = client.calls.commit[0].args;
  assert.equal(typeof authorizeArgs.operationId, 'string');
  assert.ok(authorizeArgs.operationId.length > 0);
  assert.equal(commitArgs.operationId, authorizeArgs.operationId, 'commit 必须复用同一内部 id');
  assert.deepEqual(exec.arguments, originalArguments, '不得修改 exec.arguments/真实工具参数');
  assert.equal('operationId' in exec.arguments, false);
  // 读操作不注入 operationId
  const readExec = makeExec({ name: FULL('get_home_content'), arguments: { id: 'p1' } });
  await executeHook(ctx)(readExec, makeNext());
  assert.equal('operationId' in client.calls.authorize[1].args, false);
});

test('图片准入：signal 已取消 / 无路由 / 准入抛错 时不附图且说明不泄敏', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const original = { isError: false, content: [{ type: 'text', text: JSON.stringify({ images: ['https://imgheybox.max-c.com/test.png'] }) }] };

  // 1) 已取消：signal.aborted=true 时不得附图
  {
    const { ctx } = startGuard({ deps: { fetchBuffer: async () => ({ buffer: png }) } });
    const exec = makeExec({ name: FULL('get_post_detail'), signal: { aborted: true } });
    const executed = await executeHook(ctx)(exec, makeNext(original));
    const out = await postHook(ctx)(exec, executed, async () => ({ kind: 'accept' }));
    const note = (out.content ?? []).filter((i) => i.type === 'text').map((i) => i.text).join(String.fromCharCode(10));
    assert.equal((out.content ?? []).filter((i) => i.type === 'image').length, 0, '取消时不得附图');
    // 取消时可能不给附加说明（原文里仍有地址），但绝不能附块或声称已附上。
    assert.ok(!note.includes('已附上'), '不得声称已附上');
  }

  // 2) 无路由：session 没有 requestHeader 抛错 => 视为无法确定路由
  {
    const { ctx } = startGuard({ deps: { fetchBuffer: async () => ({ buffer: png }) } });
    const exec = makeExec({ name: FULL('get_post_detail') });
    exec.agent = { id: 'a', session: { id: 's', requestHeader: () => { throw new Error('no header'); } } };
    const executed = await executeHook(ctx)(exec, makeNext(original));
    const out = await postHook(ctx)(exec, executed, async () => ({ kind: 'accept' }));
    const note = (out.content ?? []).filter((i) => i.type === 'text').map((i) => i.text).join(String.fromCharCode(10));
    assert.equal((out.content ?? []).filter((i) => i.type === 'image').length, 0);
    assert.ok(note.includes('无法确定当前模型路由'), '必须如实说明路由不可得');
  }

  // 3) 准入抛错：ctx.get('llm') 抛错 => 保留原文并给说明，不得静默
  {
    const { ctx } = startGuard({ deps: { fetchBuffer: async () => ({ buffer: png }) } });
    const realGet = ctx.get.bind(ctx);
    ctx.get = (name) => { if (name === 'llm') throw new Error('boom'); return realGet(name); };
    const { result } = await runPipeline(ctx, makeExec({ name: FULL('get_post_detail') }), original);
    assert.equal(result.content.filter((i) => i.type === 'image').length, 0);
    assert.equal(result.content[0].text, original.content[0].text, '原文必须保留');
    const note = result.content.filter((i) => i.type === 'text').map((i) => i.text).join(String.fromCharCode(10));
    assert.ok(note.trim().length > 0, '不得静默丢弃');
    assert.ok(!/已附上/u.test(note));
  }
});

test('outcome 过滤：业务失败文本不得触发附图（即使带 images 字段）', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let saves = 0;
  const { ctx } = startGuard({ deps: { fetchBuffer: async () => ({ buffer: png }) } });
  const realGet = ctx.get.bind(ctx);
  ctx.get = (name) => (name === 'attachments' ? { async saveImages(inputs) { saves += inputs.length; return []; } } : realGet(name));
  const result = { isError: false, content: [{ type: 'text', text: JSON.stringify({ images: ['https://imgheybox.max-c.com/test.png'] }) + ' ❌ 读取失败' }] };
  const { result: out } = await runPipeline(ctx, makeExec({ name: FULL('get_post_detail') }), result);
  assert.equal(out.content.filter((i) => i.type === 'image').length, 0, '业务失败不得附图');
  assert.equal(saves, 0, '不得调用附件存储');
  assert.equal(out.content[0].text, result.content[0].text, '原文必须保留');
});

