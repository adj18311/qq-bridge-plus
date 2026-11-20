// scripts/test-background-patrol-audit-readers.mjs
// 读取方契约测试（表驱动 / 常量驱动）：审计写入 → readDay → 管理端 GET /audit → console.html 5 列表格。
//
// 为什么要有这个文件
// ------------------
// 审计模块的枚举与字段会随需求增长（result 的 skipped/pending、report.contentSource 的 'none'、
// report.destination 的 null、tooLongChars 数值键……）。这些值一旦在**读取侧**被误丢、被折叠成
// 默认值、或被前端渲染丢掉一列，写入侧的单测全绿也发现不了。本文件把「读取侧四层」钉成仓库测试，
// 而不是一次性探针。
//
// 保护范围（必须如实声明，不得夸大）
// --------------------------------
// src/core/background-patrol-audit.mjs 的 readDay() 目前在 src/ 下**零调用方**（只有模块内定义）。
// 本文件保护的是**当前已知消费端**：
//   ① 审计模块 readDay() 的读回契约（JSON 解析容错、不重新校验历史字段、不补字段）；
//   ② 管理端路由 GET /api/console/xiaoheihe-column/audit 的回传契约（字段面固定、未知枚举不折叠）；
//   ③ public/console.html 的 5 列表格渲染（列集合、原样显示、缺失值 '—'、最近在前、不聚合）。
// 它**不**保护任何将来新增的消费端；新增消费端必须自己补契约用例。
//
// 四层链路
// --------
//   L1 真实写入：createBackgroundPatrolAudit({ filePath: 临时目录 }) + record()（真实模块、真实落盘）
//   L2 readDay 读回：readDay(dayKey) ⇒ 原始行对象（按文件顺序）
//   L3 管理端路由：GET /audit ⇒ entries（真实 console server + 真实专栏会话 Cookie）
//   L4 前端渲染：public/console.html 主 script 在 VM 里跑，喂**真实 L3 响应体**，断言 5 列表格
//
// 常量驱动
// --------
// 枚举用例由 AUDIT_PLATFORMS / AUDIT_ACTIONS / AUDIT_RESULTS / AUDIT_REPORT_FIELDS **生成**，
// 枚举再扩展时用例自动增加（不需要改本文件）。因此断言一律写成「读回值 === 写入值」，
// 而不是「读回值 ∈ 硬编码列表」——后者会让新值悄悄通过或悄悄失败。
//
// 全部离线：临时目录、假 console 配置、不访问平台/QQ、不重启桥接、不写仓库状态文件。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_ACTIONS,
  AUDIT_FILE_PREFIX,
  AUDIT_FILE_SUFFIX,
  AUDIT_PLATFORMS,
  AUDIT_REPORT_FIELDS,
  AUDIT_RESULTS,
  BACKGROUND_PATROL_AUDIT_VERSION,
  createBackgroundPatrolAudit,
} from '../src/core/background-patrol-audit.mjs';
import { beijingPatrolDayKey } from '../src/core/background-patrol-state.mjs';

import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CONSOLE_TOKEN = 'audit-readers-http-token-0123456789abcdef';
const COLUMN_PASSWORD = 'audit-readers-password-123';
const COLUMN_PATH = '/api/console/xiaoheihe-column';
const AUDIT_PATH = `${COLUMN_PATH}/audit`;
/** console.html 里写死的请求上限（refreshColumnAudit 发的是 `?limit=50`）。 */
const ROUTE_LIMIT = 50;
/**
 * L3 当前回传面：7 个字段，逐字来自 GET /audit 的映射表达式。
 * 注意这是「当前已知消费端字段面」，不是「审计行的全部字段」：
 * 审计行还有 v/day/quota/report/tooLongChars，但路由不回传、前端 5 列表格也不渲染它们。
 * 本常量存在的意义是**当回传面被扩大或缩小时立刻失败**，强制同步更新前端与契约说明。
 */
const ROUTE_FIELD_NAMES = Object.freeze(['at', 'platform', 'action', 'result', 'reason', 'opId', 'operator']);
/** 明确「不在当前回传面」的审计行字段（含 v/day 这类落盘元数据）。 */
const NOT_ON_ROUTE_SURFACE = Object.freeze(['v', 'day', 'quota', 'report', 'tooLongChars']);
/** console.html 表头逐字（refreshColumnAudit 里的数组字面量）。 */
const CONSOLE_COLUMNS = Object.freeze(['时间', '平台', '动作', '结果', '原因']);

const hasOwn = (target, key) => Object.prototype.hasOwnProperty.call(target, key);

/** reason 只允许 `^[a-z][a-z0-9-]{0,63}$`：用「种类 + 序号」生成，避免枚举值里的字符破坏正则。 */
const reasonTag = (kind, index) => `reader-${kind}-${index}`;

// ── 北京时间日界守卫（避免跨零点把「写入日」与「读取日」拆到两个文件）────────────
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function msUntilBeijingMidnight(nowMs = Date.now()) {
  const shifted = nowMs + BEIJING_OFFSET_MS;
  return DAY_MS - (shifted % DAY_MS);
}

async function waitForStableDay() {
  const remaining = msUntilBeijingMidnight();
  if (remaining <= 6000) await new Promise((resolve) => setTimeout(resolve, remaining + 1000));
}

// ── HTTP 客户端（原生 http；非 GET 必须带 content-type + content-length，否则 415）──
const cookieFrom = (res) => {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const hit = list.find((line) => String(line).startsWith('xb_column_session='));
  if (!hit) return null;
  return String(hit).split(';')[0].trim();
};

function httpRequest(port, {
  method = 'GET', pathname, body, cookie, token = CONSOLE_TOKEN, columnRequest = '1',
} = {}) {
  const payload = method === 'GET'
    ? null
    : Buffer.from(JSON.stringify(body === undefined ? {} : body), 'utf8');
  const headers = {
    ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
    ...(token === null ? {} : { 'x-console-token': token }),
    ...(columnRequest === null ? {} : { 'x-column-request': columnRequest }),
    ...(cookie ? { cookie } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 交给调用方看 text */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// L1 / L2：真实写入（createBackgroundPatrolAudit + 临时目录）→ readDay 读回
// ══════════════════════════════════════════════════════════════════════════════
describe('L1/L2 真实写入 → readDay：枚举与字段不被误丢', () => {
  let directory = null;
  let instance = null;
  // 时钟注入让 day 键确定（不受宿主时区/跨零点影响），同时仍是**真实**落盘。
  let now = 0;

  before(async () => {
    now = Date.now();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-audit-readers-'));
    instance = createBackgroundPatrolAudit({ filePath: directory, clock: () => now });
    await instance.load();
  });

  after(async () => {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  const dayKey = () => beijingPatrolDayKey(now);
  const dayFile = () => path.join(directory, `${AUDIT_FILE_PREFIX}${dayKey()}${AUDIT_FILE_SUFFIX}`);

  /** 写一行然后读回「刚写的那一行」（append 顺序 = readDay 的 records 顺序）。 */
  async function writeAndRead(payload) {
    const written = await instance.record(payload);
    assert.equal(written.ok, true, `真实写入必须成功：${JSON.stringify(written.error ?? null)}`);
    const day = await instance.readDay(dayKey());
    assert.equal(day.ok, true, `readDay 必须成功：${JSON.stringify(day.error ?? null)}`);
    assert.equal(day.day, dayKey());
    assert.equal(day.filePath, dayFile());
    const record = day.records[day.records.length - 1];
    assert.ok(record && typeof record === 'object', 'readDay 至少应返回刚写入的那一行');
    return { written, day, record };
  }

  // ── 枚举：result / action / platform 全量（常量驱动，新值自动覆盖）──────────
  for (const [index, result] of AUDIT_RESULTS.entries()) {
    it(`[L1/L2] result=${result} 写入后 readDay 原样读回，不被折叠成别的值`, async () => {
      const platform = AUDIT_PLATFORMS[index % AUDIT_PLATFORMS.length];
      const action = AUDIT_ACTIONS[index % AUDIT_ACTIONS.length];
      const reason = reasonTag('result', index);
      const { record } = await writeAndRead({ platform, action, result, reason });
      assert.equal(record.result, result, `readDay 读回的 result 必须严格等于写入值（${result}）`);
      assert.equal(record.action, action);
      assert.equal(record.platform, platform);
      assert.equal(record.reason, reason);
      assert.equal(record.v, BACKGROUND_PATROL_AUDIT_VERSION, '版本字段必须随行落盘');
      assert.equal(record.day, dayKey(), 'day 必须是北京时间日键');
    });
  }

  for (const [index, action] of AUDIT_ACTIONS.entries()) {
    it(`[L1/L2] action=${action} 写入后 readDay 原样读回`, async () => {
      const platform = AUDIT_PLATFORMS[(index + 1) % AUDIT_PLATFORMS.length];
      const result = AUDIT_RESULTS[index % AUDIT_RESULTS.length];
      const { record } = await writeAndRead({
        platform, action, result, reason: reasonTag('action', index),
      });
      assert.equal(record.action, action, `readDay 读回的 action 必须严格等于写入值（${action}）`);
      assert.equal(record.result, result);
    });
  }

  for (const [index, platform] of AUDIT_PLATFORMS.entries()) {
    it(`[L1/L2] platform=${platform} 写入后 readDay 原样读回`, async () => {
      const { record } = await writeAndRead({
        platform,
        action: 'read',
        result: AUDIT_RESULTS[index % AUDIT_RESULTS.length],
        reason: reasonTag('platform', index),
      });
      assert.equal(record.platform, platform, `readDay 读回的 platform 必须严格等于写入值（${platform}）`);
    });
  }

  // ── report：4 个字段全量 + 两个新增取值（contentSource 'none' / destination null）──
  for (const field of AUDIT_REPORT_FIELDS) {
    it(`[L1/L2] report.${field} 必须随行落盘且读回是同名键`, async () => {
      const { record } = await writeAndRead({
        platform: 'xiaoheihe',
        action: 'report',
        result: 'success',
        reason: `reader-report-field-${AUDIT_REPORT_FIELDS.indexOf(field)}`,
        report: {
          contentSource: 'none',
          classification: 'non-sensitive',
          destination: null,
          reportBlockPresent: false,
        },
      });
      assert.ok(record.report && typeof record.report === 'object', 'report 必须落盘为对象');
      assert.equal(hasOwn(record.report, field), true, `report 缺少字段 ${field}`);
    });
  }

  it('[L1/L2] report.contentSource = "none" 读回仍是 "none"（不被当成缺失而补默认值）', async () => {
    const { record } = await writeAndRead({
      platform: 'xiaoheihe',
      action: 'report',
      result: 'success',
      reason: 'reader-report-content-source-none',
      report: {
        contentSource: 'none', classification: 'non-sensitive', destination: null, reportBlockPresent: false,
      },
    });
    assert.equal(record.report.contentSource, 'none');
  });

  it('[L1/L2] report.destination = null 读回仍是 null（不被删字段、不变成 "owner"）', async () => {
    const { record } = await writeAndRead({
      platform: 'xiaoheihe',
      action: 'report',
      result: 'skipped',
      reason: 'reader-report-destination-null',
      report: {
        contentSource: 'none', classification: 'non-sensitive', destination: null, reportBlockPresent: false,
      },
    });
    assert.equal(hasOwn(record.report, 'destination'), true, 'destination 键必须存在（null 也要保留）');
    assert.equal(record.report.destination, null);
  });

  it('[L1/L2] report.reportBlockPresent = false 读回仍是布尔 false（不被丢掉）', async () => {
    const { record } = await writeAndRead({
      platform: 'xiaoheihe',
      action: 'report',
      result: 'pending',
      reason: 'reader-report-block-absent',
      report: {
        contentSource: 'template', classification: 'sensitive', destination: 'owner', reportBlockPresent: false,
      },
    });
    assert.equal(record.report.reportBlockPresent, false);
    assert.equal(typeof record.report.reportBlockPresent, 'boolean');
  });

  // ── tooLongChars：数值键，0 与边界都不能被当成「空值」丢掉 ──────────────────
  for (const value of [0, 1, 1234, 1000000000]) {
    it(`[L1/L2] tooLongChars=${value} 读回仍是同一个数字（0 也不能被当空值丢掉）`, async () => {
      const { record } = await writeAndRead({
        platform: 'xiaoheihe',
        action: 'report',
        result: 'failure',
        reason: `reader-toolong-${value}`,
        tooLongChars: value,
      });
      assert.equal(hasOwn(record, 'tooLongChars'), true, `tooLongChars=${value} 必须落盘`);
      assert.equal(record.tooLongChars, value);
      assert.equal(typeof record.tooLongChars, 'number', 'tooLongChars 必须是数字，不能变成字符串');
      assert.equal(Number.isSafeInteger(record.tooLongChars), true);
    });
  }

  it('[L1/L2] 不带 tooLongChars 的行不得凭空多出该键（不补字段）', async () => {
    const { record } = await writeAndRead({
      platform: 'tieba', action: 'read', result: 'allowed', reason: 'reader-toolong-absent',
    });
    assert.equal(hasOwn(record, 'tooLongChars'), false, '未传 tooLongChars 时行内不应出现该键');
    assert.equal(hasOwn(record, 'report'), false, '未传 report 时行内不应出现该键');
    assert.equal(hasOwn(record, 'operator'), false, '未传 operator 时行内不应出现该键');
  });

  // ── readDay 的容错契约：不重新校验历史字段 ────────────────────────────────
  it('[L2] readDay 不重新校验历史字段：未来枚举值原样返回（readDay 是 schema 无关的）', async () => {
    const futureLine = JSON.stringify({
      v: BACKGROUND_PATROL_AUDIT_VERSION,
      day: dayKey(),
      at: now,
      platform: 'tieba',
      action: 'read',
      result: 'a-future-result-not-in-enums',
      reason: 'reader-future-enum',
      quota: null,
      opId: null,
      futureOnlyField: 'kept-verbatim',
    });
    await fs.appendFile(dayFile(), `${futureLine}\n`, 'utf8');
    const day = await instance.readDay(dayKey());
    assert.equal(day.ok, true);
    assert.equal(day.badLines, 0, '合法 JSON 不应计入坏行');
    const record = day.records[day.records.length - 1];
    assert.equal(record.result, 'a-future-result-not-in-enums', '未知枚举值必须原样返回，不得被过滤或改写');
    assert.equal(record.futureOnlyField, 'kept-verbatim', 'readDay 不得裁剪未知字段');
  });

  // 用独立临时目录做精确计数：共享目录里已有大量行，追加后的空行数取决于既有尾部换行，
  // 断言绝对值会把「文件末尾换行」这种实现细节写成契约。这里只钉「坏行/空行只计数、不吞好行」。
  it('[L2] readDay 跳过坏行与空行但仍返回好行（badLines / blankLines 只计数）', async () => {
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-audit-readers-lines-'));
    try {
      const audit = createBackgroundPatrolAudit({ filePath: isolated, clock: () => now });
      await audit.load();
      const good = { platform: 'tieba', action: 'read', result: 'allowed', reason: 'reader-line-good' };
      assert.equal((await audit.record(good)).ok, true);
      const file = path.join(isolated, `${AUDIT_FILE_PREFIX}${dayKey()}${AUDIT_FILE_SUFFIX}`);
      // 精确构造：好行 + 一行坏 JSON + 一行纯空白，全部以单个换行分隔且不留尾部空行。
      await fs.writeFile(
        file,
        `${JSON.stringify({ v: BACKGROUND_PATROL_AUDIT_VERSION, day: dayKey(), at: now, ...good, quota: null, opId: null })}\n`
        + '{not-json\n'
        + '   \n',
        'utf8',
      );
      const day = await audit.readDay(dayKey());
      assert.equal(day.ok, true);
      assert.equal(day.badLines, 1, '坏 JSON 必须计入 badLines');
      assert.ok(day.blankLines >= 1, '纯空白行必须计入 blankLines');
      assert.equal(day.records.length, 1, '坏行/空行不得影响好行');
      assert.equal(day.records[0].reason, 'reader-line-good');
    } finally {
      await fs.rm(isolated, { recursive: true, force: true });
    }
  });

  it('[L1] 未知枚举值在写入侧被拒绝（AUDIT_INVALID_ENUM），不会污染读取面', async () => {
    const before = (await instance.readDay(dayKey())).records.length;
    const rejected = await instance.record({
      platform: 'tieba', action: 'read', result: 'not-a-known-result', reason: 'reader-reject',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'AUDIT_INVALID_ENUM');
    const afterDay = await instance.readDay(dayKey());
    assert.equal(afterDay.records.length, before, '被拒绝的记录不得落盘');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L3 管理端路由：GET /audit 的字段透传（真实 console server + 真实专栏会话）
// ══════════════════════════════════════════════════════════════════════════════
describe('L3 管理端路由 GET /audit：字段面与枚举不被改写', () => {
  let harness = null;
  let server = null;
  let port = 0;
  let cookie = null;
  let writer = null;
  /** 写入顺序（旧 → 新）的期望行。 */
  let rows = [];
  /** 全部写入行的路由回传（limit=200，足够覆盖枚举扩展）。 */
  let fullPayload = null;

  const fetchAudit = (search = '', options = {}) => httpRequest(port, {
    pathname: `${AUDIT_PATH}${search}`,
    cookie: options.cookie === undefined ? cookie : options.cookie,
  });

  async function enrollColumnSession() {
    const pause = await httpRequest(port, {
      method: 'POST', pathname: '/api/socialV2/activity', body: { paused: true },
    });
    assert.equal(pause.status, 200, `暂停二代仿真失败：${pause.text}`);
    const setup = await httpRequest(port, {
      method: 'POST', pathname: `${COLUMN_PATH}/auth/setup`, body: { password: COLUMN_PASSWORD },
    });
    assert.equal(setup.status, 200, `专栏首设密码失败：${setup.text}`);
    const value = cookieFrom(setup);
    assert.ok(value, `首设密码后必须签发会话 Cookie：${JSON.stringify(setup.headers)}`);
    return value;
  }

  /** 常量驱动的写入清单：枚举全量 + 两个新增 report 取值 + tooLongChars + 稀疏行。 */
  function buildRows() {
    const list = [];
    for (const [index, result] of AUDIT_RESULTS.entries()) {
      list.push({
        kind: 'result',
        index,
        payload: {
          platform: AUDIT_PLATFORMS[index % AUDIT_PLATFORMS.length],
          action: AUDIT_ACTIONS[index % AUDIT_ACTIONS.length],
          result,
          reason: reasonTag('result', index),
        },
      });
    }
    for (const [index, action] of AUDIT_ACTIONS.entries()) {
      list.push({
        kind: 'action',
        index,
        payload: {
          platform: AUDIT_PLATFORMS[index % AUDIT_PLATFORMS.length],
          action,
          result: 'success',
          reason: reasonTag('action', index),
        },
      });
    }
    for (const [index, platform] of AUDIT_PLATFORMS.entries()) {
      list.push({
        kind: 'platform',
        index,
        payload: {
          platform,
          action: 'read',
          result: AUDIT_RESULTS[0],
          reason: reasonTag('platform', index),
        },
      });
    }
    list.push({
      kind: 'report-none',
      index: 0,
      payload: {
        platform: 'xiaoheihe',
        action: 'report',
        result: 'success',
        reason: 'reader-report-none',
        report: {
          contentSource: 'none', classification: 'non-sensitive', destination: null, reportBlockPresent: false,
        },
      },
    });
    list.push({
      kind: 'too-long',
      index: 0,
      payload: {
        platform: 'xiaoheihe',
        action: 'report',
        result: 'failure',
        reason: 'reader-report-too-long',
        tooLongChars: 1234,
      },
    });
    list.push({
      kind: 'sparse',
      index: 0,
      payload: { platform: 'tieba', action: 'unknown', result: 'unknown' },
    });
    return list;
  }

  before(async () => {
    await waitForStableDay();
    harness = await bridgeHarness({
      config: { consoleToken: CONSOLE_TOKEN, consolePort: 0, slang: { enabled: false } },
      consoleSettings: false,
    });
    server = await harness.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    port = server.address().port;

    cookie = await enrollColumnSession();

    // 真实审计目录 == bridge 的 STATE_DIR/xiaoheihe-audit（harness 把 ROOT 改到临时目录）。
    writer = createBackgroundPatrolAudit({ filePath: path.join(harness.temp, 'state', 'xiaoheihe-audit') });
    await writer.load();

    rows = buildRows();
    for (const row of rows) {
      const written = await writer.record(row.payload);
      assert.equal(written.ok, true, `真实写入失败（${row.kind}#${row.index}）：${JSON.stringify(written.error ?? null)}`);
    }

    fullPayload = await fetchAudit('?limit=200');
    assert.equal(fullPayload.status, 200, `GET /audit 失败：${fullPayload.text}`);
    assert.equal(fullPayload.json?.ok, true);
    assert.equal(fullPayload.json.day, beijingPatrolDayKey(Date.now()), '写入与读取必须落在同一个北京时间日键上');
    assert.equal(fullPayload.json.entries.length, rows.length, '所有写入行都应可读回（limit=200 足够）');
  });

  after(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    if (harness) await harness.close();
  });

  it('[L3] 未过专栏会话门禁时 403（读取面不得裸奔）', async () => {
    const denied = await fetchAudit('', { cookie: null });
    assert.equal(denied.status, 403);
    assert.equal(denied.json?.ok, false);
    assert.equal(denied.json?.error, 'column-session-required');
  });

  it('[L3] 回传字段面固定为 7 个白名单键（回传面变化必须同步前端与契约）', async () => {
    for (const entry of fullPayload.json.entries) {
      assert.deepEqual(
        Object.keys(entry).slice().sort(),
        ROUTE_FIELD_NAMES.slice().sort(),
        `GET /audit 的 entry 字段面变了：${JSON.stringify(Object.keys(entry))}`,
      );
      for (const hidden of NOT_ON_ROUTE_SURFACE) {
        assert.equal(hasOwn(entry, hidden), false, `entry 不应回传 ${hidden}（该字段不在当前回传面）`);
      }
    }
  });

  for (const [index, result] of AUDIT_RESULTS.entries()) {
    it(`[L3] result=${result} 经真实路由回传后仍是 "${result}"（不被折叠成 unknown/denied）`, async () => {
      const reason = reasonTag('result', index);
      const entry = fullPayload.json.entries.find((item) => item.reason === reason);
      assert.ok(entry, `找不到 reason=${reason} 的回传行`);
      assert.equal(entry.result, result, `路由把 result 改写了：写入 ${result}，读回 ${entry.result}`);
      assert.equal(entry.action, AUDIT_ACTIONS[index % AUDIT_ACTIONS.length]);
      assert.equal(entry.platform, AUDIT_PLATFORMS[index % AUDIT_PLATFORMS.length]);
    });
  }

  it('[L3] skipped 与 pending 同时存在且互不相等、也都不是 denied/unknown（语义不被合并）', async (t) => {
    const wanted = ['skipped', 'pending'].filter((value) => AUDIT_RESULTS.includes(value));
    if (wanted.length !== 2) {
      t.diagnostic('AUDIT_RESULTS 未同时包含 skipped 与 pending，按常量现状跳过合并性断言');
      return;
    }
    const byReason = (value) => {
      const index = AUDIT_RESULTS.indexOf(value);
      return fullPayload.json.entries.find((item) => item.reason === reasonTag('result', index));
    };
    const skipped = byReason('skipped');
    const pending = byReason('pending');
    assert.equal(skipped.result, 'skipped');
    assert.equal(pending.result, 'pending');
    assert.notEqual(skipped.result, pending.result);
    for (const entry of [skipped, pending]) {
      assert.notEqual(entry.result, 'denied');
      assert.notEqual(entry.result, 'unknown');
    }
  });

  it('[L3] 缺失字段回传为 null 而不是 undefined/缺失（前端 "|| —" 依赖这个口径）', async () => {
    const entry = fullPayload.json.entries.find((item) => item.action === 'unknown' && item.result === 'unknown');
    assert.ok(entry, '找不到稀疏行（只有 platform/action/result）');
    for (const field of ['reason', 'opId', 'operator']) {
      assert.equal(hasOwn(entry, field), true, `稀疏行必须保留 ${field} 键`);
      assert.equal(entry[field], null, `缺失的 ${field} 必须回传 null`);
    }
  });

  it('[L3] limit 取文件末尾（最近 N 条），不是开头', async () => {
    // 最后写入的是稀疏行（无 reason），所以这里用整行 deepEqual 而不是单字段比较。
    const last = fullPayload.json.entries[fullPayload.json.entries.length - 1];
    assert.notDeepEqual(last, fullPayload.json.entries[0], '首行与末行必须可区分，否则该断言没有区分力');

    const limited = await fetchAudit('?limit=1');
    assert.equal(limited.status, 200);
    assert.equal(limited.json.entries.length, 1);
    assert.deepEqual(limited.json.entries[0], last, 'limit=1 必须回传文件最后一行（最近一条）');

    const three = await fetchAudit('?limit=3');
    assert.equal(three.status, 200);
    assert.deepEqual(three.json.entries, fullPayload.json.entries.slice(-3), 'limit=N 必须是末尾 N 条');
  });

  it('[L3] 坏行被丢弃但不影响好行（读取面容错）', async () => {
    const before = fullPayload.json.entries.length;
    const day = beijingPatrolDayKey(Date.now());
    await fs.appendFile(
      path.join(harness.temp, 'state', 'xiaoheihe-audit', `${AUDIT_FILE_PREFIX}${day}${AUDIT_FILE_SUFFIX}`),
      '{broken-json-line\n',
      'utf8',
    );
    const afterFetch = await fetchAudit('?limit=200');
    assert.equal(afterFetch.status, 200);
    assert.equal(afterFetch.json.ok, true);
    assert.equal(afterFetch.json.entries.length, before, '坏行不得出现在 entries 里，也不得挤掉好行');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// L4 前端渲染：public/console.html 的 5 列表格（喂真实 L3 响应体）
// ══════════════════════════════════════════════════════════════════════════════
const CONSOLE_HTML = await fs.readFile(path.join(ROOT, 'public', 'console.html'), 'utf8');

/** 极简 DOM 桩（与 scripts/test-console-column-ui.mjs 的 domStub 同构；该文件不导出，故此处独立一份）。 */
function domStub() {
  const seen = [];
  const elements = new Map();
  const makeEl = (tag = 'div') => {
    const listeners = new Map();
    const el = {
      tagName: String(tag).toUpperCase(), style: {}, dataset: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      children: [], value: '', checked: false, hidden: false,
      textContent: '', innerHTML: '', className: '',
      addEventListener(event, listener) { listeners.set(event, listener); }, setAttribute() {}, removeAttribute() {},
      getAttribute: () => null,
      appendChild(child) { el.children.push(child); return child; },
      insertBefore(child) { return child; }, removeChild() {}, remove() {},
      focus() {}, blur() {}, click() { listeners.get('click')?.({ target: el }); }, scrollIntoView() {},
      querySelector: () => makeEl(), querySelectorAll: () => [],
      closest: () => null, contains: () => false,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
      getContext: () => new Proxy({}, { get: () => () => ({}) }),
      animate: () => ({ finished: Promise.resolve(), cancel() {} }),
    };
    return new Proxy(el, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
        return () => undefined;
      },
      set(target, prop, value) { target[prop] = value; return true; },
      has: () => true,
    });
  };
  const document = {
    getElementById(id) { seen.push(id); if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
    querySelector: () => makeEl(), querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
    addEventListener() {}, body: makeEl('body'), documentElement: makeEl('html'),
    head: makeEl('head'), readyState: 'complete', title: '',
  };
  return { document, seen, elements };
}

/**
 * 跑 console.html 主 script。
 * 末尾追加的接缝只暴露「标记会话已验证」——columnVerifiedAt 是顶层 `let`（词法绑定），
 * 从沙箱外赋值无效，所以必须把接缝写进同一段脚本作用域；不修改生产文件。
 */
function bootConsole() {
  const scripts = [...CONSOLE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const main = scripts.sort((left, right) => right.length - left.length)[0];
  assert.ok(main && main.includes('COLUMN_AUDIT_PATH'), '找不到包含审计表格逻辑的主 script');
  assert.ok(main.includes('async function refreshColumnAudit'), '主 script 缺少 refreshColumnAudit');
  const { document, seen, elements } = domStub();
  let intervals = 0;
  const sandbox = {
    document,
    navigator: { userAgent: 'audit-readers-test', clipboard: { writeText: async () => {} } },
    location: { search: '', pathname: '/', hash: '', reload() {} },
    history: { replaceState() {}, pushState() {} },
    localStorage: {
      _v: new Map(),
      getItem(key) { return this._v.has(key) ? this._v.get(key) : null; },
      setItem(key, value) { this._v.set(key, String(value)); },
      removeItem(key) { this._v.delete(key); },
    },
    // 永不完结的 fetch：本文件不验证真实网络路径，L3 的真实响应体通过 columnApi 注入。
    fetch: () => new Promise(() => {}),
    prompt: () => null, alert() {}, confirm: () => false,
    setInterval() { intervals += 1; return intervals; }, clearInterval() {},
    setTimeout: () => 0, clearTimeout() {},
    console, JSON, Date, Math, Number, String, Boolean, Array, Object, Promise, Error,
    RegExp, Map, Set, isNaN, parseInt, parseFloat, URLSearchParams,
    encodeURIComponent, decodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.matchMedia = () => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  sandbox.scrollTo = () => {};
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sandbox.requestAnimationFrame = (fn) => { try { fn(0); } catch { /* ignore */ } return 0; };
  sandbox.cancelAnimationFrame = () => {};
  sandbox.Chart = function Chart() { return { destroy() {}, update() {}, resize() {} }; };
  sandbox.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  sandbox.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  sandbox.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const seam = [
    '',
    '// 测试接缝（scripts/test-background-patrol-audit-readers.mjs）：只做读取，不改变生产行为。',
    'globalThis.__auditReaderSeam = {',
    '  markVerified(ts) { columnVerifiedAt = ts; columnLastActivityAt = ts; },',
    '  auditPath: COLUMN_AUDIT_PATH,',
    '};',
  ].join('\n');
  let error = null;
  try {
    vm.runInNewContext(main + seam, sandbox, { filename: 'console-inline.js', timeout: 10000 });
  } catch (caught) {
    error = caught;
  }
  return { error, intervals, seen, elements, sandbox };
}

/** 用给定的 /audit 响应体渲染一次表格，返回可断言的 DOM 片段。 */
async function renderAudit(payload) {
  const booted = bootConsole();
  assert.equal(booted.error, null, `console.html 主 script 必须能跑到底：${booted.error && booted.error.message}`);
  const paths = [];
  booted.sandbox.columnApi = async (requestPath) => { paths.push(requestPath); return payload; };
  booted.sandbox.__auditReaderSeam.markVerified(Date.now());
  await booted.sandbox.refreshColumnAudit();
  return {
    paths,
    box: booted.elements.get('columnAuditTable'),
    msg: booted.elements.get('columnAuditMsg'),
    elements: booted.elements,
    sandbox: booted.sandbox,
  };
}

/** 从渲染结果里取出表格：[{ cells: string[] }]（不含表头行）。 */
function tableRows(rendered) {
  const table = rendered.box.children[0];
  assert.ok(table, '审计容器里必须有一个 table');
  assert.equal(table.tagName, 'TABLE');
  const head = table.children[0];
  assert.ok(head, 'table 缺少表头行');
  return {
    headCells: head.children.map((cell) => String(cell.textContent)),
    rows: table.children.slice(1).map((row) => ({ cells: row.children.map((cell) => String(cell.textContent)) })),
    table,
  };
}

describe('L4 console.html 5 列表格：不误显示、不聚合', () => {
  let harness = null;
  let server = null;
  let port = 0;
  let cookie = null;
  let rowsSpec = [];
  /** console.html 真正会拿到的响应体（?limit=50）。 */
  let consolePayload = null;

  // 这一段完全重放「真实写入 → 真实路由」，确保 L4 吃的是真数据而不是手写 JSON。
  before(async () => {
    await waitForStableDay();
    harness = await bridgeHarness({
      config: { consoleToken: CONSOLE_TOKEN, consolePort: 0, slang: { enabled: false } },
      consoleSettings: false,
    });
    server = await harness.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    port = server.address().port;

    const pause = await httpRequest(port, {
      method: 'POST', pathname: '/api/socialV2/activity', body: { paused: true },
    });
    assert.equal(pause.status, 200, `暂停二代仿真失败：${pause.text}`);
    const setup = await httpRequest(port, {
      method: 'POST', pathname: `${COLUMN_PATH}/auth/setup`, body: { password: COLUMN_PASSWORD },
    });
    assert.equal(setup.status, 200, `专栏首设密码失败：${setup.text}`);
    cookie = cookieFrom(setup);
    assert.ok(cookie);

    const writer = createBackgroundPatrolAudit({ filePath: path.join(harness.temp, 'state', 'xiaoheihe-audit') });
    await writer.load();
    rowsSpec = [];
    for (const [index, result] of AUDIT_RESULTS.entries()) {
      rowsSpec.push({
        payload: {
          platform: AUDIT_PLATFORMS[index % AUDIT_PLATFORMS.length],
          action: AUDIT_ACTIONS[index % AUDIT_ACTIONS.length],
          result,
          reason: reasonTag('result', index),
        },
      });
    }
    rowsSpec.push({
      payload: {
        platform: 'xiaoheihe',
        action: 'report',
        result: 'success',
        reason: 'reader-report-none',
        report: {
          contentSource: 'none', classification: 'non-sensitive', destination: null, reportBlockPresent: false,
        },
      },
    });
    for (const row of rowsSpec) {
      const written = await writer.record(row.payload);
      assert.equal(written.ok, true, `真实写入失败：${JSON.stringify(written.error ?? null)}`);
    }

    const response = await httpRequest(port, { pathname: `${AUDIT_PATH}?limit=${ROUTE_LIMIT}`, cookie });
    assert.equal(response.status, 200, `GET /audit 失败：${response.text}`);
    assert.equal(response.json?.ok, true);
    consolePayload = response.json;
    assert.equal(consolePayload.day, beijingPatrolDayKey(Date.now()));
    assert.equal(consolePayload.entries.length, rowsSpec.length);
  });

  after(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    if (harness) await harness.close();
  });

  it('[L4] 表头逐字是 5 列：时间/平台/动作/结果/原因', async () => {
    const { headCells } = tableRows(await renderAudit(consolePayload));
    assert.deepEqual(headCells, CONSOLE_COLUMNS);
  });

  it('[L4] 请求形状：路径 = COLUMN_AUDIT_PATH，且带 ?limit=50', async () => {
    const rendered = await renderAudit(consolePayload);
    assert.deepEqual(rendered.paths, [`${AUDIT_PATH}?limit=${ROUTE_LIMIT}`]);
    assert.equal(rendered.sandbox.__auditReaderSeam.auditPath, AUDIT_PATH);
  });

  it('[L4] 每行恰好 5 格，行数 = entries 数（不折叠、不聚合）', async () => {
    const { rows } = tableRows(await renderAudit(consolePayload));
    assert.equal(rows.length, consolePayload.entries.length);
    for (const row of rows) assert.equal(row.cells.length, CONSOLE_COLUMNS.length);
  });

  it('[L4] 最近在前：第一行数据对应 entries 的最后一个元素', async () => {
    const { rows } = tableRows(await renderAudit(consolePayload));
    const newest = consolePayload.entries[consolePayload.entries.length - 1];
    assert.equal(rows[0].cells[4], newest.reason, '首行必须是最新一条（entries.slice().reverse()）');
    assert.equal(rows[0].cells[1], newest.platform);
    assert.equal(rows[0].cells[2], newest.action);
    assert.equal(rows[0].cells[3], newest.result);
  });

  it('[L4] 汇总文案只报总条数，不含任何按 result 的分类统计', async () => {
    const rendered = await renderAudit(consolePayload);
    assert.equal(
      rendered.msg.textContent,
      `${consolePayload.day} 共 ${consolePayload.entries.length} 条（最近在前）`,
    );
    for (const value of AUDIT_RESULTS) {
      assert.equal(
        rendered.msg.textContent.includes(value),
        false,
        `汇总文案不应出现枚举名 "${value}"（页面没有按 result 的聚合统计）`,
      );
    }
    const { table, rows } = tableRows(rendered);
    assert.equal(rendered.box.children.length, 1, '审计容器里只能有一张表，不得追加统计块');
    assert.equal(table.children.length, rows.length + 1, '表格行数必须是 表头 + 每条记录');
  });

  it('[L4] 空结果渲染为「当日暂无审计记录。」', async () => {
    const rendered = await renderAudit({ ok: true, day: '2026-01-01', entries: [] });
    assert.equal(rendered.box.textContent, '当日暂无审计记录。');
    assert.equal(rendered.msg.textContent, '2026-01-01 共 0 条（最近在前）');
  });

  it('[L4] 全空字段都渲染成「—」（不显示 undefined/null/空串）', async () => {
    const rendered = await renderAudit({
      ok: true,
      day: '2026-01-01',
      entries: [{ at: null, platform: null, action: null, result: null, reason: null, opId: null, operator: null }],
    });
    const { rows } = tableRows(rendered);
    assert.deepEqual(rows[0].cells, ['—', '—', '—', '—', '—']);
  });

  it('[L4] ok:false 渲染为「读取失败：…」，不残留上一轮的表格', async () => {
    const rendered = await renderAudit({ ok: false, error: 'audit-unavailable' });
    assert.match(rendered.msg.textContent, /^读取失败：/u);
    assert.equal(rendered.box.children.length, 0, '失败时不得渲染表格');
  });

  for (const [index, result] of AUDIT_RESULTS.entries()) {
    it(`[L3→L4] result=${result} 端到端：写入 → 路由 → 表格「结果」列逐字为 "${result}"`, async () => {
      const reason = reasonTag('result', index);
      const entry = consolePayload.entries.find((item) => item.reason === reason);
      assert.ok(entry, `路由回传里找不到 reason=${reason}`);
      assert.equal(entry.result, result, 'L3 搬运阶段不得改写 result');
      const { rows } = tableRows(await renderAudit(consolePayload));
      const rendered = rows.find((row) => row.cells[4] === reason);
      assert.ok(rendered, `表格里找不到 原因=${reason} 的行`);
      assert.equal(rendered.cells[3], result, `L4 渲染阶段改写了 result：期望 ${result}，实际 ${rendered.cells[3]}`);
      assert.notEqual(rendered.cells[3], '—', `result=${result} 不得退化成占位符`);
      assert.equal(rendered.cells[1], entry.platform);
      assert.equal(rendered.cells[2], entry.action);
    });
  }
});
