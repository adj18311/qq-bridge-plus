// 黑话「保底名额」聚焦测试（t35）。
//
// 用户实测（2026-10-06 11:20）：刚在控制台确认的新词 count=0，而库里 40 条 confirmed 的 count 全 ≥1
// ⇒ 旧规则「confirmed → count 降序 → 取前 injectMax 条」让新词固定排在第 41 位 ⇒ 永远进不了那 30 条
// （用户实测「问它/刷新 prompt 都还是那八个」）。修法：给「最近确认/编辑」的条目留 reserve 个保底名额。
//
// 本测试分两层：
//   A. 纯选择器（src/slang-learner.js 的 selectSlangForPrompt）—— 规则、clamp、边界；
//   B. 真桥接 + 真 HTTP —— 新词必须同时出现在 (a) /api/socialV2/prompt 的 slang.entries、
//      (b) /api/socialV2/slang/query 的 entries、(c) 注入提示词的 block；且 (b) 与 (c) 的集合完全一致
//      （两条模型可见路径共用同一选择器）；POST /api/slang/config 能设置 recentReserve 并 clamp；
//      recentReserve=0 与旧行为逐条一致。
// 不读线上 config.json、不写真实 state/、不连 QQ/DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import * as coreBindings from './bridge-core-bindings.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as roleCard from '../src/role-card.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as retryObserver from '../src/retry-observer.js';
import * as retryDiagnostic from '../src/retry-diagnostic.js';
import * as errorNotice from '../src/error-notice.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const CONSOLE_TOKEN = 'fixture-console-token';
const {
  selectSlangForPrompt, buildSlangContext, SLANG_STATUS, SLANG_INJECT_MAX, SLANG_RECENT_RESERVE_DEFAULT,
} = slang;

let failures = 0;
async function test(name, run) {
  const t0 = Date.now();
  try {
    await run();
    console.log(`✅ ${name}（${Date.now() - t0}ms）`);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${name}（${Date.now() - t0}ms）\n   ${error?.stack ?? error?.message ?? error}`);
  }
}

// ── A. 纯选择器 ──────────────────────────────────────────────────────────────
const confirmed = (content, count, updatedAt, extra = {}) => ({
  id: `id-${content}`, content, meaning: `${content} 的意思`, usage: '', example: '',
  status: SLANG_STATUS.CONFIRMED, source: 'ai', count, updatedAt, ...extra,
});
const words = (list) => list.map((e) => e.content);
const contents = (list) => (list || []).map((e) => String(e?.content ?? ''));
/** 旧实现（t35 之前）的选择规则，用作 reserve=0 的对照基准。 */
const legacySelect = (entries, max) => (entries || [])
  .filter((e) => e && e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
  .sort((a, b) => (b.count || 0) - (a.count || 0))
  .slice(0, Math.max(1, Math.min(30, Number(max) || 8)));

const OLD_LIB = Array.from({ length: 40 }, (_, i) => confirmed(`老词${i + 1}`, i + 1, `2026-01-0${(i % 9) + 1}T00:00:00.000Z`));
const FRESH = confirmed('绝绝子鱼', 0, '2026-10-06T11:00:00.000Z');
const LIB_FRESH = [...OLD_LIB, FRESH];

await test('A1 新确认的词必然出现：40 条 count≥1 + 1 条 count=0，max=30/reserve=5 → 新词入选且排第一', () => {
  const picked = selectSlangForPrompt(LIB_FRESH, { max: 30, reserve: 5 });
  assert.equal(picked.length, 30, `总数必须 = max，实际 ${picked.length}`);
  assert.equal(picked[0].content, '绝绝子鱼', `保底名额必须排在前面：${words(picked).join(',')}`);
  assert.ok(words(picked).includes('绝绝子鱼'), '新确认的词必须出现');
  // 对照：旧规则（reserve=0）下它必然落选 —— 这正是用户遇到的问题
  assert.ok(!words(legacySelect(LIB_FRESH, 30)).includes('绝绝子鱼'), '旧规则下新词必须落选（对照）');
});

await test('A2 保底取自「人工确认/编辑时刻」最新的 reserve 条（缺该字段回退 updatedAt），并列按 content 字典序', () => {
  // 把一条老词「刚编辑」到现在：它必须进保底（否则 count=1 根本排不上）
  const edited = { ...OLD_LIB[0], updatedAt: '2026-10-06T12:00:00.000Z' };   // 老词1
  const lib = [...OLD_LIB.slice(1), edited, FRESH];
  const picked = selectSlangForPrompt(lib, { max: 30, reserve: 5 });
  // 期望顺序就是规范本身：reviewedAt(=lastReviewedAt，缺省回退 updatedAt) 降序，并列按 content 码元字典序（t40/F4）
  const revAt = (e) => {
    const r = Date.parse(String(e?.lastReviewedAt ?? ''));
    if (Number.isFinite(r)) return r;
    const u = Date.parse(String(e?.updatedAt ?? ''));
    return Number.isFinite(u) ? u : Number.NEGATIVE_INFINITY;
  };
  const tie = (a, b) => (String(a.content) < String(b.content) ? -1 : 1);
  const expectedReserve = [...lib].sort((a, b) => (revAt(b) - revAt(a)) || tie(a, b)).slice(0, 5).map((e) => e.content);
  const reserveWords = words(picked).slice(0, 5);
  assert.deepEqual(reserveWords, expectedReserve, '保底名额必须是 reviewedAt 最新 5 条（并列按 content 字典序）');
  assert.ok(reserveWords.includes('老词1'), '刚编辑的老词必须进保底');
  assert.ok(reserveWords.includes('绝绝子鱼'), '新确认的词必须进保底');
  // 其余名额按 count 降序补齐（新档同样带确定性二级键）
  const reserveSet = new Set(reserveWords);
  const expectedFill = [...lib]
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0) || tie(a, b))
    .filter((e) => !reserveSet.has(e.content))
    .slice(0, 25)
    .map((e) => e.content);
  assert.deepEqual(words(picked).slice(5), expectedFill, '补齐段必须按 count 降序（并列按 content 字典序）');
  assert.equal(new Set(words(picked)).size, picked.length, '不得有重复');
  assert.ok(picked.length <= 30, '不得超过 max');
});

await test('A3 reserve=0 完全等价旧行为（同库同 max 逐条一致）', () => {
  for (const max of [8, 30]) {
    assert.deepEqual(
      words(selectSlangForPrompt(LIB_FRESH, { max, reserve: 0 })),
      words(legacySelect(LIB_FRESH, max)),
      `max=${max} 时 reserve=0 必须与旧规则逐条一致`,
    );
    // 显式不传 reserve 也必须等价（默认 0）
    assert.deepEqual(words(selectSlangForPrompt(LIB_FRESH, { max })), words(legacySelect(LIB_FRESH, max)));
  }
  console.log(`   [证据] reserve=0 时 max=8/30 的选择结果与旧实现逐条一致（新词仍落选：${!words(selectSlangForPrompt(LIB_FRESH, { max: 30, reserve: 0 })).includes('绝绝子鱼')}）`);
});

await test('A4 clamp：max → 1..30；reserve → 0..max；非数字回落', () => {
  assert.equal(selectSlangForPrompt(OLD_LIB, { max: 99, reserve: 0 }).length, SLANG_INJECT_MAX, 'max=99 必须 clamp 到 30');
  assert.equal(selectSlangForPrompt(OLD_LIB, { max: 0, reserve: 0 }).length, 8, 'max=0 回落默认 8（与旧实现同一表达式）');
  assert.equal(selectSlangForPrompt(OLD_LIB, { max: -5, reserve: 0 }).length, 1, 'max 负数 clamp 到下限 1（与旧表达式一致）');
  assert.equal(selectSlangForPrompt(OLD_LIB, { max: 30, reserve: 99 }).length, 30, 'reserve>max 时 clamp 到 max');
  assert.equal(selectSlangForPrompt(OLD_LIB, { max: 8, reserve: 99 }).length, 8, 'reserve>max 时总数仍 ≤ max');
  assert.deepEqual(words(selectSlangForPrompt(LIB_FRESH, { max: 8, reserve: -3 })), words(legacySelect(LIB_FRESH, 8)), 'reserve 负数 → 0（旧行为）');
  assert.deepEqual(words(selectSlangForPrompt(LIB_FRESH, { max: 8, reserve: NaN })), words(legacySelect(LIB_FRESH, 8)), 'reserve 非数字 → 0（旧行为）');
  assert.equal(SLANG_INJECT_MAX, 30, '上限常量必须仍是 30');
  assert.equal(SLANG_RECENT_RESERVE_DEFAULT, 5, '保底默认值必须是 5');
});

await test('A5 边界：全给 / reserve>候选 / 缺 updatedAt / 并列 / count 全 0 / 非数组', () => {
  // confirmed 总数 ≤ max：全给、不截断
  const few = OLD_LIB.slice(0, 3);
  assert.equal(selectSlangForPrompt(few, { max: 30, reserve: 5 }).length, 3, '总数 ≤ max 时全给');
  // reserve > 候选数：退回按 count（即全给，不报错、不重复）
  const tiny = [confirmed('甲', 2, '2026-01-01T00:00:00.000Z'), confirmed('乙', 9, '2026-02-01T00:00:00.000Z')];
  assert.deepEqual(words(selectSlangForPrompt(tiny, { max: 30, reserve: 5 })), ['乙', '甲'], 'reserve 超出候选时必须退回按 count');
  // 缺 updatedAt ⇒ 最旧：永远排不到保底（除非名额没被占满）
  const legacy_none = [
    { id: 'x', content: '无时间', meaning: '没有 updatedAt', status: SLANG_STATUS.CONFIRMED, count: 5 },
    confirmed('有时间', 3, '2026-03-01T00:00:00.000Z'),
    confirmed('更新', 1, '2026-04-01T00:00:00.000Z'),
  ];
  const missingPicked = selectSlangForPrompt(legacy_none, { max: 2, reserve: 2 });
  assert.deepEqual(words(missingPicked), ['更新', '有时间'], '缺 updatedAt 必须按最旧处理');
  // updatedAt 并列：稳定、不重复
  const ties = [
    confirmed('并列甲', 5, '2026-05-01T00:00:00.000Z'),
    confirmed('并列乙', 4, '2026-05-01T00:00:00.000Z'),
    confirmed('并列丙', 3, '2026-05-01T00:00:00.000Z'),
    confirmed('并列丁', 2, '2026-05-01T00:00:00.000Z'),
  ];
  const tiePicked = selectSlangForPrompt(ties, { max: 3, reserve: 2 });
  assert.equal(tiePicked.length, 3);
  assert.equal(new Set(words(tiePicked)).size, 3, '并列时不得重复');
  assert.deepEqual(words(selectSlangForPrompt(ties, { max: 3, reserve: 2 })), words(tiePicked), '并列结果必须可复现');
  // count 全为 0
  const zero = [confirmed('零甲', 0, '2026-06-02T00:00:00.000Z'), confirmed('零乙', 0, '2026-06-01T00:00:00.000Z')];
  assert.deepEqual(words(selectSlangForPrompt(zero, { max: 30, reserve: 5 })), ['零甲', '零乙'], 'count 全 0 时按 updatedAt（保底）');
  // 非 confirmed / 缺 meaning / 空库 / 非数组
  assert.deepEqual(selectSlangForPrompt([{ ...FRESH, status: SLANG_STATUS.CANDIDATE }], { max: 30, reserve: 5 }), [], '候选词不得入选');
  assert.deepEqual(selectSlangForPrompt([{ ...FRESH, meaning: '' }], { max: 30, reserve: 5 }), [], '缺 meaning 不得入选');
  assert.deepEqual(selectSlangForPrompt([], { max: 30, reserve: 5 }), [], '空库返回空');
  assert.deepEqual(selectSlangForPrompt(null, { max: 30, reserve: 5 }), [], '非数组不报错');
  // 同一对象重复出现：去重
  const dupEntry = confirmed('重复词', 9, '2026-07-01T00:00:00.000Z');
  assert.equal(words(selectSlangForPrompt([dupEntry, dupEntry, ...OLD_LIB.slice(0, 2)], { max: 30, reserve: 5 })).filter((w) => w === '重复词').length, 1, '重复对象必须去重');
});

await test('A6 文本块（buildSlangContext）与选择器集合一致（纯函数层）', () => {
  const picked = selectSlangForPrompt(LIB_FRESH, { max: 30, reserve: 5 });
  const block = buildSlangContext(LIB_FRESH, 30, { reserve: 5 });
  const blockWords = block.split('\n').slice(1).map((line) => (line.startsWith('- ') ? line.slice(2).split('：')[0] : '')).filter(Boolean);
  assert.deepEqual(blockWords, words(picked), '块里的词必须与选择器输出逐条一致（含顺序）');
  assert.ok(block.includes('绝绝子鱼'), '新词必须出现在块里');
  // 旧签名（第三参缺省）仍是旧行为，兼容既有调用方/测试
  const legacyBlock = buildSlangContext(OLD_LIB, 8);
  assert.equal(legacyBlock.split('\n').length - 1, 8, 'buildSlangContext(entries, max) 仍是旧行为（8 条）');
});

// ── B. 真桥接 + 真 HTTP ─────────────────────────────────────────────────────
/** 在临时目录里跑真实桥接，并把 state/slang.json 预置成给定库。 */
async function slangHarness({ config = {}, library = [] } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-slang-select-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  const slangCfg = { enabled: true, injectMax: 30, recentReserve: 5, ...(config.slang ?? {}) };
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: CONSOLE_TOKEN, ...config, slang: slangCfg,
  }));
  fs.writeFileSync(path.join(temp, 'state', 'slang.json'), JSON.stringify(library, null, 2));
  const calls = { created: [], prompts: [], sent: [] };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: () => {} },
    workspace: { create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }), archiveSession: async () => success({}) },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
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
    if (acc.droppingImport) { if (/;\s*$/.test(line)) acc.droppingImport = false; return acc; }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) { if (!/;\s*$/.test(line)) acc.droppingImport = true; return acc; }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    cfg, state, api, socialV2, getSocialV2State, ensureSession, deliverPrompt,
    startConsoleServer, confirmedSlangListV2, slangBlockV2, slangSelectionV2,
    // 暴露**活**的黑话库引用：C1 要按真实抽取路径（upsertSlangEntry）给词条「再见到一次」
    getSlangEntries: () => slangEntries,
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
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...roleCard, ...presetPrompt,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...coreBindings, ...retryObserver, ...retryDiagnostic, ...errorNotice,
    defaultErrorNoticeGate: errorNotice.createErrorNoticeGate(),
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    processAudioVolume: async (file) => ({ path: String(file), converted: false, applied: false, mode: 'original', volume: 1, loudness: null }),
    cleanupTemp: () => {},
  });
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.slangHarnessReady = main();', context);
  const bridge = await context.slangHarnessReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, readLog: () => '', async close() { for (const t of timeouts) clearTimeout(t); fs.rmSync(temp, { recursive: true, force: true }); } };
}

function httpJson(server, { method = 'GET', pathname, query = '', body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const search = new URLSearchParams(query || {}).toString();
    const req = http.request({
      host: '127.0.0.1', port: server.address().port,
      path: `${pathname}?token=${encodeURIComponent(CONSOLE_TOKEN)}${search ? `&${search}` : ''}`,
      method,
      headers: {
        'content-type': 'application/json',
        'x-console-token': CONSOLE_TOKEN,
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        connection: 'close',
      },
      agent: false,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let data = null; try { data = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, data, raw }); });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request hung')));
    req.end(payload ?? undefined);
  });
}

async function withBridge(run, options) {
  const h = await slangHarness(options);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(h, server); }
  finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

const KEY = 'private:123';
const blockWords = (block) => String(block ?? '').split('\n').slice(1)
  .map((line) => (line.startsWith('- ') ? line.slice(2).split('：')[0] : '')).filter(Boolean);
/** 一次拿齐三条模型可见路径：prompt entries/block、query entries/block、真注入提示词。 */
async function threePaths(h, server) {
  const prompt = await httpJson(server, { pathname: '/api/socialV2/prompt', query: { key: KEY } });
  const query = await httpJson(server, { pathname: '/api/socialV2/slang/query', query: { key: KEY } });
  await h.deliverPrompt(KEY, '【测试】唤醒一下');
  const injected = h.calls.prompts.at(-1)?.content?.[0]?.text ?? '';
  return {
    promptEntries: prompt.data?.slang?.entries ?? [],
    promptBlock: prompt.data?.slang?.block ?? '',
    queryEntries: query.data?.entries ?? [],
    queryBlock: query.data?.block ?? '',
    injected,
  };
}

await test('B1 新词必然出现在三处（prompt.entries / slang.query.entries / 注入提示词的 block）', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    const prompt = await httpJson(server, { pathname: '/api/socialV2/prompt', query: { key: KEY } });
    assert.equal(prompt.status, 200, prompt.raw);
    const promptEntries = prompt.data.slang.entries;
    assert.ok(promptEntries.some((e) => e.content === '绝绝子鱼'), `(a) qq_get_prompt 的 slang.entries 必须含新词：${JSON.stringify(words(promptEntries))}`);
    assert.equal(promptEntries.length, 30, '清单仍是 ≤30 条');
    assert.ok(String(prompt.data.slang.block).includes('绝绝子鱼'), '(a) block 也必须含新词（同一个 payload）');
    // (b) qq_slang_query
    const query = await httpJson(server, { pathname: '/api/socialV2/slang/query', query: { key: KEY } });
    assert.equal(query.status, 200, query.raw);
    assert.ok(query.data.entries.some((e) => e.content === '绝绝子鱼'), `(b) qq_slang_query 的 entries 必须含新词：${JSON.stringify(words(query.data.entries))}`);
    // (c) 注入提示词（真实 deliverPrompt → withSlangContext → api.sessions.prompt）
    await h.deliverPrompt(KEY, '【测试】你好');
    const injected = h.calls.prompts.at(-1)?.content?.[0]?.text ?? '';
    assert.ok(injected.includes('绝绝子鱼'), '(c) 注入提示词必须含新词');
    assert.ok(injected.includes('【群聊黑话表】'), '(c) 注入提示词必须含黑话块');
    console.log(`   [证据] (a) entries=${promptEntries.length} 条且含「绝绝子鱼」(首位=${promptEntries[0].content})；`
      + `(b) query entries=${query.data.entries.length} 条且含新词；(c) 注入提示词含新词=${injected.includes('绝绝子鱼')}`);
  }, { library: LIB_FRESH });
});

await test('B2 两条路径共用同一选择器：block 的词集合与 entries 完全一致（顺序也一致）', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    const prompt = await httpJson(server, { pathname: '/api/socialV2/prompt', query: { key: KEY } });
    const query = await httpJson(server, { pathname: '/api/socialV2/slang/query', query: { key: KEY } });
    const promptWords = prompt.data.slang.entries.map((e) => e.content);
    const queryWords = query.data.entries.map((e) => e.content);
    const promptBlockWords = blockWords(prompt.data.slang.block);
    const queryBlockWords = blockWords(query.data.block);
    assert.deepEqual(queryWords, promptWords, '两个端点的 entries 必须完全一致');
    assert.deepEqual(promptBlockWords, promptWords, 'prompt.block 的词必须与 entries 逐条一致');
    assert.deepEqual(queryBlockWords, queryWords, 'query.block 的词必须与 entries 逐条一致');
    // 桥接内部两条路径也必须同源（防止未来有人只改一边）
    assert.deepEqual(h.confirmedSlangListV2().map((e) => e.content), blockWords(h.slangBlockV2()), 'confirmedSlangListV2() 与 slangBlockV2() 必须同源');
    console.log(`   [证据] entries=${promptWords.length} 条、block 词=${promptBlockWords.length} 条，四处集合逐条一致；首条=${promptWords[0]}`);
  }, { library: LIB_FRESH });
});

await test('B3 recentReserve=0 与旧行为完全一致（40 条库、max=8 → 等于按 count 取前 8，新词落选）', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    const res = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { injectMax: 8, recentReserve: 0 } });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.data.config.recentReserve, 0, 'recentReserve 必须写入并回显 0');
    assert.equal(res.data.config.injectMax, 8);
    const prompt = await httpJson(server, { pathname: '/api/socialV2/prompt', query: { key: KEY } });
    const got = prompt.data.slang.entries.map((e) => e.content);
    assert.deepEqual(got, words(legacySelect(LIB_FRESH, 8)), 'reserve=0 必须与旧规则逐条一致');
    assert.ok(!got.includes('绝绝子鱼'), 'reserve=0 时新词仍落选（这是旧行为的定义）');
    console.log(`   [证据] reserve=0/injectMax=8 → ${got.length} 条：${got.join(',')}（新词落选，与旧实现一致）`);
  }, { library: LIB_FRESH });
});

await test('B4 POST /api/slang/config 设置 recentReserve 并 clamp 到 0..min(30, injectMax)', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    let res = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: 3 } });
    assert.equal(res.data.config.recentReserve, 3, '正常值必须原样写入');
    // 选择结果随之变化：保底 3 条 = updatedAt 最新 3 条
    const picked3 = h.confirmedSlangListV2().map((e) => e.content);
    assert.equal(picked3.length, 30);
    const sel3 = h.slangSelectionV2();
    assert.equal(sel3.max, 30, '运行时 max 必须 = 30');
    assert.equal(sel3.reserve, 3, '运行时读到的 reserve 必须跟着配置走');
    res = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { injectMax: 8, recentReserve: 999 } });
    assert.equal(res.data.config.injectMax, 8, 'injectMax 仍照旧 clamp 到 ≤30');
    assert.equal(res.data.config.recentReserve, 8, 'reserve 必须 clamp 到 min(30, injectMax)=8');
    res = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: -5 } });
    assert.equal(res.data.config.recentReserve, 0, '负数必须 clamp 到 0');
    res = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: 'abc' } });
    assert.equal(res.data.config.recentReserve, SLANG_RECENT_RESERVE_DEFAULT, '非数字回落默认 5');
    res = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { injectMax: 99, recentReserve: 40 } });
    assert.equal(res.data.config.injectMax, 30, 'injectMax=99 必须 clamp 到 30');
    assert.equal(res.data.config.recentReserve, 30, 'reserve 随后 clamp 到 min(30, 30)=30');
    // 读取路径（控制台 GET）也要回显
    const got = await httpJson(server, { pathname: '/api/slang' });
    assert.equal(got.data.config.recentReserve, 30, 'GET /api/slang 必须回显 recentReserve');
    // max 配置成 >30 时运行时选择仍 ≤30
    assert.ok(h.confirmedSlangListV2().length <= 30, '运行时选择必须仍 ≤30');
    console.log(`   [证据] POST 3→3；injectMax=8+reserve=999→8；-5→0；'abc'→5；injectMax=99+reserve=40→30/30；运行时选择=${h.confirmedSlangListV2().length} 条`);
  }, { library: LIB_FRESH });
});

await test('B5 配置缺省 recentReserve 时按默认 5（不写 config 也生效）', async () => {
  const h = await slangHarness({ library: LIB_FRESH });      // config 里显式带 recentReserve:5（默认值同源）
  try {
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    let sel = h.slangSelectionV2();
    assert.equal(sel.max, 30);
    assert.equal(sel.reserve, 5, '默认 5 条保底');
    // 抹掉配置键 → 仍按默认 5（不是 0！否则新词又落选）
    delete h.cfg.slang.recentReserve;
    sel = h.slangSelectionV2();
    assert.equal(sel.reserve, SLANG_RECENT_RESERVE_DEFAULT, '缺省必须回落默认 5');
    assert.ok(h.confirmedSlangListV2().some((e) => e.content === '绝绝子鱼'), '缺省时新词仍必须可见');
  } finally { await h.close(); }
});

// ── C. t40 修复轮：F1（保底只认人工时刻）/ F3（POST 口径与运行时一致）/ F4（并列确定性）─────
/** 用户实测那个库 + 一条待确认的候选（C1/C2 用）。 */
const CANDS = () => ([
  ...OLD_LIB,
  {
    id: 'cand-1', content: '候选新词', meaning: '管理员刚确认的新词', usage: '', example: '',
    status: 'candidate', source: 'ai', count: 0,
    createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-01-10T00:00:00.000Z',
  },
]);

await test('C1（F1 复现用例）：确认 count=0 的新词后，5 个其它 confirmed 词各被「再见到」一次 → 新词仍在三处', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    const store = h.getSlangEntries();
    // ① 加载期一次性迁移：老条目 lastReviewedAt := 当时的 updatedAt（保序迁移，顺序不变）
    // 这条严格相等**是安全的**：迁移就是 `entry.lastReviewedAt = entry.updatedAt` 的**同一字符串复制**，
    // 不是两次 `new Date()`（对比下面 ② 那对由端点分两次读时钟写出的字段）。
    const migrated = store.find((e) => e.content === '老词9');
    assert.equal(migrated.lastReviewedAt, migrated.updatedAt, '加载期迁移必须把 updatedAt 复制成 lastReviewedAt');
    // ② 人工确认新词 X（走真实端点）
    const confirm = await httpJson(server, { method: 'POST', pathname: '/api/slang/cand-1/confirm', body: {} });
    assert.equal(confirm.status, 200, confirm.raw);
    assert.equal(confirm.data.entry.status, 'confirmed');
    assert.ok(String(confirm.data.entry.lastReviewedAt).length > 0, '人工确认必须写 lastReviewedAt');
    // ⚠️ 不能要求 `lastReviewedAt === updatedAt` 严格相等：这两个字段由端点**分两次** `new Date()` 写出
    // （bridge.js 的 confirm 分支先写 updatedAt，再由 markSlangReviewedV2 写 lastReviewedAt），
    // 只有恰好落在同一毫秒才相等 —— 实测约 1%/次会不等，曾把 `npm run test:audit` 打红（35/36）。
    // 这里只要求：两个字段都非空且可解析、且时间差 ≤1000ms（足以证明「同一次人工确认写的两个时间戳」）。
    const reviewedMs = Date.parse(String(confirm.data.entry.lastReviewedAt));
    const updatedMs = Date.parse(String(confirm.data.entry.updatedAt));
    assert.ok(Number.isFinite(reviewedMs) && Number.isFinite(updatedMs), '两个时间戳都必须是可解析的 ISO 串');
    assert.ok(Math.abs(updatedMs - reviewedMs) <= 1000,
      `同一次人工确认写的两个时间戳最多只差毫秒级，实测 updatedAt=${confirm.data.entry.updatedAt} lastReviewedAt=${confirm.data.entry.lastReviewedAt}`);
    console.log(`   [证据] 确认端点两个时间戳：updatedAt=${confirm.data.entry.updatedAt} lastReviewedAt=${confirm.data.entry.lastReviewedAt}`
      + `（差 ${updatedMs - reviewedMs}ms；只断言 ≤1000ms —— 严格相等会因为端点的两次 new Date() 偶发不等）`);
    // ③ 5 个其它 confirmed 词各被「再见到」一次 —— 走与抽取路径同一个函数（upsertSlangEntry）
    const reseen = ['老词9', '老词18', '老词27', '老词36', '老词40'];
    for (const content of reseen) {
      const before = store.find((e) => e.content === content);
      const r = slang.upsertSlangEntry(store, content, { countIncrement: 1, evidence: [] });
      assert.equal(r.created, false, `${content} 必须命中已有条目`);
      assert.ok(r.entry.updatedAt > before.updatedAt, '自动抽取照旧刷新 updatedAt（语义不变）');
      assert.equal(r.entry.lastReviewedAt, before.lastReviewedAt, '自动抽取绝不能动 lastReviewedAt（F1 的关键）');
    }
    // ④ 三处都必须还有 X
    let paths = await threePaths(h, server);
    const inAll = (p) => [contents(p.promptEntries), contents(p.queryEntries), blockWords(p.promptBlock), blockWords(p.queryBlock)]
      .every((list) => list.includes('候选新词')) && p.injected.includes('候选新词');
    assert.ok(inAll(paths), `5 次自动抽取后 X 必须仍在三处；query=${JSON.stringify(contents(paths.queryEntries).slice(0, 8))}…`);
    console.log(`   [证据] 确认后 5 次自动抽取（updatedAt 已刷新、lastReviewedAt 未动）→ X 仍在 prompt/query/block/注入提示词；`
      + `query entries=${contents(paths.queryEntries).length} 条，首位=${contents(paths.queryEntries)[0]}`);
    // ⑤ 再来 5 次（累计 N=10 = 2×reserve）→ X 仍可见
    for (const content of ['老词8', '老词17', '老词26', '老词35', '老词39']) {
      slang.upsertSlangEntry(store, content, { countIncrement: 1, evidence: [] });
    }
    paths = await threePaths(h, server);
    assert.ok(inAll(paths), '累计 10 次（≥2×reserve）自动抽取后 X 仍必须可见');
    console.log('   [证据] 累计 10 次（≥2×reserve）自动抽取后 X 仍在三处 ✔');
    // ⑥ 负控：把「更近的人工确认/编辑」给到 5 个老词 ⇒ X 被合法挤出保底区（保底＝按人工时刻轮换的定义）
    // 时刻必须**严格晚于** X 的确认时刻：不能用 `new Date()` —— 若恰好与 X 同一毫秒，保底区就要靠
    // content 码元字典序决胜，'候' < '老' ⇒ X 会赢下并列、仍留在清单里，断言偶发失败（同类脆弱点）。
    const laterStamp = new Date(Date.parse(String(confirm.data.entry.lastReviewedAt)) + 1000).toISOString();
    for (const content of reseen) {
      store.find((e) => e.content === content).lastReviewedAt = laterStamp;
    }
    paths = await threePaths(h, server);
    assert.ok(!contents(paths.queryEntries).includes('候选新词'),
      '5 条更近的人工编辑应当合法地把 X 挤出保底区（这正是「保底按人工时刻」的定义）');
    console.log('   [证据] 负控：5 条更近的人工编辑 → X 被合法挤出（保底按人工时刻轮换，不是永久置顶）');
  }, { library: CANDS() });
});

await test('C2（人工动作仍有效）：PATCH 编辑老词 / POST 确认候选 ⇒ 都进保底区', async () => {
  // 真实 id 是 createId() 生成的 ASCII 串；这里给老词换成 ASCII id（PATCH 走 URL 路径，CJK id 会被
  // Node http 客户端拒绝——那是夹具问题，不是被测行为）
  const asciiLib = OLD_LIB.map((e, i) => ({ ...e, id: `w${i + 1}` }));
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    // ① PATCH 编辑一条 count=1 的老词（否则它按 count 绝对进不了 30 条）→ 必须靠保底进来
    const patch = await httpJson(server, { method: 'PATCH', pathname: '/api/slang/w1', body: { meaning: '人工改过的含义' } });
    assert.equal(patch.status, 200, patch.raw);
    assert.ok(String(patch.data?.entry?.lastReviewedAt ?? '').length > 0, 'PATCH 必须写 lastReviewedAt');
    let paths = await threePaths(h, server);
    assert.ok(contents(paths.queryEntries).includes('老词1'), '人工编辑过的老词必须进清单（靠保底）');
    assert.equal(contents(paths.queryEntries)[0], '老词1', '人工编辑是最新的人工时刻 ⇒ 排在保底区首位');
    assert.ok(paths.injected.includes('老词1'), '注入提示词也必须含它');
    // ② POST 确认候选 → 进保底（并成为最新的人工时刻）
    const confirm = await httpJson(server, { method: 'POST', pathname: '/api/slang/cand-1/confirm', body: {} });
    assert.equal(confirm.status, 200, confirm.raw);
    paths = await threePaths(h, server);
    assert.ok(contents(paths.queryEntries).includes('候选新词'), '人工确认的候选必须进清单');
    assert.ok(contents(paths.queryEntries).includes('老词1'), '先前编辑过的老词仍应在保底区（reserve=5）');
    // ③ reserve=0 的回归在 B3（端到端 = 旧 oracle 逐条）
    console.log(`   [证据] PATCH 老词1 → 保底首位；POST 确认 cand-1 → 两条都在清单；entries=${contents(paths.queryEntries).length} 条`);
  }, { library: [...asciiLib, CANDS()[OLD_LIB.length]] });
});

await test('C3（F3）：POST recentReserve=null/""/非数字 一律回落默认 5，且与运行时读法一致；显式 0 仍关掉保底', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    // 前置：config 里 recentReserve=null（另一条读法）⇒ 运行时也必须是 5
    assert.equal(h.slangSelectionV2().reserve, SLANG_RECENT_RESERVE_DEFAULT, 'config 里 null ⇒ 运行时回落默认 5');
    for (const raw of [null, '', 'abc']) {
      const res = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: raw } });
      assert.equal(res.status, 200, `POST recentReserve=${JSON.stringify(raw)} 必须 200：${res.raw}`);
      assert.equal(res.data.config.recentReserve, SLANG_RECENT_RESERVE_DEFAULT,
        `POST recentReserve=${JSON.stringify(raw)} 必须回落默认 ${SLANG_RECENT_RESERVE_DEFAULT}（不是被夹成 0）`);
      assert.equal(h.slangSelectionV2().reserve, SLANG_RECENT_RESERVE_DEFAULT,
        `POST 之后运行时读法也必须一致（同为默认 ${SLANG_RECENT_RESERVE_DEFAULT}）`);
    }
    // 对照：显式 0 仍表示「关掉保底」（旧行为档），且必须真的关掉（新词落选）
    const off = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: 0 } });
    assert.equal(off.data.config.recentReserve, 0, '显式 0 必须原样保留（=关掉保底）');
    assert.equal(h.slangSelectionV2().reserve, 0, '运行时也必须读到 0');
    const paths = await threePaths(h, server);
    assert.ok(!contents(paths.queryEntries).includes('绝绝子鱼'), '显式 0（关掉保底）后新词必须落选');
    console.log('   [证据] config null → 运行时 5；POST null/""/"abc" → 5 且运行时同步为 5；显式 0 → 0 且新词落选（对照）');
  }, { library: LIB_FRESH, config: { slang: { recentReserve: null } } });
});

await test('C4（F4）：同一时刻并列时成员资格与顺序都确定 —— 10 条同 lastReviewedAt/count，正序 vs 逆序结果完全相同', () => {
  const same = '2026-08-08T08:08:08.000Z';
  const tieLib = Array.from({ length: 10 }, (_, i) => ({
    ...confirmed(`并列词${i + 1}`, 2, same), id: `tie-${i + 1}`, lastReviewedAt: same,
  }));
  for (const [max, reserve] of [[10, 5], [6, 5]]) {
    const fwd = words(selectSlangForPrompt(tieLib, { max, reserve }));
    const rev = words(selectSlangForPrompt([...tieLib].reverse(), { max, reserve }));
    assert.deepEqual(rev, fwd, `max=${max}/reserve=${reserve}：正序与逆序必须给出**完全相同**的结果`);
    assert.equal(new Set(fwd).size, fwd.length, '不得重复');
    assert.equal(fwd.length, max, `必须选满 max=${max}`);
  }
  // 兼容档（reserve=0）保持旧语义：count 并列 ⇒ 输入顺序（这是 zero-regression 的一部分，不许“确定化”掉）
  assert.deepEqual(
    words(selectSlangForPrompt(tieLib, { max: 4, reserve: 0 })),
    ['并列词1', '并列词2', '并列词3', '并列词4'],
    'reserve=0 档：count 并列时仍是输入顺序（旧行为）',
  );
  console.log(`   [证据] 10 条同 lastReviewedAt/count：max=10/reserve=5 → ${JSON.stringify(words(selectSlangForPrompt(tieLib, { max: 10, reserve: 5 })).slice(0, 3))}…；`
    + '正序/逆序 deepEqual 全等；reserve=0 档仍按输入顺序');
});

await test('C5（F3-b）：纯空白串一律按「未设置」⇒ 运行时回落默认 5 且新词可见，与同值 POST 一致', async () => {
  await withBridge(async (h, server) => {
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    // ① 配置文件里写纯空白串：`Number('  ')=0` 会把保底静默关掉 ⇒ 必须按「未设置」回落默认 5
    assert.equal(h.slangSelectionV2().reserve, SLANG_RECENT_RESERVE_DEFAULT,
      "配置文件 recentReserve='  ' ⇒ 运行时必须回落默认 5（不是被 Number('  ')=0 静默关掉）");
    let paths = await threePaths(h, server);
    assert.ok(contents(paths.queryEntries).includes('绝绝子鱼'), "配置文件 '  ' 时新词必须可见（保底没被静默关掉）");
    assert.ok(paths.injected.includes('绝绝子鱼'), '注入提示词里也必须可见');
    // 其它空白组合一视同仁（trim 覆盖 tab / 空格混排）
    for (const raw of ['\t', '\t ', '   ']) {
      h.cfg.slang.recentReserve = raw;
      assert.equal(h.slangSelectionV2().reserve, SLANG_RECENT_RESERVE_DEFAULT,
        `配置文件 recentReserve=${JSON.stringify(raw)} ⇒ 同样回落默认 5`);
    }
    h.cfg.slang.recentReserve = '  ';
    // ② 同值走 POST：两条路结果必须一致（都 5），且清单里新词仍在
    for (const raw of ['  ', '\t', '']) {
      const res = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: raw } });
      assert.equal(res.status, 200, `POST recentReserve=${JSON.stringify(raw)} 必须 200：${res.raw}`);
      assert.equal(res.data.config.recentReserve, SLANG_RECENT_RESERVE_DEFAULT,
        `POST recentReserve=${JSON.stringify(raw)} 必须回落默认 ${SLANG_RECENT_RESERVE_DEFAULT}`);
      assert.equal(h.slangSelectionV2().reserve, SLANG_RECENT_RESERVE_DEFAULT,
        `POST recentReserve=${JSON.stringify(raw)} 之后运行时读法必须一致（同为默认 5）`);
    }
    paths = await threePaths(h, server);
    assert.ok(contents(paths.queryEntries).includes('绝绝子鱼'), 'POST 空白串之后新词仍必须可见');
    // ③ 对照：显式 0 仍是合法开关（关掉保底）
    const off = await httpJson(server, { method: 'POST', pathname: '/api/slang/config', body: { recentReserve: 0 } });
    assert.equal(off.data.config.recentReserve, 0, '显式 0 必须原样生效');
    assert.equal(h.slangSelectionV2().reserve, 0, '运行时也必须读到 0');
    console.log("   [证据] config '  '→运行时 5 且新词可见；'\\t'/'\\t '/'   ' 同；POST '  '/'\\t'/'' → 5 且运行时同步；显式 0 → 0（对照）");
  }, { library: LIB_FRESH, config: { slang: { recentReserve: '  ' } } });
});

if (failures) {
  console.error(`\n❌ 黑话保底名额测试失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n🎉 黑话保底名额（t35/t40）聚焦测试全部通过');
