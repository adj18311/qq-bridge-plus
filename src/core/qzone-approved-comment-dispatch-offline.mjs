// Host-APPROVED operation -> ONE real platform call (comment, reply or like), offline composition only.
//
// WHY THIS MODULE EXISTS
// ----------------------
// Three reviewed pieces already exist and none of them is a write:
//
//   `qzone-operation-authorization-offline.mjs`  prepare/verify/claim/finish — "this exact
//                                                operation was approved, and its B2 key is mine".
//   `qzone-write-path-offline.mjs`               gate -> reserve -> final check -> transport,
//                                                with a FROZEN `dispatch` handed to the transport.
//   `qzone-onebot-write-contract.mjs`            the platform request shape for that dispatch.
//
// Composing them by hand is where the interesting failure lives: the write path's transport is
// called AFTER the quota was reserved, so anything that refuses inside the transport is a write
// that costs a unit and sends nothing. That must be a REFUSAL, never an exception — an exception
// would be classified `unknown` by the write path, i.e. "it may have gone out", which is a lie
// about a call that provably did not. This module exists to make the composition explicit and to
// get that classification right.
//
// THE ORDER IS THE DESIGN, AND IT IS NOT COMMUTABLE
// ------------------------------------------------
//   1. action not in {comment, reply, like} -> CONTROLLED REFUSAL (`unsupported-action`). No
//                                       prepare, no reservation, no claim, no send.
//   1a. (REMOVED — see "THE EVIDENCE CHECK LIVES IN THE RESERVATION LAYER" below.)
//   1b. like carrying `abstime`       -> CONTROLLED REFUSAL (`unsupported-abstime`), checked on the
//                                       caller's input AND on the frozen snapshot. No reserve, no
//                                       claim, no send.
//   2. authorizer.prepare(...)       -> null -> refusal. Nothing was reserved and nothing was
//                                       claimed: `prepare()` is side-effect free by construction.
//   3. writePath(closure).write(..)   -> gate -> reserve (INCLUDING the reply evidence gate, inside
//                                       that same transaction) -> finalAuthorisationCheck -> closure.
//   4. the closure, i.e. AFTER the linearization point and BEFORE the platform call:
//        a. dispatch vs the approved snapshot (field by field)  -> mismatch = refusal, no send
//        b. authorizer.verify(ticket, expected) !== true        -> refusal, no claim, no send
//        c. payload built FROM `ticket.operation.input` (the deep-frozen canonical snapshot)
//        d. authorizer.claim(ticket, expected) — exactly once    -> refusal, no send
//        e. await send(payload)
//   5. finally authorizer.finish(ticket)
//
// WHY `writePath` MUST BE A FACTORY AND NOT AN INSTANCE
// -----------------------------------------------------
// The transport closure needs THIS execution's ticket, THIS execution's `expected` frame and a
// per-execution refusal cell. An instance would have been built with a transport somebody else
// chose — most likely a plain `async (dispatch) => send(dispatch)` that never runs step 4 at all.
// Accepting one would therefore silently skip the dispatch comparison, the verify and the claim,
// and still look like a working write path. So an instance is a CONSTRUCTION-TIME TypeError; a
// factory is the only shape that makes step 4 structurally unavoidable. Tests that need to
// observe the dispatch (e.g. tamper with it) can still wrap the real factory — the wrapper is
// where the comparison is supposed to fail.
//
// WHY THE PAYLOAD IS BUILT FROM THE FROZEN SNAPSHOT
// -------------------------------------------------
// `ticket.operation.input` is a deep-frozen, canonicalised copy of what the host approved. The
// caller's `input` object is mutable and is only used to RE-CHECK the approval (`verify`). If the
// payload were built from the caller's object, a write could go out for a body the host never saw.
// Field order is irrelevant to the platform, but the mapping is total: MCP `{tid, target_uin,
// content}` -> facade `{postId: tid, target: target_uin, content}` -> dispatch -> `{action:
// 'comment_qzone', params: {tid, target_uin, content}}`. Nothing is dropped and nothing is invented,
// which is why `comment` and `like` need no extra corroboration. `reply` has FOUR of its five
// required fields on that same path (`comment_id` rides the dispatch as `commentId`) and takes the
// fifth (`comment_uin`) straight from the frozen snapshot — never from the caller, and never
// invented. The write path freezes that identity onto the dispatch and the RESERVATION layer refuses
// the reply unless the store's evidence collection corroborates it, all inside one transaction.
//
// THE BUILDER IS CHOSEN BY BUSINESS `action`, NEVER BY THE QUOTA `kind`
// -------------------------------------------------------------------
// `dispatch.kind` is a QUOTA BUCKET, not an action: `ACTION_TO_KIND` maps BOTH `comment` and
// `reply` onto `'comment'` because a reply is a comment write sharing one daily allowance and one
// 3-minute interval. Choosing the platform builder from `kind` would therefore silently turn a
// reply into a comment — a DIFFERENT operation on the same post, sent under an approved reply.
// `like`'s kind happens to equal its action today (`like` -> `'like'`), and that coincidence is
// exactly the kind of thing that stops being true without anyone noticing, so the rule is
// unconditional: the builder key comes from the approved business action. `ACTION_TO_KIND` is
// imported from the write path (the one place that decides quota buckets) rather than re-spelled
// here, so a future bucket change cannot make the two disagree.
//
// `like` HAS NO BODY, AND `abstime` IS REFUSED RATHER THAN DROPPED
// --------------------------------------------------------------
// The platform contract lists exactly `FIELDS.like = {tid, target_uin, abstime}`; `content` is not
// a field of a like and `copyFields` throws `invalid field` on it. So the like payload is built
// from ONLY `{tid, target_uin}` — passing the dispatch's `content: null` through would be an
// `invalid field` throw, and passing a real body would be worse: it would be refused by
// `snapshotRequest` (`unexpected-content`) anyway.
//
// `abstime` is a different matter: it IS a legal MCP field (`qzone-mcp-contract.mjs` documents it
// as optional) but it has NO carrier in either the write-path dispatch
// (`{id, action, kind, target, postId, source, content}`) or the facade call, so it cannot reach
// the platform through this composition. Dropping it silently would send a like at a DIFFERENT
// timestamp than the host approved, so an approved snapshot containing `abstime` is a CONTROLLED
// REFUSAL before anything is reserved, claimed or sent. "Not supported yet" is the honest report;
// a quiet substitution is not.
//
// `publish` remains refused for the reason in `UNSUPPORTED_DETAIL`: the frozen dispatch has no
// field for `ugc_right`/`target_uins`, so rebuilding it would require inventing fields the host
// never approved.
//
// WHY `reply` IS NOW SUPPORTED, AND WHAT MAKES IT DIFFERENT
// --------------------------------------------------------
// A reply needs five MANDATORY platform fields — `{tid, target_uin, content, comment_id,
// comment_uin}` — plus an optional `{reply_uin, reply_name}` pair. The write-path dispatch carries
// three of them (`postId`, `target`, `content`) and, for a reply only, `commentId`. `comment_uin`
// and the reply pair are supplied by THIS module from the approved snapshot, and the write path
// validates and freezes them onto the dispatch.
//
// `comment_uin` is the AUTHOR of the parent comment, i.e. an identity this process did not observe.
// Taking it from the approved snapshot alone would let the host-facing caller name the parent
// comment's author, and a reply would then be addressed to a comment (and, with
// `reply_uin`/`reply_name`, to a person) that nothing in this process ever confirmed exists.
//
// So a reply additionally requires EVIDENCE: `state.commentEvidence` must hold exactly one entry for
// this (target, postId, commentId) triple whose `commentUin` equals the approved `comment_uin` and
// whose `replyUin`/`replyName` agree with the approved pair — compared with the SHARED predicate
// `matchesReplyEvidence` (`qzone-reply-evidence-offline.mjs`), imported rather than re-spelled,
// because a second copy of "same reply?" is a copy that can drift without anyone noticing.
//
// ⚠️ THE EVIDENCE CHECK LIVES IN THE RESERVATION LAYER, NOT HERE
// -------------------------------------------------------------
// `reserveAuditedOfflineInteraction` (`qzone-reservation-offline.mjs`) owns this check, and the write
// path calls it at stage 1 for `action === 'reply'`. That placement is the whole guarantee:
//
//   · The check runs INSIDE the same `store.update` as the quota reservation and the audit-intent
//     append. A missing/mismatched row therefore returns `{allowed:false}` BEFORE `reserveWrite`
//     runs, so `used.comment`, `lastCommentAt`, `commentTargets` and the B2 claim are all unchanged,
//     and the refusal is the write path's ordinary pre-reserve shape: `stage:'reserve'` with NO
//     `quotaConsumed` field at all (it only appears once a unit could have been spent) — never
//     `quotaConsumed:true`.
//   · This module deliberately does NOT repeat the check in its transport closure. A check there
//     would run AFTER the reservation committed, so refusing would burn a `comment` unit and push
//     the 3-minute comment clock — turning one bad request into a cooldown that throttles every
//     later legitimate comment. Transport-stage refusals remain, but only for causes that cannot be
//     decided before the write path is entered (`compareDispatch`, `verify`, `claim`).
//   · Because the check is inside the reservation transaction, "reserved ⇒ evidence matched" is
//     TRUE for a reply (up to the transaction boundary of this store). This module states that only
//     because the write path puts the check there; it does not perform or duplicate it.
//
// ⚠️ WHAT THAT EVIDENCE CHECK IS NOT
// ----------------------------------
//   · NOT production evidence. **No producer of `state.commentEvidence` was found within the checked
//     scope** (this repository's `src/`). Every test seeds it as a FIXTURE, and no reader in the
//     checked scope appends a row from a platform read. That is not a claim about every deployment,
//     host or external writer. When no corroborating row exists the reservation layer refuses the
//     reply — FAIL CLOSED by absence, which is the honest state, not "verified".
//   · NOT a claim that the parent comment exists on the platform, and NOT a verification of who
//     wrote the evidence row. It says "such a row exists in this store"; the reservation module's
//     own comment ("a model-supplied evidence list would defeat this check") is the reason absence
//     must refuse, not a proof that a present row is genuine.
//
// WHAT THIS IS NOT
// ----------------
//   · NOT a production entry point. Nothing in `src/bridge.js` imports it.
//   · NOT `state.audit` and NOT the circuit breaker. This module appends nothing to `state.audit`,
//     counts no consecutive failure and never trips `writePaused`; those live in their own modules
//     and must not be described as integrated here. (The reservation layer DOES append an `unknown`
//     audit intent together with a successful reserve; that is the write path's transaction, not this
//     module's.) It DOES write to the separate write-AUDIT sink (`state.writeAudit`) when a caller
//     opts in with `audit` — the `intent`/`result` rows, derived from the frozen post-approval
//     snapshot; see the doc comment on `createQzoneWriteAuthorizer` for exactly what they say.
//   · NOT an authentication of the caller, the host or the transport. `authorizer` and `send` are
//     TRUSTED injections; everything is in-process and inherits the process boundary.
//   · NOT a retry engine. A `send` that throws is classified `unknown`, the claim and the quota
//     unit are kept, and nothing is retried (a retry is a second send, not a repair).
//   · NOT a refund path. A refusal inside the closure happens after the reservation committed, so
//     `quotaConsumed: true` is reported honestly; `reserveWrite` has no undo and deleting a
//     reservation would reopen the replay window. Refusals decided BEFORE the transport (including
//     the evidence gate, which is now decided in the reservation transaction) cost nothing.

import { buildQzoneOnebotWriteRequest } from './qzone-onebot-write-contract.mjs';
import { ACTION_TO_KIND } from './qzone-write-path-offline.mjs';
import { buildQzoneWriteAuditFrame } from './qzone-write-audit-broker-adapter-offline.mjs';
// G1 (M2)：结算映射**只有一份**，就用 publish 组合层导出的那个。这里刻意不复制一份实现 ——
// 两条写组合层若各写一套“哪种 outcome 计失败”，漂移的后果是熔断误停或计数永不清零。
import { settleApprovedWriteOutcome } from './qzone-approved-publish-dispatch-offline.mjs';

/** The outcome words the write-audit sink accepts on a `result` row. */
const AUDIT_RESULT_OUTCOMES = new Set(['success', 'failed', 'unknown', 'not-sent']);

/**
 * The actions this module will attempt, and the SOURCE each payload field is built from.
 *
 * `comment` needs `{tid, target_uin, content}`: all three are carried by the dispatch and by the
 * approved snapshot, so the payload is `{tid, target_uin, content}`.
 * `like` needs `{tid, target_uin}` and carries exactly that (see the header on `abstime`).
 * `reply` needs `{tid, target_uin, content, comment_id, comment_uin}` (+ an optional
 * `{reply_uin, reply_name}` pair). The dispatch carries `target`, `postId`, `content`,
 * `commentId`, and — because this module passes them from the approved snapshot — the reply
 * identity (`commentUin`, and the optional pair). The snapshot carries ALL of them, which is why the
 * payload is built from `ticket.operation.input`. "Supported" still does not mean "has a lossless
 * mapping alone": the reservation layer refuses a reply whose evidence does not match those
 * identities (see the header), so a reply is reachable here only when that gate has already passed.
 *
 * NOT here, for a measured reason rather than "later":
 *   publish — the frozen dispatch has no `ugc_right`/`target_uins`, and the platform requires an
 *             explicit visibility (never defaulted). It is also NOT corroborated by evidence, so
 *             there is nothing to check it against either.
 */
const SUPPORTED_ACTIONS = Object.freeze(['comment', 'reply', 'like']);

/**
 * The quota `kind` the write path MUST put on the dispatch for one action — read from the write
 * path's own `ACTION_TO_KIND`, never re-spelled. Used only to CHECK the dispatch's bucket; the
 * platform builder key is the business action (see `platformKindFor`).
 */
const EXPECTED_KIND = (action) => ACTION_TO_KIND[action];

/**
 * The builder key for one approved action.
 *
 * This function exists so the "action, not kind" rule has ONE named home instead of a literal at
 * the call site that a later edit could quietly switch back to `dispatch.kind`. `reply` maps to the
 * `comment` bucket, so a `kind`-keyed builder would send a reply as a comment.
 */
const platformKindFor = (action) => action;

/** The facade's own target rule (a QQ number as a decimal string). */
const QQ_IDENTITY = /^[1-9][0-9]*$/;

/** Returned by the closure when it refuses before invoking the platform sender. */
const NOT_SENT = Object.freeze({ ok: false, notSent: true });

/**
 * Why every other write action is refused BEFORE `prepare()` is even called.
 *
 * These are not "not implemented yet" notes; they are the measured shape of the two contracts.
 * `qzone-write-path-offline.mjs:571-580` freezes the dispatch to
 * `{id, action, kind, target, postId, source, content}` (plus `commentId` for a reply), and the
 * platform builder validates a closed field set per kind. Any action whose fields do not fit has
 * to lose data to be sent — and losing data silently is worse than refusing.
 */
const UNSUPPORTED_DETAIL = Object.freeze({
  publish: 'the frozen dispatch has no field for ugc_right/target_uins (qzone-write-path-offline.mjs:571-580), '
    + 'and buildQzoneOnebotWriteRequest requires an explicit ugc_right for publish',
});
const OTHER_ACTION_DETAIL = 'only comment, reply and like are composed here; this authorizer never invents '
  + 'platform fields the approved operation did not carry. A reply additionally needs the reservation '
  + "layer's store-backed comment_evidence gate (see the module header), so \"supported\" never means "
  + '"sendable without evidence"';

/**
 * Why a like carrying `abstime` is refused.
 *
 * `abstime` is a LEGAL optional field of the MCP like contract, so this refusal is not a shape
 * check — it is the absence of a carrier. Neither the write-path dispatch
 * (`{id, action, kind, target, postId, source, content}`) nor the facade call has a slot for it,
 * so a like approved WITH a timestamp cannot be sent at that timestamp through this composition.
 * Silently dropping the field would send a like for a different moment than the host approved, so
 * it is a controlled refusal before any reserve/claim/send.
 */
const LIKE_ABSTIME_DETAIL = 'the approved like carries abstime, but neither the write-path dispatch nor the '
  + 'facade call has a field to pass it through; sending would silently drop the timestamp the host '
  + 'approved, so this like is refused until abstime has a carrier';

const refusal = (fields) => Object.freeze({ ok: false, ...fields });

/**
 * The canonical identity of a MCP `target_uin`: a positive safe integer or a decimal string.
 * Returns `null` for anything else — a shape the builder would also reject, but this module wants
 * that verdict BEFORE the transport boundary rather than inside it.
 */
function qqIdentity(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && QQ_IDENTITY.test(value)) return value;
  return null;
}

/**
 * Does this approved/request input carry a like timestamp?
 *
 * `abstime` is OPTIONAL in the MCP contract, so "absent" is the normal case and must pass. Only an
 * own property whose value is neither `undefined` nor `null` counts as carrying one — an explicitly
 * `undefined` field (a shape JS callers commonly produce) says nothing and must not become a
 * refusal, while any concrete value must be refused rather than dropped: this composition has no
 * way to send it, so "was the value valid?" is not the question that needs answering.
 */
function carriesAbstime(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  if (!Object.hasOwn(input, 'abstime')) return false;
  const value = input.abstime;
  return value !== undefined && value !== null;
}

/** The controlled refusal for a like whose approved timestamp cannot be carried. */
const likeAbstimeRefusal = () => refusal({
  stage: 'authorize',
  reason: 'unsupported-abstime',
  action: 'like',
  detail: LIKE_ABSTIME_DETAIL,
});

/**
 * Compare the dispatch the write path froze against the operation the host approved.
 *
 * This is a CORRESPONDENCE check, not a second validation: the write path already validated the
 * dispatch with its own strict rules and the authorizer already validated the snapshot with
 * `validateQzoneMcpInput`. What is checked here is that they describe the SAME write, because the
 * two were produced independently (one by the facade, one by the host-facing snapshot).
 *
 * @returns `null` when every field agrees, else `{ reason, detail? }`.
 */
function compareDispatch(dispatch, approved, expected) {
  if (dispatch === null || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    return { reason: 'dispatch-not-an-object' };
  }
  // The reservation id is ours (minted from the approval), so a different one means the write
  // that is about to happen is not the write this execution asked for.
  if (dispatch.id !== expected.id) return { reason: 'id-mismatch' };
  // The dispatch's action must be the approved action (not merely "one of the supported ones").
  if (dispatch.action !== expected.action) return { reason: 'action-mismatch' };
  // The bucket is CHECKED, never used to pick the builder (see the header). `ACTION_TO_KIND` is the
  // write path's own mapping, so this cannot drift from what the reservation actually charged.
  if (dispatch.kind !== EXPECTED_KIND(dispatch.action)) return { reason: 'kind-mismatch' };
  const target = qqIdentity(approved.target_uin);
  if (target === null) {
    return {
      reason: 'unsupported-target-shape',
      detail: 'the approved target_uin is neither a positive safe integer nor a decimal string',
    };
  }
  if (dispatch.target !== target) return { reason: 'target-mismatch' };
  if (dispatch.postId !== approved.tid) return { reason: 'post-id-mismatch' };
  // Body: present for comment, ABSENT for like.
  //   · comment — the dispatch's `content` (a validated string) must equal the approved body.
  //   · like    — the approved snapshot must carry NO `content` at all, and the dispatch must carry
  //               `content: null` (the write path's own "no body" value). A like with a body was
  //               already refused by the write path (`unexpected-content`), so any difference here
  //               means the two descriptions are not the same write.
  if (dispatch.action === 'like') {
    if (Object.hasOwn(approved, 'content')) return { reason: 'unexpected-content' };
    if (dispatch.content !== null) return { reason: 'content-mismatch' };
  } else if (dispatch.content !== approved.content) {
    return { reason: 'content-mismatch' };
  }
  if (dispatch.source !== expected.source) return { reason: 'source-mismatch' };
  // Parent comment: a reply MUST carry `commentId` (the write path's own name for `comment_id`) and
  // it must be the approved one; any other action must carry none. `commentId` is not forwarded to
  // the platform from here — the payload takes `comment_id` from the approved snapshot — so this is
  // a correspondence check on the dispatch, which is what keeps the two descriptions the same write.
  if (dispatch.action === 'reply') {
    if (!Object.hasOwn(approved, 'comment_id')) return { reason: 'missing-comment-id' };
    if (dispatch.commentId !== approved.comment_id) return { reason: 'comment-id-mismatch' };
    // The reply identity the write path froze onto the dispatch must be the approved one. These are
    // the values the evidence check compares, so a drift here would be evidence checked against a
    // DIFFERENT reply than the one sent. Compared as canonical decimal strings (`trustedQQ`-style,
    // via `qqIdentity`), because the write path stores the normalised form while the snapshot may
    // hold either accepted shape.
    if (qqIdentity(dispatch.commentUin) === null
        || qqIdentity(dispatch.commentUin) !== qqIdentity(approved.comment_uin)) {
      return { reason: 'comment-uin-mismatch' };
    }
    const approvedHasTarget = Object.hasOwn(approved, 'reply_uin');
    if (dispatch.replyUin !== null || dispatch.replyName !== null) {
      // The write path normalises "no target" to `null`/`null` (qzone-write-path-offline.mjs:550-552).
      if (!approvedHasTarget) return { reason: 'unexpected-reply-target' };
      if (qqIdentity(dispatch.replyUin) === null
          || qqIdentity(dispatch.replyUin) !== qqIdentity(approved.reply_uin)) {
        return { reason: 'reply-uin-mismatch' };
      }
      if (dispatch.replyName !== approved.reply_name) return { reason: 'reply-name-mismatch' };
    } else if (approvedHasTarget) {
      return { reason: 'missing-reply-target' };
    }
  } else {
    // A comment/like has no parent comment; a `commentId` here would mean the dispatch is a reply.
    if (Object.hasOwn(dispatch, 'commentId')) return { reason: 'unexpected-comment-id' };
    // The write path refuses these itself for a non-reply (`unexpected-reply-field`), so seeing one
    // here means the dispatch is not the validated object this module handed over.
    if (Object.hasOwn(dispatch, 'commentUin') || Object.hasOwn(dispatch, 'replyUin')
        || Object.hasOwn(dispatch, 'replyName')) return { reason: 'unexpected-reply-identity' };
    // ...and symmetrically, an approved snapshot naming a parent comment is not this action.
    if (Object.hasOwn(approved, 'comment_id')) return { reason: 'unexpected-comment-id' };
  }
  return null;
}

/**
 * Build the approved-comment dispatcher.
 *
 * @param authorizer - the reviewed operation authorizer (`prepare`/`verify`/`claim`/`finish`).
 * @param writePath - factory `(transport) => ({ write })`. An instance is refused at construction.
 * @param send - `async (payload) => unknown`; the ONLY side effect, called at most once.
 * @param source - non-empty write source passed to the write path and mirrored in the dispatch.
 * @param audit - OPTIONAL write-audit sink (`{ recordWrite }`). When supplied, THIS module records
 *   the `intent` and `result` rows of the lifecycle from the frozen, post-approval snapshot.
 * @param clock - REQUIRED with `audit`: `() => integer ms`. Used only to stamp the audit rows.
 * @returns `Object.freeze({ execute })`.
 *
 * ⚠️ WHERE THE WRITE-AUDIT LIFECYCLE IS RECORDED, AND WHY IT MOVED HERE
 * --------------------------------------------------------------------
 * An earlier revision had the RUNTIME compose these rows before calling `execute()`. That was a
 * PSEUDO-audit and is now removed: at that point no `prepare()` had run, so there was no
 * `authorizationId` (it is minted inside `prepare`), no trustworthy approved snapshot, and no
 * operator. The row described an operation that had not been authorised yet.
 *
 * So the two dispatch-side stages are recorded HERE, after `prepare()` has returned a frozen
 * `ticket.operation`:
 *   · `intent`  — inside the transport closure, AFTER `verify` + the B2 `claim`, immediately BEFORE
 *                 `send`. An intent that cannot be recorded refuses the send (a controlled NOT-SENT
 *                 value, never a throw, because a throw would be classified `unknown`). The claim is
 *                 NOT rolled back: "this quadruple was used" is already a durable fact.
 *   · `result`  — after `send` returns or throws, from the write path's own classification. A result
 *                 row that cannot be recorded never changes what the caller is told happened; the
 *                 failure is reported as `auditFailed: true` next to the real `outcome`/`sent`.
 *
 * The APPROVAL row is not written here either — it belongs to `createQzoneApprovalAuditRecorder`,
 * inside the broker's `decide()`, the only layer holding the authenticated console session.
 *
 * EARLY REFUSALS WRITE NO INTENT: `prepare` returning null, an unsupported action, a dispatch
 * mismatch, a failed `verify`, a refused `claim` and an unbuildable payload all happen BEFORE "about
 * to send". A rejection is the approval layer's to record, not ours to invent.
 */
export function createQzoneWriteAuthorizer({ authorizer, writePath, send, source, audit, clock, store: settleStore, log } = {}) {
  if (!authorizer || typeof authorizer !== 'object'
      || typeof authorizer.prepare !== 'function' || typeof authorizer.verify !== 'function'
      || typeof authorizer.claim !== 'function' || typeof authorizer.finish !== 'function') {
    throw new TypeError('approved comment dispatch needs an authorizer with prepare/verify/claim/finish');
  }
  // See the header: an instance would already have a transport bound, so the comparison, the
  // verify and the claim would never run and the write would still look successful.
  if (typeof writePath !== 'function') {
    throw new TypeError('writePath must be a factory (transport) => ({ write }), not a ready instance');
  }
  if (typeof send !== 'function') throw new TypeError('approved comment dispatch needs a send function');
  if (typeof source !== 'string' || !source) {
    throw new TypeError('approved comment dispatch needs a non-empty source');
  }
  // OPTIONAL auditing. Supplied but unusable is a construction error, not a silently un-audited
  // write: the caller asked for rows and would otherwise get none. `clock` is only needed for that.
  if (audit !== undefined) {
    if (audit === null || typeof audit !== 'object' || typeof audit.recordWrite !== 'function') {
      throw new TypeError('approved comment dispatch needs an audit sink with recordWrite');
    }
    if (typeof clock !== 'function') throw new TypeError('approved comment dispatch needs a clock for auditing');
  }

  /** Derive the audit frame from the FROZEN approved snapshot. `null` when auditing is off. */
  function auditFrameFor(operation) {
    if (audit === undefined) return null;
    return buildQzoneWriteAuditFrame({
      accountId: operation.accountId,
      sessionId: operation.sessionId,
      requestId: operation.requestId,
      callId: operation.callId,
      connectionEpoch: operation.connectionEpoch,
      action: operation.action,
      input: operation.input,
      time: clock(),
    });
  }

  /** The controlled refusal for any action this module cannot rebuild without losing fields. */
  function unsupportedAction(action) {
    const name = typeof action === 'string' ? action : null;
    const detail = name !== null && Object.hasOwn(UNSUPPORTED_DETAIL, name)
      ? UNSUPPORTED_DETAIL[name]
      : OTHER_ACTION_DETAIL;
    return refusal({ stage: 'authorize', reason: 'unsupported-action', action: name, detail });
  }

  /**
   * Run one approved operation through the write path.
   *
   * @returns
   *   `{ ok:true, stage:'transport', outcome:'success'|'failed'|'unknown', sent:true, payload, ... }`
   *   `{ ok:false, stage:'authorize', reason:'unsupported-action'|'unsupported-abstime'|'not-authorized'|..., detail? }`
   *   `{ ok:false, stage:'transport', outcome:'not-sent', sent:false, reason, quotaConsumed }`
   *
   * A failure of the store inside the write path PROPAGATES: "I could not record whether this
   * happened" must not be flattened into "nothing happened".
   */
  async function execute(request) {
    const frame = request !== null && typeof request === 'object' ? request : {};
    const { action, input, consumption, connectionEpoch } = frame;

    // ── 1. only the actions with a lossless mapping ─────────────────────────────────────
    // Before `prepare()` on purpose: a refused action must not even ask the host, and must not be
    // able to reach `prepare`'s store-free but still host-facing path.
    if (!SUPPORTED_ACTIONS.includes(action)) return unsupportedAction(action);

    // ── 1a. (REMOVED) the reply evidence gate is NOT here ───────────────────────────────
    // It used to live here as a `evidence-store-required` refusal plus a closure-time read of
    // `state.commentEvidence`. Both are gone, and deliberately:
    //
    //   · The evidence check now runs INSIDE the same `store.update` as the quota reservation —
    //     `reserveAuditedOfflineInteraction`, called by the write path at stage 1 for a reply. A
    //     missing/mismatched row therefore refuses BEFORE the unit is spent, so it costs no quota and
    //     starts no 3-minute comment cooldown. See "THE EVIDENCE CHECK LIVES IN THE RESERVATION
    //     LAYER" in the module header.
    //   · Repeating the check here (after the reservation committed) could only ever ADD a second,
    //     LATE refusal that burns a unit — the exact cost this change removes. A duplicate gate is
    //     not extra safety; it is a second policy with a worse failure mode.
    //   · Consequently this module no longer needs a `store` at all: `comment_uin`/the reply pair
    //     travel to the write path on the dispatch (from the approved snapshot) and the write path
    //     supplies them to the reservation. No caller can hand this module a DIFFERENT store than the
    //     one the reservation uses, because it no longer reads one.

    // ── 1b. a like approved WITH a timestamp is refused, not silently downgraded ───────
    // Checked on the CALLER's input here (cheap, and it keeps a doomed operation from even asking
    // the host) AND on the frozen snapshot after `prepare()` — the snapshot is what would actually
    // be sent, and it is the only one that cannot be changed underneath us. Both are the same
    // predicate, so an input cannot pass one and fail the other for a reason other than mutation.
    if (action === 'like' && carriesAbstime(input)) return likeAbstimeRefusal();

    // ── 2. the host-facing approval ─────────────────────────────────────────────────────
    // `prepare` refuses (null) for: a malformed frame, a foreign/unbranded consumption, a stale or
    // expired operation, a host verdict that is not strict `true`, and any input the MCP contract
    // rejects. It holds no store and takes no claim.
    const ticket = await authorizer.prepare({ action, input, consumption, connectionEpoch });
    if (ticket === null || ticket === undefined) {
      return refusal({ stage: 'authorize', reason: 'not-authorized' });
    }

    // ── 3. everything below derives from the FROZEN snapshot, never from `input` ────────
    const approved = ticket.operation?.input;
    if (approved === null || typeof approved !== 'object' || Array.isArray(approved)) {
      return refusal({ stage: 'authorize', reason: 'not-authorized' });
    }
    // The snapshot is the authoritative record of what the host approved, so `abstime` is re-checked
    // HERE: a like whose snapshot carries a timestamp has no carrier, and dropping it would send a
    // different like than the one approved. No reserve, no claim, no send.
    if (action === 'like' && carriesAbstime(approved)) {
      // Retire the ticket explicitly: step 5's `finally` only covers the write path, and this
      // return happens before it. Nothing else holds the ticket, so leaving it live would be a
      // half-finished execution rather than a saved resource.
      authorizer.finish(ticket);
      return likeAbstimeRefusal();
    }
    const id = ticket.operation.authorizationId;
    const target = qqIdentity(approved.target_uin);
    if (target === null) {
      return refusal({
        stage: 'authorize',
        reason: 'unsupported-target-shape',
        detail: 'the approved target_uin is neither a positive safe integer nor a decimal string',
      });
    }
    // One frame object, reused by `verify` and `claim`. It carries the CALLER's `input` (so a
    // mutation after approval makes `verify` fail); the payload below never reads it.
    const expected = { action, input, consumption, connectionEpoch };

    // The dispatch handed to the write path. `action` is the APPROVED business action, and `kind` is
    // NOT set here — the write path derives it from `ACTION_TO_KIND` and freezes it (see
    // `snapshotRequest`). Sending our own `kind` would be silently ignored there, so writing one
    // would suggest this module gets to choose the bucket it is charged to.
    //
    // `content` is passed as `undefined` (i.e. ABSENT) for a like and as the approved body for a
    // comment. Passing `content: null` for a like is accepted by the write path, but leaving the key
    // out entirely is the honest shape: the approved snapshot has no body at all, and the write
    // path's own rule (`bodyRequired = action !== 'like'`, plus `unexpected-content` when a like
    // carries one) is the thing that decides.
    const dispatched = {
      id,
      action,
      target,
      postId: approved.tid,
      source,
      ...(action === 'like' ? {} : { content: approved.content }),
      // A reply's parent comment is the fourth field the write path carries, and it is what makes
      // "the dispatch" and "the approved snapshot" describe the same write (see `compareDispatch`).
      //
      // The REPLY IDENTITY travels the same way, and for the same reason: the write path validates
      // and freezes `commentUin`/`replyUin`/`replyName` onto the dispatch
      // (`qzone-write-path-offline.mjs:537-558`, `:638-642`), and those are exactly the values the
      // evidence check compares against. Passing them means the two descriptions of "which comment,
      // whose author, answering whom" are the SAME object graph, not two readings of the snapshot.
      // They are taken from the frozen snapshot, never from `input`.
      ...(action === 'reply' ? {
        commentId: approved.comment_id,
        commentUin: approved.comment_uin,
        ...(Object.hasOwn(approved, 'reply_uin')
          ? { replyUin: approved.reply_uin, replyName: approved.reply_name }
          : {}),
      } : {}),
    };

    // Per-execution refusal cell. Set by the closure; consumed after the write returns. It is how
    // "the transport refused" is kept distinct from "the transport was called and said no".
    let blocked = null;
    let payload = null;
    // Settlement could not be recorded. Same pattern as `auditFailed`: the caller keeps the real
    // verdict (outcome/sent/quotaConsumed) and learns separately that the breaker ledger was not
    // updated. Nothing is retried.
    let settlementFailed = false;
    // The audit frame is derived ONCE, from the frozen snapshot above (never from `input`), so the
    // three lifecycle rows describe ONE operation. `null` means auditing was not requested.
    let auditFrame = null;
    let intentRecorded = false;
    let auditFailed = false;
    if (audit !== undefined) {
      try {
        auditFrame = auditFrameFor(ticket.operation);
      } catch {
        authorizer.finish(ticket);
        return Object.freeze({
          ok: false, stage: 'authorize', reason: 'audit-unavailable', auditFailed: true,
        });
      }
    }

    // ── THE INPUT-DIGEST CROSS-CHECK ─────────────────────────────────────────────────────────
    // An equal QUADRUPLE digest proves the same session/request/call — never the same INPUT. The
    // approval row was written against `ticket.operation.inputDigest`; recomputing it from the frozen
    // snapshot and refusing on disagreement is the only thing that makes "approved" and "attempted"
    // provably about the same bytes. Without it, two rows can share an `authorizationId` while
    // describing different bodies, and a reader would have no way to notice.
    //
    // This runs BEFORE the B2 `claim`, before any `recordWrite` and before `send`, so a mismatch
    // costs no claim, no audit row, no quota unit and no platform call — nothing had been spent yet
    // at this point. The ticket is released (`finish`) rather than left dangling: the operation is
    // refused, not abandoned mid-flight.
    if (auditFrame !== null && auditFrame.inputDigest !== ticket.operation.inputDigest) {
      authorizer.finish(ticket);
      return Object.freeze({
        ok: false, stage: 'authorize', reason: 'audit-digest-mismatch', sent: false,
      });
    }

    /**
     * The transport the write path calls at stage 2 — after `finalAuthorisationCheck`, before the
     * platform. Every refusal here returns a NOT-SENT value instead of throwing, because a throw
     * would be classified `unknown` and reported as "may have been sent".
     */
    const transport = async (dispatch) => {
      if (blocked !== null) return NOT_SENT;

      // (a) the dispatch the write path froze must describe the approved operation.
      const mismatch = compareDispatch(dispatch, approved, { id, source, action });
      if (mismatch !== null) {
        blocked = mismatch;
        return NOT_SENT;
      }

      // (b) THE REPLY EVIDENCE CHECK IS GONE FROM HERE — see the module header.
      //
      // It used to run at this point, which is AFTER the reservation committed (stage 1 of the write
      // path) and BEFORE `verify`: a separate `store.read()` against a database the reservation had
      // already written. Two consequences made that the wrong place, and both are now impossible:
      //
      //   · QUOTA: a refusal here cost a `comment` unit and advanced `lastCommentAt` by 3 minutes, for
      //     a request that was never sent. It was reported as `outcome:'not-sent'` with
      //     `quotaConsumed:true` — honest, but still a payment for nothing.
      //   · ATOMICITY: the evidence read and the reservation were different transactions, so
      //     "reserved ⇒ evidence matched" was FALSE, and a fix in this module could not make it true.
      //
      // The check now lives in `reserveAuditedOfflineInteraction`, INSIDE the same `store.update` that
      // spends the unit, so the guarantee is "no unit spent unless the evidence matched". This closure
      // is deliberately not a second copy of that gate: a late duplicate could only re-introduce the
      // cost described above. The write path knows which reply identity was validated because this
      // module passes `commentUin`/`replyUin`/`replyName` (from the approved snapshot) on the dispatch
      // it hands over, and `compareDispatch` above pins them to what the host approved.

      // (c) the approval must still hold at the send boundary.
      if (authorizer.verify(ticket, expected) !== true) {
        blocked = { reason: 'not-authorized', detail: 'verify() did not return strict true at the send boundary' };
        return NOT_SENT;
      }

      // (d) build the platform payload from the deep-frozen snapshot.
      //
      // The BUILDER KEY comes from the approved business action (`platformKindFor`), never from
      // `dispatch.kind`. `reply` shares the `comment` quota bucket, so a kind-keyed builder would
      // send a reply as a plain comment — a different operation, under an approved reply. `like`'s
      // kind equals its action today, and this rule does not depend on that coincidence.
      //
      // The INPUT is never `approved` wholesale for a like: `copyFields` validates a CLOSED field set
      // per kind, so handing it a field of another kind is an `invalid field` throw. For a like that
      // means the dispatch's `content: null` must never be forwarded — the payload is built from
      // exactly `{tid, target_uin}`. For a comment and for a reply the approved snapshot IS exactly
      // the contract's field set (`{tid, target_uin, content}` / plus the reply fields with the
      // optional pair ABSENT when the host approved none), so it is used as-is. Nothing is
      // re-assembled by hand here: the frozen, canonical snapshot is the input, which is what makes
      // `comment_id`/`comment_uin`/`reply_uin`/`reply_name` provably the approved values.
      let built;
      try {
        built = dispatch.action === 'like'
          ? buildQzoneOnebotWriteRequest(
            platformKindFor(dispatch.action),
            { tid: approved.tid, target_uin: approved.target_uin },
          )
          : buildQzoneOnebotWriteRequest(platformKindFor(dispatch.action), approved);
      } catch {
        blocked = { reason: 'payload-unbuildable' };
        return NOT_SENT;
      }

      // (e) take the durable B2 key exactly once. A second claim of the same ticket is idempotent,
      // but this call runs once per execution, so "exactly once" is structural here.
      let claimed;
      try {
        claimed = authorizer.claim(ticket, expected);
      } catch {
        // The durable claim's commit status may be unknown, but send has not run.
        // Do not retry or try to restore a potentially committed claim.
        blocked = { reason: 'claim-failed' };
        return NOT_SENT;
      }
      if (!claimed || claimed.ok !== true) {
        blocked = { reason: typeof claimed?.reason === 'string' ? claimed.reason : 'claim-refused' };
        return NOT_SENT;
      }

      // (e2) THE PRE-SEND INTENT ROW — after the claim, immediately before the send.
      //
      // This is the first moment at which the operation is authorised AND the B2 quadruple is
      // durably claimed AND nothing has left the process. Earlier would describe a state that had
      // not been reached; later would allow a send whose intent row is missing.
      //
      // A throw here is a CONTROLLED refusal, not an exception: a throw would be classified
      // `unknown` ("it may have gone out"), which is false — `send` is never called. The claim is
      // NOT released: "this quadruple was used" stays true, and un-claiming would reopen the replay
      // window the claim closes. The spent unit is reported through `blocked`.
      if (audit !== undefined) {
        try {
          audit.recordWrite(auditFrame, 'intent', null, null);
          intentRecorded = true;
        } catch {
          blocked = { reason: 'audit-unavailable' };
          return NOT_SENT;
        }
      }

      // (f) the only irreversible step. A throw resolves to the write path's `unknown`.
      payload = built;
      return send(built);
    };

    let result;
    try {
      const path = writePath(transport);
      if (!path || typeof path.write !== 'function') {
        return refusal({
          stage: 'authorize',
          reason: 'write-path-invalid',
          detail: 'the writePath factory did not return an object with write()',
        });
      }
      result = await path.write(dispatched);
    } finally {
      // ── 5. retire the ticket on EVERY path, including a throwing store ────────────────
      // `finish` does not delete the B2 claim: the durable "this quadruple was used" fact must
      // outlive the process-local ticket.
      authorizer.finish(ticket);
    }

    // ── 6. the POST-SEND RESULT row ────────────────────────────────────────────────────
    // After the `finally` above, so the ticket is retired and the outcome is final. The word written
    // is the write path's OWN classification: `success` means "the transport claimed success",
    // `unknown` stays `unknown`, and `not-sent` is used only when the transport closure provably
    // refused before `send`.
    //
    // A throw here NEVER changes the verdict: a sent write is never re-reported as unsent, nothing is
    // retried, and the failure rides along as `auditFailed: true`.
    if (audit !== undefined && intentRecorded) {
      const reported = blocked !== null ? 'not-sent'
        : (AUDIT_RESULT_OUTCOMES.has(result?.outcome) ? result.outcome : 'unknown');
      try {
        audit.recordWrite(auditFrame, 'result', null, reported);
      } catch {
        auditFailed = true;
      }
    }

    // ── 6b. G1 SETTLEMENT: the write path's OWN classification goes to the breaker ───────────
    //
    // Same placement and same reasoning as the publish composition: after the RESULT audit row and
    // after the `finally` that retired the ticket, so `blocked` and `result.outcome` are final.
    // NOT in a catch — a settlement in a catch could rewrite `unknown`, and `unknown` ("it may
    // have gone out") is exactly what the breaker must hear.
    //
    // One shared policy, not a second copy: `settleApprovedWriteOutcome` lives in the publish
    // composition (see its header for the mapping table and the three hard constraints).
    // A throwing store becomes `settlementFailed: true`; the returned verdict never changes.
    const settlement = settleApprovedWriteOutcome({ store: settleStore, id, blocked, outcome: result?.outcome });
    if (settlement.failed === true) settlementFailed = true;

    if (blocked !== null) {
      // The quota was reserved before the closure ran, and nothing refunds it. Say so.
      return refusal({
        stage: 'transport',
        outcome: 'not-sent',
        sent: false,
        reason: blocked.reason,
        ...(blocked.detail === undefined ? {} : { detail: blocked.detail }),
        quotaConsumed: result.quotaConsumed === true,
        ...(auditFailed ? { auditFailed: true } : {}),
        ...(settlementFailed ? { settlementFailed: true } : {}),
      });
    }
    if (result.ok !== true) {
      // A refusal BEFORE the transport (gate / validation / reservation): nothing was sent.
      return Object.freeze({ ...result, sent: false, ...(auditFailed ? { auditFailed: true } : {}),
        ...(settlementFailed ? { settlementFailed: true } : {}) });
    }
    return Object.freeze({
      ...result,
      sent: true,
      ...(payload === null ? {} : { payload }),
      ...(auditFailed ? { auditFailed: true } : {}),
      ...(settlementFailed ? { settlementFailed: true } : {}),
    });
  }

  return Object.freeze({ execute });
}
