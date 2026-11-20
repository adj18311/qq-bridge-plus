// Corrects a claim I put in four documents: "仅首 step 可绑定 ⇒ 每回合最多一次空间调用".
//
// The second half is wrong. What the ledger actually enforces is *which step* may bind,
// not *how many calls* that step may contain. The first step of a turn is the only one
// that claims the QQ user message (`dsh-agent-loop` `claim()`), and `observeToolCall`
// binds every callId observed inside a step whose `steps` entry cites a registered
// request — so ONE step can carry N independent space calls.
//
// This probe counts them: same turn, same step, N distinct callIds, each dispatched.
// The point is to replace a guessed product statement with a measured one before it
// hardens into a requirement.

import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const DAY = Date.parse('2026-11-12T04:00:00Z');
const SESSION = 'session-perstep';
const BOT = 123;
const POST = { tid: 'p1', content: 'hello from the friend', time: Math.floor(DAY / 1000) - 3600 };

function store() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [],
  };
  return {
    read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return structuredClone(state); },
  };
}

const platform = [];

function runtimeFor(ledger) {
  return createQzoneRuntime({
    store: store(), botQq: BOT, mode: 'enabled', trackingLimit: 4096,
    getConnectionEpoch: () => 1, sourceEpoch: 'epoch-1',
    authorizeSource: () => true,
    clock: () => NOW,
    // The shapes below are copied from `scripts/qzone-r10-candidate-b-rotation.mjs`, which
    // is known-good: `get_login_info` must expose `data.user_id`, and `get_friend_list`
    // must return an ARRAY under `data`. Getting either wrong makes the friendship gate
    // fail silently and every read comes back `read-denied`, which looks like a
    // permission problem rather than a fixture problem. (First run of this probe did
    // exactly that: 13 reads, 52 platform calls, zero `ok`.)
    call: async (action, params) => {
      platform.push({ action, params });
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: BOT } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      return { status: 'ok', retcode: 0, data: { total: 1, msglist: [POST] } };
    },
    getBridgeSessions: () => ledger,
  });
}

// Count how many distinct space calls one single step can carry.
async function callsPerStep(count) {
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'epoch-1', trackingLimit: 4096 });
  const runtime = runtimeFor(ledger);
  const turn = 1;
  const requestId = 'rpc-1';
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  const bound = ledger.observeStep({
    sessionId: SESSION, turn, step: 1,
    messages: [{ role: 'user', source: { rpcId: requestId } }],
  });
  const callIds = [];
  for (let i = 0; i < count; i += 1) callIds.push(`call-${i + 1}`);
  for (const callId of callIds) {
    ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn, step: 1, callId, name: 'qzone_read_posts' } } });
  }
  const results = [];
  for (const callId of callIds) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runtime.dispatch('read_posts', { target_uin: 456 }, { sessionId: SESSION, callId }));
  }
  // Now the same turn, SECOND step (an empty continuation): does it bind?
  const secondStepBound = ledger.observeStep({ sessionId: SESSION, turn, step: 2, messages: [] });
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn, step: 2, callId: 'call-step2', name: 'qzone_read_posts' } } });
  const secondStep = await runtime.dispatch('read_posts', { target_uin: 456 }, { sessionId: SESSION, callId: 'call-step2' });
  ledger.endTurn({ sessionId: SESSION, turn });
  return {
    requested: count,
    stepOneBound: bound,
    okCount: results.filter((r) => r?.ok === true && r?.outcome === 'success').length,
    codes: results.map((r) => (r?.ok === true ? `ok:${r.outcome}` : `err:${r.error}`)),
    secondStepBound,
    secondStep,
  };
}

const one = await callsPerStep(1);
const four = await callsPerStep(4);
const eight = await callsPerStep(8);

const report = {
  probe: 'calls-per-step',
  one: { requested: one.requested, okCount: one.okCount, codes: one.codes, secondStepBound: one.secondStepBound, secondStep: one.secondStep },
  four: { requested: four.requested, okCount: four.okCount, codes: four.codes },
  eight: { requested: eight.requested, okCount: eight.okCount, codes: eight.codes },
  secondStepNeverBinds: one.secondStepBound === false && one.secondStep?.ok === false,
  multiCallPerStepWorks: four.okCount === 4 && eight.okCount === 8,
  platformCalls: platform.length,
  // The corrected statement, stated as data rather than prose.
  correctedStatement: '每回合只有「认领了用户消息的那个 step」可以绑定；同一 step 内可以有多次独立空间调用。',
  wrongStatement: '每回合最多一次空间调用。',
};
console.log(JSON.stringify(report, null, 2));

const failures = [];
if (!report.secondStepNeverBinds) failures.push('second step should never bind');
if (!report.multiCallPerStepWorks) failures.push('multiple calls in the claiming step should all succeed');
if (report.correctedStatement === report.wrongStatement) failures.push('statements must differ');
console.log(JSON.stringify({ done: true, failures }));
if (failures.length > 0) process.exitCode = 1;
