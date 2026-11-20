import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createOfflineQzoneAdminRouter } from '../src/core/qzone-admin-router-offline.mjs';
import { formatAuditRecord } from '../src/core/qzone-audit-offline.mjs';

const NOW = Date.parse('2026-11-08T03:00:00Z');

function initialState(overrides = {}) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: true, writePaused: true,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 },
    intervalMinutes: 60, activeStart: 420, activeEnd: 1380,
    ledger: { day: '2026-11-08', used: { post: 2, comment: 8, like: 9 }, reservations: { r1: 'post' } },
    reads: 3, writes: 3, probe: 'manual_only', token: 'state-secret', audit: [], ...overrides,
  };
}

async function fixture(t, { authenticate, createAuditId } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState());
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const authCalls = [];
  let generatedAuditId = 0;
  const router = createOfflineQzoneAdminRouter({
    store, clock: () => NOW, selfId: '123456',
    authenticate: authenticate ?? ((context) => {
      authCalls.push(context);
      return context.sessionToken === 'valid-session' ? { valid: true, operator: '987654' } : { valid: false };
    }),
    createAuditId: createAuditId ?? (() => `audit-${authCalls.length}-${++generatedAuditId}`),
  });
  return { router, store, authCalls };
}

const validRequest = (method, path, body) => ({ method, path, body, sessionToken: 'valid-session' });

function mockStore(state, updateImplementation) {
  let value = structuredClone(state);
  return {
    read() { return structuredClone(value); },
    update(fn) {
      return updateImplementation
        ? updateImplementation(fn, () => structuredClone(value), (next) => { value = structuredClone(next); })
        : (() => { value = structuredClone(fn(structuredClone(value))); return structuredClone(value); })();
    },
    current() { return structuredClone(value); },
  };
}

function mockRouter(t, store, options = {}) {
  let auditId = 0;
  return createOfflineQzoneAdminRouter({
    store, clock: () => NOW, selfId: '123456',
    authenticate: () => ({ valid: true, operator: '987654' }),
    createAuditId: () => `mock-audit-${++auditId}`, ...options,
  });
}

test('所有状态/管理请求先鉴权；注入鉴权可核验跨域 session 上下文', async (t) => {
  const seen = [];
  const { router, store } = await fixture(t, {
    authenticate: (context) => {
      seen.push(context);
      return { valid: context.sessionToken === 'cross-domain-session', operator: '987654' };
    },
  });

  const denied = await router({ method: 'GET', path: '/status', sessionToken: 'expired' });
  assert.equal(denied.status, 401);
  assert.deepEqual(store.read().audit, []);
  const allowed = await router({ method: 'GET', path: '/status', sessionToken: 'cross-domain-session' });
  assert.equal(allowed.status, 200);
  assert.deepEqual(seen.map(({ method, path, sessionToken }) => ({ method, path, sessionToken })), [
    { method: 'GET', path: '/status', sessionToken: 'expired' },
    { method: 'GET', path: '/status', sessionToken: 'cross-domain-session' },
  ]);
});

test('状态只返回投影，未认证不可读，异常不泄露状态凭据', async (t) => {
  const { router } = await fixture(t);
  const denied = await router({ method: 'GET', path: '/status', sessionToken: 'wrong' });
  assert.equal(denied.status, 401);
  const response = await router(validRequest('GET', '/status'));
  assert.equal(response.status, 200);
  assert.equal(response.body.accessPaused, true);
  assert.equal(JSON.stringify(response).includes('state-secret'), false);
  assert.equal(JSON.stringify(response).includes('audit'), false);
});

test('配置读取从安全状态投影生成完整每日上限', async (t) => {
  const { router } = await fixture(t);
  const response = await router(validRequest('GET', '/config'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.limits, { post: 3, comment: 25, like: 30 });
  assert.equal(Object.hasOwn(response.body, 'ledger'), false);
  assert.equal(JSON.stringify(response).includes('state-secret'), false);
});

test('鉴权等待期间修改原请求和嵌套 body 不会改变已快照操作', async (t) => {
  let release;
  let entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const { router, store } = await fixture(t, {
    authenticate: async ({ sessionToken, method, path }) => {
      entered();
      await waiting;
      return { valid: sessionToken === 'valid-session' && method === 'PATCH' && path === '/config', operator: '987654' };
    },
  });
  const body = { enabled: false, limits: { post: 7 } };
  const request = { method: 'PATCH', path: '/config', body, sessionToken: 'valid-session' };
  const pending = router(request);
  await started;
  request.method = 'POST';
  request.path = '/pause/restore';
  request.sessionToken = 'changed-session';
  body.enabled = true;
  body.limits.post = 99;
  body.operator = 'forged';
  release();

  const response = await pending;
  assert.deepEqual(response, { status: 200, body: { ok: true } });
  const after = store.read();
  assert.equal(after.enabled, false);
  assert.equal(after.limits.post, 7);
  assert.equal(after.audit[0].record.target, '123456');
  assert.equal(after.audit[0].record.operator, '987654');
});

test('请求/body 访问器及非普通对象在鉴权后作为非法请求拒绝', async (t) => {
  let authCalls = 0;
  const { router } = await fixture(t, {
    authenticate: () => { authCalls++; return { valid: true, operator: '987654' }; },
  });
  let getterCalls = 0;
  const accessorBody = {};
  Object.defineProperty(accessorBody, 'enabled', { enumerable: true, get() { getterCalls++; return false; } });
  const withBodyAccessor = await router(validRequest('PATCH', '/config', accessorBody));
  assert.equal(withBodyAccessor.status, 400);
  assert.equal(getterCalls, 0);

  const customBody = Object.assign(Object.create({ inherited: true }), { enabled: false });
  const withNonPlainBody = await router(validRequest('PATCH', '/config', customBody));
  assert.equal(withNonPlainBody.status, 400);

  const requestAccessor = {};
  Object.defineProperty(requestAccessor, 'method', { enumerable: true, get() { getterCalls++; return 'GET'; } });
  Object.defineProperties(requestAccessor, {
    path: { enumerable: true, value: '/status' },
    sessionToken: { enumerable: true, value: 'valid-session' },
  });
  const withRequestAccessor = await router(requestAccessor);
  assert.equal(withRequestAccessor.status, 400);
  assert.equal(getterCalls, 0);

  const customRequest = Object.assign(Object.create({ inherited: true }), {
    method: 'GET', path: '/status', sessionToken: 'valid-session',
  });
  const withNonPlainRequest = await router(customRequest);
  assert.equal(withNonPlainRequest.status, 400);
  assert.equal(authCalls, 4);
});

test('配置白名单立即落盘并与可信操作者、固定目标、时间和来源同事务审计', async (t) => {
  const { router, store } = await fixture(t, { createAuditId: () => 'trusted-audit-1' });
  const response = await router(validRequest('PATCH', '/config', { enabled: false, limits: { post: 5 } }));
  assert.deepEqual(response, { status: 200, body: { ok: true } });
  const after = store.read();
  assert.equal(after.enabled, false);
  assert.equal(after.limits.post, 5);
  assert.deepEqual(after.audit[0], { id: 'trusted-audit-1', record: {
    time: NOW, source: 'admin_console', action: 'configure', target: '123456', postId: null,
    commentId: null, content: '{"enabled":false,"limits":{"post":5}}', redacted: false,
    result: 'success', reason: '', quota: null, operator: '987654', pauseScope: 'both',
  } });
});

test('调用方伪造 operator/source/time/target/auditId 或未列字段一律拒绝且无副作用', async (t) => {
  const { router, store } = await fixture(t);
  const before = store.read();
  const response = await router({ ...validRequest('PATCH', '/config', {
    enabled: false, operator: 'attacker', source: 'qq', time: 1, target: '1', auditId: 'forged',
  }) });
  assert.equal(response.status, 400);
  assert.deepEqual(store.read(), before);
  const extraTopLevel = await router({ ...validRequest('GET', '/status'), operator: 'attacker' });
  assert.equal(extraTopLevel.status, 400);
});

test('严格限制方法、路径、配置字段和操作选择', async (t) => {
  const { router, store } = await fixture(t);
  for (const request of [
    validRequest('POST', '/status'),
    validRequest('GET', '/config', { operator: 'fake' }),
    validRequest('PATCH', '/unknown', {}),
    validRequest('PATCH', '/config', { password: 'secret' }),
    validRequest('POST', '/quota/reset', { kind: 'all' }),
    validRequest('POST', '/pause/restore', { layer: 'all' }),
    validRequest('POST', '/quota/reset', { kind: 'post', operator: 'fake' }),
  ]) {
    const response = await router(request);
    assert.ok([400, 404, 405].includes(response.status));
  }
  assert.equal(store.read().audit.length, 0);
  assert.equal(store.read().enabled, true);
});

test('额度重置不解除暂停；关闭总开关时仍可恢复且恢复不改额度', async (t) => {
  const { router, store } = await fixture(t);
  const reset = await router(validRequest('POST', '/quota/reset', { kind: 'post' }));
  assert.equal(reset.status, 200);
  let after = store.read();
  assert.deepEqual(after.ledger.used, { post: 0, comment: 8, like: 9 });
  assert.equal(after.accessPaused, true);
  assert.equal(after.writePaused, true);

  store.update((state) => ({ ...state, enabled: false }));
  const usedBeforeRestore = store.read().ledger.used;
  const restore = await router(validRequest('POST', '/pause/restore', { layer: 'both' }));
  assert.equal(restore.status, 200);
  after = store.read();
  assert.equal(after.accessPaused, false);
  assert.equal(after.writePaused, false);
  assert.deepEqual(after.ledger.used, usedBeforeRestore);
  assert.equal(after.enabled, false);
  assert.equal(after.audit.length, 4);
  assert.equal(after.audit[2].record.action, 'restore');
  assert.equal(after.audit[2].record.result, 'unknown');
  assert.equal(after.audit[3].record.result, 'success');
});

test('合法且已鉴权的恢复/重置先记 unknown 意图，成功审计仍与状态变更同事务', async (t) => {
  for (const [path, body, action] of [
    ['/quota/reset', { kind: 'post' }, 'reset_quota'],
    ['/pause/restore', { layer: 'both' }, 'restore'],
  ]) {
    const { router, store } = await fixture(t);
    const response = await router(validRequest('POST', path, body));
    assert.equal(response.status, 200);
    const records = store.read().audit.map(({ record }) => record);
    assert.equal(records[0].action, action);
    assert.equal(records[0].result, 'unknown');
    assert.match(records[0].content, /"phase":"intent"/);
    assert.equal(records.at(-1).action, action);
    assert.equal(records.at(-1).result, 'success');
  }
});

test('每次恢复/重置以独立安全关联 ID 连接意图和结果，且事件 ID 各异', async (t) => {
  for (const [path, body] of [
    ['/quota/reset', { kind: 'post' }],
    ['/pause/restore', { layer: 'both' }],
  ]) {
    const ids = ['corr-one', 'intent-one', 'success-one', 'unknown-one'];
    const { router, store } = await fixture(t, { createAuditId: () => ids.shift() });
    assert.equal((await router(validRequest('POST', path, body))).status, 200);
    const entries = store.read().audit;
    assert.equal(entries.length, 2);
    const [intent, result] = entries;
    assert.notEqual(intent.id, result.id);
    assert.equal(intent.id, 'intent-one');
    assert.equal(result.id, 'success-one');
    assert.deepEqual(JSON.parse(intent.record.content).correlationId, 'corr-one');
    assert.deepEqual(JSON.parse(result.record.content).correlationId, 'corr-one');
    assert.equal(intent.record.result, 'unknown');
    assert.equal(result.record.result, 'success');
  }
});

test('并发管理操作的关联 ID 各自唯一；关联生成器碰撞或超长时零副作用', async (t) => {
  const ids = ['corr-a', 'intent-a', 'success-a', 'unknown-a', 'corr-b', 'intent-b', 'success-b', 'unknown-b'];
  const { router, store } = await fixture(t, { createAuditId: () => ids.shift() });
  const results = await Promise.all([
    router(validRequest('POST', '/quota/reset', { kind: 'post' })),
    router(validRequest('POST', '/pause/restore', { layer: 'both' })),
  ]);
  assert.deepEqual(results.map(({ status }) => status), [200, 200]);
  const entries = store.read().audit;
  const groups = new Map();
  for (const entry of entries) {
    const correlationId = JSON.parse(entry.record.content).correlationId;
    assert.ok(correlationId);
    groups.set(correlationId, [...(groups.get(correlationId) ?? []), entry]);
  }
  assert.equal(groups.size, 2);
  for (const group of groups.values()) {
    assert.equal(group.length, 2);
    assert.notEqual(group[0].id, group[1].id);
    assert.deepEqual(group.map(({ record }) => record.result).sort(), ['success', 'unknown']);
  }

  for (const generated of [['collision', 'collision'], ['x'.repeat(129), 'intent', 'success', 'unknown']]) {
    const badIds = [...generated];
    const bad = await fixture(t, { createAuditId: () => badIds.shift() ?? 'fallback' });
    const before = bad.store.read();
    const response = await bad.router(validRequest('POST', '/quota/reset', { kind: 'post' }));
    assert.notEqual(response.status, 200);
    assert.deepEqual(bad.store.read(), before);
  }
});

test('关联 ID 若会触发审计脱敏则在写意图前拒绝，避免关联信息被抹除', async (t) => {
  const sensitiveCorrelationId = 'sk-abcdefghijkl';
  const formatted = formatAuditRecord({ time: NOW, source: 'admin_console', action: 'reset_quota',
    target: '123456', operator: '987654', pauseScope: 'both',
    content: JSON.stringify({ correlationId: sensitiveCorrelationId, selection: 'post', phase: 'intent' }), result: 'unknown' });
  assert.equal(formatted.redacted, true);

  const ids = [sensitiveCorrelationId, 'intent-id', 'success-id', 'unknown-id'];
  const { router, store } = await fixture(t, { createAuditId: () => ids.shift() });
  const before = store.read();
  const response = await router(validRequest('POST', '/quota/reset', { kind: 'post' }));
  assert.deepEqual(response, { status:  500, body: { ok: false, error: 'operation_failed' } });
  assert.deepEqual(store.read(), before);
});

test('各阶段审计 ID 含疑似密钥时拒绝管理操作且不落盘', async (t) => {
  for (const position of [1, 2, 3]) {
    const ids = ['corr-valid', 'intent-valid', 'success-valid', 'unknown-valid'];
    const credential = 'sk-abcdefghijklmnop';
    ids[position] = credential;
    const { router, store } = await fixture(t, { createAuditId: () => ids.shift() });
    const before = store.read();
    const response = await router(validRequest('POST', '/quota/reset', { kind: 'post' }));
    assert.notEqual(response.status, 200);
    assert.deepEqual(store.read(), before);
    assert.equal(JSON.stringify(store.read()).includes(credential), false);
  }
});

test('恢复事务异常时只记 unknown；即使结果审计失败也不声称一定持久化', async () => {
  let value = initialState();
  let updates = 0;
  const store = {
    read() { return structuredClone(value); },
    update(fn) {
      updates++;
      if (updates === 4) throw new Error('commit status uncertain');
      if (updates === 6) throw new Error('audit unavailable');
      const next = fn(structuredClone(value));
      value = structuredClone(next);
      return structuredClone(value);
    },
  };
  const router = mockRouter(null, store);
  const response = await router(validRequest('POST', '/pause/restore', { layer: 'both' }));
  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'operation-outcome-unknown');
  assert.equal(value.accessPaused, true);
  assert.equal(value.audit.length, 1);
  assert.equal(value.audit[0].record.result, 'unknown');
  assert.match(value.audit[0].record.content, /"phase":"intent"/);
});

test('操作异常时成功持久化的未知结果与意图关联且使用独立记录 ID', async () => {
  let updates = 0;
  const store = mockStore(initialState(), (fn, read, write) => {
    updates++;
    if (updates === 4) throw new Error('operation result uncertain');
    const next = fn(read());
    write(next);
    return next;
  });
  const ids = ['corr-unknown', 'intent-unknown', 'success-unknown', 'outcome-unknown'];
  const router = mockRouter(null, store, { createAuditId: () => ids.shift() });
  const response = await router(validRequest('POST', '/pause/restore', { layer: 'both' }));
  assert.deepEqual(response, { status: 500, body: { ok: false, error: 'operation-outcome-unknown' } });
  const entries = store.current().audit;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].record.result, 'unknown');
  assert.equal(entries[1].record.result, 'unknown');
  assert.equal(JSON.parse(entries[0].record.content).correlationId, 'corr-unknown');
  assert.equal(JSON.parse(entries[1].record.content).correlationId, 'corr-unknown');
  assert.notEqual(entries[0].id, entries[1].id);
});

test('时钟倒退时不执行管理变更，也不写入早于意图的结果时间', async () => {
  const store = mockStore(initialState());
  const times = [NOW, NOW - 1, NOW - 2, NOW - 3];
  const ids = ['corr-clock-back', 'intent-clock-back', 'success-clock-back', 'unknown-clock-back'];
  const router = mockRouter(null, store, {
    clock: () => times.shift() ?? NOW - 10,
    createAuditId: () => ids.shift(),
  });
  const before = store.current();
  const response = await router(validRequest('POST', '/pause/restore', { layer: 'both' }));
  assert.deepEqual(response, { status: 500, body: { ok: false, error: 'operation-outcome-unknown' } });
  const after = store.current();
  assert.equal(after.accessPaused, before.accessPaused);
  assert.equal(after.writePaused, before.writePaused);
  assert.equal(after.audit.length, 1);
  assert.equal(after.audit[0].record.result, 'unknown');
  assert.equal(JSON.parse(after.audit[0].record.content).phase, 'intent');
});

test('状态与 success 审计已提交后存储抛错时保留 success 和 unknown 两条结果证据', async () => {
  let updates = 0;
  const store = mockStore(initialState(), (fn, read, write) => {
    updates++;
    const next = fn(read());
    write(next);
    if (updates === 4) throw new Error('commit succeeded but acknowledgement failed');
    return next;
  });
  // The store's throw happens after the action update; a pre-sampled unknown
  // timestamp (+50) would sort before the success record (+100).
  const times = [NOW, NOW + 100, NOW + 50, NOW + 200];
  const ids = ['corr-commit-unknown', 'intent-commit-unknown', 'success-commit-unknown', 'outcome-commit-unknown'];
  const router = mockRouter(null, store, { clock: () => times.shift() ?? NOW + 4, createAuditId: () => ids.shift() });
  const response = await router(validRequest('POST', '/pause/restore', { layer: 'both' }));
  assert.deepEqual(response, { status: 500, body: { ok: false, error: 'operation-outcome-unknown' } });
  const after = store.current();
  assert.equal(after.accessPaused, false);
  assert.equal(after.writePaused, false);
  assert.deepEqual(after.audit.map(({ record }) => record.result), ['unknown', 'success', 'unknown']);
  const correlated = after.audit.map(({ id, record }) => ({ id, ...JSON.parse(record.content) }));
  assert.ok(correlated.every(({ correlationId }) => correlationId === 'corr-commit-unknown'));
  assert.deepEqual(correlated.map(({ id }) => id), [
    'intent-commit-unknown', 'success-commit-unknown', 'outcome-commit-unknown',
  ]);
  const timesWritten = after.audit.map(({ record }) => record.time);
  assert.ok(timesWritten.every((time, index) => index === 0 || time >= timesWritten[index - 1]));
});

test('意图写入异常时 fail closed；不执行恢复，也不声称意图审计一定持久化', async () => {
  let value = initialState();
  let updates = 0;
  const store = {
    read() { return structuredClone(value); },
    update(fn) {
      updates++;
      const next = fn(structuredClone(value));
      value = structuredClone(next);
      if (updates === 2) throw new Error('commit then disconnect');
      return structuredClone(value);
    },
  };
  const response = await mockRouter(null, store)(validRequest('POST', '/pause/restore', { layer: 'both' }));
  assert.deepEqual(response, { status: 503, body: { ok: false, error: 'audit-outcome-unknown' } });
  assert.equal(value.accessPaused, true);
  assert.equal(value.writePaused, true);
  assert.equal(value.audit.length, 1);
  assert.equal(value.audit[0].record.result, 'unknown');
});

test('延迟执行 update callback 的存储不能在路由返回后写入意图审计', async () => {
  let value = initialState();
  const pending = [];
  const store = {
    read() { return structuredClone(value); },
    update(fn) {
      pending.push(fn);
      setImmediate(() => {
        const next = fn(structuredClone(value));
        value = structuredClone(next);
      });
      return undefined;
    },
  };
  const response = await mockRouter(null, store)(validRequest('POST', '/pause/restore', { layer: 'both' }));
  assert.equal(response.status, 503);
  assert.equal(value.audit.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  // This tests a cooperative delayed callback; a malicious store that commits independently
  // of the supplied callback is outside the synchronous update contract and cannot be fenced here.
  assert.equal(pending.length, 1);
  assert.equal(value.audit.length, 0);
  assert.equal(value.accessPaused, true);
  assert.equal(value.writePaused, true);
});

test('鉴权失败或非法恢复请求不会写管理意图审计', async (t) => {
  const { router, store } = await fixture(t);
  assert.equal((await router({ method: 'POST', path: '/pause/restore', body: { layer: 'both' }, sessionToken: 'bad' })).status, 401);
  assert.equal((await router(validRequest('POST', '/pause/restore', { layer: 'invalid' }))).status, 400);
  assert.equal(store.read().audit.length, 0);
});

test('鉴权失效与鉴权异常均拒绝，返回内容不包含敏感请求或异常文本', async (t) => {
  const secret = 'Bearer qzonetoken-secret-value';
  const { router } = await fixture(t, {
    authenticate: (context) => {
      if (context.sessionToken === 'throws') throw new Error(secret);
      return { valid: false, operator: 'should-not-be-used' };
    },
  });
  for (const token of ['expired-session', 'throws']) {
    const response = await router({ method: 'POST', path: '/pause/restore', body: { layer: 'both', reason: secret }, sessionToken: token });
    assert.equal(response.status, 401);
    assert.equal(JSON.stringify(response).includes(secret), false);
    assert.equal(JSON.stringify(response).includes(token), false);
  }
});

test('鉴权结果读取异常也必须 fail closed', async (t) => {
  const { router } = await fixture(t, {
    authenticate: () => Object.defineProperty({}, 'valid', { get() { throw new Error('credential-secret'); } }),
  });
  const response = await router(validRequest('GET', '/status'));
  assert.deepEqual(response, { status: 401, body: { ok: false, error: 'unauthorized' } });
});

test('鉴权 operator accessor 不执行且不能在鉴权校验与审计之间改变身份', async (t) => {
  const store = mockStore(initialState());
  let getterCalls = 0;
  const router = mockRouter(t, store, {
    authenticate: () => ({
      valid: true,
      get operator() { getterCalls++; return getterCalls < 3 ? '987654' : 'attacker'; },
    }),
  });
  const response = await router(validRequest('PATCH', '/config', { enabled: false }));
  assert.equal(response.status, 401);
  assert.equal(getterCalls, 0);
  assert.equal(store.current().enabled, true);
  assert.equal(store.current().audit.length, 0);
});

test('reset 和 restore 在各自事务内验证完整关键状态，损坏状态保持不变', async (t) => {
  for (const [path, body] of [
    ['/quota/reset', { kind: 'post' }],
    ['/pause/restore', { layer: 'both' }],
  ]) {
    const damaged = initialState();
    delete damaged.enabled;
    const store = mockStore(damaged);
    const before = store.current();
    const response = await mockRouter(t, store)(validRequest('POST', path, body));
    assert.notEqual(response.status, 200, `${path} must reject damaged state`);
    const after = store.current();
    assert.deepEqual({ ...after, audit: before.audit }, before);
    assert.equal(after.audit[0].record.result, 'unknown');
    assert.match(after.audit[0].record.content, /"phase":"intent"/);
    assert.equal(after.audit.at(-1).record.result, 'unknown');
  }
});

test('reset/restore 不依赖事务前状态预检；事务回调看到的损坏状态会阻止变更', async (t) => {
  let value = initialState();
  let updates = 0;
  const store = {
    read() { return structuredClone(value); },
    update(fn) {
      updates++;
      if (updates === 1) {
        const probeResult = fn(structuredClone(value));
        value = { ...value, tools: null };
        return probeResult;
      }
      const next = fn(structuredClone(value));
      value = structuredClone(next);
      return structuredClone(value);
    },
  };
  const beforeMutation = store.read();
  const response = await mockRouter(t, store)(validRequest('POST', '/pause/restore', { layer: 'both' }));
  assert.equal(response.status, 500);
  const after = store.read();
  assert.deepEqual({ ...after, audit: beforeMutation.audit }, { ...beforeMutation, tools: null });
  assert.equal(after.audit.at(-1).record.result, 'unknown');
  assert.equal(updates, 6);
});

test('store 抛出的 Proxy 异常按固定失败响应处理且绝不窥视异常', async (t) => {
  const secret = 'store-error-secret';
  const store = {
    read() { throw new Proxy({}, { getPrototypeOf() { throw new Error(secret); } }); },
    update(fn) { return fn(initialState()); },
  };
  const response = await mockRouter(t, store)(validRequest('GET', '/status'));
  assert.deepEqual(response, { status: 500, body: { ok: false, error: 'operation_failed' } });
  assert.equal(JSON.stringify(response).includes(secret), false);
});

test('仅接受同步即时事务；Promise 与延迟 callback 均拒绝且 callback 不得后续改状态', async (t) => {
  const start = initialState();
  const asyncStore = mockStore(start, (fn, read, write) => {
    const next = fn(read());
    return Promise.resolve().then(() => { write(next); return structuredClone(next); });
  });
  const asyncResponse = await mockRouter(t, asyncStore)(validRequest('PATCH', '/config', { enabled: false }));
  await Promise.resolve();
  assert.notEqual(asyncResponse.status, 200);
  assert.equal(asyncStore.current().enabled, true);
  assert.equal(asyncStore.current().audit.length, 0);

  const rejectedStore = mockStore(start, (fn, read) => {
    fn(read());
    return Promise.reject(new Error('async-store-secret'));
  });
  const rejectedResponse = await mockRouter(t, rejectedStore)(validRequest('PATCH', '/config', { enabled: false }));
  assert.deepEqual(rejectedResponse, { status: 500, body: { ok: false, error: 'operation_failed' } });
  await new Promise((resolve) => setImmediate(resolve));

  let delayedCallback;
  const delayedStore = mockStore(start, (fn) => {
    delayedCallback = fn;
    return undefined;
  });
  const delayedResponse = await mockRouter(t, delayedStore)(validRequest('POST', '/pause/restore', { layer: 'both' }));
  assert.notEqual(delayedResponse.status, 200);
  delayedCallback(delayedStore.current());
  assert.equal(delayedStore.current().accessPaused, true);
  assert.equal(delayedStore.current().audit.length, 0);
});

test('审计事务失败时状态不变且不泄露存储错误', async (t) => {
  const { router, store } = await fixture(t, { createAuditId: () => 'duplicate-audit' });
  store.update((state) => ({ ...state, audit: [{ id: 'duplicate-audit', record: { content: 'different' } }] }));
  const before = store.read();
  const response = await router(validRequest('PATCH', '/config', { enabled: false }));
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(response).includes('different'), false);
  assert.deepEqual(store.read(), before);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// M10 · audit-fault recovery route — CONSTRUCTION-TIME OPT-IN, DEFAULT DISABLED
//
// 这些用例只钉新路径与其默认关闭的边界，不重跑既有四条路由的语义（那一组在上面已全绿）。
// 全部使用真实临时 SQLite；不接监听、不碰生产构造。
// ══════════════════════════════════════════════════════════════════════════════════════════

const FAULT_PATH = '/audit/fault/restore';
const faultReq = (body, token = 'valid-session') => ({ method: 'POST', path: FAULT_PATH, body, sessionToken: token });

/** 构造一个可切换 opt-in 的 router，复用本文件已有的 authenticate 约定。 */
function faultRouter(store, { enable, createAuditId } = {}) {
  let seq = 0;
  return createOfflineQzoneAdminRouter({
    store, clock: () => NOW, selfId: '123456',
    authenticate: (context) => (context.sessionToken === 'valid-session'
      ? { valid: true, operator: '987654' } : { valid: false }),
    createAuditId: createAuditId ?? (() => `fault-audit-${++seq}`),
    ...(enable === undefined ? {} : { enableAuditFaultRestore: enable }),
  });
}

const openGap = (generation = 'gen-1') => ({
  key: `gap-${generation}`, reason: 'audit-write-failed', generation, time: NOW - 1000,
});

test('M10-1 默认禁用：认证通过仍 404，且零改动（与「这条路由不存在」不可区分）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState({ auditGaps: [openGap()] }));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const router = faultRouter(store);   // 不传 enableAuditFaultRestore

  const before = JSON.stringify(store.read());
  const r = await router(faultReq({ expectedGeneration: 'gen-1' }));
  assert.equal(r.status, 404, '★★★ 默认未 opt-in 时必须 404');
  assert.equal(r.body.error, 'not_found');
  assert.equal(JSON.stringify(store.read()), before, '★★★ 零改动：无恢复、无审计行');

  // GET 同样 404（路由不存在，不是方法不对）
  const g = await router({ method: 'GET', path: FAULT_PATH, sessionToken: 'valid-session' });
  assert.equal(g.status, 404, '★ 默认禁用时 GET 也是 404');
});

test('M10-2 请求里伪造开关无效：body/query/header 都不能启用', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState({ auditGaps: [openGap()] }));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const router = faultRouter(store);

  const before = JSON.stringify(store.read());
  const attempts = [
    { expectedGeneration: 'gen-1', enableAuditFaultRestore: true },
    { expectedGeneration: 'gen-1', enabled: true },
    { expectedGeneration: 'gen-1', auditFaultRestore: true },
  ];
  for (const body of attempts) {
    const r = await router(faultReq(body));
    assert.equal(r.status, 404, `★★★ body ${JSON.stringify(body)} 不得启用路由`);
  }
  assert.equal(JSON.stringify(store.read()), before, '★★ 零改动');
});

test('M10-3 构造期非法开关值被拒（不是真布尔就不能开）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState());
  try {
    for (const bad of ['true', 1, null, {}]) {
      assert.throws(() => createOfflineQzoneAdminRouter({
        store, clock: () => NOW, selfId: '123456',
        authenticate: () => ({ valid: true, operator: '987654' }),
        enableAuditFaultRestore: bad,
      }), /invalid enableAuditFaultRestore/, `★★ ${JSON.stringify(bad)} 不是合法开关值`);
    }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('M10-4 构造启用后未授权 → 401，零恢复零审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState({ auditGaps: [openGap()] }));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const router = faultRouter(store, { enable: true });

  const before = JSON.stringify(store.read());
  const r = await router(faultReq({ expectedGeneration: 'gen-1' }, 'bad-session'));
  assert.equal(r.status, 401, '★★★ 未授权必须 401');
  assert.equal(r.body.error, 'unauthorized');
  assert.equal(JSON.stringify(store.read()), before, '★★★ 零恢复、零成功审计');
});

test('M10-5 合法管理员完成一次 gap 恢复：缺口被标注、审计与变更同事务', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const gap = openGap('gen-1');
  const store = openOfflineStore(join(dir, 'state.db'), initialState({ auditGaps: [gap] }));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const router = faultRouter(store, { enable: true });

  const r = await router(faultReq({ expectedGeneration: 'gen-1' }));
  assert.equal(r.status, 200, `★★★ 合法恢复应成功，实际：${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.result, 'success');
  assert.equal(r.body.resolvedGapCount, 1);

  const after = store.read();
  assert.notEqual(after.auditGaps[0].resolvedBy, null, '★★ 缺口被标注为已解决（不删除）');
  assert.equal(after.audit.length, 1, '★★ 恰好一条恢复审计');
  assert.equal(after.audit[0].record.source, 'admin_console', '★ 来源是受控构造依赖');
  assert.equal(after.audit[0].record.operator, '987654', '★★ operator 来自鉴权结果，不是请求体');
});

test('M10-6 同进程 latch-only 恢复：锁存被清除，且没有缺口可标', async (t) => {
  const { latchFault, readFaultLatch } = await import('../src/core/qzone-write-path-offline.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState());
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  latchFault(store, 'latch-only-fault');
  const before = readFaultLatch(store);
  assert.equal(before.revision, 1, '前提：锁存已建立');

  const router = faultRouter(store, { enable: true });
  const r = await router(faultReq({ expectedGeneration: 'gen-1', expectedLatchRevision: before.revision }));
  assert.equal(r.status, 200, `★★★ latch-only 恢复应成功：${JSON.stringify(r.body)}`);
  assert.equal(r.body.resolvedGapCount, 0, '★ 无缺口可标');
  assert.equal(r.body.releasedLatch, true, '★★ 锁存确实被释放');
  assert.equal(readFaultLatch(store), null, '★★★ 进程内锁存已清除');
});

test('M10-7 代际不符 → 409 明确拒绝，锁存保留', async (t) => {
  const { latchFault, readFaultLatch } = await import('../src/core/qzone-write-path-offline.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState({ auditGaps: [openGap('gen-2')] }));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  latchFault(store, 'must-survive');
  const router = faultRouter(store, { enable: true });

  const r = await router(faultReq({ expectedGeneration: 'gen-WRONG', expectedLatchRevision: 1 }));
  assert.equal(r.status, 409, '★★★ 代际不符是业务拒绝，不是 200');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'recovery_refused');
  assert.equal(r.body.reason, 'generation-mismatch', '★ 原因来自 M9 的闭集词表');
  assert.equal(r.body.trail, 'recorded', '★ 拒绝被记为 denied 审计');
  assert.notEqual(readFaultLatch(store), null, '★★★ 锁存必须保留');
});

test('M10-8 请求体不得自报管理身份：operator/source/target/time/auditId 一律 400', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState({ auditGaps: [openGap()] }));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const router = faultRouter(store, { enable: true });

  const before = JSON.stringify(store.read());
  for (const forged of [
    { operator: 'attacker' }, { source: 'admin_script' }, { target: '999' },
    { time: NOW + 99999 }, { auditId: 'forged-id' }, { correlationId: 'forged-correlation' },
  ]) {
    const r = await router(faultReq({ expectedGeneration: 'gen-1', ...forged }));
    assert.equal(r.status, 400, `★★★ 请求体自带 ${Object.keys(forged)[0]} 必须被拒`);
  }
  assert.equal(JSON.stringify(store.read()), before, '★★ 全部零副作用');
});

test('M10-9 缺 expectedGeneration → 400（不伪造默认代际）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState({ auditGaps: [openGap()] }));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const router = faultRouter(store, { enable: true });

  for (const body of [{}, { expectedLatchRevision: 1 }, { expectedGeneration: '' }, { expectedGeneration: 'has space' }]) {
    const r = await router(faultReq(body));
    assert.equal(r.status, 400, `★★ body ${JSON.stringify(body)} 必须 400`);
  }
});

test('M10-10 启用后响应体不含原始状态、缺口内容或异常文本', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-router-m10-'));
  const store = openOfflineStore(join(dir, 'state.db'),
    initialState({ auditGaps: [openGap()], token: 'state-secret' }));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const router = faultRouter(store, { enable: true });

  const r = await router(faultReq({ expectedGeneration: 'gen-1' }));
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  assert.equal(text.includes('state-secret'), false, '★★★ 不得泄露状态里的凭据字段');
  assert.equal(text.includes('gap-gen-1'), false, '★★ 不得回显缺口 key');
  assert.equal(text.includes('audit-write-failed'), false, '★★ 不得回显缺口 reason');
  // 只允许最小投影字段
  assert.deepEqual(Object.keys(r.body).sort(),
    ['ok', 'releasedLatch', 'resolvedGapCount', 'result'], '★★ 只返回最小投影');
});
