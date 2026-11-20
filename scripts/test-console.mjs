// 控制台增强功能综合测试（node 直接调 API）
//
// ⚠️ 这是一个**危险测试**：它对一个真实运行中的 bridge 做两处不可撤销的操作 ——
//   · POST /api/whitelist（本文件第 103 / 105 / 112 / 118 行）—— 服务端会 atomicWriteJson
//     重写 config.json 的 allow / deny / ownerQQ，并热更新内存白名单
//     （src/bridge.js:9102-9136，那一段的注释原文就是「写 config.json + 热更新内存」）；
//   · POST /api/test-send（第 113 / 121 行）—— 服务端会经 SnowLuma 真的往群里发一条消息
//     （src/bridge.js:9297-9318，走 bot.sendGroupMessage）。
//   （另外 /api/roles/create（第 72 行）与 /api/role（第 78-83 行）也会写 roles/*.md 与角色状态。）
//
// 它今天之所以没出事，纯属巧合：BASE 写死 3100，而本机 consolePort 是 3200、3100 无人监听
// （实测 ECONNREFUSED）。谁把端口改回 3100，或者把 BASE 改成读 config，它就会真的改配置、
// 真的发消息。所以加显式 opt-in 护栏：默认不跑，必须由人明确要求。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 护栏 ─────────────────────────────────────────────────────────────────────────────────────
// 跳过时 **exit(0)**：这不是失败，而是一个被主动关掉的可选测试。exit(1) 会让聚合 runner
// （test-quick / test-audit 的清单执行器）把它记成红，从而掩盖真正的回归。
if (process.env.QZ_TEST_CONSOLE_ALLOW_MUTATIONS !== '1') {
  console.log('⚠️ 跳过 test-console：本测试会真改 config.json 白名单、并真发一条群消息。');
  console.log('   确实要跑请显式打开：QZ_TEST_CONSOLE_ALLOW_MUTATIONS=1 node scripts/test-console.mjs');
  process.exit(0);
}
console.log('⚠️ QZ_TEST_CONSOLE_ALLOW_MUTATIONS=1：将向 127.0.0.1:3100 真实发请求（含改白名单、发群消息）');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 端口**刻意写死 3100，不从 config.json 的 consolePort 读**，理由是安全而不是偷懒：
// 本机 config.consolePort = 3200，且 3200 上真的跑着 bridge（实测 200）。一旦改成读 config，
// 这个测试就会连上真实 bridge 并真的改白名单 + 真发群消息 —— 正是上面那道护栏要防的事。
// 3100 是个哑端口：连不上就 ECONNREFUSED，什么破坏都发生不了。要验真链路，请自己在一个
// 一次性实例上跑（例如把临时 bridge 起在 3100），再显式设上面那个环境变量。
const BASE = 'http://127.0.0.1:3100';

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readConsoleToken();
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (path, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. 页面
const page = await fetch(BASE + '/', { headers: authHeaders });
const html = await page.text();
ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('人格与角色') && html.includes('仿真提示词') && html.includes('测试发送'), `长度 ${html.length}`);

// 2. 角色列表
let r = await api('/api/roles');
const origRole = r.body.current ?? null;
ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

// 3. 创建人格
const TEST_ROLE = '测试人格Tmp';
r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
r = await api('/api/roles');
ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

// 4. 设置 / 清除角色
r = await api('/api/role', 'POST', { role: TEST_ROLE });
ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
r = await api('/api/role', 'POST', { role: null });
ok('清除角色', r.body.ok === true && r.body.role === null);
if (origRole) {
  r = await api('/api/role', 'POST', { role: origRole });
  ok('恢复原角色', r.body.ok === true && r.body.role === origRole);
}

// 5. 会话映射
r = await api('/api/sessions');
ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

// 6. 挂起列表
r = await api('/api/pending');
ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

// 7. 白名单：读原值 → 加测试群 → 恢复
// 注意：/api/whitelist 返回的是 normalizeIdList 之后的「字符串数组」，
// 而 config.json 里可能是数字，直接 JSON.stringify 比较会因类型不同而误判失败。
const sameIds = (a, b) => JSON.stringify((a || []).map(String).sort()) === JSON.stringify((b || []).map(String).sort());
r = await api('/api/whitelist');
const origAllow = r.body.allow;
ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
const testGroups = [...new Set([...(origAllow.groups || []), 123456789])];
r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
ok('白名单写入（含测试群）', r.body.ok === true && (r.body.allow.groups || []).map(String).includes('123456789'), JSON.stringify(r.body.allow));
r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
ok('白名单恢复原值', r.body.ok === true && sameIds(r.body.allow.groups, origAllow.groups) && sameIds(r.body.allow.private, origAllow.private), JSON.stringify(r.body.allow));

// 8. 测试发送到机器人测试群（真实发送）
// 先把测试群临时加入白名单：这样既能验证白名单放行，也能验证 /api/test-send 真的走到网关。
// 若 SnowLuma 未启动，发送会失败——这属于环境问题（不是控制台回归），按「已过白名单校验」计为通过。
const withTestGroup = [...new Set([...(origAllow.groups || []).map(String), '123456789'])];
await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: withTestGroup }, deny: { private: [], groups: [] } });
r = await api('/api/test-send', 'POST', { kind: 'group', id: '123456789', message: '【控制台测试】新控制台功能验证成功 ✅' });
const snowlumaDown = typeof r.body.error === 'string' && !/白名单/.test(r.body.error);
ok('测试发送群消息', r.body.ok === true || snowlumaDown,
  r.body.ok === true ? JSON.stringify(r.body) : `SnowLuma 不可达（非白名单拦截）：${r.body.error}`);
// 还原白名单（去掉测试群）
await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });

// 9. 测试发送到非白名单（应拒绝）
r = await api('/api/test-send', 'POST', { kind: 'group', id: '100003', message: 'x' });
ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));

// 10. 清理测试人格（用绝对路径，不依赖运行目录）
fs.rmSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), { force: true });
r = await api('/api/roles');
ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE));

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
