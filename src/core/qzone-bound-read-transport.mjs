import { buildQzoneOnebotReadRequest } from './qzone-onebot-contract-offline.mjs';

// ── 两个动作、三套闭集 ─────────────────────────────────────────────────────────────────────
// 本模块只承载两个只读动作，字段集**逐个枚举**而不是「有就收」：多一个字段、少一个字段都
// 是 notSent，这样调用方不可能顺手塞进本层不认识的参数。
//
// 形状恰好三种（t40 的调用方按第一种和第三种调用）：
//   · 没有 `action` 字段          → list，恰好 6 个字段（C1 以来的形状，逐字节不变）；
//   · `action: 'get_qzone_msg_list'` → list，恰好 7 个字段（显式声明，等价于上一种）；
//   · `action: 'get_qzone_msg_detail'` → detail，恰好 8 个字段（多一个 `tid`）。
//
// 为什么允许显式写出 list 动作：`action` 的合法取值就是这两个（见下），只在 detail 时才认它
// 会让「加个 action 说清楚」变成一个莫名其妙的 notSent —— 那是给人挖坑，不是收紧边界。
// 真正的收紧在于：取值只能是这两个，别的值（包括 send_qzone_msg 这类写动作）一律 notSent。
const LIST_ACTION = 'get_qzone_msg_list';
const DETAIL_ACTION = 'get_qzone_msg_detail';

const LIST_FIELDS = new Set(['target_uin', 'pos', 'num', 'botQq', 'connectionEpoch', 'sourceProofId']);
const LIST_FIELDS_WITH_ACTION = new Set([...LIST_FIELDS, 'action']);
const DETAIL_FIELDS = new Set([...LIST_FIELDS, 'action', 'tid']);

// 与 `qzone-onebot-contract-offline.mjs:9` 的 TID_PATTERN 同口径。这里**也**判一次，不是重复：
// 路由要在**发出任何请求之前**给出带 not-sent 标记的拒绝，而契约构造器抛的是普通 TypeError
// —— 那会被本模块归成「未知结果」并白烧一个 trackingLimit 名额。
const TID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Marker for "this call refused BEFORE anything was sent to the platform".
//
// The reader sets `dispatched = true` immediately before calling the transport, and
// its catch branch treats every throw after that point as a possible post-dispatch
// failure (unknown outcome, charge kept). That is correct for a transport failure
// during the actual request, but wrong for the guards below: they run before the
// request is built, so no platform read happened and the caller must be able to tell
// the two apart. Without this marker three refused calls (a revoked source, an epoch
// bump, a malformed snapshot) permanently burned `trackingLimit` slots while issuing
// zero `get_qzone_msg_list` calls.
//
// The evidence is a MODULE-PRIVATE symbol plus a WeakSet of the exact error objects
// this module created. A `Symbol.for(...)` registry key would have been forgeable by
// any same-process module that spelled the key, and the refund it unlocks is a quota
// bypass: a forged marker on an error raised AFTER the send would let a read happen
// without ever charging a slot. Membership in the WeakSet cannot be forged without
// getting a reference to one of these error objects, and the reader exposes none.
const NOT_SENT = Symbol('qzone.read.not-sent');
const notSentErrors = new WeakSet();

// The only supported way for a caller to ask "was this refusal pre-dispatch?".
export function isQzoneReadNotSent(error) {
  return error !== null && typeof error === 'object' && notSentErrors.has(error);
}

const notSent = () => {
  const error = new Error('qzone read unavailable');
  Object.defineProperty(error, NOT_SENT, { value: true });
  notSentErrors.add(error);
  return error;
};

// Transport binding only. Callers must authenticate the connection, prove the
// request source, apply policy, and use an epoch that changes on every reconnect.
// This module is not registered as a production tool or an authorization gate.
//
// WHY `get_qzone_msg_detail` IS CHECKED LAZILY AND NOT AT CONSTRUCTION: requiring both
// methods here would be a breaking change for every existing caller and probe that only ever
// reads lists (test-qzone-bound-read-transport, the r7/not-sent/sent-ordering probes). More
// importantly it would be the wrong failure MODE: a missing detail method would make the whole
// transport unbuildable, i.e. list reads would stop working because an unrelated action is
// unconfigured. Checked at the call that needs it, the failure is local, carries the not-sent
// marker (so it costs no trackingLimit slot), and list reads are untouched.
export function createQzoneBoundReadTransport({ botQq, getConnectionEpoch, transport } = {}) {
  if (!Number.isSafeInteger(botQq) || botQq <= 0 || typeof getConnectionEpoch !== 'function' ||
      typeof transport?.get_qzone_msg_list !== 'function') throw new TypeError('invalid read transport dependencies');
  return async function boundRead(input, isStillAuthorized) {
    let sent = false;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw notSent();
      const keys = Reflect.ownKeys(input);
      for (const key of keys) {
        if (typeof key !== 'string') throw notSent();
      }
      // ── 选形状：先看有没有 `action`，再决定哪一套闭集 ───────────────────────────────────────
      // 向后兼容的判据是「**输入里没有 action 这个键**」，不是「action === undefined」：
      // 显式写 `action: undefined` 的调用方是在违反闭集，应当 notSent，而不是被当成 list 放行。
      // 这正是下面用 keys.length 比较而不是逐字段 has 的原因。
      const hasAction = keys.includes('action');
      let action = LIST_ACTION;
      let fields = LIST_FIELDS;
      if (hasAction) {
        if (keys.length === DETAIL_FIELDS.size) { fields = DETAIL_FIELDS; }
        else if (keys.length === LIST_FIELDS_WITH_ACTION.size) { fields = LIST_FIELDS_WITH_ACTION; }
        else throw notSent();
      }
      if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw notSent();
      const snapshot = {};
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw notSent();
        snapshot[key] = descriptor.value;
      }
      if (hasAction) {
        // 只认这两个只读动作。写动作（send_qzone_msg / comment_qzone / like_qzone）在这里
        // 一律 notSent —— 本模块是读传输，永远不该把写动作送出去。
        if (snapshot.action === DETAIL_ACTION) action = DETAIL_ACTION;
        else if (snapshot.action === LIST_ACTION) action = LIST_ACTION;
        else throw notSent();
        // 字段集与动作必须自洽：detail 必须带 tid，list 必须不带。
        if (action === DETAIL_ACTION && !fields.has('tid')) throw notSent();
        if (action === LIST_ACTION && fields.has('tid')) throw notSent();
      }
      if (snapshot.botQq !== botQq || !Number.isSafeInteger(snapshot.connectionEpoch) || snapshot.connectionEpoch < 0 ||
          typeof snapshot.sourceProofId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.sourceProofId)) throw notSent();
      // tid 在**发出任何请求之前**单独判定一次：契约构造器抛的是普通 TypeError，会被本模块的
      // catch 归成「未知结果」（不带 not-sent），于是白烧一个 trackingLimit 名额。
      if (action === DETAIL_ACTION && (typeof snapshot.tid !== 'string' || !TID_PATTERN.test(snapshot.tid))) throw notSent();
      let request;
      try {
        request = action === DETAIL_ACTION
          ? buildQzoneOnebotReadRequest(DETAIL_ACTION, {
            target_uin: snapshot.target_uin, pos: snapshot.pos, num: snapshot.num, tid: snapshot.tid,
          })
          : buildQzoneOnebotReadRequest(LIST_ACTION, {
            target_uin: snapshot.target_uin, pos: snapshot.pos, num: snapshot.num,
          });
      } catch {
        // 传参形状由契约模块最终裁定；它拒绝也发生在发出之前，所以同样必须带 not-sent。
        throw notSent();
      }
      // `getConnectionEpoch` itself can throw (the source is gone). That is still a
      // refusal raised before anything was sent, so it must carry the marker too.
      // Left unmarked it was charged as an "unknown outcome" while issuing zero
      // `get_qzone_msg_list` calls, and three of those exhaust `trackingLimit` — the
      // exact lockout this marker exists to prevent.
      let liveEpoch;
      try {
        liveEpoch = await getConnectionEpoch();
      } catch {
        throw notSent();
      }
      if (liveEpoch !== snapshot.connectionEpoch) throw notSent();
      // No await between the synchronous guard and invoking this local
      // transport. This does not guarantee atomicity across a remote process.
      if (typeof isStillAuthorized !== 'function' || isStillAuthorized() !== true) throw notSent();
      // 依赖在**需要它的那一次调用**上检查：缺 detail 方法只让 detail 读失败并带 not-sent，
      // 而不是让整个 transport 构造不出来（见工厂函数上方那段说明）。
      const send = action === DETAIL_ACTION ? transport.get_qzone_msg_detail : transport.get_qzone_msg_list;
      if (typeof send !== 'function') throw notSent();
      sent = true;
      const result = await send.call(transport, request.params);
      // envelope 校验对两个动作完全一致：没有按动作放松的余地。
      if (await getConnectionEpoch() !== snapshot.connectionEpoch || result?.kind !== 'trusted-envelope' ||
          !result.envelope || typeof result.envelope !== 'object') throw new Error();
      return result.envelope;
    } catch (error) {
      // Only a refusal this module raised BEFORE the send may be reported as
      // not-sent; every failure after `sent` stays indistinguishable from a lost
      // response. `sent` is checked first because it is the stronger fact: even a
      // genuinely pre-dispatch error object must not be re-thrown once the request
      // went out (that combination is impossible today, and this ordering keeps it
      // fail-closed if a future guard moves past the send).
      if (sent !== true && notSentErrors.has(error)) throw error;
      throw new Error('qzone read unavailable');
    }
  };
}
