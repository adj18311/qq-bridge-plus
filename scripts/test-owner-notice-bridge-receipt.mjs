// 阶段 2C：桥接侧「送达回执」与「关停顺序」的行为级测试（Codex 复核要求）。
//  1) message_id 必须是正整数：'' / '0' / -1 / {} / 'abc' 等异常回执一律 unknown，不得当 delivered；
//  2) 超时只说明等不到回执、不证明没发出去 ⇒ unknown（15 分钟后重试，可能重复），不得记 failed/delivered；
//  3) 关停必须**等在途发送结束**再退出：用行为断言（真实 shutdownBridge + process.exit 记录），不是静态读文本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { bridgeHarness } from './audit-bridge-harness.mjs';

const DISABLED = { backgroundPatrol: { enabled: false }, ownerNotice: { enabled: false } };

async function withHarness(options, fn) {
  const h = await bridgeHarness(options);
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

test('送达判定：只认正整数 message_id，异常回执一律 unknown', async () => {
  await withHarness({ config: DISABLED }, async (h) => {
    const cases = [
      { id: 123, want: 'delivered', messageId: '123' },
      { id: '123', want: 'delivered', messageId: '123' },
      { id: '0123', want: 'delivered', messageId: '123' },
      { id: 0, want: 'unknown' },
      { id: '0', want: 'unknown' },
      { id: '00', want: 'unknown' },
      { id: '', want: 'unknown' },
      { id: '   ', want: 'unknown' },
      // 首尾空白被 trim 后仍按数值判定（不产生假 delivered，但不能悄悄放宽成「任意字符串」）
      { id: ' 123 ', want: 'delivered', messageId: '123' },
      { id: '	123', want: 'delivered', messageId: '123' },
      { id: ' 0 ', want: 'unknown' },
      { id: ' 12 3 ', want: 'unknown' },
      // 真实 QQ 私聊会返回负 message_id（本机实测样本），必须算送达而不是 unknown。
      { id: -1, want: 'delivered', messageId: '-1' },
      { id: '-123', want: 'delivered', messageId: '-123' },
      { id: -1529327303, want: 'delivered', messageId: '-1529327303' },
      { id: 'abc', want: 'unknown' },
      { id: {}, want: 'unknown' },
      { id: [123], want: 'unknown' },
      { id: true, want: 'unknown' },
      { id: 9007199254740993, want: 'unknown' },
      { id: Number.NaN, want: 'unknown' },
      { id: 1.5, want: 'unknown' },
    ];
    for (const item of cases) {
      h.bot.sendPrivateMessage = async () => ({ message_id: item.id });
      const result = await h.sendOwnerPrivateWithReceipt('回执判定');
      assert.equal(
        result.outcome,
        item.want,
        `message_id=${JSON.stringify(item.id)} 应为 ${item.want}，实际 ${JSON.stringify(result)}`,
      );
      if (item.want === 'delivered') assert.equal(result.messageId, item.messageId);
      else assert.equal(result.messageId, undefined, `unknown 不得携带 messageId：${JSON.stringify(result)}`);
    }
  });
});

test('data.message_id / messageId 两种回执形状都能识别（非零整数才认，正负都算）', async () => {
  await withHarness({ config: DISABLED }, async (h) => {
    h.bot.sendPrivateMessage = async () => ({ data: { message_id: 456 } });
    const viaData = await h.sendOwnerPrivateWithReceipt('a');
    assert.equal(viaData.outcome, 'delivered');
    assert.equal(viaData.code, null);
    assert.equal(viaData.messageId, '456');

    h.bot.sendPrivateMessage = async () => ({ messageId: '789' });
    const viaCamel = await h.sendOwnerPrivateWithReceipt('b');
    assert.equal(viaCamel.outcome, 'delivered');
    assert.equal(viaCamel.messageId, '789');

    h.bot.sendPrivateMessage = async () => ({ data: { message_id: 'x' } });
    assert.equal((await h.sendOwnerPrivateWithReceipt('c')).outcome, 'unknown');
  });
});

test('超时记为 unknown（不是 failed、不是 delivered），底层迟到成功不得被当成送达', async () => {
  await withHarness(
    { config: DISABLED, globals: { __testSendTimeoutMs: 40 } },
    async (h) => {
      let release;
      const late = new Promise((resolve) => { release = resolve; });
      h.bot.sendPrivateMessage = () => late;

      const timedOut = await h.sendOwnerPrivateWithReceipt('超时');
      assert.equal(timedOut.outcome, 'unknown', `超时必须 unknown，实际 ${JSON.stringify(timedOut)}`);
      assert.equal(timedOut.code, 'timeout');
      assert.equal(timedOut.messageId, undefined);

      // 迟到成功：底层 promise 才 resolve —— 这次结果已被丢弃，不得回头把上面的 unknown 改成 delivered。
      release({ message_id: 321 });
      await late;
      await new Promise((resolve) => setImmediate(resolve));

      // 下一次发送是独立的一次；不复用上一次的结论。
      h.bot.sendPrivateMessage = async () => ({ message_id: 654 });
      const next = await h.sendOwnerPrivateWithReceipt('重试');
      assert.equal(next.outcome, 'delivered');
      assert.equal(next.code, null);
      assert.equal(next.messageId, '654');
    },
  );
});

test('发送异常仍记 failed（与超时区分开），且不带 messageId', async () => {
  await withHarness({ config: DISABLED }, async (h) => {
    h.bot.sendPrivateMessage = async () => { throw Object.assign(new Error('网关拒绝'), { retcode: 100 }); };
    const result = await h.sendOwnerPrivateWithReceipt('失败');
    assert.equal(result.outcome, 'failed');
    assert.equal(result.code, '100');
    assert.equal(result.messageId, undefined);
  });
});

test('关停顺序：shutdownBridge 必须等在途发送结束（stop 之后）才 exit(0)', async () => {
  const events = [];
  let releaseSend;
  const inboxEntry = {
    schemaVersion: 1,
    noticeId: 'aaaaaaaa-1111-2222-3333-444444444444',
    kind: 'tool-surface-missing',
    missingCount: 12,
    consecutiveMisses: 3,
    lastSeenAt: Date.now() - 10_000,
    createdAt: Date.now() - 10_000,
    platform: 'dsh',
  };
  // 临时目录里的 inbox 由 harness 的 temp 提供；用 harness 自己的 state 目录下的 owner-notice-inbox。
  const h = await bridgeHarness({
    config: {
      backgroundPatrol: { enabled: false },
      ownerNotice: { enabled: true, intervalMs: 60_000 },
    },
    globals: {
      process: {
        pid: process.pid,
        platform: process.platform,
        kill: process.kill,
        env: {},
        exit: (code) => { events.push(`exit:${code}`); },
      },
    },
  });
  try {
    const status = await h.context.__ownerNoticeWiringStatus();
    assert.equal(status.started, true, `接线必须已启动：${JSON.stringify(status)}`);
    // 接线默认把收件箱放在 STATE_DIR 下；harness 的 STATE_DIR 在 temp 里，直接推导（status 不暴露路径）。
    const inboxDir = path.join(h.temp, 'state', 'owner-notice-inbox');

    h.bot.sendPrivateMessage = () => new Promise((resolve) => {
      events.push('send-entered');
      releaseSend = resolve;
    });

    fs.mkdirSync(inboxDir, { recursive: true });
    const entryPath = path.join(inboxDir, `${inboxEntry.noticeId}.json`);
    fs.writeFileSync(entryPath, JSON.stringify(inboxEntry), 'utf8');
    // 真实接线有 2s 最小年龄闸：把 mtime 调到 5 秒前，避免测试依赖 sleep。
    const old = (Date.now() - 5_000) / 1000;
    fs.utimesSync(entryPath, old, old);

    assert.equal(typeof h.context.__ownerNoticeRunOnce, 'function', '必须暴露 __ownerNoticeRunOnce 接缝');
    const runPromise = h.context.__ownerNoticeRunOnce();
    // 等发送真正进入（确定性信号，不依赖睡眠）。
    await new Promise((resolve) => {
      const check = () => (releaseSend === undefined ? setTimeout(check, 1) : resolve());
      check();
    });

    const shutdownPromise = h.shutdownBridge('TEST');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['send-entered'], `在途发送未结束时不得 exit，实际 ${JSON.stringify(events)}`);

    releaseSend({ message_id: 777 });
    await runPromise;
    await shutdownPromise;
    assert.deepEqual(events, ['send-entered', 'exit:0'], `必须先完成在途发送再 exit，实际 ${JSON.stringify(events)}`);
  } finally {
    await h.close();
  }
});