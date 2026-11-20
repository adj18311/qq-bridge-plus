import assert from 'node:assert/strict';
import {
  QZONE_MCP_TOOLS,
  QZONE_MCP_VALIDATORS,
  validateQzoneMcpInput
} from '../src/core/qzone-mcp-contract.mjs';

const expectedNames = ['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like'];
assert.deepEqual(Object.keys(QZONE_MCP_TOOLS), expectedNames);
assert.deepEqual(Object.keys(QZONE_MCP_VALIDATORS), expectedNames);
assert.throws(() => { QZONE_MCP_TOOLS.read_posts.inputSchema.properties.target_uin.oneOf[0].minimum = 0; }, TypeError);

for (const name of expectedNames) {
  const definition = QZONE_MCP_TOOLS[name];
  assert.equal(definition.name, name);
  assert.equal(definition.inputSchema.type, 'object');
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.ok(Array.isArray(definition.inputSchema.required));
  assert.equal(typeof QZONE_MCP_VALIDATORS[name], 'function');
  assert.equal(validateQzoneMcpInput(name, {}), false);
}

const validCases = {
  read_posts: { target_uin: '12345' },
  read_comments: { tid: 'post_1', target_uin: 12345 },
  publish: { content: 'hello', ugc_right: 1 },
  comment: { tid: 'post_1', target_uin: 12345, content: 'hello' },
  reply: { tid: 'post_1', target_uin: 12345, content: 'hello', comment_id: 'comment_1', comment_uin: 456 },
  like: { tid: 'post_1', target_uin: 12345 }
};
for (const [name, input] of Object.entries(validCases)) {
  assert.equal(validateQzoneMcpInput(name, input), true, `${name} valid business input`);
}

for (const name of expectedNames) {
  for (const forbidden of [
    { ...validCases[name], identity: '12345' },
    { ...validCases[name], source: 'admin' },
    { ...validCases[name], authorization: { granted: true } },
    { ...validCases[name], scope: 'all' },
    { ...validCases[name], token: 'secret' },
    { ...validCases[name], cookie: 'secret' },
    { ...validCases[name], bypass: true }
  ]) assert.equal(validateQzoneMcpInput(name, forbidden), false, `${name} rejects forbidden field`);
}

assert.equal(validateQzoneMcpInput('unknown', {}), false);
assert.equal(validateQzoneMcpInput('like', null), false);
let getterCalled = false;
const accessor = Object.defineProperty({ tid: 'post_1', target_uin: 12345 }, 'abstime', {
  enumerable: true,
  get() { getterCalled = true; return 1; }
});
assert.equal(validateQzoneMcpInput('like', accessor), false);
assert.equal(getterCalled, false);
assert.equal(validateQzoneMcpInput('read_posts', Object.create({ target_uin: 12345 })), false);

console.log('qzone-mcp-contract: all assertions passed');
