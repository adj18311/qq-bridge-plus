// 离线政策试验：在临时副本里改变巡逻写门禁；可信登记与路由仅为测试假设。
// 不接生产服务、不调用平台；不能作为宿主来源认证或生产接线已完成的证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createXhhOperationController } from '../src/core/xiaoheihe-operation-controller.mjs';
import { createBindingPrototype } from './owner-patrol-binding-prototype.mjs';

test('隔离副本：假定可信绑定后验证巡逻计额、凭据拒绝与管理员行为', async (t) => {
  const source = new URL('../src/core/xiaoheihe-authorize-api.mjs', import.meta.url);
  const settings = new URL('../src/core/xiaoheihe-console-settings.mjs', import.meta.url);
  const original = await readFile(source, 'utf8');
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const needle = "if (isWrite && provenance === 'patrol') {\n      return deny({ at, tool: shortTool, agentClass, reason: 'read-only-background' });\n    }";
  const normalized = original.replaceAll('\r\n', '\n');
  assert.equal(normalized.split(needle).length, 2, '必须恰好找到一处策略锚点');
  const unknownNeedle = "if (isWrite && provenance === 'unknown') {\n      return deny({ at, tool: shortTool, agentClass, reason: 'unknown-source' });\n    }";
  assert.equal(normalized.split(unknownNeedle).length, 2, '必须恰好找到一处未知来源策略锚点');
  const changed = normalized.replace(needle, "if (isWrite && provenance === 'patrol' && agentClass !== 'background') {\n      return deny({ at, tool: shortTool, agentClass, reason: 'patrol-must-count' });\n    }")
    .replace(unknownNeedle, "if (isWrite && provenance === 'unknown' && agentClass !== 'background') {\n      return deny({ at, tool: shortTool, agentClass, reason: 'unknown-source' });\n    }");
  const dir = await mkdtemp(join(tmpdir(), 'owner-patrol-policy-'));
  try {
    await writeFile(join(dir, 'xiaoheihe-authorize-api.mjs'), changed);
    await copyFile(settings, join(dir, 'xiaoheihe-console-settings.mjs'));
    const { createXhhAuthorizeApi } = await import(pathToFileURL(join(dir, 'xiaoheihe-authorize-api.mjs')).href);
    const now = Date.UTC(2026, 9, 24, 2);
    function fixture() {
      const controller = createXhhOperationController({ clock: () => now });
      const api = createXhhAuthorizeApi({ controller, backgroundSessionKeys: ['fixture-patrol', 'fixture-unknown'], userExemptAgents: ['fixture-owner'], clock: () => now,
        provenanceClassifier: (key) => key === 'fixture-patrol' ? 'patrol' : key === 'fixture-owner' ? 'owner' : 'unknown' });
      const p = createBindingPrototype({ sessionId: 'same-session', epoch: 'fixture' });
      let turn = 0;
      function call(source, tool, args = {}) {
        turn++;
        const message = { id: `message-${turn}`, role: 'user', content: [{ type: 'text', text: 'fixture' }] };
        p.register(message, source);
        p.step({ sessionId: 'same-session', turn, step: 1, messages: [message] });
        const req = { sessionId: 'same-session', turn, step: 1, callId: `call-${turn}`, tool: `mcp__xiaoheihe__${tool}`, args };
        p.call(req);
        return req;
      }
      async function authorize(req) {
        const result = p.authorize(req);
        if (result === 'deny') return { decision: 'deny', reason: 'fixture-binding' };
        // 测试用别名模拟可信路由，生产环境不存在这一可信转换。
        const agentKey = result === 'quota' ? 'fixture-patrol' : 'fixture-owner';
        return { ...(await api.authorize({ agentKey, tool: req.tool, args: req.args, now })), agentKey };
      }
      return { controller, api, p, call, authorize };
    }
    await t.test('巡逻写经真实控制器预留、提交计数，重复提交不重复计数', async () => {
      const f = fixture();
      const req = f.call('patrol', 'publish_content', { operationId: 'offline-1' });
      const allowed = await f.authorize(req);
      assert.equal(allowed.decision, 'allow');
      assert.equal((await f.controller.status()).post.used, 0);
      assert.equal((await f.api.commit({ ticket: allowed.ticket, agentKey: allowed.agentKey, now })).ok, true);
      assert.equal((await f.controller.status()).post.used, 1);
      assert.equal((await f.api.commit({ ticket: allowed.ticket, agentKey: allowed.agentKey, now })).ok, true);
      assert.equal((await f.controller.status()).post.used, 1);
    });
    await t.test('巡逻登录被绑定层及候选门禁双重拒绝', async () => {
      const f = fixture();
      assert.equal((await f.authorize(f.call('patrol', 'interactive_login'))).decision, 'deny');
      const direct = await f.api.authorize({ agentKey: 'fixture-patrol', tool: 'interactive_login', args: {}, now });
      assert.equal(direct.reason, 'credential-requires-user-present');
    });
    await t.test('来源不明写入按后台计额，登录拒绝', async () => {
      const f = fixture();
      const write = await f.api.authorize({ agentKey: 'fixture-unknown', tool: 'publish_content', args: { operationId: 'unknown-1' }, now });
      assert.equal(write.decision, 'allow');
      assert.equal((await f.api.commit({ ticket: write.ticket, agentKey: 'fixture-unknown', now })).ok, true);
      assert.equal((await f.controller.status()).post.used, 1);
      const login = await f.api.authorize({ agentKey: 'fixture-unknown', tool: 'interactive_login', args: {}, now });
      assert.equal(login.decision, 'deny');
    });
    await t.test('请求参数自报管理员不改变来源不明的计额和登录限制', async () => {
      const f = fixture();
      const args = { operationId: 'untrusted-tag', source: 'owner', admin: true };
      const write = await f.api.authorize({ agentKey: 'fixture-unknown', tool: 'publish_content', args, now });
      assert.equal(write.decision, 'allow');
      assert.notEqual(write.exemption, 'user');
      assert.equal((await f.api.commit({ ticket: write.ticket, agentKey: 'fixture-unknown', now })).ok, true);
      assert.equal((await f.controller.status()).post.used, 1);
      const login = await f.api.authorize({ agentKey: 'fixture-unknown', tool: 'interactive_login', args: { source: 'owner' }, now });
      assert.equal(login.decision, 'deny');
    });
    await t.test('来源不明确而被错误分类为管理员时不得豁免写入', async () => {
      const controller = createXhhOperationController({ clock: () => now });
      const api = createXhhAuthorizeApi({ controller, backgroundSessionKeys: ['fixture-patrol'], userExemptAgents: ['fixture-owner'], clock: () => now, provenanceClassifier: () => 'unknown' });
      const write = await api.authorize({ agentKey: 'fixture-owner', tool: 'publish_content', args: { operationId: 'ambiguous-owner' }, now });
      assert.equal(write.decision, 'deny');
      assert.equal(write.reason, 'unknown-source');
    });
    await t.test('巡逻发帖额度为零时被真实控制器拒绝，管理员豁免仍可用', async () => {
      const f = fixture();
      assert.equal((await f.controller.setDailyLimits({ post: 0 })).ok, true);
      const denied = await f.authorize(f.call('patrol', 'publish_content', { operationId: 'over-cap' }));
      assert.equal(denied.decision, 'deny');
      assert.equal(denied.reason, 'post-daily-cap');
      f.p.end({ sessionId: 'same-session', turn: 1 });
      const owner = await f.authorize(f.call('owner', 'publish_content', { operationId: 'owner-over-cap' }));
      assert.equal(owner.decision, 'allow');
      assert.equal(owner.exemption, 'user');
    });
    await t.test('同一模拟会话的管理员登录和写入保留原有用户豁免', async () => {
      const f = fixture();
      const login = await f.authorize(f.call('owner', 'interactive_login'));
      assert.equal(login.decision, 'allow');
      f.p.end({ sessionId: 'same-session', turn: 1 });
      const write = await f.authorize(f.call('owner', 'publish_content', { operationId: 'owner-1' }));
      assert.equal(write.decision, 'allow');
      assert.equal(write.exemption, 'user');
      assert.equal((await f.controller.status()).post.used, 0);
    });
    await t.test('变更工具或参数、回合结束后不得重新授权', async () => {
      const f = fixture();
      const req = f.call('patrol', 'publish_content', { operationId: 'offline-2' });
      assert.equal((await f.authorize({ ...req, args: { operationId: 'altered' } })).decision, 'deny');
      assert.equal((await f.authorize({ ...req, tool: 'mcp__xiaoheihe__interactive_login' })).decision, 'deny');
      f.p.end({ sessionId: 'same-session', turn: 1 });
      assert.equal((await f.authorize(req)).decision, 'deny');
      assert.equal((await f.controller.status()).post.used, 0);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(hash(await readFile(source, 'utf8')), hash(original), '真实授权文件必须不变');
});
