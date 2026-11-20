// Offline identity guard. It does not call connect(), but the injected client's
// getLoginInfo() may itself connect; production use requires a transport that
// guarantees the check stays on the already-observed connection.
// The caller must supply the epoch getter for this exact client, and arrange
// for it to update before this guard observes each connection event.
export function createQzoneAccountIdentityGuard({ client, getEpoch, expectedUserId }) {
  const validId = (value) => Number.isSafeInteger(value) && value > 0;
  if (!client || typeof client.on !== 'function' || typeof client.getLoginInfo !== 'function' ||
      (typeof client.off !== 'function' && typeof client.removeListener !== 'function') ||
      typeof getEpoch !== 'function' || !validId(expectedUserId)) {
    throw new TypeError('invalid identity guard configuration');
  }

  let opened = false;
  let disposed = false;
  let conflict = false;
  let binding = null;
  let revision = 0;
  const epoch = () => {
    try {
      const value = getEpoch();
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch { return null; }
  };
  const invalidate = () => { binding = null; revision++; };
  const onOpen = () => { invalidate(); opened = true; conflict = false; };
  const onDisconnect = () => { invalidate(); opened = false; };

  // Treat malformed identity-bearing events as conflicts as well. bot_status
  // offline revokes the binding even when its identity is consistent.
  function observeEvent(event) {
    if (disposed || !opened || !event || typeof event !== 'object') return false;
    const hasSelf = Object.hasOwn(event, 'self_id');
    const isStatus = event.post_type === 'notice' && event.notice_type === 'bot_status';
    const badSelf = (event.post_type === 'message' && !hasSelf) ||
      (hasSelf && (!validId(event.self_id) || event.self_id !== expectedUserId));
    const badStatus = isStatus && (!hasSelf || !validId(event.user_id) ||
      event.user_id !== expectedUserId || event.user_id !== event.self_id ||
      !['online', 'offline'].includes(event.sub_type) || event.sub_type === 'offline');
    if (badSelf || badStatus) {
      conflict = true;
      invalidate();
      return false;
    }
    return isVerified();
  }
  function isVerified() {
    if (disposed || !opened || conflict || !binding) return false;
    if (epoch() !== binding.epoch) { invalidate(); return false; }
    return true;
  }
  async function verify() {
    if (disposed || !opened || conflict) return false;
    const startEpoch = epoch();
    // Starting a check revokes the old grant until it finishes successfully.
    invalidate();
    const ticket = revision;
    if (startEpoch === null) return false;
    try {
      const result = await client.getLoginInfo();
      if (disposed || !opened || conflict || ticket !== revision) return false;
      if (epoch() !== startEpoch || !validId(result?.user_id) || result.user_id !== expectedUserId) {
        invalidate();
        return false;
      }
      binding = { epoch: startEpoch, userId: result.user_id };
      return true;
    } catch {
      // An old request must not revoke a newer generation or newer request.
      if (ticket === revision) invalidate();
      return false;
    }
  }

  client.on('open', onOpen);
  client.on('close', onDisconnect);
  client.on('error', onDisconnect);
  client.on('event', observeEvent);
  const remove = typeof client.off === 'function' ? client.off.bind(client) : client.removeListener.bind(client);
  return Object.freeze({
    verify,
    isVerified,
    accountId: () => isVerified() ? binding.userId : null,
    observeEvent,
    close() {
      if (disposed) return;
      disposed = true; opened = false; invalidate();
      remove('open', onOpen);
      remove('close', onDisconnect);
      remove('error', onDisconnect);
      remove('event', observeEvent);
    },
  });
}
