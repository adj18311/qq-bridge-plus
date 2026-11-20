// 鱼缸日记（Fish Diary）P2 方案 C：7 个**控制台**端点的契约测试。
//
// 与 test-diary-endpoints.mjs 一样，全部走**真实桥接 + 真实 HTTP**
// （scripts/audit-bridge-harness.mjs 在系统临时目录里跑真实 src/bridge.js），
// 日记/配置/备份/审计一律落临时目录 —— 仓库里真实的 `Fish Diary/*.txt`
// 必须始终保持 0 字节（本文件最后一条用例显式复核）。
//
// 覆盖点（对应任务卡 t4 的验收要求）：
//   · 7 个端点各自的鉴权失败（无控制台令牌 401 / 带 agent 令牌 403 / 缺 x-console-admin 403）
//   · 7 个端点各自的成功路径
//   · 方案 C 隐私红线：status / backups / audit / restore 的响应体**不含日记正文片段**
//   · 恢复（restore）算一次写入：占当日额度、并且恢复前先把当前版本备份下来
//   · config 热生效：不重启桥接，改完 limit 立刻生效；关总开关/单工具后 agent 工具立刻 diary-disabled
//   · reset-usage / cleanup 都会写审计；审计里只有元数据
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE_TOKEN = 'fixture-console-token';
const ALLOWED_KEY = 'private:123';
const ALLOWED_GROUP = 'group:456';

const STATUS_PATH = '/api/diary/status';
const CONFIG_PATH = '/api/diary/config';
const RESET_PATH = '/api/diary/reset-usage';
const BACKUPS_PATH = '/api/diary/backups';
const RESTORE_PATH = '/api/diary/restore';
const CLEANUP_PATH = '/api/diary/cleanup';
const AUDIT_PATH = '/api/diary/audit';
const CONSOLE_PATHS = [STATUS_PATH, CONFIG_PATH, RESET_PATH, BACKUPS_PATH, RESTORE_PATH, CLEANUP_PATH, AUDIT_PATH];

const AGENT_WRITE_PATH = '/api/socialV2/diary/write';

const NOTEBOOK_FILE = 'Fish Diary Notebook.txt';
const PRIVY_FILE = 'Fish Privy Diary Notebook.txt';
const REPO_DIARY_DIR = fileURLToPath(new URL('../Fish Diary/', import.meta.url));

// 真实仓库日记文件的「进入测试时」快照。
// 历史上这里断言的是「必须 0 字节」——那是「测试没碰过它」的代理指标，但只要智能体自己
// 写过字（2026-11-02 就写了 3877 B / 791 B），代理指标就会失效并误报。现在直接验证不变量：
// 整个测试跑完，这两个文件的存在状态与字节内容都不得有任何变化。
const REPO_DIARY_SNAPSHOT = (() => {
  const snap = new Map();
  for (const name of [NOTEBOOK_FILE, PRIVY_FILE]) {
    const file = path.join(REPO_DIARY_DIR, name);
    try {
      const buf = fs.readFileSync(file);
      snap.set(file, { exists: true, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    } catch {
      snap.set(file, { exists: false, size: 0, sha256: null });
    }
  }
  return snap;
})();
function assertRepoDiaryUntouched(label) {
  for (const [file, before] of REPO_DIARY_SNAPSHOT) {
    const name = path.basename(file);
    let now;
    try {
      const buf = fs.readFileSync(file);
      now = { exists: true, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    } catch {
      now = { exists: false, size: 0, sha256: null };
    }
    assert.equal(now.exists, before.exists, `${label}：${name} 的存在状态被改动`);
    assert.equal(now.size, before.size, `${label}：测试不得写入真实日记文件 ${name}（进入时为 ${before.size} 字节，现在 ${now.size} 字节）`);
    assert.equal(now.sha256, before.sha256, `${label}：${name} 的字节内容被测试改动`);
  }
}

/** 一段绝不可能出现在任何元数据里的正文标记，用来断言「响应体不含正文」。 */
const SECRET_TEXT = '绝密正文片段-ZQX-9f3a：今天心情很差，但只写给自己的';

function request(port, { method = 'GET', pathname, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request hung')));
    if (payload) req.end(payload);
    else req.end();
  });
}

/** 控制台请求：页面里的 api() 恒带 x-console-token + x-console-admin: 1。 */
function consoleRequest(port, { method = 'GET', pathname, body, headers = {} } = {}) {
  return request(port, {
    method,
    pathname,
    body,
    headers: { 'x-console-token': CONSOLE_TOKEN, 'x-console-admin': '1', ...headers },
  });
}

/** agent 调用：MCP 工具同时持有控制台令牌与会话令牌。 */
function agentRequest(port, { token, pathname, method = 'POST', body } = {}) {
  return request(port, {
    method,
    pathname,
    body,
    headers: {
      'x-console-token': CONSOLE_TOKEN,
      'x-agent-call': '1',
      ...(token === undefined ? {} : { 'x-agent-token': token }),
    },
  });
}

async function boot({ diaryEnabled = true, config = {}, savedState = null } = {}) {
  const h = await bridgeHarness({
    config: {
      ...config,
      socialV2: {
        enabled: true,
        ...(config.socialV2 ?? {}),
        tools: { diary: diaryEnabled, ...(config.socialV2?.tools ?? {}) },
      },
    },
    savedState: savedState ?? { mode: 'reserved2', sessions: { [ALLOWED_KEY]: 'sid-1', [ALLOWED_GROUP]: 'sid-2' } },
  });
  h.setMode('reserved2');
  h.setReady(true);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    h,
    port,
    temp: h.temp,
    token: h.getSocialV2State(ALLOWED_KEY).agentToken,
    diaryPath: (which) => path.join(h.temp, 'Fish Diary', which === 'privy' ? PRIVY_FILE : NOTEBOOK_FILE),
    readDiary: (which) => {
      const file = path.join(h.temp, 'Fish Diary', which === 'privy' ? PRIVY_FILE : NOTEBOOK_FILE);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    },
    configFile: () => path.join(h.temp, 'state', 'diary-config.json'),
    usageFile: () => path.join(h.temp, 'state', 'diary-usage.json'),
    auditFile: () => path.join(h.temp, 'state', 'diary-audit.jsonl'),
    readAuditLines: () => {
      const file = path.join(h.temp, 'state', 'diary-audit.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    },
  };
}

const agentBody = (extra = {}) => ({ key: ALLOWED_KEY, ...extra });

/** 读回来的正文统一成 LF，省得测试关心 EOL 风格（store 会保留原文件风格）。 */
const lf = (text) => String(text ?? '').replace(/\r\n/g, '\n');

/** 每个错误响应都必须是「非 200 + ok:false + 稳定 code」。 */
function assertErrorEnvelope(res, expectedCode) {
  assert.notEqual(res.status, 200, `错误不得以 200 返回：${JSON.stringify(res.body)}`);
  assert.equal(res.body?.ok, false, `错误响应必须 ok:false：${JSON.stringify(res.body)}`);
  assert.equal(typeof res.body?.code, 'string', `错误响应必须带稳定 code：${JSON.stringify(res.body)}`);
  if (expectedCode) assert.equal(res.body.code, expectedCode, `期望 code=${expectedCode}，实际 ${res.body.code}`);
}

/** 响应里不得出现正文（方案 C 隐私红线）。 */
function assertNoSecret(res, label) {
  assert.ok(!String(res.text ?? JSON.stringify(res.body ?? '')).includes('绝密正文片段'),
    `${label} 的响应体不得包含日记正文片段：${String(res.text).slice(0, 400)}`);
  const keys = Object.keys(res.body ?? {});
  for (const banned of ['text', 'content', 'body', 'lines', 'preview']) {
    assert.ok(!keys.includes(banned), `${label} 响应体不得含正文字段 ${banned}：${keys.join(',')}`);
  }
}

// ── ① 鉴权：7 个端点 × 3 种失败 ─────────────────────────────────────────────
test('① 7 端点鉴权：无控制台令牌 401、带 agent 令牌 403、缺 x-console-admin 403', async () => {
  const ctx = await boot();
  try {
    for (const pathname of CONSOLE_PATHS) {
      const method = pathname === STATUS_PATH || pathname === BACKUPS_PATH || pathname === AUDIT_PATH ? 'GET' : 'POST';

      // (a) 没有任何令牌：集中关卡 401。
      const anon = await request(ctx.port, { method, pathname, body: method === 'POST' ? {} : undefined });
      assert.equal(anon.status, 401, `${pathname} 无令牌应 401，实际 ${anon.status}`);

      // (b) 带 agent 会话令牌：即使同时持有控制台令牌，也必须被挡（agent token 白名单）。
      const asAgent = await agentRequest(ctx.port, { token: ctx.token, pathname, method, body: method === 'POST' ? agentBody() : undefined });
      assert.equal(asAgent.status, 403, `${pathname} 带 agent 令牌应 403，实际 ${asAgent.status}`);
      assert.match(String(asAgent.body?.error ?? ''), /仅控制台/, `${pathname} 应给出「仅控制台」理由`);

      // (c) 有控制台令牌但没有 x-console-admin 正向标记：端点自己拒绝（confused deputy 防护）。
      const noAdmin = await request(ctx.port, {
        method,
        pathname: `${pathname}?token=${CONSOLE_TOKEN}`,
        headers: { 'x-console-token': CONSOLE_TOKEN, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        body: method === 'POST' ? {} : undefined,
      });
      assert.equal(noAdmin.status, 403, `${pathname} 缺 x-console-admin 应 403，实际 ${noAdmin.status}`);
      assertErrorEnvelope(noAdmin, 'console-only');
    }
  } finally {
    await ctx.close();
  }
});

// ── ② status：只有元数据 ────────────────────────────────────────────────────
test('② status：返回元数据 + 限额 + 今日用量，零正文', async () => {
  const ctx = await boot();
  try {
    await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: SECRET_TEXT }) });

    const res = await consoleRequest(ctx.port, { pathname: STATUS_PATH });
    assert.equal(res.status, 200, `status 应 200：${res.text}`);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.tools, { read: true, edit: true, write: true, delete: true });
    assert.equal(res.body.limits.maxFileBytes, 10 * 1024 * 1024);
    // 默认单次写入上限 = min(store 默认 1MB, 桥接 HTTP 体上限 1_000_000)。
    // 取小的那个才是「真能写进去」的值 —— 否则默认值本身就超 HTTP 上限（旧缺陷）。
    assert.equal(res.body.limits.maxPayloadBytes, 1_000_000);
    assert.equal(res.body.effectiveLimits.httpMaxBodyBytes, 1_000_000);
    assert.equal(res.body.effectiveLimits.maxPayloadBytes, 1_000_000);
    assert.equal(res.body.effectiveLimits.capped, false);
    assert.equal(res.body.limits.dailyWrites, 10);
    assert.equal(res.body.limits.backupKeep, 10);
    assert.equal(res.body.configPath, 'state/diary-config.json');
    assert.equal(res.body.configCorrupt, false);
    assert.equal(res.body.files.notebook.bytes, Buffer.byteLength(SECRET_TEXT, 'utf8'));
    assert.equal(res.body.files.notebook.lineCount, 1);
    assert.equal(res.body.files.notebook.usedToday, 1);
    assert.equal(res.body.files.notebook.remaining, 9);
    assert.equal(res.body.files.privy.exists, false);
    assert.equal(res.body.files.privy.usedToday, 0);
    assertNoSecret(res, 'status');
  } finally {
    await ctx.close();
  }
});

// ── ③ config：热生效（限额 / 单工具 / 总开关）────────────────────────────────
test('③ config 热生效：改 dailyWrites 后立刻限流，改 tools.write 后立刻 diary-disabled', async () => {
  const ctx = await boot();
  try {
    // 先把额度改成 1 —— 不重启桥接。
    const first = await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: 'a', mode: 'append' }) });
    assert.equal(first.status, 200, first.text);

    const patch = await consoleRequest(ctx.port, {
      method: 'POST',
      pathname: CONFIG_PATH,
      body: { limits: { dailyWrites: 2 } },
    });
    assert.equal(patch.status, 200, `config 应 200：${patch.text}`);
    assert.equal(patch.body.ok, true);
    assert.equal(patch.body.limits.dailyWrites, 2);
    assert.match(String(patch.body.note ?? ''), /立即生效/);

    // 落盘可复核：state/diary-config.json 在临时 root 里。
    const onDisk = JSON.parse(fs.readFileSync(ctx.configFile(), 'utf8'));
    assert.equal(onDisk.limits.dailyWrites, 2);
    assert.equal(onDisk.enabled, true);

    // 热生效①：已用 1 次，新上限 2 → 第 2 次成功、第 3 次 429。
    const second = await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: 'b', mode: 'append' }) });
    assert.equal(second.status, 200, second.text);
    const third = await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: 'c', mode: 'append' }) });
    assertErrorEnvelope(third, 'daily-write-limit');
    assert.equal(third.status, 429);

    // 热生效②：单独关掉 write 工具，写入立刻 403 diary-disabled，但 read 仍然可用。
    const off = await consoleRequest(ctx.port, { method: 'POST', pathname: CONFIG_PATH, body: { tools: { write: false } } });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.body.tools.write, false);
    assert.equal(off.body.tools.read, true);

    const blocked = await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: 'd', mode: 'append' }) });
    assertErrorEnvelope(blocked, 'diary-disabled');
    assert.equal(blocked.status, 403);
    assert.match(String(blocked.body.error), /write/);
    assert.equal(lf(ctx.readDiary('notebook')), 'a\nb');

    // 热生效③：关总开关，read 也立刻被拒。
    const allOff = await consoleRequest(ctx.port, { method: 'POST', pathname: CONFIG_PATH, body: { enabled: false } });
    assert.equal(allOff.status, 200, allOff.text);
    assert.equal(allOff.body.enabled, false);
    const readBlocked = await agentRequest(ctx.port, {
      token: ctx.token, pathname: '/api/socialV2/diary/read', body: agentBody({ which: 'notebook' }),
    });
    assertErrorEnvelope(readBlocked, 'diary-disabled');

    // status 反映关闭状态（控制台要能显示，不然用户没法再打开）。
    const status = await consoleRequest(ctx.port, { pathname: STATUS_PATH });
    assert.equal(status.status, 200, status.text);
    assert.equal(status.body.enabled, false);

    // 非法配置：未知限额键 → 400 bad-diary-config，且**不覆盖**已生效的配置。
    const bad = await consoleRequest(ctx.port, { method: 'POST', pathname: CONFIG_PATH, body: { limits: { nope: 1 } } });
    assert.equal(bad.status, 400, bad.text);
    assert.equal(bad.body.code, 'bad-diary-config');
    const afterBad = JSON.parse(fs.readFileSync(ctx.configFile(), 'utf8'));
    assert.equal(afterBad.enabled, false, '非法 patch 不得改动已落盘的配置');
  } finally {
    await ctx.close();
  }
});

// ── ④ reset-usage：计数归零 + 记审计 ────────────────────────────────────────
test('④ reset-usage：归零当日计数并写审计，不影响日记内容', async () => {
  const ctx = await boot();
  try {
    await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: '第一行' }) });
    await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: '第二行', mode: 'append' }) });

    const before = await consoleRequest(ctx.port, { pathname: STATUS_PATH });
    assert.equal(before.body.files.notebook.usedToday, 2);

    const reset = await consoleRequest(ctx.port, { method: 'POST', pathname: RESET_PATH, body: { which: 'notebook' } });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(reset.body.ok, true);
    assert.equal(reset.body.which, 'notebook');
    assert.equal(reset.body.before.notebook, 2);
    assert.equal(reset.body.after.notebook, 0);

    const after = await consoleRequest(ctx.port, { pathname: STATUS_PATH });
    assert.equal(after.body.files.notebook.usedToday, 0);
    assert.equal(after.body.files.notebook.remaining, 10);

    // 内容一字未动。
    assert.equal(lf(ctx.readDiary('notebook')), '第一行\n第二行');

    // 审计里有一条 reset-usage。
    const audits = ctx.readAuditLines();
    const entry = audits.find((e) => e.op === 'reset-usage');
    assert.ok(entry, `审计应包含 reset-usage：${JSON.stringify(audits)}`);
    assert.equal(entry.ok, true);

    // 非法 which → 400 bad-which。
    const bad = await consoleRequest(ctx.port, { method: 'POST', pathname: RESET_PATH, body: { which: '../etc' } });
    assertErrorEnvelope(bad, 'bad-which');
  } finally {
    await ctx.close();
  }
});

// ── ⑤ backups + restore：恢复算一次写入，恢复前先备份当前版本 ─────────────────
test('⑤ restore：占一次写入额度、恢复前先备份当前版本、响应无正文', async () => {
  const ctx = await boot();
  try {
    // 第一次写：文件原本不存在/为空 → 不产生备份。
    await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: SECRET_TEXT }) });
    // 第二次写（覆盖）：产生一份 overwrite 备份，内容 = 上一版正文。
    await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: '第二版正文' }) });

    const list = await consoleRequest(ctx.port, { pathname: `${BACKUPS_PATH}?which=notebook` });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.ok, true);
    assert.equal(list.body.which, 'notebook');
    assert.ok(list.body.backups.length >= 1, `应有至少一份备份：${list.text}`);
    const backup = list.body.backups[0];
    for (const key of ['id', 'at', 'bytes', 'kind']) {
      assert.ok(key in backup, `备份项应含 ${key}：${JSON.stringify(backup)}`);
    }
    assert.equal(typeof backup.id, 'string');
    assert.equal(backup.kind, 'overwrite');
    assert.equal(backup.bytes, Buffer.byteLength(SECRET_TEXT, 'utf8'));
    assertNoSecret(list, 'backups');

    // 无 which 时返回双文件结构。
    const both = await consoleRequest(ctx.port, { pathname: BACKUPS_PATH });
    assert.equal(both.status, 200, both.text);
    assert.ok(Array.isArray(both.body.backups.notebook));
    assert.ok(Array.isArray(both.body.backups.privy));
    assertNoSecret(both, 'backups(all)');

    const usedBefore = (await consoleRequest(ctx.port, { pathname: STATUS_PATH })).body.files.notebook.usedToday;
    assert.equal(usedBefore, 2);

    const restore = await consoleRequest(ctx.port, { method: 'POST', pathname: RESTORE_PATH, body: { which: 'notebook', backupId: backup.id } });
    assert.equal(restore.status, 200, `restore 应 200：${restore.text}`);
    assert.equal(restore.body.ok, true);
    assert.equal(restore.body.which, 'notebook');
    assert.equal(restore.body.restoredFrom, backup.id);
    assert.equal(restore.body.bytes, Buffer.byteLength(SECRET_TEXT, 'utf8'));
    assert.equal(restore.body.lineCount, 1);
    assertNoSecret(restore, 'restore');

    // 正文真的回去了（服务端行为，不通过接口断言内容 —— 接口本身不回正文）。
    assert.equal(ctx.readDiary('notebook'), SECRET_TEXT);

    // 恢复算一次写入：计数 +1。
    const usedAfter = (await consoleRequest(ctx.port, { pathname: STATUS_PATH })).body.files.notebook.usedToday;
    assert.equal(usedAfter, 3, 'restore 必须占一次当日写入额度');

    // 恢复前先备份当前版本：新增一份 kind=restore 的备份（内容是"第二版正文"上一版）。
    const list2 = await consoleRequest(ctx.port, { pathname: `${BACKUPS_PATH}?which=notebook` });
    const kinds = list2.body.backups.map((b) => b.kind);
    assert.ok(kinds.includes('restore'), `恢复前应先备份当前版本：${JSON.stringify(kinds)}`);

    // 额度耗尽时 restore 也必须 429（不能被当成「只读操作」偷偷放行）。
    await consoleRequest(ctx.port, { method: 'POST', pathname: CONFIG_PATH, body: { limits: { dailyWrites: 3 } } });
    const overLimit = await consoleRequest(ctx.port, { method: 'POST', pathname: RESTORE_PATH, body: { which: 'notebook', backupId: backup.id } });
    assertErrorEnvelope(overLimit, 'daily-write-limit');

    // 非法 backupId → 400 bad-backup-id。
    const badId = await consoleRequest(ctx.port, { method: 'POST', pathname: RESTORE_PATH, body: { which: 'notebook', backupId: '../../config.json' } });
    assertErrorEnvelope(badId, 'bad-backup-id');
  } finally {
    await ctx.close();
  }
});

// ── ⑥ cleanup：保留最近 N 份 ────────────────────────────────────────────────
test('⑥ cleanup：只保留最近 keep 份备份并记审计', async () => {
  const ctx = await boot();
  try {
    for (let i = 0; i < 4; i += 1) {
      await agentRequest(ctx.port, {
        token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: `第 ${i} 版` }),
      });
    }
    const before = await consoleRequest(ctx.port, { pathname: `${BACKUPS_PATH}?which=notebook` });
    assert.equal(before.body.backups.length, 3, `4 次写入应留下 3 份备份：${before.text}`);

    const cleanup = await consoleRequest(ctx.port, { method: 'POST', pathname: CLEANUP_PATH, body: { which: 'notebook', keep: 1 } });
    assert.equal(cleanup.status, 200, cleanup.text);
    assert.equal(cleanup.body.ok, true);
    assert.equal(cleanup.body.keep, 1);
    assert.equal(cleanup.body.removed.notebook, 2);
    assert.equal(cleanup.body.total, 2);

    const after = await consoleRequest(ctx.port, { pathname: `${BACKUPS_PATH}?which=notebook` });
    assert.equal(after.body.backups.length, 1);

    // 未被清理的那份必须是最新的（keep 是「最近 N 份」）。
    assert.equal(after.body.backups[0].id, before.body.backups[0].id);

    const audits = ctx.readAuditLines();
    assert.ok(audits.some((e) => e.op === 'cleanup' && e.ok === true), `审计应包含 cleanup：${JSON.stringify(audits)}`);

    // 日记内容没被 cleanup 碰到。
    assert.equal(lf(ctx.readDiary('notebook')), '第 3 版');
  } finally {
    await ctx.close();
  }
});

// ── ⑦ audit：元数据，无正文 ────────────────────────────────────────────────
test('⑦ audit：只回时间/操作/结果/文件/字节/备份 id，绝不含正文', async () => {
  const ctx = await boot();
  try {
    await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: SECRET_TEXT }) });
    await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: '覆盖后的正文' }) });
    await consoleRequest(ctx.port, { method: 'POST', pathname: RESET_PATH, body: {} });

    const res = await consoleRequest(ctx.port, { pathname: `${AUDIT_PATH}?limit=200` });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.count >= 3, `审计至少 3 条：${res.text}`);

    for (const entry of res.body.entries) {
      for (const key of Object.keys(entry)) {
        assert.ok(['at', 'file', 'op', 'mode', 'bytes', 'sha256', 'backup', 'ok'].includes(key),
          `审计项出现白名单外字段 ${key}：${JSON.stringify(entry)}`);
      }
      assert.equal(typeof entry.at, 'number');
    }
    const ops = res.body.entries.map((e) => e.op);
    // store 的审计 op 用的是「模式名」：overwrite/append/edit/delete/restore。
    assert.ok(ops.includes('overwrite'), `审计应含 overwrite：${ops.join(',')}`);
    assert.ok(ops.includes('reset-usage'), `审计应含 reset-usage：${ops.join(',')}`);

    // sha256 是元数据（可校验完整性），但正文片段绝不能出现。
    const writeEntry = res.body.entries.find((e) => e.op === 'overwrite');
    assert.equal(writeEntry.file, 'notebook');
    assert.equal(typeof writeEntry.sha256, 'string');
    assert.equal(writeEntry.sha256.length, 64);
    assertNoSecret(res, 'audit');

    // 磁盘上的审计文件本身也不许含正文（§8：日志/审计都不落内容）。
    const rawAudit = fs.readFileSync(ctx.auditFile(), 'utf8');
    assert.ok(!rawAudit.includes('绝密正文片段'), '审计文件不得落日记正文');
    assert.ok(!rawAudit.includes('覆盖后的正文'), '审计文件不得落日记正文');

    // 非法 limit 走钳制而不是报错。
    const clamped = await consoleRequest(ctx.port, { pathname: `${AUDIT_PATH}?limit=99999` });
    assert.equal(clamped.status, 200, clamped.text);
    assert.ok(clamped.body.entries.length <= 500);
  } finally {
    await ctx.close();
  }
});

// ── ⑧ HTTP 请求体上限 vs 日记单次写入上限（控制台提示的「我配了 10MB 为什么还报 1MB」）──
// 背景（队长实测发现的真实缺陷）：桥接全局 MAX_BODY_BYTES = 1_000_000，readBody() 在读 body
// 阶段就 413；而 diary limits.maxPayloadBytes 默认 1_048_576、控制台还允许配到 100MB。
// 结果是「控制台让你配 10MB，但任何超过 ~1MB 的写入都在 HTTP 层就被拒，且文案说超过 1MB」。
// 修法（本用例锁定）：① 默认 maxPayloadBytes 取 min(store 1MB, HTTP 上限) = 1_000_000；
// ② 控制台再想配更大 → 400 + 明确解释（不静默钳，避免「以为记住了」）；
// ③ 413 带稳定 code=body-too-large 且文案同时写出「HTTP 上限」与「用户当前配置值」。
test('⑧ HTTP 体上限：995000 字节可写、1000000 被拒且 code 稳定、config 超限 400 并解释', async () => {
  const ctx = await boot();
  try {
    // 默认值自洽：默认 maxPayloadBytes 不得大于 HTTP 上限（旧版是 1048576 > 1000000）。
    const status0 = await consoleRequest(ctx.port, { pathname: STATUS_PATH });
    assert.equal(status0.status, 200, status0.text);
    const httpMax = status0.body.effectiveLimits.httpMaxBodyBytes;
    assert.equal(httpMax, 1_000_000, 'HTTP 体上限应为 1_000_000');
    assert.ok(status0.body.limits.maxPayloadBytes <= httpMax,
      `默认 maxPayloadBytes（${status0.body.limits.maxPayloadBytes}）不得大于 HTTP 上限 ${httpMax}`);
    assert.equal(status0.body.effectiveLimits.maxPayloadBytes, status0.body.limits.maxPayloadBytes);
    assert.equal(status0.body.effectiveLimits.capped, false);

    // 额度放大，避免用例被每日 10 次限流干扰。
    const bump = await consoleRequest(ctx.port, { method: 'POST', pathname: CONFIG_PATH, body: { limits: { dailyWrites: 50 } } });
    assert.equal(bump.status, 200, bump.text);

    // ① 995000 字节的正文：必须真的写进去（这是「配了 1MB 就该能写接近 1MB」的下界）。
    const bigText = 'A'.repeat(995_000);
    const okWrite = await agentRequest(ctx.port, {
      token: ctx.token,
      pathname: AGENT_WRITE_PATH,
      body: agentBody({ which: 'notebook', text: bigText }),
    });
    assert.equal(okWrite.status, 200, `995000 字节应可写入：${okWrite.text.slice(0, 300)}`);
    assert.equal(okWrite.body.bytes, 995_000);
    assert.equal(ctx.readDiary('notebook').length, 995_000);

    // ② 整体超过 1_000_000 字节的请求体：HTTP 层 413，code 稳定，文案含具体数字。
    const tooBig = await agentRequest(ctx.port, {
      token: ctx.token,
      pathname: AGENT_WRITE_PATH,
      body: agentBody({ which: 'notebook', text: 'B'.repeat(1_000_000) }),
    });
    assert.equal(tooBig.status, 413, `超过 HTTP 上限应 413：${tooBig.text.slice(0, 300)}`);
    assert.equal(tooBig.body.ok, false);
    assert.equal(tooBig.body.code, 'body-too-large', '413 必须带稳定 code');
    assert.match(String(tooBig.body.error), /1000000/, `文案要写出 HTTP 上限具体数字：${tooBig.body.error}`);
    assert.match(String(tooBig.body.error), /maxPayloadBytes/, '文案要点名是哪个配置项');
    // 被拒的写入不得落盘（正文仍是上一次的 995000 字节）。
    assert.equal(ctx.readDiary('notebook').length, 995_000);

    // ③ 控制台试图把 maxPayloadBytes 配到 HTTP 上限之上：400 + 解释，且不覆盖已落盘配置。
    const before = JSON.parse(fs.readFileSync(ctx.configFile(), 'utf8'));
    const overLimit = await consoleRequest(ctx.port, {
      method: 'POST',
      pathname: CONFIG_PATH,
      body: { limits: { maxPayloadBytes: 2_000_000 } },
    });
    assert.equal(overLimit.status, 400, `超 HTTP 上限的配置应 400：${overLimit.text}`);
    assert.equal(overLimit.body.code, 'bad-diary-config');
    assert.match(String(overLimit.body.error), /1000000/, `错误要写出真实上限：${overLimit.body.error}`);
    assert.match(String(overLimit.body.error), /HTTP/, '错误要说明这是 HTTP 请求体上限而非业务规则');
    const after = JSON.parse(fs.readFileSync(ctx.configFile(), 'utf8'));
    assert.deepEqual(after, before, '被拒的配置不得写盘');

    // ④ 手改配置越过上限（模拟旧版本残留 / 直接编辑文件）：不判成损坏，按 HTTP 上限生效并提示。
    fs.writeFileSync(ctx.configFile(), JSON.stringify({
      schemaVersion: 1, enabled: true,
      tools: { read: true, edit: true, write: true, delete: true },
      limits: { maxFileBytes: 10 * 1024 * 1024, maxPayloadBytes: 5_000_000, dailyWrites: 50, backupKeep: 10 },
    }, null, 2), 'utf8');
    const legacy = await consoleRequest(ctx.port, { pathname: STATUS_PATH });
    assert.equal(legacy.status, 200, legacy.text);
    assert.equal(legacy.body.configCorrupt, false, '越界的 maxPayloadBytes 不得把整份配置判成损坏');
    assert.equal(legacy.body.limits.maxPayloadBytes, httpMax, '实际生效值应被压到 HTTP 上限');
    assert.equal(legacy.body.effectiveLimits.capped, true, '应显式标记「被压低了」');
    assert.equal(legacy.body.effectiveLimits.configuredMaxPayloadBytes, 5_000_000, '仍要如实回显用户配置值');
    assert.match(String(legacy.body.configNotice ?? ''), /1000000/, '应给出可读的降级提示');

    // ⑤ 极端：连 config 端点自己都收到超大 body 时，同样给 body-too-large（而不是裸 413 无 code）。
    const bigConfigBody = await consoleRequest(ctx.port, {
      method: 'POST',
      pathname: CONFIG_PATH,
      body: { note: 'C'.repeat(1_000_000) },
    });
    assert.equal(bigConfigBody.status, 413, bigConfigBody.text.slice(0, 200));
    assert.equal(bigConfigBody.body.code, 'body-too-large');
  } finally {
    await ctx.close();
  }
});

// ── ⑨ 路径/方法边界 + 真实仓库保持 0 字节 ────────────────────────────────────
test('⑨ 端点只认这 7 个路径与固定方法；真实仓库 Fish Diary/ 不被测试改动', async () => {
  const ctx = await boot();
  try {
    // 认路径但不认方法 → 404（不是 405：统一走 unknown-diary-console-op）。
    const wrongMethod = await consoleRequest(ctx.port, { method: 'POST', pathname: STATUS_PATH, body: {} });
    assert.equal(wrongMethod.status, 404, wrongMethod.text);
    assert.equal(wrongMethod.body.code, 'unknown-diary-console-op');

    // 未定义的 diary 子路径 → 404。
    const unknown = await consoleRequest(ctx.port, { pathname: '/api/diary/whatever' });
    assert.equal(unknown.status, 404);

    // 请求里塞 root / path / stateDir 一律无效：服务端永远用 ROOT。
    const sneaky = await consoleRequest(ctx.port, {
      method: 'POST',
      pathname: CONFIG_PATH,
      body: { root: 'C:/Windows', path: '../../etc', stateDir: '/tmp' },
    });
    assert.equal(sneaky.status, 400, `未知字段应被拒：${sneaky.text}`);
    assert.equal(sneaky.body.code, 'bad-diary-config');

    // 真实仓库里的日记文件不得被测试改动（存在状态 + 字节内容都不变）。
    assertRepoDiaryUntouched('⑨');
  } finally {
    await ctx.close();
  }
});

// ── ⑩ 恢复文案的边界条件（复审 P3-3）+ 量纲文案（P3-10）────────────────────
// 复审实测：`remove()` 之后文件是 0 字节，此时 `restore()` **不产生** `kind:'restore'` 备份
// （store 的 writeBackup 遇到空文件直接跳过，返回 null）—— 也就是说「当前是空的」时
// 恢复没有后悔药可留。控制台两处文案（面板说明 + confirm 弹窗）原来讲得像「恢复总能反悔」，
// 会把用户/模型教错。这里用两层钉住：
//   · 行为层：证实「空文件时恢复不留 restore 备份」，让文案的边界从句有事实依据；
//   · 静态层：两处文案必须都出现这个边界条件，且量纲说明必须说清「含 JSON 外壳」。
const CONSOLE_HTML = fileURLToPath(new URL('../public/console.html', import.meta.url));

test('⑩ 恢复文案边界（空文件恢复不留 restore 备份）+ 1MB 量纲文案，两处都钉住', async () => {
  const ctx = await boot();
  try {
    // 造出「当前文件为空 + 已有历史备份」的状态：write → write(覆盖) → delete。
    await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: '第一版正文' }) });
    await agentRequest(ctx.port, { token: ctx.token, pathname: AGENT_WRITE_PATH, body: agentBody({ which: 'notebook', text: '第二版正文' }) });
    const del = await agentRequest(ctx.port, { token: ctx.token, pathname: '/api/socialV2/diary/delete', body: agentBody({ which: 'notebook' }) });
    assert.equal(del.status, 200, del.text);
    assert.equal(ctx.readDiary('notebook'), '', '删除后文件应为 0 字节');

    const before = await consoleRequest(ctx.port, { pathname: `${BACKUPS_PATH}?which=notebook` });
    const kindsBefore = before.body.backups.map((b) => b.kind).sort();
    assert.deepEqual(kindsBefore, ['delete', 'overwrite'], `前置状态应只有 delete/overwrite：${kindsBefore.join(',')}`);

    // 恢复最早那份（'第一版正文'）：当前文件为空 → 恢复本身**不再**留下 restore 备份。
    const overwriteBackup = before.body.backups.find((b) => b.kind === 'overwrite');
    const restore = await consoleRequest(ctx.port, { method: 'POST', pathname: RESTORE_PATH, body: { which: 'notebook', backupId: overwriteBackup.id } });
    assert.equal(restore.status, 200, restore.text);
    assert.equal(restore.body.ok, true);
    assert.equal(ctx.readDiary('notebook'), '第一版正文', '内容应真的恢复');

    const after = await consoleRequest(ctx.port, { pathname: `${BACKUPS_PATH}?which=notebook` });
    const kindsAfter = after.body.backups.map((b) => b.kind);
    assert.equal(kindsAfter.includes('restore'), false,
      `当前文件为空时恢复不应新增 restore 备份（这正是文案要说明的边界）：${kindsAfter.join(',')}`);
    // 但已存在的历史备份仍在 —— 「空文件恢复没后悔药」不等于「备份被清空」。
    assert.equal(after.body.backups.length, before.body.backups.length,
      '恢复不得删除/新增备份（空文件情形）');

    // 反向对照：当前非空时恢复**会**先备份当前版本（⑤ 已覆盖，这里只锁一行差异）。
    const restore2 = await consoleRequest(ctx.port, { method: 'POST', pathname: RESTORE_PATH, body: { which: 'notebook', backupId: overwriteBackup.id } });
    assert.equal(restore2.status, 200, restore2.text);
    const after2 = await consoleRequest(ctx.port, { pathname: `${BACKUPS_PATH}?which=notebook` });
    assert.ok(after2.body.backups.map((b) => b.kind).includes('restore'),
      '当前非空时恢复应先备份当前版本（与空文件情形相反）');

    // ── 静态层：控制台两处文案必须都写出这个边界条件 ──
    const html = fs.readFileSync(CONSOLE_HTML, 'utf8');
    const panelNote = /恢复会把备份写回原文件([\s\S]{0,400}?)<\/div>/u.exec(html);
    assert.ok(panelNote, '找不到面板说明文案（结构可能被改动）');
    const panelText = panelNote[1];
    assert.match(panelText, /没有内容可备份/u,
      `面板说明必须写出「当前为空时没有内容可备份」这个边界：${panelText}`);
    assert.match(panelText, /跳过/u, `面板说明应说明这一步会被跳过：${panelText}`);
    assert.match(panelText, /通常/u, '面板说明不能再说「总能反悔」，应留出边界（「通常也可以反悔」）');

    const confirmNote = /确定把 \$\{diaryWhichLabel\(which\)\} 恢复到备份 \$\{backupId\}？([\s\S]{0,300}?)`\)\) return;/u.exec(html);
    assert.ok(confirmNote, '找不到 confirm 弹窗文案（结构可能被改动）');
    const confirmText = confirmNote[1];
    assert.match(confirmText, /没有内容可备份/u,
      `confirm 弹窗必须写出同一个边界条件：${confirmText}`);
    assert.match(confirmText, /通常/u, 'confirm 弹窗不能承诺「还能再恢复回来」为绝对');

    // ── 静态层：1MB 量纲（P3-10）—— 必须说清是「含 JSON 外壳的整个请求体」，且只说「约」 ──
    const hintMatch = /id="diaryPayloadHint"[^>]*>([\s\S]{0,400}?)<\/span>/u.exec(html);
    assert.ok(hintMatch, '找不到 diaryPayloadHint 静态文案');
    const hintText = hintMatch[1];
    assert.match(hintText, /JSON 外壳/u, `提示行必须说清量纲（含 JSON 外壳）：${hintText}`);
    assert.match(hintText, /约\s*\d+/u, `正文可用量要给出「约」值：${hintText}`);
    assert.match(hintText, /不是精确契约值/u, '必须声明该数值不是精确契约（外壳长度随字段变化）');
    assert.equal(/999953/u.test(hintText), false,
      '不得把探针测得的 999953 写成硬编码契约数字（外壳长度会变）');

    // JS 动态重建的同一条默认文案也要满足同样要求（否则刷新一次就退回旧说法）。
    const dynHint = /hint\.textContent = `默认 \$\{httpMax\} 字节[^`]*`/u.exec(html);
    assert.ok(dynHint, '找不到 applyDiaryConfigForm 里的动态默认文案');
    assert.match(dynHint[0], /JSON 外壳/u, `动态文案必须同样说清量纲：${dynHint[0]}`);
    assert.match(dynHint[0], /约 \$\{Math\.max\(0, httpMax - 50\)\}/u,
      `动态文案的「约」值必须由 httpMax 推导，不能写死：${dynHint[0]}`);
  } finally {
    await ctx.close();
  }
});

// ── ⑪ 兜底 limits 必须收敛到 HTTP 上限（P3-11）──────────────────────────────
// readDiaryConfig() 的 catch 分支在结构上不可达（DIARY_CONFIG_PATH 恒为合法 join 结果），
// 所以任何**行为级**测试都打不到它 —— 第四轮复审把它改回 `limits:{}`，三套测试全绿。
// 而它恰恰是 P2-4 那类「声明 1000000 / 实际生效 1048576」缺陷的唯一落点：
// 一旦将来有人给 loadDiaryConfig 加新的 throw 条件，这条分支立刻变成活缺陷。
// 因此这里用**源码静态断言**把它钉住（只读 readFileSync，零侵入）。
test('⑪ readDiaryConfig 的 catch 兜底必须显式引用 DIARY_HTTP_MAX_BODY_BYTES（不是 limits:{}）', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../src/bridge.js', import.meta.url)), 'utf8');
  const start = source.indexOf('function readDiaryConfig()');
  assert.ok(start > 0, '必须能定位到 readDiaryConfig()');
  const end = source.indexOf('function diaryConfigSnapshot()', start);
  assert.ok(end > start, '必须能定位到紧邻的 diaryConfigSnapshot()');
  const block = source.slice(start, end);
  assert.ok(block.includes('catch'), '兜底必须在 catch 分支里');

  // 先剥掉行注释再比对：注释里正当地解释了「不要写 limits: {}」，直接扫原文会误伤自己。
  const codeOnly = block.split('\n').map((line) => {
    const at = line.indexOf('//');
    return at < 0 ? line : line.slice(0, at);
  }).join('\n');
  const flat = codeOnly.replace(/\s+/gu, '');

  assert.equal(flat.includes('limits:{}'), false,
    'catch 兜底不得写 limits: {} —— 空对象会一路传到 store，用上它 1048576 的历史默认值');
  assert.ok(flat.includes('limits:{maxPayloadBytes:DIARY_HTTP_MAX_BODY_BYTES}'),
    '兜底必须在 limits 里显式引用 DIARY_HTTP_MAX_BODY_BYTES，不得写死数字');
});
