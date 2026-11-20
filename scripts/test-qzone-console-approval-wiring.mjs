import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openQzoneConsoleRuntime } from '../src/core/qzone-console-runtime.mjs';
import { createQzoneOperationApprovalBroker } from '../src/core/qzone-operation-approval-console.mjs';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A1 —— 审批来源真的接进 console 运行时（operationApprovals 工厂）
//
// 背景（已核）：改动前 `openQzoneConsoleRuntime` 构造 gateway 时**不传** operationApprovals，
// 所以真实 console 的 `/operation-approvals` 路由是关闭的 —— gateway 里那个 if 整块被跳过，
// 请求落到 admin router 的默认路由表，得到 404 not_found。也就是说「审批面板」在真实运行时里
// 从来不会出现。本文件钉的就是这条接线的**可观察行为**，而不是源码长得像不像。
//
// 本文件的全部验证都是离线的：真实临时目录 + 真实 SQLite 文件（node:sqlite），假身份、假时钟、
// 假 schedule，没有任何网络请求，也不碰项目 state/ 下的真实文件（一切都在 mkdtemp 的目录里，
// 用后删除）。
//
// 为什么用「假 broker」而不是只用真 broker：真 broker 能证明端到端可用，但**看不出**运行时到底
// 把哪一个对象交给了 gateway、调用了几次、operator 是谁。假 broker 是一个探针，能把运行时与
// gateway 之间的那一层握手变成可观测事实；真 broker 的用例放在最后，证明这条链真的能走通。
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** 本文件固定的「现在」。必须是可以安全转成日期、且能驱动 broker 过期判断的整数毫秒。 */
const NOW = Date.parse('2026-11-16T03:00:00Z');
const PREFIX = '/api/console/qqspace-column';
const APPROVALS = `${PREFIX}/operation-approvals`;
/** broker 要求的 inputDigest 形状：64 位小写十六进制。 */
const DIGEST = 'a'.repeat(64);

/**
 * 一个能打开 console 运行时的配置。`schedule` 被换成不真正挂 24 小时定时器的假实现，
 * 否则测试进程会被日切定时器吊住（既有 runtime 测试就是这么做的）。
 */
const config = (stateDir, extra = {}) => ({
  stateDir,
  consoleToken: 'fixture-console-token',
  getIdentity: async () => '123',
  authorizeConsole: () => true,
  verifyCsrf: () => true,
  isAgentPaused: () => true,
  now: () => NOW,
  schedule: () => ({ unref() {} }),
  cancelSchedule: () => {},
  ...extra,
});

/**
 * 建一个真实临时目录，并把「关运行时」和「删目录」绑在**同一个** after 钩子里。
 *
 * 为什么必须绑在一起：Windows 上 `rm` 删不掉**仍被打开**的 SQLite 文件，实测
 * `EBUSY: resource busy or locked, unlink '…\\qzone-console-state.sqlite'`。而 node:test 的
 * `t.after` 钩子是**按注册顺序**执行的（不是像 mocha 那样后进先出），所以「注册一个删目录、再
 * 注册一个关运行时」会让删目录先跑 —— 用例主体全绿，却因为收尾 EBUSY 被判红（第一版就是这么
 * 红的）。一个钩子里先关后删，顺序不再依赖框架语义。
 *
 * `track` 收的是「关闭函数」，注册顺序即执行顺序。
 */
async function sandbox(t, tag) {
  const dir = await mkdtemp(join(tmpdir(), `qzone-console-approval-${tag}-`));
  const closers = [];
  t.after(async () => {
    for (const close of closers) {
      try { close(); } catch { /* 收尾失败不得掩盖真实断言：失败的用例如实报红 */ }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, track(close) { closers.push(close); return close; } };
}

/**
 * 让运行时在删目录**之前**关闭，并返回一个幂等的 `close`。
 *
 * 运行时自己的 `close()` 不是幂等的：它最后会 `store.close()`，同一个 SQLite 句柄关两次会抛
 * `ERR_INVALID_STATE`。用例中途主动关闭（测「close 结清票据」）与收尾关闭因此共用同一个闸刀。
 */
function trackRuntime(box, runtime) {
  let closed = false;
  return box.track(() => {
    if (closed) return;
    closed = true;
    runtime.close();
  });
}

/**
 * 走真实的专栏密码流程拿到会话 cookie —— 审批路由要求**独立**的 QZone 专栏会话，
 * 直接伪造 cookie 会得到 401，那样测的就不是接线而是「401 还在」。
 */
async function login(runtime) {
  const setup = await runtime.handle({ method: 'POST', pathname: `${PREFIX}/auth/setup`,
    headers: {}, body: { password: 'test-password-123' } });
  assert.equal(setup.status, 200, '专栏密码设置必须成功，否则后面的会话都无从谈起');
  const cookie = setup.headers['set-cookie'].split(';')[0];
  assert.match(cookie, /^qqspace_column_session=/);
  return cookie;
}

/** GET/POST 一个 console 请求的最小形状。 */
const request = (method, pathname, headers = {}, body) => ({
  method, pathname, headers, ...(body === undefined ? {} : { body }),
});

/** 等一个 promise 结清；超时即判失败，而不是把测试挂死（挂起票据没被关闭时的真实表现）。 */
function withinMs(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}：${ms}ms 内没有结清，票据很可能没有被关闭`)), ms);
      timer.unref?.();
    }),
  ]);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 1. 不给工厂 ⇒ 行为与改动前逐字一致：审批路由不存在（404 not_found），不是 401、不是 500
//
// 这条是「默认行为不变」的守门员。如果哪天有人把 operationApprovals 默认成一个空 broker，
// 路由会变成 200 + 空列表 —— 那正是「看起来接上了」的假状态，本用例会红。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('不传 operationApprovals 时审批路由不存在（与改动前一致：404 not_found，而不是空列表 200）', async (t) => {
  const box = await sandbox(t, 'absent');
  const dir = box.dir;
  const runtime = await openQzoneConsoleRuntime(config(dir));
  trackRuntime(box, runtime);
  const cookie = await login(runtime);

  // 认证先于路由存在性：没会话时是 401，这一点改动前后都必须一样。
  const anonymous = await runtime.handle(request('GET', APPROVALS, {}));
  assert.equal(anonymous.status, 401, '没有专栏会话时必须是 401（这条不因接线而放宽）');

  // 带会话时，路由不存在才是「没有审批来源」的诚实答案。
  const listing = await runtime.handle(request('GET', APPROVALS, { cookie }));
  assert.equal(listing.status, 404, '★★★ 没传工厂就绝不能凭空造出审批路由');
  assert.equal(listing.body.ok, false);
  assert.equal(listing.body.error, 'not_found', '必须和 admin router 的未知路由完全同一个答案');

  const decision = await runtime.handle(request('POST', APPROVALS, { cookie },
    { authorizationId: 'auth-1', inputDigest: DIGEST, approved: true }));
  assert.equal(decision.status, 404, '★ 决策路由同样不存在：不能只开一半');
  assert.equal(decision.body.error, 'not_found');

  // 对照组：同一份会话下，另一个不存在的路由也是 404 not_found。两者形状一致，
  // 说明审批路由是「真的不存在」，而不是被某个特判挡住（否则未来很容易把它当成权限问题排查）。
  const control = await runtime.handle(request('GET', `${PREFIX}/no-such-route`, { cookie }));
  assert.equal(control.status, 404);
  assert.deepEqual(listing.body, control.body, '审批路由缺席时的答案必须就是「没有这个路由」');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 2. 给了工厂 ⇒ gateway 真的拿到了那个 broker：listPending / decide 都被调用，operator 来自会话
//
// 假 broker 只做登记，不做判断。它能回答的问题正是静态检查回答不了的：
//   · 工厂被调用了几次（必须恰好一次，不是每次请求一次）；
//   · 工厂收到的依赖对象长什么样（store 已打开、clock 就是运行时那个 now）；
//   · gateway 转给 broker 的 body 与 operator 是什么（operator 必须来自服务端会话，不来自 body）。
// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⚠️ t55 起这条用例的**结论翻转**：`/operation-approvals` 路由已被删除（用户裁定不要人工审批）。
//
// 原断言是「传了工厂 ⇒ 路由 200 可用」。路由没了以后，同样的装配得到 404 —— 这不是回归，而是
// 删掉一条**只会在生产里 404** 的路由后的必然结果。所以本用例改钉新事实：工厂仍然被调用（契约
// 未变、仍校验形状），但它换来的 broker **不再有任何路由可挂**。
//
// 保留（而不是删除）这条用例的理由：它记录的是「谁来应答审批面板」这件事已经不存在了。删掉它
// 会让下一个人以为只是没测到。
test('t55：传了工厂仍然会调用它（形状校验保留），但审批路由已删除 ⇒ 404', async (t) => {
  const box = await sandbox(t, 'fake');
  const dir = box.dir;
  const calls = { factory: 0, listPending: 0, decide: [], close: 0 };
  let seenDeps = null;
  // 注意：这个假 broker **故意没有 close 方法** —— close 是可选契约，缺了它运行时也必须能关。
  const pendingRow = { authorizationId: 'auth-1', inputDigest: DIGEST, action: 'publish' };
  const fakeBroker = {
    listPending() { calls.listPending += 1; return [pendingRow]; },
    decide(input, context) { calls.decide.push({ input, context }); return calls.decide.length === 1; },
  };

  const runtime = await openQzoneConsoleRuntime(config(dir, {
    operationApprovals: (deps) => {
      calls.factory += 1;
      seenDeps = deps;
      // 工厂是在 store 打开之后被调用的，所以此刻它必须是**可读的真实句柄**。
      assert.equal(typeof deps.store?.read, 'function', '工厂必须拿到真实 store 句柄');
      assert.equal(deps.store.read().botQq, '123', '工厂被调用时 store 必须已经打开并带着身份');
      assert.equal(typeof deps.clock, 'function');
      assert.equal(deps.clock(), NOW, '工厂拿到的 clock 必须就是运行时使用的那个 now');
      return fakeBroker;
    },
  }));
  trackRuntime(box, runtime);
  const cookie = await login(runtime);

  assert.equal(calls.factory, 1, '★★★ 工厂必须恰好被调用一次（不是每次请求都造一个新 broker）');
  assert.deepEqual(Object.keys(seenDeps).sort(), ['clock', 'store'], '工厂依赖面就是 { store, clock }，不得悄悄加参数');

  // THE ROUTE IS GONE. Both methods now fall through to the admin router, which answers 404 for any
  // path it does not know — the same answer a typo would get, which is the point of deleting it.
  const listing = await runtime.handle(request('GET', APPROVALS, { cookie }));
  assert.equal(listing.status, 404, '★★★ t55：审批列表路由已删除，必须 404');
  assert.equal(listing.body.error, 'not_found');
  const decided = await runtime.handle(request('POST', APPROVALS, { cookie },
    { authorizationId: 'auth-1', inputDigest: DIGEST, approved: true }));
  assert.equal(decided.status, 404, '★★★ t55：审批决策路由同样不存在（不能只留一半）');

  // THE BROKER IS NEVER CONSULTED. That is the observable consequence of the route being gone: a
  // pending list that nobody can read and a decision nobody can submit.
  assert.equal(calls.listPending, 0, '路由没了，broker 的 listPending 就不可能被调用');
  assert.equal(calls.decide.length, 0, '同上：decide 不可能被调用');
  assert.equal(calls.factory, 1, '工厂仍然只被调用一次（运行时契约未变）');
  // 假 broker **没有 close 方法**：运行时的 close 走可选链，缺了它也照样能关（否则这条 t.after 会红）。
  assert.equal(existsSync(join(dir, 'qzone-console-state.sqlite')), true, '状态库确实落在临时目录里');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 3. 工厂抛错 ⇒ 打开失败，异常向上抛（绝不静默降级成「没有审批来源」的 console）
//
// 这是整条接线里最容易做错的一处：catch 一下、继续把 console 交出去，就会得到一个「配置里写了
// 审批来源、路由却 404」的假状态 —— 运维会以为是权限问题。所以这里不仅断言 reject，还断言
// 工厂拿到的 store 已被释放（否则每次失败都会泄漏一个打开的 SQLite 句柄）。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('工厂抛错时打开失败、异常向上抛，且工厂已拿到的 store 被释放（不静默降级）', async (t) => {
  const dir = (await sandbox(t, 'throws')).dir;
  let captured = null;
  let factoryCalls = 0;
  await assert.rejects(
    openQzoneConsoleRuntime(config(dir, {
      operationApprovals: (deps) => {
        factoryCalls += 1;
        captured = deps.store;             // 先抓住句柄，再失败：模拟「接线做了一半」的真实形态
        assert.equal(captured.read().botQq, '123');
        throw new Error('approval factory exploded');
      },
    })),
    /approval factory exploded/,
    '★★★ 工厂的异常必须原样向上抛，不能被吞成「没有审批路由」',
  );
  assert.equal(factoryCalls, 1, '失败路径上工厂也只调用一次');

  let released = false;
  let releaseCode = null;
  try { captured.read(); } catch (error) { released = true; releaseCode = error?.code ?? null; }
  assert.equal(released, true,
    `★★★ 构造失败后必须关闭 store（实测 node:sqlite 关闭后再读会抛 ${releaseCode}）；否则每次失败都泄漏一个句柄`);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 4. 工厂返回的东西 gateway 不收 ⇒ 同样打开失败，并且刚交回来的 broker 被关闭
//
// gateway 自己就会校验 listPending/decide（'invalid operation approvals'）。运行时**不预检**，
// 因为预检会变成第二份契约；它只负责让错误照原样抛出去，并在抛出前把已经造出来的 broker 收掉。
// 这条同时钉住「工厂返回 null / {} / Promise 都算失败」这个方向：宁可开不起来，也不要假接线。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('工厂返回非法对象时打开失败（异常向上抛），且已造出的 broker 被关闭', async (t) => {
  const dir = (await sandbox(t, 'invalid')).dir;
  let closes = 0;
  // 返回一个「能关、但 gateway 不收」的对象：既能触发 gateway 的校验，也能量到清理。
  await assert.rejects(
    openQzoneConsoleRuntime(config(dir, {
      operationApprovals: () => ({ close() { closes += 1; }, listPending: 'not-a-function' }),
    })),
    /invalid operation approvals/,
    '★★ gateway 的校验失败必须原样冒出来，不能被运行时吞掉',
  );
  assert.equal(closes, 1, '★★★ 构造失败也必须把工厂刚交回来的 broker 关掉（挂起票据不能泄漏）');

  // 同步工厂的返回值就是最终 broker：async 工厂返回的是 Promise（没有 listPending/decide），
  // 所以同样必须失败。这条把「工厂是同步的」写进契约，避免有人以为 async 也能用。
  await assert.rejects(
    openQzoneConsoleRuntime(config(dir, {
      operationApprovals: async () => ({ listPending() { return []; }, decide() { return true; } }),
    })),
    /invalid operation approvals/,
    '★ 返回 Promise 的工厂不等于接上了：同步契约，非法即失败',
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 5. 非函数一律 TypeError，且失败发生在**打开状态库之前**（失败关闭，不是静默忽略）
//
// 「传了个现成的 broker 进去」是最自然的误用。如果运行时默默忽略它，调用方会以为接上了，
// 面板却永远 404 —— 所以这里要求开不起来。同时断言目录里没有生成 sqlite 文件：参数校验必须
// 先做，别为了报一个类型错误先在磁盘上留下半个库。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('operationApprovals 传非函数时抛 TypeError，且不碰磁盘（不静默忽略现成 broker）', async (t) => {
  const dir = (await sandbox(t, 'nonfunction')).dir;
  // 'a broker' 这个形状（一个现成对象）是最容易被误传的，所以它在列表里。
  const broker = { listPending() { return []; }, decide() { return true; }, close() {} };
  for (const bad of [{}, broker, 'a broker', 1, true, null]) {
    await assert.rejects(
      openQzoneConsoleRuntime(config(dir, { operationApprovals: bad })),
      (error) => {
        assert.ok(error instanceof TypeError, `必须是 TypeError，实际是 ${error?.constructor?.name}`);
        assert.match(error.message, /invalid operationApprovals/);
        return true;
      },
      `★ operationApprovals=${JSON.stringify(bad)} 必须失败关闭`,
    );
  }
  assert.equal(existsSync(join(dir, 'qzone-console-state.sqlite')), false,
    '★ 参数被拒时不得先在磁盘上留下状态库（校验在任何 I/O 之前）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 6. 端到端：真 broker + 真实 SQLite，console 决定真的放行；close() 结清挂起票据
//
// 前面几条用的是探针，这一条用的是**真的** createQzoneOperationApprovalBroker：运行时把 store 和
// clock 交给工厂，工厂造出真 broker，面板看得到它、决定得到它、close 之后挂起的票据被释放成
// 「未批准」而不是泄漏一个永不结清的 Promise。
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('t55：真 broker 仍被造出来但无路由可达；close() 必须结清挂起票据（泄漏会让等待方永远等下去）', async (t) => {
  const box = await sandbox(t, 'real');
  const dir = box.dir;
  const decisions = [];
  let broker = null;
  const runtime = await openQzoneConsoleRuntime(config(dir, {
    operationApprovals: (deps) => {
      broker = createQzoneOperationApprovalBroker({
        clock: deps.clock,                      // 用运行时给的时钟，而不是自带的 Date.now
        recordDecision: (event) => { decisions.push(event); return true; },
      });
      return broker;
    },
  }));
  // 用例中途要主动关一次（测「close 结清票据」），收尾还要再关一次：运行时 close() 不是幂等的，
  // 所以两处都走同一把闸刀 `closeOnce`（同一个 after 钩子里先关后删）。
  const closeOnce = trackRuntime(box, runtime);
  const cookie = await login(runtime);
  assert.ok(broker, '工厂必须真的跑过');

  // 一个动作在等审批（相当于 authorizer 挂起的那个 turn）。
  const waiting = broker.approveOperation({ authorizationId: 'auth-1', inputDigest: DIGEST,
    action: 'publish', expiresAt: NOW + 30000 });

  // t55：审批路由已删除。真 broker 仍然被造出来（构造契约未变），但没有路由能读到它、也没有路由
  // 能替它做决定 —— 这正是「不要人工审批」的可观察形态。
  const listing = await runtime.handle(request('GET', APPROVALS, { cookie }));
  assert.equal(listing.status, 404, '★★ t55：面板路由已删除');
  const decision = await runtime.handle(request('POST', APPROVALS, { cookie },
    { authorizationId: 'auth-1', inputDigest: DIGEST, approved: true }));
  assert.equal(decision.status, 404, '★★ t55：决策路由已删除');
  assert.equal(decisions.length, 0, '没有任何路径能走到 broker 的 recordDecision');
  assert.equal(broker.listPending().length, 1, '那张票据仍然挂着（没有人能批准它）—— 由 close() 结清');

  // 关掉运行时：第一张票据（auth-1，谁也批准不了）必须被结清成 false，而不是留到 30 秒超时。
  const orphan = waiting;
  assert.equal(broker.listPending().length, 1, '前提：close 之前它确实还挂着');
  closeOnce();
  assert.equal(await withinMs(orphan, 1000, 'close 后结清'), false,
    '★★★ close() 必须把挂起的审批票据关掉（按 broker 契约解成“未批准”）');
  assert.deepEqual(broker.listPending(), [], 'close() 之后队列必须为空');
  assert.equal(broker.decide({ authorizationId: 'auth-2', inputDigest: DIGEST, approved: true }), false,
    '已经被 close 掉的票据不能再被决定');
  assert.equal(decisions.length, 0, 'close 结清的票据不算一次“决定”，不得伪造留痕（t55：路由没了，本来也不会有决定）');
  // 已经关过之后，broker 自己的 close 依然可以安全重复调用（空队列什么都不做）。
  broker.close();
  assert.deepEqual(broker.listPending(), []);
});
