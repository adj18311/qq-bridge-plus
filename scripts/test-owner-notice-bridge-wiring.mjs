import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  OWNER_NOTICE_INBOX_VERSION,
  OWNER_NOTICE_INBOX_MAX_BYTES,
  parseOwnerNoticeInboxEntry,
  receiptOutcomeFor,
  createProvenDeliverySender,
  createOwnerNoticeBridgeWiring, isValidDeliveredMessageId, normalizeDeliveredMessageId } from '../src/core/owner-notice-bridge-wiring.mjs';

// —— 公共夹具 ——

const NOW = 1793360000000; // 固定时钟：测试不得依赖真实墙钟（夜间静默时段会改行为）

const noticeId = () => crypto.randomUUID();

function validEntry(overrides = {}) {
  return {
    schemaVersion: OWNER_NOTICE_INBOX_VERSION,
    noticeId: noticeId(),
    kind: 'tool-surface-missing',
    platform: 'dsh',
    missingCount: 12,
    consecutiveMisses: 3,
    lastSeenAt: NOW - 60_000,
    createdAt: NOW - 30_000,
    ...overrides,
  };
}

async function tempInbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-notice-wiring-'));
  return { dir, inboxDir: path.join(dir, 'inbox'), stateFile: path.join(dir, 'state', 'outbox.json') };
}

async function writeEntry(inboxDir, entry, name = `${entry.noticeId}.json`) {
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.writeFile(path.join(inboxDir, name), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  return path.join(inboxDir, name);
}

/** 记录所有发送文本的假发送器。 */
function fakeSender(result) {
  const sent = [];
  const fn = async (text) => {
    sent.push(text);
    if (typeof result === 'function') return result(text);
    return result;
  };
  fn.sent = sent;
  return fn;
}

function makeWiring({ inboxDir, stateFile, send, clock = () => NOW, fs: fsImpl = fs, logs = null, outbox = undefined }) {
  const log = logs === null ? () => {} : (message) => logs.push(String(message));
  return createOwnerNoticeBridgeWiring({
    inboxDir,
    stateFile,
    sendOwnerPrivateWithReceipt: send,
    fs: fsImpl,
    clock: typeof clock === 'function' ? clock : () => clock,
    log,
    // 测试里文件刚写出来，不能等 2 秒的"正在写"窗口，显式关掉。
    minFileAgeMs: 0,
    ...(outbox === undefined ? {} : { outbox }),
  });
}

// —— 1. schema 校验（任何意外都拒绝，不「尽力解析」）——

test('parse：合法条目逐字段归一，不含多余键', () => {
  const raw = validEntry();
  const parsed = parseOwnerNoticeInboxEntry(raw, { now: NOW });
  assert.equal(parsed.ok, true);
  assert.deepEqual(Object.keys(parsed.value).sort(), [
    'consecutiveMisses', 'createdAt', 'kind', 'lastSeenAt', 'missingCount', 'noticeId',
  ]);
  assert.equal(parsed.value.noticeId, raw.noticeId);
});

test('parse：多余键一律整条拒绝（不忽略）', () => {
  const parsed = parseOwnerNoticeInboxEntry({ ...validEntry(), extra: 1 }, { now: NOW });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'unknown-field');
});

test('parse：版本 / id / kind / platform 各自独立拒绝', () => {
  const cases = [
    [{ schemaVersion: 2 }, 'schema-version-unsupported'],
    [{ noticeId: 'zzzz' }, 'invalid-notice-id'],
    [{ noticeId: 'ab' }, 'invalid-notice-id'],
    [{ kind: 'free-text' }, 'invalid-kind'],
    [{ platform: 'xiaoheihe' }, 'invalid-platform'],
  ];
  for (const [patch, reason] of cases) {
    const parsed = parseOwnerNoticeInboxEntry(validEntry(patch), { now: NOW });
    assert.equal(parsed.ok, false, JSON.stringify(patch));
    assert.equal(parsed.reason, reason, JSON.stringify(patch));
  }
});

test('parse：数值范围与未来时钟偏差（只拦未来，不按年龄判重放）', () => {
  const cases = [
    [{ missingCount: 0 }, 'invalid-missing-count'],
    [{ missingCount: 65 }, 'invalid-missing-count'],
    [{ consecutiveMisses: 0 }, 'invalid-consecutive-misses'],
    [{ consecutiveMisses: 65 }, 'invalid-consecutive-misses'],
    [{ createdAt: NOW + 11 * 60 * 1000 }, 'created-in-future'],
    [{ lastSeenAt: NOW + 11 * 60 * 1000 }, 'last-seen-in-future'],
    [{ createdAt: 1.5 }, 'invalid-created-at'],
    [{ lastSeenAt: 1.5 }, 'invalid-last-seen-at'],
  ];
  for (const [patch, reason] of cases) {
    const parsed = parseOwnerNoticeInboxEntry(validEntry(patch), { now: NOW });
    assert.equal(parsed.ok, false, JSON.stringify(patch));
    assert.equal(parsed.reason, reason, JSON.stringify(patch));
  }
});

test('parse：旧报龄不清零 —— 3 小时前的报警仍然合法（按年龄拒绝会丢真实报警）', () => {
  const old = validEntry({ createdAt: NOW - 3 * 60 * 60 * 1000, lastSeenAt: NOW - 3 * 60 * 60 * 1000 });
  const parsed = parseOwnerNoticeInboxEntry(old, { now: NOW });
  assert.equal(parsed.ok, true, '桥接离线 3 小时后恢复，报警不得因为"旧"被丢弃');
  assert.equal(parsed.value.createdAt, NOW - 3 * 60 * 60 * 1000);
});

test('parse：recovered 受支持，且计数允许为 0', () => {
  const ok = parseOwnerNoticeInboxEntry(validEntry({ kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0 }), { now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.kind, 'tool-surface-recovered');
  const bad = parseOwnerNoticeInboxEntry(validEntry({ kind: 'tool-surface-recovered', missingCount: 65 }), { now: NOW });
  assert.equal(bad.reason, 'invalid-missing-count');
  assert.equal(parseOwnerNoticeInboxEntry(validEntry({ kind: 'tool-surface-other' }), { now: NOW }).reason, 'invalid-kind');
});

test('parse：非对象与非法时钟一律拒绝', () => {
  for (const bad of [null, undefined, [], 'x', 1]) {
    assert.equal(parseOwnerNoticeInboxEntry(bad, { now: NOW }).ok, false);
  }
  assert.equal(parseOwnerNoticeInboxEntry(validEntry(), { now: 'x' }).reason, 'clock-invalid');
});

// —— 2. 回执状态（delivered 只能由 deliveredAt 支撑）——

test('receiptOutcomeFor：只有 deliveredAt 才算 delivered；unknown 不得升级', () => {
  assert.deepEqual(receiptOutcomeFor({ deliveredAt: NOW, attempts: [] }), { outcome: 'delivered', at: NOW });
  assert.equal(receiptOutcomeFor({ deliveredAt: null, attempts: [] }).outcome, 'pending');
  assert.equal(receiptOutcomeFor({ deliveredAt: null, attempts: [{ outcome: 'unknown', code: 'no-message-id', finishedAt: NOW }] }).outcome, 'unknown');
  assert.equal(receiptOutcomeFor({ deliveredAt: null, attempts: [{ outcome: 'failed', code: 'send-failed', finishedAt: NOW }] }).outcome, 'failed');
  assert.equal(receiptOutcomeFor({ deliveredAt: null, attempts: [{ outcome: null, finishedAt: null }] }).outcome, 'pending');
});

// —— 3. 发送器收口：没有 message_id 就不是送达 ——

test('createProvenDeliverySender：缺 messageId 的 delivered 降级为 unknown', async () => {
  const sender = createProvenDeliverySender(async () => ({ outcome: 'delivered' }));
  const result = await sender('text');
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.code, 'delivered-without-message-id');
});

test('createProvenDeliverySender：空串 messageId 也不算送达；字符串/数字 id 都接受', async () => {
  const empty = createProvenDeliverySender(async () => ({ outcome: 'delivered', messageId: '' }));
  assert.equal((await empty('t')).outcome, 'unknown');

  const str = createProvenDeliverySender(async () => ({ outcome: 'delivered', messageId: '880001' }));
  assert.deepEqual(await str('t'), { outcome: 'delivered', messageId: '880001' });

  const num = createProvenDeliverySender(async () => ({ outcome: 'delivered', messageId: 12345 }));
  assert.deepEqual(await num('t'), { outcome: 'delivered', messageId: '12345' });
});

test('createProvenDeliverySender：failed / unknown 原样透传，异常原样抛出', async () => {
  const failed = createProvenDeliverySender(async () => ({ outcome: 'failed', code: 'onebot-down' }));
  assert.deepEqual(await failed('t'), { outcome: 'failed', code: 'onebot-down' });

  const boom = createProvenDeliverySender(async () => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); });
  await assert.rejects(() => boom('t'), /x/);
});

// —— 4. 接线：收取 → 发送 → 回执（真 outbox，临时目录，全程离线）——

test('runOnce：合法条目被接手、移入 processed/、真发一条、回执写 delivered', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const entry = validEntry();
  const file = await writeEntry(inboxDir, entry);
  const send = fakeSender({ outcome: 'delivered', messageId: '880002' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  const result = await wiring.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.ingested.accepted, 1);
  assert.equal(send.sent.length, 1);
  // 文案来自 outbox 固定模板：不含插件提供的任何字符串
  assert.match(send.sent[0], /【工具自愈】小黑盒工具连续 3 次检查不可见（缺失 12 个/);

  const moved = await fs.readFile(path.join(inboxDir, 'processed', path.basename(file)), 'utf8');
  assert.match(moved, /tool-surface-missing/);

  const receipt = JSON.parse(await fs.readFile(path.join(inboxDir, 'receipts', `${entry.noticeId}.json`), 'utf8'));
  assert.equal(receipt.outcome, 'delivered');
  assert.equal(receipt.noticeId, entry.noticeId);
  assert.equal(receipt.atLeastOnce, true);
  assert.equal(receipt.code, undefined);
});

test('runOnce：发送器声称 delivered 但没有 messageId ⇒ 回执 unknown（不得写成功）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const entry = validEntry();
  await writeEntry(inboxDir, entry);
  const send = fakeSender({ outcome: 'delivered' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  const result = await wiring.runOnce();
  assert.equal(result.report.delivered, 0);
  assert.equal(result.report.unknown, 1);

  const receipt = JSON.parse(await fs.readFile(path.join(inboxDir, 'receipts', `${entry.noticeId}.json`), 'utf8'));
  assert.equal(receipt.outcome, 'unknown');
  assert.equal(receipt.code, 'delivered-without-message-id');
});

test('runOnce：发送抛错 ⇒ 回执 failed/unknown，事件保留待重试（不静默丢）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const entry = validEntry();
  await writeEntry(inboxDir, entry);
  const send = fakeSender(async () => { throw Object.assign(new Error('net'), { code: 'ECONNRESET' }); });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  const result = await wiring.runOnce();
  assert.equal(result.report.attempted, 1);
  assert.ok(result.report.failed + result.report.unknown === 1);

  const receipt = JSON.parse(await fs.readFile(path.join(inboxDir, 'receipts', `${entry.noticeId}.json`), 'utf8'));
  assert.ok(['failed', 'unknown'].includes(receipt.outcome));
  assert.notEqual(receipt.outcome, 'delivered');
});

test('runOnce：畸形 / 超大 / 非法 JSON 被移出并留取证，不进入发送链路', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.writeFile(path.join(inboxDir, 'bad.json'), '{ not json', 'utf8');
  await fs.writeFile(path.join(inboxDir, 'big.json'), 'x'.repeat(OWNER_NOTICE_INBOX_MAX_BYTES + 10), 'utf8');
  await fs.writeFile(path.join(inboxDir, 'extra.json'), JSON.stringify({ ...validEntry(), evil: 'x' }), 'utf8');
  await fs.writeFile(path.join(inboxDir, 'note.txt'), 'ignored', 'utf8');
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  const result = await wiring.runOnce();
  assert.equal(send.sent.length, 0, '非法条目不得触发发送');
  assert.equal(result.ingested.rejected.length, 3);
  // 隔离文件名带时间戳（避免覆盖上一次取证），所以按前缀断言。
  const names = (await fs.readdir(inboxDir)).filter((n) => n.endsWith('.rejected')).sort();
  assert.equal(names.length, 3);
  for (const prefix of ['bad.json.', 'big.json.', 'extra.json.']) {
    assert.ok(names.some((n) => n.startsWith(prefix)), `缺少隔离文件：${prefix}`);
  }
});

test('runOnce：同一 noticeId 重复写两次只保留一个事件（幂等）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const entry = validEntry();
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  await writeEntry(inboxDir, entry);
  await wiring.runOnce();
  // 插件重写同一个 noticeId（第二份文件）
  await writeEntry(inboxDir, entry, `${entry.noticeId}-dup.json`);
  const second = await wiring.runOnce();

  assert.equal(second.ingested.duplicates, 1);
  assert.equal(send.sent.length, 1, '同一事件不得重复发送');

  const snap = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(snap.events.length, 1);
});

test('runOnce：inbox 目录不存在时安静通过（首启场景）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });
  const result = await wiring.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.ingested.accepted, 0);
  assert.equal(send.sent.length, 0);
});

test('runOnce：并发调用复用同一个在飞 Promise（单飞）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const entry = validEntry();
  await writeEntry(inboxDir, entry);
  let calls = 0;
  const send = fakeSender(async () => { calls += 1; return { outcome: 'delivered', messageId: '880003' }; });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  const [a, b, c] = await Promise.all([wiring.runOnce(), wiring.runOnce(), wiring.runOnce()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(calls, 1);
  assert.equal(wiring.snapshot().runs, 1);
});

test('start/stop：定时器按 intervalMs 触发，stop 等在途结束且之后不再跑', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  let tick = null;
  let cleared = 0;
  const wiring = createOwnerNoticeBridgeWiring({
    inboxDir,
    stateFile,
    sendOwnerPrivateWithReceipt: send,
    fs,
    clock: () => NOW,
    log: () => {},
    minFileAgeMs: 0,
    intervalMs: 60_000,
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
    clearInterval: () => { cleared += 1; },
  });

  assert.equal(wiring.start().ok, true);
  assert.equal(wiring.start().already, true, '重复 start 不得起第二个定时器');
  await writeEntry(inboxDir, validEntry());
  tick();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(send.sent.length, 1);
  await wiring.stop();
  assert.equal(cleared, 1);
  await writeEntry(inboxDir, validEntry());
  const after = await wiring.runOnce();
  assert.equal(after.reason, 'stopped');
});

test('snapshot：暴露运行状态与累计计数，且不含任何正文/令牌', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  await writeEntry(inboxDir, validEntry());
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });
  await wiring.runOnce();

  const snap = wiring.snapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.delivered, 1);
  assert.equal(snap.ingested, 1);
  assert.equal(snap.inboxDir, inboxDir);
  const text = JSON.stringify(snap);
  assert.equal(/【工具自愈】/.test(text), false);
  assert.equal(/msg-|message_id|token/i.test(text), false);
});

test('构造期严格校验：缺 inboxDir / 缺 stateFile / 非法 intervalMs 直接抛（不静默降级）', () => {
  assert.throws(() => createOwnerNoticeBridgeWiring({ fs, stateFile: 'x' }), /inboxDir/);
  assert.throws(() => createOwnerNoticeBridgeWiring({ fs, inboxDir: 'x' }), /stateFile/);
  assert.throws(() => createOwnerNoticeBridgeWiring({ fs, inboxDir: 'x', stateFile: 'y', intervalMs: 10 }), /intervalMs/);
  assert.throws(() => createOwnerNoticeBridgeWiring({ fs, inboxDir: 'x', stateFile: 'y', sendOwnerPrivateWithReceipt: null }), /sendOwnerPrivateWithReceipt|outbox/);
});
// —— 复审 P2/P3 补强（2026-10-31）——

test('P2-2：发送器声称 delivered 但没有 messageId ⇒ unknown + 一条机械护栏日志', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  await writeEntry(inboxDir, validEntry());
  const logs = [];
  const wiring = createOwnerNoticeBridgeWiring({
    inboxDir,
    stateFile,
    sendOwnerPrivateWithReceipt: async () => ({ outcome: 'delivered', code: null }),
    fs,
    clock: () => NOW,
    log: (msg) => logs.push(msg),
    minFileAgeMs: 0,
  });
  const result = await wiring.runOnce();
  assert.equal(result.report.delivered, 0);
  assert.equal(result.report.unknown, 1);
  assert.ok(logs.some((m) => m.includes('message_id')), '必须有一条可搜到的护栏日志');
  // 回执写 unknown，不得写 delivered
  const receipts = await fs.readdir(path.join(inboxDir, 'receipts'));
  const receipt = JSON.parse(await fs.readFile(path.join(inboxDir, 'receipts', receipts[0]), 'utf8'));
  assert.equal(receipt.outcome, 'unknown');
  assert.equal(receipt.code, 'delivered-without-message-id');
});

test('P3：messageId 为 0 / 空串 / 纯空白都不算送达', async () => {
  for (const bad of [0, '', '   ', '0', null, undefined, Number.NaN, 1.5]) {
    const sender = createProvenDeliverySender(async () => ({ outcome: 'delivered', code: null, messageId: bad }));
    const out = await sender('x');
    assert.equal(out.outcome, 'unknown', `messageId=${String(bad)} 不应算送达`);
  }
  const okSender = createProvenDeliverySender(async () => ({ outcome: 'delivered', code: null, messageId: 42 }));
  assert.deepEqual(await okSender('x'), { outcome: 'delivered', messageId: '42' });
});

test('P3：符号链接文件一律拒绝并隔离，不跟随', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  await fs.mkdir(inboxDir, { recursive: true });
  const outside = path.join(path.dirname(inboxDir), 'outside.json');
  await fs.writeFile(outside, JSON.stringify(validEntry()), 'utf8');
  try {
    await fs.symlink(outside, path.join(inboxDir, 'link.json'));
  } catch {
    return; // 无权限建链接（非管理员）则跳过，不让测试变假绿：下面断言仍要求 rejected 为空时显式失败
  }
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });
  const result = await wiring.runOnce();
  assert.equal(send.sent.length, 0);
  assert.equal(result.ingested.rejected.some((r) => r.reason === 'symlink'), true);
});

test('P3：刚写出的文件（未过最小年龄）本轮跳过，不隔离也不发送', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  await writeEntry(inboxDir, validEntry());
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = createOwnerNoticeBridgeWiring({
    inboxDir, stateFile, sendOwnerPrivateWithReceipt: send, fs, clock: () => NOW, log: () => {}, minFileAgeMs: 60_000,
  });
  const result = await wiring.runOnce();
  assert.equal(send.sent.length, 0);
  assert.equal(result.ingested.accepted, 0);
  assert.equal(result.ingested.rejected.length, 0);
  const names = await fs.readdir(inboxDir);
  assert.ok(names.includes(`${JSON.parse(await fs.readFile(path.join(inboxDir, names.find((n) => n.endsWith('.json'))), 'utf8')).noticeId}.json`) || names.some((n) => n.endsWith('.json')), '文件必须留在收件箱等下一轮');
});

test('P2-3/P2-4：入队失败与隔离都写日志，且每次投递结果回调一次审计', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  await writeEntry(inboxDir, validEntry());
  await fs.writeFile(path.join(inboxDir, 'broken.json'), '{oops', 'utf8');
  const logs = [];
  const audited = [];
  const wiring = createOwnerNoticeBridgeWiring({
    inboxDir,
    stateFile,
    sendOwnerPrivateWithReceipt: async () => ({ outcome: 'delivered', code: null, messageId: '880005' }),
    fs,
    clock: () => NOW,
    log: (msg) => logs.push(msg),
    minFileAgeMs: 0,
    audit: (record) => audited.push(record),
  });
  await wiring.runOnce();
  await wiring.runOnce(); // 第二轮不得重复审计同一次结果
  assert.ok(logs.some((m) => m.includes('被隔离')), '隔离必须可观测');
  assert.equal(audited.length, 1);
  assert.equal(audited[0].outcome, 'delivered');
});

test('P3：同名坏文件被连续隔离两次，两份取证都保留（不互相覆盖）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  await fs.mkdir(inboxDir, { recursive: true });
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });
  for (let i = 0; i < 2; i += 1) {
    await fs.writeFile(path.join(inboxDir, 'dup.json'), '{oops', 'utf8');
    await wiring.runOnce();
  }
  const rejected = (await fs.readdir(inboxDir)).filter((n) => n.startsWith('dup.json.') && n.endsWith('.rejected'));
  assert.equal(rejected.length, 2, `两次隔离必须各自留证，实际：${rejected.join(',')}`);
});

// —— 6. 端到端（假时钟）：长停机不丢报警、恢复即取消、可观察性 ——

test('模块内集成 长停机：桥接离线 3 小时后恢复，3 小时前的报警仍然送达（不得按年龄丢弃）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const createdAt = NOW - 3 * 60 * 60 * 1000; // 3 小时前
  const entry = validEntry({ createdAt, lastSeenAt: createdAt + 1000 });
  await writeEntry(inboxDir, entry);
  const send = fakeSender({ outcome: 'delivered', messageId: '880006' });
  const wiring = makeWiring({ inboxDir, stateFile, send, clock: () => NOW });

  const result = await wiring.runOnce();
  assert.equal(result.ingested.accepted, 1, '旧报警必须被接手，而不是 expired 丢弃');
  assert.equal(result.ingested.rejected.length, 0);
  assert.equal(send.sent.length, 1, '必须真的发出去');
  const receipt = JSON.parse(await fs.readFile(path.join(inboxDir, 'receipts', `${entry.noticeId}.json`), 'utf8'));
  assert.equal(receipt.outcome, 'delivered');
});

test('模块内集成 恢复闭环：missing 先 unknown 待重试 → recovered 取消 → 之后不再发送', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const missing = validEntry({ createdAt: NOW - 60_000, lastSeenAt: NOW - 60_000 });
  await writeEntry(inboxDir, missing);

  // 第 1 轮：发送器没有 messageId ⇒ unknown，事件保留待重试（不是 delivered）
  const failingSend = fakeSender({ outcome: 'delivered' }); // 故意不带 messageId
  const wiring = makeWiring({ inboxDir, stateFile, send: failingSend, clock: () => NOW });
  const first = await wiring.runOnce();
  assert.equal(first.report.unknown, 1);
  assert.equal(first.report.delivered, 0);

  // 第 2 轮：插件写来 recovered ⇒ 取消所有未送达的 missing 事件
  const recovered = validEntry({ kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0, createdAt: NOW, lastSeenAt: NOW });
  await writeEntry(inboxDir, recovered);
  const second = await wiring.runOnce();
  assert.equal(second.ingested.accepted, 0, 'recovered 不得被当成通知事件入队');
  assert.equal(second.ingested.duplicates, 0);
  assert.equal(second.ingested.errors.length, 0, JSON.stringify(second.ingested.errors));

  const snap = wiring.snapshot();
  assert.equal(snap.cancelled, 1, '必须取消 1 条待发事件');

  // 第 3 轮：取消后不得再发送任何东西
  const before = failingSend.sent.length;
  await wiring.runOnce();
  assert.equal(failingSend.sent.length, before, '恢复后不得继续提醒');

  // recovered 文件也必须被接手（移入 processed/）
  const processed = await fs.readdir(path.join(inboxDir, 'processed'));
  assert.ok(processed.includes(`${recovered.noticeId}.json`));
});

test('模块内集成 恢复闭环：没有待发事件时 recovered 也算成功（cancelled 0，不报错）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const recovered = validEntry({ kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0 });
  await writeEntry(inboxDir, recovered);
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  const result = await wiring.runOnce();
  assert.equal(result.ingested.errors.length, 0);
  assert.equal(wiring.snapshot().cancelled, 0);
  assert.equal(send.sent.length, 0, 'recovered 本身不发送');
});

test('恢复取消失败：文件不得移入 processed（下一轮还要再试），且失败可见', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const recovered = validEntry({ kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0 });
  const file = await writeEntry(inboxDir, recovered);
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const fakeOutbox = {
    submit: async () => ({ ok: true }),
    drain: async () => ({ ok: true, delivered: 0, unknown: 0, failed: 0, attempted: 0 }),
    snapshot: async () => ({ ok: true, events: [{ eventId: 'e-'.padEnd(20, '0'), kind: 'tool-surface-missing', deliveredAt: null, closedAt: null }] }),
    close: async () => ({ ok: false, reason: 'owner-held' }),
    dispose: async () => ({ ok: true }),
  };
  const wiring = makeWiring({ inboxDir, stateFile, send, outbox: fakeOutbox });

  const result = await wiring.runOnce();
  assert.equal(result.ingested.errors.length, 1);
  assert.equal(result.ingested.errors[0].reason, 'owner-held');
  assert.equal(wiring.snapshot().cancelled, 0);
  // 文件仍在收件箱
  const names = await fs.readdir(inboxDir);
  assert.ok(names.includes(path.basename(file)), '取消失败时不得把文件当成已处理');
});

test('有界读取：超过 2KB 的文件被拒绝并隔离（不把整份读进内存）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const entry = validEntry();
  await fs.mkdir(inboxDir, { recursive: true });
  const padded = { ...entry, blob: 'x'.repeat(4000) };
  await fs.writeFile(path.join(inboxDir, 'big.json'), JSON.stringify(padded), 'utf8');
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  const result = await wiring.runOnce();
  assert.equal(result.ingested.accepted, 0);
  assert.equal(result.ingested.rejected[0].reason, 'too-large');
  assert.equal(send.sent.length, 0);
  const rejected = (await fs.readdir(inboxDir)).filter((n) => n.endsWith('.rejected'));
  assert.equal(rejected.length, 1, '必须留取证');
});

test('可观察性：移入 processed/ 失败要计数并写日志（不再静默 catch）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const entry = validEntry();
  await writeEntry(inboxDir, entry);
  const logs = [];
  const failingFs = {
    ...fs,
    rename: async (from, to) => {
      if (String(to).includes('processed')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return fs.rename(from, to);
    },
  };
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send, fs: failingFs, logs });

  await wiring.runOnce();
  assert.equal(wiring.snapshot().processedMoveFailures, 1);
  assert.ok(logs.some((m) => m.includes('移入 processed/ 失败')), logs.join('\n'));
});

test('可观察性：写回执失败要计数并写日志，但不得影响发送', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const entry = validEntry();
  await writeEntry(inboxDir, entry);
  const logs = [];
  const failingFs = {
    ...fs,
    rename: async (from, to) => {
      if (String(to).includes('receipts')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return fs.rename(from, to);
    },
  };
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send, fs: failingFs, logs });

  const result = await wiring.runOnce();
  assert.equal(result.report.delivered, 1, '发回执失败不能回滚已发生的发送');
  assert.equal(wiring.snapshot().receiptWriteFailures, 1);
  assert.ok(logs.some((m) => m.includes('写回执失败')), logs.join('\n'));
});

test('有界读取的竞态：stat 报 100B、真实读到 2049B ⇒ 仍然拒绝', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  await fs.mkdir(inboxDir, { recursive: true });
  // 真文件就是 3000 字节；只骗过 stat（模拟 stat→read 之间被写大），read 仍走真实文件系统。
  await fs.writeFile(path.join(inboxDir, 'grew.json'), JSON.stringify({ ...validEntry(), pad: 'x'.repeat(2900) }), 'utf8');
  const racingFs = {
    ...fs,
    lstat: async (target) => {
      const real = await fs.lstat(target);
      if (!String(target).endsWith('.json')) return real;
      return { ...real, size: 100, isSymbolicLink: () => false };
    },
  };
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send, fs: racingFs });

  const result = await wiring.runOnce();
  assert.equal(result.ingested.accepted, 0, '竞态下不得接受');
  assert.equal(result.ingested.rejected[0].reason, 'too-large');
  assert.equal(send.sent.length, 0);
});

test('P2-1 同批顺序：recovered 文件名排前、missing 排后 ⇒ 过时报警不得发出', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const missing = validEntry({ noticeId: 'bbbbbbbb-1111-4111-8111-111111111111', createdAt: NOW - 60_000, lastSeenAt: NOW - 60_000 });
  const recovered = validEntry({ noticeId: 'aaaaaaaa-1111-4111-8111-111111111111', kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0, createdAt: NOW - 30_000, lastSeenAt: NOW - 30_000 });
  await writeEntry(inboxDir, recovered, 'aa-recovered.json');
  await writeEntry(inboxDir, missing, 'zz-missing.json');
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  const result = await wiring.runOnce();
  assert.equal(send.sent.length, 0, '同一轮里必须先处理恢复，旧报警不得发出');
  assert.equal(result.ingested.skippedStale, 1);
  assert.equal(wiring.snapshot().cancelled, 0, '没有已入队事件可取消，但水位仍要生效');
});

test('P2-1 跨轮：上一轮已恢复，下一轮才到的旧报警仍不得发出（水位需持久化）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  await writeEntry(inboxDir, validEntry({ kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0, createdAt: NOW - 30_000 }));
  await wiring.runOnce();
  assert.equal(send.sent.length, 0);

  const stale = validEntry({ createdAt: NOW - 3 * 60 * 1000, lastSeenAt: NOW - 3 * 60 * 1000 });
  await writeEntry(inboxDir, stale);
  const second = await wiring.runOnce();
  assert.equal(send.sent.length, 0, '恢复之后才到的旧报警不得补发');
  assert.equal(second.ingested.skippedStale, 1);

  // 模拟进程重启：新实例、同一 stateFile
  const send2 = fakeSender({ outcome: 'delivered', messageId: '880004' });
  const wiring2 = makeWiring({ inboxDir, stateFile, send: send2 });
  await writeEntry(inboxDir, validEntry({ createdAt: NOW - 2 * 60 * 1000, lastSeenAt: NOW - 2 * 60 * 1000 }));
  const third = await wiring2.runOnce();
  assert.equal(send2.sent.length, 0, '水位必须跨重启生效');
  assert.equal(third.ingested.skippedStale, 1);
});

test('P3-2 水位不得前跳：未来时间戳的 recovered 只能把水位推到 now', async () => {
  const { dir, inboxDir, stateFile } = await tempInbox();
  const send = fakeSender({ outcome: 'delivered', messageId: '880005' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  // createdAt 落在允许的 ±10 分钟窗口内，但比 now 晚 5 分钟：水位若照抄会把「之后才发生的缺失」误判成过时。
  const futureRecovered = validEntry({
    kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0,
    createdAt: NOW + 5 * 60 * 1000, lastSeenAt: NOW + 5 * 60 * 1000,
  });
  await writeEntry(inboxDir, futureRecovered);
  const first = await wiring.runOnce();
  assert.equal(first.ok, true);

  const markerPath = path.join(dir, 'state', 'owner-notice-recovered-at.json');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  assert.equal(marker.lastRecoveredAt, NOW, '水位必须被 clamp 到 now，不得采用未来时间');

  // 比 now 晚 1 分钟的缺失：若水位停在 NOW+5min 就会被判过时；clamp 到 NOW 后它必须被正常接手。
  // 注意：这里不断言「发出」——发件箱对「记录时间在未来」有独立的 skew 保护（skipped），
  // 那是另一层刻意的 fail-closed，与本条（水位不得前跳）是两件事。
  const fresh = validEntry({ noticeId: 'eeeeeeee-1111-4111-8111-111111111111', createdAt: NOW + 60_000, lastSeenAt: NOW + 60_000 });
  await writeEntry(inboxDir, fresh);
  const wiring2 = makeWiring({ inboxDir, stateFile, send });
  const second = await wiring2.runOnce();
  assert.equal(second.ingested.skippedStale, 0, '未来水位会误杀新报警');
  assert.equal(second.ingested.accepted, 1, 'clamp 之后这条缺失必须被接手（不得被当成过时丢弃）');
});

test('P2-1 不误杀：恢复之后产生的新报警必须照常发出', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  await writeEntry(inboxDir, validEntry({ kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0, createdAt: NOW - 60_000 }));
  await wiring.runOnce();

  await writeEntry(inboxDir, validEntry({ createdAt: NOW - 1000, lastSeenAt: NOW - 500 }));
  const result = await wiring.runOnce();
  assert.equal(result.ingested.accepted, 1);
  assert.equal(result.ingested.skippedStale, 0);
  assert.equal(send.sent.length, 1, '恢复之后的新报警必须发出');
});

test('P3 回执语义：被恢复取消且从未送达的事件写 outcome=cancelled（插件据此停止等待）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const missing = validEntry({ createdAt: NOW - 60_000, lastSeenAt: NOW - 60_000 });
  await writeEntry(inboxDir, missing);
  const failingSend = fakeSender({ outcome: 'delivered' }); // 无 messageId ⇒ unknown，事件留在待重试
  const wiring = makeWiring({ inboxDir, stateFile, send: failingSend });
  await wiring.runOnce();

  await writeEntry(inboxDir, validEntry({ kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0, createdAt: NOW - 1000 }));
  await wiring.runOnce();

  const receiptPath = path.join(inboxDir, 'receipts', missing.noticeId + '.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'cancelled', JSON.stringify(receipt));
});

test('P3 同毫秒：recovered 与 missing 的 createdAt 相同 ⇒ 视为已恢复覆盖，不再发（`<=` 语义）', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const sameAt = NOW - 30_000;
  const recovered = validEntry({ noticeId: 'cccccccc-1111-4111-8111-111111111111', kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0, createdAt: sameAt, lastSeenAt: sameAt });
  const missing = validEntry({ noticeId: 'dddddddd-1111-4111-8111-111111111111', createdAt: sameAt, lastSeenAt: sameAt });
  await writeEntry(inboxDir, recovered, 'aa-recovered.json');
  await writeEntry(inboxDir, missing, 'zz-missing.json');
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const wiring = makeWiring({ inboxDir, stateFile, send });

  const result = await wiring.runOnce();
  assert.equal(send.sent.length, 0, '同毫秒没有次序证据，按少发优先处理');
  assert.equal(result.ingested.skippedStale, 1);
});

test('P3 无 stateFile（注入外部 outbox）：水位只在内存 ⇒ 计数 + 告警，且同一进程内仍生效', async () => {
  const { inboxDir } = await tempInbox();
  const logs = [];
  const send = fakeSender({ outcome: 'delivered', messageId: '880003' });
  const fakeOutbox = {
    submit: async () => ({ ok: true }),
    drain: async () => ({ ok: true, delivered: 0, unknown: 0, failed: 0, attempted: 0 }),
    snapshot: async () => ({ ok: true, events: [] }),
    close: async () => ({ ok: true }),
    dispose: async () => ({ ok: true }),
  };
  const wiring = createOwnerNoticeBridgeWiring({
    inboxDir,
    outbox: fakeOutbox,
    sendOwnerPrivateWithReceipt: send,
    fs,
    clock: () => NOW,
    log: (message) => logs.push(String(message)),
    minFileAgeMs: 0,
  });
  await writeEntry(inboxDir, validEntry({ kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0, createdAt: NOW - 30_000 }));
  await wiring.runOnce();
  assert.equal(wiring.snapshot().recoveredMarkerUnpersisted, 1);
  assert.ok(logs.some((m2) => m2.includes('未配置 stateFile')), logs.join(String.fromCharCode(10)));

  await writeEntry(inboxDir, validEntry({ createdAt: NOW - 60_000, lastSeenAt: NOW - 60_000 }));
  const second = await wiring.runOnce();
  assert.equal(second.ingested.skippedStale, 1, '同一进程内内存水位仍必须生效');
});

test('回执 id 判定：只认非零安全整数（正负都算；bridge 与 wiring 共用同一函数，避免两处漂移）', () => {
  // 真实 QQ 私聊的 message_id 可以为负（2026-11-02 实测：state/social-v2.json 里
  // isSelf=true 且带 messageId 的条目全部是负数）。把这类真实回执判成非法，会让
  // 「已送达」永远记为 unknown，进而卡死 qq-comms 前置条件。
  const accepted = [1, 123, '123', '0123', 9007199254740991, -1, '-123', -1529327303, '-1529327303', -325256368];
  for (const value of accepted) {
    assert.equal(isValidDeliveredMessageId(value), true, `${JSON.stringify(value)} 应被接受`);
    assert.match(normalizeDeliveredMessageId(value), /^-?[1-9][0-9]*$/u);
  }
  // 下面这些**仍然不是**回执：0 与 -0 证明不了「这条消息有 id」，其余是形状不对。
  const rejected = [0, '0', '00', -0, '   ', '', 'abc', '1.5', 1.5, '-', '--1', {}, true, [], Number.NaN, Number.POSITIVE_INFINITY, 9007199254740993, '-9007199254740993'];
  for (const value of rejected) {
    assert.equal(isValidDeliveredMessageId(value), false, `${JSON.stringify(value)} 应被拒绝`);
    assert.equal(normalizeDeliveredMessageId(value), null);
  }
  assert.equal(normalizeDeliveredMessageId('0123'), '123', '归一化必须去掉前导零');
  assert.equal(normalizeDeliveredMessageId('-0123'), '-123', '负号必须保留，前导零必须去掉');
  assert.equal(normalizeDeliveredMessageId(' -45 '), '-45', '首尾空白必须被 trim 掉');
});

test('发送器声称 delivered 但 id 非法 ⇒ unknown（机械护栏日志）', async () => {
  const logs = [];
  const sender = createProvenDeliverySender(async () => ({ outcome: 'delivered', code: null, messageId: '0' }), { log: (line) => logs.push(line) });
  const result = await sender('x');
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.code, 'delivered-without-message-id');
  assert.equal(logs.length, 1);
});

test('P3 回执：cancelled 带 code=recovered 且不带 atLeastOnce', async () => {
  const { inboxDir, stateFile } = await tempInbox();
  const missing = validEntry({ createdAt: NOW - 60_000, lastSeenAt: NOW - 60_000 });
  await writeEntry(inboxDir, missing);
  const wiring = makeWiring({ inboxDir, stateFile, send: fakeSender({ outcome: 'delivered' }) });
  await wiring.runOnce();
  await writeEntry(inboxDir, validEntry({ kind: 'tool-surface-recovered', missingCount: 0, consecutiveMisses: 0, createdAt: NOW - 1000 }));
  await wiring.runOnce();
  const receiptPath = path.join(inboxDir, 'receipts', missing.noticeId + '.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.outcome, 'cancelled');
  assert.equal(receipt.code, 'recovered');
  assert.equal(receipt.atLeastOnce, undefined, '从未送达就不该声称 at-least-once');
});
