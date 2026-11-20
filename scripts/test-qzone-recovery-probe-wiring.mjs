#!/usr/bin/env node
// test-qzone-recovery-probe-wiring.mjs —— A2：24 小时恢复探测的宿主装配
//
// WHY THIS EXISTS:
//   · runQzoneHealthProbe 早已实现并有自己的单测，但【没有任何生产调用方】——
//     熔断后永远不会自动恢复。
//   · 它拒绝运行的前提之一（matchesBot）要求库内有 botQq/selfId，而全新插件库两个字段都缺，
//     所以哪怕接上线也会立刻 identity_mismatch。
// 这条用例覆盖这两处装配：① 身份字段的初始化/冲突；② 探测的资格门与一次性结算。
//
// 全部用临时库 + 假请求，不发真实 QQ。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQzoneHostAssembly } from '../plugins/qzone-safe/host-assembly.mjs';
import { runQzoneHealthProbe } from '../src/core/qzone-health-probe-runtime.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const BOT = 9876543210;
const ADMIN = 1234567890;
const TOKEN = 'fixture-token-1234567890';

const BASE_STATE = {
  enabled: true, readAllowed: true, writeAllowed: true,
  accessPaused: false, writePaused: false,
  tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
  limits: { post: 3, comment: 25, like: 30 },
  // ⚠️ claim/finish 会往这两个数组里推行（审计意图 + 通知），缺了它们
  // `appendOfflineAudit` 就抛错，整条探测返回 claim_failed。这不是可选字段。
  audit: [], notices: [],
};

function assemble(dir, initial) {
  return createQzoneHostAssembly({
    stateDir: dir, initialState: initial ?? { ...BASE_STATE },
    origin: 'http://127.0.0.1:3200', token: TOKEN, botQq: BOT,
  });
}

/**
 * 建临时目录，并把 **close → rm** 绑成**一个** after 回调。
 *
 * ⚠️ 不能把 rm 和 store.close 分别注册成两个 after：句柄还没关就删目录会 EPERM
 * （Windows 上 SQLite 文件仍被占用，实测报 `Error: EPERM, Permission denied`）。
 * 一个回调里按序做，顺序才是确定的。
 */
function withDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qzone-probe-'));
  const cleanups = [];
  t.after(() => {
    // 逆序：先关句柄，再删文件。
    for (const fn of [...cleanups].reverse()) { try { fn(); } catch {} }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return { dir, onCleanup: (fn) => cleanups.push(fn) };
}

test('PROBE-1 全新库：身份字段被初始化为装配配置的账号', (t) => {
  const { dir, onCleanup } = withDir(t);
  const asm = assemble(dir);
  onCleanup(() => asm.store.close());
  const binding = asm.describe().identityBinding;
  assert.equal(binding.ok, true);
  assert.equal(binding.action, 'initialized');
  const st = asm.store.read();
  assert.equal(String(st.botQq), String(BOT));
  assert.equal(String(st.selfId), String(BOT));
  // 规范化成 matchesBot 要的字符串
  assert.equal(typeof st.botQq, 'string');
});

test('PROBE-2 已一致：不动库，报 kept', (t) => {
  const { dir, onCleanup } = withDir(t);
  const asm = assemble(dir, { ...BASE_STATE, botQq: String(BOT), selfId: String(BOT) });
  onCleanup(() => asm.store.close());
  assert.equal(asm.describe().identityBinding.action, 'kept');
});

test('PROBE-3 身份冲突：报错且**完全不改库**（额度/暂停/审计都不动）', (t) => {
  const { dir, onCleanup } = withDir(t);
  const initial = {
    ...BASE_STATE, botQq: '111111', selfId: '111111', accessPaused: true, writePaused: true,
    ledger: { day: beijingDay(Date.now()), used: { post: 2, comment: 3, like: 4 }, reservations: {} },
    audit: [{ id: 'keep-me', record: { action: 'read_posts' } }],
  };
  const asm = assemble(dir, initial);
  onCleanup(() => asm.store.close());
  const binding = asm.describe().identityBinding;
  assert.equal(binding.ok, false);
  assert.equal(binding.action, 'conflict');
  assert.equal(binding.expected, String(BOT));
  const st = asm.store.read();
  // 一个字节都没改
  assert.equal(st.botQq, '111111');
  assert.equal(st.selfId, '111111');
  assert.equal(st.accessPaused, true);
  assert.deepEqual(st.ledger.used, { post: 2, comment: 3, like: 4 });
  assert.equal(st.audit.length, 1);
});

test('PROBE-4 半写身份（只有 botQq）：按冲突处理，不猜', (t) => {
  const { dir, onCleanup } = withDir(t);
  const asm = assemble(dir, { ...BASE_STATE, botQq: '111111' });
  onCleanup(() => asm.store.close());
  const binding = asm.describe().identityBinding;
  assert.equal(binding.action, 'conflict');
  assert.equal(asm.store.read().selfId, undefined);
});

test('PROBE-5 身份就绪后，探测能过 matchesBot 并在成功时清暂停', async (t) => {
  const { dir, onCleanup } = withDir(t);
  const now = Date.now();
  const asm = assemble(dir, {
    ...BASE_STATE,
    accessPaused: true, writePaused: true,
    pausedAt: now - 25 * 3600 * 1000, probe: 'waiting',
    ledger: { day: beijingDay(now), used: { post: 1, comment: 0, like: 0 }, reservations: {} },
  });
  onCleanup(() => asm.store.close());

  const result = await runQzoneHealthProbe({
    store: asm.store,
    botQq: String(BOT), adminQq: String(ADMIN),
    now: () => now,
    serviceReady: () => true,
    activeTime: () => true,
    readOwnSpace: async (request) => ({ status: 'ok',
      targetQq: String(request.targetQq), selfQq: String(BOT) }),
  });
  // ⚠️ 终态词汇是 recovered/failed/unknown（success 是内部的 outcome，不是这里的 status）。
  assert.equal(result.status, 'recovered', '身份就绪 + 条件满足时探测必须成功');
  const st = asm.store.read();
  assert.equal(st.accessPaused, false, '成功必须解除访问暂停');
  assert.equal(st.writePaused, false, '成功必须一并解除写入暂停');
  assert.equal(st.probe, 'done');
  // 当天配额不重置
  assert.deepEqual(st.ledger.used, { post: 1, comment: 0, like: 0 });
});

test('PROBE-6 探测读到的账号与配置不符 ⇒ 失败，不恢复', async (t) => {
  const { dir, onCleanup } = withDir(t);
  const now = Date.now();
  const asm = assemble(dir, { ...BASE_STATE, accessPaused: true, pausedAt: now - 25 * 3600 * 1000, probe: 'waiting' });
  onCleanup(() => asm.store.close());

  const result = await runQzoneHealthProbe({
    store: asm.store,
    botQq: String(BOT), adminQq: String(ADMIN),
    now: () => now,
    serviceReady: () => true, activeTime: () => true,
    // 返回了别人（selfQq 不符）—— 这是登录身份不一致
    readOwnSpace: async () => ({ status: 'ok', targetQq: String(ADMIN), selfQq: '999999' }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(asm.store.read().accessPaused, true, '身份不符不得恢复');
});

test('PROBE-7 同一个库第二次探测不再放行（一次性 claim）', async (t) => {
  const { dir, onCleanup } = withDir(t);
  const now = Date.now();
  const asm = assemble(dir, { ...BASE_STATE, accessPaused: true, pausedAt: now - 25 * 3600 * 1000, probe: 'waiting' });
  onCleanup(() => asm.store.close());
  const deps = {
    store: asm.store, botQq: String(BOT), adminQq: String(ADMIN), now: () => now,
    serviceReady: () => true, activeTime: () => true,
    readOwnSpace: async (request) => ({ status: 'ok', targetQq: String(request.targetQq), selfQq: String(BOT) }),
  };
  assert.equal((await runQzoneHealthProbe(deps)).status, 'recovered');
  const second = await runQzoneHealthProbe(deps);
  assert.notEqual(second.status, 'recovered', '同一状态不应再探测一次');
});