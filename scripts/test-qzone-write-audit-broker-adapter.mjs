// The broker → write-audit adapter: does a decision become a durable approval row, or a refusal?
//
// ⚠️ WHAT THIS FILE PINS, AND WHAT IT DOES NOT
// --------------------------------------------
// It pins the WIRING: the callback the broker calls (`recordDecision`) produces exactly one
// `stage:'approval'` row per authorisation, carrying the console session it was handed and the
// decision the operator made; and it pins FAIL-CLOSED: when the row cannot be written, the callback
// returns `false` and the broker closes the ticket without approving.
//
// It does NOT prove the session id is real, that the operator was a particular person, or that the
// operation shelled here is the one the platform receives — a caller can build this callback around an
// invented session id and a plausible operation.
//
// ⚠️ THE DIGESTS IN THIS FILE ARE LITERALS, AND WHY
// ------------------------------------------------
// The adapter re-derives a digest from `operation.input` and REFUSES the decision unless it equals
// `operation.inputDigest`. So the fixture digests must be the real ones. They are written here as
// literals computed INDEPENDENTLY of the module (`sha256` of the canonical text below), not by calling
// the module's own helper — calling the helper would make the check circular and prove nothing about
// the canonicalisation. Each literal is spelled with the exact canonical string next to it so a reader
// can recompute it.
//
// ⚠️ NOT PROVEN HERE: that the ADAPTER's canonicalisation equals the AUTHORIZER's for every input.
// The two are independently written; only a real `createQzoneOperationAuthorizer` round trip can show
// they agree. The module header points at `scripts/test-qzone-write-audit-runtime-wiring.mjs` for that
// check, and **that file does not exist in this workspace** — so the claim is currently unbacked by a
// test. Recorded here rather than glossed over.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneWriteAudit } from '../src/core/qzone-write-audit-offline.mjs';
import { createQzoneApprovalAuditRecorder } from '../src/core/qzone-write-audit-broker-adapter-offline.mjs';
import { createQzoneOperationApprovalBroker } from '../src/core/qzone-operation-approval-console.mjs';

const NOW = 1_800_000_000_000;
const SESSION = 'session-abc123';
const BODY = 'hello there';

// sha256('{"content":"hello there","ugc_right":1}') — the canonical rendering of PUBLISH_INPUT.
const PUBLISH_DIGEST = '75455d47faa4d3e205e6545a9b0aa58e990e532d6ab69e3189874014d601531f';
// sha256('qzone-write-audit\n123\ns1\nr1\nc1') truncated to 32 hex — the audit id the sink is keyed by.
const AUTH_ID = '20002327b1e8923a493703efd3606d44';

function tempStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-approval-adapter-${label}-`));
  const store = openOfflineStore(path.join(dir, 'state.db'), { writeAudit: [] });
  return {
    store,
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      for (let i = 0; i < 20; i += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows delay */ }
      }
    },
  };
}

const PUBLISH_INPUT = Object.freeze({ content: BODY, ugc_right: 1 });

/** The operation frame the broker hands to `recordDecision` (a real authorizer's `operation`). */
const operation = (over = {}) => Object.freeze({
  authorizationId: 'ticket-uuid-1',
  accountId: 123,
  sessionId: 's1',
  requestId: 'r1',
  callId: 'c1',
  connectionEpoch: 3,
  action: 'publish',
  // A body IS present on purpose: the test asserts it can never reach the audit row.
  input: PUBLISH_INPUT,
  inputDigest: PUBLISH_DIGEST,
  expiresAt: NOW + 30_000,
  ...over,
});

const decision = (over = {}) => Object.freeze({ operation: operation(), operator: SESSION, approved: true, ...over });

// ── 1. approve writes one approval row carrying the console session ─────────────────────────────
test('AD-1 approve: one approval row, decision "approved", operatorSessionId is the console session', () => {
  const t = tempStore('approve');
  try {
    const audit = createQzoneWriteAudit({ store: t.store });
    const record = createQzoneApprovalAuditRecorder({ audit, clock: () => NOW });

    assert.equal(record(decision()), true, 'a durable approval row must report success');

    const rows = audit.read();
    assert.equal(rows.length, 1, 'exactly one row');
    const [row] = rows;
    assert.equal(row.stage, 'approval');
    assert.equal(row.decision, 'approved');
    assert.equal(row.operatorSessionId, SESSION, 'operatorSessionId comes from the operator argument');
    assert.equal(row.operator, null, 'no display label is known: only a session was given');
    assert.equal(row.decidedAt, NOW, 'decidedAt comes from the injected clock');
    assert.equal(row.outcome, null, 'an approval is not a platform outcome');
    // The id is the QUADRUPLE digest, not the ticket UUID: the runtime never sees the ticket, so both
    // sides key on the identity they actually share.
    assert.equal(row.authorizationId, AUTH_ID, 'audit id is the B2 quadruple digest');
    assert.notEqual(row.authorizationId, 'ticket-uuid-1', 'and NOT the operation ticket uuid');
    assert.equal(row.accountId, 123);
    assert.equal(row.sessionId, 's1');
    assert.equal(row.requestId, 'r1');
    assert.equal(row.callId, 'c1');
    assert.equal(row.connectionEpoch, 3);
    assert.equal(row.action, 'publish');
    assert.equal(row.inputDigest, PUBLISH_DIGEST, 'the row carries the approved snapshot digest');
    // Publish identity fields moved from the tool input into the sink's own names.
    assert.equal(row.ugcRight, 1);
    assert.equal(row.targetUins, null, 'ugc_right 1 requires no recipients');

    // A DIFFERENT digest must be refused rather than written: the row would claim to describe an
    // approval it cannot identify. This is the adapter's cross-check, exercised through its own entry.
    const mismatched = Object.freeze({
      ...operation({ callId: 'c2' }),
      inputDigest: 'a'.repeat(64),
    });
    assert.equal(record(Object.freeze({ operation: mismatched, operator: SESSION, approved: true })), false,
      'a digest that disagrees with the snapshot must be refused');
    assert.equal(audit.read().length, 1, 'and nothing was written for it');
  } finally { t.cleanup(); }
});

// ── 2. reject is recorded as its own decision ───────────────────────────────────────────────────
test('AD-2 reject: decision "rejected", and the ticket closes with a refusal', async () => {
  const t = tempStore('reject');
  try {
    const audit = createQzoneWriteAudit({ store: t.store });
    const record = createQzoneApprovalAuditRecorder({ audit, clock: () => NOW });

    assert.equal(record(decision({ approved: false })), true, 'the row must be written for a refusal too');
    const rows = audit.read();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, 'rejected');
    assert.equal(rows[0].stage, 'approval');
    assert.equal(rows[0].operatorSessionId, SESSION);

    // End to end through the real broker: a recorded rejection is still a rejection.
    const broker = createQzoneOperationApprovalBroker({ clock: () => NOW, recordDecision: record });
    const waiting = broker.approveOperation(operation({ authorizationId: 'ticket-reject' }));
    const decided = broker.decide(
      { authorizationId: 'ticket-reject', inputDigest: PUBLISH_DIGEST, approved: false },
      { operator: SESSION },
    );
    assert.equal(decided, true, 'the decision was accepted (and its row recorded)');
    assert.equal(await waiting, false, 'a rejection resolves the broker promise as false');

    const rejectRow = audit.read().find((row) => row.decision === 'rejected'
      && row.inputDigest === PUBLISH_DIGEST && row.stage === 'approval');
    assert.ok(rejectRow, 'the rejection row exists');
    assert.equal(rejectRow.operatorSessionId, SESSION);
  } finally { t.cleanup(); }
});

// ── 3. a store fault makes the callback false, and the broker refuses to approve ───────────────
test('AD-3 store failure: callback false, broker closes the ticket and does NOT approve', async () => {
  // A sink whose write always fails, exactly like an unwritable audit store.
  const broken = {
    recordWrite() { const error = new Error('audit store unavailable (injected)'); error.code = 'EIO'; throw error; },
    read() { return Object.freeze([]); },
    stagesFor() { return Object.freeze([]); },
  };
  const record = createQzoneApprovalAuditRecorder({ audit: broken, clock: () => NOW });
  assert.equal(record(decision()), false, 'a failed write must never be reported as recorded');

  // And the broker must treat that as "cannot evidence it, so do not approve".
  const t = tempStore('broker-fail');
  try {
    const audit = createQzoneWriteAudit({ store: t.store });
    const flaky = {
      recordWrite: (...args) => {
        if (args[1] === 'approval') throw new Error('audit store unavailable (injected)');
        return audit.recordWrite(...args);
      },
      read: () => audit.read(),
      stagesFor: (id) => audit.stagesFor(id),
    };
    const recorder = createQzoneApprovalAuditRecorder({ audit: flaky, clock: () => NOW });
    const broker = createQzoneOperationApprovalBroker({ clock: () => NOW, recordDecision: recorder });

    const waiting = broker.approveOperation(operation({ authorizationId: 'ticket-broken' }));
    const decided = broker.decide(
      { authorizationId: 'ticket-broken', inputDigest: PUBLISH_DIGEST, approved: true },
      { operator: SESSION },
    );
    assert.equal(decided, false, 'the broker must refuse the decision when it cannot be recorded');
    assert.equal(await waiting, false, 'and the ticket must resolve as not-approved');
    assert.deepEqual(broker.listPending(), [], 'the ticket is closed, not left pending');
    assert.equal(audit.read().length, 0, 'no approval row exists — which is why it was refused');
  } finally { t.cleanup(); }
});

// ── 4. no body is stored: `content` is not even a key on the row ───────────────────────────────
test('AD-4 no body: the row has no content key at all, and the body text is nowhere in it', () => {
  const t = tempStore('nobody');
  try {
    const audit = createQzoneWriteAudit({ store: t.store });
    const record = createQzoneApprovalAuditRecorder({ audit, clock: () => NOW });
    assert.equal(record(decision()), true);

    const [row] = audit.read();
    assert.equal(Object.hasOwn(row, 'content'), false, 'the sink has no content field and the adapter adds none');
    assert.equal(Object.hasOwn(row, 'body'), false);
    assert.equal(JSON.stringify(row).includes(BODY), false,
      'the publish body must not appear anywhere in the stored row');
    assert.equal(row.inputDigest, PUBLISH_DIGEST, 'only the digest is derived from the body');

    // A reply carries its parent identity, and (like publish) still no body.
    const replyInput = Object.freeze({
      content: BODY, comment_id: 'cmt-1', comment_uin: 456, reply_uin: 789, reply_name: 'someone',
    });
    // sha256 of the canonical rendering of `replyInput` (keys sorted):
    //   {"comment_id":"cmt-1","comment_uin":456,"content":"hello there","reply_name":"someone","reply_uin":789}
    const RESPONSE_DIGEST = 'a918f76bdfc828a9a9f296ac002980e096428cb943e79e30d77ee1ceb4961142';
    const replyOperation = operation({
      callId: 'c-reply',
      action: 'reply',
      input: replyInput,
      inputDigest: RESPONSE_DIGEST,
    });
    assert.equal(record(Object.freeze({ operation: replyOperation, operator: SESSION, approved: true })), true,
      'a legal reply must be recordable');

    const replyRow = audit.read().find((row) => row.action === 'reply');
    assert.ok(replyRow, 'the reply row exists');
    assert.equal(replyRow.commentId, 'cmt-1');
    assert.equal(replyRow.commentUin, 456);
    assert.equal(replyRow.replyUin, 789);
    assert.equal(Object.hasOwn(replyRow, 'content'), false);
    assert.equal(JSON.stringify(replyRow).includes(BODY), false, 'still no body for a reply');
  } finally { t.cleanup(); }
});
