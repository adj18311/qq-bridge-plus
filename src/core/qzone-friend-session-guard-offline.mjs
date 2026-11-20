const UNKNOWN = Object.freeze({ trustedStatus: 'unknown', friend: false });
const OPTION_KEYS = new Set(['botQq', 'friendSource', 'getBotIdentity', 'getConnectionEpoch']);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    ? { valid: true, value: descriptor.value }
    : { valid: false };
}

function validIdentity(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function trustedFriendResult(value) {
  try {
    if (!isPlainRecord(value) || Reflect.ownKeys(value).length !== 2) return null;
    const status = ownData(value, 'trustedStatus');
    const friend = ownData(value, 'friend');
    if (!status.valid || status.value !== 'trusted' || !friend.valid || typeof friend.value !== 'boolean') return null;
    return { trustedStatus: 'trusted', friend: friend.value };
  } catch {
    return null;
  }
}

/**
 * Offline guard around a trusted friend source. The application privately
 * supplies the identity and connection-epoch readers. Safety across reconnects
 * depends on that application monotonically changing the epoch on every
 * reconnect and identity switch; this module cannot verify that contract or
 * bind the source to a real SnowLuma connection.
 */
export function createQzoneFriendSessionGuardOffline(options) {
  try {
    if (!isPlainRecord(options) || Reflect.ownKeys(options).some((key) =>
      typeof key !== 'string' || !OPTION_KEYS.has(key))) throw new TypeError('invalid session guard configuration');
  } catch {
    throw new TypeError('invalid session guard configuration');
  }

  const botQqField = ownData(options, 'botQq');
  const sourceField = ownData(options, 'friendSource');
  const identityReaderField = ownData(options, 'getBotIdentity');
  const epochReaderField = ownData(options, 'getConnectionEpoch');
  const sourceMethod = sourceField.valid && isPlainRecord(sourceField.value)
    ? ownData(sourceField.value, 'isFriend') : { valid: false };
  if (!botQqField.valid || !validIdentity(botQqField.value) || !sourceMethod.valid ||
      typeof sourceMethod.value !== 'function' || !identityReaderField.valid ||
      typeof identityReaderField.value !== 'function' || !epochReaderField.valid ||
      typeof epochReaderField.value !== 'function') {
    throw new TypeError('invalid session guard configuration');
  }

  const botQq = botQqField.value;
  const isFriend = sourceMethod.value;
  const getBotIdentity = identityReaderField.value;
  const getConnectionEpoch = epochReaderField.value;
  let highestEpoch = -1;
  let epochRegressionObserved = false;
  const activeSourceEpochs = new Map();

  async function readSessionSnapshot() {
    if (epochRegressionObserved) return null;
    let epochBefore;
    try {
      epochBefore = await getConnectionEpoch();
    } catch {
      return null;
    }
    if (!validEpoch(epochBefore) || epochBefore < highestEpoch) return { epoch: epochBefore, identity: null };
    highestEpoch = Math.max(highestEpoch, epochBefore);

    let identity;
    try { identity = await getBotIdentity(); }
    catch { return { epoch: epochBefore, identity: null }; }

    let epochAfter;
    try {
      epochAfter = await getConnectionEpoch();
    } catch {
      return { epoch: epochBefore, identity: null };
    }
    if (validEpoch(epochAfter) && epochAfter < epochBefore) epochRegressionObserved = true;
    if (epochRegressionObserved) return { epoch: epochAfter, identity: null };
    if (!validEpoch(epochAfter) || epochAfter < highestEpoch) return { epoch: epochAfter, identity: null };
    highestEpoch = Math.max(highestEpoch, epochAfter);
    if (epochAfter !== epochBefore || !validIdentity(identity)) return { epoch: epochAfter, identity: null };
    return { epoch: epochAfter, identity };
  }

  return Object.freeze({
    async isFriend(targetQq) {
      if (!validIdentity(targetQq)) return { ...UNKNOWN };
      const before = await readSessionSnapshot();
      if (!before || before.epoch < highestEpoch || before.identity !== botQq) return { ...UNKNOWN };

      // A source call started in an older connection may still be holding a
      // cached snapshot. Do not let a new-epoch query overlap and bless it.
      if ([...activeSourceEpochs.keys()].some((epoch) => epoch !== before.epoch)) return { ...UNKNOWN };
      activeSourceEpochs.set(before.epoch, (activeSourceEpochs.get(before.epoch) ?? 0) + 1);

      let sourceResult;
      try { sourceResult = await isFriend(targetQq); }
      catch { return { ...UNKNOWN }; }
      finally {
        const activeCount = activeSourceEpochs.get(before.epoch);
        if (activeCount === 1) activeSourceEpochs.delete(before.epoch);
        else if (activeCount > 1) activeSourceEpochs.set(before.epoch, activeCount - 1);
      }

      const after = await readSessionSnapshot();
      if (!after || after.epoch < highestEpoch || after.identity !== botQq) return { ...UNKNOWN };
      if (after.epoch !== before.epoch || after.identity !== before.identity) return { ...UNKNOWN };

      const trusted = trustedFriendResult(sourceResult);
      return trusted ?? { ...UNKNOWN };
    }
  });
}
