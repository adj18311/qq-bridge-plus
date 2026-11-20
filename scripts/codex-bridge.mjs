// scripts/codex-bridge.mjs
// task-64：DSH ↔ Codex CLI 桥（本地脚本 + 可测试模块；离线测试注入 fake runner）。
//
// 用途：把任务交给 Codex CLI（`codex exec`），保存 thread_id，支持 `codex exec resume` 续聊。
// 安全边界（固定，不提供覆盖开关）：
//  · exec：`-s read-only` + `-c approval_policy="never"` + `--skip-git-repo-check`；
//  · resume：`-c sandbox_mode="read-only"` + `-c approval_policy="never"` + `--skip-git-repo-check`；
//  · 拒绝任何 `sandbox/approval/bypass` 覆盖参数；不提供 dangerously-bypass；
//  · 不用 shell:true；cwd 必须是已存在目录；prompt ≤32KB；默认 180s 超时并杀进程；不重试。
// 状态：默认 `%USERPROFILE%\.codex-bridge\state.json`（仓库外；CODEX_BRIDGE_STATE 可覆盖），
// 原子写（tmp+rename）、0600、历史最多 20 轮，只存 prompt 摘要/reply/at/threadId/usage。
// 本模块不读/写正式 config/profile/state；只有 CLI 显式调用才会运行 Codex。

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CODEX_BRIDGE_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MAX_PROMPT_BYTES = 32 * 1024;
export const MAX_HISTORY = 20;
export const DEFAULT_WAIT_REPLY_MS = 15_000;
export const MAX_WAIT_REPLY_MS = 300_000;
export const DEFAULT_POLL_INTERVAL_MS = 500;
const THREAD_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
export const MAX_CAPTURED_STDERR = 16 * 1024;
export const MAX_ERROR_STDERR = 400;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const UNSAFE_OPTION_KEYS = new Set([
  'sandbox', 'sandbox_mode', 'sandboxMode', 'approval', 'approval_policy', 'approvalPolicy',
  'dangerouslyBypassApprovalsAndSandbox', 'dangerously_bypass_approvals_and_sandbox', 'bypass',
]);
const SEND_OPTION_KEYS = new Set(['cwd', 'timeoutMs', 'model']);
const CONTINUE_OPTION_KEYS = new Set(['cwd', 'timeoutMs', 'model', 'threadId', 'waitReplyMs']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function homeDir(env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function defaultStatePath(env) {
  if (typeof env.CODEX_BRIDGE_STATE === 'string' && env.CODEX_BRIDGE_STATE.trim() !== '') {
    return path.resolve(env.CODEX_BRIDGE_STATE);
  }
  return path.join(homeDir(env), '.codex-bridge', 'state.json');
}

/** 只读解析 CLI 候选是否存在（不执行）。 */
export async function resolveCodexCli({ env = process.env, fs: fsOps = fs, platform = process.platform } = {}) {
  if (typeof env.CODEX_CLI === 'string' && env.CODEX_CLI.trim() !== '') {
    const explicit = path.resolve(env.CODEX_CLI.trim());
    try {
      await fsOps.access(explicit, fsSync.constants.X_OK);
      return explicit;
    } catch {
      throw codedError('codex-cli-invalid', `CODEX_CLI 指向的文件不可用：${explicit}`);
    }
  }

  const binDir = env.LOCALAPPDATA === undefined
    ? null
    : path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  if (binDir !== null) {
    try {
      const entries = await fsOps.readdir(binDir);
      const candidates = [];
      for (const entry of entries) {
        if (!entry || entry.startsWith('.')) continue;
        const dirPath = path.join(binDir, entry);
        try {
          const stat = await fsOps.stat(dirPath);
          if (stat.isDirectory()) candidates.push({ dirPath, mtimeMs: Number(stat.mtimeMs) || 0 });
        } catch {
          // ignore
        }
      }
      candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
      for (const candidate of candidates) {
        const cliPath = path.join(candidate.dirPath, platform === 'win32' ? 'codex.exe' : 'codex');
        try {
          await fsOps.access(cliPath, fsSync.constants.X_OK);
          return cliPath;
        } catch {
          // try next
        }
      }
    } catch {
      // fall through to PATH
    }
  }

  const pathValue = typeof env.PATH === 'string' ? env.PATH : (typeof env.Path === 'string' ? env.Path : '');
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.trim() === '') continue;
    const candidate = path.join(dir.trim(), executable);
    try {
      await fsOps.access(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  throw codedError('codex-cli-not-found', '找不到 Codex CLI；请设置 CODEX_CLI 或安装/登录 Codex');
}

/** 固定 exec 参数（只读沙箱、approval never、跳过 git 检查；prompt 作为最后一个 argv，不经 shell）。 */
export function buildExecArgs({ cwd, prompt, model }) {
  const args = [
    'exec', '--json', '-C', cwd, '-s', 'read-only',
    '-c', 'approval_policy="never"', '--skip-git-repo-check',
  ];
  if (model !== undefined && model !== null) args.push('-m', String(model));
  args.push(String(prompt));
  return args;
}

/** 固定 resume 参数（resume 不支持 -s，用 -c 覆盖只读沙箱；approval never；必须带 --json 才有 JSONL 事件）。 */
export function buildResumeArgs({ threadId, prompt, model }) {
  const args = [
    'exec', 'resume', String(threadId),
    '--json',
    '-c', 'sandbox_mode="read-only"',
    '-c', 'approval_policy="never"',
    '--skip-git-repo-check',
  ];
  if (model !== undefined && model !== null) args.push('-m', String(model));
  args.push(String(prompt));
  return args;
}

/** 解析 `codex exec --json` 的 JSONL：未知事件忽略；重复 agent_message 取最后一个。 */
export function parseCodexJsonl(stdout) {
  const result = { threadId: null, reply: null, usage: null, errors: [] };
  if (typeof stdout !== 'string') return result;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(event)) continue;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id !== '') {
      result.threadId = event.thread_id;
    } else if (event.type === 'item.completed' && isPlainObject(event.item)) {
      if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
        result.reply = event.item.text;
      }
    } else if (event.type === 'turn.completed') {
      if (isPlainObject(event.usage)) result.usage = event.usage;
    } else if (event.type === 'error' && typeof event.message === 'string') {
      result.errors.push(event.message);
    }
  }
  return result;
}


/** queue 模式参数（活动会话自身权限；不提供任何 sandbox/approval 绕过参数）。 */
export function buildQueueArgs({ threadId, prompt }) {
  return ['queue', '--thread', String(threadId), '--message', String(prompt)];
}

function isActiveWriterFailure(runResult) {
  if (!isPlainObject(runResult)) return false;
  const text = `${runResult.stdout ?? ''}\n${runResult.stderr ?? ''}`;
  return /already has an active writer|active writer|-32600|32600/i.test(text);
}

function parseQueuedMessageId(stdout) {
  if (typeof stdout !== 'string') return null;
  const match = stdout.match(/Queued message\s+(\S+)\s+for thread/i);
  return match === null ? null : match[1];
}

function collectOutputTexts(payload) {
  if (!isPlainObject(payload) || payload.type !== 'message') return [];
  const texts = [];
  if (typeof payload.output_text === 'string' && payload.output_text !== '') texts.push(payload.output_text);
  if (Array.isArray(payload.content)) {
    for (const item of payload.content) {
      if (isPlainObject(item) && item.type === 'output_text' && typeof item.text === 'string' && item.text !== '') texts.push(item.text);
    }
  }
  return texts;
}

/** 解析 rollout JSONL 中的助手回复（payload.type==='message' 的 output_text）。 */
export function parseRolloutReplies(content) {
  const replies = [];
  if (typeof content !== 'string') return replies;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const payload = isPlainObject(entry.payload) ? entry.payload : entry;
    const timestamp = entry.timestamp ?? payload.timestamp ?? null;
    for (const text of collectOutputTexts(payload)) {
      replies.push({ text, timestamp, fingerprint: `${timestamp ?? ''}|${text}` });
    }
  }
  return replies;
}

async function findLatestRolloutFile(rolloutRoot, threadId, fsOps) {
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fsOps.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = typeof entry?.name === 'string' ? entry.name : '';
      if (name === '') continue;
      const full = path.join(dir, name);
      if (entry.isDirectory && entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && name.includes(threadId)) {
        try {
          const stat = await fsOps.stat(full);
          if (stat.isFile()) files.push({ filePath: full, mtimeMs: Number(stat.mtimeMs) || 0 });
        } catch {
          // ignore
        }
      }
    }
  };
  await walk(path.join(rolloutRoot, 'sessions'), 0);
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files.length === 0 ? null : files[0];
}

async function readLatestRolloutReplies(rolloutRoot, threadId, fsOps) {
  const latest = await findLatestRolloutFile(rolloutRoot, threadId, fsOps);
  if (latest === null) return { filePath: null, replies: [] };
  try {
    const content = await fsOps.readFile(latest.filePath, 'utf8');
    return { filePath: latest.filePath, replies: parseRolloutReplies(content) };
  } catch {
    return { filePath: latest.filePath, replies: [] };
  }
}

function defaultRun({ command, args, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch {}
      finish({ code: null, stdout, stderr: stderr.slice(0, MAX_CAPTURED_STDERR), timedOut: true });
    }, timeoutMs);
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      finish({ code: null, stdout: '', stderr: '', error });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_CAPTURED_STDERR) stderr = stderr.slice(-MAX_CAPTURED_STDERR);
    });
    child.on('error', (error) => finish({ code: null, stdout, stderr, error }));
    child.on('close', (code) => finish({ code, stdout, stderr: stderr.slice(0, MAX_CAPTURED_STDERR) }));
  });
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') return { ok: false, error: { code: 'invalid-prompt', message: 'prompt 必须是非空字符串' } };
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return { ok: false, error: { code: 'invalid-prompt', message: `prompt 超过 ${MAX_PROMPT_BYTES} 字节上限` } };
  return { ok: true };
}

function normalizeOptions(options, { allowCwd = true, allowThread = false } = {}) {
  const source = options === undefined ? {} : options;
  if (!isPlainObject(source)) return { ok: false, error: { code: 'invalid-options', message: 'options 必须是对象' } };
  for (const key of Object.keys(source)) {
    if (UNSAFE_OPTION_KEYS.has(key)) {
      return { ok: false, error: { code: 'invalid-options', message: `不允许覆盖安全参数：${key}（固定只读沙箱 + approval never）` } };
    }
    const allowed = allowThread ? CONTINUE_OPTION_KEYS : SEND_OPTION_KEYS;
    if (!allowed.has(key)) {
      return { ok: false, error: { code: 'invalid-options', message: `未知选项：${key}` } };
    }
  }
  const model = source.model;
  if (model !== undefined && (typeof model !== 'string' || !MODEL_RE.test(model))) {
    return { ok: false, error: { code: 'invalid-model', message: 'model 名称非法' } };
  }
  const timeoutMs = source.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : source.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60 * 1000) {
    return { ok: false, error: { code: 'invalid-timeout', message: 'timeoutMs 必须是 1..1800000 的整数' } };
  }
  const cwd = source.cwd === undefined ? process.cwd() : source.cwd;
  if (!allowCwd || typeof cwd !== 'string' || cwd.trim() === '') {
    return { ok: false, error: { code: 'invalid-cwd', message: 'cwd 必须是字符串目录路径' } };
  }
  let threadId;
  if (allowThread && source.threadId !== undefined) {
    if (typeof source.threadId !== 'string' || !THREAD_RE.test(source.threadId)) {
      return { ok: false, error: { code: 'invalid-thread', message: 'threadId 非法（需为 Codex thread id）' } };
    }
    threadId = source.threadId;
  }
  const waitReplyMs = source.waitReplyMs === undefined ? DEFAULT_WAIT_REPLY_MS : source.waitReplyMs;
  if (allowThread && (!Number.isInteger(waitReplyMs) || waitReplyMs < 0 || waitReplyMs > MAX_WAIT_REPLY_MS)) {
    return { ok: false, error: { code: 'invalid-wait-reply', message: `waitReplyMs 必须是 0..${MAX_WAIT_REPLY_MS} 的整数` } };
  }
  return { ok: true, value: { cwd: path.resolve(cwd), timeoutMs, model, threadId, waitReplyMs } };
}

function emptyState() {
  return { version: CODEX_BRIDGE_VERSION, threadId: null, turns: 0, lastAt: null, history: [] };
}

function validateState(value) {
  if (!isPlainObject(value)) throw codedError('state-invalid', 'state 根必须是对象');
  if (value.version !== CODEX_BRIDGE_VERSION) throw codedError('state-invalid', 'state version 不受支持');
  if (!(value.threadId === null || (typeof value.threadId === 'string' && value.threadId !== ''))) throw codedError('state-invalid', 'threadId 非法');
  if (!Number.isInteger(value.turns) || value.turns < 0) throw codedError('state-invalid', 'turns 非法');
  if (!(value.lastAt === null || Number.isFinite(value.lastAt))) throw codedError('state-invalid', 'lastAt 非法');
  if (!Array.isArray(value.history) || value.history.length > MAX_HISTORY) throw codedError('state-invalid', 'history 非法');
  return {
    version: CODEX_BRIDGE_VERSION,
    threadId: value.threadId,
    turns: value.turns,
    lastAt: value.lastAt,
    history: value.history.map((entry) => {
      if (!isPlainObject(entry)) throw codedError('state-invalid', 'history 条目非法');
      if (!(entry.threadId === null || typeof entry.threadId === 'string')) throw codedError('state-invalid', 'history.threadId 非法');
      if (typeof entry.prompt !== 'string' || typeof entry.reply !== 'string') throw codedError('state-invalid', 'history 文本非法');
      if (!Number.isFinite(entry.at)) throw codedError('state-invalid', 'history.at 非法');
      return {
        threadId: entry.threadId,
        prompt: entry.prompt.slice(0, 200),
        reply: entry.reply.slice(0, 500),
        at: entry.at,
        usage: isPlainObject(entry.usage) ? entry.usage : null,
      };
    }),
  };
}

async function readStateFile(statePath, fsOps) {
  let raw;
  try {
    raw = await fsOps.readFile(statePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw codedError('state-invalid', `读取 state 失败（${error?.code ?? 'UNKNOWN'}）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw codedError('state-invalid', 'state 不是合法 JSON');
  }
  return validateState(parsed);
}

async function writeStateFile(statePath, state, fsOps) {
  const directory = path.dirname(statePath);
  await fsOps.mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `${path.basename(statePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fsOps.writeFile(tempPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fsOps.rename(tempPath, statePath);
    if (process.platform !== 'win32') {
      try { await fsOps.chmod(statePath, 0o600); } catch {}
    }
  } catch (error) {
    try { await fsOps.unlink(tempPath); } catch {}
    throw codedError('state-failed', `写入 state 失败（${error?.code ?? 'UNKNOWN'}）`);
  }
}

function outcomeFromRun(runResult) {
  if (!isPlainObject(runResult)) return { ok: false, error: { code: 'runner-failed', message: 'runner 返回非法结果' } };
  if (runResult.error !== undefined && runResult.code === null) {
    return { ok: false, error: { code: 'runner-failed', message: `runner 异常：${runResult.error?.code ?? runResult.error?.message ?? 'UNKNOWN'}` } };
  }
  if (runResult.timedOut === true) {
    return { ok: false, error: { code: 'timeout', message: 'Codex 执行超时（已杀进程，不重试）' } };
  }
  if (runResult.code !== 0) {
    const stderrExcerpt = typeof runResult.stderr === 'string' ? runResult.stderr.slice(0, MAX_ERROR_STDERR) : '';
    return {
      ok: false,
      error: {
        code: 'codex-failed',
        message: `codex exit ${runResult.code ?? 'null'}`,
        ...(stderrExcerpt !== '' ? { stderr: stderrExcerpt } : {}),
      },
    };
  }
  const parsed = parseCodexJsonl(runResult.stdout ?? '');
  if (parsed.threadId === null) return { ok: false, error: { code: 'no-thread-id', message: 'Codex 输出缺少 thread.started.thread_id' } };
  if (typeof parsed.reply !== 'string' || parsed.reply.trim() === '') {
    return { ok: false, error: { code: 'no-reply', message: 'Codex 输出缺少 agent_message' } };
  }
  return { ok: true, threadId: parsed.threadId, reply: parsed.reply, usage: parsed.usage };
}

/**
 * 创建 Codex 桥实例。
 * @param {object} [options]
 * @param {string} [options.statePath] 默认 %USERPROFILE%/.codex-bridge/state.json（CODEX_BRIDGE_STATE 可覆盖）
 * @param {Function} [options.run] 注入 runner（测试用）；默认 spawn codex CLI
 * @param {() => number} [options.now]
 * @param {string} [options.codexCli] 已解析的 CLI 路径（缺省时在首次执行前 resolveCodexCli）
 * @param {object} [options.env] 环境变量（状态路径/CLI 查找）
 * @param {object} [options.fsOps] 文件系统注入（测试用）
 */
export function createCodexBridge(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const env = isPlainObject(source.env) ? source.env : process.env;
  const fsOps = { readFile: fs.readFile, writeFile: fs.writeFile, mkdir: fs.mkdir, rename: fs.rename, unlink: fs.unlink, chmod: fs.chmod, stat: fs.stat, readdir: fs.readdir, ...(isPlainObject(source.fsOps) ? source.fsOps : {}) };
  const statePath = source.statePath === undefined ? defaultStatePath(env) : path.resolve(String(source.statePath));
  const now = typeof source.now === 'function' ? source.now : () => Date.now();
  const run = typeof source.run === 'function' ? source.run : defaultRun;
  const rolloutRoot = source.rolloutRoot === undefined ? path.join(homeDir(env), '.codex') : path.resolve(String(source.rolloutRoot));
  const pollIntervalMs = Number.isInteger(source.pollIntervalMs) && source.pollIntervalMs > 0 ? source.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const sleep = typeof source.sleep === 'function' ? source.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let resolvedCli = typeof source.codexCli === 'string' && source.codexCli !== '' ? source.codexCli : null;

  async function cliPath() {
    if (resolvedCli !== null) return resolvedCli;
    resolvedCli = await resolveCodexCli({ env });
    return resolvedCli;
  }

  function statusSync() {
    let state;
    if (!fsSync.existsSync(statePath)) state = emptyState();
    else {
      try {
        state = validateState(JSON.parse(fsSync.readFileSync(statePath, 'utf8')));
      } catch (error) {
        throw error?.code === 'state-invalid' ? error : codedError('state-invalid', 'state 文件不可用');
      }
    }
    return { threadId: state.threadId, turns: state.turns, lastAt: state.lastAt, statePath };
  }

  async function status() {
    let state;
    try {
      state = await readStateFile(statePath, fsOps);
    } catch (error) {
      throw error;
    }
    return { threadId: state.threadId, turns: state.turns, lastAt: state.lastAt, statePath };
  }

  function errorResult(error) {
    return { ok: false, error };
  }

  async function saveTurn({ state, threadId, prompt, reply, usage, at }) {
    const next = {
      version: CODEX_BRIDGE_VERSION,
      threadId,
      turns: state.turns + 1,
      lastAt: at,
      history: [
        ...state.history,
        {
          threadId,
          prompt: prompt.slice(0, 200),
          reply: typeof reply === 'string' ? reply.slice(0, 500) : '',
          at,
          usage: isPlainObject(usage) ? usage : null,
        },
      ].slice(-MAX_HISTORY),
    };
    await writeStateFile(statePath, next, fsOps);
    return next;
  }

  async function runQueueFallback({ cli, prompt, normalized, state, threadId }) {
    // 先记录 queue 之前的 rollout 回复指纹，避免把历史回复当成本次回复。
    const baseline = await readLatestRolloutReplies(rolloutRoot, threadId, fsOps);
    const baselineFingerprints = new Set(baseline.replies.map((entry) => entry.fingerprint));
    const queueArgs = buildQueueArgs({ threadId, prompt });
    let runResult;
    try {
      runResult = await run({ command: cli, args: queueArgs, cwd: normalized.cwd, timeoutMs: normalized.timeoutMs, env });
    } catch (error) {
      return errorResult({ code: 'runner-failed', message: `queue runner 异常：${error?.code ?? error?.message ?? 'UNKNOWN'}` });
    }
    if (!isPlainObject(runResult)) return errorResult({ code: 'queue-failed', message: 'queue runner 返回非法结果' });
    if (runResult.timedOut === true) return errorResult({ code: 'timeout', message: 'codex queue 超时（已杀进程，不重试）' });
    if (runResult.code !== 0) {
      return errorResult({ code: 'queue-failed', message: `codex queue exit ${runResult.code ?? 'null'}` });
    }
    const queuedMessageId = parseQueuedMessageId(runResult.stdout ?? '');
    let reply = null;
    let waitedMs = 0;
    if (normalized.waitReplyMs > 0) {
      const startedAt = now();
      for (;;) {
        const latest = await readLatestRolloutReplies(rolloutRoot, threadId, fsOps);
        const fresh = latest.replies.filter((entry) => !baselineFingerprints.has(entry.fingerprint));
        if (fresh.length > 0) {
          reply = fresh[fresh.length - 1].text;
          break;
        }
        const elapsed = now() - startedAt;
        if (elapsed >= normalized.waitReplyMs) break;
        await sleep(Math.min(pollIntervalMs, Math.max(1, normalized.waitReplyMs - elapsed)));
      }
      waitedMs = Math.max(0, now() - startedAt);
    }
    const at = now();
    try {
      await saveTurn({ state, threadId, prompt, reply: reply ?? '', usage: null, at });
    } catch (error) {
      return errorResult({ code: error?.code ?? 'state-failed', message: error?.message ?? '状态保存失败' });
    }
    const result = {
      ok: true,
      mode: 'queue',
      sandbox: 'session-defined',
      threadId,
      queuedMessageId,
      reply,
      waitedMs,
      resumed: true,
    };
    if (reply === null) result.note = 'queued-no-reply-in-timeout';
    return result;
  }

  async function execute({ prompt, options, resumeThreadId, queueFallback = false }) {
    const promptCheck = validatePrompt(prompt);
    if (!promptCheck.ok) return errorResult(promptCheck.error);
    const optionsCheck = normalizeOptions(options, { allowCwd: true, allowThread: queueFallback });
    if (!optionsCheck.ok) return errorResult(optionsCheck.error);
    const normalized = optionsCheck.value;
    const { cwd, timeoutMs, model } = normalized;
    try {
      const stat = await fsOps.stat(cwd);
      if (!stat.isDirectory()) return errorResult({ code: 'invalid-cwd', message: 'cwd 不是目录' });
    } catch {
      return errorResult({ code: 'invalid-cwd', message: 'cwd 不存在' });
    }

    // 先读状态：损坏时在运行 Codex 之前 fail-closed（不得先跑后失败）。
    let state;
    try {
      state = await readStateFile(statePath, fsOps);
    } catch (error) {
      return errorResult({ code: error?.code ?? 'state-invalid', message: error?.message ?? 'state 不可用' });
    }
    let cli;
    try {
      cli = await cliPath();
    } catch (error) {
      return errorResult({ code: error?.code ?? 'codex-cli-not-found', message: error?.message ?? '找不到 Codex CLI' });
    }

    const args = resumeThreadId === undefined
      ? buildExecArgs({ cwd, prompt, model })
      : buildResumeArgs({ threadId: resumeThreadId, prompt, model });
    let runResult;
    try {
      runResult = await run({ command: cli, args, cwd, timeoutMs, env });
    } catch (error) {
      return errorResult({ code: 'runner-failed', message: `runner 异常：${error?.code ?? error?.message ?? 'UNKNOWN'}` });
    }
    const outcome = outcomeFromRun(runResult);
    if (!outcome.ok) {
      if (queueFallback && resumeThreadId !== undefined && isActiveWriterFailure(runResult)) {
        return runQueueFallback({ cli, prompt, normalized, state, threadId: resumeThreadId });
      }
      return errorResult(outcome.error);
    }

    const threadId = typeof outcome.threadId === 'string' && outcome.threadId !== '' ? outcome.threadId : resumeThreadId;
    const at = now();
    try {
      await saveTurn({ state, threadId, prompt, reply: outcome.reply, usage: outcome.usage, at });
    } catch (error) {
      return errorResult({ code: error?.code ?? 'state-failed', message: error?.message ?? '状态保存失败' });
    }
    return resumeThreadId === undefined
      ? { ok: true, threadId, reply: outcome.reply, usage: outcome.usage, newSession: true }
      : { ok: true, threadId, reply: outcome.reply, usage: outcome.usage, resumed: true, mode: 'resume', sandbox: 'read-only' };
  }

  async function send(prompt, opts) {
    return execute({ prompt, options: opts });
  }

  async function continueSession(prompt, opts) {
    let state;
    try {
      state = await readStateFile(statePath, fsOps);
    } catch (error) {
      return errorResult({ code: error?.code ?? 'state-invalid', message: error?.message ?? 'state 不可用' });
    }
    const optionsCheck = normalizeOptions(opts, { allowCwd: true, allowThread: true });
    if (!optionsCheck.ok) return errorResult(optionsCheck.error);
    const threadId = optionsCheck.value.threadId ?? state.threadId;
    if (threadId === null) return errorResult({ code: 'no-session', message: '没有保存的 Codex 会话，请先 send 或传 --thread' });
    return execute({ prompt, options: opts, resumeThreadId: threadId, queueFallback: true });
  }

  async function reset() {
    try {
      await writeStateFile(statePath, emptyState(), fsOps);
    } catch (error) {
      return errorResult({ code: error?.code ?? 'state-failed', message: error?.message ?? '重置失败' });
    }
    return { ok: true };
  }

  async function close() {
    return { ok: true };
  }

  return { send, continueSession, status: statusSync, reset, close };
}

function writeUsage(stream) {
  stream.write([
    '用法：node scripts/codex-bridge.mjs <send|continue|status|reset> [参数]',
    '',
    '  send "<prompt>" [--json] [--cwd <dir>] [--timeout-ms N] [--model M]',
    '  continue "<prompt>" [--json] [--cwd <dir>] [--timeout-ms N] [--model M]',
    '           [--thread <uuid>] [--wait-reply-ms N]',
    '  status [--json]',
    '  reset [--json]',
    '',
    '安全：exec/resume 固定只读沙箱 + approval never；拒绝 --sandbox/--approval 等覆盖参数。',
    'continue 默认先 resume；若目标会话被 Codex Desktop 占用（active writer）则自动 fallback 到 queue。',
    'queue 模式以【活动会话自身权限】执行（mode=queue, sandbox=session-defined），等待回复默认 15000ms（0=不等）。',
    '退出码：0 成功 / 1 执行错误 / 2 参数错误。',
    '',
  ].join('\n'));
}

function parseCliArgs(argv) {
  const allowedCommands = new Set(['send', 'continue', 'status', 'reset']);
  const dangerous = /^--(dangerously|sandbox|approval|bypass)/;
  const options = { json: false, cwd: undefined, timeoutMs: undefined, model: undefined, threadId: undefined, waitReplyMs: undefined, positionals: [] };
  const command = argv[0];
  if (!allowedCommands.has(command)) return { error: `未知子命令：${String(command ?? '(缺失)')}` };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--help' || arg === '-h') return { help: true, command };
    if (dangerous.test(arg)) return { error: `不允许的危险参数：${arg}（固定只读沙箱 + approval never）` };
    if (arg === '--cwd' || arg === '--timeout-ms' || arg === '--model' || arg === '--thread' || arg === '--wait-reply-ms') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} 需要参数值` };
      if (arg === '--cwd') options.cwd = value;
      else if (arg === '--timeout-ms') options.timeoutMs = Number(value);
      else if (arg === '--model') options.model = value;
      else if (arg === '--thread') options.threadId = value;
      else {
        const waitReplyMs = Number(value);
        if (!Number.isInteger(waitReplyMs) || waitReplyMs < 0 || waitReplyMs > 300_000) {
          return { error: '--wait-reply-ms 必须是 0..300000 的整数' };
        }
        options.waitReplyMs = waitReplyMs;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) return { error: `未知参数：${arg}` };
    options.positionals.push(arg);
  }
  if (command === 'send' || command === 'continue') {
    if (options.positionals.length === 0) return { error: `${command} 需要 prompt 参数` };
    options.prompt = options.positionals.join(' ');
  } else if (options.positionals.length > 0) {
    return { error: `${command} 不接受位置参数` };
  }
  if (command !== 'continue' && (options.threadId !== undefined || options.waitReplyMs !== undefined)) {
    return { error: '--thread/--wait-reply-ms 只适用于 continue（活动会话 queue 模式）' };
  }
  return { command, options };
}

/**
 * CLI 入口（可注入 bridge/stdout/stderr 便于离线测试）。
 * @returns {Promise<0|1|2>}
 */
export async function main(argv = [], io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const parsed = parseCliArgs(argv);
  if (parsed.error !== undefined) {
    stderr.write(`[codex-bridge] ${parsed.error}\n`);
    writeUsage(stderr);
    return 2;
  }
  if (parsed.help === true) {
    writeUsage(stdout);
    return 0;
  }
  const { command, options } = parsed;
  const bridge = io.bridge ?? createCodexBridge({ env: io.env ?? process.env, now: io.now });
  const emit = (result) => {
    if (options.json) {
      stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (result.ok) {
      if (command === 'status') {
        stdout.write(`thread: ${result.threadId ?? '(none)'}\nturns: ${result.turns}\nlastAt: ${result.lastAt ?? '(none)'}\nstate: ${result.statePath}\n`);
      } else if (command === 'reset') {
        stdout.write('已重置 Codex 会话。\n');
      } else if (result.mode === 'queue') {
        stdout.write(`${result.reply === null ? '(queued; no reply yet)' : result.reply}\nthread: ${result.threadId}\nmode: queue\nsandbox: session-defined\n`);
        if (result.queuedMessageId !== null) stdout.write(`queuedMessageId: ${result.queuedMessageId}\n`);
        if (result.note !== undefined) stdout.write(`note: ${result.note}\n`);
      } else {
        stdout.write(`${result.reply}\nthread: ${result.threadId}\n`);
      }
      return;
    }
    stderr.write(`[codex-bridge] ${result.error?.code ?? 'error'}: ${result.error?.message ?? 'unknown'}\n`);
  };

  let result;
  try {
    if (command === 'send') result = await bridge.send(options.prompt, { cwd: options.cwd, timeoutMs: options.timeoutMs, model: options.model });
    else if (command === 'continue') result = await bridge.continueSession(options.prompt, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      model: options.model,
      threadId: options.threadId,
      waitReplyMs: options.waitReplyMs,
    });
    else if (command === 'status') result = { ok: true, ...(await bridge.status()) };
    else {
      try {
        result = await bridge.reset();
      } catch (error) {
        result = { ok: false, error: { code: error?.code ?? 'state-failed', message: error?.message ?? '重置失败' } };
      }
    }
  } catch (error) {
    result = { ok: false, error: { code: error?.code ?? 'internal-error', message: error?.message ?? '未知错误' } };
  }
  emit(result);
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[codex-bridge] 未预期错误：${error?.code ?? 'UNKNOWN'}\n`);
    process.exitCode = 1;
  }
}
