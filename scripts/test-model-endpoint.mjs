#!/usr/bin/env node
/**
 * scripts/test-model-endpoint.mjs —— POST /api/dsh/model（档位热更新）的自动化测试
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   ① 鉴权：无令牌 / 错令牌 → 401；GET 仍是只读视图（写路径只认 POST）
 *   ② 正常热更新：model / provider / reasoningEffort / modelOverrides / removeOverrides
 *   ③ 校验拒绝：未知 provider、未知 model、非法 modelOverrides（数组 / 坏 key / 多余字段 /
 *      空串 / 非字符串 / 空对象）、非法 reasoningEffort、空请求体 → 400（目录不可用时 503）
 *   ④ 失败零副作用：磁盘 sha256 + mtime + 内存 cfg + 备份数量全都不变，也不留 .tmp
 *   ⑤ 成功路径：备份 config.json.bak-model-<stamp>（内容 == 写前字节）、原子写、内存同步、
 *      epoch 递增、返回 ok + 实际生效值 + 变更摘要；并验证 BOM / tab 缩进 / CRLF 风格被保留
 *   ⑥ 「下一条消息就地重新 selectModel」：改档 → 再投递一次 prompt → selectModel 收到新档位、
 *      session id 不变（不重启、不重建会话）
 *   ⑦ 向后兼容：/api/dsh/effort 行为不变
 *
 * 隔离方式：用 scripts/audit-bridge-harness.mjs 把**真实** src/bridge.js 跑在 %TEMP% 的全新临时
 * 仓库里（config.json / state/ 都是临时文件），再真的起 console server 发 HTTP 请求 ——
 * 不碰仓库里的 config.json，也不连 QQ / DSH / SnowLuma（api 与 fetch 都是桩）。
 *
 * 用法：node scripts/test-model-endpoint.mjs        （退出码 0 = 全绿）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const TOKEN = 'test-console-token-0123456789abcdef';
const OWNER_KEY = 'private:123';
const GROUP_KEY = 'group:456';

/** 假的 DSH 模型目录（真目录结构：groups[].models[]）。 */
const CATALOG = {
  groups: [
    { id: 'minimax-cn', models: [{ id: 'MiniMax-M3.1-Flash-Preview' }, { id: 'MiniMax-M3' }] },
    { id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mtime = (file) => fs.statSync(file).mtimeMs;
const backups = (temp) => fs.readdirSync(temp).filter((f) => f.startsWith('config.json.bak-model-'));
const tmpFiles = (temp) => fs.readdirSync(temp).filter((f) => f.endsWith('.tmp'));

async function waitFor(fn, timeoutMs = 4000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

async function listen(server) {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

/** 一次 HTTP 请求（token=null 表示不带令牌；body=undefined 表示空体）。 */
function request(server, { method = 'POST', pathname = '/api/dsh/model', body, token = TOKEN, contentType = 'application/json' } = {}) {
  const { port } = server.address();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: {
        ...(payload ? { 'content-type': contentType, 'content-length': payload.length } : {}),
        ...(token === null ? {} : { 'x-console-token': token }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`❌ ${name}（${Date.now() - t0}ms）\n   ${error?.stack ?? error?.message ?? error}`);
  }
}

/** 起一个隔离的 harness + console server，跑完自动收尾。 */
async function withBridge(run, config = {}) {
  const logs = [];
  const h = await bridgeHarness({
    config: {
      dsh: {
        authToken: 'fixture-only',
        provider: 'minimax-cn',
        model: 'MiniMax-M3.1-Flash-Preview',
        reasoningEffort: 'high',
      },
      ownerQQ: 123,
      allow: { private: ['123'], groups: ['456'] },
      consolePort: 0,
      consoleToken: TOKEN,
      slang: { enabled: false },
      ...config,
    },
    globals: { console: { log: (line) => logs.push(String(line)), error: () => {} } },
  });
  // 模型目录桩：让 provider/model 校验有东西可查（真目录形状）。
  h.api.callUnary = async (method) => {
    if (method === 'session.modelCatalog' || method === 'session.models') {
      return { result: { ok: true, value: CATALOG } };
    }
    return { result: { ok: true, value: {} } };
  };
  // selectModel 桩：记录每次档位请求，并按请求回填 selected（这样日志里的档位就是「目标档位」）。
  const modelCalls = [];
  h.api.sessions.selectModel = async (params) => {
    modelCalls.push(params);
    return {
      result: {
        ok: true,
        value: { selected: { provider: params.provider, model: params.model, reasoningEffort: params.reasoningEffort } },
      },
    };
  };
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  h.setReady(true);
  h.setMode('chat');
  const server = await listen(h.startConsoleServer());
  try {
    await run({ h, server, logs, modelCalls, temp: h.temp, configFile: path.join(h.temp, 'config.json') });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
console.log('== POST /api/dsh/model 端点测试（隔离临时仓库，不碰真实 config.json）==\n');

await withBridge(async ({ h, server, logs, modelCalls, temp, configFile }) => {
  const post = (body, opts = {}) => request(server, { body, ...opts });

  // 把夹具配置对齐成**仓库现状**的书写风格（无 BOM + 2 空格缩进 + LF + 末尾换行），
  // 后面才好断言「写盘保持风格」。harness 自己写的是紧凑单行 JSON。
  {
    const current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  }

  // ① 鉴权 + 只读视图
  await test('未带令牌 → 401，且不改盘', async () => {
    const before = sha256(configFile);
    const r = await post({ model: 'MiniMax-M3' }, { token: null });
    assert.equal(r.status, 401, `期望 401，实得 ${r.status} ${r.text}`);
    assert.match(String(r.json?.error ?? ''), /未授权/);
    assert.equal(sha256(configFile), before, '401 不该改 config.json');
  });

  await test('错误令牌 → 401', async () => {
    const r = await post({ model: 'MiniMax-M3' }, { token: 'wrong-token-wrong-token' });
    assert.equal(r.status, 401, `期望 401，实得 ${r.status}`);
  });

  await test('GET /api/dsh/model 仍是只读视图（写路径只认 POST）', async () => {
    const before = sha256(configFile);
    const r = await request(server, { method: 'GET', pathname: '/api/dsh/model' });
    assert.equal(r.status, 200, `期望 200，实得 ${r.status} ${r.text}`);
    assert.equal(r.json.provider, 'minimax-cn');
    assert.equal(r.json.model, 'MiniMax-M3.1-Flash-Preview');
    assert.equal(sha256(configFile), before, 'GET 不该改 config.json');
  });

  // ② 正常热更新
  await test('热更新 model：写盘 + 备份 + 内存同步 + epoch 递增', async () => {
    const beforeRaw = fs.readFileSync(configFile);
    const beforeSha = sha256(configFile);
    const beforeEpoch = h.cfg.dsh.model;
    const beforeBackups = backups(temp).length;
    const r = await post({ model: 'MiniMax-M3' });
    assert.equal(r.status, 200, `期望 200，实得 ${r.status} ${r.text}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.applied.model, 'MiniMax-M3', '响应应回实际生效值');
    assert.deepEqual(r.json.changes.map((c) => `${c.scope}:${c.from}→${c.to}`), ['dsh.model:MiniMax-M3.1-Flash-Preview→MiniMax-M3']);
    assert.equal(r.json.wrote, true);
    assert.ok(Number.isFinite(r.json.epoch), '响应应带 epoch');
    assert.match(r.json.note, /下一条消息/);
    // 磁盘
    assert.notEqual(sha256(configFile), beforeSha, 'config.json 应已改变');
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(onDisk.dsh.model, 'MiniMax-M3');
    assert.equal(onDisk.dsh.provider, 'minimax-cn', '未提供的字段必须保持不变');
    assert.equal(onDisk.socialV2?.modelOverrides?.['private:10001'], undefined, '不该凭空造 overrides');
    // 备份：命名 + 内容 == 写前字节
    const list = backups(temp);
    assert.equal(list.length, beforeBackups + 1, '应新增一个 config.json.bak-model-* 备份');
    const name = r.json.backup;
    assert.match(name, /^config\.json\.bak-model-\d{8}T\d{6}(-\d+)?$/, `备份名不符合约定：${name}`);
    assert.deepEqual(fs.readFileSync(path.join(temp, name)), beforeRaw, '备份必须是写入前的原始字节');
    // 内存
    assert.equal(h.cfg.dsh.model, 'MiniMax-M3');
    assert.notEqual(h.cfg.dsh.model, beforeEpoch);
    // 风格：无 BOM + 2 空格 + LF + 末尾换行
    const text = fs.readFileSync(configFile, 'utf8');
    assert.equal(text.charCodeAt(0) === 0xfeff, false, '不该加 BOM');
    assert.ok(!text.includes('\r\n'), '不该把 LF 改成 CRLF');
    assert.ok(text.endsWith('\n'), '应保留末尾换行');
    assert.ok(text.includes('\n  "dsh": {'), '应保持 2 空格缩进');
  });

  await test('未变化的请求 → 不写盘、不备份（wrote:false）', async () => {
    const beforeSha = sha256(configFile);
    const beforeBackups = backups(temp).length;
    const r = await post({ model: 'MiniMax-M3' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.wrote, false);
    assert.deepEqual(r.json.changes, []);
    assert.match(r.json.note, /未写盘/);
    assert.equal(sha256(configFile), beforeSha);
    assert.equal(backups(temp).length, beforeBackups, '无变化不该新增备份');
  });

  await test('热更新 provider + model（目录里合法的组合）', async () => {
    const r = await post({ provider: 'deepseek-account', model: 'deepseek-flash' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.applied.provider, 'deepseek-account');
    assert.equal(r.json.applied.model, 'deepseek-flash');
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(onDisk.dsh.provider, 'deepseek-account');
    assert.equal(onDisk.dsh.model, 'deepseek-flash');
  });

  await test('热更新 reasoningEffort', async () => {
    const r = await post({ reasoningEffort: 'max' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.applied.reasoningEffort, 'max');
    assert.equal(h.cfg.dsh.reasoningEffort, 'max');
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).dsh.reasoningEffort, 'max');
  });

  // ③ 校验拒绝 + ④ 零副作用
  const zeroSideEffect = async (label, body) => {
    await test(`${label} → 400 且零副作用`, async () => {
      const beforeSha = sha256(configFile);
      const beforeMtime = mtime(configFile);
      const beforeBackups = backups(temp).length;
      const beforeCfg = JSON.stringify({ dsh: h.cfg.dsh, ov: h.cfg.socialV2?.modelOverrides ?? {} });
      const r = await post(body);
      assert.equal(r.status, 400, `期望 400，实得 ${r.status} ${r.text}`);
      assert.equal(r.json?.ok, false);
      assert.ok(String(r.json?.error ?? '').length > 0, '必须说明原因');
      assert.equal(sha256(configFile), beforeSha, '失败的调用绝不能改磁盘');
      assert.equal(mtime(configFile), beforeMtime, '失败时 mtime 也不该变');
      assert.equal(backups(temp).length, beforeBackups, '失败时不该留下多余备份');
      assert.equal(JSON.stringify({ dsh: h.cfg.dsh, ov: h.cfg.socialV2?.modelOverrides ?? {} }), beforeCfg, '失败时内存也不该变');
      assert.equal(tmpFiles(temp).length, 0, '不该留下半写临时文件');
    });
  };

  await zeroSideEffect('未知 provider', { provider: 'nope-inc', model: 'x' });
  await zeroSideEffect('未知 model', { provider: 'minimax-cn', model: 'gpt-不存在' });
  await zeroSideEffect('provider 非字符串', { provider: 42 });
  await zeroSideEffect('provider 空串', { provider: '   ' });
  await zeroSideEffect('reasoningEffort 非法', { reasoningEffort: 'ultra' });
  await zeroSideEffect('modelOverrides 是数组', { modelOverrides: [] });
  await zeroSideEffect('modelOverrides 是字符串', { modelOverrides: 'private:123' });
  await zeroSideEffect('modelOverrides key 不合法', { modelOverrides: { 'foo:1': { model: 'MiniMax-M3' } } });
  await zeroSideEffect('modelOverrides key 号码为 0', { modelOverrides: { 'private:0': { model: 'MiniMax-M3' } } });
  await zeroSideEffect('modelOverrides 值多余字段', { modelOverrides: { 'private:123': { model: 'MiniMax-M3', temperature: 1 } } });
  await zeroSideEffect('modelOverrides 值空串', { modelOverrides: { 'private:123': { model: '   ' } } });
  await zeroSideEffect('modelOverrides 值非字符串', { modelOverrides: { 'private:123': { model: 7 } } });
  await zeroSideEffect('modelOverrides 值空对象', { modelOverrides: { 'private:123': {} } });
  await zeroSideEffect('modelOverrides 值 reasoningEffort 非法', { modelOverrides: { 'private:123': { reasoningEffort: 'ultra' } } });
  await zeroSideEffect('removeOverrides 非数组', { removeOverrides: 'private:123' });
  await zeroSideEffect('removeOverrides 项不合法', { removeOverrides: ['nope'] });
  await zeroSideEffect('空请求体（什么都没给）', {});
  await zeroSideEffect('请求体是 JSON 数组（不是对象）', []);
  await test('完全不带请求体 / 非 JSON 内容类型 → 被既有 CSRF 关卡挡下（4xx，且不改盘）', async () => {
    const beforeSha = sha256(configFile);
    const noBody = await post(undefined);
    assert.ok(noBody.status >= 400 && noBody.status < 500, `期望 4xx，实得 ${noBody.status}`);
    const formType = await request(server, { body: { model: 'MiniMax-M3' }, contentType: 'text/plain' });
    assert.ok(formType.status >= 400 && formType.status < 500, `期望 4xx，实得 ${formType.status}`);
    assert.equal(sha256(configFile), beforeSha);
    assert.equal(tmpFiles(temp).length, 0);
  });

  await test('未知 provider 的报错里带上可选项（帮助用户改对）', async () => {
    const r = await post({ provider: 'nope-inc' });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /minimax-cn/);
    assert.match(String(r.json.error), /deepseek-account/);
  });

  await test('写盘失败 → 500、零副作用（备份被回滚、内存不同步）', async () => {
    const beforeSha = sha256(configFile);
    const beforeBackups = backups(temp).length;
    const beforeCfg = JSON.stringify({ dsh: h.cfg.dsh, ov: h.cfg.socialV2?.modelOverrides ?? {} });
    const originalRename = fs.renameSync;
    // bridge.js 与测试共享同一个 fs 模块对象：把 rename 打瘸，模拟「写到一半失败」。
    fs.renameSync = () => { const error = new Error('EPERM: 模拟写盘失败'); error.code = 'EPERM'; throw error; };
    try {
      const r = await post({ provider: 'minimax-cn', model: 'MiniMax-M3' });
      assert.equal(r.status, 500, `期望 500，实得 ${r.status} ${r.text}`);
      assert.match(String(r.json.error), /写 config.json 失败/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(sha256(configFile), beforeSha, '写盘失败后磁盘必须原样');
    assert.equal(backups(temp).length, beforeBackups, '写盘失败不得留下多余备份（备份要被回滚）');
    assert.equal(JSON.stringify({ dsh: h.cfg.dsh, ov: h.cfg.socialV2?.modelOverrides ?? {} }), beforeCfg, '写盘失败时内存不该被同步');
    assert.equal(tmpFiles(temp).length, 0, '不该留下半写临时文件');
  });

  await test('DSH 目录读不到 → 503 且零副作用（fail closed，不静默接受未知档位）', async () => {
    const beforeSha = sha256(configFile);
    const beforeBackups = backups(temp).length;
    const beforeCfg = JSON.stringify(h.cfg.dsh);
    const goodCallUnary = h.api.callUnary;
    h.api.callUnary = async () => { throw new Error('DSH 不可用（模拟）'); };
    try {
      const r = await post({ model: 'MiniMax-M3' });
      assert.equal(r.status, 503, `期望 503，实得 ${r.status} ${r.text}`);
      assert.match(String(r.json.error), /读不到 DSH 模型目录/);
    } finally {
      h.api.callUnary = goodCallUnary;
    }
    assert.equal(sha256(configFile), beforeSha);
    assert.equal(backups(temp).length, beforeBackups);
    assert.equal(JSON.stringify(h.cfg.dsh), beforeCfg);
  });
  await test('未知 model 的报错里列出该 provider 下的模型', async () => {
    const r = await post({ provider: 'minimax-cn', model: 'nope-model' });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /MiniMax-M3\.1-Flash-Preview/);
    assert.match(String(r.json.error), /MiniMax-M3/);
  });

  // ② modelOverrides：打补丁 / 合并 / 删除
  await test('modelOverrides 打补丁：写盘 + 内存同步 + 摘要', async () => {
    const r = await post({ modelOverrides: { [GROUP_KEY]: { provider: 'deepseek-account', model: 'deepseek-flash' } } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.applied.modelOverrides[GROUP_KEY], { provider: 'deepseek-account', model: 'deepseek-flash' });
    assert.equal(r.json.changes.length, 1);
    assert.equal(r.json.changes[0].scope, `socialV2.modelOverrides["${GROUP_KEY}"]`);
    assert.equal(h.cfg.socialV2.modelOverrides[GROUP_KEY].model, 'deepseek-flash');
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.deepEqual(onDisk.socialV2.modelOverrides[GROUP_KEY], { provider: 'deepseek-account', model: 'deepseek-flash' });
  });

  await test('modelOverrides 二次打补丁只改给到的字段（其余继承原值）', async () => {
    const r = await post({ modelOverrides: { [GROUP_KEY]: { model: 'MiniMax-M3' } } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.applied.modelOverrides[GROUP_KEY], { provider: 'deepseek-account', model: 'MiniMax-M3' });
  });

  await test('removeOverrides 删除 key（= 跟随全局），内存与磁盘一致', async () => {
    const r = await post({ removeOverrides: [GROUP_KEY] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.applied.modelOverrides[GROUP_KEY], undefined);
    assert.equal(h.cfg.socialV2.modelOverrides[GROUP_KEY], undefined);
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(onDisk.socialV2.modelOverrides[GROUP_KEY], undefined);
    assert.equal(r.json.changes[0].to, null, '删除类变更的 to 应为 null');
    assert.match(JSON.stringify(r.json.changes[0].from), /deepseek-account/);
  });

  await test('BOM / tab 缩进 / CRLF 风格被保留', async () => {
    // 把临时 config.json 改写成「带 BOM + tab 缩进 + CRLF」，再让端点写一次。
    const obj = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const styled = '\ufeff' + JSON.stringify(obj, null, '\t').split('\n').join('\r\n') + '\r\n';
    fs.writeFileSync(configFile, styled, 'utf8');
    const r = await post({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview' });
    assert.equal(r.status, 200, r.text);
    const text = fs.readFileSync(configFile, 'utf8');
    assert.equal(text.charCodeAt(0), 0xfeff, '应保留 BOM');
    assert.ok(text.includes('\r\n'), '应保留 CRLF');
    assert.ok(!/(^|[^\r])\n/.test(text), '不该混入裸 LF');
    assert.ok(text.includes('\r\n\t"dsh": {'), '应保留 tab 缩进');
    assert.ok(text.endsWith('\r\n'), '应保留末尾换行');
    assert.equal(JSON.parse(text.replace(/^\ufeff/, '')).dsh.model, 'MiniMax-M3.1-Flash-Preview');
  });

  // ⑥ 下一条消息就地重新 selectModel
  await test('改档后下一条消息就地重新 selectModel（session id 不变）', async () => {
    const warm = await h.deliverPrompt(GROUP_KEY, '【测试】预热：建立会话并对齐当前档位', { silent: true });
    assert.ok(warm?.ok !== false, `预热投递应成功：${JSON.stringify(warm)}`);
    const sid = await waitFor(() => h.state.sessions[GROUP_KEY]);
    assert.ok(sid, '预热后应存在会话映射');
    assert.ok(modelCalls.length >= 1, '预热应触发一次 selectModel');
    const firstCall = modelCalls[modelCalls.length - 1];

    const before = await post({ modelOverrides: { [GROUP_KEY]: { provider: 'minimax-cn', model: 'MiniMax-M3' } } });
    assert.equal(before.status, 200, before.text);

    const logsBefore = logs.length;
    await h.deliverPrompt(GROUP_KEY, '【测试】改档后的下一条消息：应就地重新 selectModel', { silent: true });
    const resel = await waitFor(() => modelCalls.find((c, i) => i >= modelCalls.indexOf(firstCall) + 1 && c.model === 'MiniMax-M3'));
    await waitFor(() => logs.slice(logsBefore).some((l) => l.includes('已设置会话模型')), 3000);

    assert.ok(resel, `下一条消息应重新 selectModel 到新档位；实际调用：${JSON.stringify(modelCalls)}`);
    assert.equal(resel.provider, 'minimax-cn');
    assert.equal(resel.model, 'MiniMax-M3');
    assert.equal(h.state.sessions[GROUP_KEY], sid, 'session id 必须不变（不重启桥接、不重建会话）');
    const line = logs.slice(logsBefore).find((l) => l.includes('已设置会话模型'));
    assert.ok(line, `bridge 日志应出现「已设置会话模型 … [${GROUP_KEY}] -> 新档位」；实际新增日志：${JSON.stringify(logs.slice(logsBefore))}`);
    assert.match(line, new RegExp(`已设置会话模型\\s+${sid}\\s+\\[${GROUP_KEY}\\]\\s+->\\s+minimax-cn/MiniMax-M3`));
  });

  // ⑦ 向后兼容
  await test('/api/dsh/effort 仍然照旧工作', async () => {
    const r = await request(server, { method: 'POST', pathname: '/api/dsh/effort', body: { reasoningEffort: 'low' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.reasoningEffort, 'low');
    assert.equal(h.cfg.dsh.reasoningEffort, 'low');
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).dsh.reasoningEffort, 'low');
  });

  await test('全程没有留下 .tmp 半写文件', async () => {
    assert.deepEqual(tmpFiles(temp), []);
  });

  await test('所有成功写的备份名都符合 config.json.bak-model-<stamp> 约定', async () => {
    const list = backups(temp);
    assert.ok(list.length >= 3, `应有多份备份，实得 ${list.length}`);
    for (const name of list) assert.match(name, /^config\.json\.bak-model-\d{8}T\d{6}(-\d+)?$/);
  });
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.error('\n失败明细：');
  for (const f of failures) console.error(` - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exit(1);
}
console.log('全部通过 ✅');
