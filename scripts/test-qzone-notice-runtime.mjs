import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { dispatchNotice } from '../src/core/qzone-notice-runtime.mjs';

const runtimeTestPath = fileURLToPath(import.meta.url);

function runWorker(dbPath, token, gatePath, counterPath) {
  const source = `
    import { openOfflineStore } from ${JSON.stringify(new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href)};
    import { dispatchNotice } from ${JSON.stringify(new URL('../src/core/qzone-notice-runtime.mjs', import.meta.url).href)};
    import { appendFileSync, existsSync } from 'node:fs';
    const db = openOfflineStore(process.argv[1], { notices: [] });
    try {
      const result = await dispatchNotice(db, 0, { token: process.argv[2], timeoutMs: 10000, sender: async () => {
        appendFileSync(process.argv[4], process.argv[2] + '\\n', { flag: 'a' });
        while (!existsSync(process.argv[3])) await new Promise(resolve => setTimeout(resolve, 5));
        return 'success';
      }});
      process.stdout.write(JSON.stringify(result));
    } finally { db.close(); }
  `;
  return spawn(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', source,
    dbPath, token, gatePath, counterPath], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
}

async function finishChild(child) {
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const errors = [];
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const [code] = await once(child, 'exit');
  return { code, stdout: Buffer.concat(chunks).toString(), stderr: Buffer.concat(errors).toString() };
}

async function withStore(t, notices) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-notice-runtime-'));
  let db = openOfflineStore(join(dir, 'state.sqlite'), { notices });
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    get db() { return db; },
    reopen() { db.close(); db = openOfflineStore(join(dir, 'state.sqlite'), { notices: [] }); return db; },
  };
}

const notice = (extra = {}) => ({ layer: 'write', cause: 'failure', operationId: 'op-1', ...extra });

test('调用注入 sender 前持久 claim，明确成功后持久 finish 且不重复发送', async (t) => {
  const holder = await withStore(t, [notice()]);
  let calls = 0;
  const result = await dispatchNotice(holder.db, 0, { token: 'claim1', sender: async (message) => {
    calls++;
    assert.equal(message, 'QQ空间写入连续失败，写入已暂停。请管理员检查状态并手动处理。');
    assert.equal(holder.db.read().notices[0].delivery, 'claimed');
    return 'success';
  } });
  assert.equal(result.status, 'sent');
  assert.equal(holder.db.read().notices[0].delivery, 'sent');
  holder.reopen();
  assert.equal((await dispatchNotice(holder.db, 0, { token: 'claim2', sender: async () => { calls++; return 'success'; } })).status, 'not_claimed');
  assert.equal(calls, 1);
});

test('不同 Node 进程竞争同一 SQLite 待发通知时仅一方 claim 并调用 fake sender', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-notice-process-race-'));
  const dbPath = join(dir, 'state.sqlite');
  const gatePath = join(dir, 'release-senders');
  const counterPath = join(dir, 'sender-calls.txt');
  const db = openOfflineStore(dbPath, { notices: [notice()] });
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

  const children = [runWorker(dbPath, 'worker1', gatePath, counterPath), runWorker(dbPath, 'worker2', gatePath, counterPath)];
  const exits = children.map(finishChild);
  const deadline = Date.now() + 8000;
  let senderStarted = false;
  while (Date.now() < deadline) {
    try { await stat(counterPath); senderStarted = true; break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!senderStarted) {
    for (const child of children) child.kill();
    await Promise.all(exits);
    assert.fail('no child reached the fake sender before timeout');
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(gatePath, 'go');
  const results = await Promise.all(exits);

  assert.deepEqual(results.map(({ code, stdout }) => ({ code, status: JSON.parse(stdout).status })).sort((a, b) => a.status.localeCompare(b.status)), [
    { code: 0, status: 'sent' },
    { code: 0, status: 'not_claimed' },
  ].sort((a, b) => a.status.localeCompare(b.status)));
  assert.equal((await readFile(counterPath, 'utf8')).trim().split(/\r?\n/).length, 1);
  assert.equal(db.read().notices[0].delivery, 'sent');
});

test('明确失败可重试；sender 抛错或返回非法值按 unknown 封存并隐藏原始错误', async (t) => {
  const holder = await withStore(t, [notice()]);
  assert.equal((await dispatchNotice(holder.db, 0, { token: 'claim1', sender: async () => 'failure' })).status, 'failure');
  let calls = 0;
  const result = await dispatchNotice(holder.db, 0, { token: 'claim2', sender: async () => { calls++; throw new Error('Bearer raw-secret'); } });
  assert.equal(result.status, 'unknown');
  assert.equal(JSON.stringify(result).includes('raw-secret'), false);
  assert.equal(holder.db.read().notices[0].delivery, 'unknown');
  assert.equal((await dispatchNotice(holder.db, 0, { token: 'claim3', sender: async () => { calls++; return 'sent'; } })).status, 'not_claimed');
  assert.equal(calls, 1);
});

test('取消在发送期间结算 unknown，后续不盲目重发', async (t) => {
  const holder = await withStore(t, [notice()]);
  const controller = new AbortController();
  const result = await dispatchNotice(holder.db, 0, { token: 'claim1', signal: controller.signal,
    sender: async (_message, { signal }) => { controller.abort(); assert.equal(signal.aborted, true); return new Promise(() => {}); } });
  assert.equal(result.status, 'unknown');
  assert.equal(holder.db.read().notices[0].delivery, 'unknown');
  assert.equal((await dispatchNotice(holder.db, 0, { token: 'claim2', sender: async () => 'success' })).status, 'not_claimed');
});

test('sender 微任务执行前同步取消时不得调用 sender', async (t) => {
  const holder = await withStore(t, [notice()]);
  const controller = new AbortController();
  let calls = 0;
  const pending = dispatchNotice(holder.db, 0, { token: 'claim1', signal: controller.signal,
    sender: async () => { calls++; return 'success'; } });
  controller.abort();
  assert.equal((await pending).status, 'unknown');
  assert.equal(calls, 0);
  assert.equal(holder.db.read().notices[0].delivery, 'unknown');
});

test('sender 永不返回时限时 abort 并结算 unknown，迟到成功不改变终态', async (t) => {
  const holder = await withStore(t, [notice()]);
  let calls = 0;
  let senderSignal;
  let release;
  const lateResult = new Promise((resolve) => { release = resolve; });
  const result = await dispatchNotice(holder.db, 0, { token: 'claim1', timeoutMs: 15,
    sender: (_message, { signal }) => {
      calls++;
      senderSignal = signal;
      return lateResult;
    } });
  assert.equal(result.status, 'unknown');
  assert.equal(senderSignal.aborted, true);
  assert.equal(holder.db.read().notices[0].delivery, 'unknown');
  release('success');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(holder.db.read().notices[0].delivery, 'unknown');
  assert.equal((await dispatchNotice(holder.db, 0, { token: 'claim2', sender: async () => { calls++; return 'success'; } })).status, 'not_claimed');
  assert.equal(calls, 1);
});

test('claim 前拒绝缺少 removeEventListener 的伪信号且不改变状态', async (t) => {
  const holder = await withStore(t, [notice()]);
  let calls = 0;
  const before = structuredClone(holder.db.read());
  await assert.rejects(dispatchNotice(holder.db, 0, { token: 'claim1', signal: {
    aborted: false,
    addEventListener() {},
  }, sender: async () => { calls++; return 'success'; } }), /invalid options/);
  assert.equal(calls, 0);
  assert.deepEqual(holder.db.read(), before);
});

test('signal 注册或清理监听器抛错也必须结算 unknown，不残留 claimed', async (t) => {
  const holder = await withStore(t, [notice()]);
  const throwingSignal = {
    aborted: false,
    addEventListener() { throw new Error('listener registration failed'); },
    removeEventListener() { throw new Error('listener cleanup failed'); },
  };
  const result = await dispatchNotice(holder.db, 0, { token: 'claim1', signal: throwingSignal,
    sender: async () => 'success' });
  assert.equal(result.status, 'unknown');
  assert.equal(holder.db.read().notices[0].delivery, 'unknown');
});

test('初始 read 抛含敏感文本错误时只返回 unknown 且不调用 sender', async (t) => {
  const holder = await withStore(t, [notice()]);
  let calls = 0;
  const store = { read() { throw new Error('Bearer read-secret'); }, update: holder.db.update.bind(holder.db) };
  const result = await dispatchNotice(store, 0, { token: 'claim1', sender: async () => { calls++; return 'success'; } });
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(JSON.stringify(result).includes('read-secret'), false);
  assert.equal(calls, 0);
  assert.equal(holder.db.read().notices[0].delivery, undefined);
});

test('claim 已提交后抛错返回 unknown，不调用 sender 且不重复 claim', async (t) => {
  const holder = await withStore(t, [notice()]);
  let calls = 0;
  let throwAfterCommit = true;
  const store = {
    read: holder.db.read.bind(holder.db),
    update(fn) {
      const result = holder.db.update(fn);
      if (throwAfterCommit) { throwAfterCommit = false; throw new Error('Bearer commit-secret'); }
      return result;
    },
  };
  const result = await dispatchNotice(store, 0, { token: 'claim1', sender: async () => { calls++; return 'success'; } });
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(JSON.stringify(result).includes('commit-secret'), false);
  assert.equal(calls, 0);
  assert.equal(holder.db.read().notices[0].delivery, 'claimed');
  assert.equal((await dispatchNotice(holder.db, 0, { token: 'claim2', sender: async () => { calls++; return 'success'; } })).status, 'not_claimed');
  assert.equal(calls, 0);
});

test('claim 后复读抛错保守返回 unknown 并尝试封存 claim', async (t) => {
  const holder = await withStore(t, [notice()]);
  let reads = 0;
  let calls = 0;
  const store = {
    read() { if (++reads === 2) throw new Error('Bearer reread-secret'); return holder.db.read(); },
    update: holder.db.update.bind(holder.db),
  };
  const result = await dispatchNotice(store, 0, { token: 'claim1', sender: async () => { calls++; return 'success'; } });
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(JSON.stringify(result).includes('reread-secret'), false);
  assert.equal(calls, 0);
  assert.equal(holder.db.read().notices[0].delivery, 'unknown');
});

test('claim 前 notice 被替换时以已领取记录重新判定，不派发旧文案', async (t) => {
  const holder = await withStore(t, [notice()]);
  let state = holder.db.read();
  let firstRead = true;
  const racingStore = {
    read() {
      if (firstRead) { firstRead = false; return state; }
      return holder.db.read();
    },
    update(fn) {
      state = holder.db.read();
      state = { ...state, notices: state.notices.map((item, index) => index === 0 ? { ...item, cause: 'unexpected', reason: 'changed-secret' } : item) };
      holder.db.update(() => state);
      return holder.db.update(fn);
    },
  };
  let calls = 0;
  const result = await dispatchNotice(racingStore, 0, { token: 'claim1', sender: async () => { calls++; return 'success'; } });
  assert.equal(result.status, 'unsupported');
  assert.equal(calls, 0);
  assert.equal(holder.db.read().notices[0].delivery, 'unknown');
});

test('无凭据文案的通知不会调用 sender，接线不接受独占布尔开关', async (t) => {
  const holder = await withStore(t, [notice({ cause: 'unexpected', reason: 'secret' })]);
  let calls = 0;
  assert.equal((await dispatchNotice(holder.db, 0, { token: 'claim1', sender: async () => { calls++; return 'success'; } })).status, 'unsupported');
  assert.equal(calls, 0);
  await assert.rejects(dispatchNotice(holder.db, 0, { token: 'claim2', exclusiveOwnershipConfirmed: true, sender: async () => 'success' }), /invalid options/);
});
