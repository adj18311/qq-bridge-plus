// DSH 0.2.1 desktop binds an OS-selected port. Inspect only its own processes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WIN32 = 'win32';
const DESKTOP_IMAGE_NAME = 'DeepSeek Harness.exe';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const TASKLIST_ARGS = ['/FI', 'IMAGENAME eq ' + DESKTOP_IMAGE_NAME, '/FO', 'CSV', '/NH'];
const NETSTAT_ARGS = ['-ano'];
const LOOPBACK_SOCKET = /^(127\.0\.0\.1|\[::1\]):(\d{1,5})$/;

function defaultRun(file, args, options) {
  return execFileAsync(file, args, options);
}

function emitDiagnostic(onDiagnostic, record) {
  if (typeof onDiagnostic !== 'function') return;
  try {
    onDiagnostic(record);
  } catch {
    // Diagnostics are best-effort and must never affect discovery.
  }
}

function isStringResult(result) {
  return Boolean(result) && typeof result.stdout === 'string';
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      fields.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

function collectDesktopPids(stdout) {
  const pids = new Set();
  const lines = stdout.split(/\r\n|\n|\r/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const fields = parseCsvLine(line);
    if (fields.length < 2) continue;
    if (fields[0].trim().toLowerCase() !== DESKTOP_IMAGE_NAME.toLowerCase()) continue;
    const pidText = fields[1].trim();
    if (!/^\d+$/.test(pidText)) continue;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    pids.add(pid);
  }
  return pids;
}

function collectLoopbackOrigins(stdout, pids) {
  const origins = [];
  const seen = new Set();
  const lines = stdout.split(/\r\n|\n|\r/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 5) continue;
    const protocol = fields[0];
    const localAddress = fields[1];
    const state = fields[3];
    const pidText = fields[4];
    if (protocol.toUpperCase() !== 'TCP') continue;
    if (state.toUpperCase() !== 'LISTENING') continue;
    if (!/^\d+$/.test(pidText)) continue;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !pids.has(pid)) continue;
    const match = LOOPBACK_SOCKET.exec(localAddress);
    if (!match) continue;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const origin = 'http://' + (match[1] === '127.0.0.1' ? '127.0.0.1' : '[::1]') + ':' + port;
    if (seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
  }
  return origins;
}

const RECOGNIZED_OS_ERROR_CODES = new Set([
  'E2BIG', 'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EAGAIN', 'EALREADY',
  'EBADF', 'EBADMSG', 'EBUSY', 'ECANCELED', 'ECHILD', 'ECONNABORTED', 'ECONNREFUSED',
  'ECONNRESET', 'EDEADLK', 'EDESTADDRREQ', 'EDOM', 'EDQUOT', 'EEXIST', 'EFAULT', 'EFBIG',
  'EHOSTDOWN', 'EHOSTUNREACH', 'EIDRM', 'EILSEQ', 'EINPROGRESS', 'EINTR', 'EINVAL', 'EIO',
  'EISCONN', 'EISDIR', 'ELOOP', 'EMFILE', 'EMLINK', 'EMSGSIZE', 'ENAMETOOLONG', 'ENETDOWN',
  'ENETRESET', 'ENETUNREACH', 'ENFILE', 'ENOBUFS', 'ENODATA', 'ENODEV', 'ENOENT', 'ENOEXEC',
  'ENOLCK', 'ENOLINK', 'ENOMEM', 'ENOMSG', 'ENOPROTOOPT', 'ENOSPC', 'ENOSR', 'ENOSTR',
  'ENOSYS', 'ENOTCONN', 'ENOTDIR', 'ENOTEMPTY', 'ENOTRECOVERABLE', 'ENOTSOCK', 'ENOTSUP',
  'ENOTTY', 'ENXIO', 'EOPNOTSUPP', 'EOVERFLOW', 'EOWNERDEAD', 'EPERM', 'EPIPE', 'EPROTO',
  'EPROTONOSUPPORT', 'EPROTOTYPE', 'ERANGE', 'EROFS', 'ESPIPE', 'ESRCH', 'ESTALE', 'ETIME',
  'ETIMEDOUT', 'ETXTBSY', 'EWOULDBLOCK', 'EXDEV',
]);

function normalizeFailureCode(code) {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && RECOGNIZED_OS_ERROR_CODES.has(code)) return code;
  return undefined;
}

function classifyCommandFailure(error) {
  const name = error && typeof error.name === 'string' ? error.name : '';
  const code = error && error.code !== undefined ? error.code : undefined;
  if (name === 'AbortError' || code === 'ABORT_ERR') {
    return { cleanup: true };
  }
  const killed = Boolean(error && error.killed);
  const signal = error && typeof error.signal === 'string' ? error.signal : '';
  if (killed || code === 'ETIMEDOUT' || name === 'TimeoutError' || signal === 'SIGTERM') {
    return { cleanup: false, status: 'timeout', reason: 'timeout', code: 'ETIMEDOUT' };
  }
  const safeCode = normalizeFailureCode(code);
  const failure = { cleanup: false, status: 'failed', reason: 'command-failed' };
  if (safeCode !== undefined) failure.code = safeCode;
  return failure;
}

export async function discoverDshDesktopOrigins(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const platform = settings.platform === undefined ? process.platform : settings.platform;
  if (platform !== WIN32) return [];

  const run = typeof settings.run === 'function' ? settings.run : defaultRun;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const timeoutMs = Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : DEFAULT_TIMEOUT_MS;
  const onDiagnostic = typeof settings.onDiagnostic === 'function' ? settings.onDiagnostic : null;
  const externalSignal = settings.signal
    && typeof settings.signal === 'object'
    && typeof settings.signal.aborted === 'boolean'
    && typeof settings.signal.addEventListener === 'function'
    ? settings.signal
    : null;

  const discoveryStartedAt = now();
  let settleSequence = 0;

  if (externalSignal && externalSignal.aborted) {
    emitDiagnostic(onDiagnostic, {
      stage: 'discovery',
      status: 'cancelled',
      reason: 'cancelled',
      elapsedMs: Math.max(0, now() - discoveryStartedAt),
    });
    return [];
  }

  const controller = new AbortController();
  let externalCancelled = false;
  const handleExternalAbort = () => {
    externalCancelled = true;
    controller.abort();
  };
  if (externalSignal) externalSignal.addEventListener('abort', handleExternalAbort, { once: true });

  const childOptions = {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    signal: controller.signal,
  };

  const startCommand = (file, args) => {
    const startedAt = now();
    let pending;
    try {
      pending = Promise.resolve(run(file, args, childOptions));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (result) => {
        settleSequence += 1;
        return {
          ok: true,
          result: result || {},
          elapsedMs: Math.max(0, now() - startedAt),
          settledOrder: settleSequence,
        };
      },
      (error) => {
        if (error && !externalCancelled) controller.abort();
        settleSequence += 1;
        return {
          ok: false,
          error,
          elapsedMs: Math.max(0, now() - startedAt),
          settledOrder: settleSequence,
        };
      },
    );
  };

  const tasklistTask = startCommand('tasklist.exe', TASKLIST_ARGS);
  const netstatTask = startCommand('netstat.exe', NETSTAT_ARGS);

  let tasklistOutcome;
  let netstatOutcome;
  try {
    [tasklistOutcome, netstatOutcome] = await Promise.all([tasklistTask, netstatTask]);
  } finally {
    if (externalSignal) externalSignal.removeEventListener('abort', handleExternalAbort);
  }

  if (externalCancelled) {
    emitDiagnostic(onDiagnostic, {
      stage: 'discovery',
      status: 'cancelled',
      reason: 'cancelled',
      elapsedMs: Math.max(0, now() - discoveryStartedAt),
    });
    return [];
  }

  const tasklistFailure = tasklistOutcome.ok ? null : classifyCommandFailure(tasklistOutcome.error);
  const netstatFailure = netstatOutcome.ok ? null : classifyCommandFailure(netstatOutcome.error);

  if (tasklistFailure) {
    // A command that fails first aborts its sibling, so the survivor can be a
    // peer AbortError. Report the first real failure, never the peer cleanup.
    const failures = [];
    if (!tasklistFailure.cleanup) {
      failures.push({ stage: 'tasklist', outcome: tasklistOutcome, failure: tasklistFailure });
    }
    if (netstatFailure && !netstatFailure.cleanup) {
      failures.push({ stage: 'netstat', outcome: netstatOutcome, failure: netstatFailure });
    }
    failures.sort((left, right) => left.outcome.settledOrder - right.outcome.settledOrder);
    if (failures.length > 0) {
      const root = failures[0];
      const record = {
        stage: root.stage,
        status: root.failure.status,
        reason: root.failure.reason,
        elapsedMs: root.outcome.elapsedMs,
      };
      if (root.failure.code !== undefined) record.code = root.failure.code;
      emitDiagnostic(onDiagnostic, record);
    }
    return [];
  }

  if (!isStringResult(tasklistOutcome.result)) {
    emitDiagnostic(onDiagnostic, {
      stage: 'tasklist',
      status: 'failed',
      reason: 'parse-failed',
      elapsedMs: tasklistOutcome.elapsedMs,
    });
    return [];
  }

  const pids = collectDesktopPids(tasklistOutcome.result.stdout);
  if (pids.size === 0) {
    emitDiagnostic(onDiagnostic, {
      stage: 'process',
      status: 'empty',
      reason: 'no-process',
      elapsedMs: tasklistOutcome.elapsedMs,
      candidateCount: 0,
    });
    return [];
  }
  emitDiagnostic(onDiagnostic, {
    stage: 'process',
    status: 'success',
    elapsedMs: tasklistOutcome.elapsedMs,
    candidateCount: pids.size,
  });

  if (netstatFailure) {
    if (!netstatFailure.cleanup) {
      const record = {
        stage: 'netstat',
        status: netstatFailure.status,
        reason: netstatFailure.reason,
        elapsedMs: netstatOutcome.elapsedMs,
      };
      if (netstatFailure.code !== undefined) record.code = netstatFailure.code;
      emitDiagnostic(onDiagnostic, record);
    }
    return [];
  }

  if (!isStringResult(netstatOutcome.result)) {
    emitDiagnostic(onDiagnostic, {
      stage: 'netstat',
      status: 'failed',
      reason: 'parse-failed',
      elapsedMs: netstatOutcome.elapsedMs,
    });
    return [];
  }

  const origins = collectLoopbackOrigins(netstatOutcome.result.stdout, pids);
  if (origins.length === 0) {
    emitDiagnostic(onDiagnostic, {
      stage: 'listener',
      status: 'empty',
      reason: 'no-listener',
      elapsedMs: netstatOutcome.elapsedMs,
      candidateCount: 0,
    });
    return [];
  }
  emitDiagnostic(onDiagnostic, {
    stage: 'listener',
    status: 'success',
    elapsedMs: netstatOutcome.elapsedMs,
    candidateCount: origins.length,
  });
  return origins;
}
