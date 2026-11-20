import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
const claimModule = await import('../src/core/qzone-dispatch-claim-offline.mjs').catch(() => ({}));
const { claimQzoneWriteDispatch } = claimModule;

const now = Date.parse('2026-11-08T02:00:00Z');
const request = { id: 'op1', kind: 'publish' };

function initialState() {
  return { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    selfId: '123',
    tools: { publish: true, comment: true, reply: true, like: true },
    ledger: { day: '2026-11-08', used: { post: 1, comment: 0, like: 0 }, reservations: { op1: 'post' } },
    outcomes: {}, dispatchClaims: {}, audit: [{ id: 'intent_op1', record: { time: now, source: 'qq', action: 'publish',
      target: '123', postId: null, commentId: null, content: 'fixture', redacted: false, result: 'unknown', reason: '', quota: null } }] };
}

test('事务认领检查开关、写权限、暂停、类型及预留和意图绑定，并拒绝重复', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-claim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), initialState());
  assert.equal(typeof claimQzoneWriteDispatch, 'function', 'offline atomic dispatch claim module must exist');
  assert.deepEqual(claimQzoneWriteDispatch(db, request), { allowed: true, claim: { id: 'op1', kind: 'publish' } });
  assert.deepEqual(claimQzoneWriteDispatch(db, request), { allowed: false, reason: 'duplicate' });
  db.close();
  db = openOfflineStore(join(dir, 'state.db'), initialState());
  assert.deepEqual(claimQzoneWriteDispatch(db, request), { allowed: false, reason: 'duplicate' }, 'a committed claim survives restart');

  db.update(s => ({ ...s, dispatchClaims: {}, audit: [{ ...s.audit[0], record: { ...s.audit[0].record,
    content: '[REDACTED]', redacted: true } }] }));
  assert.deepEqual(claimQzoneWriteDispatch(db, request), { allowed: true, claim: { id: 'op1', kind: 'publish' } },
    'canonical redacted intent is claimable');

  const cases = [
    [s => ({ ...s, enabled: false }), request, 'disabled'],
    [s => ({ ...s, writeAllowed: false }), request, 'permission'],
    [s => ({ ...s, accessPaused: true }), request, 'access_paused'],
    [s => ({ ...s, writePaused: true }), request, 'write_paused'],
    [s => ({ ...s, tools: { ...s.tools, publish: false } }), request, 'tool_permission'],
    [s => ({ ...s, ledger: { ...s.ledger, reservations: {} } }), request, 'missing_reservation'],
    [s => ({ ...s, audit: [] }), request, 'missing_intent'],
    [s => ({ ...s, audit: [{ ...s.audit[0], record: { ...s.audit[0].record, target: '456' } }] }), request, 'intent_mismatch'],
    [s => ({ ...s, audit: [{ ...s.audit[0], record: { ...s.audit[0].record, content: 'unmasked', redacted: true } }] }), request, 'intent_mismatch'],
    [s => ({ ...s, audit: [{ ...s.audit[0], record: { ...s.audit[0].record, content: '[REDACTED]', redacted: false } }] }), request, 'intent_mismatch'],
    [s => ({ ...s, ledger: { ...s.ledger, reservations: { op1: 'like' } } }), request, 'missing_reservation'],
    [s => ({ ...s, outcomes: { op1: 'unknown' } }), request, 'already_settled'],
    [s => s, { id: 'op1', kind: 'delete' }, 'invalid_operation'],
  ];
  for (const [mutate, req, reason] of cases) {
    db.update(mutate);
    assert.deepEqual(claimQzoneWriteDispatch(db, req), { allowed: false, reason }, reason);
    db.update(() => initialState());
  }
});

test('多个 Node 进程竞争同一预留时只有一个获得持久认领', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-claim-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.db');
  const db = openOfflineStore(file, initialState()); db.close();
  const storeUrl = new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href;
  const claimUrl = new URL('../src/core/qzone-dispatch-claim-offline.mjs', import.meta.url).href;
  const gate = join(dir, 'go');
  const code = `import {access} from 'node:fs/promises'; import {openOfflineStore} from ${JSON.stringify(storeUrl)}; import {claimQzoneWriteDispatch} from ${JSON.stringify(claimUrl)}; while(true){try{await access(process.argv[2]);break}catch{await new Promise(r=>setTimeout(r,5))}} const s=openOfflineStore(process.argv[1],{}); try{const r=claimQzoneWriteDispatch(s,{id:'op1',kind:'publish'});process.stdout.write(JSON.stringify(r));}finally{s.close()}`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file, gate], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', x => { stdout += x; });
    child.stderr.setEncoding('utf8').on('data', x => { stderr += x; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `child exit ${code}`)));
  });
  const workers = Array.from({ length: 6 }, run);
  await new Promise(resolve => setTimeout(resolve, 100));
  await writeFile(gate, 'go');
  const results = await Promise.all(workers);
  assert.equal(results.filter(x => x.allowed).length, 1);
  assert.equal(results.filter(x => x.reason === 'duplicate').length, 5);
  const verify = openOfflineStore(file, initialState());
  try { assert.deepEqual(verify.read().dispatchClaims, { op1: 'publish' }); } finally { verify.close(); }
});

test('权限在预留后、认领前被另一进程撤销时拒绝认领', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-claim-revoke-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  db = openOfflineStore(file, initialState());
  const storeUrl = new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href;
  const code = `import {openOfflineStore} from ${JSON.stringify(storeUrl)}; const s=openOfflineStore(process.argv[1],{}); try{s.update(state=>({...state,writeAllowed:false}))}finally{s.close()}`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`revocation process exit ${code}`)));
  });
  assert.deepEqual(claimQzoneWriteDispatch(db, request), { allowed: false, reason: 'permission' });
  assert.deepEqual(db.read().dispatchClaims, {});
  assert.equal(db.read().ledger.reservations.op1, 'post');
});

test('异步或迟到的存储事务不得在认领返回后修改状态', async () => {
  let delayed;
  const state = initialState();
  assert.throws(() => claimQzoneWriteDispatch({ update(fn) { delayed = fn; return Promise.resolve(state); } }, request));
  assert.deepEqual(delayed(state), state);
  assert.deepEqual(state.dispatchClaims, {});
});
