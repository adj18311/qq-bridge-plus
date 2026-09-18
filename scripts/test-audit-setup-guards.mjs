// Execute both real preset plugins against a captured tools service, without DSH/QQ.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const { apply } = await import(pathToFileURL(path.join(root, 'dsh/agent-presets', preset, 'qq-tool-restrict.mjs')).href);
  let guard;
  const restricted = [];
  apply({ tools: {
    restrict: ({ deny }) => restricted.push(...deny),
    guard: (callback) => { guard = callback; },
  } });
  assert.equal(typeof guard, 'function');
  assert.ok(restricted.includes('dev_install_package'));
  for (const name of ['ask_user_question', 'todo_write', 'mcp__snowluma__qq_send_message',
    'mcp__snowluma-host__snowluma_status', 'mcp__web-search-safe__web_fetch']) {
    assert.equal(guard({ name }), undefined, `${preset}: expected allowed ${name}`);
  }
  for (const name of ['web_fetch', 'web_search', 'bash', 'read_file', 'dev_future_tool',
    'mcp__untrusted__web_fetch', '', null, undefined]) {
    try { assert.equal(typeof guard({ name }), 'string', `${preset}: must reject ${String(name)}`); }
    catch (error) { failures++; console.error(`FAIL ${error.message}`); }
  }
  console.log(`${preset}: checked allowed tools and denied inherited/local/invalid tools`);
}
process.exitCode = failures ? 1 : 0;
