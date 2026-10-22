// 三条纯缝（console-input / persona-text / image-format）的真实桥接边界集成测试。
//
// 只使用 audit-bridge-harness 的隔离 VM：源码在临时目录里执行，临时 config/role，
// FakeBot 不联网、不发 QQ。目的是证明入口里的八个 persona/image 薄适配器（以及
// currentRoleHintV2 / fetchOneBotImage / sendToQQ 这些真实消费点）确实在调用被抽出的
// 模块实现，而不是在入口里留了一份内联副本。第九条 console-input 缝由下面的
// 真实 HTTP /api/dsh/model 哨兵用例单独证明（鉴权之后才进入导入实现）。
// 模块本身的逐字节语义由各自 direct 测试负责。
//
// 变异证据：bridgeHarness 的 globals 在 coreBindings 之后展开，因此测试可以把某个
// 注入绑定替换成计数器桩；适配器若绕过导入实现、自己内联了逻辑，计数就不会增加。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { httpFail } from '../src/core/model-policy.mjs';

const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';

// 只构造 getImageDimensions 需要的 PNG 头（签名 + IHDR 宽高），不携带真实像素数据。
// 9000 × 9000 = 81,000,000 > MAX_MEDIA_PIXELS(64,000,000)，用于证明入口仍执行原始像素上限。
function pngHeader(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('入口八个 persona/image 薄适配器调用被抽出的模块实现（变异证据）', async () => {
  const calls = {
    cjkLikeChar: 0, convertExampleSpaces: 0, cjkSpaceWarning: 0, splitBoundaryWarning: 0,
    detectImageMime: 0, imageMimeFromUrl: 0, imageDimensions: 0, parseImageBase64: 0
  };
  const h = await bridgeHarness({
    globals: {
      cjkLikeChar: (ch) => { calls.cjkLikeChar += 1; return `cjk:${ch}`; },
      convertExampleSpaces: (line) => { calls.convertExampleSpaces += 1; return `conv:${line}`; },
      cjkSpaceWarning: (messages) => { calls.cjkSpaceWarning += 1; return `space:${messages.length}`; },
      splitBoundaryWarning: (messages) => { calls.splitBoundaryWarning += 1; return `split:${messages.length}`; },
      detectImageMime: (buf) => { calls.detectImageMime += 1; return `mime:${buf.length}`; },
      imageMimeFromUrl: (url, fallback) => { calls.imageMimeFromUrl += 1; return `url:${url}:${fallback}`; },
      imageDimensions: (buf) => { calls.imageDimensions += 1; return { width: buf.length, height: 7 }; },
      parseImageBase64: (value) => { calls.parseImageBase64 += 1; return `b64:${value}`; }
    }
  });
  try {
    const baseline = { ...calls };
    assert.equal(h.isCjkLikeChar('中'), 'cjk:中');
    assert.equal(h.convertExampleSpacesToComma('你 好'), 'conv:你 好');
    assert.equal(h.findCjkSpaceWarning(['a', 'b']), 'space:2');
    assert.equal(h.findSplitBoundaryWarning(['a', 'b']), 'split:2');
    const bytes = Buffer.from([1, 2, 3]);
    assert.equal(h.mimeFromBuffer(bytes), 'mime:3');
    assert.equal(h.mimeFromUrl('https://fixture.invalid/a.png', 'image/webp'), 'url:https://fixture.invalid/a.png:image/webp');
    assert.deepEqual(h.getImageDimensions(bytes), { width: 3, height: 7 });
    assert.equal(h.base64FromMaybe('base64://AA=='), 'b64:base64://AA==');
    for (const name of Object.keys(calls)) {
      assert.equal(calls[name] - baseline[name], 1, `${name} 应被入口适配器调用一次`);
    }
    // 默认参数语义留给 direct 测试；这里只确认入口没有把 fallback 写死成别的值。
    assert.equal(h.mimeFromUrl('https://fixture.invalid/a.png'), 'url:https://fixture.invalid/a.png:image/jpeg');
  } finally {
    await h.close();
  }
});

test('第九条 console-input 缝：/api/dsh/model 鉴权后才进入导入实现（HTTP 哨兵）', async () => {
  const parserCalls = [];
  const h = await bridgeHarness({
    globals: {
      parseModelUpdateInput: (body) => {
        parserCalls.push(body);
        throw httpFail(400, 'sentinel: parser reached');
      }
    }
  });
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const request = ({ body, token }) => new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/dsh/model',
      headers: {
        'content-type': 'application/json', 'content-length': payload.length,
        ...(token === null ? {} : { 'x-console-token': token })
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  let server;
  try {
    h.setReady(true);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const configFile = path.join(h.temp, 'config.json');
    const beforeConfig = sha256(configFile);
    const beforeCfg = JSON.stringify(h.cfg);

    const unauthorized = await request({ body: { model: 'MiniMax-M3' }, token: null });
    assert.equal(unauthorized.status, 401, `未带令牌应 401，实得 ${unauthorized.status} ${unauthorized.text}`);
    assert.equal(parserCalls.length, 0, '鉴权失败时不应进入 parsing');

    const reached = await request({ body: { model: 'MiniMax-M3' }, token: 'fixture-console-token' });
    assert.equal(reached.status, 400, `哨兵应返回 400，实得 ${reached.status} ${reached.text}`);
    assert.match(String(reached.json?.error ?? ''), /sentinel: parser reached/);
    assert.equal(parserCalls.length, 1, '鉴权通过后导入实现应恰好被调用一次');
    assert.equal(parserCalls[0]?.model, 'MiniMax-M3', '解析器应拿到原始请求体');
    assert.equal(sha256(configFile), beforeConfig, '哨兵失败不得改盘');
    assert.equal(JSON.stringify(h.cfg), beforeCfg, '哨兵失败不得改内存配置');
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    await h.close();
  }
});

test('currentRoleHintV2 用临时人格卡完成示例空格→逗号转换', async () => {
  const h = await bridgeHarness();
  try {
    const roleName = '集成测试人格';
    fs.mkdirSync(path.join(h.temp, 'roles'), { recursive: true });
    fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: roleName, mode: 'reserved2' }));
    fs.writeFileSync(path.join(h.temp, 'roles', `${roleName}.md`), [
      '# 测试人格',
      '〔二代〕设定：说话短。',
      '## 〔二代〕回复示例',
      '你好 今天 过得 怎么样',
      '## 〔一代〕指令',
      '[SILENT] 不回复',
      ''
    ].join('\n'));
    const hint = h.currentRoleHintV2();
    assert.match(hint, /你好，今天，过得，怎么样/, '示例行的中文空格应经导入实现转成逗号');
    assert.doesNotMatch(hint, /你好 今天/, '入口不应保留未转换的示例行');
    assert.doesNotMatch(hint, /\[SILENT\]/, '一代指令仍在入口按行过滤');
  } finally {
    await h.close();
  }
});

test('fetchOneBotImage 经 FakeBot 走通 base64 → MIME → 尺寸链', async () => {
  const h = await bridgeHarness();
  try {
    const img = await h.fetchOneBotImage({ kind: 'image', file: 'fixture-1x1.png' });
    assert.ok(img && Buffer.isBuffer(img.buffer), '应返回真实字节');
    assert.equal(img.mimeType, 'image/png');
    assert.deepEqual(h.calls.images, ['fixture-1x1.png'], '只在安全缓存文件名时才交给网关 get_image');
    assert.equal(img.buffer.length, Buffer.from(PNG_1X1_BASE64, 'base64').length);
  } finally {
    await h.close();
  }
});

test('fetchOneBotImage 对超大像素图片仍返回 null（原始 64M 像素上限）', async () => {
  const oversized = pngHeader(9000, 9000);
  const h = await bridgeHarness({ globals: { safeFetchBuffer: async () => ({ buffer: oversized }) } });
  try {
    const img = await h.fetchOneBotImage({ kind: 'image', url: 'https://fixture.invalid/oversized.png' });
    assert.equal(img, null, '超过像素上限时入口必须丢弃图片');
  } finally {
    await h.close();
  }
});

test('sendToQQ 仍是可用真实消费点（FakeBot 记录发送）', async () => {
  const h = await bridgeHarness();
  try {
    await h.sendToQQ('private:123', 'focused seam fixture');
    assert.deepEqual(h.calls.sent.at(-1), { kind: 'private', id: 123, text: 'focused seam fixture' });
  } finally {
    await h.close();
  }
});
