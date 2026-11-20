const UNKNOWN = Object.freeze({ trustedStatus: 'unknown', friend: false });
const TRUSTED_READ_FIELDS = new Set(['trustedCurrentRead', 'targetQq', 'envelope']);

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { valid: false };
  return { valid: true, value: descriptor.value };
}

function readTrustedInput(input) {
  if (!plainRecord(input) || Reflect.ownKeys(input).some((key) =>
    typeof key !== 'string' || !TRUSTED_READ_FIELDS.has(key))) return null;

  const trustedCurrentRead = ownDataValue(input, 'trustedCurrentRead');
  const targetQq = ownDataValue(input, 'targetQq');
  const envelope = ownDataValue(input, 'envelope');
  if (!trustedCurrentRead.valid || trustedCurrentRead.value !== true ||
      !targetQq.valid || !Number.isSafeInteger(targetQq.value) || targetQq.value <= 0 ||
      !envelope.valid || !plainRecord(envelope.value)) return null;

  const status = ownDataValue(envelope.value, 'status');
  const retcode = ownDataValue(envelope.value, 'retcode');
  const data = ownDataValue(envelope.value, 'data');
  if (!status.valid || status.value !== 'ok' ||
      !retcode.valid || retcode.value !== 0 ||
      !data.valid || !Array.isArray(data.value)) return null;

  return { targetQq: targetQq.value, data: data.value };
}

function validatedFriendIds(data) {
  const ids = [];
  for (let index = 0; index < data.length; index++) {
    if (!Object.hasOwn(data, index)) return null;
    const item = Object.getOwnPropertyDescriptor(data, String(index));
    if (!item || !Object.hasOwn(item, 'value') || !plainRecord(item.value)) return null;
    const userId = ownDataValue(item.value, 'user_id');
    if (!userId.valid || !Number.isSafeInteger(userId.value) || userId.value <= 0) return null;
    ids.push(userId.value);
  }
  return ids;
}

/**
 * Offline projection only. The caller must independently authenticate the
 * OneBot source and identity, obtain this successful response during the
 * current read, and set trustedCurrentRead only for that verified response.
 * Never pass data supplied by a user or model as trusted evidence. This pure
 * function cannot establish provenance or authenticate the caller itself.
 */
export function verifyOfflineQzoneFriend(input) {
  try {
    const snapshot = readTrustedInput(input);
    if (!snapshot) return { ...UNKNOWN };

    const friendIds = validatedFriendIds(snapshot.data);
    if (!friendIds) return { ...UNKNOWN };

    return {
      trustedStatus: 'trusted',
      friend: friendIds.includes(snapshot.targetQq)
    };
  } catch {
    // Proxies, revoked proxies, and hostile descriptors are unverifiable.
    return { ...UNKNOWN };
  }
}
