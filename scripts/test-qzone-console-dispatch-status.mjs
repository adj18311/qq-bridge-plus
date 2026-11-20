import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openQzoneConsoleRuntime } from '../src/core/qzone-console-runtime.mjs';
import { createQzoneConsoleGateway } from '../src/core/qzone-console-gateway.mjs';
import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';

// Offline only: fake identity, fake clock, local sqlite under tmpdir.
//
// Binds defect #4: the console runtime deliberately passes no isDispatchAvailable,
// so the console /status endpoint must report dispatchAvailable=false — even when
// a same-process plugin handle is dispatch-ready. The console side has no
// production dispatch, and a truthful plugin-side flag must not leak into it.
const now = Date.parse('2026-11-10T04:00:00Z');
const STATUS = '/api/console/qqspace-column/status';

async function loggedInConsole(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-console-dispatch-'));
  const runtime = await openQzoneConsoleRuntime({ stateDir: dir, consoleToken: 'fixture-console-token',
    getIdentity: async () => '123', authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true,
    now: () => now, schedule: () => ({ unref() {} }), cancelSchedule: () => {}, ...extra });
  t.after(async () => { runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const setup = await runtime.handle({ method: 'POST', pathname: '/api/console/qqspace-column/auth/setup',
    headers: {}, body: { password: 'test-password-123' } });
  const cookie = setup.headers['set-cookie'].split(';')[0];
  const read = async () => runtime.handle({ method: 'GET', pathname: STATUS, headers: { cookie } });
  return { runtime, read, dir };
}

test('console /status 在未注入 isDispatchAvailable 时恒报 dispatchAvailable=false', async (t) => {
  const { read } = await loggedInConsole(t);
  const status = await read();
  assert.equal(status.status, 200);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.dispatchAvailable, false);
});

test('同进程 plugin 已达 dispatch-ready 也不改变 console 的 dispatchAvailable=false', async (t) => {
  const { read } = await loggedInConsole(t);
  const registered = new Map();
  const listeners = new Map();
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args); };
  const on = (name, fn) => { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return () => {}; };
  let handle;
  try {
    handle = await createQzonePluginHandle({ on, tools: { register(tool) {
      registered.set(tool.name, tool); return () => registered.delete(tool.name);
    } } }, { enabled: true }, { epoch: 'e1', defineTool: (tool) => tool, dispatch: async () => ({ ok: true }) });
    assert.equal(handle.status().state, 'enabled-dispatch-ready');
    // `ready` alone is not dispatch-ready: without a pre-step adapter (created in
    // `agent/created`) no `tool/call` is observed, so nothing can bind. The plugin
    // reports that honestly, which is exactly why this fixture has to create an
    // agent before claiming the plugin-side flag is true.
    assert.equal(handle.status().dispatchAvailable, false, '没有 agent 时不得报 dispatch-ready');
    emit('agent/created', { agent: { id: 'agent-1', session: { id: 's1' }, ctx: { on: () => () => {} } } });
    assert.equal(handle.status().agentAdapters, 1);
    assert.equal(handle.status().dispatchAvailable, true, '同进程绑定确实是 ready');
    const status = await read();
    assert.equal(status.body.dispatchAvailable, false, 'console 侧没有生产 dispatch，必须保持 false');
  } finally { await handle?.dispose(); }
});

test('向 openQzoneConsoleRuntime 额外注入 isDispatchAvailable 也不能把 console 报成 true', async (t) => {
  // The runtime destructures its inputs; there is no such input. Pinning it here
  // means a future wiring change must break this test on purpose.
  const { read } = await loggedInConsole(t, { isDispatchAvailable: () => true });
  assert.equal((await read()).body.dispatchAvailable, false);
});

test('console-runtime 刻意不传 isDispatchAvailable：结构性断言 + 词法金丝雀 + 说明注释', async () => {
  const source = await readFile(new URL('../src/core/qzone-console-runtime.mjs', import.meta.url), 'utf8');
  const gatewaySource = await readFile(new URL('../src/core/qzone-console-gateway.mjs', import.meta.url), 'utf8');

  // Load-bearing (independent review N3): structural assertions that survive
  // renaming, comments and formatting, unlike the old lexical regex which missed
  // `...spread` / default-parameter / assignment / optional-chaining forms and
  // false-fired on any comment that merely mentioned the option.

  // `enableAuditFaultRestore` is EXPLICITLY ACKNOWLEDGED here, which is exactly what this canary
  // exists to force. It is a construction-time opt-in for the management route
  // `/audit/fault/restore`; it is NOT a dispatch injection point, it cannot turn `dispatchAvailable`
  // on, and no request value can reach it. Adding it therefore required this edit rather than a
  // silent signature drift — if a future option is added, this assertion fires again on purpose.
  // A1 ACKNOWLEDGEMENT: `operationApprovals` is now part of this set ON PURPOSE.
  //
  // The console runtime accepts it as an OPTIONAL FACTORY (`({ store, clock }) => broker`), calls it
  // once after the store is open, and forwards the result to the gateway. Omitted ⇒ the factory is
  // never called and the gateway route stays absent, which is what every pre-existing caller gets.
  // It is NOT a dispatch injection point: it adds the operator-decision route only and cannot turn
  // `dispatchAvailable` on (the assertions below still pin that). The canary fired when that wiring
  // landed — as designed — and this line is the explicit acknowledgement, not a loosening.
  // t55 ACKNOWLEDGEMENT: `pluginStore` is part of this set ON PURPOSE.
  //
  // The console now projects the PLUGIN's database (`state/qzone-plugin-state.sqlite`), because that
  // is the only state that decides whether a QQ-space tool actually runs. `pluginStore` is a STORE
  // HANDLE (`{ read, update, close }`), not a callback and not a dispatch binding: it cannot answer
  // "is dispatch ready" for any question, and the assertions below still pin `dispatchAvailable`
  // at false. The canary fired when the wiring landed — as designed — and this is the explicit
  // acknowledgement the canary exists to force, not a loosening of it.
  const WANT = ['store', 'stateDir', 'selfId', 'consoleToken', 'authorizeConsole',
    'verifyCsrf', 'isAgentPaused', 'now', 'enableAuditFaultRestore', 'operationApprovals',
    'pluginStore'];
  // The gateway's own parameter set. It already carried `operationApprovals` BEFORE this wiring —
  // the gateway is what refuses an object without `listPending`/`decide` — and now the runtime
  // forwards that same option, so the two sets coincide: the gateway must declare exactly what the
  // runtime passes, no key more and no key less. Still a set comparison at the SAME cardinality,
  // never `includes`, so dropping a name from either side keeps this red.
  //
  // WHY NOT `[...WANT, 'operationApprovals']` ANY MORE (and why that is not a loosening): `WANT` now
  // contains the name, so appending it again would duplicate it and pin the cardinality at 11 while
  // the gateway declares 10 — the equality assert would then fail on a list that is semantically
  // correct. Deriving from `WANT` keeps one source of truth; it does NOT weaken anything.
  // The gateway declares `pluginStore` and the runtime forwards it, so the two sets still coincide.
  // `GATEWAY_WANT` is derived from `WANT` (one source of truth) and this is the one place the two
  // differ today: the runtime opens the plugin handle itself, so the gateway is the side that names
  // it in a destructured parameter. Keeping the derivation means a name added to one side alone still
  // turns this red.
  const GATEWAY_WANT = [...WANT];
  // Strip both `key: value` and `key = default` forms down to the bare key.
  const bareKeys = (body) => body
    .split(',').map((part) => part.trim().split(/[:=]/)[0].trim()).filter(Boolean);

  // (a) The gateway must not declare the option in its destructured parameters.
  //
  // Round-4 review F-B: this used to assert the ordered array, so a semantically
  // equivalent reordering of the same eight names false-fired with a message
  // that claimed a parameter had been *added*. Compare as a sorted set and pin
  // the cardinality separately; parameter ORDER is not security-relevant and is
  // deliberately not pinned here.
  const gatewaySignature = gatewaySource.match(/export function createQzoneConsoleGateway\(\{([\s\S]*?)\}\s*=\s*\{\}\s*\)/);
  assert.ok(gatewaySignature, 'gateway 签名必须可解析，否则本断言失效');
  const gatewayParams = bareKeys(gatewaySignature[1]);
  assert.equal(gatewayParams.length, GATEWAY_WANT.length,
    'gateway 形参个数被改动，必须显式复核是否新增了 dispatch 注入点');
  assert.deepEqual([...gatewayParams].sort(), [...GATEWAY_WANT].sort(),
    'gateway 形参成员集合被改动，必须显式复核是否新增了 dispatch 注入点（本断言不钉顺序）');

  // (b) The console runtime must not pass the option into the gateway call, and
  // must have exactly one call site.
  //
  // Round-3 review N5: `source.match` only inspected the FIRST call site, so a
  // second call elsewhere was never looked at.
  // Round-4 review F-A: making the object-literal regex `matchAll` was still a
  // lexical gate — two equivalent spellings kept passing it:
  //   `createQzoneConsoleGateway ({…})`   (space before the paren)
  //   `const o = {…}; createQzoneConsoleGateway(o)`   (identifier argument)
  // Both still had exactly one object-literal match. The load-bearing check is
  // therefore a reverse whitelist on the bare identifier: it must appear exactly
  // once after comments are stripped, no matter how the call is spelled. The key
  // set is then validated by resolving either an inline object literal or a
  // single local identifier bound to one.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Count CALLS, not bare mentions: the import statement mentions the identifier
  // but is not a call site. `\s*\(` (not `\(\{`) is what closes F-A — it matches
  // a space before the paren and an identifier argument alike.
  const callSites = [...stripped.matchAll(/createQzoneConsoleGateway\s*\(/g)];
  assert.equal(callSites.length, 1,
    'console-runtime 只允许一处 createQzoneConsoleGateway 调用点；新增调用点必须先显式复核 dispatch 注入');
  const tail = stripped.slice(callSites[0].index + callSites[0][0].length);

  let argBody = null;
  const inlineObject = tail.match(/^\s*\{([\s\S]*?)\}\s*\)/);
  if (inlineObject) {
    argBody = inlineObject[1];
  } else {
    // Identifier argument: resolve it to its local object-literal definition so a
    // shadow object cannot smuggle a computed dispatch key past the check.
    const ident = tail.match(/^\s*([A-Za-z_$][\w$]*)\s*\)/);
    assert.ok(ident, 'console-runtime 的 gateway 实参必须是对象字面量或单一标识符；其它形态必须显式复核');
    const def = stripped.match(new RegExp(`(?:const|let|var)\\s+${ident[1]}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    assert.ok(def, `console-runtime 以标识符 ${ident[1]} 传参时，必须能在同文件内解析到它的对象字面量定义`);
    argBody = def[1];
  }

  const runtimeKeys = bareKeys(argBody);
  assert.deepEqual([...runtimeKeys].sort(), [...WANT].sort(),
    'console-runtime 传给 gateway 的键集合被改动，必须显式复核');
  assert.equal(runtimeKeys.some((key) => key.includes('isDispatchAvailable') || key.startsWith('...') || key.startsWith('[')), false,
    'console-runtime 不得把 isDispatchAvailable（或 spread / 计算属性键）接进 gateway');

  // Cheap canary on top: the bare token must not appear outside comments. This is
  // deliberately comment-stripped so that a comment merely naming the option no
  // longer false-fires.
  assert.equal(/isDispatchAvailable\s*[,:)}\]"']/.test(stripped), false,
    'console runtime 不得把 isDispatchAvailable 接进 gateway；要接必须先改这里的说明与测试');
  assert.ok(source.includes('Deliberately omit isDispatchAvailable'),
    '省略的理由必须留在源码注释里，否则下一个人会以为是漏接线');
});

test('gateway 没有 dispatch 绑定的注入点：任何注入值都不改变 dispatchAvailable=false', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-console-gateway-'));
  const state = openOfflineStore(join(dir, 'qzone-console-state.sqlite'), { botQq: '123', selfId: '123', enabled: false,
    readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false, pauseCycles: { access: null, write: null },
    reads: 0, writes: 0, probe: 'done', tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
    ledger: { day: '2026-11-10', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, commentTargets: [], likes: [], outcomes: {}, dispatchClaims: {}, notices: [],
    readAttempts: {}, readOutcomes: {}, browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, audit: [] });
  t.after(async () => { state.close(); await rm(dir, { recursive: true, force: true }); });
  const base = { store: state, stateDir: dir, selfId: '123', consoleToken: 'fixture-console-token',
    authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true, now: () => now };
  const setup = await createQzoneConsoleGateway({ ...base })({ method: 'POST',
    pathname: '/api/console/qqspace-column/auth/setup', headers: {}, body: { password: 'test-password-123' } });
  const cookie = setup.headers['set-cookie'].split(';')[0];
  // Behavioural pin, not a source grep: the gateway has no dispatch binding to
  // inject, so extra properties — including a truthy callback — are inert. A
  // future caller wired into the console must break this test on purpose rather
  // than accidentally reporting a ready console.
  for (const [label, value] of [
    ['默认省略', undefined],
    ['注入返回 true 的回调', () => true],
    ['注入 true 本身', true],
    ['注入返回 1 的回调', () => 1],
    ['注入 Promise 回调', () => Promise.resolve(true)],
    ['注入抛异常的回调', () => { throw new Error('boom'); }],
  ]) {
    const gateway = createQzoneConsoleGateway(value === undefined ? base : { ...base, isDispatchAvailable: value });
    const status = await gateway({ method: 'GET', pathname: STATUS, headers: { cookie } });
    assert.equal(status.status, 200, label);
    assert.equal(status.body.dispatchAvailable, false, label);
  }
});
