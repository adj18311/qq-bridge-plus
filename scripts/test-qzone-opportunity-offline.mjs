import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { adaptQzoneOfflineOpportunity, QZONE_OPPORTUNITY_OFFLINE_BOUNDARY } from '../src/core/qzone-opportunity-offline.mjs';

const NOW = Date.parse('2026-11-08T02:00:00Z'); // 10:00 Beijing

function initial(overrides = {}) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false,
    writePaused: false, tools: { read_posts: true }, activeStart: 420, activeEnd: 1380,
    intervalMinutes: 100,
    readAttempts: {}, readOutcomes: {}, usedOpportunities: {},
    browseDay: '2026-11-08', todayBrowses: 0, lastBrowseAt: null,
    ...overrides,
  };
}

async function harness(t, state = initial()) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-opportunity-'));
  const file = join(dir, 'state.db');
  let store = openOfflineStore(file, state);
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  return { file, get store() { return store; }, reopen() { store.close(); store = openOfflineStore(file, initial()); return store; } };
}

test('领取机会只记录展示，不消耗额度；真实读取仍可预留，重启后不重放', async (t) => {
  const h = await harness(t);
  const before = h.store.read();
  const first = adaptQzoneOfflineOpportunity(h.store, { id: 'patrol-20261108-1', now: NOW });
  assert.deepEqual(first, { allowed: true, opportunity: { id: 'patrol-20261108-1', tool: 'read_posts', now: NOW } });
  assert.deepEqual(h.store.read().readAttempts, before.readAttempts);
  assert.equal(h.store.read().todayBrowses, before.todayBrowses);
  assert.equal(h.store.read().lastBrowseAt, before.lastBrowseAt);
  assert.deepEqual(h.store.read().usedOpportunities, before.usedOpportunities);
  assert.equal(h.store.read().offlineOpportunityOffers['patrol-20261108-1'], NOW);
  const { reserveOfflineRead } = await import('../src/core/qzone-read-reservation-offline.mjs');
  assert.deepEqual(reserveOfflineRead(h.store, {
    id: 'patrol-20261108-1', tool: 'read_posts', source: 'proactive',
    opportunity: 'patrol-20261108-1', now: NOW, activeTime: false,
  }), { allowed: true });
  assert.equal(h.store.read().todayBrowses, 1);
  assert.equal(h.store.read().readAttempts['patrol-20261108-1'], true);
  assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'patrol-20261108-1', now: NOW + 3600000 }).reason, 'duplicate');
  h.reopen();
  assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'patrol-20261108-1', now: NOW }).reason, 'duplicate');
  assert.equal(h.store.read().todayBrowses, 1);
});

test('主动机会遵守配置间隔，跨重启保留；缩短配置只影响后续机会', async (t) => {
  const h = await harness(t);
  assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'first-offer', now: NOW }).allowed, true);
  h.reopen();
  assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'early-offer', now: NOW + 99 * 60000 }).allowed, false);
  assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'next-offer', now: NOW + 100 * 60000 }).allowed, true);
  h.store.update((s) => ({ ...s, intervalMinutes: 15 }));
  assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'changed-early', now: NOW + 114 * 60000 }).allowed, false);
  assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'changed-ready', now: NOW + 115 * 60000 }).allowed, true);
});

test('两个 Node 进程同时领取不同机会时仅放行一个，重启后间隔仍持久', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-opportunity-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.db');
  const state = initial();
  const seeded = openOfflineStore(file, state);
  seeded.close();

  const storeUrl = new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href;
  const opportunityUrl = new URL('../src/core/qzone-opportunity-offline.mjs', import.meta.url).href;
  const code = `import {openOfflineStore} from ${JSON.stringify(storeUrl)};
import {adaptQzoneOfflineOpportunity} from ${JSON.stringify(opportunityUrl)};
const store = openOfflineStore(process.argv[1], ${JSON.stringify(state)});
process.stdout.write('READY\\n');
process.stdin.once('data', () => {
  try {
    const result = adaptQzoneOfflineOpportunity(store, {id: process.argv[2], now: ${NOW}});
    process.stdout.write(JSON.stringify({id: process.argv[2], ...result}) + '\\n');
  } catch (error) {
    process.stderr.write(String(error));
    process.exitCode = 1;
  } finally {
    store.close();
  }
});`;
  const children = ['race-a', 'race-b'].map((id) => spawn(process.execPath,
    ['--input-type=module', '-e', code, file, id], { stdio: ['pipe', 'pipe', 'pipe'] }));
  const results = [];
  const ready = children.map((child) => new Promise((resolve, reject) => {
    let buffer = '';
    let isReady = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line === 'READY') {
          isReady = true;
          resolve();
        } else if (line) {
          try { results.push(JSON.parse(line)); } catch (error) { reject(error); }
        }
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!isReady) reject(new Error(`child exited before READY (${code})`));
    });
  }));
  const exits = children.map((child) => new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  }));

  await Promise.all(ready);
  for (const child of children) child.stdin.end('go');
  const exitResults = await Promise.all(exits);
  assert.deepEqual(exitResults.map(({ code }) => code), [0, 0], exitResults.map(({ stderr }) => stderr).join('\n'));
  assert.equal(results.length, 2);
  assert.equal(results.filter((result) => result.allowed).length, 1);
  assert.equal(results.filter((result) => result.reason === 'interval').length, 1);

  const verify = openOfflineStore(file, state);
  try {
    assert.equal(Object.keys(verify.read().offlineOpportunityOffers).length, 1);
    const early = adaptQzoneOfflineOpportunity(verify, { id: 'after-restart-early', now: NOW + 99 * 60000 });
    assert.deepEqual(early, { allowed: false, reason: 'interval' });
    assert.equal(adaptQzoneOfflineOpportunity(verify, { id: 'after-restart-ready', now: NOW + 100 * 60000 }).allowed, true);
  } finally {
    verify.close();
  }
});

test('机会间隔无效或历史时间损坏时拒绝，不因时钟回拨提前产生机会', async (t) => {
  for (const state of [initial({ intervalMinutes: 14 }), initial({ intervalMinutes: null }),
    initial({ offlineOpportunityOffers: { old: 'bad' } }), initial({ offlineOpportunityOffers: { old: NOW + 1 } })]) {
    const h = await harness(t, state);
    assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'next', now: NOW }).allowed, false);
    assert.equal(Object.hasOwn(h.store.read().offlineOpportunityOffers ?? {}, 'next'), false);
  }
});

test('关闭、无权限、暂停、工具关闭或非活动时段均拒绝且不领取机会', async (t) => {
  const variants = [
    [{ enabled: false }, 'disabled'], [{ readAllowed: false }, 'permission'],
    [{ accessPaused: true }, 'access_paused'], [{ tools: { read_posts: false } }, 'tool_permission'],
    [{ activeStart: 660, activeEnd: 1380 }, 'outside_active_time'],
  ];
  for (const [overrides, reason] of variants) {
    const h = await harness(t, initial(overrides));
    const result = adaptQzoneOfflineOpportunity(h.store, { id: `blocked-${reason}`, now: NOW });
    assert.deepEqual(result, { allowed: false, reason });
    assert.deepEqual(h.store.read().offlineOpportunityOffers ?? {}, {});
    assert.deepEqual(h.store.read().readAttempts, {});
  }
});

test('初始化状态中的北京时间默认时段决定机会是否可用', async (t) => {
  const h = await harness(t, initial({ activeStart: 420, activeEnd: 1380 }));
  assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'default-window', now: NOW }).allowed, true);
  const afterWindow = adaptQzoneOfflineOpportunity(h.store, {
    id: 'outside-default-window', now: Date.parse('2026-11-08T16:00:00Z'), // midnight Beijing
  });
  assert.deepEqual(afterWindow, { allowed: false, reason: 'outside_active_time' });
});

test('缺少或非法活动时段配置时 fail closed，不提供机会', async (t) => {
  for (const overrides of [
    { activeStart: undefined }, { activeEnd: undefined },
    { activeStart: 420, activeEnd: 420 }, { activeStart: -1, activeEnd: 1380 },
  ]) {
    const state = initial(overrides);
    if ('activeStart' in overrides && overrides.activeStart === undefined) delete state.activeStart;
    if ('activeEnd' in overrides && overrides.activeEnd === undefined) delete state.activeEnd;
    const h = await harness(t, state);
    assert.deepEqual(adaptQzoneOfflineOpportunity(h.store, { id: 'missing-window', now: NOW }), {
      allowed: false, reason: 'invalid',
    });
    assert.deepEqual(h.store.read().offlineOpportunityOffers ?? {}, {});
  }
});

test('旧 usedOpportunities 已领取的机会不能再次展示', async (t) => {
  const h = await harness(t, initial({ usedOpportunities: { 'already-used': true } }));
  assert.deepEqual(adaptQzoneOfflineOpportunity(h.store, { id: 'already-used', now: NOW }), {
    allowed: false, reason: 'duplicate',
  });
  assert.deepEqual(h.store.read().offlineOpportunityOffers ?? {}, {});
});

test('无效或不存在的 browseDay 日期 fail closed', async (t) => {
  for (const browseDay of ['2026-02-30', '2026-13-01', '2026-2-03', 'not-a-day']) {
    const h = await harness(t, initial({ browseDay }));
    assert.deepEqual(adaptQzoneOfflineOpportunity(h.store, { id: `invalid-${browseDay}`, now: NOW }), {
      allowed: false, reason: 'invalid',
    });
    assert.deepEqual(h.store.read().offlineOpportunityOffers ?? {}, {});
  }
});

test('写暂停预算已耗尽时拒绝机会展示且不记录领取', async (t) => {
  const h = await harness(t, initial({ writePaused: true, todayBrowses: 3 }));
  const denied = adaptQzoneOfflineOpportunity(h.store, { id: 'budget-denied', now: NOW });
  assert.deepEqual(denied, { allowed: false, reason: 'degraded_budget' });
  assert.equal(Object.hasOwn(h.store.read().offlineOpportunityOffers ?? {}, 'budget-denied'), false);
  assert.equal(h.store.read().todayBrowses, 3);
  h.store.update((s) => ({ ...s, todayBrowses: 0 }));
  const allowed = adaptQzoneOfflineOpportunity(h.store, { id: 'budget-allowed', now: NOW });
  assert.equal(allowed.allowed, true);
  assert.equal(h.store.read().todayBrowses, 0, '展示机会不能消耗浏览额度');
});

test('拒绝非法机会 ID/时间且不写状态', async (t) => {
  const h = await harness(t);
  for (const id of ['', 'has space', '../x', '__proto__', 'x'.repeat(129), 3, null]) {
    assert.throws(() => adaptQzoneOfflineOpportunity(h.store, { id, now: NOW }), TypeError);
  }
  for (const now of [NaN, Infinity, '2026-11-08']) {
    assert.throws(() => adaptQzoneOfflineOpportunity(h.store, { id: 'valid-id', now }), TypeError);
  }
  assert.deepEqual(h.store.read().offlineOpportunityOffers ?? {}, {});
  assert.deepEqual(h.store.read().readAttempts, {});
});

test('适配器不创建定时器、不调用模型或网络，并声明不覆盖跨进程 dispatch 临界区', async (t) => {
  const h = await harness(t);
  assert.equal(adaptQzoneOfflineOpportunity(h.store, { id: 'local-only', now: NOW }).allowed, true);
  assert.deepEqual(QZONE_OPPORTUNITY_OFFLINE_BOUNDARY, {
    timers: false, modelCalls: false, networkCalls: false, crossProcessDispatchLock: false,
  });
});
