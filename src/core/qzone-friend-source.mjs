const UNKNOWN = Object.freeze({ trustedStatus: 'unknown', friend: false });

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    ? { valid: true, value: descriptor.value }
    : { valid: false };
}

function validQq(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function friendIds(response) {
  if (!record(response)) return null;
  const status = dataValue(response, 'status');
  const retcode = dataValue(response, 'retcode');
  const data = dataValue(response, 'data');
  if (!status.valid || status.value !== 'ok' || !retcode.valid || retcode.value !== 0 ||
      !data.valid || !Array.isArray(data.value)) return null;

  const ids = [];
  for (let index = 0; index < data.value.length; index++) {
    if (!Object.hasOwn(data.value, index)) return null;
    const item = dataValue(data.value, String(index));
    if (!item.valid || !record(item.value)) return null;
    const userId = dataValue(item.value, 'user_id');
    if (!userId.valid || !validQq(userId.value)) return null;
    ids.push(userId.value);
  }
  return ids;
}

/**
 * Bind a narrow, trusted transport and login identity reader to one bot account.
 * Dependency injection supplies provenance only as an application boundary; it
 * does not authenticate the transport or its external network by itself.
 */
export function createQzoneFriendSource(options) {
  if (!record(options)) throw new TypeError('invalid friend source configuration');
  const botQqField = dataValue(options, 'botQq');
  const loginField = dataValue(options, 'getLoginInfo');
  const friendsField = dataValue(options, 'getFriendList');
  if (!botQqField.valid || !validQq(botQqField.value) || !loginField.valid ||
      typeof loginField.value !== 'function' || !friendsField.valid || typeof friendsField.value !== 'function' ||
      Reflect.ownKeys(options).some((key) => !['botQq', 'getLoginInfo', 'getFriendList'].includes(key))) {
    throw new TypeError('invalid friend source configuration');
  }
  const botQq = botQqField.value;
  const getLoginInfo = loginField.value;
  const getFriendList = friendsField.value;

  return Object.freeze({
    async isFriend(targetQq) {
      try {
        if (!validQq(targetQq)) return { ...UNKNOWN };
        const boundTargetQq = targetQq;
        const login = await getLoginInfo();
        if (!record(login)) return { ...UNKNOWN };
        const loginId = dataValue(login, 'user_id');
        if (!loginId.valid || loginId.value !== botQq) return { ...UNKNOWN };

        // The fixed transport takes no caller supplied target, identity, or response.
        const response = await getFriendList();
        const ids = friendIds(response);
        if (!ids) return { ...UNKNOWN };
        // This detects a changed account around the read; it cannot prove that
        // the transport was authenticated or prevent an ABA account switch.
        const loginAfter = await getLoginInfo();
        if (!record(loginAfter)) return { ...UNKNOWN };
        const loginIdAfter = dataValue(loginAfter, 'user_id');
        if (!loginIdAfter.valid || loginIdAfter.value !== botQq) return { ...UNKNOWN };
        return { trustedStatus: 'trusted', friend: ids.includes(boundTargetQq) };
      } catch {
        return { ...UNKNOWN };
      }
    }
  });
}
