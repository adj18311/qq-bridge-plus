/**
 * 阶段 2B v2.2：通知模块 `notifier.mjs` 的离线测试。
 *
 * 全部离线：注入 fake fetch，不发起真实网络请求、不发真实消息、不触碰 config/state。
 * 核心规则（「只有能证明 QQ 真发出才算 delivered」）：
 *  · 默认契约 `none`：任何 2xx（含 `{ok:true}`、`{}`、`null`、`[]`）都只能是 unknown；
 *  · 契约 `bridge-send-v1`：2xx + `ok===true` + 整数 `sent>=1` + `failed===0` 才 delivered；
 *    `{ok:true, sent:0, failed:1}` 是「2xx 但没发出」→ unknown；
 *  · 2xx + `{ok:false}` → failed；4xx → failed；5xx / 网络 / 超时 / 非 JSON / 空体 / 超大体 → unknown；
 *  · 超时覆盖整次请求 + 响应体读取（`response.text()` 挂起也会按时返回）；
 *  · 任何情况都不抛异常；token 绝不进日志。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHttpNotifier,
  createNotifierFromConfig,
  DEFAULT_NOTIFY_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  NOTIFY_SUCCESS_CONTRACT_IDS,
  resolveNotifySuccessContract,
  verifyBridgeSendV1Receipt,
} from './notifier.mjs';

const URL_SEND = 'http://127.0.0.1:18766/api/send/private';
const URL_OTHER = 'http://127.0.0.1:18766/api/console/xhh-notice';
const TOKEN = 'console-token-super-secret';
const CONTRACT = 'bridge-send-v1';

/** 造一个最小 Response 形对象（只实现 notifier 会用到的方法）。 */
function fakeResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function jsonResponse(status, value) {
  return fakeResponse(status, JSON.stringify(value));
}

/** 记录调用参数的 fake fetch。 */
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeLogger() {
  const lines = [];
  const log = (level, message) => lines.push(`${level}: ${message}`);
  log.lines = lines;
  return log;
}

test('① 默认契约 none：2xx + {ok:true} 也绝不能算 delivered（Codex 阻断点）', async () => {
  const fetchImpl = makeFetch(async () => jsonResponse(200, { ok: true }));
  const notify = createHttpNotifier({ url: URL_OTHER, token: TOKEN, fetchImpl });
  const result = await notify({ kind: 'registration-lost', message: '缺 12 个工具' });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.status, 200);
  assert.equal(result.reason, 'contract-not-satisfied:none');
  // 请求形状：POST + JSON + token 头 + body.message
  const [{ url, options }] = fetchImpl.calls;
  assert.equal(url, URL_OTHER);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.equal(options.headers['x-console-token'], TOKEN);
  assert.deepEqual(JSON.parse(options.body), { message: '缺 12 个工具' });
});

test('② 默认契约 none：{}、null、[]、[] 内嵌 ok 全部 unknown（只证明受理/排队）', async () => {
  for (const payload of [{}, null, [], [true], { accepted: true }, { queued: true }]) {
    const notify = createHttpNotifier({
      url: URL_OTHER,
      fetchImpl: makeFetch(async () => jsonResponse(200, payload)),
    });
    const result = await notify({ kind: 'registration-lost', message: 'x' });
    assert.equal(result.outcome, 'unknown', `payload=${JSON.stringify(payload)} 不能算送达`);
  }
});

test('③ 默认 none：即使响应是完整发送回执 {ok:true,sent:1,failed:0} 也不算送达（P2-② 补）', async () => {
  const body = { ok: true, key: 'private:1420193228', sent: 1, failed: 0, quoted: null };
  const fetchImpl = makeFetch(async () => jsonResponse(200, body));
  const notify = createHttpNotifier({ url: URL_SEND, fetchImpl });
  const result = await notify({ kind: 'registration-lost', message: 'x' });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.reason, 'contract-not-satisfied:none');
});

test('③b 未来端点判据 verifyBridgeSendV1Receipt 真值表（含 sent:0 反向）', () => {
  assert.equal(verifyBridgeSendV1Receipt({ ok: true, sent: 1, failed: 0 }), true);
  assert.equal(verifyBridgeSendV1Receipt({ ok: true, sent: 3, failed: 0, key: 'private:1' }), true);
  assert.equal(verifyBridgeSendV1Receipt({ ok: true, sent: 0, failed: 0 }), false);
  assert.equal(verifyBridgeSendV1Receipt({ ok: true, sent: 0, failed: 1 }), false);
  assert.equal(verifyBridgeSendV1Receipt({ ok: true }), false);
  assert.equal(verifyBridgeSendV1Receipt({ ok: true, sent: '1', failed: 0 }), false);
  assert.equal(verifyBridgeSendV1Receipt({ ok: true, sent: 1, failed: 1 }), false);
  assert.equal(verifyBridgeSendV1Receipt({ ok: false, sent: 1, failed: 0 }), false);
  assert.equal(verifyBridgeSendV1Receipt(null), false);
  assert.equal(verifyBridgeSendV1Receipt([]), false);
});

test('④ 契约 bridge-send-v1：{ok:true, sent:0, failed:1} 是「2xx 但没发出」→ unknown', async () => {
  const notify = createHttpNotifier({
    url: URL_SEND,
    fetchImpl: makeFetch(async () => jsonResponse(200, { ok: true, key: 'private:1', sent: 0, failed: 1, quoted: null })),
  });
  const result = await notify({ kind: 'registration-lost', message: 'x' });
  assert.equal(result.outcome, 'unknown');
});

test('⑤ 契约 bridge-send-v1：{ok:true} / sent 非整数 / failed 非 0 都不算送达', async () => {
  const bads = [
    { ok: true },
    { ok: true, sent: '1', failed: 0 },
    { ok: true, sent: 1.5, failed: 0 },
    { ok: true, sent: 1, failed: 1 },
    { ok: true, sent: 1 },
  ];
  for (const body of bads) {
    const notify = createHttpNotifier({
      url: URL_SEND,
      fetchImpl: makeFetch(async () => jsonResponse(200, body)),
    });
    const result = await notify({ kind: 'registration-lost', message: 'x' });
    assert.equal(result.outcome, 'unknown', `body=${JSON.stringify(body)} 不能算送达`);
  }
});

test('⑥ 2xx + {ok:false} → failed（服务端明确拒绝，任何契约下都成立）', async () => {
  const notify = createHttpNotifier({
    url: URL_SEND,
    fetchImpl: makeFetch(async () => jsonResponse(200, { ok: false, error: 'no such user' })),
  });
  const result = await notify({ kind: 'registration-lost', message: 'x' });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.status, 200);
});

test('⑦ 4xx → failed（凭据/配置问题，15 分钟内不重试）', async () => {
  for (const status of [400, 401, 403, 404, 429]) {
    const notify = createHttpNotifier({
      url: URL_SEND,
      fetchImpl: makeFetch(async () => fakeResponse(status, 'nope')),
    });
    const result = await notify({ kind: 'registration-lost', message: 'x' });
    assert.equal(result.outcome, 'failed', `HTTP ${status} 应判 failed`);
  }
});

test('⑧ 5xx → unknown（服务端故障，结果未知）', async () => {
  for (const status of [500, 502, 503]) {
    const notify = createHttpNotifier({
      url: URL_SEND,
      fetchImpl: makeFetch(async () => fakeResponse(status, 'boom')),
    });
    const result = await notify({ kind: 'registration-lost', message: 'x' });
    assert.equal(result.outcome, 'unknown');
  }
});

test('⑨ 2xx 非 JSON / 空响应体 → unknown', async () => {
  for (const text of ['OK', '', '   ']) {
    const notify = createHttpNotifier({
      url: URL_SEND,
      fetchImpl: makeFetch(async () => fakeResponse(200, text)),
    });
    const result = await notify({ kind: 'registration-lost', message: 'x' });
    assert.equal(result.outcome, 'unknown', `响应体=${JSON.stringify(text)} 不能算送达`);
  }
});

test('⑩ 响应体超过 64KB → unknown（不解析可能被塞爆的响应）', async () => {
  const huge = JSON.stringify({ ok: true, sent: 1, failed: 0, pad: 'x'.repeat(MAX_RESPONSE_BYTES + 1) });
  const notify = createHttpNotifier({
    url: URL_SEND,
    fetchImpl: makeFetch(async () => fakeResponse(200, huge)),
  });
  const result = await notify({ kind: 'registration-lost', message: 'x' });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.reason, 'response-too-large');
});

test('⑪ 网络异常（fetch 抛错）→ unknown，且不向外抛', async () => {
  const fetchImpl = makeFetch(async () => {
    throw new TypeError('fetch failed');
  });
  const notify = createHttpNotifier({ url: URL_SEND, fetchImpl });
  const result = await notify({ kind: 'registration-lost', message: 'x' });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.status, null);
});

test('⑫ fetch 永不 resolve 且忽略 abort → unknown，按时返回不挂死', async () => {
  const fetchImpl = makeFetch(() => new Promise(() => {}));
  const notify = createHttpNotifier({ url: URL_SEND, fetchImpl, timeoutMs: 25 });
  const startedAt = Date.now();
  const result = await notify({ kind: 'registration-lost', message: 'x' });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.outcome, 'unknown');
  assert.match(String(result.reason), /timeout/);
  assert.ok(elapsed < 2000, `超时必须及时返回，实际 ${elapsed}ms`);
});

test('⑬ response.text() 挂起（响应头已到、body 永不结束）→ unknown 且按时返回（Codex 第 3 点）', async () => {
  const hanging = {
    ok: true,
    status: 200,
    text: () => new Promise(() => {}),
  };
  const notify = createHttpNotifier({
    url: URL_SEND,
    fetchImpl: makeFetch(async () => hanging),
    timeoutMs: 30,
  });
  const startedAt = Date.now();
  const result = await notify({ kind: 'registration-lost', message: 'x' });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.outcome, 'unknown');
  assert.match(String(result.reason), /timeout/);
  assert.ok(elapsed < 2000, `body 读取挂起也必须按时返回，实际 ${elapsed}ms`);
});

test('⑭ AbortError（fetch 自己因信号中止）→ unknown', async () => {
  const fetchImpl = makeFetch(async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });
  const notify = createHttpNotifier({ url: URL_SEND, fetchImpl });
  const result = await notify({ kind: 'registration-lost', message: 'x' });
  assert.equal(result.outcome, 'unknown');
});

test('⑮ 契约 id 未知 / 契约与端点不匹配 → 构造时抛 TypeError（装配期暴露，不静默）', () => {
  assert.throws(() => createHttpNotifier({ url: URL_SEND, successContract: 'whatever' }), /successContract|未知的通知送达契约/);
  assert.throws(() => createHttpNotifier({ url: URL_SEND, successContract: CONTRACT }), /bridge-send-v1 目前不可配置/);
  assert.throws(() => createHttpNotifier({ url: URL_OTHER, successContract: CONTRACT }), /bridge-send-v1 目前不可配置/);
});

test('⑯ url 缺失 / 非 http(s) → 构造时抛 TypeError', async () => {
  assert.throws(() => createHttpNotifier({}), /url/);
  assert.throws(() => createHttpNotifier({ url: 'ftp://x/y' }), /url/);
  assert.throws(() => createHttpNotifier({ url: 'not-a-url' }), /url/);
});

test('⑰ token 不出现在任何日志文本里（5xx / 网络异常 / 契约不满足三条路径）', async () => {
  const log = makeLogger();
  const cases = [
    async () => fakeResponse(500, 'boom'),
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => jsonResponse(200, { ok: true }),
  ];
  for (const handler of cases) {
    const notify = createHttpNotifier({ url: URL_SEND, token: TOKEN, fetchImpl: makeFetch(handler), log });
    await notify({ kind: 'registration-lost', message: 'x' });
  }
  assert.ok(log.lines.length >= 3, '应记录结果日志');
  for (const line of log.lines) {
    assert.ok(!line.includes(TOKEN), `日志泄露 token：${line}`);
  }
});

test('⑱ ownerUserId 进 body、自定义 headerName 生效、bodyFactory 优先', async () => {
  const fetchImpl = makeFetch(async () => jsonResponse(200, { ok: true, sent: 1, failed: 0 }));
  const notify = createHttpNotifier({
    url: URL_SEND,
    token: TOKEN,
    headerName: 'x-custom-token',
    ownerUserId: 123456789,
    fetchImpl,
    bodyFactory: ({ kind, message }) => ({ kind, message, extra: true }),
  });
  await notify({ kind: 'registration-lost', message: 'm' });
  const [{ options }] = fetchImpl.calls;
  assert.equal(options.headers['x-custom-token'], TOKEN);
  assert.equal(options.headers['x-console-token'], undefined);
  assert.deepEqual(JSON.parse(options.body), { kind: 'registration-lost', message: 'm', extra: true, ownerUserId: 123456789 });
});

test('⑲ createNotifierFromConfig：缺省契约走 none、非法配置返回 null 并记 error', async () => {
  assert.equal(createNotifierFromConfig({}), null);
  assert.equal(createNotifierFromConfig({ notifyUrl: 'not-a-url' }, { log: makeLogger() }), null);

  const badContractLog = makeLogger();
  assert.equal(createNotifierFromConfig(
    { notifyUrl: URL_OTHER, notifySuccessContract: 'nope' },
    { log: badContractLog },
  ), null);
  assert.ok(badContractLog.lines.some((line) => line.startsWith('error:')), '必须有 error 日志');

  const unavailableLog = makeLogger();
  assert.equal(createNotifierFromConfig(
    { notifyUrl: URL_SEND, notifySuccessContract: CONTRACT },
    { log: unavailableLog },
  ), null);
  assert.ok(unavailableLog.lines.some((line) => line.startsWith('error:')), 'bridge-send-v1 不可配置必须 error');

  const typeLog = makeLogger();
  assert.equal(createNotifierFromConfig({ notifyUrl: URL_SEND, notifySuccessContract: 123 }, { log: typeLog }), null);
  assert.ok(typeLog.lines.some((line) => line.startsWith('error:')), '非字符串契约必须 error');

  const okFetch = makeFetch(async () => jsonResponse(200, { ok: true, sent: 1, failed: 0 }));
  const notify = createNotifierFromConfig(
    { notifyUrl: URL_SEND, notifyToken: TOKEN },
    { fetchImpl: okFetch, log: makeLogger() },
  );
  assert.equal(typeof notify, 'function');
  const result = await notify({ kind: 'registration-lost', message: 'x' });
  assert.equal(result.outcome, 'unknown', '默认 none 下即使有发送回执也只判 unknown');
  assert.equal(okFetch.calls[0].options.headers['x-console-token'], TOKEN);
});

test('⑳ 常量与契约表：默认超时 5000ms、上限 64KB、只暴露两个契约 id', async () => {
  assert.equal(DEFAULT_NOTIFY_TIMEOUT_MS, 5000);
  assert.equal(MAX_RESPONSE_BYTES, 64 * 1024);
  assert.deepEqual([...NOTIFY_SUCCESS_CONTRACT_IDS], ['none']);
  assert.equal(resolveNotifySuccessContract('none').id, 'none');
  assert.equal(resolveNotifySuccessContract('nope'), null);
  assert.equal(resolveNotifySuccessContract('bridge-send-v1'), null, 'bridge-send-v1 已下线，不可配置');
  assert.equal(NOTIFY_SUCCESS_CONTRACT_IDS.includes('none'), true);
});