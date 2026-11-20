import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('桥接空间控制台路由在主鉴权和 agent 限制之后，并要求专栏防护头', () => {
  const source = readFileSync(resolve('src/bridge.js'), 'utf8');
  const marker = source.indexOf("url.pathname.startsWith('/api/console/qqspace-column/')");
  assert.ok(marker > source.indexOf('if (consoleToken && !tokenMatches)'));
  assert.ok(marker > source.indexOf('if (req.headers[\'x-agent-token\'])'));
  const block = source.slice(marker, marker + 3500);
  assert.match(block, /x-column-request/);
  assert.match(block, /getQzoneConsoleRuntime/);
  assert.match(block, /readBody/);
  assert.match(block, /setHeader\('Set-Cookie'/);
  assert.match(source, /existsSync\(path\.join\(STATE_DIR, 'qzone-console-state\.sqlite'\)\)/);
});
