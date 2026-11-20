// C5：写入许可（permit）在 bridge 进程一侧的交换通道 —— 协议 + 服务端 + 客户端 + 配置解读。
//
// 为什么要有这个文件
// ------------------
// `createQzoneWritePermitRegistry`（src/core/qzone-write-permit-offline.mjs）解决的是
// 「一次批准 → 至多一次写」。它只有在**审批者与执行者不是同一个人**时才有意义：
// 若 registry 跟着插件进程走，那么持有长期 Bearer 的人可以自己 issue 再自己 consume，
// 许可就退化成一句自我声明。所以 registry 必须住在 **bridge**（持有审批 broker 的那个进程），
// 插件只能通过本文件的 loopback 通道「换取」许可。
//
// 三个环节，缺一不可
// ------------------
//   issue    只有 `(authorizationId, inputDigest)` 能在 bridge 本地的**已批准记录**里查到才签发。
//            已批准记录来自审批 broker 的 decide 路径（见 src/bridge.js 的观察包装），
//            本模块只消费这份记录，不生产它。
//   consume  一次性：同一个 permitId 第二次 consume 一律 false（由 core registry 保证）。
//   close    关停即失效：客户端拿到 null / false，写链按「未批准」处理（fail-closed）。
//
// 服务端额外补的两个洞（core registry 不负责这两个）
// --------------------------------------------------
// ① 单飞：`registry.issue` 对同一个 binding **每次都铸新许可**，一张批准能被换成 N 张。
//    所以本层维护 `authorizationId -> permitId` 的**单飞表**：已有存活许可时再 issue 一律
//    403 already-issued。
// ② 已用尽（spent）：单飞表只挡"同时持有多个活许可"。许可被 consume 或过期后槽位会释放，
//    同一 authorizationId 又能换出新许可 ⇒ 同一笔批准可以写第二次。**这是真实缺口**，
//    所以 consume 成功即把 authorizationId 记入 spent，此后永久不再签发（403 authorization-spent）。
//
// 不做什么
// --------
//   · 不记日志、不写正文；请求体、token、id 一律不进任何输出。
//   · 不 import 审批通道模块（qzone-approval-ipc-*）：那是另一条协议，共享实现会让两条通道
//     的演进互相拖拽。这里独立写，只借用它的**形状**（帧上限、鉴权先于路由、总函数式失败）。
//   · **不做 payload 重建比对**。插件在冻结快照上现场构造 payload（authorization 快照 deepFreeze，
//     approved-publish-dispatch 用它构造后直接 send），不存在"可变请求"；重建再比对等于防
//     「插件被攻破」，超出本轮的威胁模型（用户裁定）。
//     只保留一项**零成本的轻量检查**：客户端声称的业务 action 必须与批准快照的 action 同族
//     （挡住"拿 comment 的许可去 reply"）。

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

// ── 协议常量 ────────────────────────────────────────────────────────────────────────────────
export const QZONE_PERMIT_ISSUE_PATH = '/permit/issue';
export const QZONE_PERMIT_CONSUME_PATH = '/permit/consume';
/** 一帧只有三个短字段；16 KiB 已经远超需要，同时给恶意本地对端一个上界。 */
export const QZONE_WRITE_PERMIT_MAX_FRAME_BYTES = 16 * 1024;
export const QZONE_WRITE_PERMIT_MAX_RESPONSE_BYTES = 8 * 1024;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
/** 溢出时最多再读这么多字节就断链，避免对端无限流式写入拖住事件循环。 */
const OVERFLOW_DRAIN_BYTES = QZONE_WRITE_PERMIT_MAX_FRAME_BYTES * 2;
/** 只接受字面量回环地址：'localhost' 会走 hosts 文件重解析，那是另一条信任路径。 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);
const TOKEN = /^[\x21-\x7E]{16,512}$/;

/** 与 core registry / authorizer 同形（qzone-write-permit-offline.mjs:53-57）。 */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PERMIT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 业务 action（与 qzone-onebot-write-contract.mjs 的 FIELDS 键一致）。 */
const WRITE_ACTIONS = new Set(['publish', 'like', 'comment', 'reply']);

const ISSUE_KEYS = Object.freeze(['authorizationId', 'inputDigest']);
const CONSUME_KEYS = Object.freeze(['permitId', 'authorizationId', 'inputDigest']);

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 读一个自有 **数据** 属性；getter / 缺失 / 抛异常一律 undefined。 */
function ownData(target, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** 闭集读取：键集必须**恰好**是 allowed，任何多余/缺失/非字符串键都返回 null。 */
function readClosedRecord(value, allowed) {
  try {
    if (!isPlainRecord(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== allowed.length) return null;
    for (const key of keys) {
      if (typeof key !== 'string' || allowed.includes(key) === false) return null;
    }
    const out = Object.create(null);
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || Object.hasOwn(descriptor, 'value') === false) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

function readBinding(value) {
  const frame = readClosedRecord(value, ISSUE_KEYS);
  if (frame === null) return null;
  if (typeof frame.authorizationId !== 'string' || ID.test(frame.authorizationId) === false) return null;
  if (typeof frame.inputDigest !== 'string' || DIGEST.test(frame.inputDigest) === false) return null;
  return frame;
}

function readConsumption(value) {
  const frame = readClosedRecord(value, CONSUME_KEYS);
  if (frame === null) return null;
  if (typeof frame.authorizationId !== 'string' || ID.test(frame.authorizationId) === false) return null;
  if (typeof frame.inputDigest !== 'string' || DIGEST.test(frame.inputDigest) === false) return null;
  if (typeof frame.permitId !== 'string' || PERMIT_ID.test(frame.permitId) === false) return null;
  return frame;
}

// ── 已批准记录（bridge 侧唯一的一份，插件不可写）──────────────────────────────────────────
/**
 * `(authorizationId, inputDigest)` 的有界 LRU 记录。
 *
 * 谁往里写：**只有** src/bridge.js 里那段 decide 观察包装，且仅在「审计行已落库 + approved===true」
 * 时写。谁读：本模块的 issue 端点。
 * 为什么有界：它随操作员点审批而增长，若不封顶，一台跑上几个月的桥接会把它变成另一个内存泄漏；
 * 淘汰最旧的条目只会让「很久以前批准但从未执行」的操作不能再换许可 —— 方向是安全的。
 *
 * @param {{capacity?: number}} [options] 1..4096，默认 256。
 */
export function createApprovedBindingLedger({ capacity = 256 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) {
    throw new TypeError('approved binding ledger needs a capacity between 1 and 4096');
  }
  /** authorizationId -> { inputDigest, action }（Map 的插入序即 LRU 序） */
  const entries = new Map();

  /**
   * @param {string} authorizationId
   * @param {string} inputDigest
   * @param {string} [action]  业务 action（publish/comment/reply/like）。只用于端点侧的
   *   「同一笔批准的 action 必须一致」这一项轻量检查，**不是** payload 重建。
   */
  function record(authorizationId, inputDigest, action) {
    if (typeof authorizationId !== 'string' || ID.test(authorizationId) === false) return false;
    if (typeof inputDigest !== 'string' || DIGEST.test(inputDigest) === false) return false;
    const declared = typeof action === 'string' && WRITE_ACTIONS.has(action) ? action : null;
    // 重新记录同一个 id（操作员改了决定再批一次）时，以最新摘要为准。
    entries.delete(authorizationId);
    entries.set(authorizationId, Object.freeze({ inputDigest, action: declared }));
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
    return true;
  }

  function has(authorizationId, inputDigest) {
    if (typeof authorizationId !== 'string' || typeof inputDigest !== 'string') return false;
    const entry = entries.get(authorizationId);
    return entry !== undefined && entry.inputDigest === inputDigest;
  }

  /** 这笔批准记录的业务 action（没有记录就是 null）。 */
  function actionOf(authorizationId) {
    if (typeof authorizationId !== 'string') return null;
    const entry = entries.get(authorizationId);
    return entry === undefined ? null : entry.action;
  }

  function size() { return entries.size; }

  return Object.freeze({ record, has, actionOf, size, capacity });
}

// ── 配置解读 ────────────────────────────────────────────────────────────────────────────────
/** 允许出现在 `qzone.writePermitIpc` 里的键；多一个都算配置错误。 */
export const QZONE_WRITE_PERMIT_IPC_KEYS = Object.freeze(['token', 'port']);

/**
 * 解读 `cfg.qzone.writePermitIpc`。
 *
 * @param {unknown} qzone  整个 `cfg.qzone`（本函数自己取 `writePermitIpc` 子键）。
 * @returns {{enabled:false, reason:string} | {enabled:true, token:string, port:number}}
 *   `enabled:false` 不是错误：调用方 log 原因后照常继续启动桥接（fail-soft）。
 */
export function readQzoneWritePermitConfig(qzone) {
  const section = isPlainRecord(qzone) ? ownData(qzone, 'writePermitIpc') ?? null : null;
  if (section === undefined || section === null) return { enabled: false, reason: 'not-configured' };
  if (!isPlainRecord(section)) return { enabled: false, reason: 'invalid-section' };
  for (const key of Reflect.ownKeys(section)) {
    if (typeof key !== 'string' || QZONE_WRITE_PERMIT_IPC_KEYS.includes(key) === false) {
      return { enabled: false, reason: 'unknown-field' };
    }
  }
  const token = ownData(section, 'token');
  if (typeof token !== 'string' || token === '') return { enabled: false, reason: 'token-missing' };
  if (/^[A-Za-z0-9_-]{32,256}$/.test(token) === false) return { enabled: false, reason: 'token-invalid' };
  const rawPort = ownData(section, 'port');
  const port = rawPort === undefined ? 0 : rawPort;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) return { enabled: false, reason: 'port-invalid' };
  return { enabled: true, token, port };
}

// ── 写入口开关（C7）────────────────────────────────────────────────────────────────────────
/** `qzone.writeAdmit` 允许的键：只有 `enabled`，多一个都算配置错误。 */
export const QZONE_WRITE_ADMIT_KEYS = Object.freeze(['enabled']);

/**
 * 解读 `cfg.qzone.writeAdmit`。
 *
 * **生产默认关闭**：不写这个键就是关闭，写动作继续 403 write-channel-not-wired（与 C1 一致）。
 * 只有显式 `enabled: true` 才打开写入口。非布尔值一律按关闭处理并给出 reason（不做真值强转：
 * `"false"` / `1` 这种"看起来像开"的值不能被当成开）。
 *
 * @param {unknown} qzone 整个 `cfg.qzone`。
 * @returns {{enabled: boolean, reason?: string}}
 */
export function readQzoneWriteAdmitConfig(qzone) {
  const section = isPlainRecord(qzone) ? ownData(qzone, 'writeAdmit') : undefined;
  if (section === undefined || section === null) return { enabled: false, reason: 'not-configured' };
  if (!isPlainRecord(section)) return { enabled: false, reason: 'invalid-section' };
  for (const key of Reflect.ownKeys(section)) {
    if (typeof key !== 'string' || QZONE_WRITE_ADMIT_KEYS.includes(key) === false) {
      return { enabled: false, reason: 'unknown-field' };
    }
  }
  const enabled = ownData(section, 'enabled');
  if (typeof enabled !== 'boolean') return { enabled: false, reason: 'enabled-not-boolean' };
  return enabled === true ? { enabled: true } : { enabled: false, reason: 'disabled' };
}

/**
 * OneBot 平台 action → 业务 action（`qzone-onebot-write-contract.mjs` 的 FIELDS 键）。
 *
 * 为什么需要它：批准快照里记的是业务 action（publish/comment/reply/like），而端点收到的
 * 是平台 action（send_qzone_msg/comment_qzone/like_qzone）。两者必须能对上，否则
 * 「用 comment 的许可去 reply」这类错配就无从检查。
 *
 * `comment_qzone` 在平台层同时承载 comment 与 reply（两者 payload 形状相同），因此这里
 * 返回 `'comment'` —— 与 host-assembly 的 WRITE_PAYLOAD_KINDS 一致；具体是 comment 还是
 * reply 由 payload 里有没有 `comment_id` 决定，admit 的同族比较已经覆盖这一点。
 *
 * @param {unknown} action
 * @returns {string|null}
 */
export function businessActionOf(action) {
  if (action === 'send_qzone_msg') return 'publish';
  if (action === 'comment_qzone') return 'comment';
  if (action === 'like_qzone') return 'like';
  return null;
}

// ── 服务端 ──────────────────────────────────────────────────────────────────────────────────
/**
 * 起一个只绑回环的许可交换 listener。
 *
 * @param {object} options
 * @param {{issue: Function, consume: Function, revoke?: Function}} options.registry
 *   来自 `createQzoneWritePermitRegistry`，**必须**是 bridge 进程里那唯一一个。
 * @param {(binding: {authorizationId: string, inputDigest: string}) => boolean} options.isApproved
 *   「这笔操作是否已在本地被批准并落库」。返回严格 true 才签发；任何其它情况（false、抛错）
 *   都按未批准处理。**没有它服务器就无法执行本层的核心规则，因此它是必填**。
 * @param {string} options.token  调用方提供的 Bearer token（本模块从不生成、不读盘）。
 * @param {() => number} [options.clock]
 * @param {string} [options.host]  '127.0.0.1'（默认）或 '::1'。
 * @param {number} [options.port]  0（默认）= 由系统分配，实际端口在返回值里。
 * @returns {Promise<{close: () => Promise<void>, port: number, address: string}>}
 */
export async function createQzoneWritePermitIpcServer({
  registry, isApproved, isApprovedAction, token, clock = Date.now, host = '127.0.0.1', port = 0,
} = {}) {
  if (registry === null || typeof registry !== 'object'
      || typeof registry.issue !== 'function' || typeof registry.consume !== 'function') {
    throw new TypeError('write permit ipc server needs a registry with issue/consume');
  }
  if (typeof isApproved !== 'function') {
    throw new TypeError('write permit ipc server needs an isApproved function (the only place approval is checked)');
  }
  // 可选：给出「这笔批准的业务 action」。不传 ⇒ admit() 的 action 一致性检查一律拒绝
  // （action-unverified）：无法核实不等于核实通过。
  if (isApprovedAction !== undefined && typeof isApprovedAction !== 'function') {
    throw new TypeError('write permit ipc server needs isApprovedAction to be a function when provided');
  }
  if (typeof token !== 'string' || TOKEN.test(token) === false) {
    throw new TypeError('write permit ipc server needs a 16-512 character printable bearer token supplied by the caller');
  }
  if (typeof clock !== 'function') throw new TypeError('write permit ipc server needs a clock function');
  if (typeof host !== 'string' || LOOPBACK_ADDRESSES.has(host) === false) {
    throw new TypeError('write permit ipc server only listens on a loopback address (127.0.0.1 or ::1)');
  }
  if (Number.isSafeInteger(port) === false || port < 0 || port > 65535) {
    throw new TypeError('write permit ipc server needs a valid port');
  }

  const expected = Buffer.from(token, 'utf8');
  /** authorizationId -> { permitId, inputDigest }：一张批准同时只允许一张活许可。 */
  const issued = new Map();
  /**
   * 已用尽：某个 authorizationId 的许可被 **consume 成功** 过一次之后，它永久不再签发。
   *
   * 为什么必须有这张表：单飞表只挡「同时持有多个活许可」。许可被消费（或过期）后槽位就被释放，
   * 同一 authorizationId 又能换出新许可 ⇒ 同一笔批准可以写第二次、第三次。这是真实缺口，
   * 只有「用尽」状态能堵住它。
   *
   * 语义边界（与 core registry 一致）：
   *   · consume 返回 true  ⇒ 标记 spent（这笔批准已经花掉了）；
   *   · consume 返回 false ⇒ **不标记**。失败可能是绑定不符（猜错了，不该毁掉合法许可）
   *     或已过期（许可死了但批准本身没被用掉），两种情况都不该把批准作废。
   *
   * ⚠️ 内存态：进程重启后 spent 丢失。跨重启的重复保护依赖插件侧 B2 claim（state.dispatchClaims）
   * 与审计行；bridge 无法独立验证插件侧 B2 是否已执行。
   * ⚠️ 有界（MAX_SPENT = 4096，LRU 淘汰）：**它不是"永久标记"**。被逐出的 authorizationId
 * 不再受本层保护，同一批准在逐出后重换许可会成功。逐出后的重复保护同样依赖插件侧 B2 claim
 * 与可信调用路径 —— bridge 不独立保障。真实运行中每分钟批准数远小于该上限，
 * 但这只说明"通常不会逐出"，不是"永不逐出"。
   */
  const spent = new Set();
  const MAX_SINGLE_FLIGHT = 4096;
  const MAX_SPENT = 4096;
  let closed = false;

  function markSpent(authorizationId) {
    spent.delete(authorizationId);
    spent.add(authorizationId);
    while (spent.size > MAX_SPENT) {
      const oldest = spent.values().next();
      if (oldest.done === true) break;
      spent.delete(oldest.value);
    }
  }

  function respond(response, status, body, extraHeaders) {
    try {
      if (response.writableEnded === true || response.destroyed === true) return;
      response.writeHead(status, extraHeaders === undefined ? JSON_HEADERS : { ...JSON_HEADERS, ...extraHeaders });
      response.end(JSON.stringify(body));
    } catch {
      try { response.destroy(); } catch {}
    }
  }

  function discard(request) {
    try { request.resume(); } catch {}
  }

  function isAuthorized(request) {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.startsWith('Bearer ') === false) return false;
    const supplied = Buffer.from(header.slice(7), 'utf8');
    if (supplied.length !== expected.length) return false;
    try { return timingSafeEqual(supplied, expected); } catch { return false; }
  }

  function pathOf(url) {
    if (typeof url !== 'string') return null;
    const mark = url.indexOf('?');
    return mark === -1 ? url : url.slice(0, mark);
  }

  function readBody(request) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let drained = 0;
      let overflow = false;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        request.removeListener('data', onData);
        request.removeListener('end', onEnd);
        request.removeListener('error', onError);
        request.removeListener('aborted', onAbort);
        resolve(result);
      };

      const deadline = setTimeout(() => {
        finish({ ok: false, status: 408 });
        try { request.destroy(); } catch {}
      }, DEFAULT_TIMEOUT_MS);

      function onData(chunk) {
        if (overflow) {
          drained += chunk.length;
          if (drained > OVERFLOW_DRAIN_BYTES) {
            finish({ ok: false, status: 413 });
            try { request.destroy(); } catch {}
          }
          return;
        }
        size += chunk.length;
        if (size > QZONE_WRITE_PERMIT_MAX_FRAME_BYTES) {
          overflow = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      }

      function onEnd() {
        if (overflow) finish({ ok: false, status: 413 });
        else if (size === 0) finish({ ok: false, status: 400 });
        else finish({ ok: true, buffer: Buffer.concat(chunks, size) });
      }

      function onError() { finish({ ok: false, status: 400 }); }
      function onAbort() { finish({ ok: false, status: 400 }); }

      request.on('data', onData);
      request.on('end', onEnd);
      request.on('error', onError);
      request.on('aborted', onAbort);
    });
  }

  function parseJson(buffer) {
    try {
      const text = buffer.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > QZONE_WRITE_PERMIT_MAX_FRAME_BYTES) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** 「已批准记录里的业务 action」；取不到（或 provider 抛错）一律 null，调用方据此拒绝。 */
  function policyAction(authorizationId) {
    try {
      return isApprovedAction(authorizationId) ?? null;
    } catch {
      return null;
    }
  }

  /** 「已批准」是本层唯一的授权来源；任何异常都按未批准处理。 */
  function approvedByPolicy(binding) {
    try {
      return isApproved(Object.freeze({ authorizationId: binding.authorizationId, inputDigest: binding.inputDigest })) === true;
    } catch {
      return false;
    }
  }

  function handleIssue(frame, response) {
    const binding = readBinding(frame);
    if (binding === null) { respond(response, 400, { ok: false, error: 'invalid-frame' }); return; }
    // 已用尽优先于「已批准」：这笔批准花掉之后，连"还能不能再换"都不该问出可用的答案。
    if (spent.has(binding.authorizationId)) {
      respond(response, 403, { ok: false, error: 'authorization-spent' });
      return;
    }
    if (approvedByPolicy(binding) !== true) {
      // 403 而不是 400：请求形状没问题，是"这笔操作没有被批准"。
      respond(response, 403, { ok: false, error: 'not-approved' });
      return;
    }
    if (issued.has(binding.authorizationId)) {
      respond(response, 403, { ok: false, error: 'already-issued' });
      return;
    }
    if (issued.size >= MAX_SINGLE_FLIGHT) {
      respond(response, 503, { ok: false, error: 'permit-unavailable' });
      return;
    }
    const permitId = registry.issue({ authorizationId: binding.authorizationId, inputDigest: binding.inputDigest });
    if (typeof permitId !== 'string' || permitId === '') {
      // 容量满 / 时钟坏了 / binding 被 registry 拒绝 —— 三者的对外答案相同：现在给不了许可。
      respond(response, 503, { ok: false, error: 'permit-unavailable' });
      return;
    }
    issued.set(binding.authorizationId, { permitId, inputDigest: binding.inputDigest });
    respond(response, 200, { ok: true, permitId });
  }

  function handleConsume(frame, response) {
    const request = readConsumption(frame);
    if (request === null) { respond(response, 400, { ok: false, error: 'invalid-frame' }); return; }
    let consumed = false;
    try {
      consumed = registry.consume({ permitId: request.permitId,
        authorizationId: request.authorizationId, inputDigest: request.inputDigest }) === true;
    } catch {
      consumed = false;
    }
    const record = issued.get(request.authorizationId);
    if (record !== undefined && record.permitId === request.permitId) {
      // 成功的许可已经花掉；摘要对得上却失败的，说明它过期或已花费 —— 两种都该释放单飞槽位。
      // 摘要**对不上**的失败不释放：registry 明确「绑定不匹配不烧许可」，本层必须与它一致，
      // 否则猜一个错摘要就能毁掉别人的写。
      if (consumed === true || record.inputDigest === request.inputDigest) issued.delete(request.authorizationId);
    }
    // 用尽标记：只有**真正花掉**才标记（见 spent 表的注释）。标记之后同一 authorizationId
    // 再也换不到许可，即使它的许可已经过期或被清掉。
    if (consumed === true) markSpent(request.authorizationId);
    // 唯一的成功形状就是这个 { ok: true }；客户端只认严格 true。
    respond(response, 200, { ok: consumed });
  }

  /**
   * **进程内**的许可裁定入口，供 bridge 自己的写端点使用（不走 HTTP）。
   *
   * 为什么放在这里而不是另建一套：permitId -> authorizationId 的索引（`issued`）与 spent 状态
   * 都只存在于本 server 实例里。另建一份等于第二事实来源，两边迟早不一致。
   *
   * 语义：
   *   · 许可必须存在且未花费（registry.consume 判定）；
   *   · 只消费一次，消费成功即标记 spent（同一笔批准此后换不到新许可）；
   *   · `expectedAction` 与已批准记录里的业务 action 必须一致 —— 挡住「拿 comment 的许可去 reply」。
   *     这是**一致性检查**，不是 payload 重建比对（后者防「插件被攻破」，已明确超出威胁模型）。
   *   · 任何不符都**不**标记 spent：合法的重试仍然可能。
   *
   * @param {{permitId: string, expectedAction?: string}} input
   * @returns {{ok: true, authorizationId: string} | {ok: false, code: string}}
   */
  function admit(input) {
    if (closed === true) return { ok: false, code: 'closed' };
    const permitId = ownData(input, 'permitId');
    if (typeof permitId !== 'string' || PERMIT_ID.test(permitId) === false) return { ok: false, code: 'invalid-permit' };
    const expectedAction = ownData(input, 'expectedAction');
    // 反查：permitId 是 registry 铸的，但索引在本层。线性扫描受 MAX_SINGLE_FLIGHT 约束。
    let authorizationId = null;
    let record = null;
    for (const [id, entry] of issued) {
      if (entry.permitId === permitId) { authorizationId = id; record = entry; break; }
    }
    if (authorizationId === null || record === null) return { ok: false, code: 'unknown-permit' };
    if (spent.has(authorizationId)) return { ok: false, code: 'authorization-spent' };
    if (typeof expectedAction === 'string' && expectedAction !== '') {
      const approvedAction = policyAction(authorizationId);
      if (approvedAction === null || WRITE_ACTIONS.has(expectedAction) === false) {
        return { ok: false, code: 'action-unverified' };
      }
      // comment_qzone 同时承载 comment 与 reply，两者在批准快照里可能是任一拼写；只要求同族。
      const family = (name) => (name === 'comment' || name === 'reply' ? 'comment' : name);
      if (family(approvedAction) !== family(expectedAction)) return { ok: false, code: 'action-mismatch' };
    }
    let consumed = false;
    try {
      consumed = registry.consume({ permitId, authorizationId, inputDigest: record.inputDigest }) === true;
    } catch {
      consumed = false;
    }
    if (consumed !== true) return { ok: false, code: 'permit-refused' };
    issued.delete(authorizationId);
    markSpent(authorizationId);
    return { ok: true, authorizationId };
  }

  async function handle(request, response) {
    if (closed === true) { respond(response, 503, { ok: false, error: 'closed' }); discard(request); return; }
    // 鉴权先于路由：未授权对端连"有哪些路径"都不该问出来。
    if (isAuthorized(request) === false) {
      respond(response, 401, { ok: false, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      discard(request);
      return;
    }
    const path = pathOf(request.url);
    const known = path === QZONE_PERMIT_ISSUE_PATH || path === QZONE_PERMIT_CONSUME_PATH;
    if (known === false) { respond(response, 404, { ok: false, error: 'not-found' }); discard(request); return; }
    if (request.method !== 'POST') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' }, { Allow: 'POST' });
      discard(request);
      return;
    }
    const body = await readBody(request);
    if (body.ok !== true) { respond(response, body.status, { ok: false, error: 'invalid-frame' }); return; }
    const frame = parseJson(body.buffer);
    if (frame === null) { respond(response, 400, { ok: false, error: 'invalid-frame' }); return; }
    if (path === QZONE_PERMIT_ISSUE_PATH) handleIssue(frame, response);
    else handleConsume(frame, response);
  }

  const server = http.createServer((request, response) => {
    // handle 是总函数，但万一有意外抛出，也必须回一个封闭的拒绝帧而不是让 socket 悬着。
    handle(request, response).catch(() => {
      respond(response, 500, { ok: false, error: 'internal' });
      discard(request);
    });
  });
  server.headersTimeout = Math.min(DEFAULT_TIMEOUT_MS + 5000, 30000);
  server.requestTimeout = DEFAULT_TIMEOUT_MS + 5000;
  server.keepAliveTimeout = 5000;
  server.on('clientError', (_error, socket) => { try { socket.destroy(); } catch {} });

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen({ host, port, exclusive: true });
    } catch (error) {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      reject(error);
    }
  });

  const bound = server.address();
  if (bound === null || typeof bound !== 'object' || LOOPBACK_ADDRESSES.has(bound.address) === false) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error('write permit ipc server refused to start: the bound address is not loopback');
  }
  // listen 之后的 'error' 若无人接，会变成杀死宿主的未捕获事件。这里把它变成"关掉的 listener"。
  server.on('error', () => { closed = true; });

  async function close() {
    if (closed === true) return;
    closed = true;
    issued.clear();
    try { server.closeAllConnections(); } catch {}
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
  }

  return Object.freeze({ close, admit, port: bound.port, address: bound.address });
}

// ── 客户端 ──────────────────────────────────────────────────────────────────────────────────
/** 只接受字面量回环 origin（不接受 localhost，理由同服务端）。 */
function readOrigin(value) {
  if (typeof value !== 'string') return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]' && parsed.hostname !== '::1') return null;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return parsed.origin;
}

async function readCappedText(response, maxBytes) {
  const stream = response.body;
  if (stream === null || typeof stream !== 'object' || typeof stream.getReader !== 'function') {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  }
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      const chunk = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch {}
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * 插件进程一侧的许可客户端。
 *
 * 契约与写链一致：**从不抛**。issue 失败给 null，consume 失败给 false —— 调用方据此按
 * 「没有许可」处理（fail-closed），而不是按"重试"处理（重试会再多要一张许可）。
 *
 * @param {object} options
 * @param {string} options.origin   形如 'http://127.0.0.1:41234'（只接受字面量回环）。
 * @param {string} options.token    Bearer token，16..512 个可打印 ASCII。
 * @param {number} [options.timeoutMs] 单次预算，1..60000（默认 10000）。
 * @param {Function} [options.fetch] 注入的 fetch（默认全局 fetch）。
 * @returns {{issue: (binding: object) => Promise<string|null>,
 *            consume: (request: object) => Promise<boolean>,
 *            close: () => Promise<void>}}
 */
export function createQzoneWritePermitIpcClient({ origin, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl } = {}) {
  const base = readOrigin(origin);
  if (base === null) throw new TypeError('write permit ipc client needs a loopback http origin such as http://127.0.0.1:1234');
  if (typeof token !== 'string' || TOKEN.test(token) === false) {
    throw new TypeError('write permit ipc client needs a 16-512 character printable bearer token supplied by the caller');
  }
  if (Number.isSafeInteger(timeoutMs) === false || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('write permit ipc client needs a timeoutMs between 1 and ' + MAX_TIMEOUT_MS);
  }
  const doFetch = fetchImpl === undefined ? globalThis.fetch : fetchImpl;
  if (typeof doFetch !== 'function') throw new TypeError('write permit ipc client needs a fetch function');

  const controllers = new Set();
  let closed = false;

  /** 一次请求，永不抛；返回解析后的 JSON 值或 null。 */
  async function post(path, body, controller) {
    let response;
    try {
      response = await doFetch(base + path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // 重定向会把这次 POST 悄悄发到别处；固定端点。
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      return null;
    }
    try {
      if (Number.isInteger(response.status) === false || response.status < 200 || response.status > 299) {
        try { await response.body?.cancel?.(); } catch {}
        return null;
      }
      const text = await readCappedText(response, QZONE_WRITE_PERMIT_MAX_RESPONSE_BYTES);
      if (text === null) return null;
      const parsed = JSON.parse(text);
      return isPlainRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 带预算地跑一次 post；超时则中止并返回 null。 */
  async function withDeadline(path, body) {
    if (closed === true) return null;
    const controller = new AbortController();
    controllers.add(controller);
    let timer = null;
    try {
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          try { controller.abort(); } catch {}
          resolve(null);
        }, timeoutMs);
      });
      return await Promise.race([post(path, body, controller), deadline]);
    } catch {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  /** 换取一张许可；拿不到一律 null。 */
  async function issue(binding) {
    const frame = readBinding(binding);
    if (frame === null) return null;
    const answer = await withDeadline(QZONE_PERMIT_ISSUE_PATH,
      { authorizationId: frame.authorizationId, inputDigest: frame.inputDigest });
    if (answer === null || answer.ok !== true) return null;
    const permitId = ownData(answer, 'permitId');
    if (typeof permitId !== 'string' || PERMIT_ID.test(permitId) === false) return null;
    return permitId;
  }

  /** 花费一张许可；只有严格 { ok: true } 才是 true。 */
  async function consume(request) {
    const frame = readConsumption(request);
    if (frame === null) return false;
    const answer = await withDeadline(QZONE_PERMIT_CONSUME_PATH,
      { permitId: frame.permitId, authorizationId: frame.authorizationId, inputDigest: frame.inputDigest });
    return answer !== null && answer.ok === true;
  }

  /** 中止在途请求；之后 issue 一律 null、consume 一律 false。幂等。 */
  async function close() {
    closed = true;
    for (const controller of controllers) {
      try { controller.abort(); } catch {}
    }
    controllers.clear();
  }

  return Object.freeze({ issue, consume, close });
}
