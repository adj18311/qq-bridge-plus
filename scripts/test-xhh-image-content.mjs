import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleUrl = new URL('../plugins/xhh-quota-guard/image-content.mjs', import.meta.url);
const implementation = await import(moduleUrl).catch(() => ({}));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('安全下载小黑盒图片并生成模型图像，保留失败说明', async () => {
  assert.equal(typeof implementation.buildXhhImageContent, 'function');
  const calls = [];
  const result = await implementation.buildXhhImageContent([
    'https://imgheybox.max-c.com/a', 'https://evil.example/a', 'http://127.0.0.1/a',
    'https://imgheybox1.max-c.com/b',
  ], { fetchBuffer: async (url, max, opts) => { calls.push({ url, max, opts }); if (url.endsWith('/b')) throw new Error('fixture secret'); return { buffer: png }; } });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(result.content[0].data, 'base64'), png);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.allowRedirect, false);
  assert.match(result.notes.join(' '), /qq_send_image/);
  assert.match(result.notes.join(' '), /https:\/\/imgheybox\.max-c\.com\/a/);
  assert.ok(result.notes.length >= 3);
  assert.doesNotMatch(result.notes.join(' '), /fixture secret/);
});

test('限制数量和总字节，不发送不可识别的图片', async () => {
  assert.equal(typeof implementation.buildXhhImageContent, 'function');
  const urls = Array.from({length: 4}, (_, i) => `https://cdn.max-c.com/${i}`);
  let calls = 0;
  const result = await implementation.buildXhhImageContent(urls, { maxImages: 2, maxBytes: png.length, maxTotalBytes: png.length, fetchBuffer: async () => { calls++; return { buffer: png }; } });
  assert.equal(calls, 1);
  assert.equal(result.content.length, 1);
  assert.ok(result.notes.some((x) => /上限/.test(x)));
  const invalid = await implementation.buildXhhImageContent([urls[0]], { fetchBuffer: async () => ({ buffer: Buffer.from('not-a-picture') }) });
  assert.equal(invalid.content.length, 0);
});

test('仅有图片签名或被截断的内容不能当作图片送给模型', async () => {
  for (const bytes of [png.subarray(0, 12), png.subarray(0, png.length - 3), Buffer.from('ffd8ff000000000000000000', 'hex'), Buffer.from('47494638396101000100003b', 'hex'), Buffer.from('524946460400000057454250', 'hex')]) {
    const result = await implementation.buildXhhImageContent(['https://cdn.max-c.com/a'], { fetchBuffer: async () => ({ buffer: bytes }) });
    assert.equal(result.content.length, 0);
  }
});

test('WebP 扩展头没有图像帧不能作为图片', async () => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(22, 4); bytes.write('WEBPVP8X', 8); bytes.writeUInt32LE(10, 16);
  const result = await implementation.buildXhhImageContent(['https://cdn.max-c.com/a'], { fetchBuffer: async () => ({ buffer: bytes }) });
  assert.equal(result.content.length, 0);
});

test('合法的 GIF、JPEG 与 WebP 图片结构仍可提供给模型', async () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const webp = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=', 'base64');
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==', 'base64');
  for (const [bytes, mime] of [[gif, 'image/gif'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const result = await implementation.buildXhhImageContent(['https://cdn.max-c.com/a'], { fetchBuffer: async () => ({ buffer: bytes }) });
    assert.equal(result.content[0]?.mimeType, mime);
  }
});

test('仿冒域、用户信息、非标准端口与非 HTTPS 地址不能触发下载', async () => {
  let calls = 0;
  const result = await implementation.buildXhhImageContent([
    'https://imgheybox.max-c.com.evil.test/a',
    'https://evil-imgheybox.max-c.com/a',
    'https://user:pass@imgheybox.max-c.com/a',
    'https://imgheybox.max-c.com:8443/a',
    'http://imgheybox.max-c.com/a',
  ], { fetchBuffer: async () => { calls++; return { buffer: png }; } });
  assert.equal(calls, 0);
  assert.equal(result.content.length, 0);
  assert.equal(result.notes.length, 5);
});

test('整个取图过程有总时限，挂起时保留失败说明并不继续下载', async () => {
  let calls = 0;
  const result = await implementation.buildXhhImageContent(['https://cdn.max-c.com/a', 'https://cdn.max-c.com/b'], {
    maxDurationMs: 20,
    fetchBuffer: () => { calls++; return new Promise(() => {}); },
  });
  assert.equal(calls, 1);
  assert.equal(result.content.length, 0);
  assert.ok(result.notes.some((x) => /未取/.test(x)));
});

test('总时限和外部取消均通知下载器中止', async () => {
  let aborted = 0;
  const fetchBuffer = (_url, _max, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true });
  });
  await implementation.buildXhhImageContent(['https://cdn.max-c.com/a'], { maxDurationMs: 20, fetchBuffer });
  assert.equal(aborted, 1);
  const controller = new AbortController();
  const pending = implementation.buildXhhImageContent(['https://cdn.max-c.com/a'], { signal: controller.signal, fetchBuffer });
  controller.abort();
  await pending;
  assert.equal(aborted, 2);
});

test('部署包内安全下载模块与仓库权威实现逐字节一致', () => {
  const canonical = fs.readFileSync(new URL('../src/safe-fetch.js', import.meta.url));
  const bundled = fs.readFileSync(new URL('../plugins/xhh-quota-guard/safe-fetch.mjs', import.meta.url));
  assert.deepEqual(bundled, canonical);
});


// ---- 总预算 8 MiB 的保守取舍（2026-11-01 指令）----
// 用真实 PNG 结构造出指定字节数的图片：8 字节签名 + IHDR(25) + IDAT(12+N) + IEND(12) = 57 + N。
function pngOfSize(bytes) {
  if (!Number.isInteger(bytes) || bytes < 58) throw new Error('pngOfSize 太小');
  const idatLen = bytes - 57;
  const head = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(1, 8);   // width
  ihdr.writeUInt32BE(1, 12);  // height
  ihdr[16] = 8; ihdr[17] = 6; // 位深 / RGBA
  const idat = Buffer.alloc(12 + idatLen);
  idat.writeUInt32BE(idatLen, 0);
  idat.write('IDAT', 4, 'ascii');
  const iend = Buffer.alloc(12);
  iend.writeUInt32BE(0, 0);
  iend.write('IEND', 4, 'ascii');
  const buf = Buffer.concat([head, ihdr, idat, iend]);
  if (buf.length !== bytes) throw new Error('pngOfSize 计算不一致');
  return buf;
}

const MIB = 1024 * 1024;

test('2D-预算-1：合计接近 8 MiB 时全部提供（默认预算不变更小）', async () => {
  const sizes = [3 * MIB, Math.round(2.75 * MIB), 2 * MIB]; // 7.75 MiB（整数字节）
  const urls = sizes.map((_, i) => `https://cdn.max-c.com/budget-${i}`);
  const result = await implementation.buildXhhImageContent(urls, {
    fetchBuffer: async (url, max) => { const i = Number(url.slice(-1)); assert.ok(max >= sizes[i], '单张上限不应被预算压到小于图片本身'); return { buffer: pngOfSize(sizes[i]) }; },
  });
  assert.equal(result.content.length, 3, result.notes.join(' '));
  const provided = result.notes.filter((n) => n.includes('已提供图像内容')).length;
  assert.equal(provided, 3);
  for (const url of urls) assert.match(result.notes.join(' '), new RegExp(url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
});

test('2D-预算-2：恰好用满 8 MiB 后，后续图片如实说明「剩余总预算不足」', async () => {
  const four = pngOfSize(4 * MIB);
  const urls = ['https://cdn.max-c.com/a', 'https://cdn.max-c.com/b', 'https://cdn.max-c.com/c'];
  const result = await implementation.buildXhhImageContent(urls, { fetchBuffer: async () => ({ buffer: four }) });
  assert.equal(result.content.length, 2, result.notes.join(' '));
  const joined = result.notes.join(' ');
  assert.match(joined, /\[图片3：剩余总预算不足（已用 8\.00 MiB），未取\]/u);
  assert.doesNotMatch(joined, /\[图片3：获取失败或不符合图片限制/u);
  // 已取到的两张仍保留可发送地址
  assert.match(joined, /已提供图像内容，可用 qq_send_image 发送：https:\/\/cdn\.max-c\.com\/a/u);
  assert.match(joined, /已提供图像内容，可用 qq_send_image 发送：https:\/\/cdn\.max-c\.com\/b/u);
});

test('2D-预算-3：剩余预算不足导致取不到时，说明里写明剩余额度而不是笼统失败', async () => {
  const urls = ['https://cdn.max-c.com/big', 'https://cdn.max-c.com/next'];
  const result = await implementation.buildXhhImageContent(urls, {
    maxBytes: 3 * MIB,
    maxTotalBytes: 4 * MIB,
    fetchBuffer: async (url, max) => {
      // 第一次：3 MiB 用掉后只剩 1 MiB；第二次请求被压到 1 MiB，底层按“超过大小限制”拒绝
      if (url.endsWith('/big')) return { buffer: pngOfSize(3 * MIB) };
      assert.equal(max, 1 * MIB);
      throw new Error(`图片超过大小限制（${max} 字节）`);
    },
  });
  assert.equal(result.content.length, 1);
  const second = result.notes.find((n) => n.startsWith('[图片2：'));
  assert.match(second, /剩余总预算不足（剩余 1\.00 MiB）/u);
});

test('2D-预算-4：单张 4 MiB 上限与数量 10 张均未放宽', async () => {
  const tooBig = await implementation.buildXhhImageContent(['https://cdn.max-c.com/huge'], {
    fetchBuffer: async () => ({ buffer: pngOfSize(4 * MIB + 1) }),
  });
  assert.equal(tooBig.content.length, 0);
  assert.match(tooBig.notes.join(' '), /\[图片1：超过单张上限（4\.00 MiB），未取\]/u);

  const many = Array.from({ length: 11 }, (_, i) => `https://cdn.max-c.com/n${i}`);
  const eleven = await implementation.buildXhhImageContent(many, {
    fetchBuffer: async () => ({ buffer: pngOfSize(4096) }),
  });
  assert.equal(eleven.content.length, 10);
  assert.match(eleven.notes.join(' '), /\[图片11：超过数量上限，未取\]/u);
});

test('2D-预算-5：无图与失败路径不回归（不产生“无图”噪声说明）', async () => {
  const failed = await implementation.buildXhhImageContent(
    ['https://cdn.max-c.com/x', 'https://evil.example/y'],
    { fetchBuffer: async () => { throw new Error('boom'); } },
  );
  assert.equal(failed.content.length, 0);
  assert.match(failed.notes.join(' '), /\[图片1：获取失败或不符合图片限制，未取\]/u);
  assert.match(failed.notes.join(' '), /\[图片2：地址不在安全白名单，未取\]/u);
  assert.doesNotMatch(failed.notes.join(' '), /没有 images|coverImages/u);
});


test('2D-超时-1：单张超时要说「获取超时」，不能写成「已取消」', async () => {
  const result = await implementation.buildXhhImageContent(['https://cdn.max-c.com/slow'], {
    maxDurationMs: 120,
    fetchBuffer: () => new Promise(() => {}), // 永不 resolve
  });
  assert.equal(result.content.length, 0);
  const note = result.notes.join(' ');
  assert.match(note, /\[图片1：获取超时（本次剩余 120 毫秒 预算），未取\]/u, note);
  assert.doesNotMatch(note, /已取消/u);
});

test('2D-超时-2：外部取消仍写成「已取消」，与超时区分', async () => {
  const controller = new AbortController();
  const pending = implementation.buildXhhImageContent(['https://cdn.max-c.com/x'], {
    maxDurationMs: 5000,
    signal: controller.signal,
    fetchBuffer: () => new Promise(() => {}),
  });
  setTimeout(() => controller.abort(), 30);
  const result = await pending;
  const note = result.notes.join(' ');
  assert.match(note, /\[图片1：获取已取消，未取\]/u, note);
  assert.doesNotMatch(note, /获取超时/u);
});


test('2D-时长-1：时长格式化单位必须明确（秒 / 毫秒），且 20 秒默认预算显示为秒', () => {
  assert.equal(typeof implementation.formatDuration, 'function');
  const table = [
    [20000, '20 秒'],
    [1500, '1.5 秒'],
    [1000, '1 秒'],
    [999, '999 毫秒'],
    [120, '120 毫秒'],
    [0, '0 毫秒'],
    [-1, '未知时长'],
    [Number.NaN, '未知时长'],
  ];
  for (const [input, expected] of table) {
    assert.equal(implementation.formatDuration(input), expected, `formatDuration(${input})`);
  }
});

test('2D-时长-2：超时说明写毫秒/秒，绝不能出现字节单位', async () => {
  const result = await implementation.buildXhhImageContent(['https://cdn.max-c.com/slow'], {
    maxDurationMs: 120,
    fetchBuffer: () => new Promise(() => {}),
  });
  const note = result.notes.join(' ');
  assert.match(note, /\[图片1：获取超时（本次剩余 120 毫秒 预算），未取\]/u, note);
  assert.doesNotMatch(note, /KiB|MiB|B 预算|字节/u);
});

test('2D-时长-3：1.5 秒预算显示为 1.5 秒（同一格式化路径）', async () => {
  const result = await implementation.buildXhhImageContent(['https://cdn.max-c.com/slow'], {
    maxDurationMs: 1500,
    fetchBuffer: () => new Promise(() => {}),
  });
  const note = result.notes.join(' ');
  assert.match(note, /本次剩余 1\.5 秒 预算/u, note);
  assert.doesNotMatch(note, /毫秒/u);
});
