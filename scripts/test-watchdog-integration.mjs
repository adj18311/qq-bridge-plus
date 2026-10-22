// Actual bridge scan against temporary peers; no real waiting or production state access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { busyHarness } from './busy-watchdog-harness.mjs';

const key = 'private:123';
const base = 100000;
async function withBusy(overrides, run) {
  const h = await busyHarness({ config: { socialV2: { enabled: true, busyWatchdog: {
    warnMs: 3000, releaseMs: 9000, hardCapMs: 18000, checkIntervalMs: 1000,
    rearmCooldownMs: 60000, maxRearmPerHour: 3, silenceProbeMs: 0, ...overrides,
  } } } });
  h.setMode('reserved2');
  h.socialV2.paused = false;
  const st = h.getSocialV2State(key);
  h.pendingWakeKeys.add(key);
  h.busyWatchdog.startedAt = base;
  h.busyWatchdog.busySinceV2.set(key, base);
  h.busyWatchdog.lastFrameAtV2.set(key, base);
  try { await run(h, st); } finally { await h.close(); }
}

test('实际扫描：WARN 精确边界只记日志，不释放、不发消息，重复扫描只记一次', () => withBusy({}, h => {
  h.runBusyWatchdogScanV2(base + 2999);
  assert.equal(h.readLog().includes('[watchdog] warn'), false);
  h.runBusyWatchdogScanV2(base + 3000);
  h.runBusyWatchdogScanV2(base + 3001);
  assert.equal((h.readLog().match(/\[watchdog\] warn key=private:123/g) ?? []).length, 1);
  assert.match(h.readLog(), /warn key=private:123 busy=3s idle=3s/);
  assert.equal(h.pendingWakeKeys.has(key), true);
  assert.equal(h.readLog().includes('[watchdog] release'), false);
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.calls.prompts.length, 0);
}));

test('实际扫描：budget 与 hardcap 同时满足，仍以 release 档优先', () => withBusy({ hardCapMs: 9000 }, h => {
  h.runBusyWatchdogScanV2(base + 9000);
  assert.match(h.readLog(), /release key=private:123 busy=9s idle=9s tier=release /);
  assert.equal(h.pendingWakeKeys.has(key), false);
  assert.equal(h.calls.prompts.length, 0, '无 backlog 不能凭空重排或发送');
}));

test('实际扫描：hardcap 仍要求零帧达到 warn 窗口，不足 release 预算时可选 hardcap', () => withBusy({}, h => {
  h.busyWatchdog.lastFrameAtV2.set(key, base + 17000);
  h.runBusyWatchdogScanV2(base + 19999);
  assert.equal(h.pendingWakeKeys.has(key), true);
  h.runBusyWatchdogScanV2(base + 20000);
  assert.match(h.readLog(), /busy=20s idle=3s tier=hardcap /);
  assert.equal(h.pendingWakeKeys.has(key), false);
}));

test('实际扫描：持续有帧的长回合超过 hardcap 仍不被释放', () => withBusy({}, h => {
  h.busyWatchdog.lastFrameAtV2.set(key, base + 60000 - 2999);
  h.runBusyWatchdogScanV2(base + 60000);
  assert.equal(h.pendingWakeKeys.has(key), true);
  assert.equal(h.readLog().includes('[watchdog] release'), false);
  assert.equal(h.readLog().includes('[watchdog] warn'), false);
}));

test('实际扫描：warnMs=0 禁用警告，hardcap 静默门槛回到 releaseMs', () => withBusy({ warnMs: 0 }, h => {
  h.busyWatchdog.lastFrameAtV2.set(key, base + 11000);
  h.runBusyWatchdogScanV2(base + 19999);
  assert.equal(h.pendingWakeKeys.has(key), true);
  assert.equal(h.readLog().includes('[watchdog] warn'), false);
  h.runBusyWatchdogScanV2(base + 20000);
  assert.match(h.readLog(), /idle=9s tier=release /);
  assert.equal(h.pendingWakeKeys.has(key), false);
}));

test('实际扫描：未来开始/帧时间的负时长夹到0，不提前告警或释放', () => withBusy({}, h => {
  h.runBusyWatchdogScanV2(base - 1);
  assert.equal(h.pendingWakeKeys.has(key), true);
  assert.equal(h.readLog().includes('[watchdog] warn'), false);
  h.busyWatchdog.lastFrameAtV2.set(key, base + 50000);
  h.runBusyWatchdogScanV2(base + 20000);
  assert.equal(h.pendingWakeKeys.has(key), true);
  assert.equal(h.readLog().includes('[watchdog] release'), false);
}));

test('实际扫描：忙→闲边沿仍清episode，下一轮卡忙会重新写WARN', () => withBusy({}, h => {
  h.runBusyWatchdogScanV2(base + 3000);
  h.pendingWakeKeys.delete(key);
  h.runBusyWatchdogScanV2(base + 4000);
  assert.equal(h.busyWatchdog.busySinceV2.has(key), false);
  assert.equal(h.busyWatchdog.warnedTiersV2.has(key), false);
  h.pendingWakeKeys.add(key);
  h.runBusyWatchdogScanV2(base + 5000);
  h.runBusyWatchdogScanV2(base + 8000);
  assert.equal((h.readLog().match(/\[watchdog\] warn key=private:123/g) ?? []).length, 2);
  assert.equal(h.pendingWakeKeys.has(key), true);
}));

// ── 支撑规则（配置归一化 + re-arm 速率）的真实桥接边界 ───────────────────────────

/** 造一次可释放且带可补发 backlog 的卡忙，供 re-arm 速率测试使用。 */
function seedRearmBacklog(h, at, k = key) {
  const st = h.getSocialV2State(k);
  h.pendingWakeKeys.add(k);
  h.busyWatchdog.busySinceV2.set(k, at - 9000);
  h.busyWatchdog.lastFrameAtV2.set(k, at - 9000);
  st.pendingWakeReasons = [{ reason: 'private', seq: 10 }];
  st.unread = [{ seq: 10 }];
  return st;
}

const CONFIG_KEYS = 'enabled,warnMs,releaseMs,hardCapMs,checkIntervalMs,rearmCooldownMs,maxRearmPerHour';

test('实际扫描：看门狗配置热读取，固定七键顺序并按旧语义归一化', () => withBusy({}, h => {
  assert.equal(Object.keys(h.busyWatchdogConfig()).join(','), CONFIG_KEYS);
  const configJson = () => JSON.stringify(h.busyWatchdogConfig());
  assert.equal(configJson(), JSON.stringify({
    enabled: true, warnMs: 3000, releaseMs: 9000, hardCapMs: 18000,
    checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 3,
  }));

  h.cfg.socialV2.busyWatchdog = {
    enabled: false, warnMs: null, releaseMs: 0, hardCapMs: -1,
    checkIntervalMs: 500, rearmCooldownMs: '', maxRearmPerHour: '2.5',
  };
  assert.equal(configJson(), JSON.stringify({
    enabled: false, warnMs: 300000, releaseMs: 900000, hardCapMs: 1800000,
    checkIntervalMs: 1000, rearmCooldownMs: 60000, maxRearmPerHour: 2.5,
  }));

  const defaults = JSON.stringify({
    enabled: true, warnMs: 300000, releaseMs: 900000, hardCapMs: 1800000,
    checkIntervalMs: 10000, rearmCooldownMs: 60000, maxRearmPerHour: 3,
  });
  h.cfg.socialV2.busyWatchdog = null;
  assert.equal(configJson(), defaults);
  h.cfg.socialV2.busyWatchdog = 'not-an-object';
  assert.equal(configJson(), defaults);
  h.cfg.socialV2.busyWatchdog = [];
  assert.equal(configJson(), defaults);

  h.cfg.socialV2.busyWatchdog = {
    releaseMs: '12000', hardCapMs: true, warnMs: '2500',
    checkIntervalMs: 1.9, rearmCooldownMs: 0, maxRearmPerHour: '1.5',
  };
  assert.equal(configJson(), JSON.stringify({
    enabled: true, warnMs: 2500, releaseMs: 12000, hardCapMs: 1,
    checkIntervalMs: 1000, rearmCooldownMs: 0, maxRearmPerHour: 1.5,
  }));
}));

test('实际扫描：re-arm cooldown 未到拒绝且不改记录，边界差允许', async () => {
  await withBusy({ rearmCooldownMs: 9001 }, h => {
    seedRearmBacklog(h, base + 9000);
    h.runBusyWatchdogScanV2(base + 9000);
    const before = h.busyWatchdog.rearmV2.get(key);
    assert.equal(JSON.stringify(before), JSON.stringify([base + 9000]));

    seedRearmBacklog(h, base + 18000);
    h.runBusyWatchdogScanV2(base + 18000);
    assert.strictEqual(h.busyWatchdog.rearmV2.get(key), before, '拒绝时不得替换/修改记录数组');
    assert.equal(JSON.stringify(h.busyWatchdog.rearmV2.get(key)), JSON.stringify([base + 9000]));
    assert.match(h.readLog(), /release key=private:123 .* rearm=none/);
  });

  await withBusy({ rearmCooldownMs: 9000 }, h => {
    seedRearmBacklog(h, base + 9000);
    h.runBusyWatchdogScanV2(base + 9000);
    seedRearmBacklog(h, base + 18000);
    h.runBusyWatchdogScanV2(base + 18000);
    assert.equal(JSON.stringify(h.busyWatchdog.rearmV2.get(key)), JSON.stringify([base + 9000, base + 18000]), '恰好等于 cooldown 时允许');
  });
});

test('实际扫描：每小时上限严格小于 3600000，边界外记录被裁剪', async () => {
  await withBusy({ rearmCooldownMs: 0, maxRearmPerHour: 1 }, h => {
    const at = base + 9000;
    const seeded = [at - 3_599_999];
    h.busyWatchdog.rearmV2.set(key, seeded);
    seedRearmBacklog(h, at);
    h.runBusyWatchdogScanV2(at);
    assert.strictEqual(h.busyWatchdog.rearmV2.get(key), seeded, '窗口内已满时不得改写记录');
    assert.equal(JSON.stringify(h.busyWatchdog.rearmV2.get(key)), JSON.stringify([at - 3_599_999]));
  });

  await withBusy({ rearmCooldownMs: 0, maxRearmPerHour: 1 }, h => {
    const at = base + 9000;
    h.busyWatchdog.rearmV2.set(key, [at - 3_600_000]);
    seedRearmBacklog(h, at);
    h.runBusyWatchdogScanV2(at);
    assert.equal(JSON.stringify(h.busyWatchdog.rearmV2.get(key)), JSON.stringify([at]), '恰好一小时前不算窗口内，随后被裁剪');
  });
});

test('实际扫描：re-arm 记录按 key 隔离，一个 key 被拒不影响另一个', () => withBusy({ rearmCooldownMs: 0, maxRearmPerHour: 1 }, h => {
  const at = base + 9000;
  const groupKey = 'group:456';
  h.busyWatchdog.rearmV2.set(key, [at - 1]);
  seedRearmBacklog(h, at, key);
  seedRearmBacklog(h, at, groupKey);
  h.runBusyWatchdogScanV2(at);
  assert.equal(JSON.stringify(h.busyWatchdog.rearmV2.get(key)), JSON.stringify([at - 1]), 'private key 仍被每小时上限拒绝');
  assert.equal(JSON.stringify(h.busyWatchdog.rearmV2.get(groupKey)), JSON.stringify([at]), 'group key 独立获得一次 re-arm');
}));
