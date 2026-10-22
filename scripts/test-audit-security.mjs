// Offline regression tests: no sockets, QQ messages, production config or secrets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SENSITIVE_RE } from '../src/sensitive.js';

const lookupCalls = [];
const originalLookup = dns.promises.lookup;
dns.promises.lookup = async (host) => {
  lookupCalls.push(host);
  if (host === 'public.test') return [{ address: '93.184.216.34', family: 4 }];
  if (host === 'mixed.test') return [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }];
  if (host === 'expanded.test') return [{ address: '0:0:0:0:0:ffff:7f00:1', family: 6 }];
  throw new Error(`Unexpected DNS lookup in offline test: ${host}`);
};
let fetchModule;
try { fetchModule = await import('../src/safe-fetch.js'); }
finally { dns.promises.lookup = originalLookup; }
const { isPrivateIp, safeFetch, safeFetchBuffer, validateFetchUrl } = fetchModule;

function mockTransport(t, scripts) {
  const requests = [];
  const responses = [];
  const request = (options, callback) => {
    const script = scripts[requests.length];
    assert.ok(script, 'Unexpected outgoing request');
    const req = new EventEmitter();
    requests.push({ options, req });
    req.destroyed = false;
    req.destroy = (error) => {
      req.destroyed = true;
      if (error) queueMicrotask(() => req.emit('error', error));
    };
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough();
      res.statusCode = script.status || 200;
      res.headers = script.headers || {};
      res.complete = false;
      responses.push(res);
      callback(res);
      if (res.destroyed) return;
      if (script.produce) script.produce(res);
      else {
        res.complete = true;
        res.end(script.body || 'ok');
      }
    });
    return req;
  };
  t.mock.method(http, 'request', request);
  t.mock.method(https, 'request', request);
  return { requests, responses };
}

test('sensitive audit catches UNC paths and quoted JSON credentials', () => {
  for (const value of [
    String.raw`\\server\share\private.txt`,
    String.raw`C:\Users\fixture-user\config.json`,
    '/root/.ssh/id_rsa',
    '{"token":"fixture-only-token"}',
    '{"accessToken": "fixture-only-token"}',
    "{'password': 'fixture-password'}",
    'api_key = fixture-api-value',
  ]) assert.equal(SENSITIVE_RE.test(value), true, value);
  for (const value of ['你好，今天吃什么', '如何设置密码？', 'token 的作用是什么？', '访问 https://example.com/guide']) {
    assert.equal(SENSITIVE_RE.test(value), false, value);
  }
});

test('IPv6 canonicalization cannot turn a private address into public', () => {
  for (const value of [
    '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1',
    '::ffff:127.0.0.1', 'fd00::8.8.8.8', 'fe80::8.8.8.8',
    '64:ff9b::7f00:1', '64:ff9b:1:a00::808:808', 'not-an-ip',
  ]) assert.equal(isPrivateIp(value), true, value);
  for (const value of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIp(value), false, value);
  }
});

test('URLs and every DNS result are validated before opening a connection', async (t) => {
  const transport = mockTransport(t, []);
  for (const url of [
    'file:///etc/passwd', 'http://user:pass@public.test/', 'http://127.1/',
    'http://[::ffff:127.0.0.1]/', 'http://localhost./', 'http://host.local./',
    'http://mixed.test/', 'http://expanded.test/',
  ]) await assert.rejects(validateFetchUrl(url));
  assert.equal(transport.requests.length, 0);
});

test('HTTP transport pins the validated IP and preserves Host and TLS SNI', async (t) => {
  const before = lookupCalls.length;
  const { requests } = mockTransport(t, [{ body: 'fixture' }]);
  const result = await safeFetch('https://public.test/page?q=1');
  assert.equal(result.body, 'fixture');
  assert.equal(result.truncated, false);
  assert.deepEqual(lookupCalls.slice(before), ['public.test']);
  assert.equal(requests[0].options.hostname, '93.184.216.34');
  assert.equal(requests[0].options.headers.host, 'public.test');
  assert.equal(requests[0].options.servername, 'public.test');
  assert.equal(requests[0].options.path, '/page?q=1');
});

// ── 追加请求头（safeFetch 的第三个参数）：登录态接入的最小口子 ──────────────
//
// 三条必须钉住的回归：
//   ① 不传 opts 时请求头**逐字节不变**（默认头集合的精确断言，防止顺手改动把反爬头弄丢）；
//   ② 传了 opts.headers 只追加/覆盖这些头，Host 仍由 URL 决定；
//   ③ 追加头不能变成绕过防护的手段（覆盖 host / 头注入 / 内网地址全部照旧拒绝）。
test('without opts the request headers stay exactly the pinned default set', async (t) => {
  const { requests } = mockTransport(t, [{ body: 'fixture' }]);
  await safeFetch('https://public.test/page?q=1');
  assert.deepEqual(requests[0].options.headers, {
    host: 'public.test',
    'user-agent': 'Mozilla/5.0',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
  });
});

test('opts.headers only appends, and Host stays pinned to the URL', async (t) => {
  const { requests } = mockTransport(t, [{ body: 'fixture' }]);
  await safeFetch('https://public.test/page', 50000, { headers: { Cookie: 'fixture_key=fixture_value' } });
  assert.deepEqual(requests[0].options.headers, {
    host: 'public.test',
    'user-agent': 'Mozilla/5.0',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    cookie: 'fixture_key=fixture_value',
  });
  // 值里的空对象等价于「什么都没加」；undefined/null 走默认路径。
  const { requests: noop } = mockTransport(t, [{ body: 'fixture' }]);
  await safeFetch('https://public.test/page', 50000, { headers: {} });
  assert.deepEqual(Object.keys(noop[0].options.headers), ['host', 'user-agent', 'accept', 'accept-language']);
  assert.equal(noop[0].options.headers.cookie, undefined);
});

test('appended headers survive same-origin redirects but are dropped across origins', async (t) => {
  // 跨源用「同 IP 不同端口」构造（离线测试里的 DNS 只认少数夹具域名，不能换域名）。
  const { requests } = mockTransport(t, [
    { status: 302, headers: { location: '/next' }, produce() {} },
    { body: 'ok' },
    { status: 302, headers: { location: 'http://93.184.216.34:8080/next' }, produce() {} },
    { body: 'ok' },
  ]);
  await safeFetch('http://93.184.216.34/start', 1000, { headers: { cookie: 'a=1' } });
  assert.equal(requests[0].options.headers.cookie, 'a=1');
  assert.equal(requests[1].options.headers.cookie, 'a=1', '同源重定向必须保留（否则登录态一跳转就丢）');
  await safeFetch('http://93.184.216.34/start', 1000, { headers: { cookie: 'a=1' } });
  assert.equal(requests[2].options.headers.cookie, 'a=1');
  assert.equal(requests[3].options.headers.cookie, undefined, '跨源重定向必须丢掉追加头：不能把 cookie 送给第三方');
});

test('header overrides cannot bypass the address guard, replace Host, or inject lines', async (t) => {
  const { requests } = mockTransport(t, []);
  await assert.rejects(safeFetch('http://93.184.216.34/', 1000, { headers: { Host: 'evil.test' } }), /host/);
  await assert.rejects(safeFetch('http://93.184.216.34/', 1000, { headers: { host: 'evil.test' } }), /host/);
  await assert.rejects(safeFetch('http://93.184.216.34/', 1000, { headers: { cookie: 'a=1\r\nx-evil: 1' } }), /换行/);
  await assert.rejects(safeFetch('http://93.184.216.34/', 1000, { headers: 'cookie' }), /普通对象/);
  // 内网地址防护仍在**最终目标**上生效：带着 headers 也照旧在发请求前拒绝。
  await assert.rejects(safeFetch('http://127.0.0.1/', 1000, { headers: { cookie: 'a=1' } }), /禁止/);
  await assert.rejects(safeFetch('http://[::1]/', 1000, { headers: { cookie: 'a=1' } }), /禁止/);
  assert.equal(requests.length, 0, '这些调用一个请求都不该发出去');
});

test('redirect bodies are closed immediately and internal redirects are rejected', async (t) => {
  const { requests, responses } = mockTransport(t, [{ status: 302, headers: { location: 'http://127.0.0.1/' }, produce() {} }]);
  await assert.rejects(safeFetch('http://93.184.216.34/'), /禁止/);
  assert.equal(requests.length, 1);
  assert.equal(responses[0].destroyed, true);
});

test('public redirects still work without downloading their bodies', async (t) => {
  const { responses } = mockTransport(t, [
    { status: 307, headers: { location: '/next' }, produce() {} },
    { body: 'redirect worked' },
  ]);
  const result = await safeFetch('http://93.184.216.34/start');
  assert.equal(result.url, 'http://93.184.216.34/next');
  assert.equal(result.body, 'redirect worked');
  assert.equal(responses[0].destroyed, true);
});

test('text limits count Unicode code points and close oversized responses', async (t) => {
  const { responses } = mockTransport(t, [{ body: '😀😀😀继续' }]);
  const result = await safeFetch('http://93.184.216.34/', 3);
  assert.equal(result.body, '😀😀😀');
  assert.equal(result.truncated, true);
  assert.equal(responses[0].destroyed, true);
});

test('image byte limits and signatures are checked', async (t) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
  const { responses } = mockTransport(t, [{ body: png }, { body: png }, { body: Buffer.alloc(20) }]);
  assert.deepEqual((await safeFetchBuffer('http://93.184.216.34/', 12)).buffer, png);
  await assert.rejects(safeFetchBuffer('http://93.184.216.34/', 11), /大小限制/);
  assert.equal(responses[1].destroyed, true);
  await assert.rejects(safeFetchBuffer('http://93.184.216.34/'), /不是有效图片/);
});

// ── safeFetchBuffer 的追加请求头（t78）：贴吧图床要 referer，口子必须和 safeFetch 同一套边界 ──
//
// 三条必须钉住的回归：不传时请求头**逐字节不变**（图片默认头集合是独立的一份，别顺手改动）、
// 传了只追加且 `host` 仍由 URL 决定、以及「带着头也不能绕过防护」（覆盖 host / 头注入 / 内网）。
test('safeFetchBuffer without opts keeps the pinned image default headers', async (t) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
  const { requests } = mockTransport(t, [{ body: png }]);
  await safeFetchBuffer('http://93.184.216.34/', 12);
  assert.deepEqual(requests[0].options.headers, {
    host: '93.184.216.34',
    'user-agent': 'Mozilla/5.0',
    accept: 'image/*,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
  });
  // 追加头只影响这一次请求：紧接着的默认调用仍然一个额外头都没有。
  const { requests: again } = mockTransport(t, [{ body: png }]);
  await safeFetchBuffer('http://93.184.216.34/', 12, { headers: {} });
  assert.deepEqual(Object.keys(again[0].options.headers), ['host', 'user-agent', 'accept', 'accept-language']);
});

test('safeFetchBuffer appends headers, keeps Host pinned, and still refuses bypasses', async (t) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
  const { requests } = mockTransport(t, [{ body: png }, { body: png }, { body: png }, { body: png }]);
  const fetched = await safeFetchBuffer('https://public.test/pic.png', 12, {
    headers: { Referer: 'https://tieba.baidu.com/', Cookie: 'fixture_key=fixture_value' }
  });
  assert.deepEqual(fetched.buffer, png);
  assert.deepEqual(requests[0].options.headers, {
    host: 'public.test',
    'user-agent': 'Mozilla/5.0',
    accept: 'image/*,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: 'https://tieba.baidu.com/',
    cookie: 'fixture_key=fixture_value',
  });
  assert.equal(requests[0].options.hostname, '93.184.216.34', '请求仍然打到已校验的 IP');
  assert.equal(requests[0].options.servername, 'public.test', 'TLS SNI 仍是原始域名');

  // 同源重定向保留追加头、跨源丢掉（图床常 302 到 CDN，但凭据不能跟着走）。
  const { requests: redir } = mockTransport(t, [
    { status: 302, headers: { location: '/moved.png' }, produce() {} },
    { body: png },
  ]);
  await safeFetchBuffer('http://93.184.216.34/pic', 12, { headers: { referer: 'https://tieba.baidu.com/' } });
  assert.equal(redir[0].options.headers.referer, 'https://tieba.baidu.com/');
  assert.equal(redir[1].options.headers.referer, 'https://tieba.baidu.com/', '同源重定向必须保留');
  const { requests: cross } = mockTransport(t, [
    { status: 302, headers: { location: 'http://93.184.216.34:8080/moved.png' }, produce() {} },
    { body: png },
  ]);
  await safeFetchBuffer('http://93.184.216.34/pic', 12, { headers: { cookie: 'a=1' } });
  assert.equal(cross[0].options.headers.cookie, 'a=1');
  assert.equal(cross[1].options.headers.cookie, undefined, '跨源重定向必须丢掉追加头');

  // 防护照旧：覆盖 host / 头注入 / 非法类型 / 内网地址，全部在发请求前拒绝。
  const { requests: guard } = mockTransport(t, []);
  await assert.rejects(safeFetchBuffer('http://93.184.216.34/', 12, { headers: { Host: 'evil.test' } }), /host/);
  await assert.rejects(safeFetchBuffer('http://93.184.216.34/', 12, { headers: { referer: 'a\r\nx-evil: 1' } }), /换行/);
  await assert.rejects(safeFetchBuffer('http://93.184.216.34/', 12, { headers: 'referer' }), /普通对象/);
  await assert.rejects(safeFetchBuffer('http://127.0.0.1/', 12, { headers: { referer: 'https://tieba.baidu.com/' } }), /禁止/);
  await assert.rejects(safeFetchBuffer('http://[::1]/', 12, { headers: { referer: 'https://tieba.baidu.com/' } }), /禁止/);
  assert.equal(guard.length, 0, '这些调用一个请求都不该发出去');

  // 跳转到内网：带着追加头也照旧在**最终目标**上被拒。
  mockTransport(t, [{ status: 302, headers: { location: 'http://127.0.0.1/x.png' }, produce() {} }]);
  await assert.rejects(safeFetchBuffer('http://93.184.216.34/', 12, { headers: { referer: 'https://tieba.baidu.com/' } }), /禁止/);
});

test('text and image requests have a total deadline despite continuous incoming data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { requests, responses } = mockTransport(t, [{ produce() {} }, { produce() {} }]);
  for (const fetcher of [safeFetch, safeFetchBuffer]) {
    const pending = fetcher('http://93.184.216.34/');
    const rejected = assert.rejects(pending, /请求超时/);
    // Let URL validation and the mocked response callback complete.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    t.mock.timers.tick(19000);
    responses.at(-1).write(Buffer.from('a'));
    t.mock.timers.tick(1000);
    await rejected;
    assert.equal(requests.at(-1).req.destroyed, true);
    assert.equal(responses.at(-1).destroyed, true);
  }
});

test('aborted bodies reject instead of leaving the operation pending', async (t) => {
  mockTransport(t, [{ produce: (res) => res.emit('aborted') }]);
  await assert.rejects(safeFetch('http://93.184.216.34/'), /中断/);
});

test('invalid resource limits are rejected before network access', async (t) => {
  mockTransport(t, []);
  for (const limit of [0, -1, NaN, Infinity, 1.5]) {
    await assert.rejects(safeFetch('http://93.184.216.34/', limit), /正整数/);
    await assert.rejects(safeFetchBuffer('http://93.184.216.34/', limit), /正整数/);
  }
});
