// 阶段 2C 桥接侧最小接线：owner 通知接线必须在**主启动路径**装配，而不是挂在后台巡逻分支里。
// 这里用 bridge harness 起真实 bridge（临时目录、假 bot），只读断言装配结果，不发任何 QQ 消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { bridgeHarness } from './audit-bridge-harness.mjs';

async function statusOf(harness) {
  const fn = harness.context.__ownerNoticeWiringStatus;
  assert.equal(typeof fn, 'function', 'bridge 必须暴露 __ownerNoticeWiringStatus 接缝');
  return harness.context.__ownerNoticeWiringStatus();
}

test('owner 通知接线在主启动路径装配：即使 backgroundPatrol 关闭也必须启动（解耦）', async () => {
  const h = await bridgeHarness({
    config: {
      backgroundPatrol: { enabled: false },
      ownerNotice: { enabled: true, intervalMs: 60_000 },
    },
  });
  try {
    const status = await statusOf(h);
    assert.equal(status.started, true, `必须已启动，实际 ${JSON.stringify(status)}`);
    assert.equal(status.reason, null);
  } finally {
    await h.close();
  }
});

test('默认禁用：没有 ownerNotice 配置时不启动，且原因是 disabled（不静默假装启动）', async () => {
  const h = await bridgeHarness({ config: { backgroundPatrol: { enabled: false } } });
  try {
    const status = await statusOf(h);
    assert.equal(status.started, false);
    assert.equal(status.reason, 'disabled');
  } finally {
    await h.close();
  }
});

test('显式 enabled:false 同样不启动（fail-closed）', async () => {
  const h = await bridgeHarness({
    config: { backgroundPatrol: { enabled: false }, ownerNotice: { enabled: false } },
  });
  try {
    const status = await statusOf(h);
    assert.equal(status.started, false);
    assert.equal(status.reason, 'disabled');
  } finally {
    await h.close();
  }
});

test('非法 intervalMs 回退到默认 60s 而不是拒绝启动（配置容错，日志可查）', async () => {
  const h = await bridgeHarness({
    config: { backgroundPatrol: { enabled: false }, ownerNotice: { enabled: true, intervalMs: 500 } },
  });
  try {
    const status = await statusOf(h);
    assert.equal(status.started, true, `实际 ${JSON.stringify(status)}`);
  } finally {
    await h.close();
  }
});

test('显式 inboxDir 被接受（接线不强制使用 state 目录默认值）', async () => {
  const inboxDir = path.join(process.cwd(), 'tests', 'evidence-task46');
  const h = await bridgeHarness({
    config: { backgroundPatrol: { enabled: false }, ownerNotice: { enabled: true, inboxDir } },
  });
  try {
    const status = await statusOf(h);
    assert.equal(status.started, true, `实际 ${JSON.stringify(status)}`);
  } finally {
    await h.close();
  }
});