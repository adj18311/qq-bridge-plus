// ONE copy of the reply-evidence predicate.
//
// WHY THIS FILE EXISTS
// --------------------
// "Does the recorded comment evidence describe the exact reply this request is about to send?"
// is a judgement two modules have to make:
//
//   `qzone-bound-write-simulation-offline.mjs`  — before it reserves/claims a bound write;
//   `qzone-reservation-offline.mjs`             — before it reserves an AUDITED reply
//                                                 (`reserveAuditedOfflineInteraction`).
//
// If each kept its own copy, the two would drift and the drift would be INVISIBLE: one copy
// accepting a reply whose `reply_uin` differs from what the evidence recorded is a reply sent to
// the wrong person, under an approval that named somebody else. Both call sites therefore import
// these two functions, and neither re-spells the rules. The logic below was MOVED here verbatim
// from `qzone-bound-write-simulation-offline.mjs` (its old lines 39-60); the behaviour did not
// change, only the number of copies (2 candidates -> 1).
//
// WHAT THIS PREDICATE IS, AND IS NOT
// ----------------------------------
//   · It is a COMPARISON between an evidence row and a platform-request-shaped `params` object
//     (`{comment_id?, comment_uin, reply_uin?, reply_name?}` — the shape
//     `buildQzoneOnebotWriteRequest` emits). It answers "same reply?", nothing else.
//   · It is NOT proof that the evidence row is trustworthy. Tests seed rows as fixtures, and no
//     producer was found in the checked `src/` scope. Other deployments or external writers were
//     not ruled out. When matching evidence is absent the gate fails closed; a matching row is not
//     proof that the platform was consulted.
//   · It does NOT compare `comment_id`: the caller selects the candidate row by
//     target/postId/commentId first (that triple is the row's identity), so re-checking it here
//     would be a second spelling of the same rule. What it DOES check is everything the triple
//     cannot express: the parent comment's author (`comment_uin`) and, when the reply targets a
//     person, the target's identity and display name.
//   · It requires the evidence row to CARRY the three fields (`Object.hasOwn`). A row written
//     before they existed is a mismatch, not "absent means don't care": absent evidence must never
//     be read as agreement, or a legacy row would authorise any reply on its comment.

/**
 * Canonical decimal-string form of a QQ identity, or `null` when the value cannot be one.
 *
 * Accepts the two shapes the MCP contract accepts (`integer` / `^[1-9][0-9]*$` string) and ALSO
 * accepts a number for the string field, because `1` and `'1'` name the same account: comparing
 * them as different would refuse a correct reply depending on which layer normalised first.
 * Anything else — `0`, negatives, floats, `'01'`, `true`, `null`, objects — is `null`.
 */
export function trustedQQ(value) {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? String(number) : null;
  }
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

/**
 * Does `evidence` describe the reply carried by `request.params`?
 *
 * @param evidence - one `state.commentEvidence` row
 *   `{target, postId, commentId, commentUin, replyUin, replyName}` (`replyUin`/`replyName` are
 *   both `null` when the reply targets the post author / the thread rather than a person).
 * @param request - `{params}` where `params` is built by `buildQzoneOnebotWriteRequest`.
 *   `reply_uin` and `reply_name` are present TOGETHER or absent TOGETHER (the builder refuses a
 *   half pair), so their presence is the switch between "reply to a person" and "reply to the
 *   thread".
 * @returns strict boolean. Any throw-adjacent shape (null row, missing own field) is `false` —
 *   this is a gate, and a gate that throws is a gate somebody will eventually bypass.
 */
export function matchesReplyEvidence(evidence, request) {
  const params = request.params;
  if (!evidence || !Object.hasOwn(evidence, 'commentUin') ||
      !Object.hasOwn(evidence, 'replyUin') || !Object.hasOwn(evidence, 'replyName') ||
      trustedQQ(evidence.commentUin) !== trustedQQ(params.comment_uin)) return false;

  const hasReplyTarget = Object.hasOwn(params, 'reply_uin') && Object.hasOwn(params, 'reply_name');
  if (hasReplyTarget) {
    return trustedQQ(evidence.replyUin) !== null &&
      trustedQQ(evidence.replyUin) === trustedQQ(params.reply_uin) &&
      typeof evidence.replyName === 'string' && evidence.replyName === params.reply_name;
  }
  return evidence.replyUin === null && evidence.replyName === null;
}
