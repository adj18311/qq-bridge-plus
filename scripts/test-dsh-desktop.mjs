// Tests for discoverDshDesktopOrigins in src/dsh-desktop.js.
// The Windows tooling is injected through run(), so these tests never spawn
// a real process and never touch credentials or user files.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { discoverDshDesktopOrigins } from '../src/dsh-desktop.js';

const WIN32 = 'win32';
const DSH_IMAGE = 'DeepSeek Harness.exe';
const QUOTE = String.fromCharCode(34);
const CRLF = String.fromCharCode(13, 10);
const STDOUT_MARKER = 'SENSITIVE-STDOUT-MARKER';
const STDERR_MARKER = 'SENSITIVE-STDERR-MARKER';
const ERROR_MARKER = 'SENSITIVE-ERROR-MESSAGE';
const ALLOWED_DIAGNOSTIC_KEYS = new Set(['stage', 'status', 'reason', 'elapsedMs', 'code', 'candidateCount']);

function commandKind(file) {
  const base = path.win32.basename(String(file == null ? '' : file)).toLowerCase();
  if (base.startsWith('tasklist')) return 'tasklist';
  if (base.startsWith('netstat')) return 'netstat';
  return 'unknown';
}

function createFakeRun(handlers = {}) {
  const calls = [];
  const run = (file, args, options) => {
    const kind = commandKind(file);
    const list = Array.isArray(args) ? args : args == null ? [] : [args];
    calls.push({ file: String(file), kind, args: list.map(String), options: options || {} });
    const handler = Object.prototype.hasOwnProperty.call(handlers, kind) ? handlers[kind] : undefined;
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          const value = typeof handler === 'function' ? handler(file, args, options) : handler;
          if (value instanceof Error) {
            reject(value);
            return;
          }
          if (value && typeof value.then === 'function') {
            value.then(resolve, reject);
            return;
          }
          resolve(value || { stdout: '', stderr: '' });
        } catch (error) {
          reject(error);
        }
      });
    });
  };
  return { run, calls };
}

function collectDiagnostics() {
  const seen = [];
  const onDiagnostic = (record) => {
    seen.push(record);
  };
  return { seen, onDiagnostic };
}

function csvCell(value) {
  return QUOTE + String(value).split(QUOTE).join(QUOTE + QUOTE) + QUOTE;
}

function tasklistRow(imageName, pid, memUsage = '12,345 K') {
  return [csvCell(imageName), csvCell(pid), csvCell('Console'), csvCell('1'), csvCell(memUsage)].join(',');
}

function tasklistCsv(rows = []) {
  return rows.join(CRLF) + (rows.length > 0 ? CRLF : '');
}

function netstatRow(proto, local, foreign, state, pid) {
  const cells = state == null ? [proto, local, foreign, String(pid)] : [proto, local, foreign, state, String(pid)];
  return '  ' + cells.join('  ');
}

function netstatOutput(rows = []) {
  return ['', 'Active Connections', '', '  Proto  Local Address          Foreign Address        State           PID', ...rows, ''].join(CRLF);
}

function listen(addressPort, pid, proto = 'TCP') {
  return netstatRow(proto, addressPort, proto === 'TCP' ? '0.0.0.0:0' : '*:*', proto === 'TCP' ? 'LISTENING' : null, pid);
}

function fakeCommandError({ message = ERROR_MARKER + ' command failed', code = 1, stderr = STDERR_MARKER, extra = {} } = {}) {
  return Object.assign(new Error(message), { code, stderr }, extra);
}

function failAfter(error, delayMs = 40) {
  return () => new Promise((resolve, reject) => {
    setTimeout(() => reject(error), delayMs);
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let ready = false;
      try {
        ready = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (ready) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(label + ' was not reached in ' + timeoutMs + 'ms'));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function assertUrlSet(actual, expected, label) {
  assert.ok(Array.isArray(actual), label + ': expected an array of URLs');
  for (const url of actual) assert.equal(typeof url, 'string', label + ': every origin must be a string');
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
  assert.equal(new Set(actual).size, actual.length, label + ': origins must be unique');
}

function diagnosticText(record) {
  const parts = [];
  for (const key of ['stage', 'status', 'reason', 'code']) {
    const value = record && record[key];
    if (value !== undefined && value !== null) parts.push(String(value));
  }
  return parts.join(' ').toLowerCase();
}

function saysNoProcess(record) {
  const text = diagnosticText(record);
  return text.includes('no-process') || text.includes('no_process') || text.includes('no process');
}

function saysNoListener(record) {
  const text = diagnosticText(record);
  return text.includes('no-listener') || text.includes('no_listener') || text.includes('no listener');
}

function saysCancelled(record) {
  const text = diagnosticText(record);
  return text.includes('cancel') || text.includes('abort');
}

function assertDiagnostic(seen, predicate, label) {
  const matches = seen.filter(predicate);
  assert.ok(matches.length > 0, label + '; diagnostics: ' + JSON.stringify(seen));
  return matches;
}

function assertSafeDiagnostics(seen, label) {
  for (const record of seen) {
    assert.ok(record && typeof record === 'object' && !Array.isArray(record), label + ': diagnostic must be a plain object');
    for (const key of Object.keys(record)) {
      assert.ok(ALLOWED_DIAGNOSTIC_KEYS.has(key), label + ': diagnostic leaked unexpected field ' + key);
    }
    if (record.stage !== undefined) assert.equal(typeof record.stage, 'string', label + ': stage must be a string');
    if (record.status !== undefined) assert.equal(typeof record.status, 'string', label + ': status must be a string');
    if (record.reason !== undefined) assert.equal(typeof record.reason, 'string', label + ': reason must be a string');
    if (record.code !== undefined) {
      assert.ok(typeof record.code === 'string' || typeof record.code === 'number', label + ': code must be a string or number');
    }
    if (record.elapsedMs !== undefined) {
      assert.equal(typeof record.elapsedMs, 'number', label + ': elapsedMs must be a number');
      assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0, label + ': elapsedMs must be finite and non-negative');
    }
    if (record.candidateCount !== undefined) {
      assert.ok(Number.isInteger(record.candidateCount) && record.candidateCount >= 0, label + ': candidateCount must be a non-negative integer');
    }
  }
  const serialized = JSON.stringify(seen);
  assert.ok(!serialized.includes(STDOUT_MARKER), label + ': diagnostics must not expose stdout');
  assert.ok(!serialized.includes(STDERR_MARKER), label + ': diagnostics must not expose stderr');
  assert.ok(!serialized.includes(ERROR_MARKER), label + ': diagnostics must not expose the error message');
}

test('discovers only loopback origins owned by DeepSeek Harness processes', async () => {
  const fake = createFakeRun({
    tasklist: {
      stdout: tasklistCsv([
        tasklistRow(DSH_IMAGE, '4104', '123,456 K'),
        tasklistRow(DSH_IMAGE, '88', '1,000 K'),
        tasklistRow('explorer.exe', '4560', '98,765 K'),
      ]),
      stderr: STDERR_MARKER,
    },
    netstat: {
      stdout: netstatOutput([
        '  ' + STDOUT_MARKER,
        listen('127.0.0.1:54321', 4104),
        listen('[::1]:54322', 88),
        listen('127.0.0.1:54323', 4560),
        listen('127.0.0.1:54324', 9999),
      ]),
      stderr: STDERR_MARKER,
    },
  });
  const { seen, onDiagnostic } = collectDiagnostics();
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run, onDiagnostic });
  assertUrlSet(urls, ['http://127.0.0.1:54321', 'http://[::1]:54322'], 'only listeners owned by the desktop app are returned');
  assertSafeDiagnostics(seen, 'successful discovery');
});

test('parses tasklist CSV rows whose memory column contains commas', async () => {
  const fake = createFakeRun({
    tasklist: {
      stdout: tasklistCsv([
        tasklistRow(DSH_IMAGE, '1001', '1,234,567 K'),
        tasklistRow('notepad.exe', '456', '10,000 K'),
      ]),
      stderr: '',
    },
    netstat: {
      stdout: netstatOutput([
        listen('127.0.0.1:5001', 1001),
        listen('127.0.0.1:5002', 456),
      ]),
      stderr: '',
    },
  });
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run });
  assertUrlSet(urls, ['http://127.0.0.1:5001'], 'commas in the memory column must not fabricate pids');
});

test('ignores pids that are not positive integers', async () => {
  const fake = createFakeRun({
    tasklist: {
      stdout: tasklistCsv([
        tasklistRow(DSH_IMAGE, '0'),
        tasklistRow(DSH_IMAGE, '-17'),
        tasklistRow(DSH_IMAGE, '12.5'),
        tasklistRow(DSH_IMAGE, 'abc'),
        tasklistRow(DSH_IMAGE, ''),
        tasklistRow(DSH_IMAGE, '77'),
      ]),
      stderr: '',
    },
    netstat: {
      stdout: netstatOutput([
        listen('127.0.0.1:6100', 0),
        listen('127.0.0.1:6101', -17),
        listen('127.0.0.1:6102', 12),
        listen('127.0.0.1:6103', NaN),
        listen('127.0.0.1:6104', 77),
      ]),
      stderr: '',
    },
  });
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run });
  assertUrlSet(urls, ['http://127.0.0.1:6104'], 'only valid positive integer pids may be matched');
});

test('returns no origins when the desktop process is not running', async () => {
  const fake = createFakeRun({
    tasklist: { stdout: 'INFO: No tasks are running which match the specified criteria.' + CRLF, stderr: '' },
    netstat: { stdout: netstatOutput([listen('127.0.0.1:5201', 4242)]), stderr: '' },
  });
  const { seen, onDiagnostic } = collectDiagnostics();
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run, onDiagnostic });
  assertUrlSet(urls, [], 'without a DeepSeek Harness process nothing is trusted');
  assertSafeDiagnostics(seen, 'no process');
});

test('accepts only TCP LISTENING sockets bound to exactly 127.0.0.1 or ::1', async () => {
  const pid = 3003;
  const fake = createFakeRun({
    tasklist: { stdout: tasklistCsv([tasklistRow(DSH_IMAGE, String(pid))]), stderr: '' },
    netstat: {
      stdout: netstatOutput([
        '  协议  本地地址          外部地址        状态           PID',
        listen('127.0.0.1:7101', pid),
        listen('[::1]:7102', pid),
        listen('127.0.0.2:7103', pid),
        listen('127.1.2.3:7104', pid),
        listen('0.0.0.0:7105', pid),
        listen('[::]:7106', pid),
        listen('[::ffff:127.0.0.1]:7107', pid),
        listen('192.168.1.24:7108', pid),
        listen('10.4.0.9:7109', pid),
        netstatRow('UDP', '127.0.0.1:7110', '*:*', null, pid),
        netstatRow('UDP', '0.0.0.0:7111', '*:*', null, pid),
        netstatRow('TCP', '127.0.0.1:49876', '203.0.113.9:443', 'ESTABLISHED', pid),
        netstatRow('TCP', '127.0.0.1:7112', '198.51.100.7:443', 'SYN_SENT', pid),
        listen('127.0.0.1:0', pid),
        listen('127.0.0.1:65536', pid),
        listen('127.0.0.1:999999', pid),
        listen('127.0.0.1:7113', pid),
        listen('127.0.0.1:7113', pid),
      ]),
      stderr: '',
    },
  });
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run });
  assertUrlSet(urls, ['http://127.0.0.1:7101', 'http://[::1]:7102', 'http://127.0.0.1:7113'], 'unexpected socket forms must be rejected');
  assert.equal(urls.length, 3, 'duplicate sockets must be collapsed');
});

test('keeps bracket formatting for IPv6 origins and deduplicates repeats', async () => {
  const pid = 9001;
  const fake = createFakeRun({
    tasklist: { stdout: tasklistCsv([tasklistRow(DSH_IMAGE, String(pid))]), stderr: '' },
    netstat: {
      stdout: netstatOutput([
        listen('127.0.0.1:6400', pid),
        listen('[::1]:6400', pid),
        listen('127.0.0.1:6400', pid),
        listen('[::1]:6400', pid),
      ]),
      stderr: '',
    },
  });
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run });
  assertUrlSet(urls, ['http://127.0.0.1:6400', 'http://[::1]:6400'], 'IPv4 and IPv6 origins are distinct');
  assert.equal(urls.length, 2, 'repeated sockets must be deduplicated');
});

test('starts tasklist and netstat before awaiting either result', async () => {
  const started = [];
  const resolvers = new Map();
  const run = (file) => {
    const kind = commandKind(file);
    started.push(kind);
    return new Promise((resolve) => {
      resolvers.set(kind, resolve);
    });
  };
  const discovery = discoverDshDesktopOrigins({ platform: WIN32, run });
  try {
    await waitUntil(() => started.length >= 2, 2000, 'both Windows commands starting');
    assert.deepEqual([...started].sort(), ['netstat', 'tasklist'], 'both commands must be in flight at the same time');
    resolvers.get('tasklist')({ stdout: tasklistCsv([tasklistRow(DSH_IMAGE, '4242')]), stderr: '' });
    resolvers.get('netstat')({ stdout: netstatOutput([listen('127.0.0.1:8123', 4242)]), stderr: '' });
    const urls = await withTimeout(discovery, 2000, 'discovery after both commands settle');
    assertUrlSet(urls, ['http://127.0.0.1:8123'], 'results are combined after concurrent execution');
  } finally {
    for (const resolve of resolvers.values()) resolve({ stdout: '', stderr: '' });
    await discovery.catch(() => {});
  }
});

test('invokes tasklist and netstat hidden with the documented flags, timeout and signal', async () => {
  const controller = new AbortController();
  const fake = createFakeRun({
    tasklist: { stdout: tasklistCsv([tasklistRow(DSH_IMAGE, '4242')]), stderr: '' },
    netstat: { stdout: netstatOutput([listen('127.0.0.1:8123', 4242)]), stderr: '' },
  });
  const timeoutMs = 1234;
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run, signal: controller.signal, timeoutMs });
  assertUrlSet(urls, ['http://127.0.0.1:8123'], 'baseline discovery');
  const tasklistCall = fake.calls.find((call) => call.kind === 'tasklist');
  const netstatCall = fake.calls.find((call) => call.kind === 'netstat');
  assert.ok(tasklistCall, 'tasklist.exe must be invoked');
  assert.ok(netstatCall, 'netstat.exe must be invoked');
  const tasklistArgs = tasklistCall.args.join(' ').toLowerCase().split(QUOTE).join('');
  assert.ok(tasklistArgs.includes('/fi'), 'tasklist must filter by image name: ' + tasklistArgs);
  assert.ok(tasklistArgs.includes('imagename eq deepseek harness.exe'), 'tasklist must filter the desktop image: ' + tasklistArgs);
  assert.ok(tasklistArgs.includes('/fo') && tasklistArgs.includes('csv'), 'tasklist must emit CSV: ' + tasklistArgs);
  assert.ok(tasklistArgs.includes('/nh'), 'tasklist must skip its header: ' + tasklistArgs);
  const netstatArgs = netstatCall.args.join(' ').toLowerCase();
  const netstatFlags = netstatArgs.includes('-ano') || (netstatArgs.includes('-a') && netstatArgs.includes('-n') && netstatArgs.includes('-o'));
  assert.ok(netstatFlags, 'netstat must run with -ano style flags: ' + netstatArgs);
  for (const call of fake.calls) {
    assert.ok(String(call.file).toLowerCase().endsWith('.exe'), 'only Windows executables may be run: ' + call.file);
    assert.equal(call.options.windowsHide, true, 'child process windows must stay hidden');
    assert.ok(call.options.signal instanceof AbortSignal, 'a valid abort signal must reach the child process');
    assert.equal(call.options.signal.aborted, false, 'the child signal must not start out aborted');
    assert.equal(typeof call.options.timeout, 'number', 'a command timeout must be forwarded');
    assert.ok(call.options.timeout > 0 && call.options.timeout <= timeoutMs, 'command timeout must respect the budget');
  }
  const defaultFake = createFakeRun({
    tasklist: { stdout: tasklistCsv([tasklistRow(DSH_IMAGE, '4242')]), stderr: '' },
    netstat: { stdout: netstatOutput([listen('127.0.0.1:8124', 4242)]), stderr: '' },
  });
  await discoverDshDesktopOrigins({ platform: WIN32, run: defaultFake.run });
  for (const call of defaultFake.calls) {
    assert.equal(typeof call.options.timeout, 'number', 'the default timeout must be forwarded');
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 4000, 'the default timeout budget is 4000ms');
  }
});

test('classifies a failed process listing as a tasklist command failure', async () => {
  const fake = createFakeRun({
    tasklist: failAfter(fakeCommandError({ code: 1 }), 40),
    netstat: { stdout: netstatOutput([listen('127.0.0.1:9200', 4242)]), stderr: STDERR_MARKER },
  });
  const { seen, onDiagnostic } = collectDiagnostics();
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run, onDiagnostic });
  assertUrlSet(urls, [], 'an unreadable process list cannot be trusted');
  assertSafeDiagnostics(seen, 'failed process listing');
  const failed = assertDiagnostic(seen, (record) => record.stage === 'tasklist' && record.status === 'failed' && record.reason === 'command-failed', 'a failed process listing must be reported as a tasklist command failure');
  assert.ok(failed.some((record) => typeof record.elapsedMs === 'number' && record.elapsedMs >= 10), 'the failure must record how long it waited');
  assert.ok(failed.some((record) => record.code === 1 || record.code === '1'), 'the failure code should be recorded safely');
  assert.equal(seen.filter(saysNoProcess).length, 0, 'a failed query must not be reported as no-process');
});

test('classifies a failed socket listing as a netstat command failure without blaming the process query', async () => {
  const fake = createFakeRun({
    tasklist: { stdout: tasklistCsv([tasklistRow(DSH_IMAGE, '4242')]), stderr: STDERR_MARKER },
    netstat: failAfter(fakeCommandError({ code: 'ENOENT' }), 30),
  });
  const { seen, onDiagnostic } = collectDiagnostics();
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run, onDiagnostic });
  assertUrlSet(urls, [], 'an unreadable socket table cannot produce origins');
  assertSafeDiagnostics(seen, 'failed socket listing');
  assertDiagnostic(seen, (record) => record.stage === 'netstat' && record.status === 'failed' && record.reason === 'command-failed', 'a failed socket listing must be reported as a netstat command failure');
  assert.equal(seen.filter(saysNoListener).length, 0, 'a failed socket query must not be reported as no-listener');
  assert.equal(seen.filter(saysNoProcess).length, 0, 'the successful process query must not be reported as no-process');
  assert.ok(seen.some((record) => diagnosticText(record).includes('enoent')), 'the failure code should be recorded safely');
});

test('classifies timed-out Windows commands as timeouts for the matching stage', async () => {
  const timeoutError = fakeCommandError({ code: null, extra: { killed: true, signal: 'SIGTERM', message: ERROR_MARKER + ' timed out' } });
  const tasklistFake = createFakeRun({
    tasklist: failAfter(timeoutError, 30),
    netstat: { stdout: netstatOutput([listen('127.0.0.1:9300', 4242)]), stderr: '' },
  });
  const first = collectDiagnostics();
  const tasklistUrls = await discoverDshDesktopOrigins({ platform: WIN32, run: tasklistFake.run, onDiagnostic: first.onDiagnostic });
  assertUrlSet(tasklistUrls, [], 'a timed out process query yields nothing');
  assertSafeDiagnostics(first.seen, 'timed out process query');
  assertDiagnostic(first.seen, (record) => record.stage === 'tasklist' && record.status === 'timeout' && record.reason === 'timeout', 'a timed out process query must be reported as a tasklist timeout');
  assert.ok(first.seen.some((record) => typeof record.elapsedMs === 'number' && record.elapsedMs >= 10), 'the timeout must record elapsed time');
  assert.equal(first.seen.filter(saysNoProcess).length, 0, 'a timeout must not be reported as no-process');
  const netstatFake = createFakeRun({
    tasklist: { stdout: tasklistCsv([tasklistRow(DSH_IMAGE, '4242')]), stderr: '' },
    netstat: failAfter(timeoutError, 30),
  });
  const second = collectDiagnostics();
  const netstatUrls = await discoverDshDesktopOrigins({ platform: WIN32, run: netstatFake.run, onDiagnostic: second.onDiagnostic });
  assertUrlSet(netstatUrls, [], 'a timed out socket query yields nothing');
  assertSafeDiagnostics(second.seen, 'timed out socket query');
  assertDiagnostic(second.seen, (record) => record.stage === 'netstat' && record.status === 'timeout' && record.reason === 'timeout', 'a timed out socket query must be reported as a netstat timeout');
  assert.equal(second.seen.filter(saysNoListener).length, 0, 'a timeout must not be reported as no-listener');
});

test('skips both commands when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const fake = createFakeRun({
    tasklist: { stdout: tasklistCsv([tasklistRow(DSH_IMAGE, '4242')]), stderr: '' },
    netstat: { stdout: netstatOutput([listen('127.0.0.1:8123', 4242)]), stderr: '' },
  });
  const { seen, onDiagnostic } = collectDiagnostics();
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run, signal: controller.signal, onDiagnostic });
  assertUrlSet(urls, [], 'a cancelled discovery must not report origins');
  assert.equal(fake.calls.length, 0, 'no child process may be spawned after cancellation');
  assertSafeDiagnostics(seen, 'pre-aborted discovery');
  assertDiagnostic(seen, saysCancelled, 'pre-aborted discovery must be classified as cancellation');
  assert.equal(seen.filter(saysNoProcess).length, 0, 'cancellation is not a no-process failure');
  assert.equal(seen.filter(saysNoListener).length, 0, 'cancellation is not a no-listener failure');
});

test('classifies cancellation that happens while the commands are in flight', async () => {
  const controller = new AbortController();
  let startedCount = 0;
  const run = (file, args, options) => {
    startedCount += 1;
    return new Promise((resolve, reject) => {
      const signal = options && options.signal;
      if (!signal) return;
      const onAbort = () => reject(Object.assign(new Error(ERROR_MARKER), { name: 'AbortError', code: 'ABORT_ERR' }));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const { seen, onDiagnostic } = collectDiagnostics();
  const discovery = discoverDshDesktopOrigins({ platform: WIN32, run, signal: controller.signal, onDiagnostic });
  await waitUntil(() => startedCount >= 2, 2000, 'both Windows commands starting');
  controller.abort();
  const urls = await withTimeout(discovery, 2000, 'discovery after cancellation');
  assertUrlSet(urls, [], 'cancelled discovery must not report origins');
  assertSafeDiagnostics(seen, 'cancelled discovery');
  assertDiagnostic(seen, saysCancelled, 'in-flight cancellation must be classified as cancellation');
  assert.equal(seen.filter(saysNoProcess).length, 0, 'cancellation must not be reported as no-process');
});

test('keeps discovering when the diagnostic callback throws', async () => {
  const okFake = createFakeRun({
    tasklist: { stdout: tasklistCsv([tasklistRow(DSH_IMAGE, '4242')]), stderr: '' },
    netstat: { stdout: netstatOutput([listen('127.0.0.1:8123', 4242)]), stderr: '' },
  });
  const okUrls = await discoverDshDesktopOrigins({
    platform: WIN32,
    run: okFake.run,
    onDiagnostic: () => {
      throw new Error('diagnostic callback exploded');
    },
  });
  assertUrlSet(okUrls, ['http://127.0.0.1:8123'], 'a throwing callback must not change the result');
  let failureCalls = 0;
  const failedFake = createFakeRun({
    tasklist: fakeCommandError({ code: 1 }),
    netstat: { stdout: netstatOutput([listen('127.0.0.1:8124', 4242)]), stderr: '' },
  });
  const failedUrls = await discoverDshDesktopOrigins({
    platform: WIN32,
    run: failedFake.run,
    onDiagnostic: () => {
      failureCalls += 1;
      throw new Error('diagnostic callback exploded');
    },
  });
  assertUrlSet(failedUrls, [], 'a throwing callback must not change a failed discovery');
  assert.ok(failureCalls >= 1, 'failure diagnostics must still be emitted when the callback throws');
});

test('accepts an injected clock without changing discovery semantics', async () => {
  const fake = createFakeRun({
    tasklist: { stdout: tasklistCsv([tasklistRow(DSH_IMAGE, '4242')]), stderr: '' },
    netstat: { stdout: netstatOutput([listen('127.0.0.1:8130', 4242)]), stderr: '' },
  });
  const { seen, onDiagnostic } = collectDiagnostics();
  let clock = 5000;
  const now = () => {
    clock += 25;
    return clock;
  };
  const urls = await discoverDshDesktopOrigins({ platform: WIN32, run: fake.run, now, onDiagnostic });
  assertUrlSet(urls, ['http://127.0.0.1:8130'], 'an injected clock must not change discovery');
  assertSafeDiagnostics(seen, 'injected clock');
  for (const record of seen) {
    if (record.elapsedMs !== undefined) {
      assert.equal(record.elapsedMs % 25, 0, 'elapsedMs must come from the injected clock');
    }
  }
});

test('reports the real netstat failure instead of the cancelled tasklist peer', async () => {
  const run = (file, args, options) => {
    if (commandKind(file) === 'netstat') {
      return Promise.reject(Object.assign(new Error(ERROR_MARKER), { code: 'ENOENT' }));
    }
    return new Promise((resolve, reject) => {
      const signal = options && options.signal;
      const onAbort = () => reject(Object.assign(new Error(ERROR_MARKER), { name: 'AbortError', code: 'ABORT_ERR' }));
      if (!signal) return;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const { seen, onDiagnostic } = collectDiagnostics();
  const urls = await withTimeout(
    discoverDshDesktopOrigins({ platform: WIN32, run, onDiagnostic }),
    2000,
    'netstat root-cause discovery',
  );
  assertUrlSet(urls, [], 'a failed netstat must not report origins');
  assertSafeDiagnostics(seen, 'netstat root-cause discovery');
  const failure = seen.find((record) => record.stage === 'netstat');
  assert.ok(failure, 'the real netstat failure must be reported');
  assert.equal(failure.status, 'failed', 'the failing command must be classified as failed');
  assert.equal(failure.reason, 'command-failed', 'the netstat failure must keep its own reason');
  assert.equal(failure.code, 'ENOENT', 'a recognized OS error code must be preserved');
  assert.ok(Number.isInteger(failure.elapsedMs) && failure.elapsedMs >= 0, 'the netstat failure must carry its own elapsedMs');
  assert.equal(seen.filter(saysNoProcess).length, 0, 'a cancelled tasklist is not a no-process result');
});

test('reports the first real failure when both parallel commands fail', async () => {
  const run = (file) => {
    if (commandKind(file) === 'netstat') {
      return Promise.reject(Object.assign(new Error(ERROR_MARKER), { code: 'ENOENT' }));
    }
    return Promise.resolve().then(() => {
      throw Object.assign(new Error(ERROR_MARKER), { code: 'EACCES' });
    });
  };
  const { seen, onDiagnostic } = collectDiagnostics();
  const urls = await withTimeout(
    discoverDshDesktopOrigins({ platform: WIN32, run, onDiagnostic }),
    2000,
    'first real failure discovery',
  );
  assertUrlSet(urls, [], 'failed commands must not report origins');
  assertSafeDiagnostics(seen, 'first real failure discovery');
  const failure = seen.find((record) => record.stage === 'netstat' || record.stage === 'tasklist');
  assert.ok(failure, 'the first real failure must be reported');
  assert.equal(failure.stage, 'netstat', 'the command that failed first is the root cause');
  assert.equal(failure.code, 'ENOENT', 'the root cause keeps its OS error code');
});

test('measures in-flight cancellation with the injected clock instead of a hardcoded zero', async () => {
  const controller = new AbortController();
  let startedCount = 0;
  const run = (file, args, options) => {
    startedCount += 1;
    return new Promise((resolve, reject) => {
      const signal = options && options.signal;
      const onAbort = () => reject(Object.assign(new Error(ERROR_MARKER), { name: 'AbortError', code: 'ABORT_ERR' }));
      if (!signal) return;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const { seen, onDiagnostic } = collectDiagnostics();
  let clock = 1000;
  const now = () => {
    clock += 30;
    return clock;
  };
  const discovery = discoverDshDesktopOrigins({ platform: WIN32, run, now, signal: controller.signal, onDiagnostic });
  await waitUntil(() => startedCount >= 2, 2000, 'both Windows commands starting');
  controller.abort();
  const urls = await withTimeout(discovery, 2000, 'cancelled discovery with injected clock');
  assertUrlSet(urls, [], 'cancelled discovery must not report origins');
  assertSafeDiagnostics(seen, 'cancelled discovery with injected clock');
  const cancelled = seen.find(saysCancelled);
  assert.ok(cancelled, 'in-flight cancellation must be reported');
  assert.ok(cancelled.elapsedMs > 0, 'cancellation must report the real elapsed time, not a hardcoded zero');
  assert.equal(cancelled.elapsedMs % 30, 0, 'cancelled elapsedMs must come from the injected clock');
});

test('does not publish an unrecognized error code when a command fails', async () => {
  const run = (file, args, options) => {
    if (commandKind(file) === 'tasklist') {
      return Promise.reject(Object.assign(new Error(ERROR_MARKER), { code: 'LEAK-' + ERROR_MARKER }));
    }
    return new Promise((resolve, reject) => {
      const signal = options && options.signal;
      const onAbort = () => reject(Object.assign(new Error(ERROR_MARKER), { name: 'AbortError', code: 'ABORT_ERR' }));
      if (!signal) return;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const { seen, onDiagnostic } = collectDiagnostics();
  const urls = await withTimeout(
    discoverDshDesktopOrigins({ platform: WIN32, run, onDiagnostic }),
    2000,
    'unsafe error code discovery',
  );
  assertUrlSet(urls, [], 'a failed tasklist must not report origins');
  const failure = seen.find((record) => record.stage === 'tasklist');
  assert.ok(failure, 'the tasklist failure must still be reported');
  assert.equal(failure.reason, 'command-failed', 'the failure reason must stay generic');
  assert.equal(failure.code, undefined, 'an unrecognized code string must not be published');
  assert.equal(JSON.stringify(seen).includes(ERROR_MARKER), false, 'sensitive error code text must never leak into diagnostics');
  assertSafeDiagnostics(seen, 'unsafe error code discovery');
});

test('never runs Windows tools on non-Windows platforms', async () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const fake = createFakeRun({});
    const { seen, onDiagnostic } = collectDiagnostics();
    const urls = await discoverDshDesktopOrigins({ platform, run: fake.run, onDiagnostic });
    assertUrlSet(urls, [], platform + ' must not report Windows origins');
    assert.equal(fake.calls.length, 0, platform + ' must not spawn tasklist or netstat');
    assertSafeDiagnostics(seen, platform);
  }
});
