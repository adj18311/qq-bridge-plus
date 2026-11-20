// Host-APPROVED publish -> ONE real platform call, offline composition only.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The four reviewed pieces already exist:
//
//   `qzone-operation-authorization-offline.mjs`  prepare/verify/claim/finish — "this exact
//                                                operation was approved, and its B2 key is mine".
//   `qzone-write-path-offline.mjs`               gate -> reserve -> final check -> transport,
//                                                with a FROZEN `dispatch` handed to the transport.
//   `qzone-onebot-write-contract.mjs`            the platform request shape for that dispatch.
//   `qzone-mcp-contract.mjs`                     the business input contract (explicit `ugc_right`).
//
// Composition is where the failure lives: the write path's transport runs AFTER the quota unit was
// reserved, so anything that refuses inside the transport costs a unit and sends nothing. That must
// be a REFUSAL, never an exception — an exception is classified `unknown` by the write path, i.e.
// "it may have gone out", which is a lie about a call that provably did not. This module is the
// explicit composition, with that classification right.
//
// WHY `publish` HAD TO BE A SEPARATE COMPOSITION (and not an edit of the comment one)
// ---------------------------------------------------------------------------------
// `publish` is the ONE write action whose platform payload carries fields the write-path dispatch
// does not: `ugc_right` (visibility) and, for a visibility of 16/128, `target_uins` (recipients).
// `qzone-write-path-offline.mjs:632-646` freezes
// `{id, action, kind, target, postId, source, content}` (+ the reply fields) and says so itself at
// :504-511: the full platform builder is NOT called from that facade, because for `publish` it
// needs an explicit `ugc_right`, and inventing a default visibility "would be exactly the kind of
// silent default the contract exists to forbid".
//
// So the dispatch cannot carry the visibility, and this module does not pretend otherwise. It does
// NOT widen the dispatch, does NOT pass `ugc_right` through the facade, and does NOT invent one.
// Instead the payload is built FROM the deep-frozen approved snapshot (`ticket.operation.input`),
// which DOES carry `ugc_right`/`target_uins` — because that snapshot is the thing the host
// approved. The dispatch only has to describe the same write, and it does: content, action, id.
//
// THE ORDER IS THE DESIGN, AND IT IS NOT COMMUTABLE
// ------------------------------------------------
//   1. action !== 'publish'                 -> CONTROLLED REFUSAL (`unsupported-action`). No prepare,
//                                             no reservation, no claim, no send.
//   2. authorizer.prepare(...)             -> null -> refusal (`not-authorized`). Nothing reserved
//                                             and nothing claimed: `prepare()` is side-effect free.
//                                             It is also where a publish without an explicit
//                                             `ugc_right` dies, because `validateQzoneMcpInput` routes
//                                             every publish through the platform builder.
//   3. writePath(closure).write(...)       -> gate -> reserve (post bucket, 2h interval) ->
//                                             finalAuthorisationCheck -> closure.
//   4. the closure, i.e. AFTER the linearization point and BEFORE the platform call:
//        a. dispatch vs the approved snapshot         -> mismatch = refusal, no send
//        b. authorizer.verify(ticket, expected) !== true -> refusal, no claim, no send
//        c. payload built FROM the frozen snapshot    -> unbuildable = refusal, no send
//        d. authorizer.claim(ticket, expected) once   -> refusal, no send
//        e. await send(payload)
//   5. finally authorizer.finish(ticket)
//
// WHY THE BUILDER KEY IS THE BUSINESS ACTION, NEVER `dispatch.kind`
// ----------------------------------------------------------------
// `dispatch.kind` is a QUOTA BUCKET (`ACTION_TO_KIND.publish === 'post'`, and `post` is not an
// action at all). The payload is built with the literal business action this module supports, so
// the builder choice cannot drift with a bucket rename. `dispatch.kind` is still CHECKED against
// `ACTION_TO_KIND[dispatch.action]` — imported from the write path, the one place that decides
// buckets — so a dispatch charged to a different bucket is refused rather than trusted.
//
// WHY `target`/`postId` ARE OMITTED FROM THE DISPATCH
// --------------------------------------------------
// `qzone-write-path-offline.mjs:616-622` allows `target`/`postId` to be ABSENT for `publish`
// (`!== undefined && !== null` before validating), and freezes them to `null` at :636-637. The
// approved publish snapshot has no such fields at all — `qzone-mcp-contract.mjs:24-28` is
// `{content, ugc_right, target_uins}` with `additionalProperties: false` — so there is nothing to
// pass and nothing to check them against. This module passes NEITHER, and `compareDispatch`
// therefore requires both to be `null` on the frozen dispatch: a non-null one means the object the
// transport received is not the object this execution handed over.
//
// ⚠️ WHAT THE AUDIT DOES **NOT** RECORD (read this before quoting any audit row)
// -----------------------------------------------------------------------------
// `publish` reserves through `reserveOfflinePost` — the NON-audited entry point — because that is
// the one the write path calls at stage 1 for `action === 'publish'`
// (`qzone-write-path-offline.mjs:826-827`). Consequences, stated plainly:
//
//   · THIS COMPOSITION WRITES NO `state.audit` ROW AND NO SETTLEMENT. Not a partial one, not an
//     "unknown intent": `state.audit` is untouched (pinned by the test file), and nothing here
//     settles an outcome. The write path's own `write()` returns the outcome to the caller and
//     writes no settlement either (`qzone-write-settlement-offline.mjs` is a separate chain that this
//     module does not drive). The write-AUDIT sink (`state.writeAudit`) is a DIFFERENT sink and is
//     reached only when a caller opts in with `audit` — see the doc comment on
//     `createQzonePublishAuthorizer` for exactly what is and is not recorded there.
//   · `ugc_right` and `target_uins` never enter the WRITE PATH's dispatch snapshot (`qzone-write-
//     path-offline.mjs` has no field for them), but they DO reach two other places: the built OneBot
//     payload (`buildQzoneOnebotWriteRequest('publish', approved)` needs an explicit `ugc_right`) and
//     — since the audit frame is derived from the same frozen snapshot — the `intent`/`result` rows
//     themselves, normalised by `businessFields`.
//     RECORDING VISIBILITY AND RECIPIENTS IN THE WRITE-AUDIT ROW IS **EXPLICITLY AUTHORISED** (user
//     decision, t55). The row therefore states the visibility and recipients that were APPROVED. It
//     still cannot prove the PLATFORM honoured them: the transport is injected and its answer is only
//     classified, so "row says ugc_right:16" is a statement about the approved snapshot, not about
//     who could actually see the post.
//   · This module still writes NO `state.audit` row and NO settlement, so `formatAuditRecord`'s field
//     list (`time/source/action/target/postId/content/result/reason/quota`) is not what these rows
//     are — the write-audit sink is the other sink, with its own wider shape.
//   · `reserveAuditedOfflinePost` (the audited variant) is deliberately NOT used and MUST NOT be
//     reached by routing around the write path: it requires `state.selfId` to be a decimal string
//     AND `record.target === state.selfId` (`qzone-reservation-offline.mjs:110`). A publish's
//     approved snapshot has no `target` at all, so satisfying that check would mean INVENTING an
//     audit target (the account itself) that the host never approved — a fabricated field in the
//     record that is supposed to be the evidence. Refusing to fabricate it is the honest choice;
//     the cost is that `state.audit` gets no row from this module, which is what this section says.
//     (The separate write-AUDIT sink is a different store and IS written when a caller opts in.)
//
// WHAT THIS IS NOT
// ----------------
//   · NOT a production entry point. Nothing in `src/bridge.js` imports it.
//   · NOT `state.audit`, NOT the circuit breaker, NOT settlement. It appends nothing to `state.audit`,
//     counts no consecutive failure, trips no `writePaused`, and adds no `outcomes`/`settled` entry.
//     (It DOES write `intent`/`result` rows to the separate write-AUDIT sink when `audit` is supplied.)
//   · NOT an authentication of the caller, the host or the transport. `authorizer` and `send` are
//     TRUSTED injections; everything is in-process and inherits the process boundary.
//   · NOT a retry engine. A `send` that throws is classified `unknown`, the claim and the quota unit
//     are kept, and nothing is retried (a retry is a second send, not a repair).
//   · NOT a refund path. A refusal inside the closure happens after the reservation committed, so
//     `quotaConsumed: true` is reported honestly; `reserveWrite` has no undo.
//   · NOT a defaulting layer. It never fills in `ugc_right`, never drops `target_uins`, and never
//     changes a recipient: the payload is `buildQzoneOnebotWriteRequest('publish', approved)`, and
//     the builder is the only thing that normalises identities.

import { buildQzoneOnebotWriteRequest } from './qzone-onebot-write-contract.mjs';
import { ACTION_TO_KIND } from './qzone-write-path-offline.mjs';
import { buildQzoneWriteAuditFrame } from './qzone-write-audit-broker-adapter-offline.mjs';
import { settleOfflineWrite } from './qzone-settlement-offline.mjs';

/**
 * G1：把写链的最终分类结算进双层熔断（M2）。
 *
 * WHY A SHARED FUNCTION AND NOT ONE COPY PER COMPOSITION: publish 与 comment/reply/like 是两条
 * 独立的组合层，但“哪种 outcome 该计一次失败、哪种一个字节都不该动”是**同一条政策**。两份实现迟早
 * 会漂移，而漂移的后果不是样式问题：一边把 `not-sent` 记成平台失败，熔断就会因为一串“根本没发出去”
 * 的拒绝而误停写；反过来一边漏记 `success`，连续失败计数永远清零不了。
 *
 * 三个硬约束（codex 裁定，逐条落实）：
 *   1. 只在**真实 send 之后**、结果已确定的位置调用。本函数的调用点就在 `send` 返回、RESULT 审计行
 *      之后，`blocked` 与 `result.outcome` 都已是终值 —— 不在 catch 里把 unknown 改写成别的。
 *   2. 结算失败**绝不**改变返回体：本函数只回 `{settled, failed}`，调用方据此挂一个
 *      `settlementFailed: true`，真实的 outcome/sent/quotaConsumed 原样保留，不 throw、不重试。
 *   3. 结算与 `audit.recordWrite` 是**两个独立 try**：审计写失败不该让结算跟着跳过，反之亦然。
 *
 * 映射表（写链 5 种 outcome）：
 *   · success            → settleOfflineWrite(store, id, 'success')   连续失败计数清零
 *   · unknown            → settleOfflineWrite(store, id, 'unknown')   保留配额、不计失败、不重试
 *   · failed/not-sent/refused → **不结算**，但要留一行日志（见下），便于将来发现
 *   · blocked !== null   → **完全不结算**（请求没离开进程，不计平台失败）
 *   · 其它/缺失          → 不结算（预约阶段就拒了，没有 reservation 可结算，也没有平台失败）
 *
 * ⚠️ `failure` / `login_expired` / `captcha` **没有接线**：写链当前产不出可信判据（运输层把捏不住的
 * 答案一律归成 unknown，见 qzone-write-settlement-offline.mjs 的 classify）。硬把它们塞进结算等于猜
 * 平台 retcode，codex 已明确禁止。
 *
 * @param store - 结算目标库（`{update}`）；未传入 = 本层未接线，直接不结算（行为与改动前一致）。
 * @param id    - `ticket.operation.authorizationId`，与 `ledger.reservations` 同键。
 * @param blocked - 闭包里的拒发单元：非 null 表示**一个字节都没发出去**。
 * @param outcome - 写链自己的最终分类（`result.outcome`），本函数不做任何推断。
 * @param log   - 可选日志出口；缺省退到 console.warn（只为“可见”，不是新服务）。
 */
export function settleApprovedWriteOutcome({ store, id, blocked, outcome, log } = {}) {
  // (1) 请求根本没离开进程：配额被消耗了，但那不是平台失败。
  if (blocked !== null && blocked !== undefined) return { settled: false, failed: false };
  // (2) 本层没拿到 store：如实不结算，不假装。
  //     生产已由 qzone-runtime-wiring.mjs 传入 runtime 自己的 store（M3, 21c50e3），这条分支在
  //     当前装配下不会命中。它保留是因为「不传 = 不结算」是一条 fail-quiet 契约：将来若出现
  //     第二个装配点而漏传 store，应当静默地不记账，而不是抛错或伪造成已结算。BW-4 / SI-2 钉住它。
  if (!store || typeof store.update !== 'function') return { settled: false, failed: false };
  let word;
  if (outcome === 'success') word = 'success';
  else if (outcome === 'unknown') word = 'unknown';
  else {
    if (UNEXPECTED_WRITE_OUTCOMES.has(outcome)) {
      emitLog(log, `qq 写链出现未预期的 outcome（${String(outcome)}），本轮不结算`);
    }
    return { settled: false, failed: false };
  }
  try {
    settleOfflineWrite(store, id, word);
    return { settled: true, failed: false };
  } catch {
    // 结算是旁路：抛什么都只反映成 settlementFailed，绝不改判真实的 outcome/sent。
    return { settled: false, failed: true };
  }
}

/**
 * 唯一的日志出口。缺省 console.warn 而不是静默：任务要求“未预期 outcome 必须能被发现”，
 * 而 src/core 里没有共享 logger，本文件也不允许新增服务 —— 一行 console.warn 是最小可见实现。
 * 调用方（测试/宿主）可以注入 `log` 把它接走。
 */
function emitLog(log, message) {
  if (typeof log === 'function') { try { log(message); } catch { /* 日志失败不影响结算 */ } return; }
  try { console.warn(message); } catch { /* 没有 console 的运行环境就安静 */ }
}

/** 写链里出现就必须留痕、但**不结算**的三种终值。 */
const UNEXPECTED_WRITE_OUTCOMES = new Set(['failed', 'not-sent', 'refused']);

/** The one business action this composition sends. The builder key is this, never `dispatch.kind`. */
const ACTION = 'publish';

/** Returned by the closure when it refuses before invoking the platform sender. */
const NOT_SENT = Object.freeze({ ok: false, notSent: true });

/** The outcome words the write-audit sink accepts on a `result` row. */
const AUDIT_RESULT_OUTCOMES = new Set(['success', 'failed', 'unknown', 'not-sent']);

/**
 * The dispatch fields a publish must NOT carry: they belong to other actions and mean tampering.
 * Named individually so the refusal says WHICH foreign thing arrived, not merely "unexpected".
 */
const FOREIGN_FIELDS = Object.freeze([
  ['commentId', 'unexpected-comment-id'],
  ['commentUin', 'unexpected-reply-identity'],
  ['replyUin', 'unexpected-reply-identity'],
  ['replyName', 'unexpected-reply-identity'],
]);

/**
 * The COMPLETE field set the write path freezes for a publish (`qzone-write-path-offline.mjs:632-646`,
 * with the reply branch absent). It is closed on purpose: the transport receives the object this
 * execution handed over, so ANY key outside this set means it received something else — including a
 * smuggled `ugc_right`/`target_uins`, which must never be read as "the approved visibility". The
 * payload is built from the approved SNAPSHOT only, and an extra dispatch field must not be able to
 * look like it participated.
 */
const DISPATCH_FIELDS = Object.freeze(['id', 'action', 'kind', 'target', 'postId', 'source', 'content']);

const OTHER_ACTION_DETAIL = 'only publish is composed here; every other write action is handled by '
  + 'qzone-approved-comment-dispatch-offline.mjs, and this authorizer never invents platform fields '
  + 'the approved operation did not carry';

const refusal = (fields) => Object.freeze({ ok: false, ...fields });

/**
 * Compare the dispatch the write path froze against the operation the host approved.
 *
 * A CORRESPONDENCE check, not a second validation: the write path already validated the dispatch
 * with its own strict rules and `prepare()` already validated the snapshot through the platform
 * builder. What is checked here is that the two describe the SAME write, because they were produced
 * independently (one by the facade, one by the host-facing snapshot).
 *
 * `dispatch.target`/`dispatch.postId` must be `null`: this module sends neither (see the header), so
 * a non-null value is not the approved write — it is a different dispatch.
 *
 * @returns `null` when every field agrees, else `{ reason, detail? }`.
 */
function compareDispatch(dispatch, approved, expected) {
  if (dispatch === null || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    return { reason: 'dispatch-not-an-object' };
  }
  // The reservation id is ours (minted from the approval), so a different one means the write that
  // is about to happen is not the write this execution asked for.
  if (dispatch.id !== expected.id) return { reason: 'id-mismatch' };
  if (dispatch.action !== ACTION) return { reason: 'action-mismatch' };
  // The bucket is CHECKED, never used to pick the builder (see the header).
  if (dispatch.kind !== ACTION_TO_KIND[dispatch.action]) return { reason: 'kind-mismatch' };
  if (dispatch.target !== null) {
    return {
      reason: 'target-mismatch',
      detail: 'a publish has no target in the approved snapshot, so a non-null dispatch target is '
        + 'not the write this execution handed over',
    };
  }
  if (dispatch.postId !== null) {
    return {
      reason: 'post-id-mismatch',
      detail: 'a publish has no postId in the approved snapshot (the platform assigns it), so a '
        + 'non-null dispatch postId is not the write this execution handed over',
    };
  }
  if (dispatch.content !== approved.content) return { reason: 'content-mismatch' };
  if (dispatch.source !== expected.source) return { reason: 'source-mismatch' };
  for (const [field, reason] of FOREIGN_FIELDS) {
    // The write path refuses these itself for a non-reply (`unexpected-comment-id` /
    // `unexpected-reply-field`), so seeing one here means the dispatch is not the validated object
    // this module handed over.
    if (Object.hasOwn(dispatch, field)) return { reason };
  }
  // The field set is CLOSED (see `DISPATCH_FIELDS`). A key outside it — most importantly a smuggled
  // `ugc_right`/`target_uins` — is refused rather than ignored: the payload is built from the
  // approved snapshot, so a dispatch field that looks like a visibility must not be able to sit
  // there implying it took part in the decision.
  for (const key of Reflect.ownKeys(dispatch)) {
    if (typeof key !== 'string' || !DISPATCH_FIELDS.includes(key)) return { reason: 'unexpected-field' };
  }
  return null;
}

/**
 * Build the approved-publish dispatcher.
 *
 * @param authorizer - the reviewed operation authorizer (`prepare`/`verify`/`claim`/`finish`).
 * @param writePath - factory `(transport) => ({ write })`. An instance is refused at construction:
 *   an instance would already have a transport bound, so the comparison, the verify and the claim
 *   would never run and the write would still look successful.
 * @param send - `async (payload) => unknown`; the ONLY side effect, called at most once.
 * @param source - non-empty write source passed to the write path and mirrored in the dispatch.
 * @param audit - OPTIONAL write-audit sink (`{ recordWrite }`). When supplied, THIS module records
 *   the `intent` and `result` rows of the lifecycle from the frozen, post-approval snapshot. When
 *   absent, nothing about the write changes.
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
 * The APPROVAL row is not written here either — it belongs to `createQzoneApprovalAuditRecorder` in
 * `qzone-write-audit-broker-adapter-offline.mjs`, inside the broker's `decide()`, which is the only
 * layer holding the authenticated console session.
 *
 * EARLY REFUSALS WRITE NO INTENT: `prepare` returning null, a dispatch mismatch, a failed `verify`,
 * a refused `claim` and an unbuildable payload all happen BEFORE "about to send", so the sink gets
 * nothing from this module. A rejection is the approval layer's to record, not ours to invent.
 */
export function createQzonePublishAuthorizer({ authorizer, writePath, send, source, audit, clock, store: settleStore, log } = {}) {
  if (!authorizer || typeof authorizer !== 'object'
      || typeof authorizer.prepare !== 'function' || typeof authorizer.verify !== 'function'
      || typeof authorizer.claim !== 'function' || typeof authorizer.finish !== 'function') {
    throw new TypeError('approved publish dispatch needs an authorizer with prepare/verify/claim/finish');
  }
  if (typeof writePath !== 'function') {
    throw new TypeError('writePath must be a factory (transport) => ({ write }), not a ready instance');
  }
  if (typeof send !== 'function') throw new TypeError('approved publish dispatch needs a send function');
  if (typeof source !== 'string' || !source) {
    throw new TypeError('approved publish dispatch needs a non-empty source');
  }
  // OPTIONAL auditing. Supplied but unusable is a construction error, not a silently un-audited
  // write: the caller asked for rows and would otherwise get none. `clock` is only needed for that.
  if (audit !== undefined) {
    if (audit === null || typeof audit !== 'object' || typeof audit.recordWrite !== 'function') {
      throw new TypeError('approved publish dispatch needs an audit sink with recordWrite');
    }
    if (typeof clock !== 'function') throw new TypeError('approved publish dispatch needs a clock for auditing');
  }

  /** The controlled refusal for any action this composition does not send. */
  function unsupportedAction(action) {
    const name = typeof action === 'string' ? action : null;
    const detail = name === null
      ? OTHER_ACTION_DETAIL
      : `this authorizer sends publish only (its approved snapshot carries ugc_right/target_uins, which `
        + `the write-path dispatch has no field for); "${name}" is not composed here. ${OTHER_ACTION_DETAIL}`;
    return refusal({ stage: 'authorize', reason: 'unsupported-action', action: name, detail });
  }

  /**
   * Derive the audit frame from the FROZEN approved snapshot. `null` when auditing is off.
   *
   * It is built ONCE per execution (right after `prepare`), never from the caller's `input`: the
   * snapshot is what the host approved and what the payload is built from, so the row cannot describe
   * a different operation than the one that gets sent. The id inside it is the durable quadruple
   * digest the approval row also uses, which is what makes all three rows share one `authorizationId`.
   */
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

  /**
   * Run one approved publish through the write path.
   *
   * @returns
   *   `{ ok:true, stage:'transport', outcome:'success'|'failed'|'unknown', sent:true, payload, ... }`
   *   `{ ok:false, stage:'authorize', reason:'unsupported-action'|'not-authorized'|..., detail? }`
   *   `{ ok:false, stage:'transport', outcome:'not-sent', sent:false, reason, quotaConsumed }`
   * — plus `auditFailed: true` on any of them when a requested audit row could not be written.
   *
   * A failure of the store inside the write path PROPAGATES: "I could not record whether this
   * happened" must not be flattened into "nothing happened".
   */
  async function execute(request) {
    const frame = request !== null && typeof request === 'object' ? request : {};
    const { action, input, consumption, connectionEpoch } = frame;

    // ── 1. publish only, decided BEFORE prepare() ───────────────────────────────────────
    // A refused action must not even ask the host, and must not be able to reach prepare's
    // store-free but still host-facing path.
    if (action !== ACTION) return unsupportedAction(action);

    // ── 2. the host-facing approval ─────────────────────────────────────────────────────
    // `prepare` refuses (null) for: a malformed frame, a foreign/unbranded consumption, a stale or
    // expired operation, a host verdict that is not strict `true`, and any input the MCP contract
    // rejects. That last one is where a publish WITHOUT an explicit `ugc_right` dies: the contract
    // validator runs the platform builder, which throws `invalid visibility` rather than defaulting
    // to public. It holds no store and takes no claim.
    const ticket = await authorizer.prepare({ action, input, consumption, connectionEpoch });
    if (ticket === null || ticket === undefined) {
      return refusal({ stage: 'authorize', reason: 'not-authorized' });
    }

    // ── 3. everything below derives from the FROZEN snapshot, never from `input` ────────
    const approved = ticket.operation?.input;
    if (approved === null || typeof approved !== 'object' || Array.isArray(approved)) {
      // Retire the ticket explicitly: step 5's `finally` only covers the write path, and this
      // return happens before it.
      authorizer.finish(ticket);
      return refusal({ stage: 'authorize', reason: 'not-authorized' });
    }
    const id = ticket.operation.authorizationId;
    // One frame object, reused by `verify` and `claim`. It carries the CALLER's `input` (so a
    // mutation after approval makes `verify` fail); the payload below never reads it.
    const expected = { action, input, consumption, connectionEpoch };
    // The dispatch handed to the write path. `kind` is NOT set here — the write path derives it from
    // `ACTION_TO_KIND` and freezes it. `target`/`postId` are ABSENT on purpose (see the header): a
    // publish's approved snapshot has neither, and the facade freezes both to `null`.
    //
    // `ugc_right`/`target_uins` are ABSENT TOO, and that is not an omission to be fixed later: the
    // dispatch has no field for them, so they travel only inside `approved`, which is exactly what
    // step (c) reads. Nothing is lost by that, and nothing is invented.
    const dispatched = {
      id,
      action,
      source,
      content: approved.content,
    };

    // The audit frame is derived ONCE, from the frozen snapshot above (never from `input`), so the
    // three lifecycle rows describe ONE operation. `null` means auditing was not requested. A frame
    // this module cannot build is NOT an early refusal of the write: it is an audited-operation that
    // cannot be audited, so the write is refused before anything is sent.
    let auditFrame = null;
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

    // Per-execution refusal cell. Set by the closure; consumed after the write returns. It is how
    // "the transport refused" is kept distinct from "the transport was called and said no".
    let blocked = null;
    let payload = null;
    // Settlement could not be recorded. Reported the way `auditFailed` is: the caller keeps the
    // real verdict, and learns separately that the breaker's ledger was not updated.
    let settlementFailed = false;
    // Did the INTENT row actually land? A result row is only written when it did: a lifecycle must
    // not start at the end, and a send that never had an intent recorded is exactly the unrecorded
    // send this whole change exists to prevent.
    let intentRecorded = false;

    /**
     * The transport the write path calls at stage 2 — after `finalAuthorisationCheck`, before the
     * platform. Every refusal here returns a NOT-SENT value instead of throwing, because a throw
     * would be classified `unknown` and reported as "may have been sent".
     *
     * ⚠️ MEASURED, SO IT IS STATED RATHER THAN ASSUMED: `{ok:false, notSent:true}` is NOT what the
     * write path's classifier reports. `_classifyWriteTransportResult` reads `ok:false` as a `failed`
     * claim and a co-existing `not-sent` claim as a CONTRADICTION, so it lands on `unknown`
     * (verified directly against the write path's `_classifyForTests` export — this is why the value
     * is not the evidence for any "not sent" claim in this module).
     *
     * The AUTHORITATIVE account is the `blocked` cell, not the transport's return value: the branch
     * after `write()` returns rewrites the result to `outcome:'not-sent'` whenever `blocked` is set,
     * so what a caller reads is correct regardless of the classifier's verdict. What NOT_SENT buys is
     * narrower and still necessary — the closure answers without throwing, so no exception can
     * escape into the `unknown` classification as "it may have gone out", and nothing is sent.
     */
    const transport = async (dispatch) => {
      if (blocked !== null) return NOT_SENT;

      // (a) the dispatch the write path froze must describe the approved operation.
      const mismatch = compareDispatch(dispatch, approved, { id, source });
      if (mismatch !== null) {
        blocked = mismatch;
        return NOT_SENT;
      }

      // (b) the approval must still hold at the send boundary.
      if (authorizer.verify(ticket, expected) !== true) {
        blocked = { reason: 'not-authorized', detail: 'verify() did not return strict true at the send boundary' };
        return NOT_SENT;
      }

      // (c) build the platform payload FROM the deep-frozen snapshot.
      //
      // The INPUT is `approved` wholesale, not a re-assembly: that is what makes `ugc_right` and
      // `target_uins` provably the approved values. The builder enforces the contract on that input
      // — an explicit visibility from {1,4,16,64,128}, `target_uins` REQUIRED (1..1000) for 16/128
      // and REJECTED otherwise, each recipient normalised by its own `qq()` rule. So this module
      // never supplies a default visibility and never drops or reorders a recipient: a snapshot it
      // cannot express becomes a refusal here, not a different post.
      //
      // The BUILDER KEY is the business action constant, never `dispatch.kind` (`dispatch.kind` is
      // the quota bucket `post`, which is not an action at all).
      let built;
      try {
        built = buildQzoneOnebotWriteRequest(ACTION, approved);
      } catch {
        blocked = { reason: 'payload-unbuildable' };
        return NOT_SENT;
      }

      // (d) take the durable B2 key exactly once. A second claim of the same ticket is idempotent,
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

      // (d2) THE PRE-SEND INTENT ROW — after the claim, immediately before the send.
      //
      // This is the first moment at which all three facts are true: the operation is authorised, the
      // B2 quadruple is durably claimed, and nothing has left the process. Recording "about to send"
      // anywhere earlier would describe a state that had not been reached; recording it later would
      // mean the row could be missing for a send that DID happen.
      //
      // A throw here is a CONTROLLED refusal, not an exception: a throw would be classified `unknown`
      // ("it may have gone out"), which is false — `send` is not called. The claim is NOT released:
      // "this quadruple was used" stays true, and un-claiming would reopen the replay window the
      // claim closes. The cost — one spent unit, one occupied id — is reported through `blocked`.
      if (audit !== undefined) {
        try {
          audit.recordWrite(auditFrame, 'intent', null, null);
          intentRecorded = true;
        } catch {
          blocked = { reason: 'audit-unavailable' };
          return NOT_SENT;
        }
      }

      // (e) the only irreversible step. A throw resolves to the write path's `unknown`.
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
      // The dispatch is the only argument: no `target`, no `postId`, no `commentId`. The write path
      // validates the body with the contract's own predicate and refuses anything malformed BEFORE
      // the reservation, so a bad dispatch costs nothing.
      result = await path.write(dispatched);
    } finally {
      // ── 5. retire the ticket on EVERY path, including a throwing store ────────────────
      // `finish` does not delete the B2 claim: the durable "this quadruple was used" fact must
      // outlive the process-local ticket.
      authorizer.finish(ticket);
    }

    // ── 6. the POST-SEND RESULT row ────────────────────────────────────────────────────
    // Sits after the `finally` above, so the ticket is already retired and every outcome is final.
    // The word written is the write path's OWN classification (`result.outcome`), never something
    // this module infers: `success` means "the transport claimed success", `unknown` stays `unknown`,
    // and `not-sent` is used only when the transport closure provably refused before `send`.
    //
    // A throw here NEVER changes the returned verdict: a sent write is never re-reported as unsent,
    // nothing is retried, and the failure rides along as `auditFailed: true`.
    if (audit !== undefined && intentRecorded) {
      const reported = blocked !== null ? 'not-sent'
        : (AUDIT_RESULT_OUTCOMES.has(result?.outcome) ? result.outcome : 'unknown');
      try {
        audit.recordWrite(auditFrame, 'result', null, reported);
      } catch {
        auditFailed = true;
      }
    }

    // ── 6b. G1 SETTLEMENT: hand the write path's OWN classification to the breaker ─────────
    //
    // PLACEMENT IS THE POINT. This sits after the RESULT row (so the audit lifecycle is complete)
    // and after the `finally` that retired the ticket, i.e. where `blocked` and `result.outcome`
    // are both FINAL. It is deliberately NOT inside any catch: a settlement that ran in a catch
    // could rewrite `unknown` into something else, and this module must never do that — `unknown`
    // means "it may have gone out", which is exactly what the breaker has to hear.
    //
    // SEPARATE try ON PURPOSE: `settleApprovedWriteOutcome` has its own try around
    // `settleOfflineWrite`, so a throwing audit sink (above) and a throwing store (here) fail
    // independently. Neither may swallow the other, and neither may change the returned verdict.
    //
    // `settlementFailed: true` follows the existing `auditFailed` pattern: the caller keeps the
    // REAL outcome/sent/quotaConsumed and learns, separately, that the ledger could not be updated.
    // Nothing is retried — a retry is a second send, not a repair.
    //
    // `store` and `id`: `id` is the durable authorizationId, the SAME key `reserveWrite` put in
    // `ledger.reservations` (that is what makes `ledger` a valid store for `settleOfflineWrite`).
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
