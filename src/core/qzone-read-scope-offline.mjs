// Pure snapshots for the optional offline host boundary. These shapes do not
// establish host provenance or authorize any production adapter.
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const safeId = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const qq = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) &&
  Number.isSafeInteger(Number(value)) && String(Number(value)) === value;

export function closedOwnData(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('invalid host data');
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !keys.includes(key)) || keys.some(key => ![...required, ...optional].includes(key))) {
    throw new TypeError('invalid host data');
  }
  const snapshot = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid host data');
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

export function snapshotExceptionReads(value) {
  const snapshot = closedOwnData(value, ['adminQq', 'resolveScope', 'isScopeCurrent', 'finishScope'], ['fetchPost', 'fetchCommentPage']);
  if (!qq(snapshot.adminQq) || ['resolveScope', 'isScopeCurrent', 'finishScope'].some(key => typeof snapshot[key] !== 'function') ||
      ['fetchPost', 'fetchCommentPage'].some(key => Object.hasOwn(snapshot, key) && typeof snapshot[key] !== 'function')) {
    throw new TypeError('invalid exception read dependencies');
  }
  return Object.freeze(snapshot);
}

export function snapshotReadScope(value, proof, adminQq, action, postId) {
  const scope = closedOwnData(value,
    ['kind', 'readId', 'requester', 'author', 'postId', 'commentId', 'grantId', 'question'], ['event', 'postIds']);
  const invalid = () => { throw new TypeError('invalid read scope'); };
  if (proof.source !== 'requested' || scope.readId !== proof.id || !qq(scope.requester) ||
      scope.author !== String(proof.targetQq) || !['shared', 'own-history', 'own-new-comment', 'plain-comments'].includes(scope.kind) ||
      !(scope.postId === null || safeId(scope.postId)) || !(scope.commentId === null || safeId(scope.commentId))) invalid();
  if (scope.kind === 'own-new-comment') {
    if (action !== 'read_comments' || scope.author !== String(proof.botQq) || !safeId(scope.postId) ||
        postId !== scope.postId || !safeId(scope.commentId) || scope.grantId !== null || scope.question !== null ||
        Object.hasOwn(scope, 'postIds')) invalid();
    const event = closedOwnData(scope.event, ['isNew', 'selfId', 'author', 'postId', 'commentId']);
    if (event.isNew !== true || event.selfId !== String(proof.botQq) || event.author !== scope.author ||
        event.postId !== scope.postId || event.commentId !== scope.commentId) invalid();
    scope.event = Object.freeze(event);
  } else if (scope.kind === 'plain-comments') {
    // READING THE COMMENTS OF AN ARBITRARY POST (t40). A SIBLING branch of `own-new-comment`,
    // not a variation of it — the two answer different questions and must not share a check:
    //   · `own-new-comment` exists to prove "this is a comment the OPERATOR just received" and
    //     therefore demands a trusted `event`;
    //   · `plain-comments` exists to show "what people said under this post" and has no such
    //     event. Requiring one would be a lie; accepting one would let a caller smuggle an
    //     event in and inherit the reply-evidence path's assumptions. So `event` is FORBIDDEN.
    //
    // What still binds it: the action, a well-formed post id that MATCHES the one the tool was
    // called with, no comment id (this is a page read, not a single-comment read), and the
    // author fixed to the request's target by the shared check above. `requester`/`grantId`/
    // `question`/`postIds` are the own-history and own-comment machinery; none of them applies,
    // so their absence is required rather than merely unchecked.
    if (action !== 'read_comments' || !safeId(scope.postId) || postId !== scope.postId ||
        scope.commentId !== null || scope.grantId !== null || scope.question !== null ||
        Object.hasOwn(scope, 'event') || Object.hasOwn(scope, 'postIds')) invalid();
  } else {
    if (action !== 'read_posts' || scope.commentId !== null || Object.hasOwn(scope, 'event')) invalid();
    if (scope.kind === 'own-history') {
      if (scope.requester !== scope.author ||
          !safeId(scope.grantId) || scope.grantId.length > 96 || typeof scope.question !== 'string' || !scope.question.trim()) invalid();
      if (scope.postId === null) {
        const ids = scope.postIds;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 ||
            Reflect.ownKeys(ids).length !== ids.length + 1) invalid();
        const copied = [];
        for (let i = 0; i < ids.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(ids, String(i));
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !safeId(descriptor.value) || copied.includes(descriptor.value)) invalid();
          copied.push(descriptor.value);
        }
        scope.postIds = Object.freeze(copied);
      } else if (Object.hasOwn(scope, 'postIds')) invalid();
    } else {
      // ⚠️ THE `admin` KIND IS GONE (t47, operator decision): "administrator sees everyone's whole
      // history" was a privilege design the operator explicitly cancelled. There is no
      // replacement — reading is friend + seven days, always, plus these two narrow exceptions:
      //   · `shared`      — someone shared ONE post with this account; postId is therefore required;
      //   · `own-history` — an explicit, consumed grant for a named set of the operator's own posts.
      // `adminQq` is still accepted by this module (the exception-read configuration names the
      // operator's account and `snapshotExceptionReads` validates it), but it no longer authorizes
      // ANY read: the parameter is retained only so the configuration shape does not have to change.
      if (scope.grantId !== null || scope.question !== null || Object.hasOwn(scope, 'postIds') ||
          (scope.kind === 'shared' && scope.postId === null)) invalid();
    }
  }
  return Object.freeze(scope);
}

export function snapshotExactPost(value, scope, now) {
  const post = closedOwnData(value, ['author', 'id', 'time', 'content']);
  if (post.author !== scope.author || post.id !== scope.postId || !safeId(post.id) ||
      !Number.isSafeInteger(post.time) || post.time < 0 || post.time > now || typeof post.content !== 'string') {
    throw new TypeError('invalid exact post');
  }
  return post;
}
