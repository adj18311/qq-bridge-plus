// scripts/test-codex-bridge.mjs
// task-64：DSH↔Codex CLI 桥离线测试（TDD 先红后绿）。
// 覆盖：CLI 解析/JSONL 解析/exec+resume 参数/状态原子写与历史上限/timeout/错误/CLI 子命令。
// 全部离线：注入 fake runner 与 fake fs；不真实调用 Codex、不联网、不写仓库内状态。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CODEX_BRIDGE_VERSION,
  resolveCodexCli,
  createCodexBridge,
  parseCodexJsonl,
  buildExecArgs,
  buildResumeArgs,
  buildQueueArgs,
  parseRolloutReplies,
  DEFAULT_WAIT_REPLY_MS,
  main,
} from './codex-bridge.mjs';

const tempDirs = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-test-'));
  tempDirs.push(dir);
  return dir;
}

function jsonl(events) {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

function okRun({ reply = 'hello from codex', threadId = 'thread-1', usage = { input_tokens: 3, output_tokens: 4 } } = {}) {
  return async () => ({
    code: 0,
    stdout: jsonl([
      { type: 'thread.started', thread_id: threadId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: reply } },
      { type: 'turn.completed', usage },
    ]),
    stderr: '',
  });
}

function makeRun(responses = []) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    async run(request) {
      calls.push(request);
      const next = queue.shift();
      if (next === undefined) return { code: 0, stdout: jsonl([{ type: 'thread.started', thread_id: 'thread-1' }, { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }, { type: 'turn.completed', usage: {} }]), stderr: '' };
      if (typeof next === 'function') return next(request);
      return next;
    },
  };
}

async function makeBridge({ dir, responses = [], now = () => 1_700_000_000_000, extra = {} } = {}) {
  const resolvedDir = dir ?? await makeDir();
  {
    const statePath = path.join(resolvedDir, 'state.json');
    const runner = makeRun(responses);
    const bridge = createCodexBridge({
      statePath,
      run: runner.run,
      now,
      codexCli: 'C:/fake/codex.exe',
      env: { USERPROFILE: resolvedDir, HOME: resolvedDir },
      ...extra,
    });
    return { bridge, runner, dir: resolvedDir, statePath };
  }
}

test('exports/version 与默认状态路径：仓库外 %USERPROFILE%/.codex-bridge/state.json', async () => {
  assert.equal(CODEX_BRIDGE_VERSION, 1);
  assert.equal(typeof resolveCodexCli, 'function');
  assert.equal(typeof createCodexBridge, 'function');
  assert.equal(typeof parseCodexJsonl, 'function');
  assert.equal(typeof main, 'function');
  const dir = await makeDir();
  const bridge = createCodexBridge({
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    codexCli: 'C:/fake/codex.exe',
    env: { USERPROFILE: dir, HOME: dir },
    now: () => 1,
  });
  assert.equal(bridge.status().statePath, path.join(dir, '.codex-bridge', 'state.json'));
});

test('resolveCodexCli：CODEX_CLI 优先；无效 CODEX_CLI 报错；LOCALAPPDATA 取最新；PATH 兜底；都没有报错', async () => {
  const p = (value) => path.resolve(value);
  const files = {
    [p('C:/explicit/codex.exe')]: true,
    [p('C:/old/codex.exe')]: true,
    [p('C:/new/codex.exe')]: true,
    [p('C:/path/codex.exe')]: true,
  };
  const fakeFs = {
    async access(target) {
      if (files[target]) return;
      if (/[\\/](old|new)[\\/]codex\.exe$/.test(target)) return;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async stat(target) {
      const base = path.basename(target);
      if (base === 'old') return { isDirectory: () => true, mtimeMs: 10 };
      if (base === 'new') return { isDirectory: () => true, mtimeMs: 20 };
      if (target.endsWith('codex.exe')) return { isFile: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async readdir(target) {
      if (target === p('C:/bin')) return ['old', 'new', 'readme.txt'];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
  const foundExplicit = await resolveCodexCli({ env: { CODEX_CLI: 'C:/explicit/codex.exe' }, fs: fakeFs });
  assert.equal(foundExplicit, p('C:/explicit/codex.exe'));

  await assert.rejects(
    () => resolveCodexCli({ env: { CODEX_CLI: 'C:/missing/codex.exe' }, fs: fakeFs }),
    (error) => error.code === 'codex-cli-invalid',
  );

  const foundNewest = await resolveCodexCli({
    env: { LOCALAPPDATA: 'C:/local', PATH: 'C:/path', CODEX_CLI: '' },
    fs: {
      ...fakeFs,
      async stat(target) { return fakeFs.stat(target); },
      async readdir(target) { if (target === p('C:/local/OpenAI/Codex/bin')) return ['old', 'new']; return fakeFs.readdir(target); },
    },
    platform: 'win32',
  });
  assert.equal(foundNewest, path.join(p('C:/local/OpenAI/Codex/bin'), 'new', 'codex.exe'));

  const foundPath = await resolveCodexCli({
    env: { LOCALAPPDATA: 'C:/nope', PATH: 'C:/path', CODEX_CLI: '' },
    fs: {
      ...fakeFs,
      async readdir() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
    platform: 'win32',
  });
  assert.equal(foundPath, p('C:/path/codex.exe'));

  await assert.rejects(
    () => resolveCodexCli({ env: { LOCALAPPDATA: 'C:/nope', PATH: 'C:/empty', CODEX_CLI: '' }, fs: { async access() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, async stat() { throw new Error('ENOENT'); }, async readdir() { throw new Error('ENOENT'); } }, platform: 'win32' }),
    (error) => error.code === 'codex-cli-not-found',
  );
});

test('parseCodexJsonl：未知事件忽略、重复 agent_message 取最后一个、usage/thread 提取', () => {
  const stdout = jsonl([
    { type: 'thread.started', thread_id: 't-9' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'internal' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'last' } },
    { type: 'turn.completed', usage: { input_tokens: 7 } },
    { type: 'future.event', whatever: true },
  ]);
  const parsed = parseCodexJsonl(stdout);
  assert.equal(parsed.threadId, 't-9');
  assert.equal(parsed.reply, 'last');
  assert.deepEqual(parsed.usage, { input_tokens: 7 });
});

test('buildExecArgs/buildResumeArgs：固定只读沙箱 + approval never + skip-git；resume 不含 -s', () => {
  const execArgs = buildExecArgs({ cwd: 'C:/work', prompt: 'hi', model: 'm1' });
  assert.deepEqual(execArgs.slice(0, 6), ['exec', '--json', '-C', 'C:/work', '-s', 'read-only']);
  assert.ok(execArgs.includes('--skip-git-repo-check'));
  assert.ok(execArgs.includes('approval_policy="never"'));
  assert.ok(execArgs.includes('-m'));
  assert.equal(execArgs[execArgs.length - 1], 'hi');
  assert.ok(!execArgs.includes('--dangerously-bypass-approvals-and-sandbox'));

  const resumeArgs = buildResumeArgs({ threadId: 'thread-9', prompt: 'again' });
  assert.deepEqual(resumeArgs.slice(0, 3), ['exec', 'resume', 'thread-9']);
  assert.ok(resumeArgs.includes('--json'), 'resume 必须带 --json，否则 stdout 是人类文本无法解析');
  assert.ok(resumeArgs.includes('sandbox_mode="read-only"'));
  assert.ok(resumeArgs.includes('approval_policy="never"'));
  assert.ok(resumeArgs.includes('--skip-git-repo-check'));
  assert.ok(!resumeArgs.includes('-s'));
  assert.equal(resumeArgs[resumeArgs.length - 1], 'again');
});

test('send：调用 exec --json，返回 thread/reply/usage，并原子保存状态（0600/POSIX，无 tmp）', async () => {
  const { bridge, runner, statePath } = await makeBridge({ responses: [okRun({ reply: '任务完成', threadId: 't-42' })] });
  const result = await bridge.send('帮我看看仓库');
  assert.equal(result.ok, true);
  assert.equal(result.threadId, 't-42');
  assert.equal(result.reply, '任务完成');
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4 });
  assert.equal(result.newSession, true);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].command, 'C:/fake/codex.exe');
  assert.deepEqual(runner.calls[0].args.slice(0, 6), ['exec', '--json', '-C', process.cwd(), '-s', 'read-only']);
  const raw = await fs.readFile(statePath, 'utf8');
  const state = JSON.parse(raw);
  assert.equal(state.threadId, 't-42');
  assert.equal(state.turns, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].threadId, 't-42');
  if (process.platform !== 'win32') assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(statePath))).filter((name) => name.includes('.tmp')), []);
});

test('send：prompt/cwd/timeout/model/危险参数校验', async () => {
  const { bridge, runner } = await makeBridge({ responses: [okRun(), okRun()] });
  for (const prompt of ['', '   ', 42, 'x'.repeat(32 * 1024 + 1)]) {
    const result = await bridge.send(prompt);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-prompt');
  }
  const missingCwd = await bridge.send('hi', { cwd: path.join(os.tmpdir(), 'no-such-dir-codex-xyz') });
  assert.equal(missingCwd.ok, false);
  assert.equal(missingCwd.error.code, 'invalid-cwd');
  for (const timeoutMs of [0, -1, 1.5, '1000']) {
    const result = await bridge.send('hi', { timeoutMs });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-timeout');
  }
  const badModel = await bridge.send('hi', { model: 'bad model!' });
  assert.equal(badModel.ok, false);
  assert.equal(badModel.error.code, 'invalid-model');
  for (const key of ['sandbox', 'approvalPolicy', 'dangerouslyBypassApprovalsAndSandbox', 'bypass']) {
    const result = await bridge.send('hi', { [key]: true });
    assert.equal(result.ok, false, key);
    assert.equal(result.error.code, 'invalid-options', key);
  }
  assert.equal(runner.calls.length, 0, '校验失败不得执行 runner');
});

test('send：timeout / 非零退出 / runner 抛错 → ok:false，不保存假成功', async () => {
  const timeout = await makeBridge({ responses: [{ code: null, stdout: '', stderr: '', timedOut: true }] });
  const timeoutResult = await timeout.bridge.send('hi');
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.error.code, 'timeout');
  await assert.rejects(() => fs.access(timeout.statePath), '超时不得创建状态文件');

  const failed = await makeBridge({ responses: [{ code: 1, stdout: '', stderr: 'auth failed: secret-ish' }] });
  const failedResult = await failed.bridge.send('hi');
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.error.code, 'codex-failed');
  assert.match(failedResult.error.message, /exit 1/);
  assert.ok(!failedResult.error.message.includes('secret-ish'), 'stderr 不进主错误信息');

  const thrown = await makeBridge({ responses: [async () => { throw new Error('spawn boom'); }] });
  const thrownResult = await thrown.bridge.send('hi');
  assert.equal(thrownResult.ok, false);
  assert.equal(thrownResult.error.code, 'runner-failed');
});

test('send：JSONL 缺 thread_id / 缺 agent_message → fail-closed，不保存', async () => {
  const noThread = await makeBridge({ responses: [{ code: 0, stdout: jsonl([{ type: 'item.completed', item: { type: 'agent_message', text: 'x' } }]), stderr: '' }] });
  const noThreadResult = await noThread.bridge.send('hi');
  assert.equal(noThreadResult.ok, false);
  assert.equal(noThreadResult.error.code, 'no-thread-id');

  const noReply = await makeBridge({ responses: [{ code: 0, stdout: jsonl([{ type: 'thread.started', thread_id: 't' }]), stderr: '' }] });
  const noReplyResult = await noReply.bridge.send('hi');
  assert.equal(noReplyResult.ok, false);
  assert.equal(noReplyResult.error.code, 'no-reply');
});

test('continueSession：无 session → no-session（不运行）；有 session → resume 参数正确并更新历史', async () => {
  const { bridge, runner, statePath } = await makeBridge({ responses: [okRun({ threadId: 't-1' }), okRun({ reply: '续聊回复', threadId: 't-1' })] });
  const noSession = await bridge.continueSession('hi');
  assert.equal(noSession.ok, false);
  assert.equal(noSession.error.code, 'no-session');
  assert.equal(runner.calls.length, 0);

  await bridge.send('第一轮');
  const resumed = await bridge.continueSession('第二轮', { cwd: process.cwd() });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.reply, '续聊回复');
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(runner.calls[1].args.slice(0, 3), ['exec', 'resume', 't-1']);
  assert.ok(runner.calls[1].args.includes('sandbox_mode="read-only"'));
  assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).turns, 2);
});

test('status/reset：状态字段、reset 清空会话但保留文件结构、reset 后 continue 报 no-session', async () => {
  const { bridge, statePath } = await makeBridge({ responses: [okRun({ threadId: 't-7' }), okRun({ threadId: 't-7' })] });
  const initial = bridge.status();
  assert.deepEqual({ threadId: initial.threadId, turns: initial.turns, lastAt: initial.lastAt }, { threadId: null, turns: 0, lastAt: null });
  await bridge.send('one');
  await bridge.continueSession('two');
  const status = bridge.status();
  assert.equal(status.threadId, 't-7');
  assert.equal(status.turns, 2);
  assert.equal(status.lastAt, 1_700_000_000_000);
  assert.equal(status.statePath, statePath);

  const reset = await bridge.reset();
  assert.equal(reset.ok, true);
  const after = bridge.status();
  assert.equal(after.threadId, null);
  assert.equal(after.turns, 0);
  assert.equal(after.lastAt, null);
  const raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(raw.threadId, null);
  assert.ok(Array.isArray(raw.history));
  const noSession = await bridge.continueSession('three');
  assert.equal(noSession.error.code, 'no-session');
});

test('历史最多 20 轮；只保存 prompt 摘要/reply/at/threadId（不保存 token 等敏感键）', async () => {
  const dir = await makeDir();
  const responses = Array.from({ length: 21 }, (_, index) => okRun({ reply: `reply-${index}`, threadId: `t-${index}` }));
  const { bridge, statePath } = await makeBridge({ dir, responses });
  for (let index = 0; index < 21; index += 1) {
    const result = await bridge.send(`prompt-${index}`);
    assert.equal(result.ok, true, String(index));
  }
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.history.length, 20);
  assert.equal(state.history[0].reply, 'reply-1');
  assert.equal(state.history.at(-1).reply, 'reply-20');
  const allowedKeys = new Set(['threadId', 'prompt', 'reply', 'at', 'usage']);
  for (const entry of state.history) {
    for (const key of Object.keys(entry)) assert.ok(allowedKeys.has(key), `history 含未声明字段 ${key}`);
  }
  const serialized = JSON.stringify(state);
  assert.ok(!/secret|api[_-]?key|password|cookie|authorization/i.test(serialized), '状态不得包含凭据键');
});

test('状态文件损坏：send 返回 state-invalid（不调用 runner），status 抛带 code 错误', async () => {
  const dir = await makeDir();
  const statePath = path.join(dir, 'state.json');
  await fs.writeFile(statePath, '{bad json', 'utf8');
  const run = makeRun();
  const bridge = createCodexBridge({ statePath, run: run.run, codexCli: 'C:/fake/codex.exe', now: () => 1, env: { USERPROFILE: dir } });
  const result = await bridge.send('hi');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'state-invalid');
  assert.equal(run.calls.length, 0);
  assert.throws(() => bridge.status(), (error) => error.code === 'state-invalid');
});

test('CODEX_BRIDGE_STATE 覆盖默认状态路径', async () => {
  const dir = await makeDir();
  const custom = path.join(dir, 'custom-state.json');
  const bridge = createCodexBridge({
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    codexCli: 'C:/fake/codex.exe',
    env: { CODEX_BRIDGE_STATE: custom, USERPROFILE: dir },
    now: () => 1,
  });
  assert.equal(bridge.status().statePath, custom);
});

test('CLI：send/continue/status/reset、--json、退出码 0/1/2；危险参数拒绝', async () => {
  const { bridge } = await makeBridge({ responses: [okRun({ reply: 'cli reply', threadId: 't-cli' }), okRun({ reply: 'again', threadId: 't-cli' })] });
  const out = [];
  const err = [];
  const stdout = { write: (chunk) => out.push(chunk) };
  const stderr = { write: (chunk) => err.push(chunk) };
  const io = { stdout, stderr, cwd: process.cwd(), bridge };

  const sendCode = await main(['send', 'hello', '--json'], io);
  assert.equal(sendCode, 0);
  const json = JSON.parse(out.join(''));
  assert.equal(json.ok, true);
  assert.equal(json.threadId, 't-cli');
  assert.equal(json.reply, 'cli reply');

  out.length = 0;
  const continueCode = await main(['continue', 'more', '--json'], io);
  assert.equal(continueCode, 0);
  assert.equal(JSON.parse(out.join('')).resumed, true);

  out.length = 0;
  const statusCode = await main(['status', '--json'], io);
  assert.equal(statusCode, 0);
  assert.equal(JSON.parse(out.join('')).threadId, 't-cli');

  out.length = 0;
  const humanCode = await main(['status'], io);
  assert.equal(humanCode, 0);
  assert.match(out.join(''), /t-cli/);

  out.length = 0;
  assert.equal(await main(['reset', '--json'], io), 0);
  assert.equal(JSON.parse(out.join('')).ok, true);

  const unknown = await main(['frobnicate'], io);
  assert.equal(unknown, 2);
  const missingPrompt = await main(['send'], io);
  assert.equal(missingPrompt, 2);
  const dangerous = await main(['send', 'hi', '--dangerously-bypass-approvals-and-sandbox'], io);
  assert.equal(dangerous, 2);
  const unsafeFlag = await main(['send', 'hi', '--sandbox', 'danger-full-access'], io);
  assert.equal(unsafeFlag, 2);
});

test('CLI：无 session 的 continue → 退出 1；错误 JSON 输出 ok:false', async () => {
  const { bridge } = await makeBridge();
  const out = [];
  const err = [];
  const io = { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: (chunk) => err.push(chunk) }, cwd: process.cwd(), bridge };
  assert.equal(await main(['continue', 'x', '--json'], io), 1);
  const payload = JSON.parse(out.join(''));
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'no-session');
});


// ─────────────────────────────────────────────────────────────────────────────
// task-65：--thread 任意会话 + resume/queue 自动切换。
// ─────────────────────────────────────────────────────────────────────────────

const EXPLICIT_THREAD = '01a16d4d-ff7b-7c22-9654-729df126602e';

function activeWriterRun() {
  return { code: 1, stdout: '', stderr: 'already has an active writer (code -32600)' };
}

function queueAcceptedRun(messageId = 'msg-1') {
  return { code: 0, stdout: `Queued message ${messageId} for thread ${EXPLICIT_THREAD}.\n`, stderr: '' };
}

function rolloutLine(text, timestamp = '2026-10-25T14:00:00.000Z') {
  return `${JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })}\n`;
}

async function makeRollout({ dir, threadId = EXPLICIT_THREAD, lines = [], name = 'rollout-2026-10-25T14-00-00' } = {}) {
  const sessions = path.join(dir, 'sessions', '2026', '10', '25');
  await fs.mkdir(sessions, { recursive: true });
  const filePath = path.join(sessions, `${name}-${threadId}.jsonl`);
  await fs.writeFile(filePath, lines.join(''), 'utf8');
  return { filePath, sessions };
}

test('queue 参数/rollout 解析：buildQueueArgs 固定 queue --thread --message；parseRolloutReplies 取 output_text', () => {
  assert.deepEqual(buildQueueArgs({ threadId: 't-1', prompt: 'hi' }), ['queue', '--thread', 't-1', '--message', 'hi']);
  const content = rolloutLine('旧回复', '2026-10-25T14:00:00.000Z')
    + `${JSON.stringify({ timestamp: '2026-10-25T14:01:00.000Z', payload: { type: 'message', output_text: '直接 output_text' } })}\n`
    + 'not-json\n'
    + `${JSON.stringify({ timestamp: '2026-10-25T14:02:00.000Z', payload: { type: 'reasoning', content: [] } })}\n`;
  const replies = parseRolloutReplies(content);
  assert.deepEqual(replies.map((entry) => entry.text), ['旧回复', '直接 output_text']);
  assert.equal(replies[0].fingerprint, '2026-10-25T14:00:00.000Z|旧回复');
  assert.equal(DEFAULT_WAIT_REPLY_MS, 15_000);
});

test('continueSession --thread：无存储会话也可 resume 指定 thread；结果标记 resume/read-only 并写状态', async () => {
  const { bridge, runner, statePath } = await makeBridge({ responses: [okRun({ reply: '指定会话回复', threadId: EXPLICIT_THREAD })] });
  const result = await bridge.continueSession('hi', { threadId: EXPLICIT_THREAD });
  assert.equal(result.ok, true);
  assert.equal(result.threadId, EXPLICIT_THREAD);
  assert.equal(result.resumed, true);
  assert.equal(result.mode, 'resume');
  assert.equal(result.sandbox, 'read-only');
  assert.deepEqual(runner.calls[0].args.slice(0, 3), ['exec', 'resume', EXPLICIT_THREAD]);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.threadId, EXPLICIT_THREAD);
});

test('continueSession：非法 threadId / waitReplyMs → invalid-thread / invalid-wait-reply，不运行', async () => {
  const { bridge, runner } = await makeBridge({ responses: [okRun()] });
  const badThread = await bridge.continueSession('hi', { threadId: 'bad thread id' });
  assert.equal(badThread.ok, false);
  assert.equal(badThread.error.code, 'invalid-thread');
  const badWait = await bridge.continueSession('hi', { threadId: EXPLICIT_THREAD, waitReplyMs: -1 });
  assert.equal(badWait.ok, false);
  assert.equal(badWait.error.code, 'invalid-wait-reply');
  assert.equal(runner.calls.length, 0);
});

test('active-writer：resume 失败自动 fallback queue（参数正确、解析 queuedMessageId、标记 queue/session-defined）', async () => {
  const { bridge, runner, dir } = await makeBridge({
    responses: [activeWriterRun(), queueAcceptedRun('msg-42')],
    extra: { rolloutRoot: path.join((await makeDir()), 'none') },
  });
  const result = await bridge.continueSession('请继续', { threadId: EXPLICIT_THREAD, waitReplyMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'queue');
  assert.equal(result.sandbox, 'session-defined');
  assert.equal(result.threadId, EXPLICIT_THREAD);
  assert.equal(result.queuedMessageId, 'msg-42');
  assert.equal(result.reply, null);
  assert.equal(result.note, 'queued-no-reply-in-timeout');
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(runner.calls[1].args, ['queue', '--thread', EXPLICIT_THREAD, '--message', '请继续']);
  assert.equal(result.waitedMs, 0);
});

test('queue 轮询：等待期间 rollout 新增 output_text → 返回新回复（不是历史回复）', async () => {
  const rolloutDir = await makeDir();
  const { filePath } = await makeRollout({ dir: rolloutDir, lines: [rolloutLine('历史回复', '2026-10-25T14:00:00.000Z')] });
  const { bridge } = await makeBridge({
    responses: [
      activeWriterRun(),
      async () => {
        await fs.appendFile(filePath, rolloutLine('测试通过', '2026-10-25T14:01:00.000Z'), 'utf8');
        return queueAcceptedRun('msg-9');
      },
    ],
    extra: { rolloutRoot: rolloutDir, pollIntervalMs: 5, now: () => Date.now() },
  });
  const result = await bridge.continueSession('再测', { threadId: EXPLICIT_THREAD, waitReplyMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'queue');
  assert.equal(result.reply, '测试通过');
  assert.equal(result.queuedMessageId, 'msg-9');
  assert.ok(result.waitedMs >= 0);
});

test('queue 超时无回复：ok:true、reply:null、note 如实，不假装成功', async () => {
  const rolloutDir = await makeDir();
  await makeRollout({ dir: rolloutDir, lines: [rolloutLine('旧', '2026-10-25T14:00:00.000Z')] });
  const { bridge } = await makeBridge({
    responses: [activeWriterRun(), queueAcceptedRun('msg-3')],
    extra: { rolloutRoot: rolloutDir, pollIntervalMs: 5, now: () => Date.now() },
  });
  const result = await bridge.continueSession('hi', { threadId: EXPLICIT_THREAD, waitReplyMs: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'queue');
  assert.equal(result.reply, null);
  assert.equal(result.note, 'queued-no-reply-in-timeout');
  assert.equal(result.queuedMessageId, 'msg-3');
});

test('非 active-writer 的 resume 错误不 fallback；queue 失败如实 queue-failed', async () => {
  const authFail = await makeBridge({ responses: [{ code: 1, stdout: '', stderr: 'auth failed' }] });
  const failed = await authFail.bridge.continueSession('hi', { threadId: EXPLICIT_THREAD });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'codex-failed');
  assert.equal(authFail.runner.calls.length, 1, '非 active-writer 不得 fallback');

  const queueFail = await makeBridge({ responses: [activeWriterRun(), { code: 2, stdout: '', stderr: 'queue error' }] });
  const queueFailed = await queueFail.bridge.continueSession('hi', { threadId: EXPLICIT_THREAD });
  assert.equal(queueFailed.ok, false);
  assert.equal(queueFailed.error.code, 'queue-failed');
  assert.equal(queueFail.runner.calls.length, 2);
});

test('CLI continue --thread --wait-reply-ms --json：参数传递与 JSON 输出（queue 模式）', async () => {
  const captured = [];
  const fakeBridge = {
    async continueSession(prompt, opts) {
      captured.push({ prompt, opts });
      return { ok: true, mode: 'queue', sandbox: 'session-defined', threadId: opts.threadId, queuedMessageId: 'msg-cli', reply: null, waitedMs: 0, note: 'queued-no-reply-in-timeout', resumed: true };
    },
  };
  const out = [];
  const err = [];
  const io = { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: (chunk) => err.push(chunk) }, cwd: process.cwd(), bridge: fakeBridge };
  const code = await main(['continue', '继续', '--thread', EXPLICIT_THREAD, '--wait-reply-ms', '0', '--json'], io);
  assert.equal(code, 0, err.join(''));
  assert.deepEqual(captured[0], { prompt: '继续', opts: { cwd: undefined, timeoutMs: undefined, model: undefined, threadId: EXPLICIT_THREAD, waitReplyMs: 0 } });
  const payload = JSON.parse(out.join(''));
  assert.equal(payload.mode, 'queue');
  assert.equal(payload.sandbox, 'session-defined');
  assert.equal(payload.reply, null);

  out.length = 0;
  const badWait = await main(['continue', 'x', '--wait-reply-ms', 'abc'], io);
  assert.equal(badWait, 2);
  out.length = 0;
  const sendThread = await main(['send', 'x', '--thread', EXPLICIT_THREAD], io);
  assert.equal(sendThread, 2);
});

test('CLI 人类输出：queue 模式明确打印 mode: queue / sandbox: session-defined', async () => {
  const fakeBridge = {
    async continueSession() { return { ok: true, mode: 'queue', sandbox: 'session-defined', threadId: EXPLICIT_THREAD, queuedMessageId: 'msg-h', reply: null, waitedMs: 0, note: 'queued-no-reply-in-timeout' }; },
  };
  const out = [];
  const io = { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write() {} }, cwd: process.cwd(), bridge: fakeBridge };
  assert.equal(await main(['continue', '继续'], io), 0);
  assert.match(out.join(''), /mode: queue/);
  assert.match(out.join(''), /sandbox: session-defined/);
  assert.match(out.join(''), /queuedMessageId: msg-h/);
});
