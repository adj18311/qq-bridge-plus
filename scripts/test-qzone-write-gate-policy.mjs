// M1 · `checkWriteGate` — the pure pre-dispatch health gate for writes.
//
// What this file is actually protecting
// -------------------------------------
// The gate is the ONLY thing that stops a write when our own state store is unhealthy (a recorded
// fault, or an audit hole from a settlement that could not be logged for real). Its failure modes are
// therefore asymmetric:
//
//   wrongly ALLOWING  → we dispatch while unable to record what we did   (the dangerous direction)
//   wrongly REFUSING  → writes stop until an operator looks              (an outage, but a safe one)
//
// So every "it refuses" assertion below is written from a NON-DEGENERATE state (a real fault marker /
// a real gap object), and every "it allows" assertion is paired with a positive control showing the
// same call refuses once the marker is present. That way neither "allow everything" nor "refuse
// everything" can pass this file.
//
// The gate must also stay PURE. That is not a stylistic preference: a gate that mutated state would
// turn a read-only pre-check into a write, and a caller that runs it twice (retry, or two entries
// sharing one utility) would then behave differently the second time.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { checkWriteGate, reserveWrite } from '../src/core/qzone-policy-offline.mjs';

/** A minimal WELL-FORMED state: healthy gate, no gaps, a readable ledger. */
const healthy = (over = {}) => ({
  ledger: { day: '2026-11-13', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  writeGate: null,
  auditGaps: [],
  ...over,
});

const fault = (over = {}) => ({ fault: 'audit-unavailable', since: 1_800_000_000_000, cause: 'audit-not-array', ...over });

// ── WG-1: healthy state allows ────────────────────────────────────────────────────
test('WG-1 正常 state（writeGate:null, auditGaps:[]）→ allowed:true', () => {
  const state = healthy();
  assert.deepEqual(checkWriteGate(state), { allowed: true });
  // `action`/`now` are accepted but must not be required — the gate answers a global question.
  assert.deepEqual(checkWriteGate(state, { action: 'publish', now: 1_800_000_000_000 }), { allowed: true });
  assert.deepEqual(checkWriteGate(state, { action: 'like' }), { allowed: true });
  // Non-vacuity: the SAME call refuses once a fault appears. Without this, WG-1 could pass against an
  // implementation that returns `{allowed:true}` unconditionally.
  assert.equal(checkWriteGate({ ...state, writeGate: fault() }).allowed, false);
});

// ── WG-2: a recorded fault refuses ───────────────────────────────────────────────
test('WG-2 writeGate 有故障 → allowed:false, reason:write-gate-fault', () => {
  for (const gate of [
    fault(),
    fault({ cause: 'store-update-threw' }),
    // `cause` is diagnostic only; its shape must not change the verdict.
    { fault: 'audit-unavailable' },
    // An UNKNOWN fault name still refuses: an unrecognised health marker is not evidence of health.
    { fault: 'some-future-fault-name' },
  ]) {
    assert.deepEqual(checkWriteGate(healthy({ writeGate: gate })), { allowed: false, reason: 'write-gate-fault' },
      `writeGate=${JSON.stringify(gate)} 必须拒绝`);
  }
});

// ── WG-3: any audit gap refuses (conservative threshold) ─────────────────────────
test('WG-3 auditGaps 非空 → allowed:false, reason:audit-gap-present', () => {
  const oneGap = healthy({ auditGaps: [{ at: 1_800_000_000_000, cause: 'audit-not-array' }] });
  assert.deepEqual(checkWriteGate(oneGap), { allowed: false, reason: 'audit-gap-present' });

  // The threshold is deliberately "non-empty", so even a single gap blocks. Pin the boundary from
  // BOTH sides so a future "tolerate N gaps" change cannot slide it silently.
  assert.deepEqual(checkWriteGate(healthy({ auditGaps: [] })), { allowed: true }, '空数组 = 无空洞');
  assert.equal(checkWriteGate(healthy({ auditGaps: [{ at: 0 }] })).reason, 'audit-gap-present');
  assert.equal(checkWriteGate(healthy({ auditGaps: [{ at: 0 }, { at: 1 }, { at: 2 }] })).reason, 'audit-gap-present');
});

// ── WG-4: invalid inputs fail closed ────────────────────────────────────────────
test('WG-4 state 缺失或形状非法 → allowed:false, reason:invalid-state', () => {
  for (const bad of [null, undefined, 0, '', 'state', true, [], [1, 2], 42]) {
    assert.deepEqual(checkWriteGate(bad), { allowed: false, reason: 'invalid-state' },
      `checkWriteGate(${JSON.stringify(bad)}) 必须 fail-closed`);
  }
  // Malformed ledger (present but not an object) is an unreadable state, not a quota refusal.
  for (const ledger of [null, 'x', 7, []]) {
    assert.deepEqual(checkWriteGate(healthy({ ledger })), { allowed: false, reason: 'invalid-state' },
      `ledger=${JSON.stringify(ledger)} 必须 fail-closed`);
  }
  // Malformed gate/gap shapes are uninterpretable health markers ⇒ refuse, do NOT treat as absent.
  for (const writeGate of ['broken', 1, true, []]) {
    assert.deepEqual(checkWriteGate(healthy({ writeGate })), { allowed: false, reason: 'invalid-state' },
      `writeGate=${JSON.stringify(writeGate)} 必须 fail-closed（形状非法不像「无故障」）`);
  }
  for (const auditGaps of ['none', 0, {}, true]) {
    assert.deepEqual(checkWriteGate(healthy({ auditGaps })), { allowed: false, reason: 'invalid-state' },
      `auditGaps=${JSON.stringify(auditGaps)} 必须 fail-closed`);
  }
  // A `fault` that is not a non-empty string cannot be reported as a fault ⇒ uninterpretable.
  for (const badFault of ['', 0, {}, []]) {
    assert.deepEqual(checkWriteGate(healthy({ writeGate: { fault: badFault } })), { allowed: false, reason: 'invalid-state' },
      `fault=${JSON.stringify(badFault)} 必须 fail-closed`);
  }
});

// ── WG-5: BACKWARD COMPATIBILITY — absent means healthy (a stated CHOICE) ────────
test('WG-5 缺 writeGate / 缺 auditGaps（旧 state）→ 放行（向后兼容，是选择不是疏忽）', () => {
  // Every store written before H3 lacks both fields. Treating absence as a fault would brick all of
  // them the instant this gate is wired in — an availability outage caused by a field that simply did
  // not exist yet. The gate exists to stop writes when we KNOW the store is unhealthy; a missing
  // field is not evidence of that. So: absent ⇒ healthy.
  const legacy = { ledger: healthy().ledger };   // exactly the pre-H3 shape
  assert.equal(Object.hasOwn(legacy, 'writeGate'), false, '前提：旧 state 确实没有 writeGate');
  assert.equal(Object.hasOwn(legacy, 'auditGaps'), false, '前提：旧 state 确实没有 auditGaps');
  assert.deepEqual(checkWriteGate(legacy), { allowed: true });

  // Present-but-null is equivalent to absent (both mean "no fault recorded").
  assert.deepEqual(checkWriteGate({ ledger: healthy().ledger, writeGate: null, auditGaps: [] }), { allowed: true });

  // But the tolerance is ONLY for absence/null — a garbage value still fails closed (WG-4 covers the
  // shape cases; this line ties the two rules together so neither can be read as the other).
  assert.equal(checkWriteGate({ ledger: healthy().ledger, writeGate: 'x' }).reason, 'invalid-state');

  // Also: no ledger at all is tolerated here on purpose — `checkLedger`/`reserveWrite` own that
  // rejection, and duplicating it would surface a quota problem as a gate refusal.
  assert.deepEqual(checkWriteGate({}), { allowed: true });
  assert.deepEqual(checkWriteGate({ writeGate: null, auditGaps: [] }), { allowed: true });
});

// ── WG-6: purity ────────────────────────────────────────────────────────────────
test('WG-6 纯函数：调用前后 state 深度相等（不改 state、不冻结、不写）', () => {
  const states = [
    healthy(),
    healthy({ writeGate: fault() }),
    healthy({ auditGaps: [{ at: 1 }] }),
    { ledger: healthy().ledger },
    {},
  ];
  for (const state of states) {
    const before = JSON.stringify(state);
    const keysBefore = Object.keys(state).sort();
    checkWriteGate(state);
    checkWriteGate(state, { action: 'publish', now: 1 });
    assert.equal(JSON.stringify(state), before, '调用不得改动 state（含嵌套字段）');
    assert.deepEqual(Object.keys(state).sort(), keysBefore, '调用不得增删顶层键');
  }

  // Deep equality on a nested object, so an in-place edit of `ledger.used` would also be caught.
  const nested = healthy();
  const snapshot = structuredClone(nested);
  checkWriteGate(nested);
  assert.deepEqual(nested, snapshot, '嵌套结构必须逐字段不变');

  // A FROZEN state must not throw: if the implementation tried to write, this would raise in strict
  // mode. Returning normally from a frozen input is direct evidence of read-only behaviour.
  const frozen = Object.freeze({ ledger: Object.freeze({ day: '2026-11-13' }), writeGate: null, auditGaps: Object.freeze([]) });
  assert.deepEqual(checkWriteGate(frozen), { allowed: true });
  const frozenFault = Object.freeze({ writeGate: Object.freeze({ fault: 'audit-unavailable' }), auditGaps: Object.freeze([]) });
  assert.equal(checkWriteGate(frozenFault).reason, 'write-gate-fault');
});

test('WG-6b 源码级：模块内无 I/O、无事务、且 checkWriteGate 未写进 reserveWrite', () => {
  const source = fs.readFileSync(new URL('../src/core/qzone-policy-offline.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');

  // No filesystem / process / network primitives anywhere in this policy module.
  for (const forbidden of ['readFileSync', 'writeFileSync', 'appendFileSync', 'node:fs', 'node:net', 'fetch(', 'process.env']) {
    assert.equal(code.includes(forbidden), false, `policy 模块不得使用 ${forbidden}`);
  }
  // A pure policy function must not open a transaction.
  assert.equal(code.includes('store.update'), false, 'policy 模块不得提交事务');
  // And the gate must remain a standalone export, not a clause inside reserveWrite.
  assert.match(code, /export function checkWriteGate\(state, \{ action, now \} = \{\}\)/,
    'checkWriteGate 必须是独立导出且签名固定');
  const reserveSignature = code.match(/export function reserveWrite\(([^)]*)\)/);
  assert.ok(reserveSignature, 'reserveWrite 必须仍然导出');
  assert.equal(reserveSignature[1].replace(/\s+/g, ' ').trim(), 'state, { day, kind, limit, id } = {}',
    '★ reserveWrite 签名必须保持原样（M6 要求）');
});

// ── WG-7: the audit-gap path is load-bearing ────────────────────────────────────
test('WG-7 两条拒绝原因互不吞并：有空洞但有故障时，报故障（先报更根本的那个）', () => {
  // Ordering matters for diagnosis: "we cannot record at all" is more fundamental than "we recorded
  // one hole". Pinned so a refactor cannot silently swap the two.
  const both = healthy({ writeGate: fault(), auditGaps: [{ at: 1 }] });
  assert.deepEqual(checkWriteGate(both), { allowed: false, reason: 'write-gate-fault' });
});

test('WG-7b reason 码不得混入审计白名单（formatAuditRecord 的 REASONS 不动）', async () => {
  // The gate's reasons describe a PRE-dispatch refusal; putting them in the audit vocabulary would let
  // a local health refusal masquerade as a platform outcome.
  const auditSource = fs.readFileSync(new URL('../src/core/qzone-audit-offline.mjs', import.meta.url), 'utf8');
  const reasonsLine = auditSource.split('\n').find((line) => line.includes('const REASONS'));
  assert.ok(reasonsLine, '前提：审计模块仍有 REASONS 白名单');
  assert.equal(reasonsLine.includes('write-gate-fault'), false, '不得把 write-gate-fault 加进 REASONS');
  assert.equal(reasonsLine.includes('audit-gap-present'), false, '不得把 audit-gap-present 加进 REASONS');
  assert.equal(reasonsLine.includes('invalid-state'), false, '不得把 invalid-state 加进 REASONS');
});
