// qq_send_image（把图片发到 QQ）离线测试 —— **真实的 src/bridge.js 路由** + 假下载器 + 假网关。
//
// 这条能力要防的失败模式都很具体，所以逐条钉住：
//   · 白名单图床 + 正常字节 ⇒ 真的走 `image` 段发出，且**段结构**逐字节断言（base64:// + 原字节）；
//   · 非白名单主机 ⇒ 拒绝、原因清楚，而且**一个请求都不发**（下载器调用次数为 0）；
//   · 超过 4MiB ⇒ 拒绝（既测 safe-fetch 的上限报错，也测"下载器没卡住时桥接自己再卡一次"）；
//   · 下载失败 / 网关发送失败 ⇒ 如实失败（502/500 + 原因），绝不报成功；
//   · 频率限制被触发 ⇒ 429 如实报错；失败那次已预占的额度要**回滚**（否则一次失败会把会话锁死）；
//   · MCP 侧 `qq_send_image` 的注册期开关（`socialV2.tools.sendImage=false` ⇒ 根本不注册）。
// 全程离线：不连 QQ/DSH/图床，不读线上 config.json，不写真实 state/，不启动第二个守护进程。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { isTiebaImageHost } from '../src/tieba-lib.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const CONSOLE_TOKEN = 'fixture-console-token';
const KEY = 'private:123';
const TOKEN_GROUP = 'group:456';                 // 白名单内的群（本用例不发群，只用来验证白名单判定一致）
const OK_URL = 'https://imgsa.baidu.com/forum/fixture-image.png';
const CDN_URL = 'https://fixture.gss3.bdstatic.com/fixture-bucket/fixture-image.jpg?sign=abc123&tbpicau=fixture';
const BAD_HOST_URL = 'https://example.com/a.png';
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=',
  'base64'
);

let failures = 0;
let passed = 0;
async function test(name, run) {
  const t0 = Date.now();
  try {
    await run();
    passed += 1;
    console.log(`✅ ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${name}（${Date.now() - t0}ms）\n   ${error?.stack ?? error?.message ?? error}`);
  }
}

/** 起一个 harness + console server，跑完自动收尾。`globals` 覆盖 VM 注入（假下载器 / 假网关）。 */
async function withBridge(run, { config = {}, globals = {} } = {}) {
  const h = await bridgeHarness({ config, globals });
  h.setMode('reserved2');
  await h.ensureSession(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await run(h, server);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

/** 与 MCP 工具完全一致的调用方式（x-console-token + x-agent-token + x-agent-call: 1）。 */
function agentRequest(server, { pathname, body, agentToken }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: `${pathname}?token=${encodeURIComponent(CONSOLE_TOKEN)}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-console-token': CONSOLE_TOKEN,
        ...(agentToken ? { 'x-agent-token': agentToken, 'x-agent-call': '1' } : {}),
        'content-length': Buffer.byteLength(payload),
        connection: 'close'
      },
      agent: false
    }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: response.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request hung')));
    req.end(payload);
  });
}

const sendImage = (server, { key = KEY, url, agentToken }) =>
  agentRequest(server, { pathname: '/api/socialV2/send-image', body: { key, url }, agentToken });

/** 拦下来的 OneBot 发送请求 —— 「真的发出去了」的最强证据。 */
const onebotSends = (h, action = 'send_private_msg') =>
  h.calls.http.filter((c) => String(c.url).includes(`/${action}`));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个记录调用参数的假下载器（默认返回夹具 PNG）。 */
function fakeDownloader({ buffer = FIXTURE_PNG, fail = null } = {}) {
  const calls = [];
  const fetchBuffer = async (url, maxBytes, opts) => {
    calls.push({ url, maxBytes, headers: opts?.headers });
    if (fail) throw fail;
    return { url, statusCode: 200, buffer };
  };
  fetchBuffer.calls = calls;
  return fetchBuffer;
}

// ── 1. 正常路径：白名单主机 + 正常字节 ⇒ base64 图片段发出 ─────────────────────
await test('send-image-1：白名单图床 + 正常字节 ⇒ 下载在桥接内、发出 image 段（段结构逐字节断言）', async () => {
  const downloader = fakeDownloader();
  await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    assert.ok(token, 'reserved2 会话必须有 agentToken');
    const res = await sendImage(server, { url: OK_URL, agentToken: token });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.data?.ok, true, res.raw);
    assert.equal(res.data.bytes, FIXTURE_PNG.length);
    assert.equal(res.data.host, 'imgsa.baidu.com');
    assert.equal(res.data.sent, 1);
    assert.equal(res.data.failed, 0);

    // ① 下载：走 safeFetchBuffer（带单张上限 4MiB + referer + 移动版 UA），地址是白名单原地址。
    assert.equal(downloader.calls.length, 1, '必须真的下载一次');
    assert.equal(downloader.calls[0].url, OK_URL);
    assert.equal(downloader.calls[0].maxBytes, 4 * 1024 * 1024, '单张上限必须是 4MiB');
    assert.equal(downloader.calls[0].headers?.referer, 'https://tieba.baidu.com/', '图床不带 referer 会 403');
    assert.match(String(downloader.calls[0].headers?.['user-agent'] ?? ''), /Mobile/, '要用移动版 UA');

    // ② 发送：OneBot v11 的 image 段，file 是 `base64://<原字节 base64>`，目标就是那个私聊。
    const sends = onebotSends(h);
    assert.equal(sends.length, 1, `必须恰好发出一条 OneBot 请求：${JSON.stringify(h.calls.http)}`);
    assert.deepEqual(sends[0].body, {
      user_id: 123,
      message: [{ type: 'image', data: { file: `base64://${FIXTURE_PNG.toString('base64')}` } }]
    }, '发出的消息段结构必须与约定一致');

    // ③ 记账：这条图片消息要出现在会话 recentMessages 里（模型自己知道刚发过图）。
    const st = h.getSocialV2State(KEY);
    const last = st.recentMessages.at(-1);
    assert.equal(last?.text, '[图片]');
    assert.equal(last?.isSelf, true);
    assert.equal(last?.messageId, '9001');
  }, { globals: { safeFetchBuffer: downloader } });
});

// ── 2. 白名单：非白名单主机一律拒绝，且不下载、不发送 ─────────────────────────
await test('send-image-2：非白名单主机 ⇒ 拒绝（原因清楚）、不下载、不发送', async () => {
  const downloader = fakeDownloader();
  await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    for (const url of [BAD_HOST_URL, 'http://127.0.0.1/a.png', 'https://evil-baidu.com/a.png', 'https://baidu.com.evil.test/a.png', 'data:image/png;base64,AAAA']) {
      const res = await sendImage(server, { url, agentToken: token });
      assert.equal(res.status, 400, `${url} ⇒ ${res.raw}`);
      assert.equal(res.data?.ok, false);
      assert.equal(res.data?.code, 'SEND_IMAGE_REJECTED');
      assert.match(String(res.data?.error), /非白名单图床|合法地址|http\/s|不接受 data/,
        `拒绝原因必须说清：${url} ⇒ ${res.data?.error}`);
    }
    assert.equal(downloader.calls.length, 0, '非白名单地址一个下载请求都不能发');
    assert.equal(onebotSends(h).length, 0, '被拒绝的请求绝不能真的发出去');
  }, { globals: { safeFetchBuffer: downloader } });
});

// ── 3. 体积：超过 4MiB ⇒ 拒绝（两种来源都测）─────────────────────────────────
await test('send-image-3：超过 4MiB ⇒ 拒绝（safe-fetch 的上限报错 + 桥接自己的双保险）', async () => {
  // ① 下载器按 safe-fetch 的原文报上限（真实路径：requestOnce 读到超限就抛）。
  const throwing = fakeDownloader({ fail: new Error('图片超过大小限制（4194304 字节）') });
  const resA = await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    return sendImage(server, { url: OK_URL, agentToken: token });
  }, { globals: { safeFetchBuffer: throwing } });
  assert.equal(resA.status, 400, resA.raw);
  assert.equal(resA.data?.code, 'SEND_IMAGE_REJECTED');
  assert.match(String(resA.data?.error), /图片超过体积上限（单张上限 4MiB）/);

  // ② 下载器没卡体积（注入实现/以后换实现）⇒ 桥接自己再卡一次，绝不静默截断成"半个图"。
  const oversize = fakeDownloader({ buffer: Buffer.concat([FIXTURE_PNG, Buffer.alloc(4 * 1024 * 1024)]) });
  const resB = await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    return sendImage(server, { url: OK_URL, agentToken: token });
  }, { globals: { safeFetchBuffer: oversize } });
  assert.equal(resB.status, 400, resB.raw);
  assert.equal(resB.data?.code, 'SEND_IMAGE_REJECTED');
  assert.match(String(resB.data?.error), /图片超过体积上限（单张上限 4MiB，实际约 \d+KB）/);
});

// ── 4. 下载失败 ⇒ 如实失败（502 + 原因），绝不报成功 ─────────────────────────
await test('send-image-4：下载失败 / 取回的不是图片 ⇒ 如实失败，不发送', async () => {
  const broken = fakeDownloader({ fail: new Error('图片抓取失败：HTTP 404') });
  await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    const res = await sendImage(server, { url: OK_URL, agentToken: token });
    assert.equal(res.status, 502, res.raw);
    assert.equal(res.data?.ok, false);
    assert.equal(res.data?.code, 'SEND_IMAGE_DOWNLOAD_FAILED');
    assert.match(String(res.data?.error), /图片下载失败：图片抓取失败：HTTP 404/);
    assert.equal(onebotSends(h).length, 0, '下载失败不能还发一条出去');
  }, { globals: { safeFetchBuffer: broken } });

  // 取回的不是图片（例如图床回了一个 HTML 错误页）：同样如实失败。
  const notImage = fakeDownloader({ buffer: Buffer.from('<html>对不起，页面不存在</html>') });
  await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    const res = await sendImage(server, { url: CDN_URL, agentToken: token });
    assert.equal(res.status, 502, res.raw);
    assert.match(String(res.data?.error), /不是有效图片/);
    assert.equal(onebotSends(h).length, 0);
  }, { globals: { safeFetchBuffer: notImage } });
});

// ── 5. 网关发送失败 ⇒ 500 如实失败；且预占的发送额度要回滚 ────────────────────
await test('send-image-5：网关发送失败 ⇒ 500 如实失败；失败的额度回滚（不会把会话锁死）', async () => {
  const downloader = fakeDownloader();
  const httpCalls = [];
  const failingGateway = async (url, init = {}) => {
    let body = null;
    try { body = JSON.parse(init?.body ?? 'null'); } catch {}
    httpCalls.push({ url: String(url), body });
    if (String(url).includes('/send_private_msg')) {
      return { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 100, wording: 'fixture 网关拒绝' }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  // maxSendPerMinute=1：第一次失败若没回滚，第二次就会被自己的假 429 挡住。
  await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    const first = await sendImage(server, { url: OK_URL, agentToken: token });
    assert.equal(first.status, 500, first.raw);
    assert.equal(first.data?.ok, false);
    assert.equal(first.data?.code, 'SEND_IMAGE_SEND_FAILED');
    assert.match(String(first.data?.error), /图片发送失败：OneBot send_private_msg 失败: fixture 网关拒绝/);

    const second = await sendImage(server, { url: OK_URL, agentToken: token });
    assert.equal(second.status, 500, `失败额度必须回滚，第二次不该是 429：${second.raw}`);
    assert.equal(httpCalls.filter((c) => String(c.url).includes('/send_private_msg')).length, 2,
      '两次都要真的尝试发送（失败是网关给的，不是被限频挡的）');
  }, { config: { socialV2: { send: { maxSendPerMinute: 1 } } }, globals: { safeFetchBuffer: downloader, fetch: failingGateway } });
});

// ── 6. 频率限制：真的触发时如实 429，且被限流的那次不发送 ────────────────────
await test('send-image-6：触发 maxSendPerMinute ⇒ 429 如实报错（不静默放行）', async () => {
  const downloader = fakeDownloader();
  await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    const first = await sendImage(server, { url: OK_URL, agentToken: token });
    assert.equal(first.status, 200, first.raw);
    const second = await sendImage(server, { url: OK_URL, agentToken: token });
    assert.equal(second.status, 429, second.raw);
    assert.equal(second.data?.ok, false);
    assert.equal(second.data?.code, 'RATE_LIMITED');
    assert.match(String(second.data?.error), /发送频率超限/);
    assert.equal(onebotSends(h).length, 1, '被限流的那次不能发出去');
    assert.equal(downloader.calls.length, 1, '被限流时连下载都不该做（限流判定在下载之前）');
  }, { config: { socialV2: { send: { maxSendPerMinute: 1 } } }, globals: { safeFetchBuffer: downloader } });
});

// ── 7. 三道鉴权：工具开关 / 令牌 / 会话范围 ──────────────────────────────────
await test('send-image-7：sendImage 开关关闭 ⇒ 403「工具未启用」；令牌错误 ⇒ 403', async () => {
  const downloader = fakeDownloader();
  await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    const res = await sendImage(server, { url: OK_URL, agentToken: token });
    assert.equal(res.status, 403, res.raw);
    assert.match(String(res.data?.error), /工具未启用：qq_send_image/);
    assert.equal(downloader.calls.length, 0);

    const bad = await sendImage(server, { url: OK_URL, agentToken: 'fixture-wrong-token' });
    assert.equal(bad.status, 403, bad.raw);
    assert.equal(onebotSends(h).length, 0);
  }, { config: { socialV2: { tools: { sendImage: false } } }, globals: { safeFetchBuffer: downloader } });
});

// ── 8. 白名单判定与 tieba-lib 是同一条口径（防两边漂移）──────────────────────
await test('send-image-8：可发图床与 tieba-lib 的 isTiebaImageHost 判定完全一致', async () => {
  const downloader = fakeDownloader();
  const hosts = ['imgsa.baidu.com', 'tiebapic.cdn.bcebos.com', 'fixture.gss3.bdstatic.com', 'tb2.bdimg.com',
    'evil-baidu.com', 'baidu.com.evil.test', 'example.com', '127.0.0.1', 'localhost'];
  await withBridge(async (h, server) => {
    const token = h.getSocialV2State(KEY).agentToken;
    for (const host of hosts) {
      const url = `https://${host}/fixture-image.png`;
      const res = await sendImage(server, { url, agentToken: token });
      const allowed = res.data?.ok === true;
      assert.equal(allowed, isTiebaImageHost(host),
        `${host}：端点判定(${allowed}) 必须与 isTiebaImageHost(${isTiebaImageHost(host)}) 一致；${res.raw}`);
    }
    // 群聊目标同样走这套白名单（用自己的会话令牌；本用例只验证 key 解析到 group 分支，不真的发群）。
    await h.ensureSession(TOKEN_GROUP);
    const groupToken = h.getSocialV2State(TOKEN_GROUP).agentToken;
    const groupRes = await sendImage(server, { key: TOKEN_GROUP, url: BAD_HOST_URL, agentToken: groupToken });
    assert.equal(groupRes.status, 400, groupRes.raw);
    assert.match(String(groupRes.data?.error), /非白名单图床/);
  }, { globals: { safeFetchBuffer: downloader } });
});

// ── 9. MCP 侧：qq_send_image 的注册期开关与接线 ───────────────────────────────
/** 用 vm 跑**真实的** mcp-snowluma-safe.js（去掉 import、桩掉 stdio 与 fetch），拿它注册的工具。 */
function loadMcpTools(configJson) {
  const tools = new Map();
  const requests = [];
  const source = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("const __dirname = path.dirname(fileURLToPath(import.meta.url));", "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { description, schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    URLSearchParams,
    fetch: async (url, init = {}) => {
      let body = null;
      try { body = JSON.parse(init.body ?? 'null'); } catch {}
      requests.push({ url: String(url), body, headers: init.headers ?? {} });
      return Response.json({ ok: true, key: KEY, messageId: 9001, bytes: FIXTURE_PNG.length, host: 'imgsa.baidu.com' });
    },
    AbortSignal,
    process,
    setTimeout,
    clearTimeout,
    console,
    Buffer,
    path,
    // config.json 的读取桩：模块顶层 loadConfig() 就靠它，注册期开关才测得到。
    fs: { ...fs, readFileSync: () => configJson },
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (value) => JSON.stringify(value)
  });
  return { tools, requests };
}

await test('send-image-9：MCP 注册期 —— 开关关闭就不注册；开启时把 key/url/token 打到真实端点', async () => {
  const on = loadMcpTools(JSON.stringify({ consoleToken: CONSOLE_TOKEN }));
  const tool = on.tools.get('qq_send_image');
  assert.ok(tool, '默认（未关闭）必须注册 qq_send_image');
  assert.match(tool.description, /白名单图床/, '描述里必须写清只能发白名单图床');
  assert.match(tool.description, /4MiB/, '描述里必须写清单张上限');
  assert.match(tool.description, /如实/, '描述里必须写清失败会如实说明');
  const parsed = z.object(tool.schema).parse({ key: KEY, token: 'fixture-token', url: OK_URL });
  const out = await tool.callback(parsed);
  assert.equal(on.requests.length, 1);
  assert.match(on.requests[0].url, /\/api\/socialV2\/send-image$/);
  assert.deepEqual(on.requests[0].body, { key: KEY, url: OK_URL, token: 'fixture-token' });
  assert.equal(on.requests[0].headers['x-agent-token'], 'fixture-token', '必须带会话令牌');
  assert.equal(on.requests[0].headers['x-agent-call'], '1');
  assert.equal(out.isError, undefined);

  const off = loadMcpTools(JSON.stringify({ consoleToken: CONSOLE_TOKEN, socialV2: { tools: { sendImage: false } } }));
  assert.equal(off.tools.has('qq_send_image'), false, 'sendImage=false ⇒ 注册期就不该注册（省 token、不给模型误调机会）');
  assert.ok(off.tools.has('qq_send_sticker'), '别的工具不受影响');
});

// 一个小停留：bridge 内部的 sendChain/记账是异步的，确保上面的断言在收尾前都落定。
await sleep(10);

console.log(`\n${failures === 0 ? '🎉' : '❌'} qq_send_image 离线测试：通过 ${passed} 项，失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
