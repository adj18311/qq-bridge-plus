// Direct offline test for the extracted pure image-format seam.
// Oracle = the frozen 2026-10-20 snapshot scripts/fixtures/image-format-baseline.mjs, whose four
// bodies were verified sha256-identical to src/bridge.js at faaa226 lines 8979-9061.
// The production module is the unit under test; its exports are never used to derive expectations.
// Everything runs in-process on real Buffers/strings: no bridge, config, gateway, network or fs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as image from '../src/core/image-format.mjs';
import * as legacy from './fixtures/image-format-baseline.mjs';

const MODULE_URL = new URL('../src/core/image-format.mjs', import.meta.url);
const FIXTURE_URL = new URL('./fixtures/image-format-baseline.mjs', import.meta.url);
const RENAMED = {
  detectImageMime: 'mimeFromBuffer',
  imageMimeFromUrl: 'mimeFromUrl',
  imageDimensions: 'getImageDimensions',
  parseImageBase64: 'base64FromMaybe',
};
const FROZEN_BODY_SHA256 = {
  mimeFromBuffer: '82a0ec4cbbbd72caa585d65dbce7c3cde8a1f5994696a421b933947b30fbb973',
  mimeFromUrl: '886d60075f06d316f5b42871b3f20ad38c775bcc8cb412616e2ebaf2952e2bb7',
  getImageDimensions: 'ff8ec0806e9e1c928525d4706f6da1ecb89d6d7c4b3f97985d73527b4a072484',
  base64FromMaybe: '51b6a104746ee6cf11179d723c4947af29307d1d999ae7f358659949747c47f8',
};

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const readSource = (url) => fs.readFileSync(url, 'utf8').replaceAll('\r\n', '\n');

function extractFunction(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `missing declaration: ${declaration}`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `unterminated declaration: ${declaration}`);
  return source.slice(start, end + 2);
}

function capture(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    if (error instanceof Error) return { error: { name: error.name, message: error.message } };
    return { error: { thrown: String(error) } };
  }
}

// Fresh arguments per side: the oracle must never see state already touched by the unit.
function differential(name, makeArgs) {
  const expected = capture(() => legacy[RENAMED[name]](...makeArgs()));
  const actual = capture(() => image[name](...makeArgs()));
  assert.deepEqual(actual, expected);
  return actual;
}

function assertExplicit(name, makeArgs, expectedValue) {
  const actual = differential(name, makeArgs);
  assert.deepEqual(actual, { value: expectedValue });
  return actual;
}

const signature = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
  gif87: Buffer.from('GIF87a', 'ascii'),
  gif89: Buffer.from('GIF89a', 'ascii'),
  webp: Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]),
  unknown: Buffer.alloc(12),
};

function prefixed(prefix, length) {
  const buffer = Buffer.alloc(length);
  prefix.copy(buffer, 0, 0, Math.min(length, prefix.length));
  return buffer;
}

function pngBuffer(width, height, length = 24) {
  const buffer = Buffer.alloc(Math.max(24, length));
  signature.png.copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function gifBuffer(label, width, height, length = 24) {
  const buffer = Buffer.alloc(Math.max(24, length));
  buffer.write(label, 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

// JPEG segment body layout: [FF marker LEN(2)] then payload; SOF height at offset+5,
// width at offset+7, exactly like the legacy walk reads them.
function jpegSegment(marker, length, fill = 0) {
  const buffer = Buffer.alloc(2 + length, fill);
  buffer[0] = 0xff;
  buffer[1] = marker;
  buffer.writeUInt16BE(length, 2);
  return buffer;
}

function sofSegment(marker, height, width, length = 9) {
  const buffer = jpegSegment(marker, length);
  buffer[4] = 8;
  buffer.writeUInt16BE(height, 5);
  buffer.writeUInt16BE(width, 7);
  return buffer;
}

function jpegBuffer(parts, padTo = 24) {
  const buffer = Buffer.concat([Buffer.from([0xff, 0xd8]), ...parts]);
  return buffer.length >= padTo ? buffer : Buffer.concat([buffer, Buffer.alloc(padTo - buffer.length)]);
}

function webpBuffer(fourcc, length, bytes = {}) {
  const buffer = Buffer.alloc(Math.max(16, length));
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write(fourcc, 12, 'ascii');
  for (const [index, value] of Object.entries(bytes)) buffer[Number(index)] = value;
  return buffer;
}

test('module exposes exactly the four renamed pure exports with one-argument signatures', () => {
  assert.deepEqual(Object.keys(image).sort(), [
    'detectImageMime',
    'imageDimensions',
    'imageMimeFromUrl',
    'parseImageBase64',
  ]);
  assert.equal('default' in image, false);
  for (const name of Object.keys(RENAMED)) {
    assert.equal(typeof image[name], 'function', name);
    // The legacy bodies keep their arity: value/url only (imageMimeFromUrl has a defaulted 2nd arg).
    assert.equal(image[name].length, 1, `${name} arity`);
  }
});

test('module source is self-contained: no imports, require, network, fs, process or environment access', () => {
  const source = readSource(MODULE_URL);
  const forbidden = [
    [/^\s*import\b/m, 'import statement'],
    [/^\s*export\s+\{[^}]*\}\s+from\b/m, 'export-from re-export'],
    [/\brequire\s*\(/, 'require()'],
    [/\bnode:/, 'node: specifier'],
    [/\bimport\s*\(/, 'dynamic import'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bprocess\b/, 'process'],
    [/\bglobalThis\b/, 'globalThis'],
    [/\bcreateRequire\b/, 'createRequire'],
    [/\bchild_process\b/, 'child_process'],
    [/\bXMLHttpRequest\b|\bWebSocket\b/, 'network client'],
    [/\bfs\s*\./, 'fs access'],
    [/\bMath\.random\b/, 'nondeterminism'],
  ];
  for (const [pattern, label] of forbidden) assert.equal(pattern.test(source), false, label);
  // Only the plain exports above may appear.
  const exportsFound = [...source.matchAll(/^export function (\w+)\(/gm)].map((match) => match[1]).sort();
  assert.deepEqual(exportsFound, Object.keys(RENAMED).sort());
});

test('frozen oracle bodies still hash to the faaa226 bridge slice and never import the new module', () => {
  const fixture = readSource(FIXTURE_URL);
  for (const [legacyName, expected] of Object.entries(FROZEN_BODY_SHA256)) {
    const body = extractFunction(fixture, `export function ${legacyName}(`)
      .replace(`export function ${legacyName}(`, `function ${legacyName}(`);
    assert.equal(sha256(body), expected, legacyName);
  }
  // Comments may name it, but executable oracle code must not depend on the unit under test.
  assert.equal(/^\s*import\b/m.test(fixture), false, 'fixture must not import anything');
  assert.equal(fixture.includes('../src/core/image-format.mjs'), false);
});

test('module bodies are mechanical copies: only the four declared export names differ', () => {
  const moduleSource = readSource(MODULE_URL);
  const fixture = readSource(FIXTURE_URL);
  for (const [newName, legacyName] of Object.entries(RENAMED)) {
    const newBody = extractFunction(moduleSource, `export function ${newName}(`);
    const legacyBody = extractFunction(fixture, `export function ${legacyName}(`)
      .replace(`export function ${legacyName}(`, `export function ${newName}(`);
    assert.equal(newBody, legacyBody, `${newName} must stay a verbatim copy of ${legacyName}`);
    assert.equal(newBody.split('\n').length, legacyBody.split('\n').length, `${newName} line count`);
  }
});

test('mime detection: signatures, defaults, priority and the strict length-12 guard', () => {
  const explicit = [
    [prefixed(signature.png, 12), 'image/png'],
    [prefixed(signature.png, 24), 'image/png'],
    [prefixed(signature.jpeg, 12), 'image/jpeg'],
    [prefixed(signature.gif87, 12), 'image/gif'],
    [prefixed(signature.gif89, 12), 'image/gif'],
    [prefixed(signature.webp, 12), 'image/webp'],
    [prefixed(signature.unknown, 12), 'image/jpeg'],
    [Buffer.from('GIF88a'), 'image/jpeg'],
    [prefixed(Buffer.from('RIFF'), 12), 'image/jpeg'],
    [Buffer.alloc(0), 'image/jpeg'],
    [Buffer.from([0x89, 0x50, 0x4e]), 'image/jpeg'],
    [prefixed(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 8), 'image/jpeg'],
    [Buffer.from([0xff, 0xd8]), 'image/jpeg'],
    [Buffer.from([0x47, 0x49, 0x46]), 'image/jpeg'],
  ];
  for (const [buffer, expected] of explicit) {
    assertExplicit('detectImageMime', () => [buffer], expected);
  }
  // Every length 0..31 for each signature: 0..11 falls back, 12+ detects.
  const formats = [
    ['png', signature.png, 'image/png'],
    ['gif87', signature.gif87, 'image/gif'],
    ['gif89', signature.gif89, 'image/gif'],
    ['webp', signature.webp, 'image/webp'],
    ['jpeg', signature.jpeg, 'image/jpeg'],
  ];
  for (const [label, prefix, detected] of formats) {
    for (let length = 0; length <= 31; length++) {
      const expected = length < 12 ? 'image/jpeg' : detected;
      assertExplicit('detectImageMime', () => [prefixed(prefix, length)], expected);
      assert.equal(image.detectImageMime(prefixed(prefix, length)), expected, `${label} len=${length}`);
    }
  }
});

test('dimension guard: lengths 0..23 are null for every signature, 24 is the first readable size', () => {
  for (let length = 0; length <= 23; length++) {
    for (const [label, prefix] of Object.entries(signature)) {
      assertExplicit('imageDimensions', () => [prefixed(prefix, length)], null);
      assert.equal(image.imageDimensions(prefixed(prefix, length)), null, `${label} len=${length}`);
    }
  }
  assertExplicit('imageDimensions', () => [null], null);
  assertExplicit('imageDimensions', () => [undefined], null);
  assertExplicit('imageDimensions', () => [0], null);
  assertExplicit('imageDimensions', () => [false], null);
  assertExplicit('imageDimensions', () => [''], null);
  // Exactly 24 bytes is the smallest input the legacy guard lets through.
  assertExplicit('imageDimensions', () => [pngBuffer(0, 0)], { width: 0, height: 0 });
  assertExplicit('imageDimensions', () => [gifBuffer('GIF89a', 0, 0)], { width: 0, height: 0 });
  assertExplicit('imageDimensions', () => [jpegBuffer([])], null);
  assertExplicit('imageDimensions', () => [webpBuffer('VP8X', 24)], null);
  assertExplicit('imageDimensions', () => [webpBuffer('VP8L', 24)], null);
  assertExplicit('imageDimensions', () => [webpBuffer('VP8 ', 24)], null);
});

test('PNG dimensions: big-endian, unsigned 32-bit, including values beyond 16 bits', () => {
  const cases = [
    [1, 1],
    [200, 100],
    [65535, 65536],
    [70000, 131072],
    [0xffffffff, 0xffffffff],
    [0, 0x01020304],
  ];
  for (const [width, height] of cases) {
    assertExplicit('imageDimensions', () => [pngBuffer(width, height)], { width, height });
  }
});

test('GIF dimensions: little-endian 16-bit for both GIF87a and GIF89a', () => {
  const cases = [
    ['GIF87a', 640, 480],
    ['GIF89a', 640, 480],
    ['GIF89a', 1, 1],
    ['GIF87a', 65535, 65535],
    ['GIF89a', 0x0102, 0x0304],
  ];
  for (const [label, width, height] of cases) {
    assertExplicit('imageDimensions', () => [gifBuffer(label, width, height)], { width, height });
  }
});

test('JPEG marker walk: SOF0-SOF15 except C4/C8/CC, restart/standalone skips and length failures', () => {
  // Every SOF marker 0xC0..0xCF; only DHT C4, JPG C8 and DAC CC are excluded.
  for (let marker = 0xc0; marker <= 0xcf; marker++) {
    const skipped = [0xc4, 0xc8, 0xcc].includes(marker);
    const expected = skipped ? null : { height: 480, width: 640 };
    assertExplicit('imageDimensions', () => [jpegBuffer([sofSegment(marker, 480, 640)])], expected);
  }
  // Excluded marker first, later SOF still wins.
  assertExplicit(
    'imageDimensions',
    () => [jpegBuffer([sofSegment(0xc4, 1, 2), sofSegment(0xc0, 480, 640)])],
    { height: 480, width: 640 },
  );
  // Restart markers RST0-RST7 and standalone SOI/EOI are skipped by two bytes.
  for (let marker = 0xd0; marker <= 0xd7; marker++) {
    assertExplicit(
      'imageDimensions',
      () => [jpegBuffer([Buffer.from([0xff, marker]), sofSegment(0xc2, 90, 120)])],
      { height: 90, width: 120 },
    );
  }
  for (const marker of [0xd8, 0xd9]) {
    assertExplicit(
      'imageDimensions',
      () => [jpegBuffer([Buffer.from([0xff, marker]), sofSegment(0xc1, 90, 120)])],
      { height: 90, width: 120 },
    );
  }
  // Non-0xFF filler advances one byte at a time. The filler must come after a real segment:
  // the JPEG branch itself is only entered when bytes 0..2 are FF D8 FF.
  assertExplicit(
    'imageDimensions',
    () => [jpegBuffer([jpegSegment(0xe0, 4), Buffer.from([0x00, 0x11]), sofSegment(0xc0, 7, 8)])],
    { height: 7, width: 8 },
  );
  // Segment lengths below 2 abort the walk immediately, even if a valid SOF follows.
  for (const declaredLength of [0, 1]) {
    const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, declaredLength]);
    const buffer = Buffer.concat([broken, sofSegment(0xc0, 480, 640)]);
    assertExplicit(
      'imageDimensions',
      () => [buffer.length >= 24 ? buffer : Buffer.concat([buffer, Buffer.alloc(24 - buffer.length)])],
      null,
    );
  }
  // Truncated segment: declared length runs past the buffer, the walk just ends.
  assertExplicit(
    'imageDimensions',
    () => [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe2, 0xff, 0xff]), Buffer.alloc(18)])],
    null,
  );
  // Strict loop guard: a SOF starting with only 9 bytes left is not examined (offset+9 < length).
  const filler = jpegSegment(0xe0, 11);
  const atGuard = jpegBuffer([filler, sofSegment(0xc0, 480, 640, 7)]);
  assert.equal(atGuard.length, 24);
  assertExplicit('imageDimensions', () => [atGuard], null);
  const oneMore = Buffer.concat([atGuard, Buffer.alloc(1)]);
  assertExplicit('imageDimensions', () => [oneMore], { height: 480, width: 640 });
});

test('WebP variants: VP8X/VP8L/VP8 length boundaries, masks, maxima and fourcc dispatch', () => {
  // VP8X leaves width/height bytes at 24..29 and needs length >= 30.
  assertExplicit('imageDimensions', () => [webpBuffer('VP8X', 29, { 24: 1, 25: 2, 26: 3 })], null);
  assertExplicit(
    'imageDimensions',
    () => [webpBuffer('VP8X', 30, { 24: 1, 25: 2, 26: 3, 27: 4, 28: 5, 29: 6 })],
    { width: 197122, height: 394501 },
  );
  assertExplicit(
    'imageDimensions',
    () => [webpBuffer('VP8X', 30, { 24: 255, 25: 255, 26: 255, 27: 255, 28: 255, 29: 255 })],
    { width: 16777216, height: 16777216 },
  );
  assertExplicit('imageDimensions', () => [webpBuffer('VP8X', 30)], { width: 1, height: 1 });
  assertExplicit(
    'imageDimensions',
    () => [webpBuffer('VP8X', 31, { 24: 0, 25: 0, 26: 0, 27: 0, 28: 0, 29: 0 })],
    { width: 1, height: 1 },
  );

  // VP8L needs length >= 25 and packs 14-bit width/height in bytes 21..24.
  assertExplicit('imageDimensions', () => [webpBuffer('VP8L', 24, { 21: 0xff, 22: 0xff, 23: 0xff })], null);
  assertExplicit(
    'imageDimensions',
    () => [webpBuffer('VP8L', 25, { 21: 255, 22: 255, 23: 255, 24: 255 })],
    { width: 16384, height: 16384 },
  );
  // Byte 22 supplies width bits 0..5 and height bits 0..1 (masked, not adjacent arithmetic).
  assertExplicit(
    'imageDimensions',
    () => [webpBuffer('VP8L', 25, { 21: 0, 22: 0xc1, 23: 0, 24: 0 })],
    { width: 257, height: 4 },
  );
  // Bits 4..7 of byte 24 are ignored: 0xFF and 0x0F produce the same height.
  const vp8lHigh = webpBuffer('VP8L', 25, { 21: 0, 22: 0, 23: 0, 24: 0xff });
  const vp8lTrimmed = webpBuffer('VP8L', 25, { 21: 0, 22: 0, 23: 0, 24: 0x0f });
  assertExplicit('imageDimensions', () => [vp8lHigh], { width: 1, height: 15361 });
  assertExplicit('imageDimensions', () => [vp8lTrimmed], { width: 1, height: 15361 });

  // VP8 (fourcc with trailing space) needs length >= 30 and masks 14 bits, without +1.
  assertExplicit('imageDimensions', () => [webpBuffer('VP8 ', 29, { 26: 0xff, 27: 0xff, 28: 0xff })], null);
  assertExplicit(
    'imageDimensions',
    () => [webpBuffer('VP8 ', 30, { 26: 0xff, 27: 0xff, 28: 0xff, 29: 0xff })],
    { width: 16383, height: 16383 },
  );
  assertExplicit('imageDimensions', () => [webpBuffer('VP8 ', 30)], { width: 0, height: 0 });
  assertExplicit(
    'imageDimensions',
    () => [webpBuffer('VP8 ', 30, { 26: 0x00, 27: 0x40, 28: 0x00, 29: 0x40 })],
    { width: 0, height: 0 },
  );
  assertExplicit(
    'imageDimensions',
    () => [webpBuffer('VP8 ', 30, { 26: 0x40, 27: 0x40, 28: 0x40, 29: 0x40 })],
    { width: 64, height: 64 },
  );

  // Unknown/off-by-one fourcc, RIFF without WEBP and WEBP without RIFF all fall through to null.
  for (const fourcc of ['ALPH', 'VP8\0', 'VP8x']) {
    assertExplicit('imageDimensions', () => [webpBuffer(fourcc, 30, { 24: 1, 25: 1, 26: 1 })], null);
  }
  const noWebp = webpBuffer('VP8 ', 30, { 8: 0x58 });
  assertExplicit('imageDimensions', () => [noWebp], null);
  const noRiff = webpBuffer('VP8 ', 30);
  noRiff[0] = 0x00;
  assertExplicit('imageDimensions', () => [noRiff], null);
  // The mime helper still reports WebP at a 12-byte length where dimensions are unreadable.
  assertExplicit('detectImageMime', () => [webpBuffer('VP8X', 12)], 'image/webp');
  assertExplicit('imageDimensions', () => [webpBuffer('VP8X', 12)], null);
});

test('MIME from URL: extensions, case, query/hash, invalid input, coercion and custom fallback', () => {
  const cases = [
    ['https://cdn.example/a.png', 'image/png'],
    ['https://cdn.example/a.PNG', 'image/png'],
    ['https://cdn.example/a.png?x=1.gif', 'image/png'],
    ['https://cdn.example/a.png#frag.jpg', 'image/png'],
    ['HTTPS://CDN.EXAMPLE/A.WEBP', 'image/webp'],
    ['https://cdn.example/a.webp', 'image/webp'],
    ['https://cdn.example/a.gif', 'image/gif'],
    ['https://cdn.example/a.jpg', 'image/jpeg'],
    ['https://cdn.example/a.jpeg', 'image/jpeg'],
    ['https://cdn.example/a.JPEG?size=2', 'image/jpeg'],
    ['file:///tmp/a.png', 'image/png'],
    ['https://cdn.example/a.bmp', 'image/jpeg'],
    ['https://cdn.example/a.png/', 'image/jpeg'],
    ['https://cdn.example/dir.png/file', 'image/jpeg'],
    ['https://cdn.example', 'image/jpeg'],
    ['a.png', 'image/jpeg'],
    ['/tmp/a.png', 'image/jpeg'],
    ['', 'image/jpeg'],
    ['https://[invalid', 'image/jpeg'],
    ['not a url', 'image/jpeg'],
    ['https://cdn.example/a%2Epng', 'image/jpeg'],
    ['data:image/png;base64,AAAA', 'image/jpeg'],
    [123, 'image/jpeg'],
    [null, 'image/jpeg'],
    [undefined, 'image/jpeg'],
    [Symbol('url'), 'image/jpeg'],
    [new URL('https://cdn.example/a.webp'), 'image/webp'],
  ];
  for (const [url, expected] of cases) {
    assertExplicit('imageMimeFromUrl', () => [url], expected);
  }
  assertExplicit(
    'imageMimeFromUrl',
    () => [{ toString: () => 'https://cdn.example/a.gif' }],
    'image/gif',
  );
  // Throwing coercion is swallowed by the legacy try/catch and falls back.
  assertExplicit(
    'imageMimeFromUrl',
    () => [{ toString() { throw new Error('coercion blocked'); } }],
    'image/jpeg',
  );
  // Custom fallback is returned by identity, including falsy/object values.
  const custom = { kind: 'custom-fallback' };
  const actual = differential('imageMimeFromUrl', () => ['relative/a.bmp', custom]);
  assert.equal(actual.value, custom);
  assert.equal(image.imageMimeFromUrl('relative/a.bmp', custom), custom);
  assertExplicit('imageMimeFromUrl', () => ['relative/a.bmp', 'image/bmp'], 'image/bmp');
  assertExplicit('imageMimeFromUrl', () => ['relative/a.bmp', undefined], 'image/jpeg');
  assertExplicit('imageMimeFromUrl', () => ['relative/a.bmp', null], null);
  assertExplicit('imageMimeFromUrl', () => ['relative/a.bmp', ''], '');
  assertExplicit('imageMimeFromUrl', () => ['https://cdn.example/a.svg', false], false);
});

test('base64 parsing: raw/data/base64:// prefixes, whitespace, nulls, permissiveness and invalid chars', () => {
  const cases = [
    ['YWJj', 'YWJj'],
    [' YWJj \n', 'YWJj'],
    ['YW Jj', 'YWJj'],
    ['YW\tJj\n', 'YWJj'],
    ['YW\u00a0Jj', 'YWJj'],
    ['\u00a0YWJj\u00a0', 'YWJj'],
    ['base64://YWJj', 'YWJj'],
    ['base64:// YW Jj', 'YWJj'],
    ['base64://\u00a0YWJj', 'YWJj'],
    ['base64://', ''],
    ['base64:// \n\t', ''],
    ['base64://data:image/png;base64,YWJj', 'data:image/png;base64,YWJj'],
    ['data:image/png;base64,YWJj', 'YWJj'],
    ['data:image/jpeg;base64, YWJj\n', 'YWJj'],
    ['data:image/gif;base64,', ''],
    ['data:image/svg+xml;base64,abc', 'abc'],
    ['data:image/png,***!!', '***!!'],
    ['data:image/png;base64', null],
    ['DATA:IMAGE/PNG;BASE64,YWJj', null],
    ['data:text/plain;base64,YWJj', null],
    ['YWJj===', 'YWJj==='],
    ['ab_cd', null],
    ['ab-cd', null],
    ['ab.cd', null],
    ['ab cd', 'abcd'],
    ['=', '='],
    ['====', '===='],
    ['YW😀Jj', null],
    ['😀', null],
    ['', null],
    ['   ', null],
    ['\n\t', null],
  ];
  for (const [input, expected] of cases) {
    assertExplicit('parseImageBase64', () => [input], expected);
  }
  for (const input of [null, undefined, 123, 0, true, {}, [], new String('YWJj'), Symbol('x'), Buffer.from('YWJj'), () => 'YWJj']) {
    assertExplicit('parseImageBase64', () => [input], null);
  }
  // A long permissive payload is returned as-is apart from whitespace removal.
  const long = ` ${'QUFB'.repeat(400)} \n`;
  assertExplicit('parseImageBase64', () => [long], 'QUFB'.repeat(400));
});

test('all four helpers leave their inputs untouched and are repeatable', () => {
  const buffer = pngBuffer(321, 123);
  const snapshot = Buffer.from(buffer);
  const base64 = Buffer.from('base64:// YWJj\n').toString('utf8');
  const urlObject = { toString: () => 'https://cdn.example/a.png' };
  const urlKeys = Object.keys(urlObject);

  const first = [
    image.detectImageMime(buffer),
    image.imageDimensions(buffer),
    image.parseImageBase64(base64),
    image.imageMimeFromUrl(urlObject),
  ];
  image.detectImageMime(buffer);
  image.imageDimensions(buffer);
  image.parseImageBase64(base64);
  image.imageMimeFromUrl(urlObject);
  const second = [
    image.detectImageMime(buffer),
    image.imageDimensions(buffer),
    image.parseImageBase64(base64),
    image.imageMimeFromUrl(urlObject),
  ];

  assert.deepEqual(first, second);
  assert.deepEqual(first, ['image/png', { width: 321, height: 123 }, 'YWJj', 'image/png']);
  assert.equal(Buffer.compare(buffer, snapshot), 0, 'image buffer must not be mutated');
  assert.equal(buffer.length, snapshot.length);
  assert.deepEqual(Object.keys(urlObject), urlKeys, 'url argument must not gain properties');
});

test('deterministic seeded fuzz: random lengths/payloads stay differential with stable coverage', () => {
  let seed = 0x20261020;
  const draw = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const prefixes = [
    Buffer.alloc(0),
    signature.png,
    signature.gif89,
    signature.jpeg,
    Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.from('VP8X', 'ascii')]),
    Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.from('VP8L', 'ascii')]),
    Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.from('VP8 ', 'ascii')]),
  ];
  const mimesSeen = new Set();
  let readableDimensions = 0;
  const base64Alphabet = 'ABCyz019+/=\n \t:;_-.';
  for (let index = 0; index < 600; index++) {
    const length = draw() % 96;
    const prefix = prefixes[draw() % prefixes.length];
    const buffer = Buffer.alloc(length);
    for (let offset = 0; offset < length; offset++) buffer[offset] = draw() & 0xff;
    prefix.copy(buffer, 0, 0, Math.min(length, prefix.length));

    const mime = assertExplicit('detectImageMime', () => [buffer], image.detectImageMime(buffer)).value;
    mimesSeen.add(mime);
    const dims = differential('imageDimensions', () => [buffer]);
    if (dims.value !== null && dims.value !== undefined) readableDimensions++;

    const base64ish = Array.from({ length: draw() % 40 }, () => base64Alphabet[draw() % base64Alphabet.length]).join('');
    assertExplicit('parseImageBase64', () => [base64ish], image.parseImageBase64(base64ish));

    const urlish = ['https://cdn.example/a', '.png', '.GIF', '.webp', '.jpeg', '?q=.png', '#f.jpg', 'x.bmp', ' ', '%', '['][draw() % 11];
    const url = `${['https://cdn.example/', 'http://', '/', '', 'not a url'][draw() % 5]}${urlish}`;
    differential('imageMimeFromUrl', () => [url]);
  }
  assert.deepEqual([...mimesSeen].sort(), ['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  assert.ok(readableDimensions > 0, 'fuzz must reach readable dimensions');
});

test('non-Buffer oddities keep the legacy coercion, defaults and thrown errors', () => {
  const oddities = [
    null,
    undefined,
    0,
    false,
    '',
    'x'.repeat(24),
    'x'.repeat(11),
    [],
    new Uint8Array(24),
    new DataView(new ArrayBuffer(24)),
    123,
    123n,
    Symbol('x'),
    { length: 24 },
    { length: 30, toString: () => 'GIF89a' },
    { length: 30, toString() { throw new Error('toString blocked'); } },
    { get length() { throw new Error('length getter blocked'); } },
    { length: 24, 0: 0x89, 1: 0x50, 2: 0x4e, 3: 0x47, toString: () => '', readUInt32BE: (offset) => (offset === 16 ? 200 : offset === 20 ? 100 : 0) },
  ];
  for (const value of oddities) {
    differential('detectImageMime', () => [value]);
    differential('imageDimensions', () => [value]);
  }
  // Uint8Array with a PNG signature passes header detection but has no Buffer readers.
  const typed = new Uint8Array(24);
  typed.set(signature.png);
  assertExplicit('detectImageMime', () => [typed], 'image/png');
  assertExplicit('imageDimensions', () => [typed], null);
  // A throwing length getter escapes before the try/catch in both implementations.
  const throwing = { get length() { throw new Error('length getter blocked'); } };
  assert.deepEqual(capture(() => image.imageDimensions(throwing)), {
    error: { name: 'Error', message: 'length getter blocked' },
  });
  assert.deepEqual(capture(() => image.detectImageMime(throwing)), {
    error: { name: 'Error', message: 'length getter blocked' },
  });
});
