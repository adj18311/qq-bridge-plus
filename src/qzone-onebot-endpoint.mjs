// QQ 空间：本地 OneBot 转发端点（POST /api/qzone/onebot）的**纯门禁**。
//
// 为什么单独成文件：bridge.js 不能被启动（有用户未提交改动 + 会连真实 QQ），所以路由里那几段
// 判定必须能**脱离服务单独 import** 才能验证。本模块只放纯函数：不读 config、不建连接、
// 不发请求、不写盘、不记日志、不碰 state/。
//
// ── 三条不可让步的口径（写在这里防止以后被"优化"掉）────────────────────────────────
// 1) 动作白名单**不是**身份/权限验证。真正的边界是独立的传输令牌
//    （authorizeQzoneOnebotRequest）＋ 只绑 127.0.0.1；白名单只是第二道闸。
// 2) 写动作**参数合法 ≠ 允许发送**。本模块只做形状判定（下面 readWriteParams，规则直接来自写契约）；
//    「能不能发」由 bridge 路由决定：cfg.qzone.writeAdmit.enabled !== true ⇒ 路由在进入本模块**之前**
//    就回 403 write-channel-not-wired；开关打开 ⇒ 必须出示 bridge 签发的 permitId 并原子消费。
//    所以本模块**不持有任何许可状态**，也无法单独把请求放进写链。
// 3) 只放**按现行契约核实过**的动作，不为了"凑通"放宽：
//      · get_qzone_msg_list   —— src/core/qzone-onebot-contract-offline.mjs:1-2（读请求构造器
//                                的全部合法动作）＋ src/core/qzone-onebot-read-transport.mjs:227（传输层）。
//      · get_qzone_msg_detail —— 同上构造器 :3 / 传输层 :230。**read_comments 的真正动作就是它**：
//                                src/core/qzone-mcp-contract.mjs:69 把 `read_comments` 映射到
//                                detail，src/core/qzone-live-friend-read.mjs:392 用
//                                projectQzoneOnebotMsgDetail 投影 detail 响应（该投影器见
//                                src/core/qzone-onebot-comment-projection-offline.mjs:111-116，
//                                注释明确写「Project a successful SnowLuma get_qzone_msg_detail envelope」）。
//                                注意：_snowluma-catalog.json 里没有 detail 这一条（该目录不完整），
//                                所以这里的依据是上列契约模块，不是目录。
//      · get_login_info       —— _snowluma-catalog.json:767；bridge 自己的 qzone 控制台
//                                getIdentity 也用它（src/bridge.js:7185）。
//      · get_friend_list      —— 好友证明（qzone-friend-source-runtime.mjs:20 在读任何
//                                list/detail 之前调用它）；只读，不产生任何变更。
//    写：send_qzone_msg / comment_qzone / like_qzone —— 参数形状由写契约构造器判定（见 readWriteParams）。
//    容器外的任何 action（delete_qzone_msg / set_qzone_* / get_group_msg_history …）一律 403。
import crypto from 'node:crypto';
// 写参数规则**只从契约取**，不在这里重写一遍：契约模块已经把「哪些字段合法、每个字段什么形状、
// 可见性与收件人的耦合」定死（qzone-onebot-write-contract.mjs:3-8,77-114）。端点若自己抄一份，
// 两份规则迟早漂移，而漂移方向一定是端点更宽 —— 那就等于端点接受了平台会拒的请求。
import {
  isValidWriteId, buildQzoneOnebotWriteRequest
} from './core/qzone-onebot-write-contract.mjs';

/** 本端点允许转发的只读动作（冻结数组：运行期无法被 push 放宽）。 */
export const QZONE_ONEBOT_READ_ACTIONS = Object.freeze([
  'get_qzone_msg_list',
  'get_qzone_msg_detail',
  'get_login_info',
  // get_friend_list: the friendship proof behind read_posts / read_comments.
  // qzone-friend-source-runtime.mjs:20 calls it before any list/detail fetch, and
  // without it the reader answers `unverified` even when every other gate passed.
  // Read-only: it returns the account's friend roster and mutates nothing. Added
  // after the operator granted full read AND write authority to the plugin.
  'get_friend_list'
]);

/**
 * 三个写动作的平台名（名字取自 src/core/qzone-onebot-write-contract.mjs:93/101/113）。
 *
 * 它们的**参数形状**由本模块的 readWriteParams 校验，规则直接来自契约构造器
 * （buildQzoneOnebotWriteRequest），不另写一份。
 *
 * ⚠️ 参数合法 ≠ 允许发送。真正的授权闸门在 bridge 路由里：
 *   · cfg.qzone.writeAdmit.enabled !== true ⇒ 路由在进入校验器**之前**回 403 write-channel-not-wired；
 *   · 开关打开 ⇒ 必须出示 bridge 自己签发的 permitId，由 handle.admit() 原子消费，一次批准至多一次发送。
 * 本模块只负责形状，不持有任何许可状态。
 */
export const QZONE_ONEBOT_WRITE_ACTIONS = Object.freeze([
  'send_qzone_msg',
  'comment_qzone',
  'like_qzone'
]);

const LIST_FIELDS = new Set(['target_uin', 'pos', 'num']);
const DETAIL_FIELDS = new Set(['tid', 'target_uin', 'pos', 'num']);
// 与 src/core/qzone-onebot-contract-offline.mjs:9 的 TID_PATTERN 同形（应用侧保守判定）。
const TID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const refuse = (status, code, message) => ({ ok: false, status, code, message });

/** 纯对象：原型必须是 Object.prototype 或 null（JSON.parse 产物 / Node 的 req.headers 都满足）。 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 正整数的无损表示：number 安全正整数，或可无损往返的十进制字符串。 */
function canonicalUin(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && String(n) === value ? n : null;
  }
  return null;
}

function readParams(action, params) {
  // Both of these take NO parameters. Grouped because the check is identical, and because
  // a future no-argument action must not silently fall through to the paging path below
  // (which would demand a target_uin the caller never had).
  if (action === 'get_login_info' || action === 'get_friend_list') {
    if (Reflect.ownKeys(params).length !== 0) return refuse(400, 'invalid-params', action + ' 不接受任何参数');
    return { ok: true, params: {} };
  }
  const allowed = action === 'get_qzone_msg_detail' ? DETAIL_FIELDS : LIST_FIELDS;
  for (const key of Reflect.ownKeys(params)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return refuse(400, 'invalid-params', `${action} 不接受字段 ${String(key)}`);
    }
  }
  // body 只可能来自 JSON.parse（bridge 的 readBody），不会有 getter；这里仍按字段逐个取值，
  // 保证返回给 SDK 的 params 是**新建对象**，不会带上原型链上的任何东西。
  const targetUin = canonicalUin(params.target_uin);
  if (targetUin === null) {
    return refuse(400, 'invalid-params', 'target_uin 必须是正安全整数或其无损十进制字符串');
  }
  const pos = params.pos === undefined ? 0 : params.pos;
  if (!Number.isSafeInteger(pos) || pos < 0) return refuse(400, 'invalid-params', 'pos 必须是非负安全整数');
  const num = params.num === undefined ? 20 : params.num;
  if (!Number.isSafeInteger(num) || num < 1 || num > 100) {
    return refuse(400, 'invalid-params', 'num 必须是 1..100 的整数');
  }
  if (action === 'get_qzone_msg_detail') {
    if (typeof params.tid !== 'string' || !TID_PATTERN.test(params.tid) || !isValidWriteId(params.tid)) {
      return refuse(400, 'invalid-params', 'tid 必须是 1..128 位 [A-Za-z0-9_-]');
    }
    // 字段顺序与 SnowLuma action 定义一致（qzone-onebot-contract-offline.mjs:95-106）。
    return { ok: true, params: { tid: params.tid, target_uin: targetUin, pos, num } };
  }
  return { ok: true, params: { target_uin: targetUin, pos, num } };
}

/**
 * 写动作的参数形状校验 —— 规则**全部来自写契约**，本模块不复制任何一条。
 *
 * 做法：把端点收到的平台 action + params 翻译成契约的业务 kind，然后**真的调一次**
 * `buildQzoneOnebotWriteRequest(kind, params)`：
 *   · 它抛 TypeError ⇒ 形状不合法 ⇒ 400（字段不在白名单、content 空/超长、ugc_right 越界、
 *     收件人与可见性不配套、tid/uin 形状不对、reply 目标半套……全部由它一处判定）；
 *   · 它成功 ⇒ 返回**它构造出来的** `{ action, params }`，路由就把这一份交给 SDK。
 *
 * 为什么用"构造出来的那份"而不是原样回传 params：契约的产物已经是规范化形状
 * （字段顺序、target_uins 逐个 qq() 归一、错位字段被拒绝），交给平台的就是它。
 * 这样"端点接受的"与"契约接受的"永远是同一个集合，不可能漂移。
 *
 * kind 的判定用契约自己的判别式（与 plugins/qzone-safe/host-assembly.mjs:178-186 一致）：
 * `comment_qzone` 同时承载 comment 与 reply，两者的字段白名单**互斥**
 * （comment: tid/target_uin/content；reply 额外要求 comment_id + comment_uin），
 * 所以"两个都在"就是 reply，否则是 comment。半套（只有一个）会被契约拒绝。
 */
function readWriteParams(action, params) {
  const kind = writeKindOf(action, params);
  if (kind === null) return refuse(400, 'invalid-params', `${action} 参数与写契约不匹配`);
  let built;
  try {
    built = buildQzoneOnebotWriteRequest(kind, params);
  } catch {
    // 契约的异常文案可能回显字段名；这里统一成一句可诊断但不回显取值的话。
    return refuse(400, 'invalid-params', `${action} 参数不符合写契约（${kind}）`);
  }
  // 契约可能把 kind 折成同一个平台 action（comment/reply → comment_qzone）；对不上就是内部错。
  if (built?.action !== action) return refuse(400, 'invalid-params', `${action} 与契约 action 不一致`);
  return { ok: true, action, params: built.params };
}

/** 平台 action + params ⇒ 契约的业务 kind；判不出来返回 null。 */
function writeKindOf(action, params) {
  if (action === 'send_qzone_msg') return 'publish';
  if (action === 'like_qzone') return 'like';
  if (action === 'comment_qzone') {
    const hasId = Object.hasOwn(params, 'comment_id');
    const hasUin = Object.hasOwn(params, 'comment_uin');
    // 两者必须同进同出；只有半套时仍按 reply 交给契约，让它明确拒绝（而不是在端点这里猜）。
    if (hasId !== hasUin) return 'reply';
    return hasId ? 'reply' : 'comment';
  }
  return null;
}

/**
 * 校验 POST body（必须形如 `{ action, params }`）。
 * 返回 `{ ok: true, action, params }` 或 `{ ok: false, status, code, message }`；
 * 调用方（路由）只负责把 status/code 原样回给客户端，不做二次判断。
 */
export function validateQzoneOnebotBody(body) {
  if (!isPlainObject(body)) return refuse(400, 'invalid-body', 'body 必须是 { action, params } 形式的纯对象');
  for (const key of Reflect.ownKeys(body)) {
    if (key !== 'action' && key !== 'params') return refuse(400, 'unknown-field', '只接受 action 与 params 两个字段');
  }
  const action = body.action;
  if (typeof action !== 'string' || action.trim() === '') {
    return refuse(400, 'action-required', 'action 必须是非空字符串');
  }
  // 写动作：校验参数形状后放行。**授权不在这里判断** —— 那是路由的 permitId 门禁
  // （开关关闭时路由根本走不到这里；开关打开时必须先过 admit）。本模块只说"这个请求长得对不对"。
  if (QZONE_ONEBOT_WRITE_ACTIONS.includes(action)) {
    if (!isPlainObject(body.params)) return refuse(400, 'invalid-params', 'params 必须是纯对象');
    return readWriteParams(action, body.params);
  }
  if (!QZONE_ONEBOT_READ_ACTIONS.includes(action)) {
    return refuse(403, 'action-not-allowed', `动作不在本端点的只读白名单内：${action}`);
  }
  if (!isPlainObject(body.params)) return refuse(400, 'invalid-params', 'params 必须是纯对象');
  const shaped = readParams(action, body.params);
  if (!shaped.ok) return shaped;
  return { ok: true, action, params: shaped.params };
}

function tokensEqual(supplied, expected) {
  const a = Buffer.from(String(supplied), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 端点鉴权。**独立**于控制台 cookie/x-console-token 与 x-agent-token：
 *   · 未配置令牌 ⇒ 503（整个端点禁用，fail-closed，不退回任何"无鉴权放行"）；
 *   · 只认 `Authorization: Bearer <token>`，定长比较；
 *   · 带智能体会话凭据（x-agent-token / x-agent-call）的请求一律 403，避免 MCP 流量把
 *     管理面凭据当成"转发端点通行证"。
 * @param {Record<string, unknown>} headers Node 的 req.headers
 * @param {unknown} expectedToken cfg.qzone.onebotForwardToken
 */
export function authorizeQzoneOnebotRequest(headers, expectedToken) {
  const expected = typeof expectedToken === 'string' ? expectedToken.trim() : '';
  if (expected === '') {
    return refuse(503, 'forward-token-not-configured',
      '端点未启用：config.json 缺少 qzone.onebotForwardToken');
  }
  if (expected.length < 32 || expected.length > 256 || !/^[A-Za-z0-9_-]+$/.test(expected)) {
    return refuse(503, 'forward-token-invalid',
      '端点未启用：qzone.onebotForwardToken 不合法（需 32..256 位 [A-Za-z0-9_-]）');
  }
  if (headers === null || typeof headers !== 'object') {
    return refuse(401, 'unauthorized', '缺少请求头');
  }
  if (headers['x-agent-token'] !== undefined || headers['x-agent-call'] !== undefined) {
    return refuse(403, 'agent-call-forbidden', '本端点不接受智能体会话凭据，请使用独立转发令牌');
  }
  const raw = String(headers.authorization ?? '').trim();
  const match = /^Bearer[ ]+(\S+)$/i.exec(raw);
  if (!match) return refuse(401, 'unauthorized', '缺少 Authorization: Bearer <token>');
  if (!tokensEqual(match[1], expected)) return refuse(401, 'unauthorized', '转发令牌无效');
  return { ok: true };
}

/**
 * 把 SDK 的 ApiResponse 投影成 OneBot envelope：只保留 `status` / `retcode` / `data`。
 * 平台附带的 msg/wording 等字段不转发；本进程持有的任何令牌/cookie 更不可能出现在这里
 * （`bot.request` 的返回里没有它们，而这里又是白名单投影）。
 * 形状不认识时返回 null，由路由回 502（绝不把半截对象当成功回给调用方）。
 */
export function buildQzoneOnebotEnvelope(response) {
  if (!isPlainObject(response)) return null;
  const { status, retcode } = response;
  if (typeof status !== 'string' || !Number.isSafeInteger(retcode)) return null;
  const envelope = { status, retcode };
  if (Object.hasOwn(response, 'data') && response.data !== undefined) envelope.data = response.data;
  return envelope;
}
