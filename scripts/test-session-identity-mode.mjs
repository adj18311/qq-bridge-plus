// scripts/test-session-identity-mode.mjs
// task-58：身份模式 fail-closed（非 mapper 显式告警/可配置拒绝）+ sessions 键名校验（TDD 先红后绿）。
//
// 背景（task-55 复审 P3-1）：`background-patrol-bridge-hook.mjs:58-64` 的 isSessionMap() 是形状嗅探，
// sessions 只要带 backgroundSessionKeys/userExemptAgents 属性就静默降级为 legacy；legacy 不产
// provenance ⇒ task-49 的「后台来源写一律拒绝」门禁整个消失且无任何日志。当前生产 state/sessions.json
// 6 个键全部 canonical（不可达），但「门禁静默消失且无日志」违反 fail-closed 自证要求，故加固：
//   · hook.start() 在 legacy 身份下必须显式 warn（identity-mode-legacy），并可用配置开关
//     backgroundPatrol.requireMapperIdentity=true 升级为直接 fail-closed（reason identity-mode-legacy）；
//   · state/sessions.json 的 sessions 键名白名单校验：非法键剔除 + warn + 可观测计数，不整份丢弃；
//   · status().identityMode 可观测（mapper/legacy）；
//   · legacy 模式下 provenance 缺失时 patrol 写行为显式断言（记录现状，防止将来误判为已修复）。
//
// 全部离线：临时目录 + 127.0.0.1 临时端口；不启动桥接、不读正式 config/state、不访问平台。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBackgroundPatrolBridgeHook, describeIdentityMode } from '../src/core/background-patrol-bridge-hook.mjs';
import { createSessionStore, SESSION_KEY_PATTERN } from '../src/core/session-store.mjs';
import { postJson } from './test-port-safe.mjs';

const TOKEN = 'task58-hook-token-0123456789abcdef';
const OWNER_QQ = 1234567890;
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-identity-mode-'));
  tempDirs.push(dir);
  return dir;
}

function makeHook(overrides = {}) {
  const warnings = [];
  return {
    warnings,
    hook: createBackgroundPatrolBridgeHook({
      config: { backgroundPatrol: { enabled: true } },
      consoleToken: TOKEN,
      ownerQQ: OWNER_QQ,
      // legacy 形状：含 backgroundSessionKeys 属性 ⇒ isSessionMap() 判 false。
      sessions: { backgroundSessionKeys: ['legacy-sid'] },
      logger: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
      ...overrides,
    }),
  };
}

function makeMapperHook(overrides = {}) {
  const warnings = [];
  return {
    warnings,
    hook: createBackgroundPatrolBridgeHook({
      config: { backgroundPatrol: { enabled: true } },
      consoleToken: TOKEN,
      ownerQQ: OWNER_QQ,
      // mapper 形状：QQ key → DSH sessionId。
      sessions: {
        'patrol:background': 'sid-bg',
        [`private:${OWNER_QQ}`]: 'sid-owner',
      },
      backgroundSessionId: 'sid-bg',
      logger: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
      ...overrides,
    }),
  };
}

async function authorize(url, body) {
  const response = await postJson(`${url}/api/xiaoheihe/authorize`, body, { 'x-console-token': TOKEN });
  return { status: response.status, body: await response.json() };
}

async function abort(url, ticket, agentKey) {
  const response = await postJson(`${url}/api/xiaoheihe/abort`, { ticket, agentKey }, { 'x-console-token': TOKEN });
  return { status: response.status, body: await response.json() };
}

function warnCodes(warnings) {
  return warnings
    .filter((args) => args.length > 1 && args[1] && typeof args[1] === 'object')
    .map((args) => args[1].code);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. sessions 键名校验（非法键剔除 + warn + 计数，不整份丢弃）
// ─────────────────────────────────────────────────────────────────────────────

test('session-store：非法会话键剔除、合法键保留、warn+计数可观测（task-58）', async () => {
  const dir = await makeDir();
  const file = path.join(dir, 'sessions.json');
  const initial = {
    sessions: {
      'group:1059972926': 'sess-group',
      'private:1234567890': 'sess-owner',
      'patrol:background': 'sess-patrol',
      'evil-key': 'sess-evil',
      'group:abc': 'sess-alpha',
      'private:12x': 'sess-x',
    },
    sessionPolicies: {},
  };
  await fs.writeFile(file, JSON.stringify(initial), 'utf8');

  const logs = [];
  const store = createSessionStore({ file, log: (message) => logs.push(message) });
  const state = store.load();

  assert.deepEqual(
    state.sessions,
    {
      'group:1059972926': 'sess-group',
      'private:1234567890': 'sess-owner',
      'patrol:background': 'sess-patrol',
    },
    '非法键必须剔除，合法键必须保留（不得整份丢弃）',
  );
  assert.deepEqual(state.sessionPolicies, {}, '无关字段不得受影响');
  assert.equal(store.writable, true, '键名剔除不是读损坏，不得降级为只读');
  assert.equal(logs.length, 1, '剔除必须 warn（可观测），且只打印一条汇总');
  assert.match(logs[0], /剔除 3 个非法会话键/);
  assert.match(logs[0], /已忽略/);
  assert.equal(store.diagnostics.removedSessionKeys.length, 3, '必须给出可观测计数');
  assert.equal(store.diagnostics.removedCount, 3);

  store.save(state);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.sessions).sort(), ['group:1059972926', 'patrol:background', 'private:1234567890']);
});

test('session-store：无污染键时不打印、计数为 0；白名单常量与生产会话形状一致（task-58）', async () => {
  const dir = await makeDir();
  const file = path.join(dir, 'sessions.json');
  await fs.writeFile(file, JSON.stringify({ sessions: { 'group:1': 's1', 'private:2': 's2', 'patrol:background': 's3' } }), 'utf8');
  const logs = [];
  const store = createSessionStore({ file, log: (message) => logs.push(message) });
  const state = store.load();
  assert.equal(Object.keys(state.sessions).length, 3);
  assert.deepEqual(logs, []);
  assert.deepEqual(store.diagnostics, { removedSessionKeys: [], removedCount: 0 });

  for (const key of ['group:1059972926', 'private:1234567890', 'group:863736632', 'patrol:background', 'private:3987026018', 'private:1420193228']) {
    assert.equal(SESSION_KEY_PATTERN.test(key), true, key);
  }
  for (const key of ['evil', 'group:', 'private:abc', 'patrol:other', 'group:1x', ' group:1']) {
    assert.equal(SESSION_KEY_PATTERN.test(key), false, key);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 身份模式：legacy 必须显式告警（不得静默），status().identityMode 可观测
// ─────────────────────────────────────────────────────────────────────────────

test('hook：legacy 身份模式启动必须显式 warn identity-mode-legacy，status().identityMode=legacy（task-58）', async () => {
  const dir = await makeDir();
  const { hook, warnings } = makeHook({ controllerStorePath: path.join(dir, 'controller.json') });
  const started = await hook.start();
  try {
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(hook.status().identityMode, 'legacy');
    assert.ok(
      warnCodes(warnings).includes('identity-mode-legacy'),
      `legacy 身份不得静默降级，必须 warn identity-mode-legacy；实际：${JSON.stringify(warnings)}`,
    );
  } finally {
    await hook.close();
  }
});

test('hook：mapper 身份模式无 identity-mode-legacy 告警，status().identityMode=mapper（task-58）', async () => {
  const dir = await makeDir();
  const { hook, warnings } = makeMapperHook({ controllerStorePath: path.join(dir, 'controller.json') });
  const started = await hook.start();
  try {
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(hook.status().identityMode, 'mapper');
    assert.equal(warnCodes(warnings).includes('identity-mode-legacy'), false);
  } finally {
    await hook.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 可配置升级：requireMapperIdentity=true 时 legacy 直接 fail-closed
// ─────────────────────────────────────────────────────────────────────────────

test('hook：requireMapperIdentity=true 时 legacy 身份 fail-closed（identity-mode-legacy），mapper 不受影响（task-58）', async () => {
  const dir = await makeDir();
  const strictConfig = { backgroundPatrol: { enabled: true, requireMapperIdentity: true } };

  const { hook: legacy } = makeHook({
    config: strictConfig,
    controllerStorePath: path.join(dir, 'legacy.json'),
  });
  try {
    assert.deepEqual(await legacy.start(), { ok: false, error: 'identity-mode-legacy' });
    assert.equal(legacy.status().started, false, 'fail-closed 不得留下半启动端点');
  } finally {
    await legacy.close();
  }

  const { hook: mapper } = makeMapperHook({
    config: strictConfig,
    controllerStorePath: path.join(dir, 'mapper.json'),
  });
  const started = await mapper.start();
  try {
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(mapper.status().identityMode, 'mapper');
  } finally {
    await mapper.close();
  }

  // 严格 boolean 校验：非布尔值不得静默当成 false（与 readOnly 同一 fail-closed 口径）。
  const { hook: invalid } = makeHook({
    config: { backgroundPatrol: { enabled: true, requireMapperIdentity: 'yes' } },
    controllerStorePath: path.join(dir, 'invalid.json'),
  });
  try {
    assert.deepEqual(await invalid.start(), { ok: false, error: 'invalid-require-mapper-identity' });
  } finally {
    await invalid.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. legacy 模式现状显式断言：provenance 缺失 ⇒ task-49 后台写门禁不生效（只靠告警/开关兜底）
// ─────────────────────────────────────────────────────────────────────────────

test('hook：legacy 模式 provenance 缺失时 patrol 写仍被放行（记录当前行为，防将来误判为已修复）', async () => {
  const dir = await makeDir();
  const auditEvents = [];
  const { hook } = makeHook({
    controllerStorePath: path.join(dir, 'controller.json'),
    audit: (event) => auditEvents.push(event),
  });
  const started = await hook.start();
  try {
    // 写门禁需要先完成一次对账（与 task-78/task-49 的既有契约一致）。
    const reconciled = await hook.reconcile({
      enqueue: async () => ({ ok: true, id: 'task58' }),
      isDelivered: async () => ({ ok: true, delivered: false }),
    });
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));

    // legacy 会话在旧口径下就是 background；task-49 明确保留 legacy 旧行为（不注入 provenance）。
    const response = await authorize(started.url, {
      agentKey: 'legacy-sid',
      tool: 'mcp__xiaoheihe__post_comment',
      args: { operationId: 'task58-legacy-write', content: 'legacy-behavior' },
    });
    assert.equal(response.body.decision, 'allow', 'legacy 模式现状：写门禁不生效（本用例锁定现状）');
    assert.equal(response.body.reason, undefined);
    assert.equal(response.body.ticket.state, 'reserved');
    // agentClass 不暴露在 HTTP 响应里（路由 allow 体固定字段），从审计行核对：legacy 会话仍是 background。
    const allowedAudit = auditEvents.filter((event) => event.decision === 'allow' && event.tool === 'post_comment');
    assert.equal(allowedAudit.length, 1, JSON.stringify(auditEvents));
    assert.equal(allowedAudit[0].agentClass, 'background');
    const aborted = await abort(started.url, response.body.ticket, 'legacy-sid');
    assert.equal(aborted.body.ok, true);
  } finally {
    await hook.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// task-62（P3-1）：requireMapperIdentity 严格失败后 identityMode 仍可观测。
// 旧行为：failClosed('identity-mode-legacy') 发生在 identityStatus 赋值之前 ⇒ status() 的
// identityMode 是 null；运维只看到「启动失败」却不知道是身份降级导致，仍属「静默」。
// ─────────────────────────────────────────────────────────────────────────────
test('task-62 P3-1：严格失败后 status().identityMode 仍为 legacy，且 lastError 同时可观测', async () => {
  const dir = await makeDir();
  const { hook, warnings } = makeHook({
    config: { backgroundPatrol: { enabled: true, requireMapperIdentity: true } },
    controllerStorePath: path.join(dir, 'controller.json'),
  });
  try {
    const started = await hook.start();
    assert.deepEqual(started, { ok: false, error: 'identity-mode-legacy' });
    const status = hook.status();
    assert.equal(status.started, false);
    assert.equal(status.lastError, 'identity-mode-legacy');
    assert.equal(status.identityMode, 'legacy', 'failClosed 前必须已记录身份结果，不能是 null');
    // 失败路径也要留下可检索的日志（logger.error 收到 code）。
    assert.ok(
      warnings.some((args) => args?.[1]?.code === 'identity-mode-legacy'),
      `缺少 identity-mode-legacy 失败日志：${JSON.stringify(warnings)}`,
    );
  } finally {
    await hook.close();
  }
});

test('task-62 P3-4：describeIdentityMode 纯函数覆盖 legacy/mapper/unknown 的级别与文案', () => {
  const legacy = describeIdentityMode('legacy');
  assert.equal(legacy.level, 'warn');
  assert.equal(legacy.degraded, true);
  assert.match(legacy.message, /后台写门禁已降级（legacy 身份模式）/);
  assert.match(legacy.message, /requireMapperIdentity=true/);

  const mapper = describeIdentityMode('mapper');
  assert.equal(mapper.level, 'info');
  assert.equal(mapper.degraded, false);
  assert.match(mapper.message, /后台巡逻身份模式：mapper/);

  const unknown = describeIdentityMode(undefined);
  assert.equal(unknown.level, 'warn');
  assert.equal(unknown.degraded, true);
  assert.match(unknown.message, /unknown/);
});

test('A-2：requireMapperIdentity=true 但注入了降级层时，legacy 身份不得 fail-closed（交给降级只读接管）', async () => {
  const dir = await makeDir();
  const { hook, warnings } = makeHook({
    config: { backgroundPatrol: { enabled: true, requireMapperIdentity: true } },
    degrade: { snapshot: () => ({ level: 'normal', blockWrite: false, blockAll: false }) },
    controllerStorePath: path.join(dir, 'legacy-with-degrade.json'),
  });
  try {
    const started = await hook.start();
    assert.equal(started.ok, true, `有降级层时 legacy 不得整体停摆：${JSON.stringify(started)}`);
    assert.equal(hook.status().identityMode, 'legacy', '身份模式仍必须如实报告 legacy');
    assert.equal(
      warnCodes(warnings).includes('identity-mode-legacy'),
      true,
      '必须保留 identity-mode-legacy 告警（可观测性不得因降级层而丢失）',
    );
  } finally {
    await hook.close();
  }
});
