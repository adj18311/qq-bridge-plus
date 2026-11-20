const UNKNOWN = Object.freeze({ trustedStatus: 'unknown', friend: false });
const TRUSTED = Object.freeze({ trustedStatus: 'trusted', friend: true });
const MAX_TTL_MS = 30_000;
const issuers = new WeakSet();

// Identifies only issuers created by this module; it does not authenticate the
// injected constructor or establish that a real QQ friend read occurred.
export function isQzoneFriendCapabilityIssuerOffline(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && issuers.has(value);
}

function isRecord(value) {
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

function validQq(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Build an offline, single-use friend capability issuer/consumer.
 * `trustedConstruct` is an application-private trust boundary: it must obtain
 * and authenticate current friend evidence before invoking the supplied mint.
 * This module itself does not authenticate OneBot, QQ, or the injected callback.
 */
export function createQzoneFriendCapabilityOffline(options) {
  if (!isRecord(options) || Reflect.ownKeys(options).some((key) =>
    typeof key !== 'string' || !['trustedConstruct', 'clock', 'ttlMs'].includes(key))) {
    throw new TypeError('invalid capability configuration');
  }
  const trustedConstructField = ownData(options, 'trustedConstruct');
  const clockField = ownData(options, 'clock');
  const ttlField = ownData(options, 'ttlMs');
  const trustedConstruct = trustedConstructField.value;
  const clock = clockField.value;
  const ttlMs = ttlField.value;
  if (!trustedConstructField.valid || typeof trustedConstruct !== 'function' ||
      !clockField.valid || typeof clock !== 'function' ||
      !ttlField.valid || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new TypeError('invalid capability configuration');
  }

  const issued = new WeakMap();
  let lastNow = -1;

  function readMonotonicNow() {
    let now;
    try {
      now = clock();
      if (!Number.isSafeInteger(now) || now < 0 || now > Date.now() || now < lastNow) return null;
      lastNow = now;
      return now;
    } catch {
      return null;
    }
  }

  async function issue(targetQq) {
    if (arguments.length !== 1 || !validQq(targetQq)) return null;
    let active = true;
    let minted = null;
    let mintedAt = null;
    const mint = (boundTargetQq) => {
      if (!active || minted !== null || boundTargetQq !== targetQq) return null;
      const issuedAt = readMonotonicNow();
      if (issuedAt === null) return null;
      const capability = Object.freeze(Object.create(null));
      minted = capability;
      mintedAt = issuedAt;
      return capability;
    };

    let result;
    try {
      result = await trustedConstruct(targetQq, mint);
    } catch {
      return null;
    } finally {
      active = false;
    }
    if (minted === null || result !== minted) return null;
    issued.set(minted, { targetQq, issuedAt: mintedAt, consumed: false });
    return minted;
  }

  function consume(capability, targetQq) {
    let state;
    try {
      if (capability === null || typeof capability !== 'object') return { ...UNKNOWN };
      state = issued.get(capability);
    } catch {
      return { ...UNKNOWN };
    }
    if (!state || state.consumed) return { ...UNKNOWN };

    // Burn before validating target/time so an attempted use cannot be retried.
    state.consumed = true;
    const now = readMonotonicNow();
    if (now === null || !validQq(targetQq) || targetQq !== state.targetQq ||
        now < state.issuedAt || now >= state.issuedAt + ttlMs) return { ...UNKNOWN };
    return { ...TRUSTED };
  }

  const issuer = Object.freeze({ issue, consume });
  issuers.add(issuer);
  return issuer;
}
