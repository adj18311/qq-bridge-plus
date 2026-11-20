import { authorizeTool, filterOfflinePosts } from './qzone-policy-offline.mjs';
import { reserveAuditedOfflineRead } from './qzone-read-reservation-offline.mjs';
import { settleAuditedOfflineRead } from './qzone-settlement-offline.mjs';
import { projectQzoneOnebotMsgList } from './qzone-onebot-projection-offline.mjs';
import { isQzoneReadNotSent } from './qzone-bound-read-transport.mjs';
import { consumeStoredHistoryGrant } from './qzone-history-grant-offline.mjs';
import { projectQzoneOnebotMsgDetail } from './qzone-onebot-comment-projection-offline.mjs';
import { filterOfflineOwnNewComment } from './qzone-own-comment-offline.mjs';
import { filterOfflineCommentPage } from './qzone-comment-page-offline.mjs';
import { bindAuthorizedOwnNewQzoneComment } from './qzone-comment-binding-offline.mjs';
import { createQzoneReplyEvidenceStore } from './qzone-reply-evidence-store-offline.mjs';
import { closedOwnData, snapshotExceptionReads, snapshotReadScope, snapshotExactPost } from './qzone-read-scope-offline.mjs';

const UNKNOWN = Object.freeze({ allowed: true, outcome: 'unknown', posts: [] });
/**
 * G1/M2：网络不可用的读结果，与 `unknown` 分开。
 *
 * WHY IT IS A SEPARATE WORD AND NOT A NICER `unknown`: `network_unavailable` is in the policy's
 * IMMEDIATE_PAUSE set (`qzone-policy-offline.mjs:5`), so it pauses access on the FIRST occurrence
 * instead of after three. `unknown` deliberately does neither — it keeps the charge and counts
 * nothing. Folding a proven gateway outage into `unknown` therefore means the breaker never trips
 * on the one failure we can name with certainty, which is exactly the gap M2 closes.
 *
 * THE MARKER IS A CODE-LEVEL FACT, NOT AN INFERENCE: `qzone-onebot-read-transport.mjs:186`
 * returns `{status:'gateway_unavailable'}` only for ECONNREFUSED / ENETUNREACH / EHOSTUNREACH
 * raised while awaiting the response. Nothing here reads platform text or a retcode.
 */
const GATEWAY_UNAVAILABLE = 'gateway_unavailable';
/**
 * Did the transport answer with the gateway-unavailable marker?
 *
 * STRICT ON SHAPE on purpose: only an own `status` field reading exactly `gateway_unavailable`
 * counts. A platform envelope that merely MENTIONS the string somewhere must not be able to
 * pause access, so this never does a substring or `in` test.
 */
function isGatewayUnavailable(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'status');
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    && descriptor.value === GATEWAY_UNAVAILABLE;
}
const PROOF_KEYS = ['id', 'sourceProofId', 'source', 'targetQq', 'botQq', 'connectionEpoch', 'opportunity'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * How many rows to ask for. ONE constant on purpose: it is the `num` sent to the transport, and a
 * second literal elsewhere could drift from it.
 *
 * It is NOT reported back to the caller. Knowing how many rows we asked for would let a caller
 * compare it against `posts.length` and start reasoning about how much was left out — see the
 * "WHY NO COUNT IS RETURNED" header.
 *
 * PAGE WINDOW (t30): the caller may now ask for a specific `{pos, num}` page; the default is one
 * `pos:0` request of this size. Handing the window back is NOT permitted for the same counting
 * reason: a caller that learns `pos`/`num` from the answer could reconstruct how much it has not
 * seen. The window is an INPUT only.
 */
/** The default page window: exactly the request this module used to hard-code. */
const DEFAULT_PAGE_WINDOW = Object.freeze({ pos: 0, num: 20 });

function own(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function trustedProof(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !PROOF_KEYS.includes(key)) ||
      keys.length !== PROOF_KEYS.length - 1 && keys.length !== PROOF_KEYS.length) return null;
  const id = own(value, 'id');
  const sourceProofId = own(value, 'sourceProofId');
  const source = own(value, 'source');
  const targetQq = own(value, 'targetQq');
  const botQq = own(value, 'botQq');
  const connectionEpoch = own(value, 'connectionEpoch');
  const opportunity = own(value, 'opportunity');
  if (typeof id !== 'string' || !ID.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) ||
      typeof sourceProofId !== 'string' || !ID.test(sourceProofId) || ['__proto__', 'constructor', 'prototype'].includes(sourceProofId) ||
      !['requested', 'proactive'].includes(source) ||
      !Number.isSafeInteger(targetQq) || targetQq <= 0 ||
      !Number.isSafeInteger(botQq) || botQq <= 0 ||
      !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 0 ||
      (source === 'proactive' && (typeof opportunity !== 'string' || !ID.test(opportunity))) ||
      (source === 'requested' && opportunity !== undefined) ||
      !Number.isSafeInteger(now) || now < 0) return null;
  return Object.freeze({ id, sourceProofId, source, targetQq, botQq, connectionEpoch,
    ...(opportunity === undefined ? {} : { opportunity }), now });
}

function sameProof(left, right) {
  return left && right && PROOF_KEYS.every((key) => left[key] === right[key]);
}

function boundFriendReceipt(receipt, proof) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  const proto = Object.getPrototypeOf(receipt);
  const keys = Reflect.ownKeys(receipt);
  const expected = ['status', 'sourceProofId', 'botQq', 'targetQq', 'connectionEpoch'];
  return (proto === Object.prototype || proto === null) && keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key)) &&
    own(receipt, 'status') === 'friend' && own(receipt, 'sourceProofId') === proof.sourceProofId &&
    own(receipt, 'botQq') === proof.botQq && own(receipt, 'targetQq') === proof.targetQq &&
    own(receipt, 'connectionEpoch') === proof.connectionEpoch;
}

function friendBinding(proof) {
  return Object.freeze({ sourceProofId: proof.sourceProofId, targetQq: proof.targetQq,
    botQq: proof.botQq, connectionEpoch: proof.connectionEpoch });
}

function safeClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new TypeError('invalid clock');
  return value;
}

// Only the literal synchronous true admits a guard. Observe mistaken async
// returns so refusal cannot leave a rejected Promise unhandled in the host.
function observeAsync(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    try { Promise.resolve(value).catch(() => {}); } catch {}
  }
}

function strictCurrent(callback) {
  try {
    const verdict = callback();
    if (verdict === true) return true;
    observeAsync(verdict);
  } catch {}
  return false;
}

function value(record, key) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('invalid response');
  const proto = Object.getPrototypeOf(record);
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if ((proto !== Object.prototype && proto !== null) || !descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('invalid response');
  }
  return descriptor.value;
}

/**
 * Validate and narrow ONE page of the upstream list.
 *
 * Returns ONLY the envelope the projection needs. It deliberately does NOT hand back how many rows
 * the platform sent, or the upstream `total` — see the "WHY NO COUNT IS RETURNED" header for the
 * measured leak that made those fields unsafe to expose.
 *
 * `total` is still read here because `projectQzoneOnebotMsgList` range-checks it, and a malformed
 * `total` must fail the read closed. It is a validation gate, not an output.
 */
/**
 * Resolve an optional `{pos, num}` window into the transport request fields.
 *
 * Contracts, all closed:
 *   · omitted entirely ⇒ `{pos: 0, num: 20}` — the previous hard-coded request, byte for byte;
 *   · `pos` a non-negative safe integer, `num` an integer in 1..100 (the MCP contract's page caps,
 *     `qzone-mcp-contract.mjs:10`);
 *   · `undefined` fields mean "not supplied" and take the defaults, exactly as the rest of this
 *     repository treats an explicit `undefined`;
 *   · anything else THROWS `TypeError` — a malformed window is a caller bug and must not become a
 *     platform request with silently clamped numbers.
 *
 * WHY VALIDATE HERE AND NOT AT THE TRANSPORT: the read is audited and charged before the transport
 * runs, so a window rejected downstream would cost a real read unit. Refusing up front makes a bad
 * call free.
 *
 * @param {{pos?: number, num?: number}|undefined} paging
 * @returns {{pos: number, num: number}} frozen
 * @throws {TypeError} on a malformed window.
 */
function resolvePageWindow(paging) {
  if (paging === undefined) return DEFAULT_PAGE_WINDOW;
  if (paging === null || typeof paging !== 'object' || Array.isArray(paging)) {
    throw new TypeError('invalid page window');
  }
  const read = (key) => {
    const descriptor = Object.getOwnPropertyDescriptor(paging, key);
    if (descriptor === undefined) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid page window');
    return descriptor.value;
  };
  const pos = read('pos');
  const num = read('num');
  const resolvedPos = pos === undefined ? DEFAULT_PAGE_WINDOW.pos : pos;
  const resolvedNum = num === undefined ? DEFAULT_PAGE_WINDOW.num : num;
  if (!Number.isSafeInteger(resolvedPos) || resolvedPos < 0) throw new TypeError('invalid page window');
  if (!Number.isSafeInteger(resolvedNum) || resolvedNum < 1 || resolvedNum > 100) {
    throw new TypeError('invalid page window');
  }
  return Object.freeze({ pos: resolvedPos, num: resolvedNum });
}
function recentEnvelope(raw, now) {
  if (value(raw, 'status') !== 'ok' || value(raw, 'retcode') !== 0) throw new TypeError('invalid response');
  const data = value(raw, 'data');
  const total = value(data, 'total');
  const rows = value(data, 'msglist');
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(rows) || rows.length > 100) throw new TypeError('invalid response');
  const msglist = [];
  for (let i = 0; i < rows.length; i++) {
    if (!Object.hasOwn(rows, i)) throw new TypeError('invalid response');
    const row = Object.getOwnPropertyDescriptor(rows, String(i))?.value;
    const tid = value(row, 'tid');
    const content = value(row, 'content');
    const seconds = value(row, 'time');
    if (typeof tid !== 'string' || typeof content !== 'string' || !Number.isSafeInteger(seconds) || seconds < 0) {
      throw new TypeError('invalid response');
    }
    const time = seconds * 1000;
    if (!Number.isSafeInteger(time)) throw new TypeError('invalid response');
    // FUTURE-DATED ROWS ARE STILL REFUSED HERE. `time <= now` is a clock-sanity guard (a row the
    // platform dated in the future cannot be evidence about the present), not a recency policy —
    // so this function accepts old rows and lets them through to the projection.
    //
    // ⚠️ THAT DOES **NOT** MEAN OLD POSTS ARE VISIBLE. The recency decision lives in ONE place:
    // `canReadPost` in `qzone-policy-offline.mjs`, which applies a 7-day floor to friend scope.
    // The operator's ruling is that this is the intended behaviour for EVERY read, including the
    // administrator's own space (t37): a single 7-day window, uniformly applied.
    //
    // An earlier revision of this comment claimed the floor was "gone" and that a 306-post account
    // would now answer with everything. That was wrong: removing the copy here only stopped this
    // function from pre-filtering; the projection still applied the real floor, so the observable
    // behaviour never changed. Behaviour belongs to the policy module, and this comment described
    // a behaviour that never existed.
    if (time <= now) {
      // `images` is passed through VERBATIM when the row carries one. This function rebuilds the
      // row to validate it, and dropping unknown fields here silently emptied the attachment list
      // for every post that had pictures: the projection already reads `images`, but it cannot
      // read what this rebuild threw away. NO URL VALIDATION HAPPENS HERE — that is the
      // projection's job (it applies the http/https allowlist), and duplicating it would create a
      // second rule that can drift. The descriptor read keeps this safe against a hostile getter,
      // per this module's existing convention.
      const imagesDescriptor = Object.getOwnPropertyDescriptor(row, 'images');
      const images = imagesDescriptor && Object.hasOwn(imagesDescriptor, 'value')
        ? imagesDescriptor.value : undefined;
      msglist.push({
        tid, content, time: seconds,
        ...(images === undefined ? {} : { images }),
      });
    }
  }
  // `data.total` is passed through to the projection as the platform sent it (the projection only
  // range-checks it). It must NOT travel any further than that: see the header.
  return { status: 'ok', retcode: 0, data: { total, msglist } };
}

/**
 * Offline-testable orchestration boundary. Trust comes from the application
 * injected verifiers and optional per-call host exception scope configuration;
 * model request fields never supply identity, time, friendship, epoch or scope.
 * Host configuration alone does not establish provenance/system isolation.
 * The injected transport must be a fake in offline use. This module is not
 * registered or wired to a live QQ connection.
 *
 * WHY NO COUNT IS RETURNED
 * -----------------------
 * An earlier version reported `page: { requested, received, upstreamTotal }`. `received` was the
 * count BEFORE filtering, so a caller could compute `received - posts.length` and learn exactly how
 * many rows the platform returned that this reader refused to show them. Measured: with the same
 * three visible posts, hidden rows 0/1/5/17 produced the SAME posts but DIFFERENT counts — a
 * counting side channel. Refusing to NAME it `truncated` did not help: the two inputs were handed
 * over, so the caller could construct the very judgement the module declined to make.
 *
 * The upstream `total` had unverified semantics on top of that, so it was not safe either.
 *
 * Therefore this module now returns NO count of what the platform sent. The caller cannot tell
 * whether the 7-day window was fully covered, and that is the honest state: this read covers at
 * most ONE page and paging is deliberately not implemented.
 *
 * REPLY EVIDENCE — WHAT THIS MODULE PRODUCES, AND ONLY FOR ONE SCOPE
 * -----------------------------------------------------------------
 * On a SUCCESSFUL `read_comments` read this module also writes ONE row to `state.commentEvidence`
 * (the collection `reserveAuditedOfflineInteraction` consumes for replies), through
 * `qzone-reply-evidence-store-offline.mjs` over the SAME store handle. The row is derived by the
 * EXISTING trusted binding `bindAuthorizedOwnNewQzoneComment`, fed with the raw detail response,
 * the snapshotted `scope.event` and `scope.commentId` — this module never digs identity fields out
 * of the projected page, and no model-supplied field can reach the write.
 *
 * ⚠️ THE BINDING RUNS AT THE MOMENT OF READING, NOT AT THE MOMENT OF WRITING (t52/Codex). Its frozen
 * result is what the write later records; the platform payload is never touched again after the read.
 * That distinction is the whole point: `finishScope` and the post-lease policy recheck are HOST
 * callbacks that run between the two, and a host callback can synchronously mutate the object it was
 * handed — no `await` is required for that. Binding early makes the row describe the bytes that were
 * actually read. `LFR-EV-12` mutates the payload inside `finishScope` and asserts the stored
 * `commentUin` is still the original one.
 *
 * SCOPE OF SUPPORT: **only `scope.kind === 'own-new-comment'`.** That is the ONLY branch with a
 * root sufficient to justify evidence at all, because it is the only one that carries a trusted
 * `event` (independently verified by the host: `snapshotReadScope` requires `isNew === true`,
 * `selfId === botQq`, `author === scope.author`, and postId/commentId agreement) plus an
 * authorization that names exactly ONE comment. Other reads do NOT produce evidence:
 *   · `read_posts` (ordinary friend / admin / shared / own-history) reads POSTS, not comments:
 *     there is no comment id, no parent author, no reply recipient. Writing anything would be
 *     inventing an identity.
 *   · `read_comments` with any other scope kind is refused at `:234-236` (`tool-not-wired`) before
 *     dispatch, so it never reaches the write at all. A "plain comment page" read does not exist in
 *     this module, and if one is added later it must NOT be allowed to reach `record()`: without a
 *     trustworthy event AND a single named comment there is no honest projection to write.
 *
 * The evidence write happens AFTER every gate (read, post-I/O proof, `current()`, projection,
 * `finishScope`, post-lease policy recheck) — see the block at the bottom of `read()`. A failure at
 * any of them writes nothing. Conversely, evidence CANNOT authorise anything by itself: the reply
 * gate re-checks the row, and a missing row only ever refuses a reply.
 */
export function createQzoneLiveFriendRead(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('invalid reader configuration');
  // Two mutually exclusive admission paths. Neither is an authentication
  // boundary by itself: the offline fixture flag only prevents accidental
  // wiring, and authorizeBinding is trusted only because the caller supplies a
  // gate that accepts minted trusted bindings (see qzone-trusted-binding.mjs).
  // Removing the fixture flag alone does NOT admit the reader: without a
  // production authorizeBinding callback, construction still throws.
  const offlineFixture = options.offlineTestFixture === true;
  const productionAuthorizer = typeof options.authorizeBinding === 'function';
  if (!offlineFixture && !productionAuthorizer) throw new TypeError('offline fixture or production authorizeBinding required');
  if (productionAuthorizer && typeof options.isStillAuthorized !== 'function') throw new TypeError('production isStillAuthorized required');
  const { store, clock, verifyFriendship, transport, isStillAuthorized } = options;
  const scopeDescriptor = Object.getOwnPropertyDescriptor(options, 'exceptionReads');
  if ((scopeDescriptor && !Object.hasOwn(scopeDescriptor, 'value')) ||
      (!scopeDescriptor && 'exceptionReads' in options)) throw new TypeError('invalid exception read dependencies');
  let exceptionReads;
  if (scopeDescriptor?.value !== undefined) {
    const { contextFor, ...host } = closedOwnData(scopeDescriptor.value,
      ['adminQq', 'resolveScope', 'isScopeCurrent', 'finishScope', 'contextFor'], ['fetchPost', 'fetchCommentPage']);
    if (typeof contextFor !== 'function') throw new TypeError('invalid exception read dependencies');
    exceptionReads = Object.freeze({ ...snapshotExceptionReads(host), contextFor });
  }
  const verifyRequestProof = productionAuthorizer ? options.authorizeBinding : options.verifyRequestProof;
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' ||
      typeof clock !== 'function' || typeof verifyRequestProof !== 'function' ||
      typeof verifyFriendship !== 'function' || typeof transport !== 'function') throw new TypeError('invalid reader dependencies');
  // THE EVIDENCE PRODUCER — built over the SAME store handle this reader reads/writes, on purpose.
  // A producer over a different handle would write rows the reply gate (`reserveAuditedOfflineInteraction`
  // -> `matchesReplyEvidence`) never reads, i.e. evidence that looks corroborating and is not. No new
  // constructor parameter is needed: `options.store` already IS "the real store" for this module.
  const replyEvidence = createQzoneReplyEvidenceStore({ store });

  /**
   * One audited read.
   *
   * @param modelRequest  the caller's request (identity never comes from here).
   * @param action        'read_posts' | 'read_comments'.
   * @param postId        the post an exception scope names, if any.
   * @param {{pos?: number, num?: number}} [paging]  OPTIONAL page window (t30).
   *
   * WHY PAGING IS NOW A PARAMETER: the reader used to send a hard-coded `pos: 0, num: 20`, so a
   * caller could never reach past the first page. The contract already carries `pos`/`num`
   * (`qzone-mcp-contract.mjs` page fields), so the reader forwards them.
   *
   * NOTE it does NOT buy "read everything": the visible window is still the 7 days `canReadPost`
   * allows (t37). Paging reaches further BACK in the platform's list, and rows outside the window
   * are filtered out on their own merits — so on a long-dormant account, paging forward can return
   * nothing at all. That is the agreed behaviour, not a defect.
   *
   * BACKWARD COMPATIBLE BY CONSTRUCTION: omitting the argument reproduces the previous request
   * byte for byte (`pos: 0, num: 20`), which `test-qzone-live-friend-read.mjs` pins.
   */
  async function read(modelRequest, action = 'read_posts', postId = null, paging = undefined) {
    let proof;
    let dispatched = false;
    let reserved = false;
    let audit;
    let context = null;
    let scope = null;
    let open = true;
    /**
     * The FROZEN evidence projection, built at the moment of reading (see the bind site inside
     * `read_comments`). It is a derived VALUE, not a reference to the platform's `raw` payload, so the
     * host callbacks that run between the read and the write (`finishScope`, the post-lease policy
     * recheck) cannot change what the row will say. Stays `null` unless the read reached the
     * own-new-comment success path AND the trusted binding accepted the bytes — and `null` means the
     * write below is skipped entirely.
     */
    let evidenceProjection = null;
    /**
     * G1/M2: did the transport answer with the `gateway_unavailable` marker?
     *
     * Set at the ONE place the platform answer arrives (`raw = await transport(...)`), read at the
     * ONE place an `unknown` is settled. Kept as a flag rather than threaded through every return
     * because there are three `settle('unknown')` sites and only the transport knows the fact.
     * It is never set from a throw, a message, or a retcode — only from our own transport's
     * explicit `{status:'gateway_unavailable'}`.
     */
    let gatewayUnavailable = false;
    // The page window, resolved ONCE and frozen. Validated here rather than at the transport so a
    // malformed window fails BEFORE the read is reserved (a bad `pos` must not cost a read unit).
    const pageWindow = resolvePageWindow(paging);
    const unknown = () => action === 'read_comments'
      ? { allowed: true, outcome: 'unknown', comments: [] } : { ...UNKNOWN };
    // ⚠️ `exceptionReads.isScopeCurrent` IS consulted once a scope exists — including a DERIVED
    // `plain-comments` one (t42), because by the time `current()` runs the derivation has already
    // assigned `scope`. Measured, so this comment states it plainly instead of claiming otherwise:
    // a `read_comments` that derives its scope calls the host lease checkpoint twice.
    //
    // NOT CHANGED HERE (t50): the friend checks below are the defect this task fixes. Whether a
    // host-issued lease should veto a scope the host never issued is a different question — a
    // host that implements `isScopeCurrent` as "is this one of mine?" will refuse every derived
    // read, which is a policy decision, not a bug in the friend gate. Reported, not altered.
    const current = () => open && strictCurrent(() =>
      (!isStillAuthorized || strictCurrent(() => isStillAuthorized(modelRequest))) &&
      (!scope || !exceptionReads || strictCurrent(() => exceptionReads.isScopeCurrent(context, scope))) &&
      (!exceptionReads || authorizeTool(store.read(), action).allowed === true));
    // Configured reads settle only after finishScope has closed the host lease.
    // A failed close must never leave a success outcome or release fetched data.
    //
    // G1/M2 — ONE PLACE WHERE `unknown` CAN BE UPGRADED, AND ONLY ONE: a transport answer our own
    // code named `gateway_unavailable` (ECONNREFUSED / ENETUNREACH / EHOSTUNREACH while awaiting the
    // response) settles as `network_unavailable` instead of `unknown`. Everything else that is not
    // `success` stays `unknown` — deliberately not widened, because the difference MATTERS:
    // `network_unavailable` pauses on the first occurrence, `unknown` counts nothing.
    //
    // The audit input has to describe the SETTLED outcome, not the intent
    // (`qzone-settlement-offline.mjs:15-21`: network_unavailable ⇒ result 'failure', reason
    // 'network'). Passing the untouched `audit` there would throw 'audit outcome, time or reason
    // mismatch' and lose the settlement entirely.
    const settle = (outcome, input = audit) => {
      if (exceptionReads) return;
      if (outcome === 'unknown' && gatewayUnavailable) {
        settleAuditedOfflineRead(store, proof.id, 'network_unavailable',
          { ...(input ?? audit), result: 'failure', reason: 'network' }, proof.now);
        return;
      }
      settleAuditedOfflineRead(store, proof.id, outcome, input, proof.now);
    };
    const settleUnknownBestEffort = () => {
      try {
        if (proof && audit) settle('unknown');
      } catch { /* The committed intent remains the only reliable evidence. */ }
    };
    async function perform() {
      try {
        if (exceptionReads) context = exceptionReads.contextFor(modelRequest, action);
        const now = safeClock(clock);
        proof = trustedProof(await verifyRequestProof(modelRequest), now);
        if (!proof) return { allowed: false, reason: 'unverified' };
        if (exceptionReads) {
          const resolved = await exceptionReads.resolveScope(context);
          // null is an intentional ordinary-friend lookup. Every other invalid
          // value (including undefined) is a denial, never a privilege downgrade.
          scope = resolved === null ? null : snapshotReadScope(resolved, proof, exceptionReads.adminQq, action, postId);
          if (!current()) return { allowed: false, reason: 'unverified' };
        }
        // TWO WAYS TO READ COMMENTS, and they are gated differently on purpose.
        //   · `own-new-comment` — the REPLY-EVIDENCE path. It needs the host's dedicated
        //     `fetchCommentPage` adapter because it also produces a durable evidence row that a
        //     later reply consumes; without the adapter there is nothing to read through.
        //   · `plain-comments` — reading what people said under a post. It goes through the
        //     ORDINARY bound transport like any other read, because it produces no evidence and
        //     therefore needs no special adapter. Demanding `fetchCommentPage` for it would make
        //     the feature impossible to wire for a host that has no reply flow at all.
        if (action === 'read_comments' && scope !== null
            && scope.kind !== 'own-new-comment' && scope.kind !== 'plain-comments') {
          return { allowed: false, reason: 'tool-not-wired' };
        }
        if (action === 'read_comments' && scope?.kind === 'own-new-comment' && !exceptionReads?.fetchCommentPage) {
          return { allowed: false, reason: 'unsupported' };
        }
        // ── WHICH READS DEPEND ON FRIENDSHIP (t50) ────────────────────────────────────────────
        //
        // This used to be spelled `!scope` at both friend checks, which quietly made the two
        // checks disagree: the plain-comments scope is DERIVED below (line ~423), so before the
        // I/O the read looked unscoped (check runs) and after it the scope exists (check skipped).
        // A friendship revoked during the platform call therefore went unnoticed on exactly one
        // path, while an ordinary `read_posts` — whose scope stays null — was re-checked. Same
        // read, two different answers to "is the friend still a friend".
        //
        // The question the checks are really asking is not "is there a scope" but "does this read
        // derive its authority from the friend relationship":
        //   · no scope yet  ⇒ ordinary friend read of the target's wall          ⇒ YES
        //   · plain-comments ⇒ a page read gated on that same friendship          ⇒ YES
        //   · shared / own-history / own-new-comment ⇒ their own authorization   ⇒ NO
        //     (a shared post is authorized by the share, a grant by the grant, a new-comment event
        //      by the host-attested event; demanding friendship would refuse reads the operator
        //      explicitly allowed).
        //
        // Captured ONCE, BEFORE the derivation, on purpose: deriving sets `scope`, and a value
        // re-derived at each use would answer differently at the two sites — which is the defect.
        const friendGated = scope === null || scope.kind === 'plain-comments';
        if (friendGated && !boundFriendReceipt(await verifyFriendship(friendBinding(proof)), proof)) return { allowed: false, reason: 'unverified' };
        // ── t42: DERIVE the plain-comments scope. ─────────────────────────────────────────────
        //
        // ⚠️ WITHOUT THIS BLOCK THE FEATURE IS UNREACHABLE IN PRODUCTION. `scope` is only ever
        // assigned from `exceptionReads.resolveScope`, and NO host injects `exceptionReads`
        // (`plugins/qzone-safe` has zero references; `createQzonePluginHostRuntime`'s closed option
        // set has no such key). So every real `read_comments` arrived here with `scope === null`
        // and was refused as `tool-not-wired` — exactly the defect this read was meant to fix.
        //
        // WHY DERIVING IS NOT A PRIVILEGE ESCALATION. Every fact this scope names was ALREADY
        // authenticated before this line:
        //   · `proof.targetQq` is the account the trusted binding authorises (origin ledger ->
        //     binding -> `authorizeBinding`); a model cannot choose it;
        //   · `postId` is the tool's own `tid` argument, shape-checked (safeId) by the caller;
        //   · FRIENDSHIP was just proven for exactly this target by the line ABOVE, because
        //     `scope` was still null when it ran. That ordering is load-bearing: deriving BEFORE
        //     the friend check would skip it.
        // What it does NOT grant: it is deliberately not an `admin`/exception scope, the 7-day
        // window still applies, and NO evidence row may be written from it (see the
        // plain-comments projection branch, where `evidenceProjection` stays null).
        if (action === 'read_comments' && scope === null) {
          if (typeof postId !== 'string' || !ID.test(postId)) return { allowed: false, reason: 'invalid-input' };
          scope = Object.freeze({
            kind: 'plain-comments',
            author: String(proof.targetQq),
            postId,
            commentId: null,
          });
        }

        const reservationRequest = { id: proof.id, tool: action, source: proof.source,
          ...(proof.source === 'proactive' ? { opportunity: proof.opportunity } : {}),
          ...(scope ? { postId: scope.postId, commentId: scope.commentId } : {}),
          target: String(proof.targetQq), now: proof.now, activeTime: false };
        audit = { time: proof.now, source: proof.source === 'proactive' ? 'patrol' : 'qq',
          action, target: String(proof.targetQq), content: '', result: 'unknown', reason: '',
          ...(scope ? { postId: scope.postId, commentId: scope.commentId } : {}) };
        let reservation;
        if (scope?.kind === 'own-history') {
          // ONE real update/SQLite transaction. Both existing helpers update only
          // local next-state through this private synchronous adapter, never BEGIN.
          store.update(state => {
            let next = state;
            const transaction = { update(fn) { next = fn(next); } };
            if (!current()) { reservation = { allowed: false, reason: 'unverified' }; return state; }
            reservation = reserveAuditedOfflineRead(transaction, reservationRequest, audit);
            if (!reservation.allowed) return state;
            const consumed = consumeStoredHistoryGrant(transaction, scope.grantId, {
              requester: scope.requester, author: scope.author, question: scope.question, postId: scope.postId,
            }, { time: proof.now, source: 'qq', action: 'read_posts', target: scope.requester,
              postId: scope.postId, content: '', result: 'unknown', reason: '' });
            if (!consumed.allowed) { reservation = { allowed: false, reason: 'grant' }; return state; }
            return next;
          });
        } else {
          reservation = reserveAuditedOfflineRead(store, reservationRequest, audit);
        }
        if (!reservation.allowed) return { allowed: false, reason: reservation.reason };
        // `reserved` means exactly one thing: a one-shot audited read intent is now
        // committed in the store. It is NOT evidence that a platform request was
        // issued — that only becomes true at `dispatched` below. Callers that bill or
        // report on platform cost must look at `dispatched`, not at `reserved`.
        reserved = true;

        // Reservation can await no external work, but the preceding verifier may
        // have become stale before it committed. Recheck the same source binding
        // immediately before the last state gate; the live dispatcher still needs
        // an atomic handoff to close the remaining cross-process race.
        const beforeDispatchNow = safeClock(clock);
        const beforeDispatch = trustedProof(await verifyRequestProof(modelRequest), beforeDispatchNow);
        if (beforeDispatchNow < proof.now || !sameProof(proof, beforeDispatch) || (exceptionReads && !current())) {
          return { allowed: false, reason: 'unverified', reserved: true, dispatched: false };
        }
        const gate = authorizeTool(store.read(), action);
        if (!gate.allowed) return { allowed: false, reason: gate.reason, reserved: true, dispatched: false };

        // Once a callback is invoked, failures are potentially post-dispatch.
        // Only the bound list transport may report a pre-dispatch refusal. Its marker
        // is raised exclusively while `sent === false` inside the transport, so a marked
        // error arriving here means zero `get_qzone_msg_list` calls. Every throw from the
        // revalidation steps BELOW happens after the platform call and must stay
        // indistinguishable from a lost response — checked in this narrow scope instead of
        // in the outer catch, which cannot tell the two apart (a post-send revalidation
        // that happens to throw a marker-shaped object used to flip a real read into
        // "nothing was sent" and refund the tracking charge).
        let raw;
        // WHICH ADAPTER, IF ANY. `plain-comments` is EXCLUDED on purpose: it is an ordinary read
        // of a platform page and must go through the bound transport like any other, so that its
        // request keeps the shared shape (action/tid/pos/num/binding) instead of being funnelled
        // through the exact-post adapter, which answers a different question.
        const semanticFetch = scope?.kind === 'own-new-comment' ? exceptionReads.fetchCommentPage
          : scope && scope.kind !== 'plain-comments' && scope.postId !== null ? exceptionReads.fetchPost
            : undefined;
        if (semanticFetch) {
          const operation = Object.freeze({ author: scope.author, postId: scope.postId,
            ...(action === 'read_comments' ? { commentId: scope.commentId } : {}),
            botQq: proof.botQq, connectionEpoch: proof.connectionEpoch,
            sourceProofId: proof.sourceProofId, readId: proof.id });
          // No await between the mandatory current guard and adapter invocation.
          if (!current()) return { allowed: false, reason: 'unverified', reserved: true, dispatched: false };
          dispatched = true;
          raw = await semanticFetch(operation, current);
          if (!current()) return unknown();
        } else {
          dispatched = true;
          try {
            // A `plain-comments` read asks for a POST'S COMMENTS, not a list of posts, so the
            // request carries `action` + `tid` in addition to the usual binding. This is the exact
            // shape agreed with the bound-transport work (t41):
            //   {action:'get_qzone_msg_detail', tid, target_uin, pos, num, botQq, connectionEpoch, sourceProofId}
            // The post-list path keeps its previous shape byte for byte.
            const isDetailRead = scope?.kind === 'plain-comments';
            raw = await transport(Object.freeze(isDetailRead ? {
              action: 'get_qzone_msg_detail', tid: scope.postId,
              target_uin: proof.targetQq, pos: pageWindow.pos, num: pageWindow.num,
              botQq: proof.botQq, connectionEpoch: proof.connectionEpoch, sourceProofId: proof.sourceProofId,
            } : {
              target_uin: proof.targetQq, pos: pageWindow.pos, num: pageWindow.num,
              botQq: proof.botQq, connectionEpoch: proof.connectionEpoch, sourceProofId: proof.sourceProofId,
            }),
            exceptionReads || typeof isStillAuthorized === 'function' ? current : undefined);
            // G1/M2: the ONE code-level fact this task maps. `raw` is not a platform page here —
            // it is our own transport's marker object — so it must not reach the projection as if
            // it were data; recording the fact and letting the existing failure path run (the
            // projection rejects it) keeps a single outcome decision in one place.
            if (isGatewayUnavailable(raw)) gatewayUnavailable = true;
          } catch (transportError) {
            if (isQzoneReadNotSent(transportError)) {
              dispatched = false;
              return { allowed: false, reason: 'unverified', reserved: true, dispatched: false };
            }
            throw transportError;
          }
        }

        // Revalidate source, account, friend relationship, and epoch after I/O.
        const afterNow = safeClock(clock);
        const after = trustedProof(await verifyRequestProof(modelRequest), afterNow);
        // The SAME `friendGated` captured before the derivation — see the note at its definition.
        // `!scope` here would skip this re-check for `plain-comments`, because deriving ASSIGNED a
        // scope: the read would then keep its pre-I/O friendship verdict no matter what changed
        // during the call.
        if (afterNow < proof.now || !sameProof(proof, after) ||
            (friendGated && !boundFriendReceipt(await verifyFriendship(friendBinding(after)), after))) {
          settle('unknown');
          return unknown();
        }
        // Recheck synchronously after the final asynchronous friendship lookup;
        // a source revoked during that lookup must not release fetched posts.
        if (!current()) {
          settle('unknown');
          return unknown();
        }

        let posts;
        try {
          if (action === 'read_comments' && scope.kind === 'plain-comments') {
            // READING A PAGE OF COMMENTS — and NOTHING ELSE.
            //
            // ⚠️ NO EVIDENCE IS WRITTEN HERE, DELIBERATELY. `evidenceProjection` stays null and
            // `bindAuthorizedOwnNewQzoneComment` is never called, so `state.commentEvidence` gains
            // no row. That is not an omission to be fixed later: the evidence row exists to let a
            // LATER REPLY cite a comment the operator genuinely just received, and its whole
            // trustworthiness rests on `scope.event` — a host-attested "this comment is new, for
            // this account, on this post" fact. A page read has no such event, so any row minted
            // here would be an UNATTESTED comment identity dressed as an attested one. Reusing the
            // reply path's binding without its event is precisely the kind of quiet widening this
            // module refuses everywhere else.
            const page = projectQzoneOnebotMsgDetail(String(proof.targetQq), scope.postId, raw, proof.now);
            const filtered = filterOfflineCommentPage(page,
              Object.freeze({ author: scope.author, postId: scope.postId }), proof.now);
            // `null` means the page is about some OTHER post/author: a refusal, not an empty page.
            if (filtered === null) throw new TypeError('invalid comment page');
            return { allowed: true, outcome: 'success', parent: filtered.parent, comments: filtered.comments };
          }
          if (action === 'read_comments') {
            const page = projectQzoneOnebotMsgDetail(scope.author, scope.postId, raw, proof.now);
            const comment = filterOfflineOwnNewComment(scope.event, scope, page);
            if (!comment) throw new TypeError('invalid comment');
            // BIND ONCE, HERE — from the raw bytes as they came back from the platform.
            //
            // ⚠️ WHY THE PROJECTION IS BUILT NOW AND NOT AT THE WRITE (measured defect, t52/Codex).
            // An earlier revision captured `detail: raw` — a REFERENCE — and only projected it at the
            // bottom of `read()`, after `finishScope` and the post-lease policy recheck. Both of those
            // are HOST callbacks, and a host callback can synchronously mutate the very object it was
            // handed. "There is no `await` between the capture and the write" does NOT mean "the object
            // cannot change": no suspension point is needed for a synchronous mutation to land. A host
            // that flipped `c[0].uin` between the capture and the write would have produced a row
            // describing bytes that were never read, while looking exactly like a faithful one.
            //
            // So the DERIVED identity is frozen here, at the moment of reading, and the write below
            // records THAT value without touching `raw` again. `bindAuthorizedOwnNewQzoneComment` is
            // the existing trusted binding: it re-derives the comment identity from the raw detail AND
            // the snapshotted `scope.event` and refuses unless the two agree, and its return value is
            // already `Object.freeze`d — the row cannot be re-pointed after this line.
            //
            // `target` is built from the SNAPSHOTTED scope (author/postId), never from `page`: the page
            // is upstream content, and letting it name the post owner is exactly the field digging this
            // change refuses to do.
            //
            // FAIL CLOSED, AND ONLY FOR THE EVIDENCE: if the binding throws, no row is written — but the
            // read itself is NOT downgraded, because a missing row can only ever REFUSE a later reply.
            try {
              evidenceProjection = bindAuthorizedOwnNewQzoneComment(
                Object.freeze({ author: scope.author, id: scope.postId }),
                scope.event, raw, scope.commentId,
              );
            } catch { /* projection failed ⇒ write no evidence (fail closed); the read still succeeds */ }
            return { allowed: true, outcome: 'success', parent: { author: scope.author, postId: scope.postId }, comments: [comment] };
          }
          const projected = semanticFetch ? [snapshotExactPost(raw, scope, proof.now)]
            : projectQzoneOnebotMsgList(String(proof.targetQq), scope ? raw : recentEnvelope(raw, proof.now), proof.now);
          if (scope?.kind === 'own-history') {
            // Grant consumption admits exactly this explicit set; it is not an
            // admin policy bypass and does not authorize other posts by the author.
            const ids = scope.postId === null ? scope.postIds : [scope.postId];
            posts = projected.filter(p => p.author === scope.author && ids.includes(p.id));
            if (ids.some(id => posts.filter(p => p.id === id).length !== 1)) {
              return { allowed: false, reason: 'unsupported', reserved: true, dispatched: true };
            }
          } else {
            // ⚠️ WHY `images` IS RE-ATTACHED AFTER THE FILTER (t30). `filterOfflinePosts` decides
            // WHICH posts may be shown, and it rebuilds every survivor into a fixed
            // `{author, id, time, content}` view — a projection that predates media and therefore
            // drops `images` on the floor. That is why carrying the field through `recentEnvelope`
            // alone did not make pictures reach the caller: the last step in this module threw them
            // away. Re-attaching from `projected` (never from `raw`) keeps the trust chain intact:
            // the URLs have already been through the projection's http/https allowlist, and the
            // post they belong to was already selected by the policy filter above.
            const visible = filterOfflinePosts(projected, scope
              // `shared` is the ONLY exception scope that reaches this line: it names exactly one
              // post, and `filterOfflinePosts` lets precisely that one through. (The old `admin`
              // branch — "this scope may read anything" — was removed with the privilege itself, t47.)
              ? { author: scope.author, now: proof.now, sharedPostId: scope.postId }
              : { author: String(proof.targetQq), friend: true, now: proof.now });
            // t35: only ids that are UNIQUE in `projected` may carry pictures forward. With a
            // Map built straight from the array, a duplicated `tid` silently kept the LAST row's
            // images while `filterOfflinePosts` may have selected the FIRST — re-attaching one
            // post's media to another post's text. A duplicate id is malformed upstream data, so
            // the honest response is "no pictures for that id" rather than "whichever came last".
            const seenIds = new Set();
            const duplicateIds = new Set();
            for (const post of projected) {
              if (seenIds.has(post.id)) duplicateIds.add(post.id); else seenIds.add(post.id);
            }
            const imagesById = new Map(projected
              .filter((post) => !duplicateIds.has(post.id))
              .map((post) => [post.id, post.images]));
            posts = visible.map((post) => {
              const images = imagesById.get(post.id);
              // ONLY when there is something to show. Attaching an empty array to every post would
              // change the shape of every response — including the ones with no media at all — and
              // `filterOfflinePosts` deliberately produces a fixed view; "no pictures" is expressed
              // by the field being absent, exactly as it is in the platform payload.
              return Array.isArray(images) && images.length > 0 ? { ...post, images } : post;
            });
            if (scope && scope.postId !== null) {
              posts = posts.filter(p => p.id === scope.postId);
              if (posts.length !== 1) return { allowed: false, reason: 'unsupported', reserved: true, dispatched: true };
            }
          }
        } catch {
          settle('unknown');
          return unknown();
        }
        settle('success', { ...audit, result: 'success' });
        // NO count accompanies `posts`. Returning `received` (rows before filtering) handed the caller
        // `received - posts.length`, i.e. exactly how many rows this reader refused to show — measured
        // with identical posts and hidden row counts 0/1/5/17 producing four different numbers. See the
        // "WHY NO COUNT IS RETURNED" header.
        return { allowed: true, outcome: 'success', posts };
      } catch (error) {
        if (dispatched) {
          // Pre-dispatch refusals were already separated inside the narrow try around
          // `transport(...)` above. Reaching this branch means the platform call was
          // issued: a revalidation, the projection, or an audit write failed afterwards.
          // The outcome is genuinely unknown, so keep the charge and say so.
          settleUnknownBestEffort();
          return unknown();
        }
        // A throw can also land between the committed reservation and the transport
        // (for example a clock or verifier error at the pre-dispatch recheck). The
        // one-shot intent is already stored at that point, so the caller has to hear
        // about it even though no platform request left the process. Reporting a bare
        // `unverified` here made a consumed reservation indistinguishable from a
        // rejection that never touched the store.
        return reserved
          ? { allowed: false, reason: 'unverified', reserved: true, dispatched: false }
          : { allowed: false, reason: 'unverified' };
      }
    }
    let result;
    try {
      result = await perform();
    } finally {
      open = false;
      if (exceptionReads) {
        try {
          const finished = exceptionReads.finishScope(context, scope);
          if (finished !== undefined && finished !== true) {
            observeAsync(finished);
            throw new TypeError('invalid scope finish');
          }
        } catch {
          result = dispatched ? unknown() : { allowed: false, reason: 'unverified',
            ...(reserved ? { reserved: true, dispatched: false } : {}) };
        }
      }
    }
    if (exceptionReads && reserved) {
      try {
        // Closing the host lease may revoke the source or change the epoch.
        // Recheck binding/source and policy without consulting the closed lease.
        if (result?.outcome === 'success' && !strictCurrent(() =>
          (!isStillAuthorized || strictCurrent(() => isStillAuthorized(modelRequest))) &&
          authorizeTool(store.read(), action).allowed === true)) result = unknown();
        const outcome = result?.outcome === 'success' ? 'success' : 'unknown';
        settleAuditedOfflineRead(store, proof.id, outcome, { ...audit, result: outcome }, proof.now);
        // ────────────────────────────────────────────────────────────────────────────────
        // THE ONE AND ONLY EVIDENCE WRITE IN `src/`
        // ────────────────────────────────────────────────────────────────────────────────
        // Reached only when ALL of the following already succeeded, in this order:
        //   1. the platform read itself                     (`raw` in hand, else `unknown()` above)
        //   2. post-I/O proof / account / friend / epoch     (`sameProof` + `boundFriendReceipt`)
        //   3. the synchronous `current()` source recheck    (revoked lease ⇒ `unknown()`)
        //   4. the projection + own-new-comment filter       (`filterOfflineOwnNewComment` non-null;
        //      null throws, so `evidenceProjection` stays null)
        //   5. `finishScope`                                 (a failed close rewrites `result`)
        //   6. the post-lease policy recheck                 (`authorizeTool` above; a refusal here
        //      sets `result = unknown()` BEFORE this line)
        //   7. the settled audit outcome being `success`     (`outcome` recomputed from `result`)
        // A failure at ANY of them leaves `evidenceProjection` null or `outcome !== 'success'`, and then
        // nothing is written. `reserved` is true on every `read_comments` request that got this far
        // (its reservation is unconditional before dispatch), so this block is not skipped for it.
        //
        // ⚠️ THIS LINE READS NOTHING. `evidenceProjection` was built and frozen back at the read site;
        // it is a derived value, never `raw`. Do NOT reintroduce a `bindAuthorizedOwnNewQzoneComment`
        // call here and do NOT stash `raw` on a side channel: doing so restores the very defect this
        // shape removes (a host callback mutating the payload between the read and the write).
        // A throw from `record()` writes NOTHING (its validation precedes the store transaction) and
        // cannot authorise anything; it is swallowed instead of downgrading a legitimate read to
        // `unknown`, because a missing row can only ever REFUSE a later reply (fail closed).
        if (outcome === 'success' && evidenceProjection !== null) {
          try {
            replyEvidence.record(evidenceProjection, { now: proof.now });
          } catch { /* unrecorded evidence can only refuse a reply, never authorise one */ }
        }
      } catch {
        // One settlement attempt only. Keep the committed intent and consumed
        // grant if persistence fails; never return fetched data or retry I/O.
        result = dispatched ? unknown() : { allowed: false, reason: 'unverified', reserved: true, dispatched: false };
      }
    }
    return result;
  }
  return Object.freeze({
    // `paging` is optional on every entry point so no existing caller changes shape.
    read: (binding, paging) => read(binding, 'read_posts', null, paging),
    readComments: (binding, postId, paging) => read(binding, 'read_comments', postId, paging),
  });
}

/**
 * The envelope narrowing step, exposed for tests ONLY.
 *
 * WHY IT NEEDS TO BE REACHABLE: `recentEnvelope` is the one place that decides which platform rows
 * survive and which of their fields are carried forward, and NONE of that is observable through
 * `read()` — the projection and `filterOfflinePosts` downstream rebuild each post into a fixed
 * {author, id, time, content} view, so "did the 7-day floor drop this row" and "did `images` get
 * thrown away here" both look identical to a caller. Pinning those two behaviours requires calling
 * this function directly; naming it `_forTests` follows the convention already used across
 * `src/core` (`_classifyForTests`, `_writeAuditInputDigest`, ...).
 *
 * It stays a pure function: no I/O, no store, and it never hands back an upstream count.
 */
export { recentEnvelope as _recentEnvelopeForTests };
