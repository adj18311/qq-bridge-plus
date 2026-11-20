import { createQzoneBoundFriendSource } from './qzone-friend-source-runtime.mjs';

const PROOF_KEYS = ['sourceProofId', 'targetQq', 'botQq', 'connectionEpoch'];
const UNKNOWN = null;

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownData(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function validQq(value) { return Number.isSafeInteger(value) && value > 0; }
function validEpoch(value) { return Number.isSafeInteger(value) && value >= 0; }
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value); }

/** Offline-testable binding boundary. The injected call must be an authenticated
 * OneBot transport and the epoch must change on every reconnect; only a
 * fake transport is suitable for offline use. This factory is not production-wired. */
export function createQzoneLiveFriendProof({ botQq, call, getConnectionEpoch } = {}) {
  if (!validQq(botQq) || typeof call !== 'function' || typeof getConnectionEpoch !== 'function') {
    throw new TypeError('invalid live friend proof dependencies');
  }
  const friendSource = createQzoneBoundFriendSource({ botQq, call, getConnectionEpoch });

  async function verify(proof) {
    try {
      if (!plainRecord(proof)) return UNKNOWN;
      const keys = Reflect.ownKeys(proof);
      if (keys.length !== PROOF_KEYS.length || keys.some((key) => !PROOF_KEYS.includes(key))) return UNKNOWN;
      const sourceProofId = ownData(proof, 'sourceProofId');
      const targetQq = ownData(proof, 'targetQq');
      const proofBotQq = ownData(proof, 'botQq');
      const connectionEpoch = ownData(proof, 'connectionEpoch');
      if (!validId(sourceProofId) || !validQq(targetQq) || proofBotQq !== botQq || !validEpoch(connectionEpoch)) return UNKNOWN;

      const before = await getConnectionEpoch();
      if (!validEpoch(before) || before !== connectionEpoch) return UNKNOWN;
      const result = await friendSource.isFriend(targetQq);
      const after = await getConnectionEpoch();
      if (!validEpoch(after) || after !== before || !plainRecord(result) ||
          Reflect.ownKeys(result).length !== 2 ||
          ownData(result, 'trustedStatus') !== 'trusted' || ownData(result, 'friend') !== true) return UNKNOWN;
      return Object.freeze({ status: 'friend', sourceProofId, botQq, targetQq, connectionEpoch });
    } catch {
      return UNKNOWN;
    }
  }
  return Object.freeze({ verify });
}
