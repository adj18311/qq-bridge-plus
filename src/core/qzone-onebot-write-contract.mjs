// Request shaping only: this does not grant permission, reserve quota, audit,
// send requests, or establish the source of target identities.
const FIELDS = Object.freeze({
  publish: new Set(['content', 'ugc_right', 'target_uins']),
  like: new Set(['tid', 'target_uin', 'abstime']),
  comment: new Set(['tid', 'target_uin', 'content']),
  reply: new Set(['tid', 'target_uin', 'content', 'comment_id', 'comment_uin', 'reply_uin', 'reply_name']),
});

function copyFields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('invalid input');
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new TypeError('invalid field');
    const desc = Object.getOwnPropertyDescriptor(input, key);
    if (!desc?.enumerable || !Object.hasOwn(desc, 'value')) throw new TypeError('invalid field');
    fields[key] = desc.value;
  }
  return fields;
}

function qq(value) {
  const n = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n <= 0 || (typeof value === 'string' && String(n) !== value)) throw new TypeError('invalid identity');
  return n;
}

// ── the TWO validation primitives, exported as pure predicates ──────────────────────────────
//
// The write path has to refuse the same shapes this module refuses, and it must do it BEFORE it
// reserves quota. Re-implementing "is this a body / is this an id" there would create a second rule
// source that can drift (and drift silently: a looser copy accepts what the platform call would
// reject). So the rules live here, once, and the builder below is written in terms of them — the
// exported predicates and the builder can never disagree.
//
// These are PREDICATES, not the builder: they say nothing about visibility (`ugc_right`), the parent
// comment's author (`comment_uin`), or reply targets. A caller with those values must still go
// through `buildQzoneOnebotWriteRequest`; nobody may fill the missing ones in by default.
export function isValidWriteContent(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 100000;
}

/** The identifier shape used by BOTH `tid` (post id) and `comment_id` in the request builder. */
export function isValidWriteId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

// ── READ-ONLY projection of the field allowlist ────────────────────────────────────────────
//
// WHY THIS EXISTS: a facade that accepts a field this module would reject is WIDER than its own
// contract, and that is how `like` + `content` slipped through (t10: the facade reserved quota and
// handed the body to the transport while `copyFields` would have thrown `invalid field`).
// Re-implementing the allowlist on the facade side would recreate the same drift, so instead the
// allowlist is published from HERE — the one place that already decides it — and the facade test
// compares against it table-driven (LZ-17).
//
// READ-ONLY, and deliberately not `FIELDS` itself: `FIELDS` holds live `Set` instances, and handing
// those out would let a caller mutate the contract at runtime (`FIELDS.like.add('content')` would
// disable the very check this module performs). A frozen array copy cannot be used to widen anything.
// The CONTENT of the allowlist is unchanged — this is a projection, not a new rule.
export function allowedFieldsFor(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(FIELDS, kind)) return null;
  return Object.freeze([...FIELDS[kind]].sort());
}

function body(value) {
  if (!isValidWriteContent(value)) throw new TypeError('invalid content');
  return value;
}

function id(value) {
  if (!isValidWriteId(value)) throw new TypeError('invalid id');
  return value;
}

export function buildQzoneOnebotWriteRequest(kind, input) {
  if (typeof kind !== 'string' || !Object.hasOwn(FIELDS, kind)) throw new TypeError('invalid action');
  const f = copyFields(input, FIELDS[kind]);
  if (kind === 'publish') {
    // Require an explicit visibility rather than silently publishing publicly.
    const params = { content: body(f.content), ugc_right: f.ugc_right };
    if (![1, 4, 16, 64, 128].includes(params.ugc_right)) throw new TypeError('invalid visibility');
    if (params.ugc_right === 16 || params.ugc_right === 128) {
      if (!Array.isArray(f.target_uins) || f.target_uins.length < 1 || f.target_uins.length > 1000) throw new TypeError('invalid recipients');
      params.target_uins = [];
      for (let i = 0; i < f.target_uins.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(f.target_uins, String(i));
        if (!desc || !Object.hasOwn(desc, 'value')) throw new TypeError('invalid recipients');
        params.target_uins.push(qq(desc.value));
      }
    } else if (f.target_uins !== undefined) throw new TypeError('unexpected recipients');
    return { action: 'send_qzone_msg', params };
  }
  const params = { tid: id(f.tid), target_uin: qq(f.target_uin) };
  if (kind === 'like') {
    if (f.abstime !== undefined) {
      if (!Number.isSafeInteger(f.abstime) || f.abstime < 0) throw new TypeError('invalid time');
      params.abstime = f.abstime;
    }
    return { action: 'like_qzone', params };
  }
  params.content = body(f.content);
  if (kind === 'reply') {
    params.comment_id = id(f.comment_id);
    params.comment_uin = qq(f.comment_uin);
    if ((f.reply_uin === undefined) !== (f.reply_name === undefined)) throw new TypeError('invalid reply target');
    if (f.reply_uin !== undefined) {
      params.reply_uin = qq(f.reply_uin);
      params.reply_name = body(f.reply_name);
    }
  }
  return { action: 'comment_qzone', params };
}
