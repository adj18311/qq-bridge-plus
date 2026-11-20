// R10-1 候选 B 的最小原型（隔离离线，假 store）。
//
// 目标：把「一次读取尝试的身份」从「含 turn/step 的 referenceId」改成
// 「不含代际、不含 turn 的 (account, sessionId, requestId, callId)」，
// 让它在 store 里跨代存活，从而堵住换代后的重放窗口。
//
// 明确不做、也不声称的事情：
//   1) 这不是认证。写进 store 只表示「这个键出现过」，不证明写入方是谁。
//      能直接调用 store.update 的代码可以插入键（拒绝服务方向），也可以跳过
//      这一步（前提是它已经在写权威状态，那它本来就绕过一切）。
//   2) 不提供裁剪。原型里没有任何 TTL / 容量淘汰：删一个键就重开一次重放，
//      必须由真正证明过保存期与代际注销的方案来裁，而不是这里随手加个上限。
//   3) 不解决「同 requestId 换 callId」的重放。那是另一个问题：同一个 QQ 消息
//      内部重试是合法的（模型可以重发），由 tracking 额度与 requestTurns 管，
//      不在本原型职责内。本原型只保证「同一个 call 不会被算两次」。
//
// 关键取舍：claim() 在派发之前落库，所以「结果未知」会永久占用该键。
// 这是 fail-closed 方向（宁可拒绝重放，也不给免费重试），代价是可用性：
// 一次 unknown 之后再也不能用同一 (request, call) 重试。必须写进接线前提。

const HEX32 = /^[0-9a-f]{32}$/;

export function createStoreBackedReplayGuard({ store, accountId } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('replay guard needs a store with read/update');
  }
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new TypeError('replay guard needs a positive accountId (botQq)');
  }

  // 键里必须带 account：同一台机器、同一个 store 目录，换账号后历史键不能
  // 让新账号的合法读取被判重放，也不能让旧账号的键被新账号「继承」成已读。
  function keyOf({ sessionId, requestId, callId }) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId required');
    if (typeof requestId !== 'string' || !requestId) throw new TypeError('requestId required');
    if (typeof callId !== 'string' || !callId) throw new TypeError('callId required');
    return `${accountId}\n${sessionId}\n${requestId}\n${callId}`;
  }

  // 一次性迁移：老状态没有 usedReadKeys。这里只做「补一个空容器」，
  // 绝不从 readAttempts 反推——readAttempts 的键是含 turn 的 digest，
  // 无法还原出 (requestId, callId)，硬猜会造出假键把合法读取永久拒掉。
  // 代价（必须写进接线说明）：迁移前已经发生过的那些读，重放一次仍能通过；
  // 迁移点之后的不行。这个窗口是一次性的、有上界的（= 迁移时刻之前的读取数）。
  function ensureShape(state) {
    if (state.usedReadKeys === undefined) return { ...state, usedReadKeys: {} };
    const buckets = state.usedReadKeys;
    if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) {
      throw new TypeError('corrupt usedReadKeys');
    }
    return state;
  }

  return Object.freeze({
    /** 只读探查：这个键是否已经被占用。不写任何东西。 */
    peek(identity) {
      const key = keyOf(identity);
      const state = ensureShape(store.read());
      return Object.hasOwn(state.usedReadKeys, key);
    },

    /**
     * 认领一次读取尝试。同步、单事务、先查后写都在同一个 store.update 里，
     * 因此不存在「查完到写入之间被别人插进来」的窗口。
     * 返回 { ok: true } 或 { ok: false, reason: 'replay', claimedAt }。
     */
    claim(identity, { now } = {}) {
      if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('claim needs a valid now');
      const key = keyOf(identity);
      let outcome = null;
      store.update((state) => {
        const shaped = ensureShape(state);
        if (Object.hasOwn(shaped.usedReadKeys, key)) {
          outcome = { ok: false, reason: 'replay', claimedAt: shaped.usedReadKeys[key].claimedAt };
          return state; // 原样返回：被拒的尝试不写任何状态
        }
        outcome = { ok: true };
        return {
          ...shaped,
          usedReadKeys: {
            ...shaped.usedReadKeys,
            [key]: {
              claimedAt: now,
              // 只存可审计的最小事实；不存内容、不存目标、不存结论。
              // generation 仅作诊断，不参与判定（代际不该影响「是否同一 call」）。
              generation: identity.generation ?? null,
            },
          },
        };
      });
      return outcome;
    },

    /** 诊断用：当前键数。原型不做任何裁剪，所以它只增不减。 */
    size() {
      return Object.keys(ensureShape(store.read()).usedReadKeys).length;
    },
  });
}

export { HEX32 as _HEX32 };
