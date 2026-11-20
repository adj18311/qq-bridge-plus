// Offline-only policy primitives. These functions perform no I/O and grant no
// platform access; integration must provide persistence and concurrency guards.
const OFFSET_MS = 8 * 60 * 60 * 1000;
const OUTCOMES = new Set(['success', 'failure', 'not_accessible', 'login_expired', 'captcha', 'network_unavailable']);
const IMMEDIATE_PAUSE = new Set(['login_expired', 'captcha', 'network_unavailable']);

export function beijingDay(timestamp) {
  if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be finite');
  const date = new Date(timestamp + OFFSET_MS);
  if (!Number.isFinite(date.getTime())) throw new RangeError('timestamp out of range');
  return date.toISOString().slice(0, 10);
}

export function checkDailyLimit(used, limit) {
  if (!Number.isSafeInteger(used) || used < 0) throw new RangeError('invalid used count');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 99) throw new RangeError('invalid daily limit');
  return used < limit;
}

export function nextFailureState(state, direction, outcome) {
  if (!state || !['read', 'write'].includes(direction) || !OUTCOMES.has(outcome)) {
    throw new TypeError('invalid failure transition');
  }
  if (!Number.isSafeInteger(state.reads) || state.reads < 0 ||
      !Number.isSafeInteger(state.writes) || state.writes < 0 ||
      typeof state.accessPaused !== 'boolean' || typeof state.writePaused !== 'boolean') {
    throw new TypeError('invalid failure state');
  }
  const next = { ...state };
  const key = direction === 'read' ? 'reads' : 'writes';
  if (outcome === 'success') next[key] = 0;
  else if (outcome === 'failure') {
    next[key] = Math.min(3, next[key] + 1);
    if (next[key] === 3) next[direction === 'read' ? 'accessPaused' : 'writePaused'] = true;
  } else if (IMMEDIATE_PAUSE.has(outcome)) next.accessPaused = true;
  return next;
}

// scope must come from trusted authorization, not model-provided assertions.
// This helper only filters an already obtained post; it does not authorize fetch.
export function canReadPost(post, scope) {
  if (!post || !scope || typeof scope.author !== 'string' || !scope.author ||
      typeof post.author !== 'string' || post.author !== scope.author ||
      typeof post.id !== 'string' || !post.id || !Number.isFinite(scope.now)) return false;
  // ⚠️ THERE IS NO `admin` BYPASS (t47, operator decision). It used to be:
  //     if (scope.admin === true) return true;
  // i.e. "an administrator may read anyone's entire history". The operator cancelled that design:
  // NOBODY reads past the seven-day window, and the only two ways past it are the narrow
  // exceptions below — an explicitly shared post, and an explicit own-history grant.
  // A scope that still carries `admin: true` therefore buys nothing: the field is not read here
  // any more, so the next line decides, and `friend` scopes still hit the window at the bottom.
  if (typeof scope.sharedPostId === 'string' && scope.sharedPostId && post.id === scope.sharedPostId) return true;
  if (scope.friend !== true || !Number.isFinite(post.time)) return false;
  return post.time <= scope.now && post.time >= scope.now - 7 * 86400000;
}

// Offline filtering does not prove the upstream request avoided retrieving
// unrelated records, and must occur before logging or returning a response.
export function filterOfflinePosts(posts, scope) {
  if (!Array.isArray(posts)) throw new TypeError('posts must be an array');
  return posts.filter((post) => canReadPost(post, scope)).map((post) => ({
    author: post.author, id: post.id, time: Number.isFinite(post.time) ? post.time : null,
    ...(typeof post.content === 'string' ? { content: post.content } : {}),
  }));
}

export function checkInterval(lastAt, now, intervalMs) {
  if (!Number.isFinite(now) || !Number.isFinite(intervalMs) || intervalMs < 0 ||
      (lastAt !== null && !Number.isFinite(lastAt))) throw new TypeError('invalid interval');
  return lastAt === null || (now >= lastAt && now - lastAt >= intervalMs);
}

export function wasLiked(likes, author, id) {
  if (!Array.isArray(likes) || typeof author !== 'string' || !author ||
      typeof id !== 'string' || !id) throw new TypeError('invalid like identity');
  if (likes.some((x) => !x || typeof x.author !== 'string' || !x.author ||
      typeof x.id !== 'string' || !x.id)) throw new TypeError('invalid like state');
  return likes.some((x) => x.author === author && x.id === id);
}

const WRITE_KINDS = ['post', 'comment', 'like'];

function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function checkLedger(state) {
  if (!state || !validDay(state.day) || !state.used || !state.reservations ||
      Array.isArray(state.reservations) || typeof state.reservations !== 'object' ||
      WRITE_KINDS.some((key) => !Number.isSafeInteger(state.used[key]) || state.used[key] < 0) ||
      Object.values(state.reservations).some((kind) => !WRITE_KINDS.includes(kind))) {
    throw new TypeError('invalid quota state');
  }
}

// Pure state transition only: caller must serialize, persist atomically before
// dispatch, and fail closed on persistence errors. Unknown outcomes never refund.
export function reserveWrite(state, { day, kind, limit, id } = {}) {
  checkLedger(state);
  if (!validDay(day) || day < state.day || !WRITE_KINDS.includes(kind) ||
      typeof id !== 'string' || !id || id.length > 128 ||
      ['__proto__', 'constructor', 'prototype'].includes(id)) throw new TypeError('invalid reservation');
  checkDailyLimit(0, limit);
  const next = { ...state, used: day === state.day ? { ...state.used } : { post: 0, comment: 0, like: 0 },
    reservations: { ...state.reservations }, day };
  if (Object.hasOwn(next.reservations, id)) return { allowed: false, reason: 'duplicate', state: next };
  if (!checkDailyLimit(next.used[kind], limit)) return { allowed: false, reason: 'limit', state: next };
  next.used[kind]++;
  next.reservations[id] = kind;
  return { allowed: true, state: next };
}

export function resetDailyCounter(state, kind) {
  checkLedger(state);
  if (!WRITE_KINDS.includes(kind)) throw new TypeError('invalid quota kind');
  return { ...state, used: { ...state.used, [kind]: 0 }, reservations: { ...state.reservations } };
}

function checkProbeState(state) {
  if (!state || typeof state.accessPaused !== 'boolean' || typeof state.writePaused !== 'boolean' ||
      !Number.isFinite(state.pausedAt) || !['waiting', 'claimed', 'manual_only', 'done'].includes(state.probe)) {
    throw new TypeError('invalid recovery probe state');
  }
}

// The caller must persist the claim before issuing a probe. A claimed probe
// left unresolved by a crash must not be reissued automatically.
export function claimRecoveryProbe(state, options = {}) {
  checkProbeState(state);
  if (!Number.isFinite(options.now)) throw new TypeError('invalid clock');
  const claimed = state.accessPaused && state.probe === 'waiting' && options.enabled === true &&
    options.serviceReady === true && options.activeTime === true && options.now >= state.pausedAt &&
    options.now - state.pausedAt >= 86400000;
  return { claimed, state: claimed ? { ...state, probe: 'claimed' } : { ...state } };
}

export function finishRecoveryProbe(state, outcome, { preserveWrite = false } = {}) {
  checkProbeState(state);
  if (!state.accessPaused || state.probe !== 'claimed' || !['success', 'failure', 'unknown'].includes(outcome)) {
    throw new TypeError('invalid recovery probe outcome');
  }
  if (state.pauseCycles !== undefined && (!state.pauseCycles || typeof state.pauseCycles !== 'object' || Array.isArray(state.pauseCycles))) {
    throw new TypeError('invalid pause cycles');
  }
  if (outcome !== 'success') return { ...state, probe: 'manual_only' };
  return { ...state, accessPaused: false, writePaused: preserveWrite ? state.writePaused : false, reads: 0,
    ...(state.pauseCycles === undefined ? {} : { pauseCycles: { ...state.pauseCycles, access: null, ...(preserveWrite ? {} : { write: null }) } }),
    ...(state.writePaused && !preserveWrite ? { writes: 0 } : {}), probe: 'done' };
}

// These gates must be enforced on each new call, not just tool registration.
export function authorizeOperation(context, direction) {
  if (!context || !['read', 'write'].includes(direction) ||
      ['enabled', 'readAllowed', 'writeAllowed', 'accessPaused', 'writePaused']
        .some((key) => typeof context[key] !== 'boolean')) return { allowed: false, reason: 'invalid' };
  if (!context.enabled) return { allowed: false, reason: 'disabled' };
  if (context.accessPaused) return { allowed: false, reason: 'access_paused' };
  if (direction === 'read' && !context.readAllowed) return { allowed: false, reason: 'permission' };
  if (direction === 'write' && (!context.writeAllowed || context.writePaused)) {
    return { allowed: false, reason: context.writePaused ? 'write_paused' : 'permission' };
  }
  return { allowed: true };
}

// Minutes in a Beijing day; equal boundaries are ambiguous and rejected.
export function isActiveTime(timestamp, start, end) {
  if (!Number.isFinite(timestamp) || !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || end < 0 || start >= 1440 || end >= 1440 || start === end) throw new TypeError('invalid active time');
  const date = new Date(timestamp + OFFSET_MS);
  if (!Number.isFinite(date.getTime())) throw new RangeError('timestamp out of range');
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// A budget decision is not a reservation; caller must atomically reserve before
// issuing a request. Explicit requests remain subject to content authorization.
export function checkBrowseBudget(state, source) {
  if (!state || !['proactive', 'requested'].includes(source) ||
      ['enabled', 'readAllowed', 'accessPaused', 'writePaused', 'activeTime'].some((key) => typeof state[key] !== 'boolean')) return { allowed: false, reason: 'invalid' };
  if (!state.enabled || !state.readAllowed || state.accessPaused) return { allowed: false, reason: 'blocked' };
  if (source === 'requested') return { allowed: true };
  if (!state.activeTime) return { allowed: false, reason: 'outside_active_time' };
  if (!Number.isFinite(state.now) || !Number.isSafeInteger(state.todayBrowses) || state.todayBrowses < 0 ||
      (state.lastBrowseAt !== null && !Number.isFinite(state.lastBrowseAt))) return { allowed: false, reason: 'invalid' };
  if (state.lastBrowseAt !== null && state.now < state.lastBrowseAt) return { allowed: false, reason: 'clock' };
  if (state.writePaused && (state.todayBrowses >= 3 || !checkInterval(state.lastBrowseAt, state.now, 3600000))) {
    return { allowed: false, reason: 'degraded_budget' };
  }
  return { allowed: true };
}

export function validatePatrolInterval(minutes) {
  return Number.isSafeInteger(minutes) && minutes >= 15;
}

// Returns a classification only; deleting files requires separate safe path,
// symlink, concurrency and audit handling.
export function auditRetentionDecision(name, now) {
  const today = beijingDay(now);
  if (typeof name !== 'string' || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) return 'ignore';
  const day = name.slice(0, 10);
  if (!validDay(day)) return 'ignore';
  if (day > today) return 'future';
  const difference = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000;
  return difference < 7 ? 'keep' : 'expired';
}

// Authentication, durable persistence and audit are mandatory at the caller.
export function manualRestore(state, layer) {
  if (!state || !['access', 'write', 'both'].includes(layer) ||
      typeof state.accessPaused !== 'boolean' || typeof state.writePaused !== 'boolean' ||
      !Number.isSafeInteger(state.reads) || state.reads < 0 ||
      !Number.isSafeInteger(state.writes) || state.writes < 0) throw new TypeError('invalid restore');
  const next = { ...state };
  if (state.pauseCycles !== undefined) {
    if (!state.pauseCycles || typeof state.pauseCycles !== 'object' || Array.isArray(state.pauseCycles)) throw new TypeError('invalid pause cycles');
    next.pauseCycles = { ...state.pauseCycles };
  }
  if (layer === 'access' || layer === 'both') {
    next.accessPaused = false;
    if (next.pauseCycles) next.pauseCycles.access = null;
    next.reads = 0;
    next.probe = 'done';
  }
  if (layer === 'write' || layer === 'both') {
    next.writePaused = false;
    if (next.pauseCycles) next.pauseCycles.write = null;
    next.writes = 0;
  }
  return next;
}

// Identities and the question identifier must come from a trusted QQ event.
// Consume atomically before the fetch; the caller enforces the question's
// narrower content scope and never exposes raw, unfiltered platform pages.
export function consumeHistoryGrant(grant, request) {
  const validText = (value) => typeof value === 'string' && value.trim().length > 0;
  if (!grant || !request || grant.status !== 'ready' ||
      !validText(grant.requester) || !validText(grant.author) || !validText(grant.question) ||
      grant.requester !== grant.author || request.requester !== grant.requester ||
      request.author !== grant.author || request.question !== grant.question ||
      !(grant.postId === null || validText(grant.postId)) || request.postId !== grant.postId) {
    return { allowed: false };
  }
  return { allowed: true, grant: { ...grant, status: 'consumed' } };
}

const TOOL_DIRECTIONS = Object.freeze({ read_posts: 'read', read_comments: 'read',
  publish: 'write', comment: 'write', reply: 'write', like: 'write' });

// Names are internal policy identifiers, not yet bound to MCP tool names.
export function authorizeTool(context, tool) {
  if (typeof tool !== 'string' || !Object.hasOwn(TOOL_DIRECTIONS, tool)) return { allowed: false, reason: 'invalid_tool' };
  const decision = authorizeOperation(context, TOOL_DIRECTIONS[tool]);
  if (!decision.allowed) return decision;
  if (!context.tools || !Object.hasOwn(context.tools, tool) || context.tools[tool] !== true) return { allowed: false, reason: 'tool_permission' };
  return { allowed: true };
}

// ── SHARED `resolvedBy` RULE (M8b/M1b) ──────────────────────────────────────────────────────
//
// WHY THIS LIVES IN `policy` AND NOT IN `audit`:
// `qzone-audit-offline.mjs` already imports from this module (`beijingDay`, `auditRetentionDecision`).
// Putting this validator in `audit` and importing it from here would create an import CYCLE, so the
// ONLY place a rule can be shared by both sides is a leaf module — this one. `audit` imports it,
// `policy` uses it directly, and there is exactly ONE implementation of the rule.
//
// WHY A SHARED RULE AT ALL: the gate decides "is this gap still blocking?", and `formatAuditGap`
// decides "may this resolvedBy be recorded at all?". If the two disagreed even slightly, an entry
// could be written that the gate would still treat as unresolved (or vice versa) — a gap that can
// never be cleared, or a cleared gap that still blocks. GR-11 pins that both sides agree.
//
// THE RULE IS A SHAPE RULE, NOT AN AUTHENTICATION. It answers "does this object have the right
// fields with the right types, and does it claim the SAME generation as the gap it resolves?".
// It does NOT answer "was the operator allowed to mark this resolved" — that is M9's controlled
// recovery transaction, which is the only thing permitted to write the marker and its management
// audit. A model-supplied claim must never be able to obtain recovery just by passing shape checks.

/** Field names a `resolvedBy` marker may carry. Nothing else is accepted. */
const RESOLVED_BY_FIELDS = Object.freeze(['generation', 'at', 'operator']);
// Same character set the audit module uses for safe ids. Duplicated here on purpose: this module is
// a leaf and must not import the audit module (see above). GR-11 keeps the two in step.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ID_SECRET = /sk-[A-Za-z0-9_-]{12,}/i;

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Is `value` a well-formed `resolvedBy` marker for a gap whose generation is `gapGeneration`?
 *
 * Accepts ONLY `{ generation, at, operator }` with:
 *   · `generation` a safe id that EQUALS `gapGeneration` (a marker for another generation must not
 *     clear this gap — that is how a stale/forged marker is kept from unblocking writes);
 *   · `at` a non-negative safe integer timestamp;
 *   · `operator` a safe id.
 *
 * Rejects: missing `at`/`operator` (the "only generation" shape), wrong types, extra fields, arrays
 * and primitives. A `null` marker is NOT resolved — absence of a marker means "still open".
 *
 * @returns {boolean} true only for an exact, generation-matching marker.
 */
export function isResolvedBy(value, gapGeneration) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== RESOLVED_BY_FIELDS.length) return false;
  for (let index = 0; index < RESOLVED_BY_FIELDS.length; index += 1) {
    if (keys[index] !== [...RESOLVED_BY_FIELDS].sort()[index]) return false;
  }
  const { generation, at, operator } = value;
  if (typeof generation !== 'string' || !SAFE_ID.test(generation) || SAFE_ID_SECRET.test(generation)) return false;
  if (generation !== gapGeneration) return false;
  if (!Number.isSafeInteger(at) || at < 0) return false;
  if (typeof operator !== 'string' || !SAFE_ID.test(operator) || SAFE_ID_SECRET.test(operator)) return false;
  return true;
}

// ── H3 write gate ────────────────────────────────────────────────────────────────────────────
//
// `checkWriteGate` answers exactly one question: **may a write be dispatched at all, given what we
// know about the state store's health?** It is deliberately NOT a second authorization check — the
// permission/master-switch questions stay in `authorizeOperation`/`authorizeTool`, and the generic
// pause questions stay in the breaker (`state.writePaused`). Overloading this function with those
// would make a "platform kept failing" pause indistinguishable from "we cannot write our own ledger",
// which are different incidents with different operator responses.
//
// WHY REASON CODES ARE NEW STRINGS: `formatAuditRecord`'s `REASONS` whitelist is untouched. An audit
// row records what the PLATFORM did; a gate refusal is something that happened BEFORE any dispatch,
// and it is reported through the return value of this function (and the caller's own refusal path),
// not through the audit vocabulary. Adding these to that whitelist would let a pre-dispatch refusal
// masquerade as a platform outcome.
//
// PURE: no I/O, no transaction, and `state` is never mutated (every read is a plain property read).
// The caller decides when to call it and what to do with the answer.
//
// ── WHAT IS TREATED AS ABSENT, AND WHY (backward compatibility, stated as a CHOICE) ──
// Both `writeGate` and `auditGaps` are NEW top-level fields; every state written before this change
// lacks them. Absent is therefore normal, not suspicious, and is treated as "no fault" / "no gaps":
//
//   · Absent `writeGate`  ⇒ no fault.  Failing closed here would brick every pre-existing store the
//     moment this function is wired in — an availability outage caused by a field that simply did not
//     exist yet. The gate exists to stop writes when we KNOW the store is unhealthy, and a missing
//     field is not evidence of that.
//   · Absent `auditGaps`  ⇒ no gaps.   Same reason, same shape.
//
// But PRESENT-and-wrong-type is a different thing: a `writeGate` that is a string, an array or `true`
// is a state we cannot interpret, and an uninterpretable health marker must fail CLOSED. So the rule
// is "absent is tolerated, malformed is not".
//
// ── THRESHOLD FOR auditGaps (was "any non-empty", now "any UNRESOLVED") ──
// The original revision refused on **any** non-empty `auditGaps`. That collided head-on with G-4:
// recovery must keep the gap entry as historical evidence, so the array can never shrink, so a
// non-empty-means-refuse rule would refuse forever and make recovery impossible. The threshold is
// therefore now "any gap that is still UNRESOLVED", where "resolved" means the entry carries a
// `resolvedBy` marker that passes `isResolvedBy(marker, entry.generation)`.
//
// What still refuses, unchanged in spirit (a hole is a hole):
//   · the entry has no `resolvedBy` at all            → unresolved (backward compatible: every gap
//     written before this change lacks the field, and treating those as resolved would unblock
//     writes on the strength of a field that never existed);
//   · `resolvedBy` is present but not a valid marker  → `invalid-state`. Doing anything else with an
//     uninterpretable "I was resolved" claim would be fail-open, and this function's whole job is to
//     fail closed on things it cannot read;
//   · `resolvedBy.generation` differs from the entry's `generation` → unresolved. A marker minted
//     for a DIFFERENT failure episode must not clear this one; that is what keeps a stale marker
//     (or one copied from another incident) from unblocking writes.
//
// ⚠️ SHAPE ONLY. Passing this check does NOT prove the operator was authorised to clear the gap —
// see the note on `isResolvedBy`. Authorization belongs to M9's controlled recovery transaction.
//
// ── NOT DONE HERE (deliberate, so it cannot drift) ──
//   · `state.ledger` is NOT re-validated: `checkLedger` owns that, `reserveWrite` calls it, and
//     duplicating it here would produce a gate refusal that looks like a quota problem.
//   · `action` / `now` are accepted for forward compatibility (a future revision may scope the gate
//     per action, or expire a gap) but are **not** used to weaken the decision today. Passing them
//     is optional; omitting them cannot turn a refusal into an allow.
export function checkWriteGate(state, { action, now } = {}) {
  // `action`/`now` are intentionally unused (see the note above). Reading them keeps the destructure
  // honest about the documented signature without pretending they influence the verdict.
  void action;
  void now;

  // A state we cannot even read properties from is not a state.
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { allowed: false, reason: 'invalid-state' };
  }

  // `ledger` may be absent (the gate does not need it) but must not be garbage if present.
  if (state.ledger !== undefined && (state.ledger === null || typeof state.ledger !== 'object' || Array.isArray(state.ledger))) {
    return { allowed: false, reason: 'invalid-state' };
  }

  // ── fault marker ─────────────────────────────────────────────────────────────────────────
  const gate = state.writeGate;
  if (gate !== undefined && gate !== null) {
    // Absent/null = healthy. Anything else must be a readable marker object.
    if (typeof gate !== 'object' || Array.isArray(gate)) {
      return { allowed: false, reason: 'invalid-state' };
    }
    const fault = gate.fault;
    if (fault !== undefined && fault !== null) {
      // Any non-null `fault` is a named fault (today the only name is 'audit-unavailable'). We do NOT
      // enumerate the names: an unknown fault string means some component reported a condition this
      // function does not understand, and refusing is the safe reading of that.
      if (typeof fault !== 'string' || !fault) return { allowed: false, reason: 'invalid-state' };
      return { allowed: false, reason: 'write-gate-fault' };
    }
  }

  // ── audit gaps ───────────────────────────────────────────────────────────────────────────
  const gaps = state.auditGaps;
  if (gaps !== undefined) {
    if (!Array.isArray(gaps)) return { allowed: false, reason: 'invalid-state' };
    for (const entry of gaps) {
      // A hole in the array (null/undefined) is still an unaccounted settlement: unresolved.
      if (entry === null || entry === undefined) return { allowed: false, reason: 'audit-gap-present' };
      // Every entry must be a readable record; garbage in the array is an uninterpretable state.
      if (typeof entry !== 'object' || Array.isArray(entry)) {
        return { allowed: false, reason: 'invalid-state' };
      }
      // No marker at all ⇒ still open. `undefined` is treated exactly like an absent field: after a
      // JSON round-trip the two are indistinguishable, so judging them differently would produce
      // "allows before persisting, refuses after" behaviour that nobody could debug.
      if (!Object.hasOwn(entry, 'resolvedBy') || entry.resolvedBy === null
          || entry.resolvedBy === undefined) {
        return { allowed: false, reason: 'audit-gap-present' };
      }
      // A marker we cannot read, or one minted for another generation, must NOT clear this gap.
      if (!isResolvedBy(entry.resolvedBy, entry.generation)) {
        // Unreadable shape ⇒ invalid-state; readable but generation-mismatched ⇒ still a live gap.
        // Both refuse; the distinction only tells an operator whether to repair data or to look for
        // the recovery that was supposed to have happened.
        return {
          allowed: false,
          reason: isPlainObject(entry.resolvedBy) ? 'audit-gap-present' : 'invalid-state',
        };
      }
      // Valid marker for THIS generation: the entry stays in the array as evidence, and does not
      // block. (G-4: nothing here deletes it, and nothing here may.)
    }
  }

  return { allowed: true };
}

// Only trusted, authenticated platform events may supply this evidence.
export function canReadNewOwnComment(event, target) {
  if (!event || !target || event.isNew !== true ||
      [event.selfId, event.author, event.postId, event.commentId].some((v) => typeof v !== 'string' || !v.trim())) return false;
  return event.author === event.selfId && target.author === event.selfId &&
    target.postId === event.postId && target.commentId === event.commentId;
}
