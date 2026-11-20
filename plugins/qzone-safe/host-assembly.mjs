// C2 — the PLUGIN-SIDE SELF-ASSEMBLY: everything `createQzonePluginHostRuntime` needs, built from
// ONE config object instead of being scattered across a host.
//
// WHAT THIS FILE DECIDES, AND WHAT IT ONLY PASSES THROUGH
// ------------------------------------------------------
// It creates the objects (store, replay collection, transport, approval client, write path, write
// wiring) and hands them to the runtime UNCHANGED. It makes exactly two policy choices, both
// stated and both closed:
//   · `writeWiring` is always supplied (so the write half is COMPOSED), but whether a write may
//     actually happen is still decided downstream by `mode`, the tool gate, the quota ledger, the
//     host approval and the B2 claim. A write that this file "wired" can still be refused at any
//     of those five points.
//   · nothing defaults to "on": `mode` is forwarded only when the caller names it, so the runtime's
//     own closed default (`'read-only'`, `qzone-plugin-host-runtime.mjs:121`) applies.
//
// ⚠️ WHAT THIS ASSEMBLY IS NOT (Codex ruling, C2)
// ----------------------------------------------
//   · It does NOT authenticate a source. `sourceEpoch` is a GENERATION LABEL and nothing else:
//     this file mints a random one when the caller does not supply one, and that fact proves
//     nothing about who called. The only source evidence in this system is a branded consumption
//     minted by an origin ledger AFTER it recorded the host's own events
//     (`registerBridgeRequest` -> `observeStep` from `agent/pre-step` -> `observeToolCall` from
//     `session/event`) — see `qzone-origin-ledger-offline.mjs:305-329`. The ledgers that can
//     consume are the ones `qzone-plugin-host-runtime.mjs` created through
//     `sourceLifetime.getLedger(sessionId)`, and the plugin (`plugins/qzone-safe/index.mjs:195-217,
//     278-295`) is what drives that path from real host events.
//   · It does NOT call `get_login_info` to "prove" anything. Identity arrives through the friend
//     proof chain (`qzone-friend-source-runtime.mjs` -> `qzone-friend-session-guard-offline.mjs`),
//     which re-reads the epoch around every call; that proves "which account answered right now",
//     never "this tool call came from the host".
//   · It does NOT open the write channel on the bridge side. The C1 endpoint (`src/bridge.js`,
//     `POST /api/qzone/onebot`) currently answers **403 `write-channel-not-wired`** for
//     `send_qzone_msg` / `comment_qzone` / `like_qzone`, so against the REAL bridge a write still
//     ends at the transport boundary: `qzone-write-path-offline.mjs:938-947` classifies the thrown
//     refusal as `unknown` and the quota unit stays spent. That is the honest state of the chain
//     today; see `unwired` in the returned `describe()`.
//
// THE ONE-TIME WRITE PERMIT — RETIRED WITH THE APPROVAL CHANNEL (C16 / t31)
// -------------------------------------------------------------------------
// The permit existed for ONE reason: "one human approval authorises one write". The operator then
// ruled that there is no human approval at all — only the daily quota, the minimum interval and the
// same-target dedupe. With the approval broker gone there is no "approved operation" record to mint
// a permit FROM, so the bridge's `issue` answers null for every request and every write dies as
// `write-permit-unavailable`. A gate that can only ever say no is not a gate; it is an outage with
// a gate's vocabulary. Measured: port 3212 was down and every write returned exactly that reason.
//
// SO THIS FILE NO LONGER INSTALLS THE GATE. `writePermit` / `writePermitChannel` are still ACCEPTED
// and still validated (a malformed one is a TypeError, so a typo is not silently ignored), but they
// no longer wrap the transport: the write path receives the caller's transport directly.
//
// ⚠️ WHAT STILL CONSTRAINS A WRITE — all of it below this layer and none of it touched:
//   · the tool gate and `mode` decide whether the action is enabled at all;
//   · the origin ledger / trusted binding decide whether THIS dispatch has a source;
//   · `qzone-write-path-offline.mjs` reserves the daily quota and checks the interval in one
//     transaction before the transport runs;
//   · the B2 replay claim refuses a repeated quadruple.
// What is GONE is only the replay-of-an-approval guard. What that costs, stated plainly: a holder of
// the bridge forward token can now ask the bridge to write directly, exactly as it could before C4.
//
// `send` PROJECTS THE ENVELOPE, AND THAT IS A DELIBERATE, NARROW CHOICE
// ---------------------------------------------------------------------
// The write path classifies whatever `send` RETURNS, and a raw OneBot envelope says none of the
// four words it understands, so a genuinely successful write would be filed as `unknown`. `send`
// therefore runs the answer through the codebase's OWN projector
// (`qzone-onebot-write-result.mjs`) — it does not invent a verdict, it borrows the existing rule —
// and lets every transport throw propagate, because a throw is the write path's `unknown` and is
// the honest reading of a lost answer. See `WRITE_PAYLOAD_KINDS`.
//
// WHY THE WRITE PATH IS BUILT THE WAY IT IS (the `requireAuthority` gate)
// ----------------------------------------------------------------------
// `createOfflineWritePath` refuses at construction unless its store carries a send authority
// (`qzone-write-path-offline.mjs:693` -> `qzone-authority-shared.mjs:89-100`). The ONLY way to
// satisfy that is to hand it the handle `openOfflineStore` returned (or a spread wrapper of it) —
// there is deliberately no "declare this object an authority" escape hatch any more. So this file
// opens the store itself and passes THAT handle to every component: the runtime, the replay
// collection, the write path and the write-audit sink all share one handle, which is also what
// keeps one fault latch and one quota ledger per database.
//
// AUDIT SINK — TWO SINKS, TWO LIBRARIES (stated, not implied)
// ---------------------------------------------------------
// The write-audit rows this file's sink records go into `state.writeAudit` of the PLUGIN's SQLite
// database. The bridge-side console reads ITS OWN database. Nothing today copies one into the
// other, so "the console shows no write audit row" is expected and is NOT evidence that the row was
// never written.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createQzonePluginHostRuntime } from '../../src/core/qzone-plugin-host-runtime.mjs';
import { openOfflineStore } from '../../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../../src/core/qzone-replay-claim-offline.mjs';
import { createOfflineWritePath } from '../../src/core/qzone-write-path-offline.mjs';
import { createQzoneApprovalIpcClient } from '../../src/core/qzone-approval-ipc-client.mjs';
import { createQzoneWriteAudit } from '../../src/core/qzone-write-audit-offline.mjs';
import { projectQzoneWriteResult } from '../../src/core/qzone-onebot-write-result.mjs';
import { createOnebotViaBridge } from './onebot-via-bridge.mjs';
// ⚠️ C16/t31：本文件**不再**从这里导入任何东西。一次性许可（permit）机制随人工审批一起作废，
// 详见下方 `PERMIT MECHANISM RETIRED` 注释块。`write-permit-via-bridge.mjs` 仍然保留
// （其中的 client 与 async 门面有独立测试覆盖），只是不再参与装配。

/**
 * The auto-approve host policy (C14) — see the note beside its use in the factory.
 *
 * Frozen so nothing downstream can replace it with something that looks like a policy but
 * decides per-operation in secret. It is a plain `() => true`: no operation is inspected, no
 * state is consulted, and no other authority is claimed.
 */
const AUTO_APPROVE_POLICY = Object.freeze(() => true);

/** The write tools the runtime knows (`qzone-runtime-wiring.mjs:78`). A name outside this set is refused there. */
const WRITE_ACTIONS = Object.freeze(['publish', 'comment', 'reply', 'like']);
/** `qzone-runtime-wiring.mjs:76`. Named here only to build the default action list. */
const MODES = new Set(['disabled', 'read-only', 'enabled']);
/**
 * The C1 endpoint's three write actions -> the PLATFORM payload each one carries.
 *
 * WHY THE MAPPING EXISTS AT ALL. `qzone-write-path-offline.mjs:938-959` classifies what the
 * transport RETURNS; a raw OneBot envelope carries none of the four words it looks for
 * (`ok`/`outcome`/`notSent`/`unknown`), so a genuinely successful write would be reported
 * `unknown` even though the platform answered. That is the conservative direction, but it is also
 * a FALSE one, and it leaves the quota spent with no distinguishing evidence. So `send` runs the
 * answer through the codebase's own projector (`qzone-onebot-write-result.mjs`), which never
 * invents a verdict: an envelope it cannot read stays `unknown`.
 *
 * WHY THE PROJECTOR'S KEY IS NO LONGER THE PLATFORM ACTION (C6, task B). C4 mapped
 * `comment_qzone` to the business action `comment`, and that was WRONG for a REPLY: a reply and a
 * plain comment share the platform action and differ only in their business action, so every
 * reply was recorded under `comment`. The projector reads `data.comment_id` identically for both,
 * so the VERDICT was always right and the LABEL was always wrong.
 *
 * The business action is NOT in the platform payload, so it cannot be recovered here. It comes
 * from the caller: the approved-write compositions hold `dispatch.action` in their closure and
 * pass it to `send`, so the label is derived from the operation that was actually approved.
 */
const WRITE_PAYLOAD_KINDS = Object.freeze({
  send_qzone_msg: 'publish',
  comment_qzone: 'comment',
  like_qzone: 'like',
});

/**
 * The business actions `projectQzoneWriteResult` can classify, and the platform action each implies.
 *
 * Used to REFUSE a mismatched pair: a caller that hands `send` a business action of `reply` for a
 * `send_qzone_msg` payload would get a projection about the wrong operation. The check is one-way
 * and lossless — `comment` and `reply` both arrive as `comment_qzone`, so the pair cannot be
 * recovered from the payload — which is exactly why the business action has to be supplied.
 */
const BUSINESS_ACTION_PLATFORM = Object.freeze({
  publish: 'send_qzone_msg',
  comment: 'comment_qzone',
  reply: 'comment_qzone',
  like: 'like_qzone',
});

/**
 * Which BUSINESS action a platform write payload came from.
 *
 * WHY THIS IS NOT A GUESS. `comment` and `reply` share the platform action `comment_qzone`; what
 * separates them is decided by the write contract itself (`qzone-onebot-write-contract.mjs:6-7`):
 * a reply's field allowlist REQUIRES `comment_id` and `comment_uin`, and a plain comment's
 * allowlist does not contain them at all. So presence of that PAIR is the contract's own
 * discriminator, not this file's opinion.
 *
 * WHY IT EXISTS AT ALL. The approved-write compositions hold the true `dispatch.action` but call
 * `send(built)` without it (`qzone-approved-comment-dispatch-offline.mjs:715`,
 * `qzone-approved-publish-dispatch-offline.mjs:506`). Changing those files is out of scope here, so
 * the assembly derives the action and `send` prefers an explicitly passed one when it arrives.
 *
 * HONEST SCOPE OF THE FIX: `projectQzoneWriteResult` reads `data.comment_id` identically for
 * `comment` and `reply`, and every audit row takes its `action` from the APPROVED OPERATION (not
 * from this label), so today this changes NO verdict and NO recorded audit row. It removes a
 * latent label bug: the moment the projector or a consumer distinguishes the two, a reply would
 * otherwise be filed as a comment.
 *
 * @returns {'publish'|'comment'|'reply'|'like'|null} null when the payload cannot be attributed.
 */
export function deriveBusinessAction(payload) {
  const params = payload?.params;
  if (payload?.action === 'send_qzone_msg') return 'publish';
  if (payload?.action === 'like_qzone') return 'like';
  if (payload?.action === 'comment_qzone' && isPlainRecord(params)) {
    return Object.hasOwn(params, 'comment_id') && Object.hasOwn(params, 'comment_uin') ? 'reply' : 'comment';
  }
  return null;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The policy fields `authorizeTool` reads (`qzone-policy-offline.mjs:248-254`). Checked here so a
 * mistyped initial state fails at ASSEMBLY with a message that names the field, instead of turning
 * every later dispatch into a silent `tool_permission` refusal.
 */
function requirePolicyState(initialState) {
  if (!isPlainRecord(initialState)) {
    throw new TypeError('qzone host assembly needs a plain initialState object');
  }
  const booleans = ['enabled', 'readAllowed', 'writeAllowed', 'accessPaused', 'writePaused'];
  const missing = booleans.filter((key) => typeof initialState[key] !== 'boolean');
  if (missing.length > 0) {
    throw new TypeError('qzone host assembly initialState needs boolean ' + missing.join('/'));
  }
  if (!isPlainRecord(initialState.tools)) {
    throw new TypeError('qzone host assembly initialState needs a tools record');
  }
  return initialState;
}

function requireStateDir(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('qzone host assembly needs a stateDir path');
  }
  return path.resolve(value);
}

/**
 * Build the plugin-side assembly.
 *
 * @param {object} options
 * @param {string} options.stateDir   directory for the plugin's own SQLite file (created if absent).
 *   The caller owns this decision; this module never picks `state/` on its own.
 * @param {object} options.initialState  the durable state to install on FIRST open (policy fields,
 *   limits, quota ledger, ...). Required: whether reads/writes are allowed is the operator's call.
 * @param {string} options.origin    loopback origin of the bridge console (`http://127.0.0.1:3100`).
 * @param {string} options.token     the C1 forward-endpoint bearer token (`qzone.onebotForwardToken`).
 * @param {number} options.botQq     the account this assembly speaks for.
 * @param {{origin: string, token: string, timeoutMs?: number}} [options.approval]
 *   OPTIONAL since C14. Supplied ⇒ the cross-process approval channel's client
 *   (`createQzoneApprovalIpcClient`) is built here and every operation is put to the operator.
 *   OMITTED ⇒ the assembly installs the AUTO-APPROVE host policy (see `AUTO_APPROVE_POLICY`):
 *   every operation is approved, because the operator's ruling is that no human approval is
 *   needed — the interval, the daily quota, the tool gate, the origin binding and the B2 claim
 *   all remain in force. `approveOperation` IS the host's policy hook; "always true" is a
 *   legitimate policy, not a bypass of one.
 * @param {string} [options.sourceEpoch]  generation label. Omitted => a fresh random one. It is
 *   NOT authentication (see the header).
 * @param {number} [options.connectionEpoch]  starting connection generation (default 0). A CHANGED
 *   value permanently invalidates the runtime (`qzone-runtime-wiring.mjs:262-280`); rebuild instead.
 * @param {() => number} [options.clock]  trusted clock (default `Date.now`).
 * @param {'disabled'|'read-only'|'enabled'} [options.mode]  forwarded to the runtime when named.
 * @param {string[]} [options.writeActions]  which write tools to compose (default: all four).
 * @param {string} [options.stateFile]  override the database file name inside `stateDir`.
 * @param {number} [options.sessionLimit] / @param {number} [options.trackingLimit]  forwarded.
 * @param {typeof fetch} [options.fetch]  injected fetch for the bridge transport only.
 * @param {{issue: Function, consume: Function, revoke?: Function}} [options.writePermit]
 *   a permit CLIENT whose `issue`/`consume` are ASYNC — the bridge-held registry
 *   (`plugins/qzone-safe/write-permit-via-bridge.mjs`). Absent ⇒ the write path runs exactly as
 *   before that option existed (no permit is required).
 * @param {{origin: string, token: string, timeoutMs?: number}} [options.writePermitChannel]
 *   the bridge permit channel. An alternative to `writePermit` for a host that has an origin and a
 *   token but no pre-built client: the assembly builds a LAZY client so one dynamic import is
 *   shared by every write. Supplying both is a TypeError (two owners of one decision).
 * @returns {object} frozen `{ runtime, store, transport, teardown, describe }`.
 * @throws {TypeError} on any missing or mistyped dependency, and on a store that cannot be opened.
 */
export function createQzoneHostAssembly(options = {}) {
  if (!isPlainRecord(options)) throw new TypeError('invalid qzone host assembly options');
  const {
    stateDir, initialState, origin, token, botQq, approval,
    sourceEpoch, connectionEpoch, clock, mode, writeActions,
    stateFile, sessionLimit, trackingLimit, fetch: fetchOption, writePermit, writePermitChannel,
    // C13: this module does NOT start the source-register listener — it has no handle to call.
    // The section is accepted here (rather than rejected as an unknown key) and handed straight
    // back to `apply()` through the returned object, which is where the listener lives.
    sourceRegister,
  } = options;

  const directory = requireStateDir(stateDir);
  requirePolicyState(initialState);
  if (!Number.isSafeInteger(botQq) || botQq <= 0) {
    throw new TypeError('qzone host assembly needs a positive botQq');
  }
  // C14: `approval` is OPTIONAL. When it is supplied it must be a usable channel; when it is
  // omitted the assembly installs the auto-approve policy below. A MALFORMED section is still a
  // TypeError — "no channel" and "a channel that cannot work" are different statements, and
  // silently treating the second as the first would approve writes the operator meant to review.
  if (approval !== undefined && !isPlainRecord(approval)) {
    throw new TypeError('qzone host assembly approval must be a channel { origin, token } when provided');
  }
  if (clock !== undefined && typeof clock !== 'function') {
    throw new TypeError('qzone host assembly clock must be a function when provided');
  }
  if (writePermit !== undefined && writePermitChannel !== undefined) {
    // Two owners of one decision: which client spends the permit. Refusing is the only answer
    // that cannot silently pick the wrong one.
    throw new TypeError('qzone host assembly takes writePermit OR writePermitChannel, not both');
  }
  if (writePermit !== undefined) {
    if (writePermit === null || typeof writePermit !== 'object'
        || typeof writePermit.issue !== 'function' || typeof writePermit.consume !== 'function') {
      throw new TypeError('qzone host assembly writePermit must be a client with issue/consume');
    }
  }
  if (writePermitChannel !== undefined) {
    // 形状仍然校验：一个拼错的配置必须是响亮的 TypeError，而不是被静默忽略。
    // 但**不再**要求 bridge 侧的许可模块存在 —— 许可已作废，要求一个永远不会被调用的模块
    // 只会让还留着旧配置的部署在启动时炸掉，而那正是本任务要消除的故障形态。
    if (!isPlainRecord(writePermitChannel)) {
      throw new TypeError('qzone host assembly writePermitChannel must be { origin, token }');
    }
  }
  // C16/t31：许可机制已随审批一起作废 —— 这里**不再**构造 client。
  // 两个选项仍然被接收并校验（上面那段）：拼错的配置必须是 TypeError，而不是被静默忽略；
  // 但它们不再影响 transport 的形状。理由见文件头 `PERMIT MECHANISM RETIRED` 段。
  //
  // 为什么要显式声明成常量而不是直接删掉引用：`describe()` 需要如实说明这两个选项的存在与
  // 「被忽略」这件事；一个 undefined 会让读者分不清「没配」和「配了但没用」。
  const permitRequested = writePermit !== undefined || writePermitChannel !== undefined;

  // The generation label. Random by default so two assemblies never share one; the value says
  // "this runtime instance", nothing about trustworthiness.
  const epoch = sourceEpoch === undefined ? 'qzone-assembly-' + randomUUID() : sourceEpoch;
  if (typeof epoch !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(epoch)) {
    throw new TypeError('qzone host assembly needs a sourceEpoch of 1-128 [A-Za-z0-9_.:-]');
  }
  const startEpoch = connectionEpoch === undefined ? 0 : connectionEpoch;
  if (!Number.isSafeInteger(startEpoch) || startEpoch < 0) {
    throw new TypeError('qzone host assembly connectionEpoch must be a non-negative safe integer');
  }
  if (mode !== undefined && !MODES.has(mode)) {
    throw new TypeError('qzone host assembly mode must be disabled/read-only/enabled when provided');
  }
  const actions = writeActions === undefined ? [...WRITE_ACTIONS] : writeActions;
  if (!Array.isArray(actions) || actions.length === 0 || actions.some((name) => !WRITE_ACTIONS.includes(name))) {
    throw new TypeError('qzone host assembly writeActions must be a non-empty subset of ' + WRITE_ACTIONS.join('/'));
  }

  const now = clock === undefined ? () => Date.now() : clock;

  // ── 1. the durable store, opened HERE so the write path can name its authority ──────────────
  const file = stateFile === undefined
    ? path.join(directory, 'qzone-plugin-state.sqlite')
    : path.resolve(stateFile);
  // `openOfflineStore` opens with `wx`, so the DIRECTORY has to exist. Creating it here is the
  // only filesystem write this module performs outside the database itself.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const store = openOfflineStore(file, initialState);

  // ── 1b. bind the EXPECTED bot account into the durable state, once ─────────────────────────
  //
  // WHY: the recovery probe refuses to run unless the persisted state names the account it is
  // operating on (`matchesBot` compares state.botQq/state.selfId against the configured botQq).
  // Fresh databases came up with neither field, so every probe answered identity_mismatch.
  // This closes that gap in ONE place for new and existing files alike, instead of seeding
  // initialState (which only applies to a file being created) plus a second migration script.
  //
  // WHAT THIS VALUE IS — AND IS NOT: it is the account this assembly was CONFIGURED to speak
  // for, nothing more. It is NOT proof that the live connection is that account — that is
  // attested separately by the probe's own get_login_info, and by the connection-epoch guard.
  // So writing it here does not weaken matchesBot; the comment above that function already says
  // plainly that comparing persisted strings cannot detect ABA.
  //
  // A CONFLICT IS REPORTED, NEVER OVERWRITTEN: if either field already holds a different
  // account, or a malformed value, this leaves the database completely untouched (no quota,
  // pause or audit is reset either) and records the mismatch for the caller.
  const expectedIdentity = String(botQq);
  let identityBinding = Object.freeze({ ok: true, action: 'none' });
  try {
    store.update(state => {
      const read = (key) => (state !== null && typeof state === 'object' ? state[key] : undefined);
      const currentBot = read('botQq');
      const currentSelf = read('selfId');
      const missing = currentBot === undefined && currentSelf === undefined;
      const matches = String(currentBot) === expectedIdentity && String(currentSelf) === expectedIdentity;
      if (matches) { identityBinding = Object.freeze({ ok: true, action: 'kept' }); return state; }
      // Absent on BOTH fields: initialise. A half-written pair counts as a conflict below,
      // because guessing which half is authoritative would silently pick an account.
      if (missing) {
        identityBinding = Object.freeze({ ok: true, action: 'initialized', botQq: expectedIdentity });
        return { ...state, botQq: expectedIdentity, selfId: expectedIdentity };
      }
      identityBinding = Object.freeze({
        ok: false,
        action: 'conflict',
        expected: expectedIdentity,
        found: Object.freeze({ botQq: currentBot === undefined ? null : String(currentBot), selfId: currentSelf === undefined ? null : String(currentSelf) }),
      });
      return state;
    });
  } catch (error) {
    // A store that cannot be updated must not be silently treated as "identity bound": the
    // probe will then report identity_mismatch on its own, which is the honest outcome.
    identityBinding = Object.freeze({ ok: false, action: 'failed', detail: String(error?.message ?? error) });
  }

  // ── 1c. G1 settlement prerequisite: make sure `state.outcomes` EXISTS ──────────────────────
  //
  // WHY THIS IS HERE AND NOT IN `initialState`: `initialState` only applies to a database file
  // being CREATED (`openOfflineStore` inserts it once, on first open). Every database that already
  // exists — which is every real installation — never sees it again, so a field missing from an old
  // file stays missing forever. Seeding plus a one-off migration script would be two mechanisms
  // answering one question; this single idempotent step answers it for new and existing files alike
  // (same reasoning as the identity binding in 1b, and the same placement: BEFORE anything that
  // could write).
  //
  // WHAT BREAKS WITHOUT IT — this is not cosmetic. `settleOfflineWrite`/`settleOfflineRead`
  // (`qzone-settlement-offline.mjs:40-46`) refuse to run unless
  // `state.outcomes` is a non-array object, throwing
  // `TypeError: missing reservation or invalid settlement state`. So EVERY G1 settlement — the step
  // that records a write's outcome, advances the failure breaker and enqueues the pause notice —
  // fails closed with a type error, and the reservation can never be settled. It must therefore be
  // in place BEFORE the write chain is wired (this function has not built it yet at this point).
  //
  // WHAT IT DOES **NOT** DO, and this is deliberate rather than overlooked:
  //   · it does NOT add `pauseCycles`, `dispatchClaims`, `readOutcomes` or ANY other field. One
  //     missing field is a known, measured fault; "repair whatever looks absent" would turn this
  //     into a silent schema upgrader that writes state nobody reviewed.
  //   · it does NOT reset, merge or normalise anything that already exists — no quota, no pause, no
  //     ledger, no audit, no notice. If `outcomes` is present it is left exactly as found.
  //
  // A CORRUPT VALUE IS REPORTED, NEVER REPAIRED: `null`, an array or a primitive is NOT "missing"
  // (something wrote it, so overwriting would destroy the evidence of what went wrong) and it is not
  // usable either. The database is left byte-identical and the conflict is surfaced through
  // `describe().outcomesInit`, mirroring how `identityBinding` reports a mismatch.
  let outcomesInit = Object.freeze({ ok: true, action: 'none' });
  try {
    store.update(state => {
      const present = state !== null && typeof state === 'object' && Object.hasOwn(state, 'outcomes');
      if (!present) {
        // The ONLY write this step performs: an empty, plain record. Spread first so every existing
        // field (ledger / notices / audit / readOutcomes / …) is carried over untouched.
        outcomesInit = Object.freeze({ ok: true, action: 'initialized' });
        return { ...state, outcomes: {} };
      }
      if (isPlainRecord(state.outcomes)) {
        outcomesInit = Object.freeze({ ok: true, action: 'kept' });
        return state;
      }
      outcomesInit = Object.freeze({
        ok: false,
        action: 'corrupt',
        detail: 'state.outcomes exists but is not a plain object; left UNTOUCHED because overwriting it '
          + 'would erase the evidence of whatever wrote it. G1 settlement will refuse until a human '
          + 'repairs it (qzone-settlement-offline.mjs requires a non-array object).',
        found: Object.freeze({
          type: state.outcomes === null ? 'null' : (Array.isArray(state.outcomes) ? 'array' : typeof state.outcomes),
        }),
      });
      return state;
    });
  } catch (error) {
    // A store that cannot be updated must not be reported as "outcomes ready": the marker says so,
    // and the settlement path will then fail loudly on its own.
    outcomesInit = Object.freeze({ ok: false, action: 'failed', detail: String(error?.message ?? error) });
  }

  /**
   * Observe a promise that is deliberately not awaited (`close()` is async and infallible by
   * contract). A rejection is swallowed here because the caller is already handling a failure.
   */
  const observe = (promise) => {
    if (promise !== null && typeof promise === 'object' && typeof promise.then === 'function') {
      Promise.resolve(promise).then(() => {}, () => {});
    }
    return undefined;
  };

  let approvalClient = null;
  /**
   * The host's approval POLICY when no channel is configured (C14).
   *
   * WHY THIS IS A POLICY AND NOT A BYPASS: `approveOperation` is the host's own policy hook —
   * the authorizer asks it and treats a strict `true` as "the host allows this operation"
   * (`qzone-operation-authorization-offline.mjs:304-329`). The operator's ruling is that no human
   * sign-off is required; this function is how that ruling is expressed. Everything that actually
   * limits what can happen is enforced elsewhere and is untouched here:
   *   · the tool gate (`authorizeTool`) and the origin ledger still decide whether a call may
   *     even reach an operation;
   *   · the read budget / interval (`checkBrowseBudget`) and the write intervals + daily caps
   *     (`checkInterval`, `checkDailyLimit`) still refuse;
   *   · the durable B2 claim (`replayStore`) still guarantees one execution per approved
   *     operation, which is why it stays REQUIRED and is never removed with the approval.
   * So the worst this can do is stop asking a human — it cannot widen the quota, shorten an
   * interval, bind a foreign session, or replay an operation.
   */
  let approveOperation = () => true;
  let transport = null;
  let runtime = null;
  let tornDown = false;

  // C16/t31：`approvedWrites` 捕获表与 `captureApproval` 包装**一起移除**。
  //
  // 它们存在的唯一目的是「把被批准操作的 inputDigest 喂给 permit 绑定」。许可机制作废后，
  // 这张表没有任何读者，却仍在每次 approveOperation 时拷一份正文摘要并长期持有 —— 一个只
  // 增加暴露面、不产生任何防护的负担。所以 `approveOperation` 现在直接就是策略本身
  // （AUTO_APPROVE_POLICY 或审批通道 client），不再套一层。
  //
  // 注意：这是**去掉一层包装**，不是去掉一次校验 —— 被删掉的包装只记录摘要，从不改变裁决
  // （`return verdict` 原样返回）。

  try {
    // ── 2. the B2 replay collection: without it every approved operation refuses `uninitialized` ─
    const replay = initializeReplayState(store, { now: now() });
    if (replay === null || replay.ok !== true) {
      throw new Error('qzone host assembly could not initialize the replay collection: '
        + (replay && replay.reason ? replay.reason : 'unknown'));
    }

    // ── 3. the OneBot transport (throws on every channel failure) ─────────────────────────────
    transport = createOnebotViaBridge({ origin, token, ...(fetchOption === undefined ? {} : { fetch: fetchOption }) });

    // ── 4. the approval hook ────────────────────────────────────────────────────────────────
    //
    // TWO legitimate shapes, and the Operator's ruling selects the second:
    //   · a channel ⇒ the cross-process client. Real loopback IPC; it answers `false` for every
    //     failure and never throws, so "no answer" can only mean "not approved".
    //   · no channel ⇒ AUTO-APPROVE. `approveOperation` is the host's POLICY hook (see the
    //     runtime's contract, `qzone-plugin-host-runtime.mjs:175-179`); the operator decided that
    //     no human sign-off is required, so the policy is "approve". This is a policy, not a
    //     missing check: everything that actually constrains a write is in another layer and is
    //     untouched — the tool gate, the origin ledger, the interval (2 h / 3 min), the daily
    //     quota and the durable B2 claim.
    if (approval === undefined) {
      approveOperation = AUTO_APPROVE_POLICY;
    } else {
      approvalClient = createQzoneApprovalIpcClient({
        origin: approval.origin,
        token: approval.token,
        ...(approval.timeoutMs === undefined ? {} : { timeoutMs: approval.timeoutMs }),
        clock: now,
      });
      approveOperation = approvalClient.approveOperation;
    }

    // ── 5. the write path factory. `requireAuthority` is satisfied by `store` itself — the handle
    //       `openOfflineStore` returned above. No wrapper, no declared authority, no bypass. ─────
    //
    // C16/t31：**不再包 permit 门禁**。此前这里会把 transport 包成
    // `createAsyncPermitGatedTransport`，于是每次写都先去 bridge 换一次性许可；审批 broker 移除后
    // `issue` 恒返回 null，每一笔写都以 `write-permit-unavailable` 失败（实测 3212 端口已 down）。
    // 现在 transport 原样交给 write path：额度 / 间隔 / 同目标去重 / 来源绑定 / B2 全在这条
    // write path 里，一条不少。
    //
    // `writeTransport === undefined` 仍然保留：那是「本次 dispatch 没有写通道」的既有语义，
    // write path 会以自己的方式拒绝，不是本层要改变的行为。
    const writePath = (writeTransport) => createOfflineWritePath({
      store,
      clock: now,
      transport: writeTransport,
    });

    // ── 6. the write-audit sink, over the SAME store (see the header on the two-sink split) ────
    const writeAudit = createQzoneWriteAudit({ store });

    // ── 7. the write wiring the runtime forwards VERBATIM ─────────────────────────────────────
    //   `send`       the platform payload from the approved composition, forwarded to the bridge.
    //   `writePath`  built per dispatch, exactly as the compositions expect.
    //   `source`     'qq' — a model-initiated write inside a QQ turn. `WRITE_SOURCES` allows only
    //                'qq' / 'patrol' (`qzone-runtime-wiring.mjs:88`).
    //   `actions`    the composed subset.
    //   `audit`      the sink above, so intent/result rows land next to the quota ledger.
    // ⚠️ `send` is the LAST step of the approved composition and its answer is what the write path
    // classifies. It therefore projects the envelope through `projectQzoneWriteResult` instead of
    // handing back the raw envelope, and lets every transport throw propagate: a throw is the write
    // path's `unknown`, which is the honest reading of a lost answer.
    //
    // THE BUSINESS ACTION (C6, task B). `comment` and `reply` both arrive as `comment_qzone`, so a
    // payload-derived label records every reply as a comment. The business action is not in the
    // payload, and the two compositions still call `send(built)` with no action, so this function
    // takes it EITHER WAY:
    //   · preferred — the caller passes `businessAction`, which it holds as `dispatch.action`;
    //   · otherwise — it is derived from the payload using the write contract's OWN discriminator.
    // Both are validated against the platform action before the platform is called, so a mismatch
    // refuses rather than mislabels.
    //
    // WHY DERIVATION IS LOSSLESS HERE, and not a guess: `buildQzoneOnebotWriteRequest` gives a
    // reply `comment_id` + `comment_uin` (both REQUIRED for kind 'reply',
    // `qzone-onebot-write-contract.mjs:104-106`) and gives a plain comment neither — the field
    // allowlists are disjoint (`:6-7`). So `comment_id` presence IS the reply/comment discriminator,
    // decided by the contract that built the payload, not by this file's opinion. A payload with
    // neither the explicit action nor that marker is refused.
    const send = async (payload, explicitAction) => {
      if (WRITE_PAYLOAD_KINDS[payload?.action] === undefined) {
        // No projection exists for this action, so no success can be claimed for it either.
        throw new Error('qzone host assembly cannot classify this write payload');
      }
      const kind = explicitAction === undefined ? deriveBusinessAction(payload) : explicitAction;
      if (typeof kind !== 'string' || BUSINESS_ACTION_PLATFORM[kind] !== payload.action) {
        // Refused BEFORE the platform is called: sending and then failing the label would leave a
        // real write with nothing honest to record it under.
        throw new Error('qzone host assembly needs a business action matching this write payload');
      }
      const envelope = await transport(payload.action, payload.params);
      return projectQzoneWriteResult(kind, envelope);
    };

    const writeWiring = Object.freeze({
      send,
      writePath,
      source: 'qq',
      actions: Object.freeze([...actions]),
      audit: writeAudit,
    });

    // ── 8. the runtime itself ─────────────────────────────────────────────────────────────────
    runtime = createQzonePluginHostRuntime({
      store,
      botQq,
      sourceEpoch: epoch,
      clock: now,
      call: transport,
      getConnectionEpoch: () => startEpoch,
      // C16/t31：`approveOperation` 现在就是**解析后的策略本身**（审批通道 client，或
      // AUTO_APPROVE_POLICY），不再外套 captureApproval —— 那层只为 permit 记摘要，许可作废后
      // 它没有读者。去掉的是「记录」，不是「裁决」：裁决一直由这个 hook 自己做。
      approveOperation,
      replayStore: store,
      writeWiring,
      ...(mode === undefined ? {} : { mode }),
      ...(sessionLimit === undefined ? {} : { sessionLimit }),
      ...(trackingLimit === undefined ? {} : { trackingLimit }),
    });
  } catch (error) {
    // A half-built assembly must not leak: close the client and the database handle, then rethrow
    // with the original error. Nothing here converts a failure into a partial success.
    if (approvalClient !== null) observe(approvalClient.close());
    try { store.close(); } catch { /* already closed */ }
    throw error;
  }

  /**
   * Report what was ACTUALLY assembled. Facts only: no token, no origin-secret, no "healthy" claim.
   *
   * `unwired` is the part every reader needs and nobody likes to write down: the capabilities this
   * assembly deliberately does NOT have.
   */
  function describe() {
    return Object.freeze({
      stateFile: file,
      // A2：库内身份绑定的结果。`initialized`/`kept` 表示可用；`conflict`/`failed` 表示库里的
      // botQq/selfId 与装配配置不一致（**库未被改动**），此时健康探测会拒绝运行。
      identityBinding,
      // M1：`state.outcomes` 的初始化结果（G1 结算的硬前置）。
      //   `initialized` 本轮补上了 {}；`kept` 本来就有且是普通对象（**一个字节都没改**）；
      //   `corrupt` 有但类型损坏（null / 数组 / 原始值）—— **未覆盖**，库保持原样，结算会拒绝；
      //   `failed` store.update 本身抛了（detail 里是原因）。只有 initialized/kept 是可结算状态。
      outcomesInit,
      sourceEpoch: epoch,
      connectionEpoch: startEpoch,
      mode: mode === undefined ? 'read-only' : mode,
      writeActions: Object.freeze([...actions]),
      // Sink locations, so "where would a row be" is answerable without guessing.
      auditSinks: Object.freeze({ dispatch: 'state.audit', write: 'state.writeAudit' }),
      // WHICH approval policy is in force, and the fact that the B2 claim survived it. Both are
      // facts an operator needs to read a refusal correctly: "auto-approved but quota-exhausted"
      // is a different incident from "waiting for a human".
      approvalPolicy: approval === undefined ? 'auto-approve' : 'ipc-channel',
      replayStore: 'store',
      // C16/t31: the one-time permit is RETIRED, so this field reports an OBSERVATION, not a mode.
      // `ignored` is the normal state now; the other two exist so an operator reading a config with a
      // stale `writePermitChannel` can see that it was seen and deliberately not used.
      writePermit: permitRequested
        ? 'ignored: a permit option was supplied but the permit mechanism is retired with the approval channel; every write goes straight to the write path (quota / interval / dedupe / origin / B2 still apply)'
        : 'retired: no permit is issued or spent anywhere on this path (the approval channel it belonged to is gone)',
      unwired: Object.freeze([
        // ⚠️ THIS LINE USED TO SAY THE OPPOSITE. It claimed the bridge answers 403
        // `write-channel-not-wired`, which was true when it was written and stopped being true
        // when `qzone.writeAdmit.enabled` opened the endpoint. An operator reading `describe()` to
        // understand a refusal was being told the channel was closed while it was open — worse than
        // no note at all. State the CURRENT contract and point at the switch that decides it.
        'bridge write channel: OPEN when config.qzone.writeAdmit.enabled is true (the bridge then forwards send_qzone_msg/comment_qzone/like_qzone after its own action/digest checks); CLOSED and answering 403 write-channel-not-wired when that flag is absent',
        'write permit: RETIRED with the approval channel. No permit is issued or spent on this path; a write is constrained by the tool gate, mode, origin ledger/binding, the daily quota + minimum interval reserved in one transaction, and the B2 replay claim. Consequence stated plainly: a holder of the bridge forward token can ask the bridge to write directly.',
        'business action into send(): the two approved-write compositions still call send(payload) without dispatch.action; this assembly then derives it from the write contract\'s own reply/comment discriminator (comment_id + comment_uin) — lossless today, but a composition that passes dispatch.action is strictly better and is the intended end state (C6 task B)',
        approval === undefined
          ? 'approval: AUTO-APPROVE policy (no human sign-off, by operator ruling); interval/daily-quota/tool-gate/origin-binding/B2 all still enforced'
          : 'approval: the bridge-side createQzoneApprovalIpcServer must be running and reachable at the configured origin; otherwise every approved operation refuses (client answers false)',
        'source provenance: only a ledger fed by real DSH host events (agent/pre-step + session/event tool/call) can consume; this assembly mints none',
        'write audit: rows land in the plugin SQLite (state.writeAudit), not in the bridge console database',
      ]),
      tornDown,
    });
  }

  /** Idempotent teardown: runtime ledgers, approval sockets, then the database handle. */
  async function teardown() {
    if (tornDown) return false;
    tornDown = true;
    try { runtime.teardown(); } catch { /* latched ledgers cannot throw */ }
    // C14: there may be NO client (auto-approve policy), so this is guarded rather than relying on
    // the surrounding catch to absorb a TypeError.
    if (approvalClient !== null) {
      try { await approvalClient.close(); } catch { /* aborting sockets cannot throw */ }
    }
    // C16/t31: no permit client is built any more, so there is nothing to close here. An injected
    // `writePermit` client (tests, or a host that still owns one) is the CALLER's object and was
    // never opened by this assembly — closing it would close something this module did not open.
    try { store.close(); } catch { /* already closed */ }
    return true;
  }

  return Object.freeze({
    runtime, store, transport, teardown, describe,
    // C13: passed through untouched. This module never reads it — it has no handle, so it cannot
    // register anything; `apply()` starts the listener after the handle exists.
    sourceRegister,
  });
}
