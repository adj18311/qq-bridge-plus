// Measures the memory actually retained by callIds that the ledger is asked to
// observe. Run with `--expose-gc` so the baseline is a settled heap.
//
// This exists because the length gate in `observeToolCall` is only useful if it runs
// BEFORE `spentCalls.add`: `spentCalls` is never pruned, so recording an over-long id
// first and rejecting it afterwards retains the string for the life of the ledger.
// Behaviour is identical either way (the call still fails closed), which is exactly
// why an assertion on return values cannot see the difference — only retained bytes
// can. Reported as JSON so the caller can assert on a threshold.
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const COUNT = 64;
const ID_LENGTH = 1024 * 1024;

const settled = () => {
  global.gc();
  global.gc();
  const usage = process.memoryUsage();
  return { external: usage.external, heapUsed: usage.heapUsed };
};

const ledger = createQzoneOriginLedger({ sessionId: 's', epoch: 'e1', trackingLimit: 4096 });
ledger.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
ledger.observeStep({ sessionId: 's', turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }] });

const before = settled();
const refused = [];
for (let index = 0; index < COUNT; index++) {
  // A distinct id each time: duplicates would be rejected by `spentCalls` and never
  // reach the length gate, which is what this probe must exercise.
  const callId = `${String(index).padStart(4, '0')}${'x'.repeat(ID_LENGTH)}`;
  refused.push(ledger.observeToolCall({ sessionId: 's', event: { type: 'tool/call', data: { turn: 1, step: 1, callId } } }));
}
const after = settled();

// The position must still be usable: rejecting the ids must not spend the slot.
const normalBound = ledger.observeToolCall({ sessionId: 's',
  event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c-ok' } } });
const normalConsumed = ledger.consume({ sessionId: 's', turn: 1, step: 1, callId: 'c-ok' }) !== null;

process.stdout.write(`${JSON.stringify({
  count: COUNT,
  idLength: ID_LENGTH,
  allRefused: refused.every((value) => value === false),
  retainedMB: Number(((after.heapUsed - before.heapUsed) / (1024 * 1024)).toFixed(2)),
  retainedExternalMB: Number(((after.external - before.external) / (1024 * 1024)).toFixed(2)),
  normalBound,
  normalConsumed,
})}\n`);
