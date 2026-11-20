// Measures the real per-entry cost of a `positions` entry, and what a full table costs.
//
// Why this probe exists: `MAX_POSITIONS = 4096` is a single GLOBAL ceiling, and eleven
// review rounds kept arguing about whether the memory matters or the availability does.
// The argument is unresolvable without a number, and the number depends on details that
// are easy to get wrong:
//   * `positions` keys are `JSON.stringify([sessionId, callId])` — a 40-odd character
//     string per entry, not the object alone;
//   * the value is a frozen `{ sessionId, turn, step }` object;
//   * V8's `heapUsed` is noisy at the ±1 MB scale, so a single sample proves nothing.
// So: measure the DELTA across three table sizes, repeat it, and report the spread.
//
// Run with: node --expose-gc scripts/qzone-position-cost-probe.mjs

import { createQzonePluginHandle, MAX_POSITIONS } from '../plugins/qzone-safe/index.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const SESSION = 'session-cost';
const TOOL = 'qzone_read_posts';

// `createQzonePluginHandle` is ASYNC — forgetting the await yields a Promise, and every
// `handle.xxx` on it is undefined. (First run of this probe died on exactly that:
// `TypeError: handle.dispose is not a function`.)
async function makeHandle() {
  const callbacks = new Map();
  const registered = new Map();
  const ctx = {
    on: (name, fn) => { const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); return () => {}; },
    tools: { register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  };
  const ledgers = new Map();
  const lifetime = {
    sourceEpoch: () => 'e1',
    getLedger: (sessionId) => {
      let ledger = ledgers.get(sessionId);
      if (!ledger) { ledger = createQzoneOriginLedger({ sessionId, epoch: 'e1', trackingLimit: 4096 }); ledgers.set(sessionId, ledger); }
      return ledger;
    },
    rotate() {}, ownsConsumption: () => false,
  };
  const handle = await createQzonePluginHandle(ctx, { enabled: true }, {
    epoch: 'e1', defineTool: (tool) => tool, dispatch: async () => ({ ok: true }), sourceLifetime: lifetime,
  });
  return { handle, emit: (name, ...args) => { for (const cb of callbacks.get(name) ?? []) cb(...args); } };
}

// One announce = one `session/event` carrying a tool/call. This is the ONLY writer of
// `positions`; the count therefore equals the number of live announces.
function announce(emit, index) {
  emit('session/event', { id: SESSION }, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: `call-${String(index).padStart(6, '0')}`, name: TOOL },
  });
}

function heapMB() {
  global.gc();
  return process.memoryUsage().heapUsed / 1048576;
}

async function measure(count, repeats) {
  const deltas = [];
  for (let r = 0; r < repeats; r += 1) {
    const { handle, emit } = await makeHandle();
    // One agent/created so the adapter exists; not required for positions, but keeps the
    // handle in the same shape it has in production.
    emit('agent/created', { agent: { id: 'a1', session: { id: SESSION }, ctx: { on: () => () => {} } } });
    const before = heapMB();
    for (let i = 0; i < count; i += 1) announce(emit, i);
    const after = heapMB();
    deltas.push(after - before);
    // eslint-disable-next-line no-await-in-loop
    await handle.dispose();
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  return { count, deltas: deltas.map((d) => +d.toFixed(3)), meanMB: +mean.toFixed(3) };
}

if (typeof global.gc !== 'function') {
  console.log(JSON.stringify({ error: 'run with --expose-gc' }));
  process.exitCode = 1;
} else {
  const small = await measure(512, 3);
  const medium = await measure(2048, 3);
  const full = await measure(MAX_POSITIONS, 3);

  // Bytes per entry from the two spans that are far apart enough to be above the noise.
  const perEntrySmall = (small.meanMB * 1048576) / small.count;
  const perEntryFull = (full.meanMB * 1048576) / full.count;
  const spreadMB = Math.max(...full.deltas) - Math.min(...full.deltas);

  console.log(JSON.stringify({
    probe: 'position-cost',
    maxPositions: MAX_POSITIONS,
    small, medium, full,
    bytesPerEntry: { fromSmall: +perEntrySmall.toFixed(1), fromFull: +perEntryFull.toFixed(1) },
    fullTableMB: +full.meanMB.toFixed(2),
    // Stated honestly: if the run-to-run spread is a large fraction of the mean, the
    // per-entry figure is an order-of-magnitude reading, not a measurement.
    noiseMB: +spreadMB.toFixed(3),
    perEntryIsOrderOfMagnitudeOnly: spreadMB > full.meanMB * 0.25,
    note: 'heapUsed includes key strings (JSON.stringify of the pair), frozen value objects, Map overhead and V8 slack; it does not include anything the caller keeps.',
  }));
}
