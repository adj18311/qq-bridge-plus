#!/usr/bin/env node
// test-qzone-opportunity-startup.mjs —— QQ 空间自主机会的**启动集成**验证
//
// WHY THIS EXISTS (measured, not hypothetical):
// 第一次接线时 readQzoneOpportunityInterval 等五个函数被插在模块作用域，而它们引用了
// `cfg` / `dshReady` / `deliverPrompt` —— 全是 `main()` 的局部量。bridge 一启动就打：
//
//     [bridge] QQ 空间自主机会启动失败（不影响巡逻）：cfg is not defined
//
// `node --check` 只查语法，查不出作用域；单元测试直接测 adapter，也不执行这几个函数。
// 于是**整条接线代码没有被任何测试跑过**。这条用例补的就是那个真空：真的把 bridge.js
// 启动起来，断言机会循环能启动、间隔来自插件库、停止能收敛。
//
// 手法与 busy-watchdog-harness 一致（临时目录 + 假 DSH/QQ + VM 注入真实现），
// 直接复用它的 harness，所以不需要新的 VM 装配代码。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { busyHarness } from './busy-watchdog-harness.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import path from 'node:path';

/** 在 harness 的临时 state 目录里建插件库（与生产同名同形）。 */
function seedPluginDb(tempDir, overrides = {}) {
  const pluginPath = path.join(tempDir, 'state', 'qzone-plugin-state.sqlite');
  const now = Date.now();
  const handle = openOfflineStore(pluginPath, {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 },
    ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    intervalMinutes: 15, activeStart: 0, activeEnd: 1439, probe: 'done',
    reads: 0, writes: 0, lastPostAt: null, lastCommentAt: null,
    commentTargets: [], likes: [], readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(now), todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, audit: [], notices: [], writeAudit: [], offlineOpportunityOffers: {},
    ...overrides,
  });
  handle.close();
  return pluginPath;
}

const DatabaseSync = (await import('node:sqlite')).DatabaseSync;

function readPlugin2(pluginPath) {
  const db = new DatabaseSync(pluginPath, { readOnly: true });
  const v = JSON.parse(db.prepare('select value from state where id=1').get().value);
  db.close();
  return v;
}

test('QRUN-1 bridge 启动后机会循环真的起来了（不是 cfg is not defined）', async (t) => {
  const harness = await busyHarness({
    config: { backgroundPatrol: { enabled: true, platforms: { tieba: false, xiaoheihe: false },
      paused: false, auditDir: 'state/patrol-audit', groupExempt: true, requireMapperIdentity: false } },
  });
  t.after(() => harness.close());
  seedPluginDb(harness.temp);
  // 真的走一次启动链（main 末尾那一套）
  await harness.context?.__startBackgroundPatrolWiring?.() ?? await globalThis.__startBackgroundPatrolWiring?.();
  const opp = harness.QZONE_OPP;
  assert.ok(opp, 'harness 必须暴露 QZONE_OPP 接缝');
  // 间隔必须读自插件库
  assert.equal(opp.readInterval(), 15, 'intervalMinutes 必须从插件库读到 15');
});

test('QRUN-2 到点判定：offer 落库、投递发生、零额度消耗', async (t) => {
  const harness = await busyHarness({
    config: { backgroundPatrol: { enabled: true, platforms: { tieba: false, xiaoheihe: false },
      paused: false, auditDir: 'state/patrol-audit', groupExempt: true, requireMapperIdentity: false } },
  });
  t.after(() => harness.close());
  const pluginPath = seedPluginDb(harness.temp);

  const result = await harness.QZONE_OPP.tick();
  // 关键：不得抛 ReferenceError（cfg is not defined 的回归）
  assert.equal(result?.ok, true, 'tick 必须成功，不得是 ReferenceError');

  const v = readPlugin2(pluginPath);
  assert.equal(Object.keys(v.offlineOpportunityOffers ?? {}).length, 1, '必须产生一个 offer');
  assert.equal(v.todayBrowses, 0, '机会阶段不得消耗浏览额度');
  assert.deepEqual(v.ledger.used, { post: 0, comment: 0, like: 0 }, '机会阶段不得消耗每日额度');

  // 投递证据取 `calls.prompts`（DSH prompt 的真实入参），不是包一层的 deliverPrompt ——
  // 后者拦不住闭包内的调用（`runQzoneOpportunityTick` 调的是 main() 作用域里的
  // deliverPrompt，不是返回句柄上那个属性）。这是实测出来的，不是猜的。
  const prompts = harness.calls.prompts;
  assert.equal(prompts.length, 1, '必须投递一次');
  const p0 = prompts[0];
  // 提示文本在 content[0].text 里
  const text = String(p0.content?.[0]?.text ?? '');
  assert.match(text, /QQ 空间/, '提示内容必须说明是去空间看看');
  assert.doesNotMatch(text, /会话令牌/, '机会提示不得携带认证凭据');
  // requestId 必须存在且是 UUID —— 它就是 offer 的关联 id
  assert.match(String(p0.requestId ?? ''),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    '投递必须带一个 UUID requestId（offer 与它的关联依据）');
  // 该 requestId 必须命中 offer —— 这就是「可信 requestId / offer 关联」的落地证据
  assert.equal(Object.hasOwn(v.offlineOpportunityOffers, p0.requestId), true,
    '投递的 requestId 必须与写入的 offer id 相同');
});

test('QRUN-3 停止后定时器清空、不再注册', async (t) => {
  const harness = await busyHarness({
    config: { backgroundPatrol: { enabled: true, platforms: { tieba: false, xiaoheihe: false },
      paused: false, auditDir: 'state/patrol-audit', groupExempt: true, requireMapperIdentity: false } },
  });
  t.after(() => harness.close());
  seedPluginDb(harness.temp);
  const opp = harness.QZONE_OPP;
  opp.start();
  assert.ok(opp.timer() !== null, '启动后必须有定时器');
  opp.stop();
  assert.equal(opp.timer(), null, '停止后定时器必须清空');
  assert.equal(opp.stopped(), true, '停止标志必须置真');
});

test('QRUN-4 插件库不存在时不猜默认值（返回 null，不注册定时器）', async (t) => {
  const harness = await busyHarness({
    config: { backgroundPatrol: { enabled: true, platforms: { tieba: false, xiaoheihe: false },
      paused: false, auditDir: 'state/patrol-audit', groupExempt: true, requireMapperIdentity: false } },
  });
  t.after(() => harness.close());
  // **故意不建插件库**
  assert.equal(harness.QZONE_OPP.readInterval(), null, '库不存在时必须返回 null，不能编造默认值');
});

test('QRUN-5 结果日志三分支不张冠李戴：skipped / 已投递 / 失败 各自说自己的话', async (t) => {
  const harness = await busyHarness({
    config: { backgroundPatrol: { enabled: true, platforms: { tieba: false, xiaoheihe: false },
      paused: false, auditDir: 'state/patrol-audit', groupExempt: true, requireMapperIdentity: false } },
  });
  t.after(() => harness.close());
  const describe = harness.QZONE_OPP.describe;
  assert.equal(typeof describe, 'function', 'harness 必须暴露结果格式化器');

  // ① 宿主拒绝：必须说「跳过」并给出原因，绝不能出现「已投递」字样。
  const skipped = describe({ ok: true, skipped: true, reason: 'qq-busy' });
  assert.match(skipped, /^跳过 /, 'skipped 必须以「跳过」开头');
  assert.match(skipped, /qq-busy/, '必须写出真实原因，不能只写 ok:true');
  assert.doesNotMatch(skipped, /已投递|接受/, '跳过的机会不得被描述成投递');

  // ② DSH 明确接受：可以说「已投递」+「DSH 已接受」，但必须同时声明它不证明模型执行。
  const delivered = describe({ ok: true, opportunityId: '11111111-2222-4333-8444-555555555555' });
  assert.match(delivered, /已投递/, '投递成功要能看出来');
  assert.match(delivered, /DSH 已接受/, '只说投递不说接受程度不够');
  assert.match(delivered, /未证明/, '必须写明这不等于模型执行或访问了 QQ');
  assert.match(delivered, /11111111-2222-4333-8444-555555555555/, 'offer id 必须出现，便于与插件库对照');
  assert.doesNotMatch(delivered, /成功|完成/, '不得写成业务成功');

  // ③ 失败 / 结果未知：分别是「失败」与「结果未知」，都不许读成成功。
  const failed = describe({ ok: false, reason: 'delivery-rejected', detail: 'denied: no-session' });
  assert.match(failed, /^失败 /, 'ok:false 必须以「失败」开头');
  assert.match(failed, /delivery-rejected/, '必须保留失败原因');
  assert.match(failed, /denied: no-session/, '必须保留 detail');
  assert.doesNotMatch(failed, /已投递|成功/, '失败不得读成投递或成功');

  const unknown = describe({ ok: true, reason: 'unexpected-shape' });
  assert.match(unknown, /^结果未知 /, '既非 skip 也非 delivery 的返回必须标为「结果未知」');
  assert.doesNotMatch(unknown, /成功|已投递/, '未知结果不得当作成功');

  // ④ 不得泄露正文 / 令牌 / QQ 号 / 会话 id（这条是硬边界，codex 上轮点名的）。
  // 注意：offer id 本身是 UUID，里面必然有长数字串，所以先把它摘掉再查 —— 否则这条断言
  // 会把自己的正当内容判成泄露（第一版就是这么红的，实测）。
  const offerId = '11111111-2222-4333-8444-555555555555';
  for (const line of [skipped, delivered, failed, unknown]) {
    assert.doesNotMatch(line, /【会话令牌】|Bearer /, '结果日志不得包含凭据');
    const withoutOffer = line.split(offerId).join('');
    assert.doesNotMatch(withoutOffer, /\d{7,}/, '结果日志不得包含长数字标识（QQ 号之类）');
  }
  // 会话 id 形状（session-xxxx）同样不得出现。
  for (const line of [skipped, delivered, failed, unknown]) {
    assert.doesNotMatch(line, /session-[0-9a-f-]{8,}/i, '结果日志不得包含会话 id');
  }
});

test('QRUN-6 宿主繁忙时不得留下孤儿 offer（判定必须排在做投递可行性检查之后）', async (t) => {
  const harness = await busyHarness({
    config: { backgroundPatrol: { enabled: true, platforms: { tieba: false, xiaoheihe: false },
      paused: false, auditDir: 'state/patrol-audit', groupExempt: true, requireMapperIdentity: false } },
  });
  t.after(() => harness.close());
  const pluginPath = seedPluginDb(harness.temp);

  // 制造 qq-busy：投递队列非空。这与 deliverPrompt 用的是**同一个**判据函数。
  harness.promptQueues.set('dummy-busy', { queue: [], running: true });

  const result = await harness.QZONE_OPP.tick();

  // ① 必须报告跳过，且原因就是 qq-busy
  assert.equal(result?.ok, true, '繁忙不是错误，只是跳过');
  assert.equal(result?.skipped, true, '繁忙必须是 skipped');
  assert.equal(result?.reason, 'qq-busy', '原因必须是 qq-busy');

  // ② 关键断言：**一个 offer 都不能写**。
  // 判定（adaptQzoneOfflineOpportunity）是有持久化副作用的，它写下的 offer 会：
  //   · 永远不会被消费（prompt 根本没入队）；且
  //   · 把下一次机会再推后一整个 intervalMinutes。
  // 2026-11-19 的 17:54 / 21:36 两次 tick 就是这样各留下一个孤儿。
  const v = readPlugin2(pluginPath);
  assert.equal(Object.keys(v.offlineOpportunityOffers ?? {}).length, 0,
    '宿主繁忙时不得写入任何 offer（那是不可消费的孤儿，且会推迟下一次机会）');

  // ③ 也没有投递
  assert.equal(harness.calls.prompts.length, 0, '繁忙时不得投递');

  // ④ 额度一行没动（这条与 QRUN-2 呼应，防止「跳过」被实现成「扣了再说」）
  assert.equal(v.todayBrowses, 0);
  assert.deepEqual(v.ledger.used, { post: 0, comment: 0, like: 0 });

  // ⑤ 对照：清空繁忙状态后，同一进程的下一次 tick 必须恢复正常并写出 offer。
  // 这一步证明 ② 是「因为忙才不写」，而不是「写 offer 这件事被改坏了」。
  harness.promptQueues.delete('dummy-busy');
  const second = await harness.QZONE_OPP.tick();
  assert.equal(second?.ok, true);
  assert.equal(second?.skipped, undefined, '不再繁忙时不应跳过');
  const v2 = readPlugin2(pluginPath);
  assert.equal(Object.keys(v2.offlineOpportunityOffers ?? {}).length, 1, '不忙时必须恢复写 offer');
  assert.equal(harness.calls.prompts.length, 1, '不忙时必须投递一次');
});
