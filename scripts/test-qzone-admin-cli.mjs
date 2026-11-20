// 任务卡 §6「本地管理员脚本作为备用恢复入口」—— 可执行入口的行为测试。
//
// 这些用例调用 CLI 的 `main(argv, {stdout, stderr})`，不 spawn 进程：这样能精确断言
// **退出码**与输出，也能在同一个进程里立刻回读数据库，确认「到底写没写」。
// 存储全部是真实临时 SQLite（每个用例一个 %TEMP% 目录，结束即删），不碰 state/。
//
// 关键设计：每条断言都从**非默认值**出发（accessPaused:true / used.post:3 …），
// 否则「恢复后是 false」「重置后是 0」这类断言在空状态上会假绿。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { main, EXIT, __TEST_ONLY_EXPORT_AUDIT_ID } from './qzone-admin-cli.mjs';

const TARGET = '9876543210';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-admincli-'));
  return {
    dir,
    dbPath: path.join(dir, 'state.db'),
    cleanup() {
      for (let i = 0; i < 20; i += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
      }
    },
  };
}

/** 一个「两层都暂停、配额都非零」的状态：任何重置/恢复都能看出差别。 */
function seedState(over = {}) {
  return {
    botQq: TARGET,
    selfId: TARGET,
    enabled: true,
    readAllowed: true,
    writeAllowed: true,
    accessPaused: true,
    writePaused: true,
    pauseCycles: { access: null, write: null },
    reads: 3,
    writes: 3,
    probe: 'manual_only',
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 },
    ledger: { day: '2026-11-12', used: { post: 3, comment: 8, like: 9 }, reservations: { kept: 'post' } },
    lastPostAt: null,
    lastCommentAt: null,
    commentTargets: [],
    likes: [],
    audit: [],
    ...over,
  };
}

function world(over = {}) {
  const t = tempDb();
  const store = openOfflineStore(t.dbPath, seedState(over));
  store.close();
  return {
    t,
    dbPath: t.dbPath,
    read() {
      const s = openOfflineStore(t.dbPath, { audit: [] });
      try { return s.read(); } finally { s.close(); }
    },
    close() { t.cleanup(); },
  };
}

/** 跑一次 CLI，收集 stdout/stderr 与退出码。 */
async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
  });
  return { code, out, err };
}

/** 断言「输出里有这一行」。 */
const hasLine = (out, key, value) => {
  assert.ok(out.includes(`${key}: ${value}\n`), `输出里必须有 ${key}: ${value}，实际：\n${out}`);
};

// ══════════════════════════════════════════════════════════════════════════════════════
// 1. status：只读展示
// ══════════════════════════════════════════════════════════════════════════════════════

test('CLI-1 status 只读展示 accessPaused/writePaused/ledger.used/ledger.day/probe，且零落盘', async () => {
  const w = world();
  try {
    const before = w.read();
    const { code, out, err } = await run(['status', '--db', w.dbPath]);

    assert.equal(code, EXIT.OK, `status 必须成功，stderr=${err}`);
    assert.equal(err, '', 'status 不应往 stderr 写东西');

    hasLine(out, 'accessPaused', true);
    hasLine(out, 'writePaused', true);
    hasLine(out, 'pauseScope', 'both');
    hasLine(out, 'probe', 'manual_only');
    hasLine(out, 'ledger.day', '2026-11-12');
    hasLine(out, 'ledger.used.post', 3);
    hasLine(out, 'ledger.used.comment', 8);
    hasLine(out, 'ledger.used.like', 9);

    // 零落盘：状态逐字段相同，审计也没有多出任何一行。
    const after = w.read();
    assert.deepEqual(after, before, 'status 前后状态必须完全一致');
    assert.equal(after.audit.length, 0, 'status 不得写审计');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 2. restore --layer both：两层都解除，配额不变
// ══════════════════════════════════════════════════════════════════════════════════════

test('CLI-2 restore --layer both：两层暂停都解除，ledger.used 一点不动（恢复不重置配额）', async () => {
  const w = world();
  try {
    const before = w.read();
    assert.equal(before.accessPaused, true, '前提：access 层确实暂停');
    assert.equal(before.writePaused, true, '前提：write 层确实暂停');
    assert.deepEqual(before.ledger.used, { post: 3, comment: 8, like: 9 }, '前提：配额非零');

    const { code, out, err } = await run(['restore', '--db', w.dbPath, '--layer', 'both',
      '--operator', 'ops-1', '--reason', 'network']);
    assert.equal(code, EXIT.OK, `restore both 必须成功，stderr=${err}`);
    hasLine(out, 'result', 'ok');

    const after = w.read();
    assert.equal(after.accessPaused, false, 'access 层必须解除');
    assert.equal(after.writePaused, false, 'write 层必须解除');
    assert.deepEqual(after.ledger.used, before.ledger.used,
      '恢复暂停不得重置当日配额（任务卡 §6：恢复暂停不重置已有配额）');
    assert.equal(after.ledger.day, before.ledger.day, '恢复不得改动账本日期');
    assert.deepEqual(after.ledger.reservations, before.ledger.reservations, '恢复不得改动预留表');

    // 恰好一条审计，且是 admin_script 来源。
    assert.equal(after.audit.length, 1, '一次成功恢复 = 一条审计');
    const record = after.audit[0].record;
    assert.equal(record.source, 'admin_script', '本地脚本入口的审计来源必须是 admin_script');
    assert.equal(record.action, 'restore');
    assert.equal(record.operator, 'ops-1');
    assert.equal(record.result, 'success');
    assert.equal(record.pauseScope, 'both', 'pauseScope 取执行前的真实状态');
    assert.ok(Number.isFinite(record.time), '审计必须带时间');
  } finally { w.close(); }
});

test('CLI-2b restore --layer access 只解除 access 层，write 层保持暂停', async () => {
  const w = world();
  try {
    const { code, err } = await run(['restore', '--db', w.dbPath, '--layer', 'access', '--operator', 'ops-2']);
    assert.equal(code, EXIT.OK, `stderr=${err}`);
    const after = w.read();
    assert.equal(after.accessPaused, false);
    assert.equal(after.writePaused, true, '只恢复 access 时 write 层必须仍然是暂停');
    assert.equal(after.audit.length, 1);
    assert.equal(after.audit[0].record.content.includes('"selection":"access"'), true,
      '审计内容必须记录本次选择的是哪一层');
  } finally { w.close(); }
});

test('CLI-2c restore --layer write 只解除 write 层，access 层保持暂停', async () => {
  const w = world();
  try {
    const { code, err } = await run(['restore', '--db', w.dbPath, '--layer', 'write', '--operator', 'ops-3']);
    assert.equal(code, EXIT.OK, `stderr=${err}`);
    const after = w.read();
    assert.equal(after.accessPaused, true, '只恢复 write 时 access 层必须仍然是暂停');
    assert.equal(after.writePaused, false);
    assert.equal(after.audit.length, 1);
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 3. reset-quota：只有指定 kind 归零
// ══════════════════════════════════════════════════════════════════════════════════════

test('CLI-3 reset-quota --kind comment：只有 comment 归零，post/like/day/预留表都不动', async () => {
  const w = world();
  try {
    const before = w.read();
    assert.deepEqual(before.ledger.used, { post: 3, comment: 8, like: 9 }, '前提：三个计数都非零');

    const { code, out, err } = await run(['reset-quota', '--db', w.dbPath, '--kind', 'comment',
      '--operator', 'ops-4', '--reason', 'quota']);
    assert.equal(code, EXIT.OK, `stderr=${err}`);
    hasLine(out, 'result', 'ok');

    const after = w.read();
    assert.deepEqual(after.ledger.used, { post: 3, comment: 0, like: 9 },
      '只把 comment 归零，post 与 like 保持原值');
    assert.equal(after.ledger.day, before.ledger.day, '重置配额不得改动账本日期');
    assert.deepEqual(after.ledger.reservations, before.ledger.reservations, '重置配额不得清空预留表');
    assert.equal(after.accessPaused, true, '重置配额不得解除暂停');
    assert.equal(after.writePaused, true);

    assert.equal(after.audit.length, 1);
    const record = after.audit[0].record;
    assert.equal(record.source, 'admin_script');
    assert.equal(record.action, 'reset_quota');
    assert.equal(record.operator, 'ops-4');
    assert.equal(record.result, 'success');
    assert.ok(record.content.includes('"selection":"comment"'), '审计必须记录重置的是哪个 kind');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 4. --dry-run：打印计划，不落盘
// ══════════════════════════════════════════════════════════════════════════════════════

test('CLI-4 --dry-run 打印计划与现状但零落盘（restore 与 reset-quota 各验一次）', async () => {
  const w = world();
  try {
    const before = w.read();

    const restoreDry = await run(['restore', '--db', w.dbPath, '--layer', 'both',
      '--operator', 'ops-dry', '--dry-run']);
    assert.equal(restoreDry.code, EXIT.OK, `stderr=${restoreDry.err}`);
    hasLine(restoreDry.out, 'dryRun', true);
    hasLine(restoreDry.out, 'result', 'dry-run（未落盘）');
    assert.ok(restoreDry.out.includes('restore both'), '必须打印「将要做什么」');
    hasLine(restoreDry.out, 'accessPaused', true);   // 现状（仍然是暂停）

    const resetDry = await run(['reset-quota', '--db', w.dbPath, '--kind', 'like',
      '--operator', 'ops-dry', '--dry-run']);
    assert.equal(resetDry.code, EXIT.OK, `stderr=${resetDry.err}`);
    hasLine(resetDry.out, 'dryRun', true);
    assert.ok(resetDry.out.includes('reset-quota like'), '必须打印「将要做什么」');

    // 关键：两次 dry-run 之后，状态与审计都完全没变。
    const after = w.read();
    assert.deepEqual(after, before, '--dry-run 前后状态必须完全一致（含审计数组）');
    assert.equal(after.audit.length, 0, '--dry-run 不得写审计');
    assert.equal(after.accessPaused, true, '--dry-run 不得解除暂停');
    assert.deepEqual(after.ledger.used, { post: 3, comment: 8, like: 9 }, '--dry-run 不得重置配额');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 5. 缺 --operator → 退出码 1，状态零改动
// ══════════════════════════════════════════════════════════════════════════════════════

test('CLI-5 缺 --operator → 退出码 1，且状态零改动、零审计（restore 与 reset-quota 都验）', async () => {
  const w = world();
  try {
    const before = w.read();

    for (const argv of [
      ['restore', '--db', w.dbPath, '--layer', 'both'],
      ['reset-quota', '--db', w.dbPath, '--kind', 'post'],
      ['restore', '--db', w.dbPath, '--layer', 'both', '--dry-run'],   // dry-run 也要 operator
    ]) {
      const { code, err } = await run(argv);
      assert.equal(code, EXIT.REFUSED, `${argv[0]} 缺 operator 必须退出码 1，实际 ${code}`);
      assert.match(err, /--operator/, 'stderr 必须说明缺的是 --operator');
    }

    // 非法 operator（含空格、像密钥、含路径分隔符）同样是业务拒绝。
    // 这里额外断言**拒绝发生在 CLI 层**（stderr 是 CLI 自己的措辞），而不是让模块在事务里抛：
    // 两者退出码相同，但前者在打开数据库之前就停下，不存在部分写入的可能。
    for (const bad of ['has space', 'sk-abcdefghijklmnop', 'a/b']) {
      const { code, err } = await run(['restore', '--db', w.dbPath, '--layer', 'both', '--operator', bad]);
      assert.equal(code, EXIT.REFUSED, `非法 operator ${JSON.stringify(bad)} 必须退出码 1`);
      assert.match(err, /--operator 非法/, `CLI 必须自己拒绝非法 operator（不是交给模块在事务里抛），实际 stderr=${err}`);
    }

    const after = w.read();
    assert.deepEqual(after, before, '被拒绝的调用不得改动任何状态');
    assert.equal(after.audit.length, 0, '被拒绝的调用不得写审计');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 6. 缺 --db → 退出码 2（且不创建任何数据库）
// ══════════════════════════════════════════════════════════════════════════════════════

test('CLI-6 缺 --db → 退出码 2，且不会凭空创建数据库文件', async () => {
  const t = tempDb();
  try {
    for (const argv of [
      ['status'],
      ['restore', '--layer', 'both', '--operator', 'ops-1'],
      ['reset-quota', '--kind', 'post', '--operator', 'ops-1'],
    ]) {
      const { code, err } = await run(argv);
      assert.equal(code, EXIT.USAGE, `${argv[0]} 缺 --db 必须退出码 2，实际 ${code}`);
      assert.match(err, /--db/, 'stderr 必须说明缺的是 --db');
      assert.match(err, /默认/, 'stderr 必须说明「本工具不提供默认路径」的理由');
    }
    // 目录里不应多出任何文件。
    assert.deepEqual(fs.readdirSync(t.dir), [], '缺 --db 时不得创建任何文件');
  } finally { t.cleanup(); }
});

test('CLI-6b 不存在的 --db → 退出码 2，且不建库（status 与 dry-run 也不建）', async () => {
  const t = tempDb();
  try {
    const missing = path.join(t.dir, 'nope.db');
    for (const argv of [
      ['status', '--db', missing],
      ['restore', '--db', missing, '--layer', 'both', '--operator', 'ops-1', '--dry-run'],
      ['reset-quota', '--db', missing, '--kind', 'post', '--operator', 'ops-1'],
    ]) {
      const { code, err } = await run(argv);
      assert.equal(code, EXIT.USAGE, `不存在的库必须退出码 2，实际 ${code}`);
      assert.match(err, /不存在/, 'stderr 必须说明文件不存在');
    }
    assert.equal(fs.existsSync(missing), false, '本工具绝不能创建数据库');
    assert.deepEqual(fs.readdirSync(t.dir), []);
  } finally { t.cleanup(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 7. 审计：每次成功操作恰好一条，source 必须是 admin_script
// ══════════════════════════════════════════════════════════════════════════════════════

test('CLI-7 三次成功操作 → 恰好三条审计，全部 source=admin_script 且各带 operator/action/result', async () => {
  const w = world();
  try {
    assert.equal((await run(['restore', '--db', w.dbPath, '--layer', 'access', '--operator', 'ops-a'])).code, EXIT.OK);
    assert.equal((await run(['reset-quota', '--db', w.dbPath, '--kind', 'post', '--operator', 'ops-b'])).code, EXIT.OK);
    assert.equal((await run(['restore', '--db', w.dbPath, '--layer', 'write', '--operator', 'ops-c'])).code, EXIT.OK);

    const after = w.read();
    assert.equal(after.audit.length, 3, '三次成功操作 = 三条审计');
    assert.deepEqual(after.audit.map((entry) => entry.record.source), ['admin_script', 'admin_script', 'admin_script']);
    assert.deepEqual(after.audit.map((entry) => entry.record.action), ['restore', 'reset_quota', 'restore']);
    assert.deepEqual(after.audit.map((entry) => entry.record.operator), ['ops-a', 'ops-b', 'ops-c']);
    assert.deepEqual(after.audit.map((entry) => entry.record.result), ['success', 'success', 'success']);
    // auditId 唯一：三次的审计条目不互相覆盖。
    assert.equal(new Set(after.audit.map((entry) => entry.id)).size, 3, '三次审计的 id 必须互不相同');
    // pauseScope 取「该笔操作执行之前」的真实暂停范围：
    //   ① 第一次（restore access）之前两层都暂停 → both
    //   ② 第二次（reset-quota）之前 access 已解除、write 仍暂停 → write
    //   ③ 第三次（restore write）之前同上 → write
    assert.deepEqual(after.audit.map((entry) => entry.record.pauseScope), ['both', 'write', 'write'],
      'pauseScope 必须取执行前的真实暂停范围，而不是固定值');
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 8. 业务拒绝：未暂停却要恢复 / 参数错误
// ══════════════════════════════════════════════════════════════════════════════════════

test('CLI-8 未暂停却要恢复 → 退出码 1、零改动零审计；参数错误 → 退出码 2', async () => {
  const w = world({ accessPaused: false, writePaused: false });
  try {
    const before = w.read();
    assert.equal(before.accessPaused, false, '前提：两层都已解除');

    for (const layer of ['access', 'write', 'both']) {
      const { code, err } = await run(['restore', '--db', w.dbPath, '--layer', layer, '--operator', 'ops-1']);
      assert.equal(code, EXIT.REFUSED, `layer=${layer} 未暂停时恢复必须退出码 1`);
      assert.match(err, /并未暂停/, 'stderr 必须说明当前没有可恢复的暂停');
    }
    assert.deepEqual(w.read(), before, '业务拒绝不得改动状态');
    assert.equal(w.read().audit.length, 0, '业务拒绝不得写审计');
  } finally { w.close(); }

  // 参数错误 → 2
  const w2 = world();
  try {
    const cases = [
      [],                                                        // 无子命令
      ['bogus', '--db', w2.dbPath],                              // 未知子命令
      ['status', '--db', w2.dbPath, '--extra', 'x'],             // 未知参数
      ['restore', '--db', w2.dbPath, '--layer', 'nope', '--operator', 'ops-1'],   // 非法 layer
      ['reset-quota', '--db', w2.dbPath, '--kind', 'nope', '--operator', 'ops-1'], // 非法 kind
      ['reset-quota', '--db', w2.dbPath, '--operator', 'ops-1'], // 缺 --kind
      ['restore', '--db', w2.dbPath, '--operator', 'ops-1'],     // 缺 --layer
      ['restore', '--db', w2.dbPath, '--layer'],                 // --layer 缺值
      ['restore', '--db', w2.dbPath, '--layer', 'both', '--layer', 'access', '--operator', 'x'], // 重复
      ['restore', '--db', w2.dbPath, '--layer', 'both', '--operator', 'ops-1', '--reason', 'nope'], // 非法 reason
      ['restore', '--db', w2.dbPath, '--layer', 'both', '--operator', 'ops-1', '--target', 'not-a-qq'],
      ['restore', '--db', w2.dbPath, 'extra-positional', '--layer', 'both', '--operator', 'x'],
    ];
    for (const argv of cases) {
      const { code } = await run(argv);
      assert.equal(code, EXIT.USAGE, `参数错误场景必须退出码 2：${JSON.stringify(argv)}`);
    }
    // 全部参数错误都不应改动状态。
    assert.equal(w2.read().accessPaused, true);
    assert.equal(w2.read().audit.length, 0);
  } finally { w2.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 9. 真实子进程入口：CLI 脚本本身可执行，退出码真的传给 shell
// ══════════════════════════════════════════════════════════════════════════════════════

test('CLI-9 以真实子进程运行：退出码与 stdout 真的到达 shell（0 / 1 / 2 各验一次）', async () => {
  const { spawnSync } = await import('node:child_process');
  const w = world();
  try {
    const cliPath = path.join(import.meta.dirname, 'qzone-admin-cli.mjs');
    const invoke = (args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });

    const status = invoke(['status', '--db', w.dbPath]);
    assert.equal(status.status, EXIT.OK, `status 子进程退出码应为 0，stderr=${status.stderr}`);
    assert.match(status.stdout, /accessPaused: true/);

    const refused = invoke(['restore', '--db', w.dbPath, '--layer', 'both']);
    assert.equal(refused.status, EXIT.REFUSED, '缺 operator 时子进程退出码应为 1');
    assert.match(refused.stderr, /--operator/);

    const usage = invoke(['status']);
    assert.equal(usage.status, EXIT.USAGE, '缺 --db 时子进程退出码应为 2');
    assert.match(usage.stderr, /--db/);

    // 子进程跑完，状态仍未被任何失败调用改动。
    assert.equal(w.read().accessPaused, true);
    assert.equal(w.read().audit.length, 0);
  } finally { w.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════
// audit-export：只读投影子命令
//
// 与上面几组的分工：这里只验**新行为**与**CLI 原入口兼容**，不重跑恢复/配额语义。
// 每一条都用真实临时 SQLite + 临时输出目录，不碰 state/。
// ══════════════════════════════════════════════════════════════════════════════════════

/** 一条合法审计记录（时间取"现在"，否则 7 天保留会把它判为过期）。 */
const auditRow = (id, over = {}) => ({
  id,
  record: {
    time: Date.now(),
    source: 'qq',
    action: 'publish',
    target: TARGET,
    postId: null,
    commentId: null,
    content: `body-${id}`,
    redacted: false,
    result: 'success',
    reason: '',
    quota: null,
    ...over,
  },
});

/** 带审计行的世界；返回导出用的临时输出目录。 */
function exportWorld(rows) {
  const w = world({ audit: rows });
  return { w, outDir: path.join(w.t.dir, 'export-out') };
}

test('CLI-10 audit-export 缺 --out / --namespace / 非法 namespace → 退出码 2', async () => {
  const { w, outDir } = exportWorld([]);
  try {
    assert.equal((await run(['audit-export', '--db', w.dbPath, '--namespace', 'ns1'])).code, EXIT.USAGE,
      '★ 缺 --out 必须是参数错误：不提供默认输出路径');
    assert.equal((await run(['audit-export', '--db', w.dbPath, '--out', outDir])).code, EXIT.USAGE,
      '★ 缺 --namespace 必须是参数错误：不能每次随机生成');
    assert.equal((await run(['audit-export', '--db', w.dbPath, '--out', outDir, '--namespace', 'bad ns'])).code,
      EXIT.USAGE, '★ 非法 namespace 被拒');
    assert.equal(fs.existsSync(outDir), false, '★ 参数错误时连输出目录都不该建');
  } finally { w.close(); }
});

test('CLI-10b audit-export 源库不存在/缺 state 表 → 退出码 2，且绝不创建或初始化', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-admincli-ae-'));
  try {
    const missing = path.join(dir, 'nope.db');
    const outDir = path.join(dir, 'out');
    const r1 = await run(['audit-export', '--db', missing, '--out', outDir, '--namespace', 'ns1']);
    assert.equal(r1.code, EXIT.USAGE, '★ 缺库是参数错误');
    assert.equal(fs.existsSync(missing), false, '★★ 绝不能凭空创建源库');

    // 有库但缺 state 表：只读连接不会替它建表，字节也不变。
    const noTable = path.join(dir, 'notable.db');
    const raw = new (await import('node:sqlite')).DatabaseSync(noTable);
    raw.exec('CREATE TABLE other (id INTEGER PRIMARY KEY, v TEXT)');
    raw.close();
    const bytesBefore = fs.readFileSync(noTable);
    const r2 = await run(['audit-export', '--db', noTable, '--out', outDir, '--namespace', 'ns1']);
    assert.equal(r2.code, EXIT.USAGE, '★ 缺 state 表是参数错误');
    assert.equal(bytesBefore.equals(fs.readFileSync(noTable)), true, '★★ 源库文件字节未被改动');
    assert.equal(fs.existsSync(outDir), false, '★ 拒绝时不建输出目录');

    // 打开失败的用户可见文本必须是**受控类别**，不能是底层异常原文。
    // 这条钉的是 describeOpenFailure —— 它确实可达（与导出路径的两个防御性 catch 不同）。
    assert.ok(r2.err.includes('store-shape-invalid'),
      `★★ 打开失败必须给出受控类别，实际：\n${r2.err}`);
    assert.equal(r2.err.includes('missing state table'), false,
      `★★ 不得透传底层异常原文，实际：\n${r2.err}`);
  } finally {
    for (let i = 0; i < 20; i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { /* delay */ } }
  }
});

test('CLI-11 audit-export --dry-run：只读 status，不建输出目录、不改源库', async () => {
  const { w, outDir } = exportWorld([auditRow('a-1'), auditRow('a-2')]);
  try {
    const bytesBefore = fs.readFileSync(w.dbPath);
    const r = await run(['audit-export', '--db', w.dbPath, '--out', outDir, '--namespace', 'ns1', '--dry-run']);
    assert.equal(r.code, EXIT.OK);
    hasLine(r.out, 'dryRun', 'true');
    hasLine(r.out, 'pending', 2);
    hasLine(r.out, 'delivered', 0);
    assert.equal(fs.existsSync(outDir), false, '★★ dry-run 绝不创建输出目录');
    assert.equal(bytesBefore.equals(fs.readFileSync(w.dbPath)), true, '★★ 源库文件字节未变');
  } finally { w.close(); }
});

test('CLI-12 audit-export 正式导出：导出到显式 --out，第二次不重复追加', async () => {
  const { w, outDir } = exportWorld([auditRow('b-1'), auditRow('b-2')]);
  try {
    const bytesBefore = fs.readFileSync(w.dbPath);
    const r1 = await run(['audit-export', '--db', w.dbPath, '--out', outDir, '--namespace', 'ns1']);
    assert.equal(r1.code, EXIT.OK);
    hasLine(r1.out, 'exported', 2);
    hasLine(r1.out, 'result', 'ok');

    const files = fs.readdirSync(outDir);
    assert.equal(files.length, 1, '★ 同一天只一个文件');
    const bytes1 = fs.readFileSync(path.join(outDir, files[0]), 'utf8');
    assert.equal(bytes1.split('\n').filter(Boolean).length, 2, '★ 两行');

    const r2 = await run(['audit-export', '--db', w.dbPath, '--out', outDir, '--namespace', 'ns1']);
    assert.equal(r2.code, EXIT.OK);
    hasLine(r2.out, 'exported', 0);
    hasLine(r2.out, 'alreadyPresent', 2);
    assert.equal(fs.readFileSync(path.join(outDir, files[0]), 'utf8'), bytes1,
      '★★ 第二次导出必须字节不变（不重复追加）');
    assert.equal(bytesBefore.equals(fs.readFileSync(w.dbPath)), true,
      '★★ 源库业务状态文件字节未变');
  } finally { w.close(); }
});

test('CLI-13 audit-export 导出失败 → 退出码 1，并保留已导出进度与 failedAuditId', async () => {
  const { w, outDir } = exportWorld([
    auditRow('ok-1'),
    { id: 'broken', record: { ...auditRow('x').record, content: 42 } },
  ]);
  try {
    const r = await run(['audit-export', '--db', w.dbPath, '--out', outDir, '--namespace', 'ns1']);
    assert.equal(r.code, EXIT.REFUSED, '★★★ 部分已导出随后失败，退出码必须非零');
    hasLine(r.out, 'exported', 1);
    assert.ok(r.out.includes('ns1:broken'), `★ 摘要必须命名坏行身份，实际：\n${r.out}`);
    assert.ok(r.out.includes('fault:'), '★ 故障行必须出现（固定类别，不打印记录内容）');
    assert.ok(!r.out.includes('body-ok-1'), '★★ 不得打印 record.content');
    assert.ok(!r.out.includes('body-'), '★★ 摘要里不应出现任何正文');
  } finally { w.close(); }
});

test('CLI-14 audit-export 不写审计、不动暂停/配额/gaps/settled（纯只读投影）', async () => {
  const { w, outDir } = exportWorld([auditRow('c-1')]);
  try {
    const before = w.read();
    await run(['audit-export', '--db', w.dbPath, '--out', outDir, '--namespace', 'ns1']);
    const after = w.read();
    assert.equal(after.audit.length, before.audit.length, '★★ 不得新增审计行');
    assert.equal(after.accessPaused, before.accessPaused, '★ 不得改暂停状态');
    assert.equal(after.writePaused, before.writePaused);
    assert.deepEqual(after.ledger, before.ledger, '★ 不得动配额账本');
    assert.deepEqual(after.auditGaps ?? [], before.auditGaps ?? [], '★ 不得动 gaps');
    assert.deepEqual(after.settled ?? {}, before.settled ?? {}, '★ 不得动 settled');
  } finally { w.close(); }
});

test('CLI-15 既有子命令不受影响：status/restore/reset-quota 的退出码与行为不变', async () => {
  const w = world();
  try {
    const status = await run(['status', '--db', w.dbPath]);
    assert.equal(status.code, EXIT.OK, '★ status 仍返回 0');
    hasLine(status.out, 'accessPaused', 'true');

    const restore = await run(['restore', '--db', w.dbPath, '--layer', 'both', '--operator', 'ops1']);
    assert.equal(restore.code, EXIT.OK, '★ restore 仍返回 0');
    assert.equal(w.read().accessPaused, false);

    // 未暂停再恢复 → 仍必须是业务拒绝 1
    assert.equal((await run(['restore', '--db', w.dbPath, '--layer', 'both', '--operator', 'ops1'])).code,
      EXIT.REFUSED, '★ 未暂停却恢复仍是 1');

    // 缺 --operator → 仍是 1
    assert.equal((await run(['reset-quota', '--db', w.dbPath, '--kind', 'post'])).code,
      EXIT.REFUSED, '★ 缺 operator 仍是 1');

    // 未知子命令 → 仍是 2
    assert.equal((await run(['nope', '--db', w.dbPath])).code, EXIT.USAGE, '★ 未知子命令仍是 2');
  } finally { w.close(); }
});

test('CLI-16 只读源句柄的方法面只有 read/close，且底层连接拒绝写入', async () => {
  // 这条钉的是**只读能力本身**，不是"我们恰好只调了 read"。
  // openOfflineStore 的构造会 BEGIN IMMEDIATE 并可能建表/插入；导出不需要写，
  // 所以源库必须走只读连接 —— 有写方法在手就等于给未来留了一条误用路径。
  const { openOfflineStoreReadOnly } = await import('../src/core/qzone-store-offline.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-admincli-ro-'));
  try {
    const dbPath = path.join(dir, 'state.db');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)');
    seed.prepare('INSERT INTO state (id, value) VALUES (1, ?)').run(JSON.stringify(seedState()));
    seed.close();

    const handle = openOfflineStoreReadOnly(dbPath);
    try {
      assert.deepEqual(Object.keys(handle).sort(), ['close', 'read'],
        '★★ 只读句柄只暴露 read/close；出现 update 就等于开了写入口');
      assert.equal(handle.read().accessPaused, true, '★ 能读到真实状态');

      // 直接验证底层连接真的拒绝写（不是我们不去写）。
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.throws(() => {
          raw.prepare('INSERT INTO state (id, value) VALUES (2, ?)').run('{}');
        }, /readonly|read-only/i, '★★ 只读连接上的写入必须被 SQLite 拒绝');
      } finally { raw.close(); }
    } finally { handle.close(); }

    // 缺文件：拒绝且不创建（只读连接不会替调用者建库）。
    const ghost = path.join(dir, 'ghost.db');
    assert.throws(() => openOfflineStoreReadOnly(ghost), /unable to open/i);
    assert.equal(fs.existsSync(ghost), false, '★★ 不能凭空创建源库');
  } finally {
    for (let i = 0; i < 20; i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { /* delay */ } }
  }
});

test('CLI-17 源确实用只读连接：别人持写锁时导出仍能读（可写构造会 database is locked）', async () => {
  // ⚠️ 这条是我上一轮说「打不红」之后补的。Codex 的纠正成立：那不是「无法验证」，
  // 只是我当时的断言选错了观测点。
  //
  // 判别性观察：SQLite 的 `BEGIN IMMEDIATE` 会取 RESERVED 写锁。若另一个连接先持写锁：
  //   · 可写构造（openOfflineStore 的 BEGIN IMMEDIATE）→ 在 busy_timeout(5s) 后抛
  //     "database is locked"；
  //   · 只读连接 → 不受影响，仍能读。
  // 实测：只读路径 2ms 成功退出 0；可写构造 5541ms 后抛 locked。
  // 所以「源用的是只读连接」在 CLI 层面是**可观测的**，把源换回 openOfflineStore 会让这条红。
  const { DatabaseSync } = await import('node:sqlite');
  const w = world();
  const holder = new DatabaseSync(w.dbPath);
  try {
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('UPDATE state SET value = value WHERE id = 1').run();

    const outDir = path.join(w.t.dir, 'export-under-lock');
    const started = Date.now();
    const r = await run(['audit-export', '--db', w.dbPath, '--out', outDir, '--namespace', 'ns1', '--dry-run']);
    const elapsed = Date.now() - started;

    assert.equal(r.code, EXIT.OK,
      `★★★ 别人持写锁时只读导出必须成功；若红说明源走了可写构造且被锁住：\n${r.err}`);
    hasLine(r.out, 'dryRun', 'true');
    assert.ok(elapsed < 2000,
      `★★ 只读路径不该等 busy_timeout；实际 ${elapsed}ms（可写构造会等满 ~5s 再抛）`);
    assert.equal(fs.existsSync(outDir), false, '★ still a dry-run: no output directory');
  } finally {
    try { holder.exec('ROLLBACK'); } catch { /* ignore */ }
    try { holder.close(); } catch { /* ignore */ }
    w.close();
  }
});

test('CLI-18 源内容绝不出现在用户可见输出：非 JSON 的 state.value 在导出与 dry-run 下都不泄漏', async () => {
  // Codex 的真实反例：把 state 表 id=1 的 value 设成一段**纯合成**非 JSON 字符串。
  // JSON.parse 会抛 `SyntaxError: Unexpected token 'S', "SYNTHETIC_"... is not valid JSON` ——
  // 这条 message **自带源串片段**。修复前 describeExportFailure 直接透传 result.error，
  // 于是导出与 --dry-run 两条路径都把源内容打到了 stdout。
  //
  // 这条钉的是**结构性保证**：用户可见文本只能来自闭集类别 + 已校验 identity + 进度，
  // 拿不到异常原文。不是靠关键词正则遮挡（那种在换一种坏输入时就会漏）。
  const { DatabaseSync } = await import('node:sqlite');
  const SENTINEL = 'SYNTHETIC_PRIVATE_FIXTURE_NOT_JSON';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-admincli-leak-'));
  try {
    const dbPath = path.join(dir, 'state.db');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)');
    seed.prepare('INSERT INTO state (id, value) VALUES (1, ?)').run(SENTINEL);
    seed.close();

    const outDir = path.join(dir, 'export-out');
    const modes = [
      ['export', ['audit-export', '--db', dbPath, '--out', outDir, '--namespace', 'ns1']],
      ['dry-run', ['audit-export', '--db', dbPath, '--out', outDir, '--namespace', 'ns1', '--dry-run']],
    ];

    for (const [label, argv] of modes) {
      const r = await run(argv);
      const visible = r.out + r.err;
      assert.equal(r.code, EXIT.REFUSED, `★★★ ${label}: 源不可解析必须以非零退出码报告`);
      assert.equal(visible.includes(SENTINEL), false,
        `★★★ ${label}: 输出里出现源内容片段（结构性泄漏）。实际输出：\n${visible}`);
      assert.equal(visible.includes('SYNTHETIC_'), false,
        `★★★ ${label}: 输出里出现源串前缀。实际输出：\n${visible}`);
      assert.equal(visible.includes('is not valid JSON'), false,
        `★★ ${label}: 不得透传任意异常原文。实际输出：\n${visible}`);
      assert.ok(visible.includes('code='),
        `★★ ${label}: 必须给出受控类别（code=...），实际：\n${visible}`);
    }

    // 进度仍然可见：导出模式必须打印 exported（此处应为 0），证明失败时也保留进度字段。
    const exportedRun = await run(modes[0][1]);
    hasLine(exportedRun.out, 'exported', 0);

    // dry-run 不建输出目录（与 CLI-11 一致，此处再确认一次成本很低）
    assert.equal(fs.existsSync(outDir), false, '★ dry-run 失败也不该留下输出目录');
  } finally {
    for (let i = 0; i < 20; i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { /* delay */ } }
  }
});


// ══════════════════════════════════════════════════════════════════════════════════════
// 17. audit-export 的 id 形状：含冒号的合法 id 必须能显示，且与导出器正则不漂移
// ══════════════════════════════════════════════════════════════════════════════════════
//
// 背景（2026-11-19，commit 43c597d）：导出器把 STORED_AUDIT_ID 放宽成「1 段或 2 段」，
// 因为生产里真实存在 read:<32hex>，拼成 plugin:read:<hex> 就是两个冒号。
// 本文件:196 的 EXPORT_AUDIT_ID 是那份正则的**第二份拷贝**，当时没同步 ——
// 后果是「合法失败 id 被静默吞掉，只看到 code= 看不到 at=」，排障方向会被带偏。
// 下面两条：一条钉行为（能显示），一条钉同步（两份形状一致）。

test('CLI-19 含冒号的合法 failedAuditId（plugin:read:<hex>）必须被显示，不被静默吞掉', () => {
  // 直接测纯函数，不跑整条 export：这条钉的是「形状判据」本身。
  const cases = [
    ['ns1:dsp_abc123', true, '普通一段 id'],
    ['ns1:read:484e9e6d3f177675c823d242aea5862a', true, '两段 id —— 生产里真实存在的那一种'],
    ['ns1:a:b:c', false, '三段不是合法形状'],
    ['ns1:', false, '空 id'],
    [':dsp_x', false, '空 namespace'],
    ['no-colon-here', false, '没有冒号'],
    ['ns1:dsp x', false, '含空格'],
    ['ns1:../../etc/passwd', false, '路径穿越'],
  ];
  for (const [value, expected, label] of cases) {
    assert.equal(__TEST_ONLY_EXPORT_AUDIT_ID.test(value), expected, `${label}: ${value}`);
  }
});

test('CLI-20 EXPORT_AUDIT_ID 与导出器的 AUDIT_ID.shape 必须保持一致（防两份拷贝再次漂移）', async () => {
  // 同一份数据（生产真库里真实存在的 7 条 read:<hex>）喂给两个正则，判定必须相同。
  // 不比较正则字面量：字面量可以写成很多等价形式，比行为才是真的。
  // 导出器把 AUDIT_ID 以 _AUDIT_ID 暴露（沿用 _DAY_FILE 的「下划线 = 仅供测试」惯例）。
  const { _AUDIT_ID } = await import('../src/core/qzone-audit-jsonl-offline.mjs');
  const AUDIT_ID_SHAPE_FOR_TEST = _AUDIT_ID?.shape;
  assert.ok(AUDIT_ID_SHAPE_FOR_TEST instanceof RegExp, '导出器必须暴露 _AUDIT_ID.shape 供比对（仅供测试）');
  const samples = [
    'ns1:dsp_abc123',
    'plugin:read:f1509536b847b222d2c2177688e51e1d',
    'plugin:write:484e9e6d3f177675c823d242aea5862a',
    'ns1:a:b:c',
    'ns1:',
    ':dsp_x',
    'plain',
    'ns1:dsp x',
    'plugin:read:../../etc/passwd',
  ];
  for (const sample of samples) {
    assert.equal(
      __TEST_ONLY_EXPORT_AUDIT_ID.test(sample),
      AUDIT_ID_SHAPE_FOR_TEST.test(sample),
      `两份正则对 ${JSON.stringify(sample)} 的判定必须一致（一份接受一份拒绝 = 已经漂移）`,
    );
  }
});
