// Offline comparison of the three positions-capacity policies, per Codex m05450:
// "先就全局有界+拒绝新增、分层软配额与实际错误可观察性离线比较；不要假定
//  4096×4096×157B 为实测或改变限额。"
//
// This file deliberately does NOT touch `plugins/qzone-safe/index.mjs` — it models the
// three policies in isolation so the comparison is a measurement, not a proposal. The
// production policy stays whatever it is today; nothing here changes a limit.
//
// Policies modelled:
//   A  global bound + refuse-new        : at the cap, the NEW announce is refused. The
//                                         pending call keeps its position and later
//                                         dispatches fine; the refused one dies.
//   B  global bound + evict-oldest-live : today's shipped behaviour. At the cap, the
//                                         OLDEST live position is dropped, so a call
//                                         that was about to dispatch dies instead.
//   C  per-session soft quota           : each session gets `quota`; a session at its
//                                         quota is refused without touching other
//                                         sessions' entries.
//
// What is measured for each: which call survives, what the survivor observes, and
// whether the failure is distinguishable from the other four causes that all report
// `origin-unbound`.

const MAX = 8;          // deliberately tiny so every branch is reachable
const SESSIONS = 3;
const PER_SESSION_QUOTA = 3;

// A position is "live" while the ledger still resolves its callId to a turn/step.
// `bound` models `ledger.peekCall(callId) !== null`.
function makeWorld() {
  const bound = new Set();
  return {
    bind(callId) { bound.add(callId); },
    isLive(callId) { return bound.has(callId); },
    drop(callId) { bound.delete(callId); },
    size() { return bound.size; },
  };
}

// Policy A: refuse the newcomer when full. Nobody already queued is harmed.
function policyRefuseNew(world, queue, callId) {
  world.bind(callId);
  if (queue.length >= MAX) return { accepted: false, evicted: null };
  queue.push(callId);
  return { accepted: true, evicted: null };
}

// Policy B: shipped behaviour -- evict the oldest live position, accept the newcomer.
function policyEvictOldest(world, queue, callId) {
  world.bind(callId);
  let evicted = null;
  if (queue.length >= MAX) {
    // Prefer already-dead entries; fall back to FIFO among live ones.
    const deadIndex = queue.findIndex((entry) => !world.isLive(entry));
    const index = deadIndex >= 0 ? deadIndex : 0;
    evicted = queue[index];
    queue.splice(index, 1);
  }
  queue.push(callId);
  return { accepted: true, evicted };
}

// Policy C: per-session quota. A session over quota is refused; other sessions are
// untouched even when the global table is not full.
function policyPerSession(world, queue, callId, sessionId) {
  const mine = queue.filter((entry) => entry.startsWith(`${sessionId}/`));
  world.bind(callId);
  if (mine.length >= PER_SESSION_QUOTA) return { accepted: false, evicted: null };
  queue.push(callId);
  return { accepted: true, evicted: null };
}

function runPolicy(name, apply) {
  const world = makeWorld();
  const queue = [];
  const log = [];
  // The harm question is about a call that has ALREADY been waiting: it must be the
  // oldest entry, otherwise "evict the oldest" cannot possibly reach it and the
  // comparison would flatter the shipped policy for the wrong reason.
  const victim = 's0/pending-real';
  log.push({ callId: victim, ...apply(world, queue, victim, 's0') });
  for (let index = 0; index < MAX - 1; index += 1) {
    const callId = `s0/filler-${index}`;
    log.push({ callId, ...apply(world, queue, callId, 's0') });
  }
  const newcomer = 's0/newest';
  const outsider = 's1/other-session';
  log.push({ callId: newcomer, ...apply(world, queue, newcomer, 's0') });
  log.push({ callId: outsider, ...apply(world, queue, outsider, 's1') });

  const pendingSurvives = queue.includes(victim);
  const newcomerSurvives = queue.includes(newcomer);
  const outsiderSurvives = queue.includes(outsider);
  const evictedEntries = log.filter((entry) => entry.evicted).map((entry) => entry.evicted);
  const refusedEntries = log.filter((entry) => entry.accepted === false).map((entry) => entry.callId);

  return {
    policy: name,
    tableSize: queue.length,
    pendingCallReachedDispatch: pendingSurvives,
    // The crux: does the call that was already waiting get killed to make room?
    harmsWaitingCall: !pendingSurvives,
    newcomerAdmitted: newcomerSurvives,
    crossSessionCollateral: evictedEntries.includes(outsider) || (outsiderSurvives === false && refusedEntries.includes(outsider)),
    outsiderSurvives,
    evictedEntries,
    refusedEntries,
    // Whose failure is it, and can an operator tell them apart?
    failureSignalForLoser: (pendingSurvives && newcomerSurvives) ? null : 'origin-unbound',
    distinguishableFromOtherCauses: false, // all five causes share this code, by construction
  };
}

const results = [
  runPolicy('A-refuse-new', policyRefuseNew),
  runPolicy('B-evict-oldest-live (shipped)', policyEvictOldest),
  runPolicy('C-per-session-quota', policyPerSession),
];

// Error observability: the five distinct causes that all surface as `origin-unbound`.
// This is a structural fact read off the current source, not a guess -- each site is
// named so a reader can check it.
const SAME_CODE_CAUSES = [
  { cause: 'position never announced (plugin: dispatchBound miss)', site: 'plugins/qzone-safe/index.mjs (dispatchBound: positions.get miss)' },
  { cause: 'position announced for another session', site: 'plugins/qzone-safe/index.mjs (dispatchBound: position.sessionId !== sessionId)' },
  { cause: 'position evicted by capacity', site: 'plugins/qzone-safe/index.mjs (evictOnePosition)' },
  { cause: 'ledger never bound the call (position invalid / step mismatch)', site: 'src/core/qzone-origin-ledger-offline.mjs (observeToolCall !validPosition)' },
  { cause: 'ledger consumed already (replay) or turn tainted', site: 'src/core/qzone-origin-ledger-offline.mjs (consume)' },
];

// What a "reject-new" policy would need in order to be honest: the refusal must be
// distinguishable at the moment it happens, not inferred later from a counter.
const OBSERVABILITY_REQUIREMENTS = [
  'A refusal must return its own error code, not fall through to origin-unbound.',
  'A refusal must be counted (today: positionsEvictedLive covers eviction; there is no refusal counter).',
  'An eviction must record WHICH callId died, otherwise the owner cannot tell a lost call from a call that never existed.',
  'The counter must carry a generation label, or a rotation makes the number meaningless (R10 medium-3).',
];

console.log(JSON.stringify({
  probe: 'positions-policy-comparison',
  assumptions: {
    tableCap: MAX,
    sessions: SESSIONS,
    perSessionQuota: PER_SESSION_QUOTA,
    note: 'modelled in isolation; production limits untouched and NOT measured here',
  },
  results,
  sameDiagnosticCodeCauses: SAME_CODE_CAUSES,
  observabilityRequirements: OBSERVABILITY_REQUIREMENTS,
  summary: {
    evictPolicyHarmsWaitingCall: results[1].harmsWaitingCall,
    refusePolicyHarmsWaitingCall: results[0].harmsWaitingCall,
    perSessionHarmsOtherSessions: !results[2].outsiderSurvives,
    everyPolicyLosesSilently: results.every((row) => row.distinguishableFromOtherCauses === false),
    anyPolicyHasOwnErrorCode: false,
  },
}, null, 2));

const failures = [];
if (!results[1].harmsWaitingCall) failures.push('the shipped evict-oldest policy should have killed the oldest waiting call in this model');
if (results[0].harmsWaitingCall) failures.push('refuse-new must NOT harm an already-waiting call');
if (results[0].newcomerAdmitted) failures.push('refuse-new must refuse the newcomer once the table is full');
if (results[2].outsiderSurvives !== true) failures.push('per-session quota must not touch another session');
// Policy C refuses the 4th+ call of a busy session even though the global table has
// room. That is the trade it makes: no cross-session collateral, but a single busy
// session starves itself well before the global cap is reached.
if (results[2].refusedEntries.length === 0) failures.push('per-session quota at 3 with 7 s0 calls must refuse some s0 calls');
if (results[2].tableSize >= MAX) failures.push('per-session quota should keep the global table under its cap in this model');
console.log(JSON.stringify({
  done: true,
  failures,
  tradeoffs: {
    A: 'refuses the newcomer; nobody already queued dies; the newcomer gets origin-unbound',
    B: 'admits everyone until the cap, then kills the oldest waiting call; that call gets origin-unbound',
    C: 'never kills a queued call and never touches another session, but a busy session is refused at its own quota while the global table still has room',
    shared: 'all three surface the loss as origin-unbound, indistinguishable from three other causes',
  },
}));
if (failures.length > 0) process.exitCode = 1;
