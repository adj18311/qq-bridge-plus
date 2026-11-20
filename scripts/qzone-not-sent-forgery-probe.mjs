// Codex round-8 follow-up: "读请求 not-sent 标记的真实性，包括 Symbol.for 可被伪造
// 或跨组件异常传播".
//
// The first shipped version used `Symbol.for('qzone.read.not-sent')`, which reads the
// GLOBAL symbol registry: any module in the process that spelled the key got the
// identical symbol and could tag an arbitrary error. That matters because the marker
// unlocks a quota refund — a forged marker on an error raised AFTER the send would let
// a read happen without ever charging a slot.
//
// The shipped version is a module-private symbol plus a WeakSet of the exact error
// objects the transport created. This probe measures both directions: a forged error
// must be rejected, and a genuine refusal must still be recognised.
import { createQzoneBoundReadTransport, isQzoneReadNotSent } from '../src/core/qzone-bound-read-transport.mjs';

// Exactly what an unrelated same-process component can do without importing anything.
const forged = Object.assign(new Error('forged'), { [Symbol.for('qzone.read.not-sent')]: true });
const forgedWithStringKey = Object.assign(new Error('forged'), { 'qzone.read.not-sent': true });

// A genuine pre-dispatch refusal: the snapshot is missing a field, which fails the
// field-set check before anything is built or sent.
const transport = createQzoneBoundReadTransport({
  botQq: 123,
  getConnectionEpoch: () => 8,
  transport: { async get_qzone_msg_list() { throw new Error('must not be called'); } },
});

let genuine = null;
try {
  await transport(Object.freeze({ target_uin: 456, pos: 0, num: 20, botQq: 123, connectionEpoch: 8 }), () => true);
} catch (error) {
  genuine = error;
}

// Cross-component exception propagation: an error raised INSIDE the caller's own
// guards (not by this module) must never be mistaken for a refusal.
let foreign = null;
const throwingGuard = () => { throw Object.assign(new Error('guard blew up'), { [Symbol.for('qzone.read.not-sent')]: true }); };
try {
  await transport(Object.freeze({ target_uin: 456, pos: 0, num: 20, botQq: 123,
    connectionEpoch: 8, sourceProofId: 'sp-1' }), throwingGuard);
} catch (error) {
  foreign = error;
}

console.log(JSON.stringify({
  globalRegistryKeyRemoved: Symbol.keyFor(Symbol.for('qzone.read.not-sent')) === 'qzone.read.not-sent',
  forgedWithRegistryKeyRejected: isQzoneReadNotSent(forged) === false,
  forgedWithStringKeyRejected: isQzoneReadNotSent(forgedWithStringKey) === false,
  genuineRefusalRecognised: isQzoneReadNotSent(genuine) === true,
  foreignThrowNotCredited: isQzoneReadNotSent(foreign) === false,
  foreignStillReportsUnavailable: foreign?.message === 'qzone read unavailable',
}));
