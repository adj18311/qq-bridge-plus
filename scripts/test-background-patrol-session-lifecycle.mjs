// scripts/test-background-patrol-session-lifecycle.mjs
// task-41：后台巡逻会话生命周期纯模块测试（TDD 先红后绿）。
// 会话操作全部注入（createSession/sessionExists/archiveSession + store），不真实调 DSH。
// 覆盖：首次创建 / 复用 / 5 天边界轮换 / 丢失重建 / 关闭归档保留 / 默认关闭零副作用 /
// 并发单建 / 持久化失败 fail-closed / 结构化审计事件。
// 纯离线：只用内存假会话与内存 store；不联网、不写 state/、不读凭据。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKGROUND_SESSION_KEY,
  BACKGROUND_SESSION_LIFECYCLE_VERSION,
  BACKGROUND_SESSION_ROTATION_MS,
  BACKGROUND_SESSION_AUDIT_EVENT_TYPES,
  createBackgroundPatrolSessionLifecycle,
} from '../src/core/background-patrol-session-lifecycle.mjs';

const T0 = Date.UTC(2026, 9, 24, 2, 0, 0); // 北京时间 2026-10-24 10:00
const DAY = 24 * 60 * 60 * 1000;

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 内存 store：load 返回副本；save 记录并支持失败注入/坏状态注入。 */
function makeStore(initial = null) {
  let state = jsonClone(initial);
  const saves = [];
  const control = {
    failSave: false,
    loadThrows: false,
    badInitial: undefined,
    saves,
    get state() {
      return jsonClone(state);
    },
  };
  return {
    control,
    async load() {
      if (control.loadThrows) throw Object.assign(new Error('read EACCES'), { code: 'EACCES' });
      if (control.badInitial !== undefined) return jsonClone(control.badInitial);
      return jsonClone(state);
    },
    async save(next) {
      if (control.failSave) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      state = jsonClone(next);
      saves.push(jsonClone(next));
    },
  };
}

/** 假会话操作：记录调用顺序；id 队列/存在性/归档失败均可控。 */
function makeSessions(options = {}) {
  const calls = { create: [], exists: [], archive: [] };
  const control = {
    ids: ['sess-1', 'sess-2', 'sess-3', 'sess-4'],
    nextIdIndex: 0,
    existsDefault: true,
    missingIds: new Set(),
    archiveFails: false,
    createResult: undefined,
    createThrows: false,
  };
  return {
    control,
    calls,
    async createSession() {
      calls.create.push(true);
      if (control.createThrows) throw new Error('create exploded');
      if (control.createResult !== undefined) return control.createResult;
      const id = control.ids[control.nextIdIndex] ?? `sess-${control.nextIdIndex + 1}`;
      control.nextIdIndex += 1;
      return id;
    },
    async sessionExists(id) {
      calls.exists.push(id);
      if (control.missingIds.has(id)) return false;
      return control.existsDefault;
    },
    async archiveSession(id) {
      calls.archive.push(id);
      if (control.archiveFails) throw new Error('archive failed');
    },
  };
}

function makeLifecycle(options = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(options, key);
  const config = has('config') ? options.config : { enabled: true };
  const store = has('store') ? options.store : makeStore();
  const sessions = has('sessions') ? options.sessions : makeSessions();
  const clock = has('clock') ? options.clock : (() => T0);
  const audit = has('audit') ? options.audit : null;
  const events = [];
  const lifecycle = createBackgroundPatrolSessionLifecycle({
    config,
    store: store.store ?? store,
    sessions,
    clock,
    audit: (event) => {
      events.push(event);
      if (typeof audit === 'function') audit(event);
    },
  });
  return { lifecycle, store, sessions, events };
}

function expectOk(result, label = '') {
  assert.equal(result?.ok, true, `${label} 期望 ok:true，实际 ${JSON.stringify(result)}`);
  return result;
}

function expectFail(result, reason, label = '') {
  assert.equal(result?.ok, false, `${label} 期望 ok:false，实际 ${JSON.stringify(result)}`);
  assert.equal(result?.reason, reason, `${label} 期望 reason:${reason}，实际 ${JSON.stringify(result)}`);
  return result;
}

function expectState(lifecycle, expected, label = '') {
  return lifecycle.status().then((status) => {
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(status[key], value, `${label} status.${key} 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(status[key])}`);
    }
    return status;
  });
}

test('exports: session key / version / 5-day rotation / audit event whitelist', () => {
  assert.equal(BACKGROUND_SESSION_KEY, 'patrol:background');
  assert.equal(BACKGROUND_SESSION_LIFECYCLE_VERSION, 1);
  assert.equal(BACKGROUND_SESSION_ROTATION_MS, 5 * DAY);
  assert.ok(Object.isFrozen(BACKGROUND_SESSION_AUDIT_EVENT_TYPES));
  assert.deepEqual(
    [...BACKGROUND_SESSION_AUDIT_EVENT_TYPES].sort(),
    ['archive', 'create', 'disabled', 'persist-failed', 'rebuild', 'reuse', 'rotate'].sort(),
  );
  assert.equal(typeof createBackgroundPatrolSessionLifecycle, 'function');
});

test('默认关闭：enabled !== true 时 ensure 返回 disabled 且零副作用（不调会话/不写 store）', async () => {
  // task-62（P2-1）：合法但未启用的配置仍返回笼统 'disabled'；
  // 配置本身非法（enabled 非布尔 / 整份不是对象）时，lifecycle 现在透出 resolve 阶段的精确
  // invalid-* 原因（不再一律吞成 'disabled'）——否则运维分不清「明确关闭」与「配置写错」。
  const validDisabled = [undefined, null, {}, { enabled: false }];
  const invalidConfig = [{ enabled: 'true' }, { enabled: 1 }, 'true', 1];
  for (const config of [...validDisabled, ...invalidConfig]) {
    const { lifecycle, store, sessions, events } = makeLifecycle({ config });
    const result = await lifecycle.ensureSession();
    if (validDisabled.includes(config)) {
      expectFail(result, 'disabled');
    } else {
      assert.equal(result?.ok, false, `期望 ok:false，实际 ${JSON.stringify(result)}`);
      assert.match(String(result?.reason), /^invalid-/, `非法配置必须透出精确原因，实际 ${JSON.stringify(result)}`);
      assert.notEqual(result?.reason, 'disabled', '非法配置不得退回笼统 disabled');
    }
    assert.deepEqual(sessions.calls.create, [], '默认关闭不得 create');
    assert.deepEqual(sessions.calls.exists, [], '默认关闭不得 exists');
    assert.deepEqual(sessions.calls.archive, [], '默认关闭不得 archive');
    assert.deepEqual(store.control.saves, [], '默认关闭不得写 store');
    assert.equal(events.filter((event) => event.type === 'disabled').length, 1);
    assert.equal((await lifecycle.status()).enabled, false);
  }
});

test('首次创建：create + 持久化 + create 审计；runCount=1', async () => {
  const { lifecycle, store, sessions, events } = makeLifecycle();
  const result = expectOk(await lifecycle.ensureSession());
  assert.equal(result.created, true);
  assert.equal(result.sessionId, 'sess-1');
  assert.deepEqual(sessions.calls.create, [true]);
  const saved = store.control.state;
  assert.equal(saved.sessionId, 'sess-1');
  assert.equal(saved.createdAt, T0);
  assert.equal(saved.lastUsedAt, T0);
  assert.equal(saved.runCount, 1);
  assert.equal(saved.archived, false);
  assert.equal(saved.sessionKey, 'patrol:background');
  await expectState(lifecycle, { enabled: true, sessionId: 'sess-1', runCount: 1, archived: false });

  const createEvent = events.find((event) => event.type === 'create');
  assert.ok(createEvent);
  assert.equal(createEvent.sessionId, 'sess-1');
  assert.equal(createEvent.sessionKey, 'patrol:background');
  assert.equal(createEvent.at, T0);
  assert.equal(createEvent.runCount, 1);
});

test('复用：5 天内且 sessionExists → created:false，不重建，只更新 lastUsedAt/runCount', async () => {
  const first = makeLifecycle();
  expectOk(await first.lifecycle.ensureSession());
  const { lifecycle, sessions, store, events } = makeLifecycle({ store: first.store });
  const result = expectOk(await lifecycle.ensureSession());
  assert.equal(result.created, false);
  assert.equal(result.sessionId, 'sess-1');
  assert.deepEqual(sessions.calls.create, [], '复用时不得 create');
  assert.deepEqual(sessions.calls.exists, ['sess-1']);
  assert.deepEqual(sessions.calls.archive, []);
  const saved = store.control.state;
  assert.equal(saved.runCount, 2);
  assert.equal(saved.lastUsedAt, T0);
  assert.equal(events.filter((event) => event.type === 'reuse').length, 1);
});

test('5 天边界轮换：恰好 5 天轮换（归档旧 + 新建），5 天 - 1ms 仍复用', async () => {
  const sessions = makeSessions();
  const first = makeLifecycle({ sessions });
  expectOk(await first.lifecycle.ensureSession());

  // 4 天 23:59:59.999 → 复用
  const justBefore = makeLifecycle({ store: first.store, sessions, clock: () => T0 + BACKGROUND_SESSION_ROTATION_MS - 1 });
  assert.equal((await justBefore.lifecycle.ensureSession()).created, false);
  assert.deepEqual(justBefore.sessions.calls.archive, []);

  // 恰好 5 天 → 轮换（共享 sessions 让 create 返回 sess-2）
  const rotated = makeLifecycle({ store: justBefore.store, sessions, clock: () => T0 + BACKGROUND_SESSION_ROTATION_MS });
  const result = expectOk(await rotated.lifecycle.ensureSession());
  assert.equal(result.created, true);
  assert.equal(result.rotated, true);
  assert.notEqual(result.sessionId, 'sess-1');
  assert.equal(result.sessionId, 'sess-2');
  assert.deepEqual(rotated.sessions.calls.archive, ['sess-1'], '轮换必须先归档旧 session');
  const saved = rotated.store.control.state;
  assert.equal(saved.sessionId, 'sess-2');
  assert.equal(saved.createdAt, T0 + BACKGROUND_SESSION_ROTATION_MS);
  assert.equal(saved.runCount, 1);
  assert.equal(saved.rotationCount, 1);
  assert.equal(saved.archived, false);
  const rotateEvent = rotated.events.find((event) => event.type === 'rotate');
  assert.ok(rotateEvent);
  assert.equal(rotateEvent.previousSessionId, 'sess-1');
  assert.equal(rotateEvent.sessionId, 'sess-2');
});

test('轮换时归档失败：fail-closed，不创建新 session、状态不变', async () => {
  const first = makeLifecycle();
  expectOk(await first.lifecycle.ensureSession());
  const rotated = makeLifecycle({ store: first.store, clock: () => T0 + BACKGROUND_SESSION_ROTATION_MS });
  rotated.sessions.control.archiveFails = true;
  const result = await rotated.lifecycle.ensureSession();
  expectFail(result, 'archive-failed');
  assert.deepEqual(rotated.sessions.calls.create, [], '归档失败不得创建新 session');
  const saved = rotated.store.control.state;
  assert.equal(saved.sessionId, 'sess-1');
  assert.equal(saved.rotationCount, 0);
});

test('session 丢失：sessionExists=false → 重建新 id + rebuild 审计（不静默复用失效 id）', async () => {
  const sessions = makeSessions();
  const first = makeLifecycle({ sessions });
  expectOk(await first.lifecycle.ensureSession());
  const rebuilt = makeLifecycle({ store: first.store, sessions });
  rebuilt.sessions.control.missingIds.add('sess-1');
  const result = expectOk(await rebuilt.lifecycle.ensureSession());
  assert.equal(result.created, true);
  assert.equal(result.rebuilt, true);
  assert.notEqual(result.sessionId, 'sess-1');
  assert.equal(rebuilt.sessions.calls.create.length, 2, '首次创建 + 丢失重建各一次 create');
  assert.deepEqual(rebuilt.sessions.calls.archive, [], '丢失的 session 无需归档');
  const saved = rebuilt.store.control.state;
  assert.equal(saved.sessionId, result.sessionId);
  assert.equal(saved.runCount, 1);
  const rebuildEvent = rebuilt.events.find((event) => event.type === 'rebuild');
  assert.ok(rebuildEvent);
  assert.equal(rebuildEvent.previousSessionId, 'sess-1');
  assert.equal(rebuildEvent.sessionId, result.sessionId);
});

test('关闭：archive 旧会话、保留历史记录、状态 archived；ensure 之后返回 closed 且不再创建', async () => {
  const { lifecycle, store, sessions, events } = makeLifecycle();
  expectOk(await lifecycle.ensureSession());
  const closed = expectOk(await lifecycle.close({ archive: true }));
  assert.equal(closed.archived, true);
  assert.equal(closed.sessionId, 'sess-1');
  assert.deepEqual(sessions.calls.archive, ['sess-1']);
  const saved = store.control.state;
  assert.equal(saved.archived, true);
  assert.equal(saved.sessionId, 'sess-1', '归档保留历史 sessionId');
  assert.equal(saved.createdAt, T0);
  assert.ok(saved.archivedAt >= T0);
  assert.equal(events.filter((event) => event.type === 'archive').length, 1);

  const again = await lifecycle.ensureSession();
  expectFail(again, 'closed');
  assert.deepEqual(sessions.calls.create, [true], '关闭后不得再创建');
  assert.deepEqual(sessions.calls.archive, ['sess-1'], '关闭后不得再归档');
});

test('关闭 archive:false：保留会话且不标 archived，可再次 ensure 复用', async () => {
  const { lifecycle, store, sessions } = makeLifecycle();
  const first = expectOk(await lifecycle.ensureSession());
  const closed = expectOk(await lifecycle.close({ archive: false }));
  assert.equal(closed.archived, false);
  assert.equal(closed.sessionId, first.sessionId);
  assert.deepEqual(sessions.calls.archive, [], 'archive:false 不得归档会话');
  assert.equal(store.control.state.archived, false, 'archive:false 不得把状态标 archived');
  const again = expectOk(await lifecycle.ensureSession());
  assert.equal(again.sessionId, first.sessionId, '再次 ensure 复用同一会话');
  assert.deepEqual(sessions.calls.create, [true], '不得重复创建');
});

test('关闭后新实例从持久状态加载：仍为 archived，ensure 返回 closed', async () => {
  const first = makeLifecycle();
  expectOk(await first.lifecycle.ensureSession());
  expectOk(await first.lifecycle.close({ archive: true }));
  const second = makeLifecycle({ store: first.store });
  expectFail(await second.lifecycle.ensureSession(), 'closed');
  const status = await second.lifecycle.status();
  assert.equal(status.archived, true);
  assert.equal(status.sessionId, 'sess-1');
  assert.deepEqual(second.sessions.calls.create, []);
});

test('关闭时 archive 失败：closed 失败返回 archive-failed，状态保持可用（未 archived）', async () => {
  const { lifecycle, store, sessions } = makeLifecycle();
  expectOk(await lifecycle.ensureSession());
  sessions.control.archiveFails = true;
  expectFail(await lifecycle.close({ archive: true }), 'archive-failed');
  assert.equal(store.control.state.archived, false);
  sessions.control.archiveFails = false;
  expectOk(await lifecycle.ensureSession(), '归档失败后应仍可复用（未关闭）');
});

test('并发 ensureSession：串行只有一次 create，两个调用拿到同一 id', async () => {
  const { lifecycle, sessions } = makeLifecycle();
  const [a, b] = await Promise.all([lifecycle.ensureSession(), lifecycle.ensureSession()]);
  expectOk(a);
  expectOk(b);
  assert.deepEqual(sessions.calls.create, [true], '并发 ensure 只创建一次');
  assert.equal(a.sessionId, b.sessionId);
  assert.equal([a.created, b.created].filter(Boolean).length, 1, '恰好一个 created:true');
});

test('持久化失败：返回 persist-failed 并 fail-closed（不把未落盘的会话当可复用）', async () => {
  const { lifecycle, store, sessions, events } = makeLifecycle();
  store.control.failSave = true;
  expectFail(await lifecycle.ensureSession(), 'persist-failed');
  assert.deepEqual(sessions.calls.create, [true]);
  assert.equal(events.filter((event) => event.type === 'persist-failed').length, 1);
  // 后续调用依然 fail-closed，绝不复用未落盘的 sess-1，也不再次 create。
  expectFail(await lifecycle.ensureSession(), 'persist-failed');
  assert.deepEqual(sessions.calls.create, [true], '持久化失败后不得继续创建/复用');
  assert.equal((await lifecycle.status()).sessionId, null);
});

test('持久状态损坏 / store.load 抛错：fail-closed，不 create、不覆盖', async () => {
  // 坏状态：未知字段 + 未知版本
  for (const bad of [
    { ...{}, schemaVersion: 999 },
    { schemaVersion: 1, sessionKey: 'patrol:background', unexpected: true },
    { schemaVersion: 1, sessionKey: 'private:123' },
  ]) {
    const store = makeStore();
    store.control.badInitial = bad;
    const sessions = makeSessions();
    const { lifecycle } = makeLifecycle({ store, sessions });
    expectFail(await lifecycle.ensureSession(), 'state-invalid');
    assert.deepEqual(sessions.calls.create, [], '坏状态不得 create');
    assert.deepEqual(store.control.saves, [], '坏状态不得覆盖原状态');
  }
  // load 抛错
  {
    const store = makeStore();
    store.control.loadThrows = true;
    const sessions = makeSessions();
    const { lifecycle } = makeLifecycle({ store, sessions });
    expectFail(await lifecycle.ensureSession(), 'store-load-failed');
    assert.deepEqual(sessions.calls.create, []);
  }
});

test('create 返回非法 id：create-failed，且不持久化', async () => {
  const sessions = makeSessions();
  sessions.control.createResult = '';
  const { lifecycle, store } = makeLifecycle({ sessions });
  expectFail(await lifecycle.ensureSession(), 'create-failed');
  assert.deepEqual(store.control.saves, []);
});

test('审计事件：类型白名单 + 固定字段 + 不含敏感内容', async () => {
  const sessions = makeSessions();
  const first = makeLifecycle({ sessions });
  expectOk(await first.lifecycle.ensureSession()); // create
  expectOk(await first.lifecycle.ensureSession()); // reuse
  const rotated = makeLifecycle({ store: first.store, sessions, clock: () => T0 + BACKGROUND_SESSION_ROTATION_MS });
  expectOk(await rotated.lifecycle.ensureSession()); // rotate
  const rebuilt = makeLifecycle({ store: rotated.store, sessions });
  rebuilt.sessions.control.missingIds.add(rotated.store.control.state.sessionId);
  expectOk(await rebuilt.lifecycle.ensureSession()); // rebuild
  const archived = makeLifecycle({ store: rebuilt.store, sessions });
  expectOk(await archived.lifecycle.close({ archive: true })); // archive
  const disabled = makeLifecycle({ config: { enabled: false } });
  expectFail(await disabled.lifecycle.ensureSession(), 'disabled'); // disabled

  const all = [...first.events, ...rotated.events, ...rebuilt.events, ...archived.events, ...disabled.events];
  const allowedKeys = new Set(['type', 'at', 'sessionKey', 'sessionId', 'previousSessionId', 'runCount', 'rotationCount', 'archivedAt', 'reason']);
  for (const event of all) {
    assert.ok(BACKGROUND_SESSION_AUDIT_EVENT_TYPES.includes(event.type), `未知事件类型 ${event.type}`);
    assert.equal(event.sessionKey, 'patrol:background');
    assert.equal(typeof event.at, 'number');
    for (const key of Object.keys(event)) {
      assert.ok(allowedKeys.has(key), `审计事件含未声明字段 ${key}`);
    }
    const serialized = JSON.stringify(event);
    assert.ok(!/cookie|token|secret|prompt|password/i.test(serialized), '审计不得含敏感字段');
  }
  const types = new Set(all.map((event) => event.type));
  for (const type of ['create', 'reuse', 'archive', 'rotate', 'rebuild', 'disabled']) {
    assert.ok(types.has(type), `缺少 ${type} 审计事件`);
  }
});

test('status() 返回深拷贝；未初始化时默认关闭且不触发任何会话操作', async () => {
  const { lifecycle, sessions } = makeLifecycle();
  const status = await lifecycle.status();
  assert.equal(status.enabled, true);
  assert.equal(status.sessionId, null);
  assert.deepEqual(sessions.calls, { create: [], exists: [], archive: [] });
  status.sessionId = 'tampered';
  assert.equal((await lifecycle.status()).sessionId, null);
});
