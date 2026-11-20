// scripts/test-read-only-gate.mjs
// 第 1 块：贴吧/小黑盒只读门禁（离线测试，TDD）。
// 目标：readOnly 模式下，任何 agent（owner/group/background）的写工具一律 deny，
// 读取/搜索不受影响；默认（readOnly 缺省/false）行为与现状完全一致。
// 贴吧侧只有 qq_tieba_list / qq_tieba_read 两个只读工具，无写工具（静态断言防止未来误加）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  XHH_AUTHORIZE_WRITE_TOOLS,
  XHH_AUTHORIZE_READ_TOOLS,
  createXhhAuthorizeApi,
} from '../src/core/xiaoheihe-authorize-api.mjs';
import { createXhhAuthorizeRoutes } from '../src/core/xiaoheihe-authorize-route.mjs';
import { createAuthorizeWiring } from '../src/core/xiaoheihe-authorize-wiring.mjs';
import { createBackgroundPatrolBridgeHook } from '../src/core/background-patrol-bridge-hook.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createXhhOperationController } from '../src/core/xiaoheihe-operation-controller.mjs';
// 端口安全：本文件的请求全部由测试自己发出（wiring/hook 用 OS 临时端口），改用原生 http，
// 避免落到 undici fetch 的 blocked-port 列表导致 `fetch failed (bad port)` 假红。
import { postJson } from './test-port-safe.mjs';

const BG = 'patrol:background';
const USER = 'private:1234567890';
const GROUP = 'group:456';
const FULL = (short) => `mcp__xiaoheihe__${short}`;
const TOKEN = 'fixture-console-token';
const T0 = Date.UTC(2026, 9, 24, 2, 0, 0);

function makeController() {
  const controller = createXhhOperationController({ clock: () => Date.now() });
  const calls = [];
  const wrap = (name) => {
    const original = controller[name].bind(controller);
    controller[name] = async (...args) => {
      calls.push(name);
      return original(...args);
    };
  };
  for (const name of ['reserveRead', 'reserveWrite', 'commitTicket', 'abortTicket', 'finish']) wrap(name);
  return { controller, calls };
}

function makeApi(overrides = {}) {
  const { controller, calls } = makeController();
  const api = createXhhAuthorizeApi({
    controller,
    backgroundSessionKeys: [BG],
    userExemptAgents: [USER],
    agentKeyClassifier: (key) => (key === USER ? 'user' : key === GROUP ? 'group' : key === BG ? 'background' : 'unknown'),
    readOnly: overrides.readOnly,
  });
  return { api, controller, calls };
}

test('静态：小黑盒写工具清单固定为 5 个，贴吧无写工具（名单不含 tieba 名字）', () => {
  assert.deepEqual([...XHH_AUTHORIZE_WRITE_TOOLS].sort(), [
    'post_comment', 'publish_article', 'publish_content', 'publish_video', 'reply_comment',
  ].sort());
  assert.ok(XHH_AUTHORIZE_READ_TOOLS.includes('get_home_content'));
  assert.ok(XHH_AUTHORIZE_READ_TOOLS.includes('get_post_detail'));
  for (const name of XHH_AUTHORIZE_WRITE_TOOLS) {
    assert.ok(!/tieba/i.test(name), `贴吧不应出现写工具：${name}`);
  }
});

test('readOnly=true：owner/background 写 deny read-only-mode、group 兜底 unknown-agent deny；零 controller 调用', async () => {
  const { api, calls } = makeApi({ readOnly: true });
  for (const agentKey of [USER, GROUP, BG]) {
    for (const short of XHH_AUTHORIZE_WRITE_TOOLS) {
      const result = await api.authorize({
        agentKey,
        tool: FULL(short),
        args: short === 'post_comment' ? { operationId: 'op-1' } : {},
        now: Date.now(),
      });
      assert.equal(result.decision, 'deny', `${agentKey}/${short} 必须 deny`);
      if (agentKey === GROUP) {
        // group 无法被 api classifier 归为 user/background → unknown-agent 兜底拒绝；
        // 关键仍是不放行且不触达 controller。
        assert.equal(result.reason, 'unknown-agent', `${agentKey}/${short}`);
      } else {
        assert.equal(result.reason, 'read-only-mode', `${agentKey}/${short}`);
      }
    }
  }
  assert.deepEqual(calls, [], 'readOnly 拒绝写不得触达 controller（不 reserve/commit/finish）');
});

test('readOnly=true：读/搜索仍 allow（读取与额度不受只读门禁影响）', async () => {
  const { api, calls } = makeApi({ readOnly: true });
  for (const short of XHH_AUTHORIZE_READ_TOOLS) {
    const result = await api.authorize({ agentKey: BG, tool: FULL(short), args: {}, now: Date.now() });
    assert.equal(result.ok, true, `${short} 必须 allow`);
    assert.equal(result.decision, 'allow');
  }
  const search = await api.authorize({ agentKey: BG, tool: FULL('search_content'), args: {}, now: Date.now() });
  assert.equal(search.ok, true);
  assert.ok(calls.includes('reserveRead'), '读必须仍走 reserveRead（额度逻辑不变）');
});

test('readOnly 缺省/false：写工具保持现有行为（allow + reserveWrite）', async () => {
  const { api, calls } = makeApi({});
  const result = await api.authorize({
    agentKey: BG,
    tool: FULL('post_comment'),
    args: { operationId: 'op-2' },
    now: Date.now(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, 'allow');
  assert.ok(calls.includes('reserveWrite'), '默认模式写仍必须走 reserveWrite');
});

test('route：readOnly 写请求返回 200 deny(read-only-mode)；读请求仍 allow', async () => {
  const { api } = makeApi({ readOnly: true });
  const routes = createXhhAuthorizeRoutes({ authorizeApi: api, consoleToken: TOKEN, backgroundSessionKeys: [BG] });
  const write = await routes.handleAuthorize({
    headers: { 'x-console-token': TOKEN },
    body: { tool: FULL('publish_content'), agentKey: BG, args: {}, now: Date.now() },
  });
  assert.equal(write.status, 200);
  assert.equal(write.body.decision, 'deny');
  assert.equal(write.body.reason, 'read-only-mode');

  const read = await routes.handleAuthorize({
    headers: { 'x-console-token': TOKEN },
    body: { tool: FULL('get_home_content'), agentKey: BG, args: {}, now: Date.now() },
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, true);
  assert.equal(read.body.decision, 'allow');
});

test('wiring：readOnly 配置透传（写 deny / 读 allow）；未知字段仍 fail-closed 不启动', async () => {
  const { controller } = makeController();
  const wiring = createAuthorizeWiring({
    config: { backgroundPatrol: { enabled: true, readOnly: true } },
    controller,
    consoleToken: TOKEN,
    sessionIdentity: { backgroundSessionKeys: [BG], userExemptAgents: [USER] },
    clock: () => Date.now(),
  });
  const started = await wiring.start();
  try {
    assert.equal(started.ok, true);
    const base = started.url.replace(/\/+$/, '') + '/api/xiaoheihe';
    const writeRes = await postJson(`${base}/authorize`, {
      tool: FULL('publish_content'), agentKey: BG, args: {}, now: Date.now(),
    }, { 'x-console-token': TOKEN });
    const writeBody = await writeRes.json();
    assert.equal(writeRes.status, 200);
    assert.equal(writeBody.decision, 'deny');
    assert.equal(writeBody.reason, 'read-only-mode');

    const readRes = await postJson(`${base}/authorize`, {
      tool: FULL('get_home_content'), agentKey: BG, args: {}, now: Date.now(),
    }, { 'x-console-token': TOKEN });
    const readBody = await readRes.json();
    assert.equal(readBody.ok, true);
    assert.equal(readBody.decision, 'allow');
  } finally {
    await wiring.stop();
  }

  const bad = createAuthorizeWiring({
    config: { backgroundPatrol: { enabled: true, readOnly: 'yes' } },
    controller,
    consoleToken: TOKEN,
  });
  const badStarted = await bad.start();
  try {
    assert.equal(badStarted.ok, true, '非法 readOnly 走 disabled 语义');
    assert.equal(badStarted.enabled, false, 'readOnly 非 boolean 必须 fail-closed 不启动');
  } finally {
    await bad.stop();
  }
});


test('hook：readOnly 从 bridge 配置透传（写 deny / 读 allow），默认 false 不受影响', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-readonly-hook-'));
  const token = 'x'.repeat(32);
  const hook = createBackgroundPatrolBridgeHook({
    config: { backgroundPatrol: { enabled: true, authorizeToken: token, readOnly: true } },
    consoleToken: token,
    controllerStorePath: path.join(temp, 'controller.json'),
    ownerQQ: 1234567890,
    backgroundSessionId: 'sid-bg',
  });
  const started = await hook.start();
  try {
    assert.equal(started.ok, true);
    const base = started.url.replace(/\/+$/, '') + '/api/xiaoheihe';
    const headers = { 'x-console-token': token };
    const write = await postJson(`${base}/authorize`, {
      tool: FULL('publish_content'), agentKey: 'sid-bg', args: {}, now: Date.now(),
    }, headers);
    const writeBody = await write.json();
    assert.equal(writeBody.decision, 'deny');
    assert.equal(writeBody.reason, 'read-only-mode');
    const read = await postJson(`${base}/authorize`, {
      tool: FULL('get_home_content'), agentKey: 'sid-bg', args: {}, now: Date.now(),
    }, headers);
    const readBody = await read.json();
    assert.equal(readBody.decision, 'allow');
  } finally {
    await hook.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});


test('hook：非法 readOnly 类型 fail-closed（表格 6 种；不启动、不 reserve）', async () => {
  const cases = ['yes', 'true', 1, {}, null, []];
  for (const bad of cases) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-readonly-bad-'));
    const token = 'x'.repeat(32);
    const hook = createBackgroundPatrolBridgeHook({
      config: { backgroundPatrol: { enabled: true, authorizeToken: token, readOnly: bad } },
      consoleToken: token,
      controllerStorePath: path.join(temp, 'controller.json'),
      ownerQQ: 1234567890,
      backgroundSessionId: 'sid-bg',
    });
    try {
      const started = await hook.start();
      assert.equal(started.ok, false, `readOnly=${JSON.stringify(bad)} 必须拒绝启动`);
      assert.equal(started.error, 'invalid-read-only');
      assert.equal(started.url, undefined, '非法类型不得绑定端口');
    } finally {
      await hook.stop();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// task-49：后台巡逻来源的写工具只读门禁（可信工具边界，TDD 先红后绿）
//
// 背景：task-46 §3 F1 的真实后台回合里，patrol 会话**真的发出了一条小黑盒评论**
// （controller `buckets.comment.count=1`）。原因不是没有 readOnly 开关，而是：
//   · 全局 readOnly 默认 false，无法只针对「后台来源」；
//   · 后台与 owner/群 会话在额度口径上同属 background，来源无法从 agentClass 区分。
//
// 设计（本任务）：agentClass 保持「是否计额」语义不变；新增 provenance（来源）语义：
//   · provenance==='patrol'  → 写工具一律 deny `read-only-background`（不 reserve/commit、不计写额度）；
//   · provenance==='owner' / 'group' → 主动写仍放行（不得误禁）；
//   · provenance==='unknown' → 保守 fail-closed deny `unknown-source`（与 read-only-background 可区分）；
//   · 读/搜索不经过该门禁；全局 readOnly 仍优先于来源门禁（reason 保持 read-only-mode）。
// ─────────────────────────────────────────────────────────────────────────────

const PATROL_SID = 'sid-patrol';
const OWNER_SID = 'sid-owner';
const GROUP_SID = 'sid-group';
const OWNER_QQ = 1234567890;
const HOOK_TOKEN = 'task49-hook-token-0123456789abcdef';
const PROV_AUDIT_KEYS = [
  'type', 'at', 'tool', 'decision', 'reason', 'exemption', 'agentClass', 'outcome', 'controllerReason',
];

/** 带 provenanceClassifier 的 api：三个已知来源都按 background 计额，来源另由 provenance 表达。 */
function makeProvenanceApi(overrides = {}) {
  const { controller, calls } = makeController();
  const auditEvents = [];
  const api = createXhhAuthorizeApi({
    controller,
    backgroundSessionKeys: [],
    agentKeyClassifier: (key) => ([PATROL_SID, OWNER_SID, GROUP_SID].includes(key) ? 'background' : 'unknown'),
    provenanceClassifier: (key) => (key === PATROL_SID
      ? 'patrol'
      : key === OWNER_SID ? 'owner' : key === GROUP_SID ? 'group' : 'unknown'),
    audit: (event) => auditEvents.push(event),
    ...overrides,
  });
  return { api, calls, auditEvents };
}

test('task-49 api：patrol 来源写一律 deny read-only-background、零 controller 调用、审计可观测', async () => {
  const { api, calls, auditEvents } = makeProvenanceApi();
  for (const short of XHH_AUTHORIZE_WRITE_TOOLS) {
    const result = await api.authorize({
      agentKey: PATROL_SID,
      tool: FULL(short),
      args: { operationId: `prov-p-${short}` },
      now: Date.now(),
    });
    assert.equal(result.decision, 'deny', short);
    assert.equal(result.reason, 'read-only-background', short);
    assert.equal(result.agentClass, 'background', short);
    assert.equal(result.ticket, undefined, `${short} 不得签发可 commit 的写票据`);
  }
  assert.deepEqual(calls, [], '后台来源拒绝写不得触达 controller（不 reserve/commit/finish）');
  assert.equal(auditEvents.length, XHH_AUTHORIZE_WRITE_TOOLS.length);
  for (const event of auditEvents) {
    assert.equal(event.type, 'authorize');
    assert.equal(event.decision, 'deny');
    assert.equal(event.reason, 'read-only-background');
    assert.deepEqual(
      Object.keys(event).filter((key) => !PROV_AUDIT_KEYS.includes(key)),
      [],
      '拒绝必须落审计，且审计固定字段集合不得扩张',
    );
  }
});

test('task-49 api：patrol 来源读/搜索仍放行（只读门禁不碰读取与额度）', async () => {
  const { api, calls } = makeProvenanceApi();
  for (const short of [...XHH_AUTHORIZE_READ_TOOLS, 'search_content']) {
    const result = await api.authorize({ agentKey: PATROL_SID, tool: FULL(short), args: {}, now: Date.now() });
    assert.equal(result.decision, 'allow', `${short} 必须放行`);
    assert.equal(result.ok, true, short);
  }
  assert.ok(calls.includes('reserveRead'), '读仍必须走 reserveRead（额度逻辑不变）');
});

test('task-49 api：owner / group 主动写仍放行（不得误禁管理员与群友）', async () => {
  for (const agentKey of [OWNER_SID, GROUP_SID]) {
    const { api, calls } = makeProvenanceApi();
    const result = await api.authorize({
      agentKey,
      tool: FULL('publish_content'),
      args: { operationId: `prov-${agentKey}` },
      now: Date.now(),
    });
    assert.equal(result.decision, 'allow', agentKey);
    assert.equal(result.exemption, 'quota', agentKey);
    assert.ok(calls.includes('reserveWrite'), `${agentKey} 必须正常预占写额度`);
  }
});

test('task-49 api：全局 readOnly 优先于来源门禁（reason 仍为 read-only-mode）', async () => {
  const { api, calls } = makeProvenanceApi({ readOnly: true });
  const result = await api.authorize({
    agentKey: PATROL_SID,
    tool: FULL('post_comment'),
    args: { operationId: 'prov-ro' },
    now: Date.now(),
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.reason, 'read-only-mode', '既有 readOnly 语义不得被来源门禁改写');
  assert.deepEqual(calls, []);
});

test('task-49 api：来源不可判定（unknown）写 fail-closed deny unknown-source', async () => {
  const { api, calls } = makeProvenanceApi({
    agentKeyClassifier: () => 'background',
    provenanceClassifier: () => 'unknown',
  });
  const result = await api.authorize({
    agentKey: 'sid-mystery',
    tool: FULL('post_comment'),
    args: { operationId: 'prov-unknown' },
    now: Date.now(),
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.reason, 'unknown-source', '来源未知必须与后台只读拒绝可区分');
  assert.deepEqual(calls, []);
});

test('task-49 api：未注入 provenanceClassifier 时保持旧行为（legacy 兼容）', async () => {
  const { api, calls } = makeProvenanceApi({
    agentKeyClassifier: undefined,
    provenanceClassifier: undefined,
    backgroundSessionKeys: [PATROL_SID],
  });
  const result = await api.authorize({
    agentKey: PATROL_SID,
    tool: FULL('post_comment'),
    args: { operationId: 'prov-legacy' },
    now: Date.now(),
  });
  assert.equal(result.decision, 'allow');
  assert.ok(calls.includes('reserveWrite'));
});

test('task-49 wiring：provenanceClassifier 透传到 api（patrol 写 deny 零 controller，owner 写 reserveWrite）', async () => {
  const { controller, calls } = makeController();
  const wiring = createAuthorizeWiring({
    config: { backgroundPatrol: { enabled: true } },
    controller,
    consoleToken: TOKEN,
    agentKeyClassifier: (key) => ([PATROL_SID, OWNER_SID].includes(key) ? 'background' : 'unknown'),
    provenanceClassifier: (key) => (key === PATROL_SID ? 'patrol' : key === OWNER_SID ? 'owner' : 'unknown'),
  });
  const started = await wiring.start();
  try {
    assert.equal(started.ok, true, JSON.stringify(started));
    const base = started.url.replace(/\/+$/, '') + '/api/xiaoheihe';
    const headers = { 'x-console-token': TOKEN };

    const denied = await postJson(`${base}/authorize`, {
      tool: FULL('post_comment'), agentKey: PATROL_SID, args: { operationId: 'wire-p' },
    }, headers);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.decision, 'deny');
    assert.equal(deniedBody.reason, 'read-only-background');
    assert.equal(deniedBody.ticket, undefined);
    assert.deepEqual(calls.filter((name) => name.startsWith('reserve')), []);

    const ownerWrite = await postJson(`${base}/authorize`, {
      tool: FULL('post_comment'), agentKey: OWNER_SID, args: { operationId: 'wire-o' },
    }, headers);
    const ownerBody = await ownerWrite.json();
    assert.equal(ownerBody.decision, 'allow');
    assert.ok(calls.includes('reserveWrite'));
  } finally {
    await wiring.stop();
  }
});

/** mapper 模式的 hook：patrol/owner/group 三个真实会话 id 全部来自可信 sessions 映射。 */
function makeTask49MapperHook(dir, overrides = {}) {
  return createBackgroundPatrolBridgeHook({
    config: { backgroundPatrol: { enabled: true } },
    consoleToken: HOOK_TOKEN,
    controllerStorePath: path.join(dir, 'controller.json'),
    ownerQQ: OWNER_QQ,
    sessions: {
      'patrol:background': PATROL_SID,
      [`private:${OWNER_QQ}`]: OWNER_SID,
      'group:456': GROUP_SID,
    },
    backgroundSessionId: PATROL_SID,
    port: 0,
    logger: { warn() {}, error() {} },
    ...overrides,
  });
}

function task49Ledger() {
  return {
    enqueue: async () => ({ ok: true, id: 'seed', duplicate: true }),
    isDelivered: async () => ({ ok: true, delivered: true }),
  };
}

test('task-49 hook(mapper)：patrol 会话写被拒且无票据；owner/group 写放行；patrol 读放行；审计可观测', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task49-gate-hook-'));
  const auditEvents = [];
  const hook = makeTask49MapperHook(dir, { audit: (event) => auditEvents.push(event) });
  try {
    const started = await hook.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.enabled, true);
    await hook.reconcile(task49Ledger());
    const headers = { 'x-console-token': HOOK_TOKEN };
    const authorize = (body) => postJson(`${started.url}/api/xiaoheihe/authorize`, body, headers);

    const patrolWrite = await authorize({
      agentKey: PATROL_SID, tool: FULL('post_comment'), args: { operationId: 'hook-p' },
    });
    const patrolBody = await patrolWrite.json();
    assert.equal(patrolWrite.status, 200);
    assert.equal(patrolBody.decision, 'deny');
    assert.equal(patrolBody.reason, 'read-only-background');
    assert.equal(patrolBody.ticket, undefined, '不得签发可 commit 的写票据（否则插件仍会 dispatch）');

    const patrolRead = await authorize({ agentKey: PATROL_SID, tool: FULL('get_home_content'), args: {} });
    assert.equal((await patrolRead.json()).decision, 'allow');

    for (const agentKey of [OWNER_SID, GROUP_SID]) {
      const allowed = await authorize({
        agentKey, tool: FULL('publish_content'), args: { operationId: `hook-${agentKey}` },
      });
      const body = await allowed.json();
      assert.equal(body.decision, 'allow', agentKey);
      assert.equal(body.ticket.state, 'reserved', agentKey);
      const aborted = await postJson(`${started.url}/api/xiaoheihe/abort`, { ticket: body.ticket, agentKey }, headers);
      assert.equal((await aborted.json()).ok, true, agentKey);
    }

    const deniedAudit = auditEvents.filter((event) => event.decision === 'deny' && event.reason === 'read-only-background');
    assert.equal(deniedAudit.length, 1, '拒绝必须落一条审计');
    assert.equal(deniedAudit[0].agentClass, 'background');
  } finally {
    await hook.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// task-58：不变量——「provenance 严格度 ≤ agentClass 严格度」
//
// 生产不变量：未知会话必须在 agentClass 层先被拒（classifyAgent → 'unknown' ⇒ deny unknown-agent），
// 因此正常链路上 provenance 门禁对未知 key 只会看到 'unknown'；而「写 + provenance unknown ⇒
// deny unknown-source」分支（src/core/xiaoheihe-authorize-api.mjs，注释「防御性保留」）是最后防线：
// 一旦将来有人放宽 classifyAgent（例如「agentKey 是合法字符串就给 background」），它才会第一次
// 真正生效。本测试把两层都钉住，防止该分支被当死代码删除（task-55 复审 P3-1 的补充要求）。
// 注：api 响应不暴露 provenance 值（不扩响应契约），故用「正常链路」与「模拟放宽 classifier」两个
// 场景分别锁定两层，并断言正常链路下 provenance 分类器根本不会被咨询（agentClass 先拒）。
// ─────────────────────────────────────────────────────────────────────────────

test('task-58 不变量：未知 agentKey 在 agentClass 层先被拒；放宽 classifier 后 unknown-source 是最后防线', async () => {
  const UNKNOWN_KEY = 'sid-any-unknown-key';

  // 第一层：未知 key（classifier → unknown，provenance → unknown）必须在 agentClass 层被拒，
  // 且不得触达 controller、不得咨询 provenance 分类器（证明严格度顺序：agentClass 先于 provenance）。
  let provenanceCalls = 0;
  const { api, calls } = makeProvenanceApi({
    agentKeyClassifier: () => 'unknown',
    provenanceClassifier: () => {
      provenanceCalls += 1;
      return 'unknown';
    },
  });
  const denied = await api.authorize({
    agentKey: UNKNOWN_KEY,
    tool: FULL('post_comment'),
    args: { operationId: 'inv-unknown-1' },
    now: Date.now(),
  });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.agentClass, 'unknown', '未知会话的 agentClass 必须是 unknown');
  assert.equal(denied.reason, 'unknown-agent', '生产不变量：未知会话必须在 agentClass 层先被拒');
  assert.equal(provenanceCalls, 0, 'agentClass 先拒时不得再咨询 provenance（严格度顺序）');
  assert.deepEqual(calls, [], '拒绝不得触达 controller');

  // 第二层：模拟「将来 classifyAgent 放宽」（同 key 被判 background）——provenance 仍为 unknown，
  // 必须由 unknown-source 兜底拒绝。这正是「不得删除该分支」的原因：它此刻是唯一闸门。
  const relaxed = makeProvenanceApi({
    agentKeyClassifier: () => 'background',
    provenanceClassifier: () => 'unknown',
  });
  const stillDenied = await relaxed.api.authorize({
    agentKey: UNKNOWN_KEY,
    tool: FULL('post_comment'),
    args: { operationId: 'inv-unknown-2' },
    now: Date.now(),
  });
  assert.equal(stillDenied.decision, 'deny');
  assert.equal(stillDenied.agentClass, 'background', '模拟放宽后 agentClass 已不再是闸门');
  assert.equal(stillDenied.reason, 'unknown-source', 'provenance 未知时必须 fail-closed（最后防线）');
  assert.deepEqual(relaxed.calls, []);
});
