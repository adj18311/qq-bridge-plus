// C12：bridge 为每条 QQ 消息签发 requestId 并登记到插件 —— 定向测试。
//
// 不启动 bridge（那会连真实 QQ）。两类断言：
//   A. **源码静态断言**：从 src/bridge.js 里抽出 deliverPromptNow 的函数体，检查
//      「登记在 prompt 之前」「同一个标识符」「origin 只有两个字面量」「requestId 不进日志」。
//   B. **真实 IPC 组合**：用 src/qzone-source-register-ipc.mjs 的**真 server + 真 client**
//      （127.0.0.1 回环，假 register），验证登记成功/失败两条路径都不会阻断投递。
//
// 运行：node scripts/test-qzone-source-register-wiring.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readQzoneSourceRegisterConfig,
  createQzoneSourceRegisterIpcServer,
  createQzoneSourceRegisterIpcClient,
} from '../src/qzone-source-register-ipc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '..', 'src', 'bridge.js');
const source = fs.readFileSync(BRIDGE, 'utf8');
const lines = source.split('\n');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (error) { results.push(['FAIL', name + ' :: ' + (error?.message ?? error)]); }
}

/** 从源码里按函数名抽出函数体（大括号配平，跳过字符串/注释里的括号足够用——这里只做结构定位）。 */
function extractFunctionBody(text, name) {
  const marker = `async function ${name}(`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `找不到函数 ${name}`);
  const braceStart = text.indexOf('{', text.indexOf(')', start));
  assert.ok(braceStart > start, `找不到 ${name} 的函数体起点`);
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = braceStart; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i += 1; } continue; }
    if (inSingle) { if (ch === '\\') { i += 1; continue; } if (ch === "'") inSingle = false; continue; }
    if (inDouble) { if (ch === '\\') { i += 1; continue; } if (ch === '"') inDouble = false; continue; }
    if (inTemplate) { if (ch === '\\') { i += 1; continue; } if (ch === '`') inTemplate = false; continue; }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '`') { inTemplate = true; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(braceStart + 1, i), startLine: text.slice(0, braceStart).split('\n').length };
    }
  }
  throw new Error(`${name} 函数体没有配平的大括号`);
}

const deliver = extractFunctionBody(source, 'deliverPromptNow');

// ── A. 静态断言 ──────────────────────────────────────────────────────────────────────────
await test('C12-S1 登记调用出现在 api.sessions.prompt 之前（同一函数体内，按位置）', () => {
  const registerAt = deliver.body.indexOf('await registerQzoneSource(');
  const promptAt = deliver.body.indexOf('await api.sessions.prompt(');
  assert.ok(registerAt > 0, 'deliverPromptNow 里必须有 await registerQzoneSource(...)');
  assert.ok(promptAt > 0, 'deliverPromptNow 里必须有 await api.sessions.prompt(...)');
  assert.ok(registerAt < promptAt, '登记必须在投递之前（先登记后 prompt）');
});

await test('C12-S2 登记与投递使用同一个 requestId 变量（同一次投递内只有一个赋值点）', () => {
  const declarations = [...deliver.body.matchAll(/const requestId\s*=/g)];
  assert.equal(declarations.length, 1, 'requestId 必须只声明一次（避免两个不同的 id）');
  const registerCall = deliver.body.match(/await registerQzoneSource\(([^)]*)\)/);
  assert.ok(registerCall, '必须能解析出 registerQzoneSource 的调用参数');
  const args = registerCall[1].split(',').map((part) => part.trim());
  assert.equal(args[0], 'sessionId', '第一个参数必须是已解析出来的 sessionId');
  assert.equal(args[1], 'requestId', '第二个参数必须是同一个 requestId 标识符');
  const promptCall = deliver.body.match(/await api\.sessions\.prompt\(\{([^}]*)\}\)/);
  assert.ok(promptCall, '必须能解析出 api.sessions.prompt 的参数对象');
  assert.match(promptCall[1], /\brequestId\b/, 'prompt 必须显式带 requestId（不依赖 dsh-client 隐式补）');
  assert.match(promptCall[1], /\bsessionId\b/, 'prompt 必须带同一个 sessionId');
});

await test('C12-S3 requestId 缺失时由 bridge 自己签发（crypto.randomUUID），不依赖隐式补充', () => {
  assert.match(deliver.body, /:\s*crypto\.randomUUID\(\)/, '没有外部 requestId 时必须自己签发');
  // 兼容分支保留：外部给了合法 UUID 就用它
  assert.match(deliver.body, /Object\.hasOwn\(opts, 'requestId'\)/, '必须保留外部 requestId 的兼容分支');
});

await test("C12-S4 origin 只可能是 'qq-inbound' 或 'schedule'（闭集，且判定基于 backgroundPatrol）", () => {
  const origins = [...deliver.body.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).filter((v) => v === 'qq-inbound' || v === 'schedule');
  assert.deepEqual([...new Set(origins)].sort(), ['qq-inbound', 'schedule'], '函数体内只允许这两个 origin 字面量');
  assert.match(deliver.body, /opts\.backgroundPatrol === true\s*\?\s*'schedule'\s*:\s*'qq-inbound'/,
    "origin 判定必须是 backgroundPatrol===true ? 'schedule' : 'qq-inbound'");
});

await test('C12-S5 requestId 绝不进入任何日志（隐式字符串里没有它）', () => {
  for (const match of deliver.body.matchAll(/log\((`[^`]*`|'[^']*')/g)) {
    const literal = match[1];
    assert.ok(!/requestId/.test(literal), '日志字面量里不得出现 requestId：' + literal);
  }
  // log 的任何模板插值都不许是 requestId
  for (const match of deliver.body.matchAll(/log\([^)]*\)/g)) {
    assert.ok(!/\$\{\s*requestId\s*\}/.test(match[0]), '日志插值里不得出现 requestId：' + match[0]);
  }
});

await test('C12-S6 登记失败不阻断：registerQzoneSource 从不抛，且调用点不检查返回值决定是否投递', () => {
  const helper = extractFunctionBody(source, 'registerQzoneSource');
  assert.match(helper.body, /if \(qzoneSourceRegisterClient === null\) return false/, '未启用时直接返回 false');
  assert.match(helper.body, /catch\s*\{/, '必须有 catch 吞掉一切');
  assert.match(helper.body, /return false/, '异常路径返回 false');
  // 调用点：没有 if (!registered) return / throw 之类的中断
  const afterCall = deliver.body.slice(deliver.body.indexOf('await registerQzoneSource('));
  const beforePrompt = afterCall.slice(0, afterCall.indexOf('await api.sessions.prompt('));
  assert.ok(!/return\b/.test(beforePrompt), '登记与投递之间不得有 early return');
  assert.ok(!/throw\b/.test(beforePrompt), '登记与投递之间不得 throw');
});

await test('C12-S7 开关缺省不启动；启动/关停点存在且 fail-soft', () => {
  const startFn = extractFunctionBody(source, 'startQzoneSourceRegister');
  assert.match(startFn.body, /readQzoneSourceRegisterConfig\(activeCfg\?\.qzone\)/, '必须复用 readQzoneSourceRegisterConfig');
  assert.match(startFn.body, /if \(read\.enabled !== true\) return \{ ok: false, reason: read\.reason \}/, '未启用必须直接返回');
  // 启动调用点：外层有 try/catch，失败只 log
  const startAt = source.indexOf('await startQzoneSourceRegister(cfg)');
  assert.ok(startAt > 0, '必须在 main() 里启动');
  const around = source.slice(Math.max(0, startAt - 500), startAt + 400);
  assert.match(around, /try\s*\{/, '启动调用必须包在 try 里');
  assert.match(around, /来源登记通道启动异常/, '启动异常只 log，不抛');
  // 关停
  assert.match(source, /if \(qzoneSourceRegisterClient !== null\) \{[\s\S]{0,200}qzoneSourceRegisterClient\.close\(\)/, 'shutdown 必须关 client');
});

await test('C12-S8 启动点在 botReady 之后、pumpMux 之前；关停写在 shutdownBridge 函数体内', () => {
  const botReadyAt = source.indexOf('botReady = true;');
  const startAt = source.indexOf('await startQzoneSourceRegister(cfg)');
  const pumpAt = source.indexOf('await pumpMux();');
  assert.ok(botReadyAt > 0 && startAt > botReadyAt, '必须在 botReady 之后启动');
  assert.ok(pumpAt > startAt, '必须在 pumpMux 之前启动');
  // shutdownBridge 定义在 main() 之后（文件顺序靠后），所以这里断言的是「在它的函数体里」，
  // 而不是「在 pumpMux 之前」——那会是一条与语义无关的排版断言（初版写错过）。
  const shutdown = extractFunctionBody(source, 'shutdownBridge');
  assert.match(shutdown.body, /qzoneSourceRegisterClient\.close\(\)/, 'shutdownBridge 里必须关 client');
  assert.match(shutdown.body, /qzoneSourceRegisterClient = null/, '关闭后必须置 null（幂等）');
});

// ── B. 真实 IPC 组合：登记成功 / 失败都不阻断投递 ─────────────────────────────────────────
const TOKEN = 'S'.repeat(43);
const SESSION = 'sess-c12';
const REQUEST = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/**
 * 复刻 deliverPromptNow 里 C12 那段的**投递语义**：
 * 先登记（记录日志），再"投递"（这里是假 transport），无论登记结果如何都要投递。
 */
async function deliverLikeBridge({ client, sessionId, requestId, origin, log }) {
  const delivered = [];
  // 逐行同构于 registerQzoneSource 的调用点语义
  if (client !== null) {
    try {
      const registered = await client.register(sessionId, { requestId, origin });
      if (registered !== true) log('来源登记未成功（按 fail-closed 处理，投递继续）');
    } catch {
      log('来源登记异常（已忽略，投递继续）');
    }
  }
  delivered.push({ sessionId, requestId, origin });
  return delivered;
}

await test('C12-B1 真 server + 真 client：登记成功，且投递继续（register 收到正确三字段）', async () => {
  const calls = [];
  const server = await createQzoneSourceRegisterIpcServer({
    register: async (sessionId, input) => { calls.push({ sessionId, ...input }); return { ok: true }; },
    token: TOKEN,
    clock: () => Date.now(),
  });
  const client = createQzoneSourceRegisterIpcClient({
    origin: 'http://127.0.0.1:' + server.port, token: TOKEN, timeoutMs: 3000,
  });
  const logs = [];
  try {
    const delivered = await deliverLikeBridge({
      client, sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound', log: (line) => logs.push(line),
    });
    assert.equal(delivered.length, 1, '必须发生一次投递');
    assert.equal(calls.length, 1, '必须发生一次登记');
    assert.deepEqual(calls[0], { sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound' });
    assert.equal(logs.length, 0, '成功路径不该有"登记未成功"日志');
  } finally { await client.close(); await server.close(); }
});

await test('C12-B2 server 未启动（连接被拒）：client 返回 false 不抛，投递仍然继续', async () => {
  // 先起再关，拿到一个确定没人监听的端口
  const probe = await createQzoneSourceRegisterIpcServer({
    register: async () => ({ ok: true }), token: TOKEN, clock: () => Date.now(),
  });
  const port = probe.port;
  await probe.close();
  const client = createQzoneSourceRegisterIpcClient({
    origin: 'http://127.0.0.1:' + port, token: TOKEN, timeoutMs: 1000,
  });
  const logs = [];
  try {
    const delivered = await deliverLikeBridge({
      client, sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound', log: (line) => logs.push(line),
    });
    assert.equal(delivered.length, 1, '登记失败绝不能阻断投递');
    assert.equal(logs.length, 1, '必须留一行日志');
    assert.ok(!logs[0].includes(REQUEST), '日志里不得出现 requestId');
  } finally { await client.close(); }
});

await test('C12-B3 未启用（client 为 null）：直接投递，不登记也不报错', async () => {
  const logs = [];
  const delivered = await deliverLikeBridge({
    client: null, sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound', log: (line) => logs.push(line),
  });
  assert.equal(delivered.length, 1, '未启用时投递照常');
  assert.equal(logs.length, 0, '未启用不是错误，不该刷日志');
});

await test("C12-B4 origin 'schedule' 同样被对端接受（后台巡逻路径）", async () => {
  const calls = [];
  const server = await createQzoneSourceRegisterIpcServer({
    register: async (sessionId, input) => { calls.push(input); return { ok: true }; },
    token: TOKEN, clock: () => Date.now(),
  });
  const client = createQzoneSourceRegisterIpcClient({
    origin: 'http://127.0.0.1:' + server.port, token: TOKEN, timeoutMs: 3000,
  });
  try {
    await deliverLikeBridge({ client, sessionId: SESSION, requestId: REQUEST, origin: 'schedule', log: () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin, 'schedule');
  } finally { await client.close(); await server.close(); }
});

await test('C12-B5 对端明确拒绝（ok:false）：client 返回 false 不抛，投递继续', async () => {
  const server = await createQzoneSourceRegisterIpcServer({
    register: async () => ({ ok: false }), token: TOKEN, clock: () => Date.now(),
  });
  const client = createQzoneSourceRegisterIpcClient({
    origin: 'http://127.0.0.1:' + server.port, token: TOKEN, timeoutMs: 3000,
  });
  const logs = [];
  try {
    const delivered = await deliverLikeBridge({
      client, sessionId: SESSION, requestId: REQUEST, origin: 'qq-inbound', log: (line) => logs.push(line),
    });
    assert.equal(delivered.length, 1);
    assert.equal(logs.length, 1);
  } finally { await client.close(); await server.close(); }
});

// ── C. 配置解读（复用已写的模块，确认接线用的判据正确）─────────────────────────────────────
await test('C12-C1 readQzoneSourceRegisterConfig：缺省关闭，port 缺省 0', async () => {
  assert.equal(readQzoneSourceRegisterConfig(undefined).enabled, false);
  assert.equal(readQzoneSourceRegisterConfig({}).enabled, false);
  const enabled = readQzoneSourceRegisterConfig({ sourceRegister: { token: TOKEN, port: 41234 } });
  assert.deepEqual(enabled, { enabled: true, token: TOKEN, port: 41234 });
  const noPort = readQzoneSourceRegisterConfig({ sourceRegister: { token: TOKEN } });
  assert.equal(noPort.port, 0, '未给 port 时为 0 ⇒ startQzoneSourceRegister 会以 port-not-configured 跳过');
});

const failed = results.filter((r) => r[0] === 'FAIL');
for (const [status, name] of results) console.log(status + '  ' + name);
console.log('---');
console.log('total=' + results.length + ' failed=' + failed.length);
process.exitCode = failed.length === 0 ? 0 : 1;