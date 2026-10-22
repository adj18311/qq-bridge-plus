#!/usr/bin/env node
// 本发布（Githubv1.1.0，基线 fe8bda4）去除「额度检测/额度通知」的隔离回归。
//
// 目的：证明额度通知的专用通道已彻底移除——明确的额度错误只落 error-notice 的 generic
// 固定文案，不出现任何额度文案、不生成 state/quota-notices.json、也不额外触发模型 prompt。
//
// 手法：与 test-notice-p1-integration.mjs 相同的真实桥接边界（busyHarness = 临时目录 +
// 假 DSH / 假 QQ，全部离线）；只喂真实 turn/end error 帧，不连真实 QQ/DSH、不读线上配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { busyHarness, feedFrames, frameOf, waitFor, sleep } from './busy-watchdog-harness.mjs';
import { ERROR_NOTICE_TEXTS } from '../src/error-notice.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'private:123';
const QQ = 123;
const PROVIDER = 'fixture-p';
const MODEL = 'fixture-m';
const GENERIC_TEXT = ERROR_NOTICE_TEXTS.other;
// 明显虚构的 fixture 假 key：仅用于验证日志脱敏，不对应任何真实供应商凭据。
const FAKE_API_KEY = 'sk-fixture-FAKE-0000000000000000';

let SEQ = 0;
const frame = (sid, type, data) => frameOf(sid, { seq: (SEQ += 1), type, data });
const openTurn = (sid, turn) => [
  frame(sid, 'turn/start', { turn }),
  frame(sid, 'step/start', { turn, step: 1 }),
  frame(sid, 'model/selection', { turn, step: 1, provider: PROVIDER, model: MODEL, selection: { provider: PROVIDER, model: MODEL } }),
  frame(sid, 'request/header', { header: { config: { provider: PROVIDER, model: MODEL } } }),
];
const endError = (sid, failure, turn) => frame(sid, 'turn/end', { turn, reason: { kind: 'error', error: failure } });
const textsFor = (h) => h.calls.sent.filter((row) => row.kind === 'private' && Number(row.id) === QQ).map((row) => row.text);

test('明确额度错误只发 generic 固定文案：无额度文案/状态文件，也不额外触发 prompt', async () => {
  const h = await busyHarness({
    config: {
      sendDelayMs: 0,
      dsh: { provider: PROVIDER, model: MODEL },
      allow: { private: [QQ], groups: [456] },
      socialV2: { proactive: { enabled: false } },
    },
  });
  try {
    h.setMode('reserved2');
    const sid = await h.ensureSession(KEY);
    h.wakeConfigUpdatedKeys.add(KEY);
    const promptsBefore = h.calls.prompts.length;
    const sentBefore = h.calls.sent.length;

    // 明确的额度错误：不是 429（429 一律按限流），也不是鉴权/拥挤类错误。
    const failure = { code: 'SERVER', message: `insufficient_quota: 当前额度已用完（quota exhausted） api_key=${FAKE_API_KEY}` };
    await feedFrames(h, [...openTurn(sid, 1), endError(sid, failure, 1)], 60);

    assert.ok(await waitFor(() => textsFor(h).length >= 1, 4000, 25),
      `应发出 generic 固定文案，实际 ${JSON.stringify(h.calls.sent)}`);
    await sleep(150);

    const texts = textsFor(h);
    assert.deepEqual(texts, [GENERIC_TEXT], '额度错误必须只走 error-notice 的 generic 固定文案');
    assert.equal(h.calls.sent.length, sentBefore + 1, '只允许一条固定通知，不得补发/重发');
    for (const text of texts) {
      assert.ok(!text.includes('额度'), `QQ 文案不得出现额度文案：${text}`);
      assert.ok(!/quota/i.test(text), `QQ 文案不得出现 quota 字样：${text}`);
    }
    assert.equal(fs.existsSync(path.join(h.temp, 'state', 'quota-notices.json')), false,
      '本发布不得再生成 state/quota-notices.json');
    assert.equal(h.calls.prompts.length, promptsBefore,
      `额度错误不得额外触发模型 prompt（before=${promptsBefore}, after=${h.calls.prompts.length}）`);
    assert.ok(await waitFor(() => h.readLog().includes('[other]'), 2000, 25),
      `日志应记录 generic(other) 分类，实际：${h.readLog()}`);
    const logText = h.readLog();
    assert.ok(logText.includes('[other]'), `日志应记录 generic(other) 分类，实际：${logText}`);
    assert.ok(!logText.includes(FAKE_API_KEY), `日志不得出现裸 API key（fixture 假值）：${logText}`);
    for (const row of h.calls.sent) {
      assert.ok(!String(row.text ?? '').includes(FAKE_API_KEY), `QQ 文本不得出现裸 API key：${row.text}`);
    }
    assert.equal(Object.hasOwn(ERROR_NOTICE_TEXTS, 'quota'), false, '固定文案表不得再有 quota 分支');
    for (const file of ['src/quota-error.js', 'src/quota-notice.js', 'src/quota-notice-runtime.js']) {
      assert.equal(fs.existsSync(path.join(root, file)), false, `${file} 必须已从本发布删除`);
    }
  } finally {
    await h.close();
  }
});
