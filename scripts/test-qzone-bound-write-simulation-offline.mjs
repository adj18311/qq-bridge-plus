import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneWriteBinding } from '../src/core/qzone-write-binding-offline.mjs';
import { simulateQzoneBoundWriteOffline } from '../src/core/qzone-bound-write-simulation-offline.mjs';

const now = Date.parse('2026-11-08T02:00:00Z');
const secret = 'Authorization: Bearer offline-only-secret';

function initialState(overrides = {}) {
  return {
    offlineTestFixture: true,
    reads: 0, writes: 0,
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    selfId: '123', tools: { publish: true, comment: true, reply: true, like: true },
    limits: { post: 5, comment: 5, like: 5 }, lastPostAt: null, lastCommentAt: null,
    commentTargets: [], likes: [], ledger: { day: '2026-11-08', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    outcomes: {}, dispatchClaims: {}, notices: [], audit: [], ...overrides,
  };
}

function binding(id = 'bound_op') {
  return createQzoneWriteBinding(id, 'comment', { tid: 'post_1', target_uin: 456, content: secret }, {
    time: now, source: 'qq', target: '456', result: 'unknown', reason: '',
  });
}

async function withStore(t, state = initialState()) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-bound-write-'));
  const file = join(dir, 'state.db');
  const store = openOfflineStore(file, state);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, file, dir };
}

test('从同一冻结请求产生脱敏意图与结算审计；敏感正文不落盘且重放不调用 fake', async (t) => {
  const { store, file } = await withStore(t);
  const bound = binding();
  const calls = [];
  const first = await simulateQzoneBoundWriteOffline(file, bound,
    async (request) => { calls.push(request); return { outcome: 'success', now }; });

  assert.deepEqual(first, { allowed: true, outcome: 'success', successEvidence: 'fake_simulation_only', replayed: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.content, secret);
  const state = store.read();
  assert.deepEqual(state.dispatchClaims, { bound_op: 'comment' });
  assert.equal(state.audit.length, 2);
  assert.deepEqual(state.audit[0].record, {
    time: now, source: 'qq', action: 'comment', target: '456', postId: 'post_1', commentId: null,
    content: '[REDACTED]', redacted: true, result: 'unknown', reason: '', quota: null,
  });
  assert.deepEqual(state.audit[1].record, { ...state.audit[0].record, result: 'success' });
  assert.equal(JSON.stringify(state).includes('offline-only-secret'), false);
  assert.equal((await readFile(file)).includes(Buffer.from('offline-only-secret')), false);

  const replay = await simulateQzoneBoundWriteOffline(file, bound,
    async () => { calls.push('unexpected'); return { outcome: 'success', now }; });
  assert.deepEqual(replay, { allowed: false, reason: 'invalid_capability', replayed: false });
  assert.equal(calls.length, 1);
});

test('授权或关停拒绝在 fake 调用前发生，额度和意图保持原样', async (t) => {
  for (const [name, mutate, reason] of [
    ['unauthorized', { writeAllowed: false }, 'permission'],
    ['disabled', { enabled: false }, 'disabled'],
    ['paused', { writePaused: true }, 'write_paused'],
  ]) {
    const { store, file } = await withStore(t, initialState(mutate));
    const bound = binding(`deny_${name}`);
    let calls = 0;
    const result = await simulateQzoneBoundWriteOffline(file, bound, async () => {
      calls++;
      return { outcome: 'success', now };
    });
    assert.deepEqual(result, { allowed: false, reason, replayed: false });
    assert.equal(calls, 0);
    assert.deepEqual(store.read().ledger.used, { post: 0, comment: 0, like: 0 });
    assert.deepEqual(store.read().audit, []);
    assert.deepEqual(store.read().dispatchClaims, {});
  }
});

test('非会话和巡逻来源不得预留额度或写入派发意图', async (t) => {
  const { store, file } = await withStore(t);
  const bound = createQzoneWriteBinding('bad_source', 'like', { tid: 'p', target_uin: 456 },
    { time: now, source: 'health_probe', target: '456', result: 'unknown', reason: '' });
  let calls = 0;
  const result = await simulateQzoneBoundWriteOffline(file, bound, async () => { calls++; return { outcome: 'success', now }; });
  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  assert.equal(store.read().ledger.used.like, 0);
  assert.deepEqual(store.read().audit, []);
});

test('非空意图原因无效时不得占用额度或写审计', async (t) => {
  const { store, file } = await withStore(t);
  const bound = createQzoneWriteBinding('bad_reason', 'like', { tid: 'p', target_uin: 456 },
    { time: now, source: 'qq', target: '456', result: 'unknown', reason: 'network' });
  let calls = 0;
  const result = await simulateQzoneBoundWriteOffline(file, bound, async () => { calls++; return { outcome: 'success', now }; });
  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  assert.equal(store.read().ledger.used.like, 0);
  assert.deepEqual(store.read().audit, []);
});

test('缺少离线测试标识的状态库不能被模拟器写入', async (t) => {
  const { store, file } = await withStore(t, initialState({ offlineTestFixture: false }));
  let calls = 0;
  const result = await simulateQzoneBoundWriteOffline(file, binding('unmarked_state'), async () => { calls++; return { outcome: 'success', now }; });
  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
  assert.deepEqual(store.read().ledger.used, { post: 0, comment: 0, like: 0 });
  assert.deepEqual(store.read().audit, []);
});

test('SQLite 事务输入异常时回滚并且绝不调用 fake', async (t) => {
  const { store, file } = await withStore(t, initialState({ audit: 'corrupt' }));
  let calls = 0;
  await assert.rejects(simulateQzoneBoundWriteOffline(file, binding('rollback_op'), async () => {
    calls++;
    return { outcome: 'success', now };
  }), /invalid audit state/);
  assert.equal(calls, 0);
  assert.deepEqual(store.read().ledger.used, { post: 0, comment: 0, like: 0 });
  assert.equal(store.read().audit, 'corrupt');
  assert.deepEqual(store.read().dispatchClaims, {});
});

test('unknown 终态持久化并禁止再次调用 fake', async (t) => {
  const { store, file } = await withStore(t);
  const bound = binding('unknown_op');
  let calls = 0;
  const runFake = async () => { calls++; return { outcome: 'unknown', now }; };
  assert.deepEqual(await simulateQzoneBoundWriteOffline(file, bound, runFake),
    { allowed: true, outcome: 'unknown', replayed: false });
  assert.deepEqual(await simulateQzoneBoundWriteOffline(file, bound, runFake),
    { allowed: false, reason: 'invalid_capability', replayed: false });
  assert.equal(calls, 1);
  assert.equal(store.read().outcomes.unknown_op, 'unknown');
});

test('publish 通过单次请求快照预留 post 额度并安全审计', async (t) => {
  const { store, file } = await withStore(t);
  const publish = createQzoneWriteBinding('publish_op', 'publish',
    { content: secret, ugc_right: 1 }, { time: now, source: 'qq', target: '123', result: 'unknown', reason: '' });
  let calls = 0;
  const result = await simulateQzoneBoundWriteOffline(file, publish, async (request) => {
    calls++;
    assert.equal(request.params.content, secret);
    return { outcome: 'success', now };
  });
  assert.deepEqual(result, { allowed: true, outcome: 'success', successEvidence: 'fake_simulation_only', replayed: false });
  assert.equal(calls, 1);
  assert.equal(store.read().ledger.used.post, 1);
  assert.equal(store.read().audit[0].record.content, '[REDACTED]');
});

test('publish 的可信目标必须等于 SQLite state.selfId，否则零预留、零 fake', async (t) => {
  const { store, file } = await withStore(t, initialState({ selfId: '999' }));
  const publish = createQzoneWriteBinding('publish_identity_mismatch', 'publish',
    { content: 'ordinary body', ugc_right: 1 }, { time: now, source: 'qq', target: '123', result: 'unknown', reason: '' });
  let calls = 0;
  const result = await simulateQzoneBoundWriteOffline(file, publish, async () => {
    calls++;
    return { outcome: 'success', now };
  });
  assert.deepEqual(result, { allowed: false, reason: 'identity_mismatch', replayed: false });
  assert.equal(calls, 0);
  assert.deepEqual(store.read().ledger.reservations, {});
  assert.deepEqual(store.read().audit, []);
});

test('reply 没有可信 state.commentEvidence 时拒绝，不能绕过低层预留保护', async (t) => {
  const { store, file } = await withStore(t);
  const reply = createQzoneWriteBinding('reply_without_evidence', 'reply',
    { tid: 'post_1', target_uin: 456, content: 'reply body', comment_id: 'comment_1', comment_uin: 789 },
    { time: now, source: 'qq', target: '456', result: 'unknown', reason: '' });
  let calls = 0;
  const result = await simulateQzoneBoundWriteOffline(file, reply, async () => {
    calls++;
    return { outcome: 'success', now };
  });
  assert.deepEqual(result, { allowed: false, reason: 'missing_comment_evidence', replayed: false });
  assert.equal(calls, 0);
  assert.deepEqual(store.read().ledger.reservations, {});
  assert.deepEqual(store.read().audit, []);
});

test('reply 有精确匹配的可信 commentEvidence 时可正常预留', async (t) => {
  const evidence = [{ target: '456', postId: 'post_1', commentId: 'comment_1', commentUin: '789', replyUin: null, replyName: null }];
  const { store, file } = await withStore(t, initialState({ commentEvidence: evidence }));
  const reply = createQzoneWriteBinding('reply_with_evidence', 'reply',
    { tid: 'post_1', target_uin: 456, content: 'reply body', comment_id: 'comment_1', comment_uin: 789 },
    { time: now, source: 'qq', target: '456', result: 'unknown', reason: '' });
  let calls = 0;
  const result = await simulateQzoneBoundWriteOffline(file, reply, async () => {
    calls++;
    return { outcome: 'success', now };
  });
  assert.deepEqual(result, { allowed: true, outcome: 'success', successEvidence: 'fake_simulation_only', replayed: false });
  assert.equal(calls, 1);
  assert.equal(store.read().ledger.reservations.reply_with_evidence, 'comment');
});

test('reply 必须匹配可信评论作者，楼中楼对象和名称也必须由 evidence 证明', async (t) => {
  const cases = [
    {
      name: 'different-comment-author', commentUin: '999', request: { comment_uin: 789 },
    },
    {
      name: 'unproven-thread-target', commentUin: '789', replyUin: null, replyName: null,
      request: { comment_uin: 789, reply_uin: 321, reply_name: 'Alice' },
    },
    {
      name: 'forged-thread-name', commentUin: '789', replyUin: '321', replyName: 'Bob',
      request: { comment_uin: 789, reply_uin: 321, reply_name: 'Alice' },
    },
    {
      name: 'forged-thread-recipient', commentUin: '789', replyUin: '654', replyName: 'Alice',
      request: { comment_uin: 789, reply_uin: 321, reply_name: 'Alice' },
    },
  ];
  for (const item of cases) {
    const evidence = [{ target: '456', postId: 'post_1', commentId: 'comment_1',
      commentUin: item.commentUin, replyUin: item.replyUin ?? null, replyName: item.replyName ?? null }];
    const { store, file } = await withStore(t, initialState({ commentEvidence: evidence }));
    const reply = createQzoneWriteBinding(`reply_evidence_${item.name}`, 'reply', {
      tid: 'post_1', target_uin: 456, content: 'reply body', comment_id: 'comment_1',
      comment_uin: item.request.comment_uin,
      ...(item.request.reply_uin === undefined ? {} : { reply_uin: item.request.reply_uin, reply_name: item.request.reply_name }),
    }, { time: now, source: 'qq', target: '456', result: 'unknown', reason: '' });
    let calls = 0;
    const result = await simulateQzoneBoundWriteOffline(file, reply, async () => {
      calls++;
      return { outcome: 'success', now };
    });
    assert.deepEqual(result, { allowed: false, reason: 'comment_evidence_mismatch', replayed: false }, item.name);
    assert.equal(calls, 0, item.name);
    assert.deepEqual(store.read().ledger.reservations, {}, item.name);
    assert.deepEqual(store.read().audit, [], item.name);
  }
});

test('既有 reservation 与同为 [REDACTED] 的 intent 一律不可重发', async (t) => {
  const { store, file } = await withStore(t);
  const original = binding('duplicate_redacted');
  store.update((state) => ({ ...state,
    ledger: { ...state.ledger, used: { ...state.ledger.used, comment: 1 }, reservations: { duplicate_redacted: 'comment' } },
    audit: [{ id: 'intent_duplicate_redacted', record: original.audit }],
  }));
  let calls = 0;
  const result = await simulateQzoneBoundWriteOffline(file, original, async () => {
    calls++;
    return { outcome: 'success', now };
  });
  assert.deepEqual(result, { allowed: false, reason: 'pending', replayed: false });
  assert.equal(calls, 0);
  assert.deepEqual(store.read().dispatchClaims, {});
  assert.equal(store.read().outcomes.duplicate_redacted, undefined);
});

test('重启后同一 redacted intent 携带另一正文也不得继续 claim 或 fake 重发', async (t) => {
  const { store, file } = await withStore(t);
  const original = binding('redacted_restart_collision');
  store.update((state) => ({ ...state,
    ledger: { ...state.ledger, used: { ...state.ledger.used, comment: 1 }, reservations: { redacted_restart_collision: 'comment' } },
    audit: [{ id: 'intent_redacted_restart_collision', record: original.audit }],
  }));
  const bindingUrl = new URL('../src/core/qzone-write-binding-offline.mjs', import.meta.url).href;
  const moduleUrl = new URL('../src/core/qzone-bound-write-simulation-offline.mjs', import.meta.url).href;
  const otherSecret = 'Cookie: qzonetoken=different-process-body';
  const code = `import {createQzoneWriteBinding} from ${JSON.stringify(bindingUrl)}; import {simulateQzoneBoundWriteOffline} from ${JSON.stringify(moduleUrl)}; const b=createQzoneWriteBinding('redacted_restart_collision','comment',{tid:'post_1',target_uin:456,content:${JSON.stringify(otherSecret)}},{time:${now},source:'qq',target:'456',result:'unknown',reason:''}); let calls=0; const r=await simulateQzoneBoundWriteOffline(process.argv[1],b,async()=>{calls++;return {outcome:'success',now:${now}}}); process.stdout.write(JSON.stringify({r,calls}));`;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', code, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => status === 0 ? resolve(stdout) : reject(new Error(stderr || `child exit ${status}`)));
  });
  assert.deepEqual(JSON.parse(output), { r: { allowed: false, reason: 'pending', replayed: false }, calls: 0 });
  assert.deepEqual(store.read().dispatchClaims, {});
  assert.deepEqual(store.read().outcomes, {});
  assert.equal(store.read().audit.length, 1);
  assert.equal((await readFile(file)).includes(Buffer.from('different-process-body')), false);
});

test('SQLite 持久 claim 在新进程中仍禁止 fake 重播', async (t) => {
  const { store, file } = await withStore(t);
  const first = binding('restart_op');
  assert.equal((await simulateQzoneBoundWriteOffline(file, first, async () => ({ outcome: 'success', now }))).allowed, true);

  const moduleUrl = new URL('../src/core/qzone-bound-write-simulation-offline.mjs', import.meta.url).href;
  const bindingUrl = new URL('../src/core/qzone-write-binding-offline.mjs', import.meta.url).href;
  const code = `import {createQzoneWriteBinding} from ${JSON.stringify(bindingUrl)}; import {simulateQzoneBoundWriteOffline} from ${JSON.stringify(moduleUrl)}; const b=createQzoneWriteBinding('restart_op','comment',{tid:'post_1',target_uin:456,content:${JSON.stringify(secret)}},{time:${now},source:'qq',target:'456',result:'unknown',reason:''}); let calls=0; const r=await simulateQzoneBoundWriteOffline(process.argv[1],b,async()=>{calls++;return {outcome:'success',now:${now}}}); process.stdout.write(JSON.stringify({r,calls}));`;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', code, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => status === 0 ? resolve(stdout) : reject(new Error(stderr || `child exit ${status}`)));
  });
  assert.deepEqual(JSON.parse(output), { r: { allowed: false, reason: 'already_settled', replayed: false }, calls: 0 });
  assert.equal(store.read().dispatchClaims.restart_op, 'comment');
});

test('已有 claim 可能仍在执行：第二进程只报告 pending，不改状态或重播 fake', async (t) => {
  const { store, file } = await withStore(t);
  const interrupted = binding('crash_op');
  let releaseFake;
  const inFlight = simulateQzoneBoundWriteOffline(file, interrupted, () => new Promise((resolve) => {
    releaseFake = () => resolve({ outcome: 'success', now });
  }));
  while (!releaseFake) await new Promise((resolve) => setTimeout(resolve, 1));

  const moduleUrl = new URL('../src/core/qzone-bound-write-simulation-offline.mjs', import.meta.url).href;
  const bindingUrl = new URL('../src/core/qzone-write-binding-offline.mjs', import.meta.url).href;
  const code = `import {createQzoneWriteBinding} from ${JSON.stringify(bindingUrl)}; import {simulateQzoneBoundWriteOffline} from ${JSON.stringify(moduleUrl)}; const b=createQzoneWriteBinding('crash_op','comment',{tid:'post_1',target_uin:456,content:${JSON.stringify(secret)}},{time:${now},source:'qq',target:'456',result:'unknown',reason:''}); let calls=0; const r=await simulateQzoneBoundWriteOffline(process.argv[1],b,async()=>{calls++;return {outcome:'success',now:${now}}}); process.stdout.write(JSON.stringify({r,calls}));`;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', code, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => status === 0 ? resolve(stdout) : reject(new Error(stderr || `child exit ${status}`)));
  });
  assert.deepEqual(JSON.parse(output), { r: { allowed: false, reason: 'pending', replayed: false }, calls: 0 });
  assert.equal(store.read().outcomes.crash_op, undefined);
  assert.equal(store.read().audit.length, 1);
  releaseFake();
  assert.deepEqual(await inFlight, { allowed: true, outcome: 'success', successEvidence: 'fake_simulation_only', replayed: false });
  assert.equal(store.read().outcomes.crash_op, 'success');
});

test('fake 抛错被保守结算为 unknown，且事务/能力伪造 fail closed', async (t) => {
  const { store, file } = await withStore(t);
  let calls = 0;
  const result = await simulateQzoneBoundWriteOffline(file, binding('throw_op'), async () => {
    calls++;
    throw new Error('fake interrupted');
  });
  assert.deepEqual(result, { allowed: true, outcome: 'unknown', replayed: false });
  assert.equal(calls, 1);
  assert.equal(store.read().outcomes.throw_op, 'unknown');

  assert.deepEqual(await simulateQzoneBoundWriteOffline(file,
    { id: 'forged', capability: Object.freeze(Object.create(null)) }, async () => { calls++; }),
  { allowed: false, reason: 'invalid_capability', replayed: false });
  assert.equal(calls, 1);
});

test('fake 结算时间早于意图时间时强制 unknown，不接受倒退成功', async (t) => {
  const { store, file } = await withStore(t);
  const result = await simulateQzoneBoundWriteOffline(file, binding('backdated_outcome'),
    async () => ({ outcome: 'success', now: now - 1 }));
  assert.deepEqual(result, { allowed: true, outcome: 'unknown', replayed: false });
  assert.equal(store.read().outcomes.backdated_outcome, 'unknown');
  assert.equal(store.read().ledger.used.comment, 1);
  assert.equal(store.read().ledger.reservations.backdated_outcome, 'comment');
  assert.equal(store.read().audit.find((entry) => entry.id === 'write:backdated_outcome').record.result, 'unknown');
});

test('拒绝不存在路径、目录和临时目录内符号链接，不创建或跟随目标', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-bound-path-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const missing = join(dir, 'missing.db');
  const directoryPath = join(dir, 'directory');
  const target = join(dir, 'target.db');
  const link = join(dir, 'link.db');
  const targetStore = openOfflineStore(target, initialState());
  targetStore.close();
  await import('node:fs/promises').then(({ mkdir }) => mkdir(directoryPath));
  let linked = true;
  try { await symlink(target, link, 'file'); } catch (error) { linked = false; if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; }
  let calls = 0;
  const fake = async () => { calls++; return { outcome: 'success', now }; };
  for (const path of [missing, directoryPath, ...(linked ? [link] : [])]) {
    const result = await simulateQzoneBoundWriteOffline(path, binding(`bad_path_${calls}_${path === missing ? 'missing' : path === directoryPath ? 'directory' : 'link'}`), fake);
    assert.deepEqual(result, { allowed: false, reason: 'invalid_store', replayed: false });
  }
  assert.equal(calls, 0);
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  assert.equal((await lstat(directoryPath)).isDirectory(), true);
  if (linked) assert.equal((await lstat(link)).isSymbolicLink(), true);
  const verify = openOfflineStore(target, {});
  try { assert.deepEqual(verify.read(), initialState()); } finally { verify.close(); }
});
