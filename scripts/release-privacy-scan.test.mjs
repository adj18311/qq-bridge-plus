import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRelease, loadSensitiveRules } from './release-privacy-scan.mjs';

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const SAMPLE_USER = 'release-user';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'release-privacy-test-'));
}

function writeFile(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('walks only the supplied package root and counts skipped directories', () => {
  const root = makeRoot();
  try {
    writeFile(root, 'src/app.js', 'export const ok = 1;' + NL);
    writeFile(root, '.git/config', 'ignored = 1' + NL);
    writeFile(root, 'node_modules/pkg/index.js', 'ignored = 1' + NL);
    const result = scanRelease({ root });
    assert.equal(result.scanned, 1);
    assert.equal(result.skipped.directories.git, 1);
    assert.equal(result.skipped.directories.node_modules, 1);
    assert.equal(result.findings.filter((f) => f.path.startsWith('node_modules/')).length, 0);
  } finally {
    cleanup(root);
  }
});

test('allows only the exact published LICENSE contact and reports any other LICENSE email', () => {
  const root = makeRoot();
  try {
    const publishedContact = ['motricseven', 'foxmail.com'].join('@');
    const unpublishedContact = ['license', 'owner', '4c1e'].join('.') + '@' + ['gmail', 'com'].join('.');
    writeFile(root, 'LICENSE', [
      'Copyright (c) 2026 SnowLuma project contributors',
      'Published third-party contact: ' + publishedContact,
      'Newly added private address: ' + unpublishedContact,
    ].join(NL) + NL);
    const result = scanRelease({ root });
    const reported = result.findings.filter((f) => f.path === 'LICENSE' && f.rule === 'email-address');
    assert.equal(reported.length, 1);
    assert.ok(result.classified['license-public-contact'] >= 1);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(publishedContact));
    assert.ok(!serialized.includes(unpublishedContact));
  } finally {
    cleanup(root);
  }
});

test('reports high-entropy JSON quoted credential literals but not placeholders', () => {
  const root = makeRoot();
  try {
    const apiKey = ['Zx9Qw2Er4', 'Ty6Ui8Op0'].join('');
    const password = ['Q7mN2pR5s', 'T8vW1xY4z'].join('');
    const token = ['Aa1Bb2Cc3', 'Dd4Ee5Ff6Gg7'].join('');
    const source = [
      '{',
      '  "api_key": "' + apiKey + '",',
      '  "password": "' + password + '",',
      '  "token": "' + token + '",',
      '  "client_secret": "YOUR_CLIENT_SECRET_HERE",',
      '}',
    ].join(NL);
    writeFile(root, 'src/settings.json', source + NL);
    const result = scanRelease({ root });
    const findings = result.findings.filter((f) => f.path === 'src/settings.json' && f.rule === 'credential-assignment');
    assert.equal(findings.length, 3);
    assert.ok(result.classified.placeholder >= 1);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(apiKey));
    assert.ok(!serialized.includes(password));
    assert.ok(!serialized.includes(token));
  } finally {
    cleanup(root);
  }
});

test('reports forbidden release files and directories', () => {
  const root = makeRoot();
  try {
    writeFile(root, 'config.json', '{}' + NL);
    writeFile(root, 'state/data.txt', 'x' + NL);
    writeFile(root, 'audio/a.mp3', 'x' + NL);
    writeFile(root, 'backup.zip', 'x' + NL);
    writeFile(root, 'docs/report.docx', 'x' + NL);
    writeFile(root, 'mail/inbox.eml', 'x' + NL);
    writeFile(root, 'img/screenshot.png', 'x' + NL);
    writeFile(root, '个人材料/简历.md', 'x' + NL);
    writeFile(root, 'privatekey.pem', 'x' + NL);
    writeFile(root, 'cookies.txt', 'x' + NL);
    const result = scanRelease({ root });
    const has = (p, rule) => result.findings.some((f) => f.path === p && f.rule === rule);
    assert.ok(has('config.json', 'forbidden-file'));
    assert.ok(has('state/', 'forbidden-directory'));
    assert.ok(has('audio/', 'forbidden-directory'));
    assert.ok(has('个人材料/', 'forbidden-directory'));
    assert.ok(has('backup.zip', 'forbidden-file'));
    assert.ok(has('docs/report.docx', 'forbidden-file'));
    assert.ok(has('mail/inbox.eml', 'forbidden-file'));
    assert.ok(has('img/screenshot.png', 'forbidden-file'));
    assert.ok(has('privatekey.pem', 'forbidden-file'));
    assert.ok(has('cookies.txt', 'forbidden-file'));
  } finally {
    cleanup(root);
  }
});

test('reports hardcoded secrets, QQ ids and real user paths without echoing values', () => {
  const root = makeRoot();
  try {
    const secret = ['sk', 'live', 'A1b2C3d4E5f6G7h8'].join('-');
    const ownerQq = ['2876', '543210'].join('');
    const source = [
      'const token = ' + JSON.stringify(secret) + ';',
      'const ownerQQ = ' + ownerQq + ';',
      "const p = 'C:" + BS + "Users" + BS + SAMPLE_USER + BS + "work';",
    ].join(NL);
    writeFile(root, 'src/bridge.js', source + NL);
    const result = scanRelease({ root });
    const rules = new Set(result.findings.map((f) => f.rule));
    assert.ok(rules.has('credential-assignment') || rules.has('known-token-literal'));
    assert.ok(rules.has('qq-identifier'));
    assert.ok(rules.has('windows-user-path'));
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes(ownerQq));
    assert.ok(!serialized.includes(SAMPLE_USER));
    for (const finding of result.findings) {
      assert.deepEqual(Object.keys(finding).sort(), ['explanation', 'line', 'path', 'rule']);
    }
  } finally {
    cleanup(root);
  }
});

test('classifies placeholders, env references, hashes and base64 images', () => {
  const root = makeRoot();
  try {
    const source = [
      `const apiKey = 'YOUR_API_KEY_HERE';`,
      'const authToken = process.env.RELEASE_TOKEN;',
      `const secret = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';`,
      `const token = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';`,
    ].join(NL);
    writeFile(root, 'src/config.js', source + NL);
    const result = scanRelease({ root });
    assert.equal(result.findings.filter((f) => f.path === 'src/config.js').length, 0);
    assert.ok(result.classified.placeholder >= 1);
    assert.ok(result.classified['env-reference'] >= 1);
    assert.ok(result.classified.hash >= 1);
    assert.ok(result.classified['base64-image'] >= 1);
  } finally {
    cleanup(root);
  }
});

test('matches exact values from external sensitive rules without serializing them', () => {
  const root = makeRoot();
  const rulesRoot = makeRoot();
  try {
    const exact = 'EXACT-SECRET-9f3a2b1c';
    writeFile(root, 'src/leak.js', `const x = '${exact}';` + NL);
    const rulesPath = path.join(rulesRoot, 'rules.json');
    fs.writeFileSync(rulesPath, JSON.stringify({ exactSecrets: [exact] }), 'utf8');
    const result = scanRelease({ root, exactEntries: loadSensitiveRules(rulesPath) });
    assert.ok(result.findings.some((f) => f.rule === 'external-secret-1'));
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(exact));
    assert.ok(!serialized.includes(root));
  } finally {
    cleanup(root);
    cleanup(rulesRoot);
  }
});

test('reports oversized files instead of skipping them silently', () => {
  const root = makeRoot();
  try {
    writeFile(root, 'big.txt', 'x'.repeat(128));
    const result = scanRelease({ root, maxBytes: 64 });
    assert.equal(result.skipped.oversized, 1);
    assert.ok(result.findings.some((f) => f.rule === 'file-too-large'));
    assert.ok(result.errors >= 1);
  } finally {
    cleanup(root);
  }
});

test('scans README at any nesting level instead of exempting it', () => {
  const root = makeRoot();
  try {
    writeFile(root, 'docs/README.md', 'C:' + BS + 'Users' + BS + SAMPLE_USER + BS + 'notes' + NL);
    const result = scanRelease({ root });
    assert.ok(result.findings.some((f) => f.path === 'docs/README.md' && f.rule === 'windows-user-path'));
  } finally {
    cleanup(root);
  }
});

test('reports symlinks without following them', (t) => {
  const root = makeRoot();
  try {
    writeFile(root, 'outside.txt', 'outside' + NL);
    try {
      fs.symlinkSync(path.join(root, 'outside.txt'), path.join(root, 'link.txt'), 'file');
    } catch {
      t.skip('symlink creation is unavailable on this platform');
      return;
    }
    const result = scanRelease({ root });
    assert.equal(result.skipped.symlinks, 1);
    assert.ok(result.findings.some((f) => f.rule === 'symlink-not-followed'));
    assert.equal(result.scanned, 1);
  } finally {
    cleanup(root);
  }
});
