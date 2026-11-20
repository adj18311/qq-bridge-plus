import { createQzoneFriendSource } from './qzone-friend-source.mjs';
import { createQzoneFriendSessionGuardOffline } from './qzone-friend-session-guard-offline.mjs';

// `call` must be bound by the application to its authenticated, current
// SnowLuma connection. This module alone does not establish that trust or
// protect against an ABA reconnect; a connection-epoch guard is still required.
export function createQzoneFriendSourceRuntime({ botQq, call } = {}) {
  if (!Number.isSafeInteger(botQq) || botQq <= 0 || typeof call !== 'function') {
    throw new TypeError('invalid friend source runtime');
  }
  return createQzoneFriendSource({
    botQq,
    async getLoginInfo() {
      const envelope = await call('get_login_info', {});
      if (!envelope || envelope.status !== 'ok' || envelope.retcode !== 0 ||
          !envelope.data || typeof envelope.data !== 'object') return null;
      return envelope.data;
    },
    async getFriendList() {
      return call('get_friend_list', {});
    }
  });
}

// Production wiring must supply a monotonically increasing generation from
// the actual authenticated OneBot connection; this factory cannot prove it.
export function createQzoneBoundFriendSource({ botQq, call, getConnectionEpoch } = {}) {
  if (typeof getConnectionEpoch !== 'function') throw new TypeError('connection epoch required');
  const friendSource = createQzoneFriendSourceRuntime({ botQq, call });
  return createQzoneFriendSessionGuardOffline({
    botQq,
    friendSource,
    getConnectionEpoch,
    async getBotIdentity() {
      const result = await call('get_login_info', {});
      return result?.status === 'ok' && result.retcode === 0 ? result.data?.user_id : null;
    }
  });
}
