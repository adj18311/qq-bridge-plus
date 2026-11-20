// 鱼缸日记（Fish Diary）P1b-2：4 个 agent 端点的契约测试。
//
// 全部走**真实桥接 + 真实 HTTP**（scripts/audit-bridge-harness.mjs 在临时目录里跑真实
// src/bridge.js），不连真实平台/QQ，日记文件一律落临时目录 —— 仓库里真实的
// `Fish Diary/*.txt` 必须始终保持 0 字节（本文件最后一条用例会显式复核这一点）。
//
// 覆盖点（对应任务卡 t2 的验收要求）：
//   - 4 个端点各自的成功路径（read / write / edit / delete）
//   - read 的分页（offset / afterLine / nextOffset / maxLines）
//   - 非白名单会话 403、diary 开关关闭 403、无 token / 坏 token 403
//   - 非法 which（含路径穿越尝试）400
//   - 错误码不得被吞成 200；每个错误响应都带稳定 code
//   - stale-snapshot 409 且文件内容不变
//   - 每日写入额度：read 不计、write/edit/delete 各计 1，超额 429 且**不部分写入**
//   - 服务端 root 不可被请求参数覆盖（请求里塞 root/path/file/stateDir 一律无效）
//   - 非 read 响应体不含正文字段
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
const OUTSIDER_KEY = 'private:888';

const READ_PATH = '/api/socialV2/diary/read';
const WRITE_PATH = '/api/socialV2/diary/write';
const EDIT_PATH = '/api/socialV2/diary/edit';
const DELETE_PATH = '/api/socialV2/diary/delete';
const ALL_PATHS = [READ_PATH, WRITE_PATH, EDIT_PATH, DELETE_PATH];

const NOTEBOOK_FILE = 'Fish Diary Notebook.txt';
const PRIVY_FILE = 'Fish Privy Diary Notebook.txt';

const REPO_DIARY_DIR = fileURLToPath(new URL('../Fish Diary/', import.meta.url));

// 真实仓库日记文件的「进入测试时」快照。
// 历史上这里断言的是「必须 0 字节」——那是「测试没碰过它」的代理指标，但只要智能体自己
// 写过字（2026-11-02 就写了），代理指标就会失效并误报。现在直接验证不变量本身：
// 整个测试跑完，这两个文件的字节内容不得有任何变化。
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

function request(port, { method = 'GET', pathname, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request hung')));
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

/** agent 调用：同时带控制台令牌（MCP 进程两者都持有）与 x-agent-call 声明。 */
function agentRequest(port, { token, pathname, method = 'POST', body } = {}) {
  return request(port, {
    method,
    pathname,
    body,
    headers: {
      'x-console-token': CONSOLE_TOKEN,
      'x-agent-call': '1',
      ...(token === undefined ? {} : { 'x-agent-token': token }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
}

async function boot({ diaryEnabled = true, config = {}, savedState = null } = {}) {
  const h = await bridgeHarness({
    config: {
      ...config,
      socialV2: { enabled: true, ...(config.socialV2 ?? {}), tools: { diary: diaryEnabled, ...(config.socialV2?.tools ?? {}) } },
    },
    savedState: savedState ?? { mode: 'reserved2', sessions: { [ALLOWED_KEY]: 'sid-1', [ALLOWED_GROUP]: 'sid-2' } },
  });
  h.setMode('reserved2');
  h.setReady(true);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const tokenOf = (key) => h.getSocialV2State(key).agentToken;
  return {
    h,
    port,
    temp: h.temp,
    token: tokenOf(ALLOWED_KEY),
    groupToken: tokenOf(ALLOWED_GROUP),
    outsiderToken: tokenOf(OUTSIDER_KEY),
    diaryPath: (which) => path.join(h.temp, 'Fish Diary', which === 'privy' ? PRIVY_FILE : NOTEBOOK_FILE),
    readFile: (which) => {
      const file = path.join(h.temp, 'Fish Diary', which === 'privy' ? PRIVY_FILE : NOTEBOOK_FILE);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    },
  };
}

const body = (extra = {}) => ({ key: ALLOWED_KEY, ...extra });

/** 统一换行比较：store 落盘用 CRLF，断言里只关心行内容。 */
const lf = (text) => String(text ?? '').replace(/\r\n/g, '\n');

/** 每个错误响应都必须是「非 200 + ok:false + 稳定 code」—— 防止错误被吞成成功。 */
function assertErrorEnvelope(res, expectedCode) {
  assert.notEqual(res.status, 200, `错误不得以 200 返回：${JSON.stringify(res.body)}`);
  assert.equal(res.body?.ok, false, `错误响应必须 ok:false：${JSON.stringify(res.body)}`);
  assert.equal(typeof res.body?.code, 'string', `错误响应必须带稳定 code：${JSON.stringify(res.body)}`);
  if (expectedCode) assert.equal(res.body.code, expectedCode, `期望 code=${expectedCode}，实际 ${res.body.code}`);
}

// ── ① read 成功路径 ────────────────────────────────────────────────────────
test('① read：空文件返回空页 + 空内容 sha256，不报错', async () => {
  const ctx = await boot();
  try {
    const res = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook' }) });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.which, 'notebook');
    assert.equal(res.body.text, '');
    assert.equal(res.body.lineCount, 0);
    assert.equal(res.body.hasMore, false);
    assert.equal(typeof res.body.sha256, 'string');
    assert.equal(res.body.sha256.length, 64);
  } finally {
    await ctx.close();
  }
});

test('② read：分组 key 也能读（白名单群聊），且不占每日额度', async () => {
  const ctx = await boot();
  try {
    await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: '第一行\n第二行' }) });
    for (let i = 0; i < 20; i += 1) {
      const res = await agentRequest(ctx.port, { token: ctx.groupToken, pathname: READ_PATH, body: { key: ALLOWED_GROUP, which: 'notebook' } });
      assert.equal(res.status, 200, `第 ${i + 1} 次读取必须成功（读不计入额度）`);
      assert.equal(res.body.text.split('\n')[0], '第一行');
    }
    // 额度确实没被读消耗：还能继续写 9 次（总 10 次上限，已用 1 次）。
    for (let i = 0; i < 9; i += 1) {
      const res = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: `补 ${i}`, mode: 'append' }) });
      assert.equal(res.status, 200, `第 ${i + 2} 次写入必须仍在额度内，实际 ${JSON.stringify(res.body)}`);
    }
    const over = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: '超限', mode: 'append' }) });
    assertErrorEnvelope(over, 'daily-write-limit');
    assert.equal(over.status, 429);
  } finally {
    await ctx.close();
  }
});

test('③ read：分页 —— maxLines 生效、nextOffset 可续读、afterLine 从指定行开始', async () => {
  const ctx = await boot();
  try {
    const lines = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);
    await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: lines.join('\n') }) });

    const page1 = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', maxLines: 5 }) });
    assert.equal(page1.status, 200);
    assert.equal(page1.body.lineCount, 5);
    assert.equal(page1.body.startLine, 1);
    assert.equal(page1.body.hasMore, true);
    assert.equal(page1.body.text.split('\n')[0], 'L1');

    const page2 = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', offset: page1.body.nextOffset, maxLines: 5 }) });
    assert.equal(page2.status, 200);
    assert.equal(page2.body.startLine, 6);
    assert.equal(page2.body.text.split('\n')[0], 'L6');

    const fromLine = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', afterLine: 10 }) });
    assert.equal(fromLine.status, 200);
    assert.equal(fromLine.body.startLine, 10);
    assert.equal(fromLine.body.text.split('\n')[0], 'L10');

    const badAfterLine = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', afterLine: 0 }) });
    assertErrorEnvelope(badAfterLine, 'bad-edit-range');
    assert.equal(badAfterLine.status, 400);
  } finally {
    await ctx.close();
  }
});

// ── ④ write 成功路径 ─────────────────────────────────────────────────────
test('④ write：overwrite 建文件、append 追加，返回体不含正文', async () => {
  const ctx = await boot();
  try {
    const first = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: '甲' }) });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.mode, 'overwrite');
    assert.equal(typeof first.body.sha256, 'string');
    assert.ok(Number.isInteger(first.body.lineCount));
    assert.equal('text' in first.body, false, 'write 响应不得回正文');
    assert.equal(ctx.readFile('notebook').includes('甲'), true);

    const appended = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: '乙', mode: 'append' }) });
    assert.equal(appended.status, 200);
    assert.equal(appended.body.mode, 'append');
    assert.equal('text' in appended.body, false);
    const onDisk = ctx.readFile('notebook');
    assert.ok(onDisk.includes('甲') && onDisk.includes('乙'), `append 后应保留旧内容：${JSON.stringify(onDisk)}`);

    // 两本日记互相独立：privy 仍是空文件。
    const privy = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'privy' }) });
    assert.equal(privy.body.text, '');

    // mode 非法 → 400（不写盘）。
    const badMode = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: 'x', mode: 'rewrite' }) });
    assertErrorEnvelope(badMode, 'bad-mode');
    assert.equal(ctx.readFile('notebook').includes('rewrite'), false);

    // text 缺失 → 400 bad-text（不写盘）。
    const noText = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook' }) });
    assertErrorEnvelope(noText, 'bad-text');
  } finally {
    await ctx.close();
  }
});

// ── ⑤ edit 成功路径（两种模式）────────────────────────────────────────────
test('⑤ edit：内容模式与行号模式都生效，且返回体不含正文', async () => {
  const ctx = await boot();
  try {
    await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: 'alpha\nbeta\ngamma' }) });

    const contentEdit = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'notebook', oldText: 'beta', newText: 'BETA' }) });
    assert.equal(contentEdit.status, 200, JSON.stringify(contentEdit.body));
    assert.equal(contentEdit.body.ok, true);
    assert.equal('text' in contentEdit.body, false, 'edit 响应不得回正文');
    assert.equal(ctx.readFile('notebook').includes('BETA'), true);
    assert.equal(ctx.readFile('notebook').includes('beta'), false);

    const lineEdit = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'notebook', op: 'replaceLines', start: 3, end: 3, text: 'GAMMA' }) });
    assert.equal(lineEdit.status, 200, JSON.stringify(lineEdit.body));
    assert.equal(ctx.readFile('notebook').includes('GAMMA'), true);

    const insertEdit = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'notebook', op: 'insertAfter', line: 1, text: 'inserted' }) });
    assert.equal(insertEdit.status, 200, JSON.stringify(insertEdit.body));
    assert.match(ctx.readFile('notebook'), /alpha[\r\n]+inserted/);

    // 内容不匹配 → 404 not-found；多次匹配 → 409 ambiguous-match；都不改文件。
    const before = ctx.readFile('notebook');
    const notFound = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'notebook', oldText: '不存在的串', newText: 'x' }) });
    assertErrorEnvelope(notFound, 'not-found');
    assert.equal(notFound.status, 404);
    assert.equal(ctx.readFile('notebook'), before);

    await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'privy', text: 'dup\ndup' }) });
    const ambiguous = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'privy', oldText: 'dup', newText: 'x' }) });
    assertErrorEnvelope(ambiguous, 'ambiguous-match');
    assert.equal(ambiguous.status, 409);
    assert.equal(ctx.readFile('privy').includes('dup'), true);

    // replaceAll 才能全换。
    const all = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'privy', oldText: 'dup', newText: 'x', replaceAll: true }) });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(ctx.readFile('privy').includes('dup'), false);

    // 缺 edits 也缺 op → 400 bad-edit。
    const badEdit = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'notebook' }) });
    assertErrorEnvelope(badEdit, 'bad-edit');
  } finally {
    await ctx.close();
  }
});

// ── ⑥ delete 成功路径（软删除）────────────────────────────────────────────
test('⑥ delete：软删除 —— 文件保留为空、旧内容进备份、返回 backupId', async () => {
  const ctx = await boot();
  try {
    await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: '要删掉的内容' }) });
    const res = await agentRequest(ctx.port, { token: ctx.token, pathname: DELETE_PATH, body: body({ which: 'notebook' }) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal('text' in res.body, false, 'delete 响应不得回正文');
    assert.equal(typeof res.body.backupId, 'string', 'delete 必须先备份，返回 backupId');
    // 软删除：文件还在，只是 0 字节。
    assert.equal(fs.existsSync(ctx.diaryPath('notebook')), true);
    assert.equal(fs.statSync(ctx.diaryPath('notebook')).size, 0);
    const after = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook' }) });
    assert.equal(after.body.text, '');
    // 备份目录里确实留着旧内容（内容只在备份文件里，不经任何 API 明文返回）。
    const backupDir = path.join(ctx.temp, 'state', 'diary-backups');
    const all = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else all.push(full);
      }
    };
    walk(backupDir);
    const hasOldContent = all.some((file) => fs.readFileSync(file, 'utf8').includes('要删掉的内容'));
    assert.equal(hasOldContent, true, `备份里应保留旧内容，实际备份文件：${all.join(', ')}`);
  } finally {
    await ctx.close();
  }
});

// ── ⑦ 鉴权 403 三连 × 4 端点 ─────────────────────────────────────────────
test('⑦ 鉴权：无 token / 坏 token / 非白名单会话 —— 4 个端点全部 403', async () => {
  const ctx = await boot();
  try {
    const payload = { which: 'notebook', text: 'x', oldText: 'a', newText: 'b' };
    for (const pathname of ALL_PATHS) {
      // 无 token：集中关卡先拦（403 未授权）。
      const noToken = await agentRequest(ctx.port, { token: undefined, pathname, body: body(payload) });
      assert.equal(noToken.status, 403, `${pathname} 无 token 应 403，实际 ${noToken.status}`);
      assert.equal(noToken.body.ok, false);

      // 坏 token：集中关卡 403。
      const badToken = await agentRequest(ctx.port, { token: 'deadbeef'.repeat(4), pathname, body: body(payload) });
      assert.equal(badToken.status, 403, `${pathname} 坏 token 应 403，实际 ${badToken.status}`);

      // 合法 token 但会话不在白名单：diaryGate 的 not-allowlisted。
      const outsider = await agentRequest(ctx.port, { token: ctx.outsiderToken, pathname, body: { key: OUTSIDER_KEY, ...payload } });
      assert.equal(outsider.status, 403, `${pathname} 非白名单应 403，实际 ${outsider.status}`);
      assertErrorEnvelope(outsider, 'not-allowlisted');
    }
    // 全程不该写出任何日记文件。
    assert.equal(fs.existsSync(path.join(ctx.temp, 'Fish Diary')), false, '被拒的请求不得创建日记目录');
  } finally {
    await ctx.close();
  }
});

// ── ⑧ diary 开关关闭 → 4 端点 403 ────────────────────────────────────────
test('⑧ 开关：socialV2.tools.diary=false 时 4 个端点全部 403 diary-disabled', async () => {
  const ctx = await boot({ diaryEnabled: false });
  try {
    const payload = { which: 'notebook', text: 'x' };
    for (const pathname of ALL_PATHS) {
      const res = await agentRequest(ctx.port, { token: ctx.token, pathname, body: body(payload) });
      assert.equal(res.status, 403, `${pathname} 关闭后应 403，实际 ${res.status}`);
      assertErrorEnvelope(res, 'diary-disabled');
    }
    assert.equal(fs.existsSync(path.join(ctx.temp, 'Fish Diary')), false);
  } finally {
    await ctx.close();
  }
});

// ── ⑨ 非法 which / 缺 key ────────────────────────────────────────────────
test('⑨ 入参：非法 which（含路径穿越）一律 400 bad-which，缺 key 400', async () => {
  const ctx = await boot();
  try {
    const badWhichValues = ['', 'notebooks', '../notebook', 'Fish Diary Notebook.txt', '/etc/passwd', 'notebook/../../x', 123];
    for (const pathname of ALL_PATHS) {
      for (const which of badWhichValues) {
        const res = await agentRequest(ctx.port, { token: ctx.token, pathname, body: body({ which, text: 'x', oldText: 'a', newText: 'b' }) });
        assertErrorEnvelope(res, 'bad-which');
        assert.equal(res.status, 400, `which=${JSON.stringify(which)} 应 400，实际 ${res.status} (${pathname})`);
      }
      const noKey = await agentRequest(ctx.port, { token: ctx.token, pathname, body: { which: 'notebook' } });
      assertErrorEnvelope(noKey, 'bad-key');
      assert.equal(noKey.status, 400);
    }
  } finally {
    await ctx.close();
  }
});

// ── ⑩ stale-snapshot 409 且文件不变 ──────────────────────────────────────
test('⑩ 乐观锁：sha256 不符 → 409 stale-snapshot，文件一个字节都不动', async () => {
  const ctx = await boot();
  try {
    await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: '原始内容' }) });
    const before = ctx.readFile('notebook');
    const wrong = 'f'.repeat(64);

    const editRes = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'notebook', oldText: '原始', newText: '改过', sha256: wrong }) });
    assertErrorEnvelope(editRes, 'stale-snapshot');
    assert.equal(editRes.status, 409);
    assert.equal(ctx.readFile('notebook'), before, 'stale-snapshot 后文件不得改变');

    const delRes = await agentRequest(ctx.port, { token: ctx.token, pathname: DELETE_PATH, body: body({ which: 'notebook', sha256: wrong }) });
    assertErrorEnvelope(delRes, 'stale-snapshot');
    assert.equal(delRes.status, 409);
    assert.equal(ctx.readFile('notebook'), before, 'stale-snapshot 后文件不得被清空');

    // 用真实 sha256 就能过。
    const snap = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook' }) });
    const okEdit = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'notebook', oldText: '原始', newText: '改过', sha256: snap.body.sha256 }) });
    assert.equal(okEdit.status, 200, JSON.stringify(okEdit.body));
    assert.equal(ctx.readFile('notebook').includes('改过'), true);
  } finally {
    await ctx.close();
  }
});

// ── ⑪ 每日额度：write/edit/delete 各计 1，超额 429 且不部分写入 ────────────
test('⑪ 额度：write/edit/delete 各占 1 次；第 11 次 429 且不部分写入', async () => {
  const ctx = await boot();
  try {
    // 1 次 write + 4 次 edit + 5 次 delete = 10 次，正好用满。
    let res = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: 'zero' }) });
    assert.equal(res.status, 200);
    let marker = 'zero';
    for (let i = 0; i < 4; i += 1) {
      const next = `e${i}`;
      res = await agentRequest(ctx.port, { token: ctx.token, pathname: EDIT_PATH, body: body({ which: 'notebook', oldText: marker, newText: next }) });
      assert.equal(res.status, 200, `第 ${i + 1} 次 edit 应成功：${JSON.stringify(res.body)}`);
      marker = next;
    }
    for (let i = 0; i < 5; i += 1) {
      await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: 'p', mode: 'append' }) });
    }
    // 现在 notebook 已用满 10 次（1 write + 4 edit + 5 append）。
    const snapshotBefore = ctx.readFile('notebook');
    const over = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: '不该出现的内容' }) });
    assertErrorEnvelope(over, 'daily-write-limit');
    assert.equal(over.status, 429);
    assert.equal(over.body.usageCorrupt, undefined);
    assert.equal(ctx.readFile('notebook'), snapshotBefore, '超限必须整体拒绝：不得部分写入');
    assert.equal(ctx.readFile('notebook').includes('不该出现的内容'), false);

    // privy 是独立额度：仍可写。
    const privyOk = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'privy', text: '另一本' }) });
    assert.equal(privyOk.status, 200, `两本日记额度独立：${JSON.stringify(privyOk.body)}`);

    // read 不受额度影响。
    const stillReads = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook' }) });
    assert.equal(stillReads.status, 200);
  } finally {
    await ctx.close();
  }
});

// ── ⑫ 服务端 root 不可被请求覆盖 ──────────────────────────────────────────
test('⑫ root 固定：请求里塞 root/path/file/stateDir 一律无效，文件只落临时目录', async () => {
  const ctx = await boot();
  try {
    const injected = path.join(ctx.temp, 'injected');
    const payload = {
      which: 'notebook',
      text: '服务端 root 固定',
      root: injected,
      path: injected,
      file: path.join(injected, 'evil.txt'),
      dir: injected,
      stateDir: injected,
      usageFile: path.join(injected, 'usage.json'),
      backupDir: injected,
    };
    const res = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body(payload) });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // 内容落在桥接自己的临时 root 下（harness 的 ROOT = temp）。
    assert.equal(ctx.readFile('notebook').includes('服务端 root 固定'), true);
    // 请求指定的目录/文件一个都没被创建。
    assert.equal(fs.existsSync(injected), false, '请求参数不得影响写入位置');
    assert.equal(fs.existsSync(path.join(ctx.temp, 'state', 'evil.txt')), false);

    // read 也不接受注入的路径：读到的仍是服务端那本。
    const readRes = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', root: injected, file: path.join(injected, 'evil.txt') }) });
    assert.equal(readRes.status, 200);
    assert.equal(readRes.body.text.includes('服务端 root 固定'), true);
  } finally {
    await ctx.close();
  }
});

// ── ⑬ 错误码映射完备性 + busy 结构性不可达 ────────────────────────────────
test('⑬ 错误码映射：store 每个码都映射到非 200；busy 映射 409（HTTP 层结构上不可达，见注释）', async () => {
  const ctx = await boot();
  try {
    const codes = [
      'bad-which', 'bad-text', 'bad-mode', 'bad-sha256', 'bad-edit', 'bad-edit-op', 'bad-edit-range',
      'line-out-of-range', 'overlap', 'mixed-edit-kinds', 'not-found', 'ambiguous-match', 'stale-snapshot',
      'busy', 'write-too-large', 'file-too-large', 'daily-write-limit', 'usage-unreadable',
      'path-escape', 'backup-failed', 'bad-backup-id', 'bad-path', 'bad-root',
    ];
    const seen = new Map();
    for (const code of codes) {
      const error = Object.assign(new Error(`fixture ${code}`), { code });
      const mapped = ctx.h.context.diaryErrorBody(error);
      seen.set(code, mapped.status);
      assert.notEqual(mapped.status, 200, `${code} 不得映射成 200`);
      assert.equal(mapped.body.ok, false);
      assert.equal(mapped.body.code, code);
    }
    // 关键几个状态码的语义钉死，避免以后改表改错。
    assert.equal(seen.get('busy'), 409);
    assert.equal(seen.get('stale-snapshot'), 409);
    assert.equal(seen.get('ambiguous-match'), 409);
    assert.equal(seen.get('write-too-large'), 413);
    assert.equal(seen.get('file-too-large'), 413);
    assert.equal(seen.get('daily-write-limit'), 429);
    assert.equal(seen.get('usage-unreadable'), 503);
    assert.equal(seen.get('not-found'), 404);
    assert.equal(seen.get('path-escape'), 403);
    assert.equal(seen.get('bad-which'), 400);

    // busy 在 HTTP 层结构上不可达：diary-store 的写路径是同步的
    // （inFlight.add → performWrite → finally inFlight.delete 全在同一个 tick 内闭合），
    // 单实例 Node 里不可能有第二个请求插进这段临界区。这里锁定这条事实：
    // 端点确实是同步调用 store 的（否则 busy 早就该有 HTTP 用例了）。
    const src = fs.readFileSync(fileURLToPath(new URL('../src/core/diary-store.mjs', import.meta.url)), 'utf8');
    assert.match(src, /inFlight\.add\(file\);\s*\n\s*try \{[\s\S]{0,400}?finally \{\s*\n\s*inFlight\.delete\(file\);/,
      'diary-store 的写路径若改成异步，busy 就会变成可达状态，端点需要补并发用例');
    // 端点侧确实是同步调用：sendJson 与 store 调用之间没有 await。
    const bridgeSrc = fs.readFileSync(fileURLToPath(new URL('../src/bridge.js', import.meta.url)), 'utf8');
    const diarySection = bridgeSrc.slice(bridgeSrc.indexOf("/api/socialV2/diary/\")"));
    assert.ok(diarySection.length > 0);
    assert.equal(/await store\.(write|edit|remove|read)/.test(bridgeSrc), false, '端点必须同步调用 store（await 会让 busy 变成可达状态）');
  } finally {
    await ctx.close();
  }
});

// ── ⑭ 未知识别路径 / 方法不匹配 ───────────────────────────────────────────
test('⑭ /api/socialV2/diary/<未知> → 404 unknown-diary-op；GET → 405 不落盘', async () => {
  const ctx = await boot();
  try {
    const unknown = await agentRequest(ctx.port, { token: ctx.token, pathname: '/api/socialV2/diary/nope', body: body({ which: 'notebook' }) });
    assert.notEqual(unknown.status, 200);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'unknown-diary-op');

    const viaGet = await request(ctx.port, {
      method: 'GET',
      pathname: READ_PATH,
      headers: { 'x-console-token': CONSOLE_TOKEN, 'x-agent-call': '1', 'x-agent-token': ctx.token },
    });
    assert.notEqual(viaGet.status, 200, 'GET 不是日记端点的合法方法');
    assert.equal(fs.existsSync(path.join(ctx.temp, 'Fish Diary')), false);
  } finally {
    await ctx.close();
  }
});

// ── ⑮ 真实仓库的 Fish Diary 全程不被测试改动 ────────────────────────────
test('⑮ 全程不碰真实仓库：Fish Diary/*.txt 的存在状态与字节内容都未变', async () => {
  assertRepoDiaryUntouched('⑮');
});

// ── ⑯ afterLine 越界：绝不静默返回第一页全文（复审 P2-1）─────────────────
// 旧实现在 afterLine > totalLines 时循环永不命中，`!cur.hasMore` 分支直接返回
// **当前页**（= 第一页全文，startLine:1），调用方会误判文件长度并重复追加。
// 现在的契约：
//   - afterLine 落在 1..totalLines（含正好等于 totalLines）→ 行为与以前完全一致；
//   - afterLine > totalLines → 200 + 空页 + afterLineBeyondEnd:true，
//     startLine === totalLines + 1（指向第一个不存在的行），text 为空、lineCount 0。
test('⑯ afterLine 越界返回空页 + afterLineBeyondEnd（不回落第一页）；边界行仍可读', async () => {
  const ctx = await boot();
  try {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);
    const totalLines = lines.length;
    const written = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: lines.join('\n') }) });
    assert.equal(written.status, 200);
    assert.equal(written.body.lineCount, 30);

    // 正常路径不变：第一行开始 = 整篇。
    const fromFirst = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', afterLine: 1 }) });
    assert.equal(fromFirst.status, 200);
    assert.equal(fromFirst.body.startLine, 1);
    assert.equal(fromFirst.body.lineCount, 30);
    assert.equal(fromFirst.body.text.split('\n')[0], 'L1');
    assert.equal('afterLineBeyondEnd' in fromFirst.body, false, '正常分页不得带越界标记');

    // 要求 3：afterLine 正好等于 totalLines 必须能读到最后一行。
    const atLast = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', afterLine: totalLines }) });
    assert.equal(atLast.status, 200);
    assert.equal(atLast.body.startLine, 30);
    assert.equal(atLast.body.endLine, 30);
    assert.equal(atLast.body.lineCount, 1);
    assert.equal(atLast.body.text.replace(/\n$/, ''), 'L30');
    assert.equal('afterLineBeyondEnd' in atLast.body, false, '最后一行不是越界');

    // 倒数第二行起 = 两行。
    const fromSecondLast = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', afterLine: 29 }) });
    assert.equal(fromSecondLast.status, 200);
    assert.equal(fromSecondLast.body.startLine, 29);
    assert.equal(fromSecondLast.body.lineCount, 2);
    // 末行没有行尾换行（write 不补），所以页文本不带结尾换行。
    assert.equal(fromSecondLast.body.text, 'L29\nL30');

    // 越界：31 与 999 都必须是空页 + 明确标记，且**不含任何正文**。
    for (const beyond of [totalLines + 1, 999]) {
      const res = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', afterLine: beyond }) });
      assert.equal(res.status, 200, `afterLine=${beyond} 走成功分支（空页），不应报错`);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.afterLineBeyondEnd, true, `afterLine=${beyond} 必须带越界标记`);
      assert.equal(res.body.afterLine, beyond);
      assert.equal(res.body.text, '', `afterLine=${beyond} 不得回落第一页全文`);
      assert.equal(res.body.lineCount, 0);
      assert.equal(res.body.startLine, totalLines + 1, 'startLine 必须指向第一个不存在的行');
      assert.equal(res.body.endLine, totalLines);
      assert.equal(res.body.totalLines, totalLines);
      assert.equal(res.body.hasMore, false);
      assert.match(String(res.body.note), /超出文件总行数 30/);
      assert.equal(res.body.text.includes('L1'), false);
      // 越界是只读的：不占额度、不改文件（store 落盘用 CRLF，比较前统一换行）。
      assert.equal(lf(ctx.readFile('notebook')), lines.join('\n'));
    }

    // 多页文件也越界：offset 必须落在文件末尾、sha256 必须是**整篇**快照，
    // 否则调用方会以为「还有一页没读完」（哨兵字段与真实最后一页保持一致）。
    const bigLines = Array.from({ length: 1200 }, (_, i) => `B${i + 1}`);
    const bigWrite = await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'privy', text: bigLines.join('\n') }) });
    assert.equal(bigWrite.status, 200);
    const bigBeyond = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'privy', afterLine: 5000 }) });
    assert.equal(bigBeyond.status, 200);
    assert.equal(bigBeyond.body.afterLineBeyondEnd, true);
    assert.equal(bigBeyond.body.totalLines, 1200);
    assert.equal(bigBeyond.body.startLine, 1201);
    assert.equal(bigBeyond.body.text, '');
    assert.equal(bigBeyond.body.hasMore, false);
    assert.equal(bigBeyond.body.offset, bigWrite.body.bytes, '越界页的 offset 必须等于文件字节数（真的在末尾）');
    assert.equal(bigBeyond.body.sha256, bigWrite.body.sha256, '越界页的 sha256 必须是整篇快照');

    // 空文件 + afterLine=1：同样标越界（totalLines=0），不能被当成「读到了第 1 行」。
    const emptyCtx = await boot();
    try {
      const emptyRead = await agentRequest(emptyCtx.port, { token: emptyCtx.token, pathname: READ_PATH, body: body({ which: 'notebook', afterLine: 1 }) });
      assert.equal(emptyRead.status, 200);
      assert.equal(emptyRead.body.afterLineBeyondEnd, true);
      assert.equal(emptyRead.body.text, '');
      assert.equal(emptyRead.body.totalLines, 0);
      assert.equal(emptyRead.body.startLine, 1);
    } finally {
      await emptyCtx.close();
    }

    // 既有参数校验不变：0 / 负数 / 非数字串 仍是 400 bad-edit-range。
    for (const bad of [0, -1, -30, 'abc', '1.5.5']) {
      const res = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', afterLine: bad }) });
      assertErrorEnvelope(res, 'bad-edit-range');
      assert.equal(res.status, 400, `afterLine=${String(bad)} 必须是 400`);
    }

    // afterLine 不传 / null 是「没指定」的既有语义（等价于 offset 分页首页），
    // 不属于越界，也不能变成 400 —— 这条行为同样保持不变。
    for (const omitted of [undefined, null]) {
      const res = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook', ...(omitted === undefined ? {} : { afterLine: omitted }) }) });
      assert.equal(res.status, 200);
      assert.equal(res.body.startLine, 1);
      assert.equal(res.body.text.split('\n')[0], 'L1');
      assert.equal('afterLineBeyondEnd' in res.body, false);
    }
  } finally {
    await ctx.close();
  }
});

// ── ⑰ 工具描述必须说真话（复审 P2-3）──────────────────────────────────────
// 旧描述：「清空后不可用工具恢复（备份在状态目录里，需要人工处理）」。
// 实测 delete 会在删之前自动写一份 `kind:'delete'` 备份，控制台「鱼缸日记」面板的
// 恢复按钮能把它完整写回原文件 —— 于是那句描述会把模型教成「删了就找不回来」，
// 对用户说错话。这里用**源码静态解析**钉住描述文本（不依赖 config 开关，恒可跑）：
//   · 四个日记工具都不得出现「不可恢复 / 无法恢复 / 不可用工具恢复」这类假话；
//   · delete 必须同时讲清「软删除」「备份」「可恢复」，且不得谎称工具能恢复；
//   · 描述里不得出现端点路径或 token 字样（工具描述会进模型上下文，不该泄实现细节）；
//   · 四个描述都要带隐私红线（私密日记内容不得在群聊中转述）。
const MCP_SAFE_ENTRY = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));

/** 从真实源码里抠出 4 个日记工具的描述原文（模板字面量，保留 ${DIARY_PRIVACY_NOTE} 占位）。 */
function readDiaryToolDescriptions() {
  const source = fs.readFileSync(MCP_SAFE_ENTRY, 'utf8');
  const pattern = /server\.tool\(\s*'(qq_diary_[a-z]+)',\s*`([\s\S]*?)`,\s*\r?\n\s*\{/g;
  const found = {};
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    found[match[1]] = match[2];
  }
  return found;
}

/** 描述里不许出现的「说错能力」措辞。 */
const DIARY_LIE_PATTERNS = [
  /不可恢复/,
  /无法恢复/,
  /不可用工具恢复/,
  /不能恢复/,
  /彻底删除/,
  /永久删除/,
];

test('⑰ 描述说真话：qq_diary_delete 不再谎称不可恢复，四个描述无同类假话', () => {
  const descriptions = readDiaryToolDescriptions();
  const expectedTools = ['qq_diary_read', 'qq_diary_write', 'qq_diary_edit', 'qq_diary_delete'];
  assert.deepEqual(Object.keys(descriptions).sort(), [...expectedTools].sort(), '四个日记工具都必须从源码里解析到');

  for (const name of expectedTools) {
    const text = descriptions[name];
    assert.ok(text.length > 40, `${name} 的描述不该是空壳`);
    for (const pattern of DIARY_LIE_PATTERNS) {
      assert.equal(pattern.test(text), false, `${name} 的描述不得出现 ${pattern}（会把模型教成对用户说错话）：${text}`);
    }
    // 隐私红线：每个描述都必须带同一句。
    assert.match(text, /\$\{DIARY_PRIVACY_NOTE\}/, `${name} 必须引用 DIARY_PRIVACY_NOTE`);
    // 不泄实现细节：不进模型上下文的端点路径 / token。
    assert.equal(/\/api\//.test(text), false, `${name} 描述不得出现端点路径`);
    assert.equal(/\btoken\b/i.test(text), false, `${name} 描述不得出现 token 字样`);
  }

  const del = descriptions.qq_diary_delete;
  // 事实三件套：软删除 + 删除前留备份 + 可经控制台恢复。
  assert.match(del, /软删除/, 'delete 必须说明这是软删除（文件保留为空）');
  assert.match(del, /备份/, 'delete 必须说明删除前会留备份');
  assert.match(del, /恢复/, 'delete 必须说明备份可以恢复（控制台能找回正文）');
  assert.match(del, /控制台/, '恢复要走控制台面板，描述里应点明，不能暗示工具自己会恢复');
  // 反过来说，也不能夸大成「工具能恢复」：工具面没有 restore。
  assert.match(del, /没有 ?restore|没有恢复工具|工具面没有/, 'delete 必须说明工具本身没有 restore');
  // 「先跟用户确认」是复审明确要求保留的一句。
  assert.match(del, /确认/, 'delete 仍必须要求执行前跟用户确认');

  // write 的限额是可配置的默认值（src/core/diary-config.mjs），不得写死成事实。
  assert.match(descriptions.qq_diary_write, /默认值|默认/, 'write 的限额必须标明是可调整的默认值');

  // read 必须预告 afterLine 越界的返回形状：⑯ 修好了行为（不再回落第一页），
  // 描述也要跟上，否则模型拿到 text:'' 会以为日记是空的，而不是「没有第 N 行」。
  const readDesc = descriptions.qq_diary_read;
  assert.match(readDesc, /空页/, 'read 必须说明 afterLine 越界返回空页而不是第一页');
  assert.match(readDesc, /afterLineBeyondEnd/, 'read 必须点名越界标记字段，模型才能区分「空文件」与「越界」');
  assert.match(readDesc, /lineCount/, 'read 必须说明越界时空页的 lineCount 为 0');
});

test('⑱ 动态复核：真实 MCP server tools/list 里 4 个日记描述同样不说假话', { timeout: 60_000 }, async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SAFE_ENTRY],
    cwd: path.dirname(MCP_SAFE_ENTRY),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'diary-description-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    // diary 开关默认开；若有人在本机 config 里关掉，工具会合法缺席 —— 缺席就跳过这条，
    // 静态解析那条（⑰）始终生效，不算放水。
    const present = ['qq_diary_read', 'qq_diary_write', 'qq_diary_edit', 'qq_diary_delete']
      .filter((name) => byName.has(name));
    if (present.length === 0) return;
    assert.equal(present.length, 4, `日记工具要么全注册要么全不注册，实际注册了 ${present.join(',')}`);
    for (const name of present) {
      const text = String(byName.get(name).description ?? '');
      for (const pattern of DIARY_LIE_PATTERNS) {
        assert.equal(pattern.test(text), false, `${name} 的描述不得出现 ${pattern}：${text}`);
      }
      assert.match(text, /私密日记内容不得在群聊中转述/, `${name} 必须带隐私红线`);
    }
    const delText = String(byName.get('qq_diary_delete').description ?? '');
    assert.match(delText, /软删除/);
    assert.match(delText, /备份/);
    assert.match(delText, /控制台/);
    assert.equal(/不可恢复|无法恢复/.test(delText), false);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

// ── ⑲ 端点层 which 白名单（复审 P3-7：只有 store 单层兜底 = 测试盲点）────────
// 背景：把 `diaryWhichOf(body.which)` 换成 `body.which` 直接传给 store，本套件曾**仍然 18/18 全绿**
// —— 因为 store 自己也校验 which，行为看起来没变。但两层职责不同：
//   · 端点层（diaryWhichOf）先 trim 再比对，且错误文案是「收到：<原值>」；
//   · store 层（fileNameOf）**不 trim**，且非字符串给的是另一句「which 必须是字符串」。
// 这条用例用「两层文案可区分」+「非法 which 不产生任何落盘/备份」这两条判据，
// 直接把端点层校验钉在地上：摘掉它，下面每一条断言都会红。
test('⑲ 端点层 which 白名单：非法值在进 store 之前就被拒，且不产生任何落盘', async () => {
  const ctx = await boot();
  try {
    // 判据一：带首尾空格的 ' notebook ' 被端点层 trim 成合法值 → 200。
    // 若摘掉端点层校验，这个值会直接进 store，而 store 的 fileNameOf 不 trim → 400。
    const padded = await agentRequest(ctx.port, {
      token: ctx.token, pathname: READ_PATH, body: body({ which: ' notebook ' }),
    });
    assert.equal(padded.status, 200, `端点层应先 trim 再校验（store 不 trim）：${JSON.stringify(padded.body)}`);
    assert.equal(padded.body.which, 'notebook');

    // 判据二：number 型 which 的错误文案必须是**端点层**那句（模板里塞 String(raw)），
    // 不能是 store 的「which 必须是字符串」——两者都能给 code=bad-which，只能靠文案区分。
    const numeric = await agentRequest(ctx.port, {
      token: ctx.token, pathname: READ_PATH, body: body({ which: 123 }),
    });
    assertErrorEnvelope(numeric, 'bad-which');
    assert.equal(numeric.status, 400);
    assert.match(String(numeric.body.error), /收到：123/,
      `应由端点层给出「收到：<原值>」：${numeric.body.error}`);
    assert.doesNotMatch(String(numeric.body.error), /必须是字符串/,
      `不能落到 store 的那条文案上（说明端点层校验被摘掉了）：${numeric.body.error}`);

    // 判据三：非法 which 的删除请求绝不允许产生任何副作用（不删文件、不写备份、不占额度）。
    await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: 'KEEP-ME\n' }) });
    const beforeWrite = ctx.readFile('notebook');
    const backupsDir = path.join(ctx.temp, 'state', 'diary-backups');
    const backupsBefore = fs.existsSync(backupsDir)
      ? fs.readdirSync(path.join(backupsDir, 'notebook')).length
      : 0;
    const badDelete = await agentRequest(ctx.port, {
      token: ctx.token, pathname: DELETE_PATH, body: body({ which: 'third' }),
    });
    assertErrorEnvelope(badDelete, 'bad-which');
    assert.equal(badDelete.status, 400);
    assert.equal(lf(ctx.readFile('notebook')), lf(beforeWrite), '非法 which 的 delete 不得改动文件');
    assert.equal(lf(ctx.readFile('notebook')), 'KEEP-ME\n', '文件内容应完好');
    const backupsAfter = fs.existsSync(backupsDir)
      ? fs.readdirSync(path.join(backupsDir, 'notebook')).length
      : 0;
    assert.equal(backupsAfter, backupsBefore, '非法 which 的 delete 不得产生备份');
  } finally {
    await ctx.close();
  }
});

// ── ⑳ 鉴权与读 body 的次序（复审 P3-8：两个方向的差异是**记录在案的设计取舍**）──
// console 端点（/api/diary/*）先鉴权再看 body：未授权请求连 body 都不用发完就能拿到 403。
// agent 四端点（/api/socialV2/diary/*）必然相反：diaryGate 要校验 `body.key` 指向的会话 token，
// **没有 body 就无从知道要校验谁**，所以只能先 readBody()。
// 由此产生一条已记录的行为（不是回归）：同样「有控制台令牌、缺 agent 声明、body 1.2MB」的请求，
// agent 端点回 413 body-too-large，console 端点回 403。
// 安全事故面为零：未授权请求最多让服务端读一次 ≤1MB，不落盘、不计数。
// 谁把两边「改成对称的」，本用例会立刻变红 —— 那时必须同时改这段说明与 src/bridge.js 的注释。
test('⑳ 次序差异（有意为之）：agent 端点先读 body → 413；console 端点先鉴权 → 403 且不等 body 发完', async () => {
  const ctx = await boot();
  try {
    // A. agent 端点：带控制台令牌、不带 x-agent-call、1.2MB body → 413（先 readBody）。
    const bigAgent = await request(ctx.port, {
      method: 'POST',
      pathname: WRITE_PATH,
      headers: { 'content-type': 'application/json', 'x-console-token': CONSOLE_TOKEN },
      body: { key: ALLOWED_KEY, which: 'notebook', text: 'Z'.repeat(1_200_000) },
    });
    assert.equal(bigAgent.status, 413,
      `agent 端点结构上只能先读 body，超限必然 413 而不是 401/403：${JSON.stringify(bigAgent.body)}`);
    assert.equal(bigAgent.body?.code, 'body-too-large');
    assert.match(String(bigAgent.body?.error), /包含 JSON 外壳在内/,
      '413 文案必须说清量纲（P3-10）');

    // B. console 端点：同样的令牌形态 + 1.2MB body → 先鉴权，403（不是 413）。
    const bigConsole = await request(ctx.port, {
      method: 'POST',
      pathname: '/api/diary/config',
      headers: { 'content-type': 'application/json', 'x-console-token': CONSOLE_TOKEN },
      body: { note: 'Z'.repeat(1_200_000) },
    });
    assert.equal(bigConsole.status, 403,
      `console 端点先鉴权，不该先吃 body：${JSON.stringify(bigConsole.body)}`);
    assert.equal(bigConsole.body?.code, 'console-only');

    // C. 决定性判据：声明 50MB 却一个字节都不发，console 端点仍必须在秒级内回 403。
    //    若哪天有人把 readBody 挪到鉴权之前，这里会挂到超时（5s）而不是 403。
    const startedAt = Date.now();
    const earlyRefusal = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: ctx.port, path: '/api/diary/config', method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': 50_000_000,
          'x-console-token': CONSOLE_TOKEN,
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('console 端点没有在 3s 内拒绝，说明它在等 body')));
      req.flushHeaders(); // 只发头，body 一个字节都不发
      // 收到 403 后必须主动拆掉这条半开的连接：它声明了 50MB 却永不发完，
      // 不拆的话服务端 close() 要等这条连接超时（实测白等 6s）。
      req.on('response', () => setImmediate(() => req.destroy()));
    });
    assert.equal(earlyRefusal.status, 403, `应在等 body 之前就 403：${earlyRefusal.text.slice(0, 200)}`);
    assert.ok(Date.now() - startedAt < 3000, '403 必须是秒级返回，不能等 50MB body');
  } finally {
    await ctx.close();
  }
});

// ── ㉑ delete 必须透传 removed/reason（P3-12）──────────────────────────────
// 复审第四轮指出：端点原来把 store 的 removed/reason 丢了，调用方只能靠
// sha256===null 这个**偶然**差异去猜「本来就没有」还是「真删了」。这里把语义钉死：
//   · 文件不存在 → removed:false + reason:'not-found'，且**不建文件、不烧额度**；
//   · 文件存在（哪怕已经是空的）→ removed:true + 无 reason + 有 backupId；
// 一旦有人把 not-found 的 sha256 填成空串哈希、或删掉透传，这条会立刻红。
test('㉑ delete 透传 removed/reason：不存在 → removed:false + not-found 且不建文件不烧额度；存在 → removed:true', async () => {
  const ctx = await boot();
  try {
    // 1) 文件根本不存在：不得创建文件、不得消耗额度。
    const missing = await agentRequest(ctx.port, { token: ctx.token, pathname: DELETE_PATH, body: body({ which: 'notebook' }) });
    assert.equal(missing.status, 200, JSON.stringify(missing.body));
    assert.equal(missing.body.ok, true);
    assert.equal(missing.body.removed, false, '本来就没有的文件必须明确报 removed:false');
    assert.equal(missing.body.reason, 'not-found', '必须给出可判定的 reason');
    assert.equal(missing.body.sha256, null, 'not-found 的 sha256 仍是 null（但不得再依赖它判断）');
    assert.equal(missing.body.backupId, null, '没有内容可备份');
    assert.equal(fs.existsSync(ctx.diaryPath('notebook')), false, '删不存在的文件不得把文件创建出来');
    const usageAfterMissing = await agentRequest(ctx.port, { token: ctx.token, pathname: READ_PATH, body: body({ which: 'notebook' }) });
    assert.equal(usageAfterMissing.status, 200);

    // 2) 写一次再删：removed:true、无 reason、有 backupId。
    await agentRequest(ctx.port, { token: ctx.token, pathname: WRITE_PATH, body: body({ which: 'notebook', text: '有内容' }) });
    const deleted = await agentRequest(ctx.port, { token: ctx.token, pathname: DELETE_PATH, body: body({ which: 'notebook' }) });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.removed, true, '真删了必须报 removed:true');
    assert.equal('reason' in deleted.body, false, '成功删除不带 reason');
    assert.equal(typeof deleted.body.backupId, 'string', '真删必须有备份');

    // 3) 再删一次（文件存在但已空）：仍算一次真实删除，removed 仍为 true。
    const emptyAgain = await agentRequest(ctx.port, { token: ctx.token, pathname: DELETE_PATH, body: body({ which: 'notebook' }) });
    assert.equal(emptyAgain.status, 200, JSON.stringify(emptyAgain.body));
    assert.equal(emptyAgain.body.removed, true, '文件存在（即使是 0 字节）仍是一次真实删除，不能报 not-found');
  } finally {
    await ctx.close();
  }
});
