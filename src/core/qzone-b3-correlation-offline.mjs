// B3 sample: trusted-side correlation table + explicit FAKE target/action policy.
//
// What this module is
// -------------------
// The host contract (measured, see qzone-b3-metadata-channel-probe.mjs) leaves no slot for a
// custom proof field inside `MessageSource`: it is a closed union of 24 keys, and
// `sessions.prompt` CONSTRUCTS `source` server-side, so a client cannot set it at all. The
// only QQ-inbound carrier is `rpcId`.
//
// So instead of shipping a proof blob through the prompt, the trusted side keeps a table:
//
//     requestId -> { accountId, sourceKind, sourceId, sourceMessageId, issuedAt, expiresAt,
//                    allowedActions[], targetScope }
//
// written when the trusted side sees a real inbound event, and consulted when a tool call
// arrives.
//
// rpcId IS A LOOKUP KEY, NOT A PER-CALL PROOF
// -------------------------------------------
// This is the single most important sentence in this file. The table can say "this requestId
// came from group 105 at 23:01". It CANNOT say "this particular tool call really happened in
// DSH". Any process that can observe or self-report a requestId can reuse it with a brand-new
// callId, a different target, or a different action (within the allowed set). That is B3-11 /
// B3-12 and this module does not close it.
//
// What it DOES buy: the trusted side no longer needs to receive a proof blob through a channel
// that has no slot for one, and a forged call must at least present a requestId the trusted
// side actually issued for a real event.
//
// The policy here is EXPLICITLY FAKE
// ----------------------------------
// `targetScope` rules are sample fixtures, not product authorisation. Do not read them as the
// real permission model. Notably: a QQ group id is NOT a QZone target uin, and a real message
// id is not authorisation to read anybody's QZone.

/** Refusal reasons. Every one of them means "do not execute". */
export const CORRELATION_REFUSAL = Object.freeze({
  UNKNOWN_REQUEST: 'unknown-request',
  EXPIRED: 'request-expired',
  ACCOUNT_MISMATCH: 'account-mismatch',
  ACTION_NOT_ALLOWED: 'action-not-allowed',
  TARGET_OUT_OF_SCOPE: 'target-out-of-scope',
  TARGET_UNEXPECTED: 'target-unexpected',
  NOT_YET_VALID: 'request-not-yet-valid',
  OWNERSHIP_MISMATCH: 'ownership-mismatch',
  OWNERSHIP_UNKNOWN: 'ownership-unknown',
  TARGET_MISSING: 'target-missing',
  TARGET_MALFORMED: 'target-malformed',
  REQUESTID_INVALID: 'requestid-invalid',
  CLOCK_INVALID: 'clock-invalid',
  POLICY_MALFORMED: 'policy-malformed',
  CONTRACT_INVALID: 'contract-invalid',
  AUTHOR_MISMATCH: 'author-mismatch',
  AUTHOR_UNKNOWN: 'author-unknown',
  REPLY_SELECTION_UNKNOWN: 'reply-selection-unknown',
  REPLY_TARGET_MISSING: 'reply-target-missing',
});

// `reason` is written LAST so an `extra` field named `reason` can never silently overwrite
// the refusal code. Measured: passing { reason: 'author-unknown' } as detail turned an
// 'author-mismatch' refusal into 'author-unknown' — exactly the kind of quiet
// reclassification that makes an audit trail lie.
const refusal = (reason, extra) => Object.freeze({ ok: false, ...extra, reason });

/** requestId charset. Rejects control characters so a table key can never alias. */
const REQUEST_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const QQ_RE = /^[1-9][0-9]{4,11}$/;

/**
 * FAKE policy fixtures. Each entry maps an action to how its target is read and what the
 * sample considers in-scope. These are sample rules for tests, NOT the product's rules.
 *
 * `targetField` mirrors the real contract in `src/core/qzone-mcp-contract.mjs`:
 *   read_posts{target_uin}, read_comments{tid,target_uin}, comment{tid,target_uin,content},
 *   like{tid,target_uin}, reply{tid,target_uin,content,comment_id,comment_uin},
 *   publish{target_uins[]}
 */
export const FAKE_ACTION_POLICY = Object.freeze({
  read_posts: Object.freeze({ targetField: 'target_uin', kind: 'uin' }),
  read_comments: Object.freeze({ targetField: 'target_uin', kind: 'uin', alsoRequires: ['tid'] }),
  comment: Object.freeze({ targetField: 'target_uin', kind: 'uin', alsoRequires: ['tid', 'content'] }),
  like: Object.freeze({ targetField: 'target_uin', kind: 'uin', alsoRequires: ['tid'] }),
  reply: Object.freeze({ targetField: 'target_uin', kind: 'uin', alsoRequires: ['tid', 'content', 'comment_id', 'comment_uin'] }),

  // `publish` is NOT "target_uins[]". Measured against the real contract
  // (src/core/qzone-mcp-contract.mjs:20-42):
  //
  //   required always            : content, ugc_right
  //   target_uins required       : ONLY when ugc_right is 16 or 128
  //   target_uins FORBIDDEN      : otherwise (the schema's `else: { not: { required: [...] } }`)
  //
  // So a visibility of 1 (public-to-self) is contract-valid with NO target at all, and adding
  // target_uins there is contract-INVALID. The previous version of this fixture treated
  // publish as always requiring a target list, which disagreed with the contract in BOTH
  // directions (measured). Visibility semantics are modelled separately below.
  publish: Object.freeze({
    kind: 'publish',
    ugcRightField: 'ugc_right',
    targetField: 'target_uins',
    // ugc_right values that select named recipients rather than an implicit audience.
    recipientVisibility: Object.freeze([16, 128]),
    requiredAlways: Object.freeze(['content', 'ugc_right']),
  }),
});

/**
 * FAKE ownership map: tid -> the uin that owns that post, and tid -> set of comment ids known
 * to belong to it.
 *
 * The real system would have to obtain this from the platform (a read) or from the original
 * event. This fixture exists ONLY so the sample can express "the post you are commenting on
 * belongs to the uin you claim to be authorised for", which the previous version could not
 * check at all (it only tested field presence).
 *
 * It is sample data. It is NOT a product authorisation rule, and it is NOT evidence that
 * anything was fetched from QZone.
 */
export function createFakeOwnershipMap(entries = {}) {
  const posts = new Map();
  for (const [tid, { ownerUin, commentIds = [], commentAuthors = {}, replyTargets = {} }] of Object.entries(entries)) {
    posts.set(String(tid), Object.freeze({
      ownerUin: String(ownerUin),
      commentIds: Object.freeze(commentIds.map(String)),
      // commentId -> author uin. Being able to NAME a comment is not knowing who wrote it.
      commentAuthors: Object.freeze(
        Object.fromEntries(Object.entries(commentAuthors).map(([cid, uin]) => [String(cid), String(uin)])),
      ),
      // commentId -> { replyUin, replyName }. DELIBERATELY a separate identity from the comment
      // author: replying to a comment often addresses a different person than the one who wrote
      // it. This mirrors the existing offline model (qzone-bound-write-simulation-offline.mjs
      // `matchesReplyEvidence` keeps evidence.commentUin and evidence.replyUin/replyName apart).
      replyTargets: Object.freeze(
        Object.fromEntries(Object.entries(replyTargets).map(([cid, t]) => [
          String(cid),
          Object.freeze({ replyUin: t.replyUin === null ? null : String(t.replyUin), replyName: t.replyName ?? null }),
        ])),
      ),
    }));
  }
  return Object.freeze({
    ownerOf(tid) { return posts.get(String(tid))?.ownerUin ?? null; },
    knowsComment(tid, commentId) { return posts.get(String(tid))?.commentIds.includes(String(commentId)) ?? false; },
    /** Author of the comment being replied to (null when unknown). */
    authorOf(tid, commentId) { return posts.get(String(tid))?.commentAuthors?.[String(commentId)] ?? null; },
    /**
     * Who the reply addresses, and the display name asserted for them.
     * Returns null when the map has NO evidence for this comment.
     */
    replyTargetOf(tid, commentId) { return posts.get(String(tid))?.replyTargets?.[String(commentId)] ?? null; },
    has(tid) { return posts.has(String(tid)); },
  });
}

/**
 * Target scopes the sample understands. Deliberately small and unrelated to product rules.
 *
 *   self        : only the bot's own uin
 *   uin:<n>     : exactly that uin
 *   empty       : nothing (the request authorises no QZone target at all)
 */
export function createTargetScope(scope) {
  if (scope === 'empty') return Object.freeze({ kind: 'empty', allows: () => false });

  // Compare as STRINGS on purpose. `target_uin` reaches this module from JSON/tool input as a
  // string, while `selfUin` is a number. A strict `===` compares 111 !== '111' and silently
  // rejects every legitimate self-read (measured: 7 failing cases). The normalisation happens
  // here, at the boundary, and nowhere else.
  if (scope === 'self') {
    return Object.freeze({ kind: 'self', allows: (uin, selfUin) => String(uin) === String(selfUin) });
  }

  const m = /^uin:([1-9][0-9]{4,11})$/.exec(String(scope ?? ''));
  if (m) {
    const only = m[1];
    return Object.freeze({ kind: 'uin', allows: (uin) => String(uin) === only });
  }

  return null;   // unknown scope -> caller treats as malformed policy
}

export function createCorrelationTable({ selfUin, clock, ownership, contractValidator } = {}) {
  if (!Number.isSafeInteger(selfUin) || selfUin <= 0) throw new TypeError('table needs a positive selfUin');
  if (typeof clock !== 'function') throw new TypeError('table needs a clock()');

  /** requestId -> frozen record */
  const records = new Map();

  return Object.freeze({
    /** Diagnostic: is a tid known to the fake ownership map? */
    ownershipKnown(tid) { return ownership?.has(tid) ?? false; },

    /** Diagnostic: who owns a tid in the fake ownership map? */
    ownershipOwner(tid) { return ownership?.ownerOf(tid) ?? null; },

    /**
     * Record ONE real inbound event. Called by the trusted side only, at the moment it sees
     * the event — not by anything the model or the untrusted side controls.
     */
    record({ requestId, accountId, sourceKind, sourceId, sourceMessageId, issuedAt, ttlMs, allowedActions, targetScope, selectedReply, replySelections } = {}) {
      if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
        throw new TypeError('record needs a valid requestId');
      }
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('record needs a positive accountId');
      if (typeof sourceKind !== 'string' || !sourceKind) throw new TypeError('record needs sourceKind');
      if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('record needs sourceId');
      if (typeof sourceMessageId !== 'string' || !sourceMessageId) throw new TypeError('record needs sourceMessageId');
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError('record needs issuedAt');
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('record needs a positive ttlMs');
      // Reject a window that overflows the safe-integer range rather than silently wrapping to
      // a negative interval (which would make the request permanently expired or never).
      if (!Number.isSafeInteger(issuedAt + ttlMs)) {
        throw new TypeError('record window overflows Number.MAX_SAFE_INTEGER');
      }
      if (!Array.isArray(allowedActions) || allowedActions.length === 0) {
        throw new TypeError('record needs a non-empty allowedActions list');
      }
      for (const action of allowedActions) {
        if (typeof action !== 'string' || !Object.hasOwn(FAKE_ACTION_POLICY, action)) {
          throw new TypeError(`unknown action in allowedActions: ${String(action)}`);
        }
      }
      const scope = createTargetScope(targetScope);
      if (scope === null) throw new TypeError(`unknown targetScope: ${String(targetScope)}`);

      // First record wins: re-recording the same requestId must not widen its permissions.
      if (records.has(requestId)) return Object.freeze({ ok: false, reason: 'already-recorded' });

      // ── reply selection evidence ──────────────────────────────────────────────────
      //
      // SCOPE, stated plainly because the old naming was wrong: `selectedReply` is recorded per
      // REQUEST. It is a REQUEST-LEVEL FIXED SELECTION under a single-selection assumption, not
      // per-call evidence. Measured consequence: a second legitimate call in the same request
      // that selects a different reply target is wrongly refused.
      //
      // `replySelections` is the general form: a FINITE ARRAY of the selections the trusted
      // side is willing to allow for this request. A call must name one of them. Two calls in the
      // same request may name different candidates and both pass.
      //
      // NO LENGTH CAP is enforced here — do not describe this as "bounded". Adding a cap would be
      // a product-behaviour change and needs its own justification.
      //
      // NOT CONSUMED HERE, and deliberately NOT folded into B2's unique key. The user-accepted B2
      // guarantee is "the same (account, session, request, call) executes at most once, even if the
      // content or the selection differs". Mixing `selection` into that key would mint a NEW key
      // when only the selection changes and would let the same call run again — re-opening exactly
      // the replay B2 exists to prevent. If a future requirement needs "each candidate usable once",
      // that must be a SEPARATE constraint inside the trusted boundary, with its own authorisation,
      // failure and concurrency argument.
      //
      // Three states, none of which may be collapsed into another:
      //   undefined      -> no reply-selection evidence for this request at all  (fail closed)
      //   []             -> this request explicitly has NO reply target (direct reply to the
      //                     parent comment); supplying a reply target is refused
      //   [ {replyUin, replyName}, ... ] -> candidate set; the call must name exactly one
      let normalizedSelections;
      const selectionsInput = replySelections !== undefined
        ? replySelections
        : (selectedReply === undefined ? undefined : (selectedReply === null ? [] : [selectedReply]));

      if (selectionsInput === undefined) {
        normalizedSelections = undefined;
      } else if (!Array.isArray(selectionsInput)) {
        throw new TypeError('replySelections must be an array (or selectedReply as a shortcut)');
      } else {
        normalizedSelections = Object.freeze(selectionsInput.map((sel) => {
          if (!sel || typeof sel !== 'object') throw new TypeError('each reply selection must be an object');
          const ru = sel.replyUin;
          if (!Number.isSafeInteger(ru) && typeof ru !== 'string') throw new TypeError('reply selection needs replyUin');
          return Object.freeze({
            replyUin: String(ru),
            replyName: typeof sel.replyName === 'string' ? sel.replyName : null,
          });
        }));
      }

      // First record wins: re-recording the same requestId must not widen its permissions.
      if (records.has(requestId)) return Object.freeze({ ok: false, reason: 'already-recorded' });

      records.set(requestId, Object.freeze({
        requestId, accountId, sourceKind, sourceId, sourceMessageId,
        issuedAt, expiresAt: issuedAt + ttlMs,
        allowedActions: Object.freeze([...allowedActions]),
        targetScope, scopeObject: scope,
        replySelections: normalizedSelections,
      }));
      return Object.freeze({ ok: true });
    },

    /** Diagnostic only. */
    size() { return records.size; },
    peek(requestId) { return records.get(requestId); },

    /**
     * Authorise ONE tool call against the table and the FAKE policy.
     *
     * @returns {ok:true} | {ok:false, reason}
     *
     * Order matters: requestId -> expiry -> account -> action -> target. A caller that fails an
     * earlier gate learns nothing about the later ones.
     */
    authorize({ requestId, accountId, action, input } = {}) {
      if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
        return refusal(CORRELATION_REFUSAL.REQUESTID_INVALID);
      }
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) return refusal(CORRELATION_REFUSAL.CLOCK_INVALID);

      const record = records.get(requestId);
      if (!record) return refusal(CORRELATION_REFUSAL.UNKNOWN_REQUEST);
      if (now >= record.expiresAt) return refusal(CORRELATION_REFUSAL.EXPIRED);
      // Not-yet-valid boundary. Codex measured: with clock=10, issuedAt=100, the request was
      // accepted because only `now >= expiresAt` was checked.
      if (now < record.issuedAt) return refusal(CORRELATION_REFUSAL.NOT_YET_VALID, { issuedAt: record.issuedAt });
      if (record.accountId !== accountId) return refusal(CORRELATION_REFUSAL.ACCOUNT_MISMATCH);

      if (!record.allowedActions.includes(action)) {
        return refusal(CORRELATION_REFUSAL.ACTION_NOT_ALLOWED, { allowed: record.allowedActions });
      }

      const policy = FAKE_ACTION_POLICY[action];
      if (!policy) return refusal(CORRELATION_REFUSAL.POLICY_MALFORMED);

      // Business-contract shape check, when the caller injects the real validator.
      //
      // Without this, the sample accepted shapes the MCP contract rejects — measured:
      //   publish {content:' ', ugc_right:1}  -> contract invalid, policy ok
      //   read_posts {target_uin:12345, unexpected:true} -> contract invalid (policy happened
      //     to refuse it for a different reason, which is not the same as checking the shape)
      //
      // A shape check is NOT authorisation: passing it means 'this looks like a legal call',
      // not 'this call is permitted'. Both checks must run.
      if (contractValidator !== undefined) {
        if (typeof contractValidator !== 'function') return refusal(CORRELATION_REFUSAL.POLICY_MALFORMED);
        let shapeOk = false;
        try { shapeOk = contractValidator(action, input) === true; } catch { shapeOk = false; }
        if (!shapeOk) return refusal(CORRELATION_REFUSAL.CONTRACT_INVALID);
      }

      // Required companion fields must be present.
      for (const field of policy.alsoRequires ?? []) {
        if (input?.[field] === undefined || input?.[field] === null || input?.[field] === '') {
          return refusal(CORRELATION_REFUSAL.TARGET_MISSING, { field });
        }
      }

      // ── publish: visibility decides whether a target list is required or forbidden ──
      //
      // This mirrors the real contract instead of assuming "publish needs target_uins".
      if (policy.kind === 'publish') {
        for (const field of policy.requiredAlways) {
          if (input?.[field] === undefined || input?.[field] === null || input?.[field] === '') {
            return refusal(CORRELATION_REFUSAL.TARGET_MISSING, { field });
          }
        }
        const right = input[policy.ugcRightField];
        if (!Number.isInteger(right) || ![1, 4, 16, 64, 128].includes(right)) {
          return refusal(CORRELATION_REFUSAL.TARGET_MALFORMED, { field: policy.ugcRightField });
        }
        const needsRecipients = policy.recipientVisibility.includes(right);
        const hasTargets = input[policy.targetField] !== undefined && input[policy.targetField] !== null;
        if (needsRecipients && !hasTargets) {
          return refusal(CORRELATION_REFUSAL.TARGET_MISSING, { field: policy.targetField, ugc_right: right });
        }
        if (!needsRecipients && hasTargets) {
          // The contract FORBIDS target_uins for these visibilities; sending them is invalid.
          return refusal(CORRELATION_REFUSAL.TARGET_UNEXPECTED, { field: policy.targetField, ugc_right: right });
        }
        if (!needsRecipients) {
          // Implicit audience: the sample cannot scope it by target, so it falls back to the
          // request's own target scope rule only when the scope is 'self' or 'empty'.
          if (record.targetScope !== 'self') {
            return refusal(CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE, { scope: record.targetScope, ugc_right: right });
          }
          return Object.freeze({ ok: true, requestId, action, visibility: right, targets: null });
        }
        // Needs recipients -> fall through to the uin-list branch below.
      }

      // ── association check against the FAKE evidence map ────────────────────────────
      //
      // Presence is not ownership, and "who wrote the comment" is NOT "who is being replied to".
      // The existing offline model (qzone-bound-write-simulation-offline.mjs
      // `matchesReplyEvidence`) keeps them as two identities; this sample now does the same:
      //
      //   comment_uin           must equal the known author of comment_id
      //   reply_uin + reply_name  must equal the known reply target for comment_id,
      //                           and when the map says there is no reply target, supplying one
      //                           is a mismatch; when evidence is missing entirely -> fail closed
      //
      // With no map injected nothing here runs, and the caller must not claim it did.
      if (ownership && typeof input?.tid === 'string') {
        const owner = ownership.ownerOf(input.tid);
        if (owner === null) return refusal(CORRELATION_REFUSAL.OWNERSHIP_UNKNOWN, { tid: input.tid });
        const claimed = String(input[policy.targetField] ?? '');
        if (owner !== claimed) {
          return refusal(CORRELATION_REFUSAL.OWNERSHIP_MISMATCH, { tid: input.tid, owner, claimed });
        }

        if (input.comment_id !== undefined) {
          if (!ownership.knowsComment(input.tid, input.comment_id)) {
            return refusal(CORRELATION_REFUSAL.OWNERSHIP_MISMATCH, { tid: input.tid, commentId: input.comment_id });
          }

          // (a) comment author
          if (input.comment_uin !== undefined) {
            const knownAuthor = ownership.authorOf(input.tid, input.comment_id);
            if (knownAuthor === null) {
              // Distinct, STABLE code: "we do not know" is a different fact from "it disagrees".
              return refusal(CORRELATION_REFUSAL.AUTHOR_UNKNOWN, { tid: input.tid, commentId: input.comment_id, field: 'comment_uin' });
            }
            if (String(input.comment_uin) !== knownAuthor) {
              return refusal(CORRELATION_REFUSAL.AUTHOR_MISMATCH, { field: 'comment_uin', declared: String(input.comment_uin), known: knownAuthor });
            }
          }

          // (b) reply target — a DIFFERENT identity from the comment author.
          //
          // EVIDENCE SCOPE — read this before quoting the code: the selections are recorded per
          // REQUEST as a finite candidate array. A call asserts WHICH candidate it selected; B can
          // only check that the named candidate was offered. It cannot check that the call really
          // happened in DSH. It also does not consume a candidate, and it does NOT extend B2's
          // unique key with the selection — see the note in `record` for why that would be wrong.
          //
          // The post-level cache in `ownership.replyTargets` is informational and must NOT
          // authorise, or "a target exists somewhere" would be confused with "this call selected
          // it" (measured gap).
          const suppliesReply = input.reply_uin !== undefined || input.reply_name !== undefined;
          const selections = record.replySelections;   // undefined | [] | [{replyUin, replyName}]

          if (selections === undefined) {
            // No reply-selection evidence at all for this request: refuse to judge.
            return refusal(CORRELATION_REFUSAL.REPLY_SELECTION_UNKNOWN, {
              tid: input.tid, commentId: input.comment_id,
              note: 'no reply-selection evidence for this request',
            });
          }

          if (selections.length === 0) {
            // Evidence says this request has NO reply target: direct reply to the parent comment.
            if (suppliesReply) {
              return refusal(CORRELATION_REFUSAL.REPLY_TARGET_MISSING, {
                field: input.reply_uin !== undefined ? 'reply_uin' : 'reply_name',
                reason: 'evidence-says-no-reply-target',
              });
            }
          } else {
            // Candidate set: the call must name exactly one of the offered selections.
            if (input.reply_uin === undefined) {
              return refusal(CORRELATION_REFUSAL.REPLY_TARGET_MISSING, {
                field: 'reply_uin',
                candidates: selections.map((s) => s.replyUin),
                reason: 'call-omits-its-selected-target',
              });
            }
            const declaredUin = String(input.reply_uin);
            const matched = selections.find((s) => s.replyUin === declaredUin);
            if (matched === undefined) {
              return refusal(CORRELATION_REFUSAL.AUTHOR_MISMATCH, {
                field: 'reply_uin', declared: declaredUin,
                candidates: selections.map((s) => s.replyUin),
                reason: 'not-an-offered-selection',
              });
            }
            if (matched.replyName !== null && input.reply_name !== matched.replyName) {
              return refusal(CORRELATION_REFUSAL.AUTHOR_MISMATCH, {
                field: 'reply_name', declared: input.reply_name ?? null, known: matched.replyName,
              });
            }
          }
        }
      }

      const raw = input?.[policy.targetField];
      // Empty string counts as MISSING, consistent with the companion-field check above.
      if (raw === undefined || raw === null || raw === '') {
        return refusal(CORRELATION_REFUSAL.TARGET_MISSING, { field: policy.targetField });
      }

      if (policy.kind === 'uin') {
        const uin = String(raw);
        if (!QQ_RE.test(uin)) return refusal(CORRELATION_REFUSAL.TARGET_MALFORMED, { field: policy.targetField });
        if (!record.scopeObject.allows(uin, selfUin)) {
          return refusal(CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE, { target: uin, scope: record.targetScope });
        }
        return Object.freeze({ ok: true, requestId, action, target: uin });
      }

      // publish with named recipients uses the same list semantics as an explicit uin list.
      if (policy.kind === 'uin-list' || (policy.kind === 'publish' && policy.recipientVisibility.includes(input?.[policy.ugcRightField]))) {
        if (!Array.isArray(raw) || raw.length === 0) {
          return refusal(CORRELATION_REFUSAL.TARGET_MALFORMED, { field: policy.targetField });
        }
        const list = raw.map((x) => String(x));
        for (const uin of list) {
          if (!QQ_RE.test(uin)) return refusal(CORRELATION_REFUSAL.TARGET_MALFORMED, { field: policy.targetField });
          if (!record.scopeObject.allows(uin, selfUin)) {
            return refusal(CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE, { target: uin, scope: record.targetScope });
          }
        }
        return Object.freeze({ ok: true, requestId, action, targets: Object.freeze(list) });
      }

      return refusal(CORRELATION_REFUSAL.POLICY_MALFORMED);
    },
  });
}
