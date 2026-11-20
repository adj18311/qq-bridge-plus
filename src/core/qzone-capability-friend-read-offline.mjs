import { simulateOfflineFriendRead } from './qzone-simulation-offline.mjs';
import { isQzoneFriendCapabilityIssuerOffline } from './qzone-friend-capability-offline.mjs';

const UNKNOWN = Object.freeze({ allowed: false, reason: 'friend_unverified' });
const INPUT_KEYS = new Set(['request', 'capability', 'page']);
const REQUEST_KEYS = new Set(['id', 'now', 'tool', 'source', 'target', 'activeTime', 'opportunity']);
const PAGE_ROW_KEYS = new Set(['author', 'id', 'time', 'content']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotRecord(value, allowedKeys) {
  if (!isPlainRecord(value)) return null;
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function canonicalQq(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && String(number) === value ? number : null;
}

function snapshotRequest(value) {
  const request = snapshotRecord(value, REQUEST_KEYS);
  if (!request || typeof request.id !== 'string' || !ID_PATTERN.test(request.id) || FORBIDDEN_IDS.has(request.id) ||
      !Number.isFinite(request.now) || !Number.isFinite(new Date(request.now).getTime()) ||
      request.tool !== 'read_posts' || !['requested', 'proactive'].includes(request.source) ||
      canonicalQq(request.target) === null || typeof request.activeTime !== 'boolean' ||
      (request.source === 'proactive' && (typeof request.opportunity !== 'string' ||
        !ID_PATTERN.test(request.opportunity) || FORBIDDEN_IDS.has(request.opportunity))) ||
      (request.opportunity !== undefined && (typeof request.opportunity !== 'string' ||
        !ID_PATTERN.test(request.opportunity) || FORBIDDEN_IDS.has(request.opportunity)))) return null;
  return { ...request };
}

function snapshotPage(value, target) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 100) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) return null;
  const page = [];
  for (let index = 0; index < value.length; index += 1) {
    const rowDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!rowDescriptor || !Object.hasOwn(rowDescriptor, 'value') || !isPlainRecord(rowDescriptor.value)) return null;
    const row = snapshotRecord(rowDescriptor.value, PAGE_ROW_KEYS);
    if (!row || typeof row.author !== 'string' || canonicalQq(row.author) === null ||
        typeof row.id !== 'string' || !ID_PATTERN.test(row.id) ||
        !Number.isSafeInteger(row.time) || !Number.isFinite(row.time) ||
        (row.content !== undefined && typeof row.content !== 'string')) return null;
    page.push({ author: row.author, id: row.id, time: row.time,
      ...(row.content === undefined ? {} : { content: row.content }) });
  }
  return page;
}

function validCapabilityApi(value) {
  try {
    if (!isQzoneFriendCapabilityIssuerOffline(value) || !isPlainRecord(value) || !Object.isFrozen(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('issue') || !keys.includes('consume')) return false;
    const issue = Object.getOwnPropertyDescriptor(value, 'issue');
    const consume = Object.getOwnPropertyDescriptor(value, 'consume');
    return !!issue && Object.hasOwn(issue, 'value') && typeof issue.value === 'function' &&
      !!consume && Object.hasOwn(consume, 'value') && typeof consume.value === 'function';
  } catch {
    return false;
  }
}

function trustedFriendResult(value) {
  try {
    const proof = snapshotRecord(value, new Set(['trustedStatus', 'friend']));
    return !!proof && Reflect.ownKeys(proof).length === 2 &&
      proof.trustedStatus === 'trusted' && proof.friend === true;
  } catch {
    return false;
  }
}

/**
 * Create an explicitly offline adapter around the private application's friend
 * capability issuer. It accepts preconstructed synthetic rows and has no
 * transport/fetch callback. `offlineTestFixture` prevents accidental wiring;
 * it is not an authentication or security boundary.
 */
export function createQzoneCapabilityFriendReadOffline({ store, capabilityApi, offlineTestFixture } = {}) {
  if (offlineTestFixture !== true) throw new TypeError('offline fixture marker required');
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' ||
      !validCapabilityApi(capabilityApi)) throw new TypeError('invalid offline friend read dependencies');

  return async function readQzoneFriendOffline(input) {
    // Also require the state fixture marker at use time. Both markers are only
    // accidental-use guards, not proof that an injected store is trustworthy.
    if (store.read().offlineTestFixture !== true) throw new TypeError('offline fixture state required');
    let snapshot;
    try { snapshot = snapshotRecord(input, INPUT_KEYS); } catch { snapshot = null; }
    if (!snapshot || Reflect.ownKeys(snapshot).length !== INPUT_KEYS.size ||
        !Object.hasOwn(snapshot, 'request') || !Object.hasOwn(snapshot, 'capability') || !Object.hasOwn(snapshot, 'page')) {
      throw new TypeError('invalid offline friend read input');
    }

    let request;
    let page;
    try {
      request = snapshotRequest(snapshot.request);
      page = request ? snapshotPage(snapshot.page, request.target) : null;
    } catch {
      request = null;
      page = null;
    }
    if (!request || !page) throw new TypeError('invalid synthetic friend page');

    let proof;
    try { proof = capabilityApi.consume(snapshot.capability, canonicalQq(request.target)); }
    catch { return { ...UNKNOWN }; }
    if (!trustedFriendResult(proof)) return { ...UNKNOWN };

    return simulateOfflineFriendRead(store, request,
      { friend: true, author: request.target }, async () => page);
  };
}
