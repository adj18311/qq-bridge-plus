#!/usr/bin/env node
// t36 独立验证：黑话保底名额（t35）——「最近确认/编辑」的词条在同一 ≤30 上限内被保底保住，
// 且**三条模型可见路径**（qq_get_prompt / qq_slang_query / 每次唤醒注入的 block）集合完全一致；
// reserve=0 与**仓库里上一版实现**逐条等价（可回退）。
//
// 三条最容易含糊过去的点，本脚本专门证伪：
//   ① 新词是否真的进了**三条**路径（不是只看 block 或只看 query），且两条路径集合逐词一致；
//   ② 保底是否对「新确认」与「刚编辑」两种 updatedAt 刷新都生效（都走**真实端点**：confirm / PATCH）；
//   ③ reserve=0 是否真的等价旧行为 —— oracle 逐字取自 pre-t35 的 buildSlangContext
//      （`git show HEAD:src/slang-learner.js`），不是我自己编的「旧规则」。
// 做法：纯选择器层（真 import src/slang-learner.js）+ 真 bridge/HTTP 层（真路由、真端点、真唤醒投递）
// 两层都跑；不采信实现者自报，不读线上 config/state，不连 QQ/DSH，不改 src/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import * as coreBindings from './bridge-core-bindings.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  selectSlangForPrompt, buildSlangContext, SLANG_INJECT_MAX, SLANG_RECENT_RESERVE_DEFAULT, SLANG_STATUS,
} from '../src/slang-learner.js';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slangLib from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as retryObserver from '../src/retry-observer.js';
import * as retryDiagnostic from '../src/retry-diagnostic.js';
import * as errorNotice from '../src/error-notice.js';
import * as roleCard from '../src/role-card.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as snowlumaConn from '../src/snowluma-conn.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const CONSOLE_TOKEN = 'verify-slang-console-token';
const KEY = 'private:123';
const CONFIRMED = SLANG_STATUS.CONFIRMED;

// ── 冻结基线（t72）：oracle 必须锚在**固定提交**，绝不锚 HEAD ────────────────────────────────
// 为什么不能用 HEAD：本文件校验的是「pre-t35 的旧实现长什么样」。一旦本轮改动被 commit，HEAD 就变成
// 新实现 ⇒ S13 的旧表达式断言**立刻假红**（t70-F1 实测：14 通过 / 1 失败，EXIT 1）。锚固定 SHA 之后，
// 提交前后都守着同一份冻结历史，「工作区被改坏」也照样被后面的逐字比对抓到。
const FROZEN_BASELINE_SHA = '53a93be';   // 本轮改动前的最后一个提交：pre-t35 两行旧表达式原样在位
/**
 * 读冻结基线文件内容。**拿不到基线必须明确失败**，不许静默跳过（`skipped`）：
 * 浅克隆缺对象、SHA 打错、仓库被替换 —— 任何一种都会让 oracle 失去证据力，必须红并写明原因。
 */
function gitShowFrozen(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    const first = String(error?.message ?? error).split(/\r?\n/)[0].slice(0, 120);
    throw new Error(`冻结基线不可用：git show ${ref}:${file} 失败（${first}）—— oracle 必须能读到固定提交；`
      + '请补齐该提交的历史（fetch 该 SHA）或修正 FROZEN_BASELINE_SHA，**绝不许退回 HEAD 或静默跳过**');
  }
}

// ── 旧行为 oracle：逐字转写 pre-t35 的 buildSlangContext 选择表达式 ─────────────────────────
// 原文（git show 53a93be:src/slang-learner.js = 冻结基线，不是 HEAD）：
//   const confirmed = (entries || [])
//     .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
//     .sort((a, b) => (b.count || 0) - (a.count || 0))
//     .slice(0, Math.max(1, Math.min(30, Number(max) || 8)));
// S13 会用 git 校验这两行锚点仍在**冻结提交**里 ⇒ 这份 oracle 不是凭记忆编的。
function legacySelected(entries, max = 8) {
  return (entries || [])
    .filter((e) => e.status === CONFIRMED && e.content && e.meaning)
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, Math.max(1, Math.min(30, Number(max) || 8)));
}
const contentsOf = (list) => (list || []).map((e) => String(e?.content ?? ''));
const idsOf = (list) => (list || []).map((e) => String(e?.id ?? ''));
/** 从注入块文本里解析出词条（每行 `- 词：含义…`）。 */
const blockContents = (block) => String(block ?? '').split('\n')
  .filter((line) => line.startsWith('- '))
  .map((line) => line.slice(2).split('：')[0]);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/** 断言：entries（对象列表）与 block（注入块文本）是**同一集合**（逐词，缺一不可）。 */
function assertBlockMatchesEntries({ entries, block, label }) {
  const entryContents = contentsOf(entries);
  const parsed = blockContents(block);
  assert.ok(parsed.length > 0, `${label}：注入块必须至少有一行词条`);
  assert.ok(sameSet(entryContents, parsed),
    `${label}：block 与 entries 的集合必须完全相同，实测 entries=${JSON.stringify(entryContents)} block=${JSON.stringify(parsed)}`);
  assert.equal(parsed.length, entryContents.length, `${label}：条数也必须一致`);
}

// ── 造库 ─────────────────────────────────────────────────────────────────────────────────
const iso = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
function oldWord(i, { count = 1, updatedAt = iso(i) } = {}) {
  return {
    id: `old-${i}`, content: `老词${i}`, meaning: `老词${i}的含义`, usage: '', example: '',
    status: CONFIRMED, source: 'manual', count, createdAt: '2026-01-01T00:00:00.000Z', updatedAt,
  };
}
/** 40 条 count≥1 的老 confirmed + 1 条刚确认 count=0 的新词（updatedAt 最新）＝用户实测那个库。 */
function libraryWithNewWord() {
  const entries = [];
  for (let i = 1; i <= 40; i += 1) entries.push(oldWord(i, { count: i, updatedAt: iso(i) }));
  entries.push({
    id: 'new-1', content: '新词', meaning: '刚确认的新词含义', usage: '', example: '',
    status: CONFIRMED, source: 'manual', count: 0, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
  });
  return entries;
}

/** 在临时目录里跑真实桥接（假 api/假 bot），可预置 state/slang.json。 */
async function verifyHarness({ config = {}, seedSlang = null, transformSource, slangLibOverride = null } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-verify-slang-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  const socialV2 = {
    enabled: true,
    proactive: { enabled: false },
    sticker: { enabled: false },
    // 唤醒频率额度放宽：S10 要在同一 harness 里连续取多次「唤醒注入块」，默认 1 次/分钟会把后续唤醒拦掉
    wake: { maxWakePerMinute: 120, maxWakePerHour: 600 },
    ...(config.socialV2 ?? {}),
  };
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123, allow: { private: ['123'], groups: ['456'] },
    consolePort: 0, consoleToken: CONSOLE_TOKEN,
    slang: { injectMax: 30, ...(config.slang ?? {}) },
    ...Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'slang' && k !== 'socialV2')),
    socialV2,
  }));
  if (Array.isArray(seedSlang)) fs.writeFileSync(path.join(temp, 'state', 'slang.json'), JSON.stringify(seedSlang, null, 2));
  const calls = { prompts: [], follows: [] };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: { create: async () => success({ created: false, workspace: { workspaceId: 'fixture-ws' } }), archiveSession: async () => success({}) },
    sessions: {
      create: async (params) => { calls.prompts.push(params); return success({ sessionId: `fixture-session-${calls.prompts.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async () => ({ removed: 0 }),
    callUnary: async () => success({ accepted: true }),
    settings: { describe: async () => { throw new Error('fixture: settings 不可用'); } },
    agentPresets: { list: async () => success({ presets: [{ id: 'standard', isDefault: true }, { id: 'qq-chat' }, { id: 'qq-chat-v2' }] }) },
  };
  class FakeBot {
    async sendPrivateMessage() {}
    async sendGroupMessage() {}
    async request() { return { status: 'ok', retcode: 0, data: [] }; }
  }
  const timeouts = new Set();
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  if (typeof transformSource === 'function') source = transformSource(source);
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    cfg, state, api, slangEntries, ensureSession, getSocialV2State, startConsoleServer,
    sendWakePromptV2, scheduleWakeV2, pendingWakeKeys, promptQueues,
    slangSelectionV2, confirmedSlangListV2, slangBlockV2,
    selectSlangForPrompt, buildSlangContext,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const context = vm.createContext({
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal,
    console: { log() {}, error() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }),
    execFileSync: () => '',
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error(`unexpected exit ${code}`); } },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timeouts.add(t); return t; },
    clearTimeout: (t) => { timeouts.delete(t); clearTimeout(t); },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slangLib, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...coreBindings, ...retryObserver, ...retryDiagnostic, ...errorNotice,
    defaultErrorNoticeGate: errorNotice.createErrorNoticeGate(),
    ...roleCard, ...presetPrompt, ...snowlumaConn, yaml,
    ...(slangLibOverride ?? {}),
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    processAudioVolume: async (file) => ({ path: String(file), converted: false, applied: false, mode: 'original', volume: 1, loudness: null }),
    cleanupTemp: () => {},
  });
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.verifySlangReady = main();', context);
  const bridge = await context.verifySlangReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setMode('reserved2');
  bridge.setReady(true);
  bridge.calls = calls;
  bridge.temp = temp;
  return bridge;
}

function consoleRequest(server, { method = 'GET', pathname, query = null, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const search = query ? new URLSearchParams(query).toString() : '';
    const headers = { 'x-console-token': CONSOLE_TOKEN, connection: 'close' };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    const req = http.request({
      host: '127.0.0.1', port: server.address().port,
      path: `${pathname}?token=${encodeURIComponent(CONSOLE_TOKEN)}${search ? `&${search}` : ''}`,
      method, headers, agent: false,
    }, (response) => {
      let raw = '';
      response.on('data', (c) => { raw += c; });
      response.on('end', () => { let data = null; try { data = JSON.parse(raw); } catch {} resolve({ status: response.statusCode, data, raw }); });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request hung')));
    req.end(payload ?? undefined);
  });
}
/** 与 MCP 工具一致：query token + x-console-token + x-agent-token + x-agent-call。 */
const agentRequest = (server, opts) => new Promise((resolve, reject) => {
  const { method = 'GET', pathname, query = null, body, agentToken } = opts;
  const payload = body === undefined ? null : JSON.stringify(body);
  const search = query ? new URLSearchParams(query).toString() : '';
  const headers = { 'x-console-token': CONSOLE_TOKEN, 'x-agent-token': agentToken, 'x-agent-call': '1', connection: 'close' };
  if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
  const req = http.request({
    host: '127.0.0.1', port: server.address().port,
    path: `${pathname}?token=${encodeURIComponent(CONSOLE_TOKEN)}${search ? `&${search}` : ''}`,
    method, headers, agent: false,
  }, (response) => {
    let raw = '';
    response.on('data', (c) => { raw += c; });
    response.on('end', () => { let data = null; try { data = JSON.parse(raw); } catch {} resolve({ status: response.statusCode, data, raw }); });
  });
  req.on('error', reject);
  req.setTimeout(8000, () => req.destroy(new Error('request hung')));
  req.end(payload ?? undefined);
});
async function listen(server) {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return server;
}
async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let passes = 0;
const ONLY = process.env.VERIFY_ONLY || '';
async function test(name, run) {
  if (ONLY && !name.includes(ONLY)) return;
  console.log(`\n────────────────────────────────────────────────────────────────`);
  console.log(`▶ ${name}`);
  const t0 = Date.now();
  try {
    await run();
    passes += 1;
    console.log(`✅ PASS ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failures += 1;
    console.log(`❌ FAIL ${name}（${Date.now() - t0}ms）`);
    console.log(String(error?.stack ?? error?.message ?? error).split('\n').map((l) => `   ${l}`).join('\n'));
  }
}
async function withBridge(run, { config, seedSlang, transformSource, slangLibOverride } = {}) {
  const h = await verifyHarness({ config, seedSlang, transformSource, slangLibOverride });
  const server = await listen(h.startConsoleServer());
  try { await run(h, server); }
  finally { await closeServer(server); fs.rmSync(h.temp, { recursive: true, force: true }); }
}
/** 三条模型可见路径一次取全：prompt(entries/block)、query(entries/block)、唤醒注入的提示词文本。 */
async function readThreePaths(h, server) {
  const sid = await h.ensureSession(KEY);
  const token = h.getSocialV2State(KEY).agentToken;
  const promptRes = await agentRequest(server, { pathname: '/api/socialV2/prompt', query: { key: KEY }, agentToken: token });
  assert.equal(promptRes.status, 200, `qq_get_prompt 必须 200，实测 ${promptRes.status} ${promptRes.raw}`);
  const queryRes = await agentRequest(server, { pathname: '/api/socialV2/slang/query', query: { key: KEY }, agentToken: token });
  assert.equal(queryRes.status, 200, `qq_slang_query 必须 200，实测 ${queryRes.status} ${queryRes.raw}`);
  h.pendingWakeKeys.clear();
  h.promptQueues.clear();                       // 同一 harness 里多次取「唤醒注入块」时，别被上一轮的队列残留判成「忙」
  const st = h.getSocialV2State(KEY);
  if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; }
  const before = h.calls.prompts.length;
  await h.sendWakePromptV2(KEY, 'private', {});
  const delivery = h.calls.prompts.slice(before).find((p) => p.sessionId === sid);
  if (!delivery) {
    const listRes = await consoleRequest(server, { pathname: '/api/slang' });
    console.log(`   [诊断] 唤醒未投递：pendingWakeKeys=${h.pendingWakeKeys.has(KEY)} queue=${JSON.stringify(h.promptQueues.get(KEY) ?? null)}`
      + ` pendingWakeTimer=${!!st.pendingWakeTimer} wakeTimes=${(st.wakeTimes ?? []).length} cfgRecentReserve=${listRes.data?.config?.recentReserve}`);
  }
  assert.ok(delivery, '唤醒必须真的投递（api.sessions.prompt 必须被调用）');
  const wakeText = String(delivery?.content?.[0]?.text ?? '');
  return {
    promptEntries: promptRes.data?.slang?.entries ?? null,
    promptBlock: String(promptRes.data?.slang?.block ?? ''),
    queryEntries: queryRes.data?.entries ?? null,
    queryBlock: String(queryRes.data?.block ?? ''),
    wakeText,
  };
}

// ══ S1 reserve=0 与旧实现逐条等价（oracle 取自 git HEAD 的 pre-t35 版本）════════════════════
await test('S1 reserve=0 与 pre-t35 旧实现逐条等价（41 库 + 200 个随机库 + 并列/缺字段）', async () => {
  const lib = libraryWithNewWord();
  for (const max of [1, 5, 8, 30, 99]) {
    const mine = idsOf(selectSlangForPrompt(lib, { max, reserve: 0 }));
    const old = idsOf(legacySelected(lib, max));
    assert.deepEqual(mine, old, `reserve=0 max=${max} 必须与旧实现逐条相同`);
  }
  // 随机库（含并列 count、缺 updatedAt/count、候选/拒绝条目、同名不同 id）
  let seed = 20261006;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let cases = 0;
  for (let round = 0; round < 200; round += 1) {
    const n = 1 + Math.floor(rand() * 60);
    const entries = [];
    for (let i = 0; i < n; i += 1) {
      const roll = rand();
      const status = roll < 0.7 ? CONFIRMED : (roll < 0.85 ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.REJECTED);
      const entry = { id: `r${round}-${i}`, content: `词${round}-${i}`, meaning: rand() < 0.9 ? '含义' : '', status, count: rand() < 0.3 ? undefined : Math.floor(rand() * 5) };
      if (rand() < 0.7) entry.updatedAt = iso(Math.floor(rand() * 40));
      if (rand() < 0.1) entry.content = '';                       // 空 content：两边都必须滤掉
      entries.push(entry);
    }
    const max = [1, 3, 8, 30][Math.floor(rand() * 4)];
    const mine = idsOf(selectSlangForPrompt(entries, { max, reserve: 0 }));
    const old = idsOf(legacySelected(entries, max));
    assert.deepEqual(mine, old, `随机库 #${round}（max=${max}）：reserve=0 必须与旧实现逐条相同\nmine=${JSON.stringify(mine)}\nold =${JSON.stringify(old)}`);
    cases += 1;
  }
  console.log(`   [证据] 41 库 × max{1,5,8,30,99} + ${cases} 个随机库：reserve=0 与 pre-t35 oracle **逐条相同**（deepEqual 全部通过）`);
});

// ══ S2 保底语义：updatedAt 最新 reserve 条在前，其余按 count 降序补齐 ═══════════════════════
await test('S2 保底=updatedAt 最新 reserve 条（在前）+ 其余按 count 降序补齐、无重复、≤ max', async () => {
  const lib = libraryWithNewWord();
  const picked = selectSlangForPrompt(lib, { max: 30, reserve: 5 });
  const ids = idsOf(picked);
  assert.equal(picked.length, 30, `41 库 reserve=5 必须选满 30 条，实测 ${picked.length}`);
  assert.equal(new Set(ids).size, ids.length, '不得有重复条目');
  const expectedRecent = ['new-1', 'old-40', 'old-39', 'old-38', 'old-37'];
  assert.deepEqual(ids.slice(0, 5), expectedRecent, `前 5 条必须是 updatedAt 最新的 5 条（保底区，updatedAt 降序），实测 ${JSON.stringify(ids.slice(0, 5))}`);
  const tail = ids.slice(5);
  const counts = tail.map((id) => Number(lib.find((e) => e.id === id)?.count ?? 0));
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(counts[i - 1] >= counts[i], `补齐区必须按 count 降序，实测 ${JSON.stringify(counts)}`);
  }
  assert.deepEqual(tail, ['old-36', 'old-35', 'old-34', 'old-33', 'old-32', 'old-31', 'old-30', 'old-29', 'old-28', 'old-27', 'old-26', 'old-25', 'old-24', 'old-23', 'old-22', 'old-21', 'old-20', 'old-19', 'old-18', 'old-17', 'old-16', 'old-15', 'old-14', 'old-13', 'old-12'].slice(0, tail.length), `补齐区必须是剩余的最高 count 序列，实测 ${JSON.stringify(tail)}`);
  const noReserve = idsOf(selectSlangForPrompt(lib, { max: 30, reserve: 0 }));
  assert.ok(!noReserve.includes('new-1'), 'reserve=0 时新词必须落选（它就是旧行为下那个永远进不来的词）');
  assert.ok(ids.includes('new-1'), 'reserve=5 时新词必须被保底保住');
  console.log(`   [证据] reserve=5：${JSON.stringify(ids.slice(0, 5))}（保底区）→ 补齐区 ${JSON.stringify(tail.slice(0, 5))}… 共 30 条、无重复；reserve=0 时新词落选=${!noReserve.includes('new-1')}`);
});

// ══ S3 边界：≤max 全给 / reserve>候选 / 缺 updatedAt 最旧 / 并列稳定 / 全 count=0 ═══════════
await test('S3 边界：≤max 全给、reserve>候选退回 count、缺 updatedAt 视为最旧、并列稳定、全 count=0、空库', async () => {
  // ① confirmed ≤ max ⇒ 全给、不截断（顺序按注释 ③④：保底区在前 = updatedAt 降序）
  const small = [oldWord(1, { count: 3 }), oldWord(2, { count: 9 }), oldWord(3, { count: 1 })];
  const all = selectSlangForPrompt(small, { max: 30, reserve: 5 });
  assert.equal(all.length, 3, `confirmed(3) ≤ max(30) 必须全给，实测 ${all.length}`);
  assert.deepEqual(idsOf(all).sort(), ['old-1', 'old-2', 'old-3'], '≤max 时必须三条都在（不截断）');
  assert.deepEqual(idsOf(all), ['old-3', 'old-2', 'old-1'], `≤max + reserve>0 的顺序仍是「保底在前（updatedAt 降序）」再补齐（count 降序）`);
  assert.deepEqual(idsOf(selectSlangForPrompt(small, { max: 30, reserve: 0 })), ['old-2', 'old-1', 'old-3'], 'reserve=0 时顺序退回旧的 count 降序');
  // ② reserve > 候选数：保底区吃不满，其余按 count
  const few = [oldWord(1, { count: 5 }), oldWord(2, { count: 1 })];
  const r = selectSlangForPrompt(few, { max: 30, reserve: 30 });
  assert.equal(r.length, 2, 'reserve > 候选数时不得凭空多出条目');
  assert.deepEqual(idsOf(r), ['old-2', 'old-1'], '保底区取 updatedAt 最新（old-2 更新），补齐按 count');
  // ③ 缺/非法 updatedAt ⇒ 视为最旧：绝不能抢到保底名额
  const missing = [oldWord(1, { count: 1, updatedAt: undefined }), oldWord(2, { count: 1, updatedAt: iso(5) }), oldWord(3, { count: 1, updatedAt: iso(9) })];
  delete missing[0].updatedAt;
  assert.deepEqual(idsOf(selectSlangForPrompt(missing, { max: 1, reserve: 1 })), ['old-3'],
    '缺 updatedAt 的条目绝不能拿到保底名额（max=1/reserve=1 时保底必须给 updatedAt 最新的 old-3）');
  assert.deepEqual(idsOf(selectSlangForPrompt(missing, { max: 3, reserve: 1 })), ['old-3', 'old-1', 'old-2'],
    '补齐区按 count 降序、并列保持输入顺序：缺 updatedAt 的 old-1 只能靠补齐进来');
  assert.deepEqual(idsOf(selectSlangForPrompt(missing, { max: 2, reserve: 1 })), ['old-3', 'old-1'],
    '同上前两条（保底 old-3 + 补齐区输入序第一条）');
  // ④ updatedAt 并列：稳定（保持输入顺序）且不重复
  const tie = [oldWord(1, { count: 2, updatedAt: iso(7) }), oldWord(2, { count: 2, updatedAt: iso(7) }), oldWord(3, { count: 2, updatedAt: iso(7) })];
  const tiePicked = idsOf(selectSlangForPrompt(tie, { max: 2, reserve: 2 }));
  assert.deepEqual(tiePicked, ['old-1', 'old-2'], `并列 updatedAt 必须稳定按输入顺序，实测 ${JSON.stringify(tiePicked)}`);
  assert.equal(new Set(tiePicked).size, tiePicked.length, '并列不得产生重复');
  // ⑤ 全部 count=0
  const zero = [oldWord(1, { count: 0, updatedAt: iso(1) }), oldWord(2, { count: 0, updatedAt: iso(2) })];
  const zeroPicked = idsOf(selectSlangForPrompt(zero, { max: 30, reserve: 5 }));
  assert.deepEqual(zeroPicked, ['old-2', 'old-1'], '全 count=0 时必须按 updatedAt 保底顺序给出，且不报错');
  // ⑥ 空库 / 无 confirmed
  assert.deepEqual(selectSlangForPrompt([], { max: 30, reserve: 5 }), [], '空库必须返回空数组');
  assert.deepEqual(selectSlangForPrompt([{ id: 'c1', content: 'x', meaning: 'y', status: SLANG_STATUS.CANDIDATE }], { max: 30, reserve: 5 }), [], '无 confirmed 必须返回空数组');
  assert.equal(buildSlangContext([], 30, { reserve: 5 }), '', '空库的注入块必须是空串');
  console.log('   [证据] ①≤max 全给 ②reserve>候选不多给 ③缺 updatedAt 最旧 ④并列稳定无重复 ⑤全 count=0 有序 ⑥空库/无 confirmed 返回空');
});

// ══ S4 clamp：max 1..30（含 0/负/超限/非数字回落）、reserve 0..max；不改写入参数组 ═════════
await test('S4 clamp：max 0/8/30/99/-5 与 reserve -5/0/5/30/200 均按 clamp 生效；不改写入参；确定性', async () => {
  const lib = libraryWithNewWord();
  const lenWith = (max, reserve) => selectSlangForPrompt(lib, { max, reserve }).length;
  assert.equal(lenWith(30, 5), 30, 'max=30 → 30');
  assert.equal(lenWith(99, 5), 30, 'max=99 必须 clamp 到 30');
  assert.equal(lenWith(-5, 5), 1, 'max=-5 → clamp 到 1');
  assert.equal(lenWith(0, 5), 8, 'max=0 走 `Number(max)||8` 回退 → 8（与旧实现同一表达式）');
  assert.equal(lenWith(8, 200), 8, 'reserve=200 必须 clamp 到 max=8');
  assert.equal(lenWith(30, -5), 30, 'reserve=-5 必须 clamp 到 0（按 count 补齐仍满 30）');
  assert.equal(lenWith(30, 200), 30, 'reserve=200 clamp 到 30（全为保底区）');
  const r200 = idsOf(selectSlangForPrompt(lib, { max: 30, reserve: 200 }));
  const r30 = idsOf(selectSlangForPrompt(lib, { max: 30, reserve: 30 }));
  assert.deepEqual(r200, r30, 'reserve=200 与 reserve=30（=max）必须完全一致');
  // 不改写入参
  const snapshot = JSON.stringify(lib);
  selectSlangForPrompt(lib, { max: 8, reserve: 5 });
  assert.equal(JSON.stringify(lib), snapshot, '选择器不得改写调用方传入的数组/对象');
  // 确定性
  assert.deepEqual(idsOf(selectSlangForPrompt(lib, { max: 30, reserve: 5 })), idsOf(selectSlangForPrompt(lib, { max: 30, reserve: 5 })), '同一输入必须确定性输出');
  console.log(`   [证据] max{30→30, 99→30, -5→1, 0→8}；reserve{200@max8→8, -5→0, 200@max30≡30}；入参快照未变；两次调用一致`);
});

// ══ S5 buildSlangContext：reserve=0 逐行等于旧选择；块头是新文案 ═══════════════════════════
await test('S5 buildSlangContext：reserve=0 的块逐行等于旧选择；块头文案为「最近确认的排在前，其余按出现次数」', async () => {
  const lib = libraryWithNewWord();
  const block = buildSlangContext(lib, 8, { reserve: 0 });
  assert.deepEqual(blockContents(block), contentsOf(legacySelected(lib, 8)), 'reserve=0 的块内容必须逐行等于旧实现选出的词');
  const block5 = buildSlangContext(lib, 30, { reserve: 5 });
  assert.ok(block5.includes('- 新词：'), 'reserve=5 的块必须含新词那一行');
  assert.ok(block5.startsWith('【群聊黑话表】') && block5.includes('最近确认的排在前，其余按出现次数'), `块头必须写明新口径，实测首行=${JSON.stringify(block5.split('\n')[0])}`);
  assert.equal(buildSlangContext(lib, 30).includes('最近确认的排在前'), true, '不传 reserve 时（旧签名）也必须走同一选择器与新块头');
  console.log(`   [证据] reserve=0 块内容 == 旧实现选择（${blockContents(block).length} 行）；reserve=5 块含「新词」；块头=「…最近确认的排在前，其余按出现次数…」`);
});

// ══ S6 三路径必达 + 集合一致（真实 bridge / 真 HTTP / 真唤醒投递）═══════════════════════════
await test('S6 三路径必达：qq_get_prompt.entries / qq_slang_query.entries / 唤醒注入 block 都有新词，且集合逐词一致', async () => {
  await withBridge(async (h, server) => {
    const paths = await readThreePaths(h, server);
    assert.ok(paths.promptEntries?.length === 30, `qq_get_prompt 的 slang.entries 必须是 30 条，实测 ${paths.promptEntries?.length}`);
    assert.ok(paths.queryEntries?.length === 30, `qq_slang_query 的 entries 必须是 30 条，实测 ${paths.queryEntries?.length}`);
    for (const [label, list] of [['qq_get_prompt.slang.entries', paths.promptEntries], ['qq_slang_query.entries', paths.queryEntries]]) {
      assert.ok(contentsOf(list).includes('新词'), `${label} 必须含新词，实测 ${JSON.stringify(contentsOf(list))}`);
    }
    assert.ok(blockContents(paths.promptBlock).includes('新词'), 'qq_get_prompt 的 slang.block 必须含新词');
    assert.ok(blockContents(paths.queryBlock).includes('新词'), 'qq_slang_query 的 block 必须含新词');
    assert.ok(blockContents(paths.wakeText).includes('新词'), `唤醒注入的提示词必须含新词（block），实测尾部=${JSON.stringify(String(paths.wakeText).slice(-160))}`);
    assert.equal(paths.promptBlock, paths.queryBlock, '两条路径的 block 必须逐字相同（同一选择器 + 同一配置）');
    assert.ok(paths.wakeText.includes(paths.promptBlock), '唤醒提示词里必须嵌入与 prompt/query 完全相同的 block');
    assertBlockMatchesEntries({ entries: paths.promptEntries, block: paths.promptBlock, label: 'S6 qq_get_prompt' });
    assertBlockMatchesEntries({ entries: paths.queryEntries, block: paths.queryBlock, label: 'S6 qq_slang_query' });
    assert.deepEqual(idsOf(paths.promptEntries), idsOf(paths.queryEntries), '两条路径的 entries 必须逐条相同（含顺序）');
    console.log(`   [证据] prompt.entries=${paths.promptEntries.length} 含新词=${contentsOf(paths.promptEntries).includes('新词')}；query.entries=${paths.queryEntries.length} 含新词=${contentsOf(paths.queryEntries).includes('新词')}（两条逐条相同）；block 24/30 词集合一致=blockMatchesEntries 通过；唤醒提示词含同一 block（长度 ${paths.wakeText.length}）`);
  }, { seedSlang: libraryWithNewWord() });
});

// ══ S7 「新确认」走真实端点：候选择变成 confirmed 后必须三处可见 ═════════════════════════════
await test('S7 「新确认」（真实端点 POST /api/slang/:id/confirm）：updatedAt 刷新 → 三条路径都保住它', async () => {
  const seed = libraryWithNewWord();
  seed.push({
    id: 'cand-1', content: '候选新词', meaning: '刚被管理员确认的候选', usage: '', example: '',
    status: SLANG_STATUS.CANDIDATE, source: 'ai', count: 0, createdAt: '2026-10-06T01:00:00.000Z', updatedAt: '2026-10-06T01:00:00.000Z',
  });
  await withBridge(async (h, server) => {
    await h.ensureSession(KEY);
    const confirm = await consoleRequest(server, { method: 'POST', pathname: '/api/slang/cand-1/confirm', body: {} });
    assert.equal(confirm.status, 200, `确认端点必须 200，实测 ${confirm.status} ${confirm.raw}`);
    assert.equal(confirm.data?.entry?.status, 'confirmed', '确认后状态必须变 confirmed');
    const confirmedAt = String(confirm.data?.entry?.updatedAt ?? '');
    assert.ok(confirmedAt >= '2026-10-06T01:00:00.000Z', `确认必须刷新 updatedAt，实测 ${confirmedAt}`);
    const paths = await readThreePaths(h, server);
    for (const [label, list] of [['prompt.slang.entries', paths.promptEntries], ['query.entries', paths.queryEntries]]) {
      assert.ok(contentsOf(list).includes('候选新词'), `${label} 必须含刚确认的「候选新词」`);
    }
    assert.ok(blockContents(paths.wakeText).includes('候选新词'), '唤醒提示词必须含刚确认的词');
    assertBlockMatchesEntries({ entries: paths.queryEntries, block: paths.queryBlock, label: 'S7 query' });
    console.log(`   [证据] POST /api/slang/cand-1/confirm → status=${confirm.data?.entry?.status}、updatedAt=${confirmedAt}；prompt/query/唤醒 block 三处都含「候选新词」`);
  }, { seedSlang: seed });
});

// ══ S8 「刚编辑」走真实端点：老词 PATCH 后 updatedAt 刷新 → 保住 ═════════════════════════════
await test('S8 「刚编辑」（真实端点 PATCH /api/slang/:id）：老词 updatedAt 刷新 → 三条路径都保住它', async () => {
  const seed = libraryWithNewWord();
  // 让 old-1 原本是「最旧 + count 最低」⇒ 旧行为下必然排在 40 条之外
  seed[0] = oldWord(1, { count: 0, updatedAt: '2025-01-01T00:00:00.000Z' });
  await withBridge(async (h, server) => {
    await h.ensureSession(KEY);
    const patch = await consoleRequest(server, { method: 'PATCH', pathname: '/api/slang/old-1', body: { usage: '刚刚被编辑过' } });
    assert.equal(patch.status, 200, `编辑端点必须 200，实测 ${patch.status} ${patch.raw}`);
    assert.ok(String(patch.data?.entry?.updatedAt ?? '') > '2026-01-01T00:00:00.000Z', `编辑必须刷新 updatedAt，实测 ${patch.data?.entry?.updatedAt}`);
    const paths = await readThreePaths(h, server);
    for (const [label, list] of [['prompt.slang.entries', paths.promptEntries], ['query.entries', paths.queryEntries]]) {
      assert.ok(contentsOf(list).includes('老词1'), `${label} 必须含刚编辑的「老词1」`);
    }
    assert.ok(blockContents(paths.promptBlock).includes('老词1'), 'prompt.block 必须含刚编辑的词');
    assert.ok(blockContents(paths.wakeText).includes('老词1'), '唤醒提示词必须含刚编辑的词');
    assertBlockMatchesEntries({ entries: paths.promptEntries, block: paths.promptBlock, label: 'S8 prompt' });
    console.log(`   [证据] PATCH /api/slang/old-1 → updatedAt=${patch.data?.entry?.updatedAt}（刷新）；prompt/query/唤醒 block 三处都含「老词1」（count=0 的老词靠保底进来）`);
  }, { seedSlang: seed });
});

// ══ S9 reserve=0 端到端等价旧行为（真端点 + oracle 逐条）════════════════════════════════════
await test('S9 reserve=0 端到端：POST /api/slang/config 后 query/prompt entries 与旧 oracle 逐条相同，新词落选', async () => {
  await withBridge(async (h, server) => {
    const cfgRes = await consoleRequest(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: 0 } });
    assert.equal(cfgRes.status, 200, `配置端点必须 200，实测 ${cfgRes.status} ${cfgRes.raw}`);
    assert.equal(cfgRes.data?.config?.recentReserve, 0, `回显必须是 0，实测 ${cfgRes.raw}`);
    const listRes = await consoleRequest(server, { pathname: '/api/slang' });
    const loaded = listRes.data?.entries ?? [];
    assert.equal(listRes.data?.config?.recentReserve, 0, 'GET /api/slang 的 config 回显必须也是 0');
    const paths = await readThreePaths(h, server);
    const expected = idsOf(legacySelected(loaded, 30));
    assert.deepEqual(idsOf(paths.promptEntries), expected, 'reserve=0 时 prompt.entries 必须与旧 oracle 逐条相同（含顺序）');
    assert.deepEqual(idsOf(paths.queryEntries), expected, 'reserve=0 时 query.entries 必须与旧 oracle 逐条相同');
    assert.ok(!contentsOf(paths.queryEntries).includes('新词'), 'reserve=0 时新词必须落选（旧行为的真实复现）');
    assert.ok(!blockContents(paths.wakeText).includes('新词'), 'reserve=0 时唤醒提示词也不该出现新词');
    console.log(`   [证据] POST recentReserve=0 → 回显=0；prompt/query entries == 旧 oracle（30 条逐条相同）；新词落选=${!contentsOf(paths.queryEntries).includes('新词')}`);
  }, { seedSlang: libraryWithNewWord() });
});

// ══ S10 clamp 端到端（真端点）：-5/0/5/30/200 → 0/0/5/30/30；injectMax>30 → 30 ═════════════
await test('S10 clamp 端到端：POST /api/slang/config 的 recentReserve -5/0/5/30/200 → 0/0/5/30/30；injectMax>30 → 30', async () => {
  await withBridge(async (h, server) => {
    const cases = [[-5, 0], [0, 0], [5, 5], [30, 30], [200, 30]];
    for (const [input, expect] of cases) {
      const res = await consoleRequest(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: input } });
      assert.equal(res.status, 200, `recentReserve=${input} 必须 200，实测 ${res.status} ${res.raw}`);
      assert.equal(res.data?.config?.recentReserve, expect, `recentReserve=${input} 必须生效为 ${expect}，实测 ${JSON.stringify(res.data?.config?.recentReserve)}`);
      const listRes = await consoleRequest(server, { pathname: '/api/slang' });
      assert.equal(listRes.data?.config?.recentReserve, expect, `recentReserve=${input} 的 GET 回显必须也是 ${expect}`);
      // 行为核对：同一库、同一 max，与纯选择器（用 clamp 后的 reserve）逐条一致
      const loaded = listRes.data?.entries ?? [];
      const expectedIds = idsOf(selectSlangForPrompt(loaded, { max: 30, reserve: expect }));
      const paths = await readThreePaths(h, server);
      assert.deepEqual(idsOf(paths.queryEntries), expectedIds, `recentReserve=${input}（生效 ${expect}）时的实际清单必须与同参数选择器逐条相同`);
    }
    const big = await consoleRequest(server, { method: 'POST', pathname: '/api/slang/config', body: { injectMax: 99, recentReserve: 200 } });
    assert.equal(big.data?.config?.injectMax, 30, `injectMax=99 必须 clamp 到 30，实测 ${JSON.stringify(big.data?.config?.injectMax)}`);
    assert.equal(big.data?.config?.recentReserve, 30, `同请求里 recentReserve=200 必须 clamp 到 30，实测 ${JSON.stringify(big.data?.config?.recentReserve)}`);
    const small = await consoleRequest(server, { method: 'POST', pathname: '/api/slang/config', body: { injectMax: 8, recentReserve: 999 } });
    assert.equal(small.data?.config?.injectMax, 8, 'injectMax=8 应保持 8');
    assert.equal(small.data?.config?.recentReserve, 8, `injectMax=8 + recentReserve=999 必须 clamp 到 8，实测 ${JSON.stringify(small.data?.config?.recentReserve)}`);
    const bad = await consoleRequest(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: 'abc' } });
    assert.equal(bad.data?.config?.recentReserve, SLANG_RECENT_RESERVE_DEFAULT, `非数字必须回落默认 ${SLANG_RECENT_RESERVE_DEFAULT}，实测 ${JSON.stringify(bad.data?.config?.recentReserve)}`);
    console.log('   [证据] -5→0 / 0→0 / 5→5 / 30→30 / 200→30（每次都用同参数选择器逐条核对行为）；injectMax 99→30 且 reserve 200→30；injectMax 8 + reserve 999 → 8；\'abc\'→5');
  }, { seedSlang: libraryWithNewWord() });
});

// ══ S11 边界端到端：confirmed ≤ max 全给；全 count=0 + 并列 ═════════════════════════════════
await test('S11 边界端到端：confirmed(3) ≤ max 全给不截断；全 count=0 + 并列不报错、无重复、≤上限、集合一致', async () => {
  const few = [oldWord(1, { count: 9, updatedAt: iso(1) }), oldWord(2, { count: 3, updatedAt: iso(2) }), oldWord(3, { count: 0, updatedAt: iso(3) })];
  await withBridge(async (h, server) => {
    const paths = await readThreePaths(h, server);
    assert.equal(paths.promptEntries.length, 3, `confirmed(3) ≤ max(30) 必须全给，实测 ${paths.promptEntries.length}`);
    assert.equal(paths.queryEntries.length, 3, 'query 也必须全给');
    assert.deepEqual(contentsOf(paths.queryEntries).sort(), ['老词1', '老词2', '老词3'].sort(), '三条都必须出现（不截断）');
    assertBlockMatchesEntries({ entries: paths.queryEntries, block: paths.queryBlock, label: 'S11 全给' });
  }, { seedSlang: few });
  const zero = [];
  for (let i = 1; i <= 45; i += 1) zero.push({ ...oldWord(i, { count: 0, updatedAt: iso(10) }), content: `零词${i}`, id: `zero-${i}` });
  await withBridge(async (h, server) => {
    const paths = await readThreePaths(h, server);
    const list = contentsOf(paths.queryEntries);
    assert.equal(list.length, 30, `45 条同 updatedAt 的 count=0 库必须仍截到 30，实测 ${list.length}`);
    assert.equal(new Set(list).size, list.length, '不得有重复');
    assertBlockMatchesEntries({ entries: paths.queryEntries, block: paths.queryBlock, label: 'S11 全 count=0' });
    assert.deepEqual(idsOf(paths.promptEntries), idsOf(paths.queryEntries), '并列 updatedAt 下两条路径也必须逐条相同（稳定）');
    console.log(`   [证据] confirmed(3) ≤ max(30) 全给=3 条；45 条并列 count=0 库 → 30 条、无重复、block/entries 集合一致、两路径逐条相同`);
  }, { seedSlang: zero });
});

// ══ S12 缺 updatedAt 端到端（实测 §19.5 那条已记档的边界）══════════════════════════════════
await test('S12 缺 updatedAt 端到端：文件加载会把 updatedAt 补成 now（§19.5 已记档）⇒ 该条会拿到保底名额', async () => {
  const seed = libraryWithNewWord();
  seed.push({ id: 'no-ts', content: '无时间戳词', meaning: '历史条目缺 updatedAt', usage: '', example: '', status: CONFIRMED, source: 'ai', count: 0 });
  await withBridge(async (h, server) => {
    const listRes = await consoleRequest(server, { pathname: '/api/slang' });
    const loaded = (listRes.data?.entries ?? []).find((e) => e.id === 'no-ts');
    assert.ok(loaded, '缺 updatedAt 的条目必须仍在库里（不能被丢）');
    const filled = String(loaded.updatedAt ?? '');
    assert.ok(filled.length > 0, '实测：加载 normalize 会把缺失的 updatedAt 补成当前时间');
    const paths = await readThreePaths(h, server);
    const inList = contentsOf(paths.queryEntries).includes('无时间戳词');
    console.log(`   [证据] 缺 updatedAt 的条目被 loadSlang 补成 ${filled} ⇒ 它被当成「刚更新」；实测它是否进入清单：${inList}`);
    assert.equal(inList, true, '实测口径：加载期补 now ⇒ 该条会被当成最新并拿到保底名额（选择器层另按「最旧」，见 S3）');
  }, { seedSlang: seed });
});

// ══ S13 静态锚点：唯一选择器 / 两路径共用 / 常量 / oracle 可信 ═══════════════════════════════
await test('S13 静态锚点：两条模型可见路径共用唯一选择器；SLANG_INJECT_MAX=30、默认 reserve=5；oracle 与冻结提交一致（不用 HEAD）', async () => {
  const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const learnerSrc = fs.readFileSync(path.join(root, 'src/slang-learner.js'), 'utf8');
  assert.equal(SLANG_INJECT_MAX, 30, 'SLANG_INJECT_MAX 必须是 30');
  assert.equal(SLANG_RECENT_RESERVE_DEFAULT, 5, '默认保底名额必须是 5');
  assert.match(learnerSrc, /export function selectSlangForPrompt\(entries, \{ max = 8, reserve = 0 \} = \{\}\)/, '必须有唯一选择器 selectSlangForPrompt');
  assert.match(bridgeSrc, /function confirmedSlangListV2\(\) \{[\s\S]{0,300}selectSlangForPrompt\(slangEntries, \{ max, reserve \}\)/, 'confirmedSlangListV2 必须走唯一选择器');
  assert.match(bridgeSrc, /function slangBlockV2\(\) \{[\s\S]{0,200}buildSlangContext\(slangEntries, max, \{ reserve \}\)/, 'slangBlockV2 必须走 buildSlangContext（内部即同一选择器）');
  assert.match(bridgeSrc, /const reserveNum = \(reserveRaw === undefined \|\| reserveRaw === null \|\| reserveRaw === ''\)\s*\n\s*\? SLANG_RECENT_RESERVE_DEFAULT/, '未配置 recentReserve 时必须取默认 5');
  // t40/F3 + t42：配置写入路径必须把 null / undefined / 空串视作「未设置」⇒ 回落默认（不得静默关掉保底），
  // 且显式 0 仍原样保留（合法开关）。这条静态锚点把新口径钉住，防止实现悄悄退回 null→0。
  assert.match(bridgeSrc, /const reserveUnset = rawReserve === null \|\| rawReserve === undefined\s*\n\s*\|\| \(typeof rawReserve === 'string' && rawReserve\.trim\(\) === ''\)/,
    '写入路径必须把 null/undefined/空串（含空白串）判为「未设置」');
  assert.match(bridgeSrc, /const n = reserveUnset \? SLANG_RECENT_RESERVE_DEFAULT : Math\.round\(Number\(rawReserve\)\)/,
    '「未设置」必须回落默认 5；其余才走 Number 解析（显式 0 因此仍是 0）');
  assert.match(bridgeSrc, /merged\.recentReserve = Number\.isFinite\(n\) \? Math\.max\(0, Math\.min\(effectiveInjectMax, n\)\) : SLANG_RECENT_RESERVE_DEFAULT/,
    '非有限数（非数字字符串等）也必须回落默认 5');
  const promptEndpoint = bridgeSrc.slice(bridgeSrc.indexOf("url.pathname === '/api/socialV2/prompt'"), bridgeSrc.indexOf("url.pathname === '/api/socialV2/prompt'") + 12000);
  assert.match(promptEndpoint, /entries: confirmedSlangListV2\(\),\s*\n\s*block: slangBlockV2\(\)/, 'qq_get_prompt 必须同时用这两个（同一选择器）');
  const queryEndpoint = bridgeSrc.slice(bridgeSrc.indexOf("url.pathname === '/api/socialV2/slang/query'"), bridgeSrc.indexOf("url.pathname === '/api/socialV2/slang/query'") + 3000);
  assert.match(queryEndpoint, /const list = confirmedSlangListV2\(\)/, 'qq_slang_query 必须用 confirmedSlangListV2');
  assert.match(queryEndpoint, /block: slangBlockV2\(\)/, 'qq_slang_query 必须用 slangBlockV2');
  // oracle 可信度：**冻结提交（pre-t35）**里必须仍是那两行旧表达式。
  // t72：以前这里读 `HEAD:…` ⇒ 一提交就假红；现在读固定 SHA，且取不到基线会**抛错**（不静默跳过）。
  const frozen = gitShowFrozen(FROZEN_BASELINE_SHA, 'src/slang-learner.js');
  assert.match(frozen, /\.sort\(\(a, b\) => \(b\.count \|\| 0\) - \(a\.count \|\| 0\)\)/, `冻结基线 ${FROZEN_BASELINE_SHA} 里必须仍是旧排序表达式`);
  assert.match(frozen, /\.slice\(0, Math\.max\(1, Math\.min\(30, Number\(max\) \|\| 8\)\)\)/, `冻结基线 ${FROZEN_BASELINE_SHA} 里必须仍是旧 slice 表达式`);
  assert.ok(!/selectSlangForPrompt/.test(frozen), `冻结基线 ${FROZEN_BASELINE_SHA} 必须仍是**旧**实现（不得含 selectSlangForPrompt；否则说明 SHA 选错了）`);
  const gitOracle = `frozen@${FROZEN_BASELINE_SHA}`;
  // ── 防复发（t72）：oracle/基线不得锚在 HEAD —— 本文件自审，写在 S13 里（不新增用例）────────
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // 只看**代码**：先把注释剥掉，避免把「为什么不能用 HEAD」这类说明文字误判成锚点。
  const selfCode = selfSrc.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const HEAD_REF = 'HE' + 'AD';   // 拆开写 + 消息里也用插值：否则本检查会把自己的文本当成违规
  assert.ok(!selfCode.includes(`${HEAD_REF}:src/`), `本文件不得把 ${HEAD_REF}:<path> 当 git show 的 refspec（一提交就假红）`);
  assert.ok(!new RegExp(`execFileSync\\([^)]*${HEAD_REF}`).test(selfCode), `本文件不得用 git show ${HEAD_REF}… 当基线`);
  assert.match(selfSrc, /const FROZEN_BASELINE_SHA = '[0-9a-f]{7,40}';/, '必须保留固定 SHA 常量（冻结基线）');
  assert.match(selfCode, /gitShowFrozen\(FROZEN_BASELINE_SHA, 'src\/slang-learner\.js'\)/, 'oracle 必须经 gitShowFrozen 读固定 SHA');
  assert.match(selfCode, /throw new Error\(`冻结基线不可用/, '取不到冻结基线必须明确抛错（不得静默 skipped）');
  assert.ok(!/skipped\(/.test(selfCode), '不得退回「取不到就 skipped」的静默放行写法');
  console.log(`   [证据] 唯一选择器 + 两路径共用（静态锚点全中）；SLANG_INJECT_MAX=30、默认 reserve=5；`
    + `旧实现 oracle=${gitOracle}（冻结基线里两行旧表达式在、且不含 selectSlangForPrompt）；防复发自审：无 HEAD 锚点`);
});

// ══ S14 载荷性反证：中和「保底」/ 破坏「两路径共用选择器」→ 本套断言必然转红 ════════════════
// 变异只发生在**模块边界**（VM context 里替换从 slang-learner.js 注入的绑定），src/ 一个字节都不动。
await test('S14 载荷性反证（变异体）：中和保底 → S6 断言必红；让 block 用另一套 max → 集合一致断言必红', async () => {
  // 变异 A：把「保底名额」中和掉（两条路径都退回 reserve=0 ＝ 旧行为）
  await withBridge(async (h, server) => {
    const paths = await readThreePaths(h, server);
    assert.ok(!contentsOf(paths.queryEntries).includes('新词'),
      '变异 A（保底恒 0）下新词必须落选 —— 这正是 S6「必须含新词」会转红的原因（本套断言不是空断言）');
    assert.ok(!blockContents(paths.promptBlock).includes('新词'), '变异 A 下 block 也必然不含新词');
    console.log('   [反证 A] 保底被中和 ⇒ 新词从 entries 与 block 同时消失：S2/S6/S7/S8 的「必须含新词」会因此转红 ✔');
  }, {
    seedSlang: libraryWithNewWord(),
    slangLibOverride: {
      selectSlangForPrompt: (entries, opts = {}) => slangLib.selectSlangForPrompt(entries, { ...opts, reserve: 0 }),
      buildSlangContext: (entries, max = 8, opts = {}) => slangLib.buildSlangContext(entries, max, { ...opts, reserve: 0 }),
    },
  });
  // 变异 B：让 block 与 entries 分叉（block 固定用 max=8）
  await withBridge(async (h, server) => {
    const paths = await readThreePaths(h, server);
    assert.equal(paths.queryEntries.length, 30, '（前置）entries 仍是 30 条');
    assert.equal(blockContents(paths.promptBlock).length, 8, '（前置）变异 B 下 block 只剩 8 条');
    let threw = null;
    try { assertBlockMatchesEntries({ entries: paths.queryEntries, block: paths.promptBlock, label: '变异 B' }); } catch (error) { threw = error; }
    assert.ok(threw, '变异 B（block 用另一套 max）下「block 与 entries 集合一致」必须抛错（否则该断言不是载荷的）');
    console.log(`   [反证 B] block 分叉（30 vs 8）后集合一致断言已抛出：${String(threw.message).split('\n')[0].slice(0, 120)} ✔`);
  }, {
    seedSlang: libraryWithNewWord(),
    slangLibOverride: {
      buildSlangContext: (entries, max = 8, opts = {}) => slangLib.buildSlangContext(entries, 8, opts),
    },
  });
});

// ══ S15 边界补充：reserve 强转/小数/NaN clamp、重复 id/引用去重、无效值回落（t42 新口径） ═══════
await test('S15 边界补充：reserve 字符串/小数/NaN 的 clamp；重复 id/对象引用去重；无效值(null/空串/非数字)一律回落默认 5、显式 0 仍关掉保底', async () => {
  const lib = libraryWithNewWord();
  // 判别用的小库：count 顺序与 updatedAt 顺序**相反**，这样「保底几名」能从输出位置上看出来
  const probe = [
    { id: 'w1', content: '词1', meaning: 'm1', status: CONFIRMED, count: 5, updatedAt: iso(1) },
    { id: 'w2', content: '词2', meaning: 'm2', status: CONFIRMED, count: 4, updatedAt: iso(2) },
    { id: 'w3', content: '词3', meaning: 'm3', status: CONFIRMED, count: 3, updatedAt: iso(3) },
    { id: 'w4', content: '词4', meaning: 'm4', status: CONFIRMED, count: 2, updatedAt: iso(4) },
    { id: 'w5', content: '词5', meaning: 'm5', status: CONFIRMED, count: 1, updatedAt: iso(5) },
  ];
  assert.deepEqual(idsOf(selectSlangForPrompt(probe, { max: 3, reserve: 0 })), ['w1', 'w2', 'w3'], '（前置）reserve=0 就是旧规则：count 降序');
  assert.deepEqual(idsOf(selectSlangForPrompt(probe, { max: 3, reserve: 1 })), ['w5', 'w1', 'w2'], 'reserve=1：保底 1 条（updatedAt 最新 w5）+ 补齐');
  assert.deepEqual(idsOf(selectSlangForPrompt(probe, { max: 3, reserve: 2.4 })), ['w5', 'w4', 'w1'], 'reserve=2.4 → 2（四舍五入）');
  assert.deepEqual(idsOf(selectSlangForPrompt(probe, { max: 3, reserve: 2 })), ['w5', 'w4', 'w1'], 'reserve=2.4 必须与 2 等价');
  assert.deepEqual(idsOf(selectSlangForPrompt(probe, { max: 3, reserve: 2.6 })), ['w5', 'w4', 'w3'], 'reserve=2.6 → 3');
  assert.deepEqual(idsOf(selectSlangForPrompt(probe, { max: 3, reserve: '3' })), idsOf(selectSlangForPrompt(probe, { max: 3, reserve: 3 })), "reserve='3' 必须与 3 等价");
  assert.deepEqual(idsOf(selectSlangForPrompt(probe, { max: 3, reserve: 'abc' })), idsOf(selectSlangForPrompt(probe, { max: 3, reserve: 0 })), "reserve='abc'（NaN → 0）必须与 0 等价");
  assert.deepEqual(idsOf(selectSlangForPrompt(lib, { max: 30, reserve: 'abc' })), idsOf(selectSlangForPrompt(lib, { max: 30, reserve: 0 })), '41 库上 NaN 同样等价 0（新词落选）');
  // 重复 id / 重复对象引用：必须去重（顺序由保底/补齐规则决定，这里只钉「不重复 + 不同 id 都在」）
  const dupId = [oldWord(1, { count: 9 }), { ...oldWord(1, { count: 9 }), content: '同名不同对象' }, oldWord(2, { count: 1 })];
  const dupPicked = idsOf(selectSlangForPrompt(dupId, { max: 30, reserve: 5 }));
  assert.equal(dupPicked.length, 2, `3 条里有一个重复 id ⇒ 只能出 2 条，实测 ${JSON.stringify(dupPicked)}`);
  assert.equal(new Set(dupPicked).size, dupPicked.length, `同 id 只能出现一次，实测 ${JSON.stringify(dupPicked)}`);
  assert.ok(dupPicked.includes('old-1') && dupPicked.includes('old-2'), `两个不同 id 都必须保留，实测 ${JSON.stringify(dupPicked)}`);
  const shared = oldWord(3, { count: 5 });
  const dupRef = [shared, shared, oldWord(4, { count: 1 })];
  const refPicked = idsOf(selectSlangForPrompt(dupRef, { max: 30, reserve: 5 }));
  assert.equal(refPicked.length, 2, `同一对象引用出现两次 ⇒ 只能出 2 条，实测 ${JSON.stringify(refPicked)}`);
  assert.equal(new Set(refPicked).size, 2, '同一对象引用不得重复输出');
  // t40/F3 新口径：**无效值/空值不得静默关掉保底** —— 配置文件 null、POST null、POST ''、POST 非数字
  // 四条路都必须回落默认 5，且实际清单与「reserve=默认值」同参数选择器逐条相同；显式 0 仍是合法开关（关掉保底）。
  await withBridge(async (h, server) => {
    // ① 配置文件里 recentReserve=null ⇒ 运行时读法 = 默认 5
    const pathsFromFile = await readThreePaths(h, server);
    const before = await consoleRequest(server, { pathname: '/api/slang' });
    const loaded = before.data?.entries ?? [];
    const expectedDefault = idsOf(selectSlangForPrompt(loaded, { max: 30, reserve: SLANG_RECENT_RESERVE_DEFAULT }));
    const expectedZero = idsOf(selectSlangForPrompt(loaded, { max: 30, reserve: 0 }));
    assert.ok(contentsOf(pathsFromFile.queryEntries).includes('新词'), 'config 里 recentReserve=null 必须回落默认 5 ⇒ 新词可见');
    assert.deepEqual(idsOf(pathsFromFile.queryEntries), expectedDefault,
      '配置文件 null 时：实际清单必须等于「reserve=默认 5」同参数选择器的结果（逐条）');
    console.log(`   [实测] 配置文件 recentReserve=null → 运行时生效=默认 ${SLANG_RECENT_RESERVE_DEFAULT}（新词可见；清单==默认5选择器逐条相同）；`
      + `GET 回显的原始 config.recentReserve=${JSON.stringify(before.data?.config?.recentReserve)}（回显的是原始配置值，不影响生效值）`);
    // ② POST null / '' / 非数字 ⇒ 与配置文件 null **一致**（都回落默认 5）——t42 更新点
    for (const input of [null, '', 'abc']) {
      const post = await consoleRequest(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: input } });
      assert.equal(post.status, 200, `POST recentReserve=${JSON.stringify(input)} 必须 200，实测 ${post.status} ${post.raw}`);
      assert.equal(post.data?.config?.recentReserve, SLANG_RECENT_RESERVE_DEFAULT,
        `POST recentReserve=${JSON.stringify(input)} 必须回落默认 ${SLANG_RECENT_RESERVE_DEFAULT}（无效值不得静默关掉保底），实测 ${JSON.stringify(post.data?.config?.recentReserve)}`);
      const get = await consoleRequest(server, { pathname: '/api/slang' });
      assert.equal(get.data?.config?.recentReserve, SLANG_RECENT_RESERVE_DEFAULT,
        `POST ${JSON.stringify(input)} 之后 GET 回显必须也是 ${SLANG_RECENT_RESERVE_DEFAULT}，实测 ${JSON.stringify(get.data?.config?.recentReserve)}`);
      const paths = await readThreePaths(h, server);
      assert.ok(contentsOf(paths.queryEntries).includes('新词'), `POST ${JSON.stringify(input)}（生效 5）后新词必须仍可见`);
      assert.deepEqual(idsOf(paths.queryEntries), expectedDefault,
        `POST ${JSON.stringify(input)} 的清单必须与「默认 5」选择器逐条相同（与配置文件 null 那条路一致）`);
    }
    console.log(`   [证据] 四条路一致：配置文件 null / POST null / POST '' / POST 'abc' → 都回落默认 ${SLANG_RECENT_RESERVE_DEFAULT}`
      + '（POST 回显 + GET 回显 + 实际清单==默认5选择器 + 新词可见，四项全对）');
    // ③ 显式 0 是合法开关：仍然关掉保底（可回归旧行为）
    const zero = await consoleRequest(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: 0 } });
    assert.equal(zero.status, 200, `POST 0 必须 200，实测 ${zero.status} ${zero.raw}`);
    assert.equal(zero.data?.config?.recentReserve, 0, `显式 0 必须原样生效，实测 ${JSON.stringify(zero.data?.config?.recentReserve)}`);
    const getZero = await consoleRequest(server, { pathname: '/api/slang' });
    assert.equal(getZero.data?.config?.recentReserve, 0, 'POST 0 之后 GET 回显必须也是 0');
    const pathsZero = await readThreePaths(h, server);
    assert.ok(!contentsOf(pathsZero.queryEntries).includes('新词'), '显式 0 必须仍然关掉保底（新词落选）');
    assert.deepEqual(idsOf(pathsZero.queryEntries), expectedZero, '显式 0 的清单必须等于「reserve=0」同参数选择器（=旧行为）');
    console.log('   [证据] 显式 0 仍是合法开关：POST 回显 0 + GET 回显 0 + 清单==reserve=0 选择器 + 新词落选');
  }, { config: { slang: { recentReserve: null } }, seedSlang: libraryWithNewWord() });
  // t48：t40/F3-b 已把「纯空白串」按「未设置」归一（src/bridge.js:2215-2221 的 reserveConfigured → trim → reserveRaw）。
  // 本段从 t42 的「观测」升级为**断言**：null / undefined（键缺失）/ '' / 纯空白串（"  "、"\t"、"\t "）/ 非数字
  // ⇒ 一律回落默认 5（**保底不得被静默关掉**），且与 POST 同值的判据一致；显式 0 仍是合法关闭（对照）。
  // 三条模型可见路径逐条核对：(a) qq_get_prompt 的 slang.entries、(b) qq_slang_query 的 entries、(c) 注入提示词的 block。
  const reserveEdgeCases = [
    ['纯空白串 "  "', '  ', true],
    ['制表符 "\\t"', '\t', true],
    ['混合空白 "\\t "', '\t ', true],
    ['空串 ""', '', true],
    ['null', null, true],
    ['非数字 "abc"', 'abc', true],
    ['显式 0（合法关闭）', 0, false],
  ];
  for (const [caseName, seedValue, expectDefault] of reserveEdgeCases) {
    await withBridge(async (h, server) => {
      const listRes = await consoleRequest(server, { pathname: '/api/slang' });
      const loaded = listRes.data?.entries ?? [];
      const reserveLabel = expectDefault ? `默认 ${SLANG_RECENT_RESERVE_DEFAULT}` : '0';
      const expectedIds = idsOf(selectSlangForPrompt(loaded, { max: 30, reserve: expectDefault ? SLANG_RECENT_RESERVE_DEFAULT : 0 }));
      const paths = await readThreePaths(h, server);
      // ① 运行时读法 = 同参数选择器（等价于「运行时 reserve=默认5 / =0」）
      assert.deepEqual(idsOf(paths.queryEntries), expectedIds,
        `${caseName}：运行时清单必须等于 reserve=${reserveLabel} 的选择器（逐条）`);
      assert.equal(contentsOf(paths.queryEntries).includes('新词'), expectDefault,
        `${caseName}：新词${expectDefault ? '必须被保底保住' : '必须落选（显式 0 是合法关闭）'}，实测 ${JSON.stringify(contentsOf(paths.queryEntries).slice(0, 5))}`);
      // ② 三条模型可见路径状态一致
      for (const [label, list] of [['prompt.slang.entries', paths.promptEntries], ['slang/query.entries', paths.queryEntries]]) {
        assert.equal(contentsOf(list).includes('新词'), expectDefault, `${caseName}：${label} 的新词状态必须与运行时一致`);
      }
      assert.equal(blockContents(paths.wakeText).includes('新词'), expectDefault, `${caseName}：注入提示词 block 的新词状态必须与运行时一致`);
      assertBlockMatchesEntries({ entries: paths.queryEntries, block: paths.queryBlock, label: `${caseName}·配置层` });
      // ③ POST 同值 ⇒ 与配置层**判据一致**（回显 + 清单逐条相同 + 三处状态相同）
      const post = await consoleRequest(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: seedValue } });
      assert.equal(post.status, 200, `${caseName}：POST 必须 200，实测 ${post.status} ${post.raw}`);
      assert.equal(post.data?.config?.recentReserve, expectDefault ? SLANG_RECENT_RESERVE_DEFAULT : 0,
        `${caseName}：POST 同值必须回 ${reserveLabel}，实测 ${JSON.stringify(post.data?.config?.recentReserve)}`);
      const after = await readThreePaths(h, server);
      assert.deepEqual(idsOf(after.queryEntries), expectedIds, `${caseName}：POST 后清单必须与配置层逐条一致`);
      assert.equal(blockContents(after.wakeText).includes('新词'), expectDefault, `${caseName}：POST 后注入 block 的新词状态必须一致`);
      console.log(`   [证据·${caseName}] 配置层清单==reserve=${reserveLabel} 选择器（新词${expectDefault ? '可见' : '落选'}）`
        + ` + prompt/query/注入 block 三处状态一致 + POST 同值回 ${post.data?.config?.recentReserve} 且清单与配置层逐条一致`);
    }, { config: { slang: { recentReserve: seedValue } }, seedSlang: libraryWithNewWord() });
  }
  // undefined（配置里**没有这个键**）⇒ 同样回落默认 5（断言，不是观测）
  await withBridge(async (h, server) => {
    const listRes = await consoleRequest(server, { pathname: '/api/slang' });
    const loaded = listRes.data?.entries ?? [];
    const expectedIds = idsOf(selectSlangForPrompt(loaded, { max: 30, reserve: SLANG_RECENT_RESERVE_DEFAULT }));
    const paths = await readThreePaths(h, server);
    assert.equal(listRes.data?.config?.recentReserve, SLANG_RECENT_RESERVE_DEFAULT,
      `undefined（配置里没写 recentReserve）：内存生效值必须是默认 ${SLANG_RECENT_RESERVE_DEFAULT}，实测 ${JSON.stringify(listRes.data?.config?.recentReserve)}`);
    assert.deepEqual(idsOf(paths.queryEntries), expectedIds, 'undefined：运行时清单必须等于 reserve=默认 5 的选择器');
    assert.ok(contentsOf(paths.promptEntries).includes('新词'), 'undefined：prompt.slang.entries 必须含新词');
    assert.ok(contentsOf(paths.queryEntries).includes('新词'), 'undefined：slang/query.entries 必须含新词');
    assert.ok(blockContents(paths.wakeText).includes('新词'), 'undefined：注入 block 必须含新词');
    console.log('   [证据·undefined（配置里没有 recentReserve 键）] 生效值=默认 5 + 清单==默认5选择器 + prompt/query/注入 block 三处都含新词');
  }, { seedSlang: libraryWithNewWord() });
  // F3-b 静态锚点：读实现确认「纯空白串按未设置归一」这一层仍在（防回退）
  const f3bSource = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  assert.match(f3bSource,
    /const reserveConfigured = cfg\.slang\?\.recentReserve;[\s\S]{0,400}typeof reserveConfigured === 'string' && reserveConfigured\.trim\(\) === ''[\s\S]{0,120}\? ''\s*\n\s*: reserveConfigured;/,
    'F3-b：运行时读法必须先把「空串/纯空白串」归一到空串（否则 Number("  ")=0 会把保底静默关掉）');
  assert.match(f3bSource, /const reserveRaw = \(typeof reserveConfigured === 'string' && reserveConfigured\.trim\(\) === ''\)/,
    'F3-b 的归一必须仍在（且在被 S13 静态锚点钉住的 reserveNum 那行之前）');
  console.log('   [证据·F3-b 静态锚点] src/bridge.js 的 slangSelectionV2 里「纯空白串 → 空串」归一仍在，且位于 S13 钉住的 reserveNum 行之前（S13 锚点原文未被扰动）');
  console.log('   [说明] F3-b 之后的正确口径：null / undefined（键缺失）/ "" / 纯空白串 / 非数字 ⇒ 一律「未设置」回落默认 5，'
    + '配置路径与 POST 路径判据一致；**只有显式 0 才是「关掉保底」**。'
    + '（t42 曾把「运行时不 trim ⇒ "  " 被 Number("  ")=0 静默关掉」记为观测；该旧行为已被 t40/F3-b 修掉，'
    + '本节已改为断言，不要按旧口径改回去。）');
  // 载荷性反证（t48）：把 F3-b 的 trim 归一中和掉（只在 VM 内源码副本上）⇒ 纯空白串必须**重新**变成
  // 「保底被静默关掉」（新词不可见）—— 这正是上面那条断言能抓到回退的原因（也就是 t42 观测到的旧行为）。
  await withBridge(async (h, server) => {
    const paths = await readThreePaths(h, server);
    const listRes = await consoleRequest(server, { pathname: '/api/slang' });
    const expectedZero = idsOf(selectSlangForPrompt(listRes.data?.entries ?? [], { max: 30, reserve: 0 }));
    assert.equal(contentsOf(paths.queryEntries).includes('新词'), false,
      '变异体（去掉 trim 归一）上：配置 "  " 必须重新变成「保底被静默关掉」（新词不可见）');
    assert.deepEqual(idsOf(paths.queryEntries), expectedZero,
      '变异体上清单必须等于 reserve=0 的选择器（旧口径原样复现）');
    assert.ok(!blockContents(paths.wakeText).includes('新词'), '变异体上注入 block 也必然不含新词');
    console.log('   [反证·F3-b] 中和 trim 归一后：配置 "  " ⇒ 运行时 reserve=0、新词不可见（旧口径复现）⇒ 上面的断言一旦回退必然转红 ✔');
  }, {
    config: { slang: { recentReserve: '  ' } },
    seedSlang: libraryWithNewWord(),
    transformSource: (src) => {
      const out = src.replace(
        /const reserveRaw = \(typeof reserveConfigured === 'string' && reserveConfigured\.trim\(\) === ''\)\s*\n\s*\? ''\s*\n\s*: reserveConfigured;/,
        'const reserveRaw = reserveConfigured; /* mutant：中和 F3-b 的 trim 归一 */');
      assert.notEqual(out, src, 'F3-b 变异锚点（reserveRaw 归一）必须命中，否则本反证是空的');
      return out;
    },
  });
  console.log('   [证据] reserve 强转/小数/NaN clamp 与「重复 id/引用去重」全部按文档语义（选择器层 NaN→0；配置层非数字→默认 5，见上）');
});

console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`通过 ${passes} 项，失败 ${failures} 项`);
if (failures) process.exitCode = 1;
