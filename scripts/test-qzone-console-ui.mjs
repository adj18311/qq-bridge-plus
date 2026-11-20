import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneConsoleGateway } from '../src/core/qzone-console-gateway.mjs';

const html = await readFile(new URL('../public/console.html', import.meta.url), 'utf8');
const qzone = html.match(/<section\b[^>]*id="section-qzone"[\s\S]*?<\/section>/i)?.[0] ?? '';
const qzoneCode = html.match(/\/\* QZONE_CONSOLE_BEGIN \*\/[\s\S]*?\/\* QZONE_CONSOLE_END \*\//)?.[0] ?? '';
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)?.[1] ?? '';
const firstRouteCall = script.indexOf('setConsolePage(location.hash');
const qzoneStateAt = script.indexOf('const QZONE_COLUMN_BASE');

assert.match(html, /data-view="qzone"/);
assert.ok(qzone, 'QQ 空间专栏必须是独立页面区块');
for (const text of ['独立密码', '总开关', '允许读取', '允许写入', '工具权限', '每日额度', '15 分钟', '07:00', '23:00', '重置', '恢复', '审计']) {
  assert.ok(qzone.includes(text), `专栏应呈现：${text}`);
}
for (const id of ['qzoneSetupPassword', 'qzoneVerifyPassword', 'qzoneEnabled', 'qzoneReadAllowed', 'qzoneWriteAllowed', 'qzoneDispatchStatus', 'qzoneInterval', 'qzoneStart', 'qzoneEnd', 'qzoneAudit']) {
  assert.ok(qzone.includes(`id="${id}"`), `缺少控件 ${id}`);
}
assert.ok(qzoneStateAt >= 0 && qzoneStateAt < firstRouteCall, 'QZone 状态和常量必须在首次页面路由前初始化，避免 #qzone TDZ');
assert.match(qzoneCode, /input\.min = '0'; input\.max = '99'/);
assert.match(html, /const QZONE_COLUMN_BASE = '\/api\/console\/qqspace-column'/);
assert.match(qzoneCode, /x-column-request/);
assert.match(qzoneCode, /x-console-token/);
assert.match(qzoneCode, /credentials:\s*'same-origin'/);
assert.match(qzoneCode, /session\?\.valid/);
assert.match(qzoneCode, /\/config/);
assert.match(qzoneCode, /PATCH/);
assert.match(qzoneCode, /kind/);
assert.match(qzoneCode, /layer/);
assert.match(qzoneCode, /records/);
assert.match(qzoneCode, /dispatchAvailable/);
assert.match(qzoneCode, /空间工具\/调度尚未接入，当前不可执行真实操作/);
assert.doesNotMatch(qzoneCode, /\['read'[^\]]*搜索|\['patrol'/, '不得发明任务卡以外的工具或读取额度');
for (const tool of ['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like']) assert.ok(html.includes("['" + tool + "'"), `缺少工具 ${tool}`);
assert.doesNotMatch(qzoneCode, /localStorage\.setItem\([^)]*password/i);
assert.match(qzoneCode, /未连接|连接失败/);

// Run the complete main inline script with a direct #qzone entry to catch TDZ
// and top-level fixture incompatibilities, including the intentionally absent createTextNode.
const mainScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).sort((a, b) => b.length - a.length)[0];
const bootElements = new Map();
const makeBootElement = (tag = 'div') => {
  const listeners = new Map();
  const element = {
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    children: [], value: '', checked: false, hidden: false, textContent: '', innerHTML: '', className: '',
    addEventListener(type, fn) { listeners.set(type, fn); }, setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    appendChild(child) { element.children.push(child); return child; }, insertBefore(child) { return child; }, removeChild() {}, remove() {},
    focus() {}, blur() {}, click() { listeners.get('click')?.({ target: element }); }, scrollIntoView() {},
    querySelector: () => makeBootElement(), querySelectorAll: () => [], closest: () => null, contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }), getContext: () => new Proxy({}, { get: () => () => ({}) }),
    animate: () => ({ finished: Promise.resolve(), cancel() {} }),
  };
  return new Proxy(element, { get(target, key) { if (key in target) return target[key]; if (key === Symbol.toPrimitive || key === 'then') return undefined; return () => undefined; }, set(target, key, value) { target[key] = value; return true; }, has: () => true });
};
const bootDocument = {
  getElementById(id) { if (!bootElements.has(id)) bootElements.set(id, makeBootElement()); return bootElements.get(id); },
  querySelector: () => makeBootElement(), querySelectorAll: () => [], createElement: tag => makeBootElement(tag),
  addEventListener() {}, body: makeBootElement('body'), documentElement: makeBootElement('html'), head: makeBootElement('head'), readyState: 'complete', title: '',
};
const bootSandbox = {
  document: bootDocument, navigator: { userAgent: 'qzone-ui-test', clipboard: { writeText: async () => {} } },
  location: { search: '', pathname: '/', hash: '#qzone', reload() {} }, history: { replaceState() {}, pushState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => new Promise(() => {}),
  prompt: () => null, alert() {}, confirm: () => false, setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  console, JSON, Date, Math, Number, String, Boolean, Array, Object, Promise, Error, RegExp, Map, Set, isNaN, parseInt, parseFloat, URLSearchParams,
  encodeURIComponent, decodeURIComponent,
};
bootSandbox.window = bootSandbox; bootSandbox.globalThis = bootSandbox;
bootSandbox.addEventListener = () => {}; bootSandbox.removeEventListener = () => {};
bootSandbox.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
bootSandbox.innerWidth = 1280; bootSandbox.innerHeight = 800; bootSandbox.scrollTo = () => {}; bootSandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
bootSandbox.requestAnimationFrame = fn => { try { fn(0); } catch {} return 0; }; bootSandbox.cancelAnimationFrame = () => {};
bootSandbox.Chart = function Chart() { return { destroy() {}, update() {}, resize() {} }; };
bootSandbox.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
bootSandbox.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
bootSandbox.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
assert.doesNotThrow(() => vm.runInNewContext(mainScript, bootSandbox, { filename: 'console-qzone-hash-boot.js', timeout: 10000 }), '完整控制台脚本以 #qzone 启动必须不抛异常');

// Execute just the production QZone block against a tiny DOM and mocked fetch.
// This checks real request construction and response-to-control mapping without network access.
class Element {
  constructor(id = '') { this.id = id; this.tagName = String(id).toUpperCase(); this.hidden = false; this.value = ''; this.checked = false; this.dataset = {}; this.children = []; this.listeners = {}; this.textContent = ''; this.style = {}; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  appendChild(child) { this.children.push(child); }
  setAttribute() {}
}
const elements = new Map();
const getElementById = id => elements.get(id) ?? (elements.set(id, new Element(id)), elements.get(id));
for (const [, id] of qzone.matchAll(/\bid="([^"]+)"/g)) getElementById(id);
const calls = [];
let responseByPath = new Map();
const context = {
  document: {
    getElementById,
    createElement: tag => {
      const el = new Element(tag);
      Object.defineProperty(el, 'id', { get() { return el._id || ''; }, set(value) { el._id = value; elements.set(value, el); } });
      return el;
    },
    querySelectorAll(selector) {
      if (selector === '[data-qzone-tool]') return [...elements.values()].filter(e => e.dataset.qzoneTool);
      if (selector === '[data-qzone-quota]') return [...elements.values()].filter(e => e.dataset.qzoneQuota);
      return [];
    },
  },
  localStorage: { getItem(key) { assert.equal(key, 'consoleToken'); return 'existing-console-token'; }, setItem() { throw new Error('不得写入凭据'); } },
  fetch: async (url, options) => {
    calls.push({ url, options });
    const result = responseByPath.get(url) ?? { status: 200, body: { ok: true } };
    if (result.wait) await result.wait;
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
  },
  console,
  URLSearchParams,
  QZONE_COLUMN_BASE: '/api/console/qqspace-column',
  qzoneToolNames: [['read_posts', '读取说说'], ['read_comments', '读取评论'], ['publish', '发说说'], ['comment', '评论'], ['reply', '回复'], ['like', '点赞']],
  qzoneQuotaNames: [['post', '发说说'], ['comment', '评论/回复'], ['like', '点赞']],
  qzoneVerified: false, qzoneConfigValid: false, qzoneStatusValid: false, qzoneDraftDirty: false, qzoneDraftVersion: 0,
  qzoneDirtyFields: new Set(),
  qzoneConfigRequestId: 0, qzoneStatusRequestId: 0, qzoneDispatchAvailable: false, qzonePasswordConfigured: false,
};
vm.runInNewContext(`${qzoneCode}\nglobalThis.qzoneTest = { qzoneCheckAuth, qzoneReadSettings, qzoneLoadSettings, qzoneLoadDispatchStatus, qzoneRefreshAudit, qzoneAction, qzoneAuthSubmit };`, context);

const validConfig = {
  ok: true, enabled: true, readAllowed: true, writeAllowed: false,
  tools: { read_posts: true, read_comments: true, publish: false, comment: false, reply: false, like: true },
  limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
  accessPaused: false, writePaused: true,
};
const validStatus = { ...validConfig, day: '2026-11-08', dispatchAvailable: false,
  quota: { post: { used: 0, limit: 3, remaining: 3 }, comment: { used: 0, limit: 25, remaining: 25 }, like: { used: 0, limit: 30, remaining: 30 } } };
const validAuth = { ok: true, state: 'set', session: { valid: true } };
responseByPath.set('/api/console/qqspace-column/auth/status', { status: 200, body: validAuth });
responseByPath.set('/api/console/qqspace-column/status', { status: 200, body: validStatus });
responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: validConfig });
responseByPath.set('/api/console/qqspace-column/audit', { status: 200, body: { ok: true, records: [
  // t55/D6：后端给每条记录带 kind（intent=读/写意图，settle=写结算），前端渲染成一张表 + 类型列。
  { kind: 'intent', time: '2026-11-08T01:00:00Z', source: 'patrol', action: 'comment', target: 'post-1', result: 'denied', reason: 'paused', content: '内容', redacted: true },
  { kind: 'settle', time: '2026-11-08T02:00:00Z', stage: 'write', action: 'publish', outcome: 'success', authorizationId: 'auth-1' },
] } });
await context.qzoneTest.qzoneCheckAuth();
assert.equal(getElementById('qzonePanel').hidden, false);
// t-1.2.0：状态读取成功时那一行必须**静默**（空文本 + hidden）。
// 原来这里断言的是常驻红字「空间工具/调度尚未接入，当前不可执行真实操作」——那句话已经删掉了，
// 因为它读起来像"功能没做完"，反而让用户以为整个专栏只是个空壳。容器留着，只在真出错时才显示。
assert.equal(getElementById('qzoneDispatchStatus').textContent, '');
assert.equal(getElementById('qzoneDispatchStatus').hidden, true);
assert.equal(getElementById('qzoneReadAllowed').checked, true);
assert.equal(getElementById('qzoneWriteAllowed').checked, false);
assert.equal(elements.get('qzoneQuotaPost').value, '3');
assert.equal(elements.get('qzoneQuotaComment').value, '25');
assert.equal(elements.get('qzoneQuotaLike').value, '30');
assert.equal(getElementById('qzoneStart').value, '07:00');
assert.equal(getElementById('qzoneEnd').value, '23:00');
assert.equal(context.qzoneTest.qzoneReadSettings().activeStart, 420);
assert.equal(context.qzoneTest.qzoneReadSettings().activeEnd, 1380);
assert.match(getElementById('qzonePauseStatus').textContent, /访问暂停：未暂停；写入暂停：已暂停/);
// t55/D6：审计现在渲染成「一张表 + 类型列」，不再是每行一个 div。
// 断言改成读表格：表头必须含「类型」，每条记录一行，首列是 kind 的中文说明。
const auditBox = getElementById('qzoneAudit');
const auditTable = auditBox.children[0];
assert.equal(auditTable.tagName, 'TABLE', '审计必须渲染为表格');
const [auditHead, ...auditRows] = auditTable.children;
assert.deepEqual(auditHead.children.map(cell => cell.textContent),
  ['类型', '时间', '来源', '动作', '目标', '结果', '原因', '内容'], '表头必须固定且类型列在首位');
assert.equal(auditRows.length, 2, '两条记录必须各占一行');
const rowText = (row) => row.children.map(cell => cell.textContent).join(' | ');
assert.match(rowText(auditRows[0]), /intent（意图）/);
assert.match(rowText(auditRows[0]), /post-1/);
assert.match(rowText(auditRows[0]), /已脱敏/);
// redacted=true 时只显示占位符，绝不再把原文放出来（这是脱敏的意义）。
assert.doesNotMatch(rowText(auditRows[0]), /内容/, 'redacted 记录的原文不得出现');
assert.match(rowText(auditRows[1]), /settle（结算）/, 'settle 行必须标成结算，不能伪装成意图');
assert.match(rowText(auditRows[1]), /success/, 'settle 行必须带它自己的 outcome 词汇');
assert.deepEqual(calls.slice(0, 4).map(({ url }) => url), [
  '/api/console/qqspace-column/auth/status', '/api/console/qqspace-column/status', '/api/console/qqspace-column/config', '/api/console/qqspace-column/audit',
]);
for (const { options } of calls) {
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers['x-console-token'], 'existing-console-token');
  assert.equal(options.headers['x-column-request'], '1');
  assert.equal(options.headers['x-qzone-request'], undefined);
}
calls.length = 0;
await context.qzoneTest.qzoneAction('/config', 'PATCH', context.qzoneTest.qzoneReadSettings(), '保存');
assert.equal(JSON.parse(calls[0].options.body).activeStart, 420, '07:00 必须提交为 420');
assert.equal(JSON.parse(calls[0].options.body).activeEnd, 1380, '23:00 必须提交为 1380');

// An incomplete config cannot overwrite the loaded form or authorize mutations.
getElementById('qzoneInterval').value = '45';
getElementById('qzoneInterval').listeners.input?.({ target: getElementById('qzoneInterval') });
responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: { ok: true } });
await context.qzoneTest.qzoneLoadSettings();
assert.equal(getElementById('qzoneSave').disabled, true, '不完整配置必须禁用保存');
assert.equal(getElementById('qzoneRecoverAll').disabled, true, '不完整配置必须禁用恢复');
assert.ok(getElementById('qzoneQuotaReset').children.every(button => button.disabled), '不完整配置必须禁用各额度重置');
assert.equal(getElementById('qzoneInterval').value, '45', '失败读取必须保留未保存的输入');
calls.length = 0;
await context.qzoneTest.qzoneAction('/quota/reset', 'POST', { kind: 'post' }, '重置');
assert.equal(calls.length, 0, '不完整配置不得发送管理请求');
for (const invalidConfig of [
  { ...validConfig, ok: undefined }, { ...validConfig, enabled: undefined },
  { ...validConfig, readAllowed: 'true' }, { ...validConfig, writeAllowed: null },
  { ...validConfig, accessPaused: undefined }, { ...validConfig, writePaused: 0 },
  { ...validConfig, tools: { ...validConfig.tools, reply: undefined } },
  { ...validConfig, limits: { ...validConfig.limits, like: 100 } },
  { ...validConfig, limits: { ...validConfig.limits, comment: -1 } },
  { ...validConfig, intervalMinutes: 14 }, { ...validConfig, intervalMinutes: 15.5 },
  { ...validConfig, activeStart: -1 }, { ...validConfig, activeEnd: 1440 },
  { ...validConfig, activeEnd: validConfig.activeStart },
]) {
  responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: invalidConfig });
  await context.qzoneTest.qzoneLoadSettings();
  assert.equal(getElementById('qzoneSave').disabled, true, '缺字段、类型错误或越界的配置必须拒绝');
  assert.equal(getElementById('qzoneInterval').value, '45', '无效响应不能覆盖草稿');
}
for (const field of ['enabled', 'readAllowed', 'writeAllowed', 'accessPaused', 'writePaused', 'tools', 'limits', 'intervalMinutes', 'activeStart', 'activeEnd']) {
  const incomplete = { ...validConfig }; delete incomplete[field];
  responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: incomplete });
  await context.qzoneTest.qzoneLoadSettings();
  assert.equal(getElementById('qzoneSave').disabled, true, `缺少 ${field} 时禁止保存`);
}
for (const [key] of context.qzoneToolNames) {
  const tools = { ...validConfig.tools }; delete tools[key];
  responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: { ...validConfig, tools } });
  await context.qzoneTest.qzoneLoadSettings();
  assert.equal(getElementById('qzoneSave').disabled, true, `缺少工具 ${key} 时禁止保存`);
}
for (const [key] of context.qzoneQuotaNames) {
  const limits = { ...validConfig.limits }; delete limits[key];
  responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: { ...validConfig, limits } });
  await context.qzoneTest.qzoneLoadSettings();
  assert.equal(getElementById('qzoneSave').disabled, true, `缺少额度 ${key} 时禁止保存`);
}
responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: validConfig });
await context.qzoneTest.qzoneLoadSettings();
assert.equal(getElementById('qzoneSave').disabled, false, '有效配置恢复管理操作');
assert.equal(getElementById('qzoneInterval').value, '45', '有效刷新也不能覆盖未保存的输入');
responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: { ...validConfig, limits: { ...validConfig.limits, post: 4 } } });
await context.qzoneTest.qzoneLoadSettings();
assert.equal(getElementById('qzoneInterval').value, '45', '刷新时保留已编辑字段');
assert.equal(elements.get('qzoneQuotaPost').value, '4', '未编辑字段应从完整响应读取，不能保留默认值');
responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: validConfig });
await context.qzoneTest.qzoneLoadSettings();
for (const invalidStatus of [
  { ...validStatus, ok: undefined }, { ...validStatus, dispatchAvailable: undefined },
  { ...validStatus, accessPaused: undefined }, { ...validStatus, day: 'invalid' },
  { ...validStatus, quota: { ...validStatus.quota, post: { used: -1, limit: 3, remaining: 3 } } },
  { ...validStatus, quota: { ...validStatus.quota, post: { used: 0, limit: 3, remaining: 2 } } },
  { ...validStatus, intervalMinutes: 14 }, { ...validStatus, activeEnd: 1440 },
]) {
  responseByPath.set('/api/console/qqspace-column/status', { status: 200, body: invalidStatus });
  await context.qzoneTest.qzoneLoadDispatchStatus();
  assert.equal(getElementById('qzoneSave').disabled, true, '状态缺失或越界时必须停止管理操作');
}
for (const field of ['day', 'enabled', 'readAllowed', 'writeAllowed', 'accessPaused', 'writePaused', 'tools', 'quota', 'intervalMinutes', 'activeStart', 'activeEnd', 'dispatchAvailable']) {
  const incomplete = { ...validStatus }; delete incomplete[field];
  responseByPath.set('/api/console/qqspace-column/status', { status: 200, body: incomplete });
  await context.qzoneTest.qzoneLoadDispatchStatus();
  assert.equal(getElementById('qzoneSave').disabled, true, `状态缺少 ${field} 时禁止保存`);
}
responseByPath.set('/api/console/qqspace-column/status', { status: 200, body: validStatus });
await context.qzoneTest.qzoneLoadDispatchStatus();
assert.equal(getElementById('qzoneSave').disabled, false);

calls.length = 0;
getElementById('qzoneEnabled').checked = true;
getElementById('qzoneReadAllowed').checked = false;
getElementById('qzoneWriteAllowed').checked = true;
elements.get('qzoneToolReadPosts').checked = true;
elements.get('qzoneQuotaPost').value = '2';
elements.get('qzoneQuotaComment').value = '19';
elements.get('qzoneQuotaLike').value = '29';
getElementById('qzoneInterval').value = '45';
getElementById('qzoneStart').value = '08:00';
getElementById('qzoneEnd').value = '22:00';
responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: validConfig });
await context.qzoneTest.qzoneAction('/config', 'PATCH', context.qzoneTest.qzoneReadSettings(), '保存');
assert.equal(calls[0].options.method, 'PATCH');
assert.deepEqual(JSON.parse(calls[0].options.body), {
  enabled: true, readAllowed: false, writeAllowed: true,
  tools: { read_posts: true, read_comments: true, publish: false, comment: false, reply: false, like: true },
  limits: { post: 2, comment: 19, like: 29 }, intervalMinutes: 45, activeStart: 480, activeEnd: 1320,
});

calls.length = 0;
await context.qzoneTest.qzoneAction('/quota/reset', 'POST', { kind: 'post' }, '重置');
await context.qzoneTest.qzoneAction('/quota/reset', 'POST', { kind: 'comment' }, '重置');
await context.qzoneTest.qzoneAction('/quota/reset', 'POST', { kind: 'like' }, '重置');
await context.qzoneTest.qzoneAction('/pause/restore', 'POST', { layer: 'access' }, '恢复');
await context.qzoneTest.qzoneAction('/pause/restore', 'POST', { layer: 'write' }, '恢复');
await context.qzoneTest.qzoneAction('/pause/restore', 'POST', { layer: 'both' }, '恢复');
await context.qzoneTest.qzoneRefreshAudit();
assert.deepEqual(calls.map(({ url, options }) => [url, options.method, options.body && JSON.parse(options.body)]), [
  ['/api/console/qqspace-column/quota/reset', 'POST', { kind: 'post' }],
  ['/api/console/qqspace-column/quota/reset', 'POST', { kind: 'comment' }],
  ['/api/console/qqspace-column/quota/reset', 'POST', { kind: 'like' }],
  ['/api/console/qqspace-column/pause/restore', 'POST', { layer: 'access' }],
  ['/api/console/qqspace-column/config', 'GET', undefined],
  ['/api/console/qqspace-column/pause/restore', 'POST', { layer: 'write' }],
  ['/api/console/qqspace-column/config', 'GET', undefined],
  ['/api/console/qqspace-column/pause/restore', 'POST', { layer: 'both' }],
  ['/api/console/qqspace-column/config', 'GET', undefined],
  ['/api/console/qqspace-column/audit', 'GET', undefined],
]);

// Editing while a save is in flight must survive its subsequent config reload.
let releaseSave;
const pendingSave = new Promise(resolve => { releaseSave = resolve; });
responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: { ok: true }, wait: pendingSave });
getElementById('qzoneInterval').value = '50';
getElementById('qzoneInterval').listeners.input?.({ target: getElementById('qzoneInterval') });
const saving = context.qzoneTest.qzoneAction('/config', 'PATCH', context.qzoneTest.qzoneReadSettings(), '保存');
getElementById('qzoneInterval').value = '51';
getElementById('qzoneInterval').listeners.input?.({ target: getElementById('qzoneInterval') });
responseByPath.set('/api/console/qqspace-column/config', { status: 200, body: validConfig });
releaseSave();
await saving;
assert.equal(getElementById('qzoneInterval').value, '51', '保存期间继续编辑不能被刷新覆盖');

// A dedicated column 401 must return to its password form without going through api().
calls.length = 0;
responseByPath.set('/api/console/qqspace-column/config', { status: 401, body: { ok: false, error: 'unauthorized' } });
await context.qzoneTest.qzoneLoadSettings();
assert.equal(getElementById('qzoneVerify').hidden, false);
assert.match(getElementById('qzoneAuthStatus').textContent, /会话已失效/);

// Password reset failure is reported as a server refusal; successful setup is not login until status says session.valid.
calls.length = 0;
getElementById('qzoneForgotPassword').value = 'offline-test-password';
responseByPath.set('/api/console/qqspace-column/auth/forgot-reset', { status: 409, body: { ok: false, reason: 'agent-not-paused' } });
await context.qzoneTest.qzoneAuthSubmit('forgot-reset', 'qzoneForgotPassword', 'qzoneForgotMessage');
assert.match(getElementById('qzoneForgotMessage').textContent, /服务端确认 QQAgent 尚未暂停，拒绝重设/);
assert.equal(calls[0].url, '/api/console/qqspace-column/auth/forgot-reset');
assert.deepEqual(JSON.parse(calls[0].options.body), { password: 'offline-test-password' });

calls.length = 0;
responseByPath.set('/api/console/qqspace-column/auth/setup', { status: 200, body: { ok: true } });
responseByPath.set('/api/console/qqspace-column/auth/status', { status: 200, body: { ok: true, state: 'set', session: { valid: false } } });
getElementById('qzoneSetupPassword').value = 'offline-test-password';
await context.qzoneTest.qzoneAuthSubmit('setup', 'qzoneSetupPassword', 'qzoneSetupMessage');
assert.equal(getElementById('qzonePanel').hidden, true, 'session.valid=false 时不可进入已登录面板');
assert.equal(getElementById('qzoneVerify').hidden, false);

for (const state of ['locked', 'untrusted', 'unrecognized-state']) {
  responseByPath.set('/api/console/qqspace-column/auth/status', { status: 200, body: { ok: true, state, lockedSeconds: 37, session: { valid: true } } });
  await context.qzoneTest.qzoneCheckAuth();
  assert.equal(getElementById('qzoneSetup').hidden, true, `${state} 不得回落到初始设置`);
  assert.equal(getElementById('qzonePanel').hidden, true, `${state} 必须 fail closed`);
  assert.equal(getElementById('qzoneAuthStateMessage').hidden, false);
}
responseByPath.set('/api/console/qqspace-column/auth/status', { status: 200, body: { state: 'set', session: { valid: true } } });
await context.qzoneTest.qzoneCheckAuth();
assert.equal(getElementById('qzonePanel').hidden, true, 'GET 缺少 ok:true 时不得通过认证');
assert.equal(getElementById('qzoneSetup').hidden, true, '认证状态无效时不得当成未设置密码');
assert.equal(getElementById('qzoneSave').disabled, true);

// In-process gateway + isolated SQLite: exercise the real auth, config and
// persistence paths without opening a socket or contacting any QQ service.
const fixtureRoot = resolve(tmpdir());
const fixtureDir = await mkdtemp(join(fixtureRoot, 'qzone-console-ui-'));
assert.equal(dirname(resolve(fixtureDir)), fixtureRoot);
assert.ok(basename(fixtureDir).startsWith('qzone-console-ui-'));
const fixturePath = join(fixtureDir, 'qzone.db');
const fixtureToken = randomBytes(24).toString('hex');
const fixturePassword = randomBytes(24).toString('hex');
const fixtureNow = Date.parse('2026-11-08T03:00:00Z');
const initialState = {
  enabled: false, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  reads: 0, writes: 0, probe: 'waiting',
  tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
  limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
  ledger: { day: '2026-11-08', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, audit: [],
};
let fixtureStore;
try {
  fixtureStore = openOfflineStore(fixturePath, initialState);
  const gateway = createQzoneConsoleGateway({
    store: fixtureStore, stateDir: fixtureDir, selfId: '123', consoleToken: fixtureToken,
    authorizeConsole: request => request.headers['x-console-token'] === fixtureToken,
    verifyCsrf: request => request.headers['x-column-request'] === '1',
    isAgentPaused: () => true, now: () => fixtureNow,
  });
  let cookie = '';
  const gatewayCalls = [];
  context.localStorage.getItem = key => key === 'consoleToken' ? fixtureToken : null;
  context.fetch = async (url, options) => {
    assert.equal(options.credentials, 'same-origin');
    const headers = { ...options.headers, ...(cookie ? { cookie } : {}) };
    const request = { method: options.method, pathname: url, headers,
      ...(options.body === undefined ? {} : { body: JSON.parse(options.body) }) };
    const result = await gateway(request);
    const setCookie = result.headers?.['set-cookie'];
    if (setCookie) cookie = setCookie.split(';')[0];
    gatewayCalls.push({ pathname: request.pathname, method: request.method, body: request.body, status: result.status });
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
  };
  context.qzoneDirtyFields.clear();
  context.qzoneDraftDirty = false;
  await context.qzoneTest.qzoneCheckAuth();
  assert.equal(getElementById('qzoneSetup').hidden, false);
  getElementById('qzoneSetupPassword').value = fixturePassword;
  await context.qzoneTest.qzoneAuthSubmit('setup', 'qzoneSetupPassword', 'qzoneSetupMessage');
  assert.equal(getElementById('qzonePanel').hidden, false);
  assert.equal(getElementById('qzoneSave').disabled, false);
  getElementById('qzoneStart').value = '08:30';
  getElementById('qzoneStart').listeners.input({ target: getElementById('qzoneStart') });
  getElementById('qzoneEnd').value = '23:05';
  getElementById('qzoneEnd').listeners.input({ target: getElementById('qzoneEnd') });
  await context.qzoneTest.qzoneAction('/config', 'PATCH', context.qzoneTest.qzoneReadSettings(), '保存');
  const patchCall = gatewayCalls.find(call => call.pathname.endsWith('/config') && call.method === 'PATCH');
  assert.ok(patchCall, '页面必须通过模拟 fetch 发送 PATCH');
  assert.equal(patchCall.status, 200, '真实网关必须接受配置修改');
  assert.equal(patchCall.body.activeStart, 510);
  assert.equal(patchCall.body.activeEnd, 1385);
  assert.equal(fixtureStore.read().activeStart, 510);
  assert.equal(fixtureStore.read().activeEnd, 1385);
  assert.equal(getElementById('qzoneStart').value, '08:30');
  assert.equal(getElementById('qzoneEnd').value, '23:05');
  fixtureStore.close();
  fixtureStore = openOfflineStore(fixturePath, initialState);
  assert.equal(fixtureStore.read().activeStart, 510, '重新打开 SQLite 后开始时间应保留');
  assert.equal(fixtureStore.read().activeEnd, 1385, '重新打开 SQLite 后结束时间应保留');
} finally {
  if (fixtureStore) fixtureStore.close();
  await rm(fixtureDir, { recursive: true, force: true });
}

console.log('QQ 空间控制台 behavior contract: PASS');
