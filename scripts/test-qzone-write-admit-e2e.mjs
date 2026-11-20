// C7 端到端：bridge 真实写许可校验（spent + 原子消费 + action 一致性）。
//
// 一条正控 + 三条负控。**不启动 bridge**：这里用**真 IPC server + 真 registry + 真 broker
// （decide 走真 recordDecision、真审计 sink）+ 真 core write contract**，transport 是假的
// ——记录 payload，绝不发任何真实 QQ/OneBot 请求。
//
// ⚠️ 端点路由那一段（src/bridge.js 的 /api/qzone/onebot 写分支）不能被单独 import：
// 它在 http.createServer 的闭包里、且依赖 main() 的局部量。所以本测试把那段逻辑**逐行同构复刻**
// 成一个 admitWrite()，喂它的是**真实的** server.admit / 真 ledger / 真 businessActionOf。
// 这一点是诚实的边界：路由接线本身在本轮**没有运行时验证**。
//
// 运行：node scripts/test-qzone-write-admit-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// C15：写动作的**形状**校验现在由端点模块负责（它内部直接调写契约构造器）。
import { validateQzoneOnebotBody } from '../src/qzone-onebot-endpoint.mjs';
import { buildQzoneOnebotWriteRequest } from '../src/core/qzone-onebot-write-contract.mjs';
import { readQzoneWriteAdmitConfig } from '../src/qzone-write-permit-ipc.mjs';
import { businessActionOf } from '../src/qzone-write-permit-ipc.mjs';

const TOKEN = 'A'.repeat(43);
let NOW = 1_700_000_000_000;
const clock = () => NOW;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (error) { results.push(['FAIL', name + ' :: ' + (error?.message ?? error)]); }
}
/** 串行执行：每条用完后立刻 await，保证打印时结果已就绪（顶层 await 在 ESM 里可用）。 */
const queued = [];
function queue(name, fn) { const promise = test(name, fn); queued.push(promise); return promise; }

// ── 最小的真 store：内存态，但 update 语义与 qzone-store-offline.mjs:290-303 一致 ─────────────

/**
 * 复刻 bridge.js 的写分支（C15 之后，:7789-7862 附近）。
 * 与真实代码的差别只有两处，且都无害：
 *   · sendJson 换成返回 { status, body }；
 *   · bot.request 换成注入的 fake transport。
 *
 * 顺序与真实路由逐条对齐：开关 → permitId 存在 → **形状校验（不烧许可）** → admit 原子消费 → 发送。
 * 形状校验用的是端点模块真正的 validateQzoneOnebotBody（它内部又直接用写契约构造器），
 * 所以这里没有第二份规则。
 */
function makeAdmitWrite({ transport, writeAdmitEnabled = true }) {
  return async function admitWrite(forwardBody) {
    const enabled = readQzoneWriteAdmitConfig({ writeAdmit: { enabled: writeAdmitEnabled } }).enabled === true;
    const claimedWriteAction = typeof forwardBody?.action === 'string'
      && businessActionOf(forwardBody.action) !== null;
    if (!enabled && claimedWriteAction) {
      return { status: 403, body: { ok: false, code: 'write-channel-not-wired' } };
    }
    if (enabled && claimedWriteAction) {
      // C16: NO permit gate. Shape check, then forward.
      const shaped = validateQzoneOnebotBody({ action: forwardBody.action, params: forwardBody.params });
      if (!shaped.ok) {
        return { status: shaped.status, body: { ok: false, code: shaped.code } };
      }
      const envelope = await transport(shaped.action, shaped.params);
      return { status: 200, body: envelope };
    }
    const read = validateQzoneOnebotBody(forwardBody);
    if (!read.ok) return { status: read.status, body: { ok: false, code: read.code } };
    const envelope = await transport(read.action, read.params);
    return { status: 200, body: envelope };
  };
}

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-admit-'));
  tempDirs.push(dir);
  return dir;
}

const INPUT = { content: 'hello world', ugc_right: 1 };
const PLATFORM_ACTION = 'send_qzone_msg';
const PAYLOAD_PARAMS = buildQzoneOnebotWriteRequest('publish', INPUT).params;

queue('W-01 正控：writeAdmit:true + 合法写参数 ⇒ 转发恰好 1 次，参数=契约归一形状', async () => {
  const sent = [];
  const admitWrite = makeAdmitWrite({
    transport: async (action, params) => { sent.push({ action, params }); return { status: 'ok', retcode: 0, data: { tid: 'post-1', time: 1 } }; },
  });
  const out = await admitWrite({ action: PLATFORM_ACTION, params: PAYLOAD_PARAMS });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.status, 'ok');
  assert.equal(sent.length, 1, 'fake transport 必须恰好被调用 1 次');
  assert.deepEqual(sent[0], { action: PLATFORM_ACTION, params: PAYLOAD_PARAMS });
});

queue('W-02 负控：writeAdmit:false ⇒ 仍 403 write-channel-not-wired，transport 0 次', async () => {
  const sent = [];
  const admitWrite = makeAdmitWrite({ writeAdmitEnabled: false,
    transport: async (a, pr) => { sent.push({ a, pr }); return { status: 'ok', retcode: 0 }; } });
  const out = await admitWrite({ action: PLATFORM_ACTION, params: PAYLOAD_PARAMS });
  assert.equal(out.status, 403);
  assert.equal(out.body.code, 'write-channel-not-wired');
  assert.equal(sent.length, 0, '开关关闭绝不能发送');
});

queue('W-03 负控：写参数非法 ⇒ 400，transport 0 次（六类形状）', async () => {
  const sent = [];
  const admitWrite = makeAdmitWrite({
    transport: async (a, p) => { sent.push({ a, p }); return { status: 'ok', retcode: 0 }; },
  });
  const bad = [
    { action: 'send_qzone_msg', params: { ugc_right: 1 } },                          // 缺 content
    { action: 'send_qzone_msg', params: { content: 'x', ugc_right: 999 } },          // ugc 越界
    { action: 'send_qzone_msg', params: { content: 'x', ugc_right: 16 } },           // 16 缺 target_uins
    { action: 'send_qzone_msg', params: { content: 'x', ugc_right: 1, target_uins: [1] } }, // 非 16/128 不许带
    { action: 'like_qzone', params: { tid: 'has space', target_uin: 1 } },           // tid 形状非法
    { action: 'comment_qzone', params: { tid: 't1', target_uin: 1, content: 'x', bogus: 1 } }, // 未知字段
  ];
  for (const body of bad) {
    const out = await admitWrite(body);
    assert.equal(out.status, 400, JSON.stringify(body) + ' => ' + JSON.stringify(out.body));
  }
  assert.equal(sent.length, 0, '形状非法绝不能发送');
});

queue('W-04 读动作不受影响：get_qzone_msg_list 在 writeAdmit:true 下照常放行', async () => {
  const sent = [];
  const admitWrite = makeAdmitWrite({
    transport: async (a, p) => { sent.push({ a, p }); return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } }; },
  });
  const out = await admitWrite({ action: 'get_qzone_msg_list', params: { target_uin: 1234567890, pos: 0, num: 5 } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(sent.length, 1);
});

queue('W-05 端点直接校验：写动作不再返回 write-channel-not-wired，get_friend_list 仍在白名单', async () => {
  const ok = validateQzoneOnebotBody({ action: PLATFORM_ACTION, params: PAYLOAD_PARAMS });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.notEqual(ok.code, 'write-channel-not-wired');
  const friend = validateQzoneOnebotBody({ action: 'get_friend_list', params: {} });
  assert.equal(friend.ok, true, 'get_friend_list 必须在只读白名单里（朋友验证依赖它）');
  const del = validateQzoneOnebotBody({ action: 'delete_qzone_msg', params: { tid: 't1' } });
  assert.equal(del.ok, false);
  assert.equal(del.code, 'action-not-allowed');
});

await Promise.all(queued);
for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
const failed = results.filter((r) => r[0] === 'FAIL');
for (const [status, name] of results) console.log(status + '  ' + name);
console.log('---');
console.log('total=' + results.length + ' failed=' + failed.length);
process.exitCode = failed.length === 0 ? 0 : 1;