// 小黑盒专栏独立密码：认证核心模块单测（task-86）。
// 规格：docs/superpowers/plans/2026-10-30-console-column-password-spec.md §3.1 / §3.5。
// 全部离线：临时 stateDir + 注入 now，不写正式 state/、不访问网络/平台/QQ。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getAuthStatus,
  setPassword,
  verifyPassword,
  verifySession,
  revokeSession,
  revokeAllSessions,
  forgotResetPassword,
} from '../src/core/console-column-auth.mjs';

const START = 1_800_000_000_000;
const CONSOLE_TOKEN = 'console-token-for-tests-0123456789';
const GOOD = 'correct-horse-battery';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'column-auth-'));
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上句柄释放慢时忽略；临时目录会在系统清理中回收。
  }
}

function authFile(dir) {
  return path.join(dir, 'xiaoheihe-console-column-auth.json');
}

function qqspaceAuthFile(dir) {
  return path.join(dir, 'qqspace-console-column-auth.json');
}

function readAuthFile(dir) {
  return JSON.parse(fs.readFileSync(authFile(dir), 'utf8'));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function withTempDir(fn) {
  const dir = tmpDir();
  try {
    return await fn(dir);
  } finally {
    rmDir(dir);
  }
}

// 只用于「落盘失败」用例：注入必然抛错的写文件操作，验证模块不会假装成功。
const failingFsOps = Object.freeze({
  mkdirSync() {},
  writeFileSync() {
    throw new Error('injected disk failure');
  },
  renameSync() {
    throw new Error('injected disk failure');
  },
  unlinkSync() {},
});

function countings() {
  const attempts = [];
  return { attempts };
}

// 连续失败 n 次；lockAfter 表示每次失败后时间推进（毫秒）。
function failTimes(dir, n, { from = START, gapMs = 1, password = 'wrong-password-1' } = {}) {
  let now = from;
  let last = null;
  for (let i = 0; i < n; i += 1) {
    last = verifyPassword({ stateDir: dir, password, now });
    now += gapMs;
  }
  return { last, now };
}

// ── 1. 未设置 ────────────────────────────────────────────────────────────
test('task86-01 文件不存在 → unset，且 verifyPassword 拒绝（绝不视作无密码放行）', async () => {
  await withTempDir((dir) => {
    const status = getAuthStatus({ stateDir: dir, now: START });
    assert.deepEqual(status, {
      state: 'unset',
      lockedSeconds: 0,
      failedAttempts: 0,
      passwordSetAt: null,
      lockedUntil: null,
    });
    assert.equal(fs.existsSync(authFile(dir)), false);

    const verify = verifyPassword({ stateDir: dir, password: '', now: START });
    assert.equal(verify.ok, false);
    assert.equal(verify.reason, 'unset');
    assert.equal(verify.sessionToken, undefined);
  });
});

// ── 2. agentPaused 门（set / forgot） ────────────────────────────────────
test('task86-02 agentPaused !== true → setPassword 返回 agent-not-paused 且不写文件（字节/存在性不变）', async () => {
  await withTempDir((dir) => {
    for (const agentPaused of [false, undefined, null, 0, 'true']) {
      const result = setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused, now: START });
      assert.deepEqual(result, { ok: false, reason: 'agent-not-paused' });
      assert.equal(fs.existsSync(authFile(dir)), false, `agentPaused=${String(agentPaused)} 不应创建文件`);
    }
  });
});

test('task86-03 agentPaused !== true → forgotResetPassword 返回 agent-not-paused 且已有 auth 文件字节不变', async () => {
  await withTempDir((dir) => {
    assert.deepEqual(
      setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START }),
      { ok: true },
    );
    const before = fs.readFileSync(authFile(dir));

    for (const agentPaused of [false, undefined, 0]) {
      const result = forgotResetPassword({
        stateDir: dir,
        password: 'another-good-password',
        consoleToken: CONSOLE_TOKEN,
        agentPaused,
        now: START + 1000,
      });
      assert.deepEqual(result, { ok: false, reason: 'agent-not-paused' });
      assert.equal(sha256(fs.readFileSync(authFile(dir))), sha256(before), '未暂停时 auth 文件必须字节不变');
    }

    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 2000 }).ok, true);
  });
});

// ── 3. 密码强度 ──────────────────────────────────────────────────────────
test('task86-04 密码不足 10 字符/非字符串 → password-too-short（非字符串为 invalid-password）且不写文件', async () => {
  await withTempDir((dir) => {
    for (const password of ['', 'short', '123456789']) {
      assert.deepEqual(
        setPassword({ stateDir: dir, password, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START }),
        { ok: false, reason: 'password-too-short' },
      );
    }
    for (const password of [null, undefined, 123, {}, []]) {
      const result = setPassword({ stateDir: dir, password, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid-password');
    }
    assert.equal(fs.existsSync(authFile(dir)), false);
  });
});

test('task86-05 密码等于 consoleToken → password-equals-console-token，不写文件', async () => {
  await withTempDir((dir) => {
    const result = setPassword({
      stateDir: dir,
      password: CONSOLE_TOKEN,
      consoleToken: CONSOLE_TOKEN,
      agentPaused: true,
      now: START,
    });
    assert.deepEqual(result, { ok: false, reason: 'password-equals-console-token' });
    assert.equal(fs.existsSync(authFile(dir)), false);
  });
});

// ── 4. 设置成功 + 存储格式 ──────────────────────────────────────────────
test('task86-06 设置成功：ok、状态 set、0600（非 Windows）、字段与 scrypt 参数正确、无明文密码、无 tmp 残留', async () => {
  await withTempDir((dir) => {
    assert.deepEqual(
      setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START }),
      { ok: true },
    );

    // task-86 规格澄清（lead m02715）：status 额外给 passwordSetAt / lockedUntil 毫秒时间戳，
    // 便于 bridge 如实回报 UI 并每秒重算倒计时；既有字段保持原语义。
    assert.deepEqual(getAuthStatus({ stateDir: dir, now: START }), {
      state: 'set',
      lockedSeconds: 0,
      failedAttempts: 0,
      passwordSetAt: START,
      lockedUntil: null,
    });

    const raw = fs.readFileSync(authFile(dir));
    assert.equal(raw.includes(Buffer.from(GOOD)), false, 'auth 文件不得含明文密码');
    const stored = JSON.parse(raw.toString('utf8'));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.algorithm, 'scrypt');
    assert.deepEqual(stored.params, { N: 16384, r: 8, p: 1, keylen: 32 });
    assert.equal(Buffer.from(stored.salt, 'base64').length, 16);
    assert.equal(Buffer.from(stored.hash, 'base64').length, 32);
    assert.equal(stored.passwordUpdatedAt, START);
    assert.equal(stored.failedAttempts, 0);
    assert.equal(stored.lockedUntil, null);

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(authFile(dir)).mode & 0o777, 0o600);
    }
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '原子写不得留下临时文件');
  });
});

test('task86-07 已设置时再次 setPassword → already-set（不覆盖既有哈希）', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const before = fs.readFileSync(authFile(dir));
    const result = setPassword({
      stateDir: dir,
      password: 'another-good-password',
      consoleToken: CONSOLE_TOKEN,
      agentPaused: true,
      now: START + 5000,
    });
    assert.deepEqual(result, { ok: false, reason: 'already-set' });
    assert.equal(sha256(fs.readFileSync(authFile(dir))), sha256(before));
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 6000 }).ok, true);
  });
});

// ── 5. untrusted 三种 + 未知 schema（绝不当作无密码） ────────────────────
const untrustedCases = [
  ['坏 JSON', '{ not json'],
  ['未知 algorithm', JSON.stringify({ schemaVersion: 1, algorithm: 'pbkdf2', params: { N: 16384, r: 8, p: 1, keylen: 32 }, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'A'.repeat(44), passwordUpdatedAt: START, failedAttempts: 0, lockedUntil: null, lastFailedAt: null })],
  ['hash 长度非法', JSON.stringify({ schemaVersion: 1, algorithm: 'scrypt', params: { N: 16384, r: 8, p: 1, keylen: 32 }, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'AAAA', passwordUpdatedAt: START, failedAttempts: 0, lockedUntil: null, lastFailedAt: null })],
  ['schemaVersion 未知', JSON.stringify({ schemaVersion: 999, algorithm: 'scrypt', params: { N: 16384, r: 8, p: 1, keylen: 32 }, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'A'.repeat(44), passwordUpdatedAt: START, failedAttempts: 0, lockedUntil: null, lastFailedAt: null })],
  ['salt 长度非法', JSON.stringify({ schemaVersion: 1, algorithm: 'scrypt', params: { N: 16384, r: 8, p: 1, keylen: 32 }, salt: 'AAAA', hash: 'A'.repeat(44), passwordUpdatedAt: START, failedAttempts: 0, lockedUntil: null, lastFailedAt: null })],
];

for (const [label, raw] of untrustedCases) {
  test(`task86-08 ${label} → untrusted：status untrusted、验证拒绝、setPassword 拒绝`, async () => {
    await withTempDir((dir) => {
      fs.writeFileSync(authFile(dir), raw, 'utf8');
      const before = fs.readFileSync(authFile(dir));

      const status = getAuthStatus({ stateDir: dir, now: START });
      assert.equal(status.state, 'untrusted');
      assert.equal(status.failedAttempts, 0);

      const verify = verifyPassword({ stateDir: dir, password: GOOD, now: START });
      assert.equal(verify.ok, false);
      assert.equal(verify.reason, 'untrusted');

      const set = setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
      assert.deepEqual(set, { ok: false, reason: 'state-untrusted' });
      assert.equal(sha256(fs.readFileSync(authFile(dir))), sha256(before), 'untrusted 文件不得被 setPassword 覆盖');
    });
  });
}

// ── 6. 验证成功 / 会话 ─────────────────────────────────────────────────
test('task86-09 正确密码 → 发放 32B 随机会话、expiresAt=now+2h、文件失败计数清零', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });

    const result = verifyPassword({ stateDir: dir, password: GOOD, now: START + 1000 });
    assert.equal(result.ok, true);
    assert.match(result.sessionToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(result.sessionToken, 'base64url').length, 32);
    assert.equal(result.expiresAt, START + 1000 + 2 * 60 * 60 * 1000);

    const session = verifySession({ sessionToken: result.sessionToken, now: START + 2000 });
    assert.equal(session.ok, true);
    assert.equal(typeof session.sessionId, 'string');
    assert.ok(session.sessionId.length > 0);
    // task-89 P2-1：校验成功必须同时给出到期时刻（= 本次续期后的空闲到期，早于绝对到期）。
    assert.equal(session.expiresAt, START + 2000 + 15 * 60 * 1000);

    assert.equal(readAuthFile(dir).failedAttempts, 0);
    assert.equal(readAuthFile(dir).lockedUntil, null);
  });
});

// task-89 P2-1：`expiresAt` 必须是「绝对到期」与「本次续期后空闲到期」的较小者。
// 这里让绝对到期先到（会话已存活 1h55m），空闲窗口远未用完 ⇒ 只有取 min 才会得到绝对到期。
test('task89-P2-1 verifySession 的 expiresAt 取 min(绝对到期, 空闲到期)', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const result = verifyPassword({ stateDir: dir, password: GOOD, now: START });
    assert.equal(result.ok, true);

    // 每隔 10 分钟活跃一次，走到 START+115m（绝对到期还剩 5 分钟，空闲窗口还剩 15 分钟）。
    let at = START;
    for (let minute = 10; minute <= 110; minute += 10) {
      at = START + minute * 60 * 1000;
      assert.equal(verifySession({ sessionToken: result.sessionToken, now: at }).ok, true, `第 ${minute} 分钟应仍有效`);
    }
    const nearAbsolute = verifySession({ sessionToken: result.sessionToken, now: at });
    assert.equal(nearAbsolute.ok, true);
    assert.equal(nearAbsolute.expiresAt, START + 2 * 60 * 60 * 1000, '绝对到期更近时必须回报绝对到期');
    assert.ok(nearAbsolute.expiresAt < at + 15 * 60 * 1000);
  });
});

test('task86-10 错误密码 → wrong-password 且计数落盘；随后正确密码清零', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });

    const bad = verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: START + 10 });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'wrong-password');
    assert.equal(bad.failedAttempts, 1);
    assert.equal(readAuthFile(dir).failedAttempts, 1);
    assert.equal(readAuthFile(dir).lastFailedAt, START + 10);

    const ok = verifyPassword({ stateDir: dir, password: GOOD, now: START + 20 });
    assert.equal(ok.ok, true);
    assert.equal(readAuthFile(dir).failedAttempts, 0);
    assert.equal(readAuthFile(dir).lockedUntil, null);
  });
});

test('task86-11 会话未知/非字符串 → unknown-session；revokeSession 后同样失效', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const { sessionToken } = verifyPassword({ stateDir: dir, password: GOOD, now: START });

    assert.deepEqual(verifySession({ sessionToken: 'no-such-token', now: START }), { ok: false, reason: 'unknown-session' });
    for (const bad of [null, undefined, 123, {}, []]) {
      assert.deepEqual(verifySession({ sessionToken: bad, now: START }), { ok: false, reason: 'unknown-session' });
    }

    revokeSession(sessionToken);
    assert.deepEqual(verifySession({ sessionToken, now: START }), { ok: false, reason: 'unknown-session' });
  });
});

test('task86-12 空闲 15 分钟过期；过期后 unknown-session', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const { sessionToken } = verifyPassword({ stateDir: dir, password: GOOD, now: START });

    // 在 15 分钟边界前最后活跃一次（滑动续期），再等满 15 分钟。
    const lastActive = START + 15 * 60 * 1000 - 1;
    assert.equal(verifySession({ sessionToken, now: lastActive }).ok, true);

    const expired = verifySession({ sessionToken, now: lastActive + 15 * 60 * 1000 });
    assert.deepEqual(expired, { ok: false, reason: 'expired' });
    assert.deepEqual(verifySession({ sessionToken, now: lastActive + 15 * 60 * 1000 + 1 }), { ok: false, reason: 'unknown-session' });
  });
});

test('task86-13 绝对 2 小时过期（即使持续活跃）', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const { sessionToken } = verifyPassword({ stateDir: dir, password: GOOD, now: START });

    // 每 10 分钟活跃一次（不触发空闲过期），验证滑动续期有效。
    for (let minute = 10; minute <= 110; minute += 10) {
      assert.equal(verifySession({ sessionToken, now: START + minute * 60 * 1000 }).ok, true, `第 ${minute} 分钟应仍有效`);
    }

    // 但绝对时限不因活跃而延长：满 2 小时即过期，且过期后从会话表移除。
    assert.deepEqual(verifySession({ sessionToken, now: START + 2 * 60 * 60 * 1000 }), { ok: false, reason: 'expired' });
    assert.deepEqual(verifySession({ sessionToken, now: START + 2 * 60 * 60 * 1000 + 1 }), { ok: false, reason: 'unknown-session' });
  });
});

// ── 7. 失败锁定三档 + 重启不清零 ────────────────────────────────────────
test('task86-14 连续失败 5 次 → 锁定 60s（写文件）；锁定期内正确密码也拒绝；过期后正确密码放行并清零', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });

    let result = null;
    for (let i = 0; i < 5; i += 1) {
      result = verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: START + i });
    }
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'locked');
    assert.equal(result.failedAttempts, 5);
    assert.equal(result.lockedSeconds, 60);

    const lockedStatus = getAuthStatus({ stateDir: dir, now: START + 5 });
    assert.equal(lockedStatus.state, 'locked');
    assert.equal(lockedStatus.lockedSeconds, 60);
    assert.equal(lockedStatus.failedAttempts, 5);
    assert.equal(lockedStatus.passwordSetAt, START);
    assert.equal(lockedStatus.lockedUntil, START + 4 + 60 * 1000);
    const stored = readAuthFile(dir);
    assert.equal(stored.failedAttempts, 5);
    assert.equal(stored.lockedUntil, START + 4 + 60 * 1000);

    const duringLock = verifyPassword({ stateDir: dir, password: GOOD, now: START + 30_000 });
    assert.equal(duringLock.ok, false);
    assert.equal(duringLock.reason, 'locked');
    assert.equal(duringLock.lockedSeconds > 0, true);

    const afterLock = verifyPassword({ stateDir: dir, password: GOOD, now: START + 4 + 60 * 1000 });
    assert.equal(afterLock.ok, true);
    assert.equal(readAuthFile(dir).failedAttempts, 0);
    assert.equal(readAuthFile(dir).lockedUntil, null);
  });
});

test('task86-15 累计 10 次失败 → 锁定 300s（锁定期内失败不计数）', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });

    let now = START;
    for (let i = 0; i < 5; i += 1) verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: now + i });

    // 等待 60s 锁过期后继续失败到 10 次
    now = START + 4 + 60 * 1000;
    let result = null;
    for (let i = 0; i < 5; i += 1) {
      result = verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: now + i });
    }
    assert.equal(result.reason, 'locked');
    assert.equal(result.failedAttempts, 10);
    assert.equal(result.lockedSeconds, 300);
    assert.equal(readAuthFile(dir).lockedUntil, now + 4 + 300 * 1000);
  });
});

test('task86-16 累计 15 次失败 → 900s，之后每次再满 5 次仍为 900s 上限', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });

    let now = START;
    const locks = [];
    for (let round = 0; round < 4; round += 1) {
      let result = null;
      for (let i = 0; i < 5; i += 1) result = verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: now + i });
      locks.push(result.lockedSeconds);
      now += 4 + result.lockedSeconds * 1000;
    }
    assert.deepEqual(locks, [60, 300, 900, 900]);
  });
});

test('task86-17 锁定写文件：换进程语义（直接读文件 JSON）也能看到 lockedUntil，重启不清零', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    for (let i = 0; i < 5; i += 1) verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: START + i });

    const stored = readAuthFile(dir);
    assert.equal(stored.failedAttempts, 5);
    assert.equal(typeof stored.lockedUntil, 'number');
    assert.equal(stored.lockedUntil > START, true);

    // 模拟重启后仍是同一模块（无内存状态）→ 直接读文件即锁定
    assert.equal(getAuthStatus({ stateDir: dir, now: START + 1000 }).state, 'locked');
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 1000 }).reason, 'locked');
  });
});

test('task86-18 锁过期后继续失败：不到下一个 5 次档位则只报 wrong-password（无新锁）', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    for (let i = 0; i < 5; i += 1) verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: START + i });

    const after = START + 4 + 60 * 1000 + 1;
    const result = verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: after });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wrong-password');
    assert.equal(result.failedAttempts, 6);
    assert.equal(result.lockedSeconds, 0);
  });
});

// ── 8. forgotResetPassword ───────────────────────────────────────────────
test('task86-19 forgotResetPassword 成功：untrusted 也可重设、状态变 set、新密码可验证、旧会话全部失效', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const { sessionToken } = verifyPassword({ stateDir: dir, password: GOOD, now: START });
    assert.equal(verifySession({ sessionToken, now: START }).ok, true);

    // 把文件弄坏 → untrusted，唯一出路是忘记重设。
    fs.writeFileSync(authFile(dir), '{ broken', 'utf8');
    assert.equal(getAuthStatus({ stateDir: dir, now: START }).state, 'untrusted');

    const reset = forgotResetPassword({
      stateDir: dir,
      password: 'brand-new-password',
      consoleToken: CONSOLE_TOKEN,
      agentPaused: true,
      now: START + 5000,
    });
    assert.deepEqual(reset, { ok: true });

    assert.equal(getAuthStatus({ stateDir: dir, now: START + 6000 }).state, 'set');
    assert.equal(verifyPassword({ stateDir: dir, password: 'brand-new-password', now: START + 6000 }).ok, true);
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 6000 }).ok, false);

    // 旧会话必须全部失效
    assert.deepEqual(verifySession({ sessionToken, now: START + 7000 }), { ok: false, reason: 'unknown-session' });
  });
});

test('task86-20 forgotResetPassword 密码规则同样生效（短/等于 consoleToken），且文件字节不变', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const before = fs.readFileSync(authFile(dir));

    assert.deepEqual(
      forgotResetPassword({ stateDir: dir, password: 'short', consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START + 1 }),
      { ok: false, reason: 'password-too-short' },
    );
    assert.deepEqual(
      forgotResetPassword({ stateDir: dir, password: CONSOLE_TOKEN, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START + 1 }),
      { ok: false, reason: 'password-equals-console-token' },
    );
    assert.equal(sha256(fs.readFileSync(authFile(dir))), sha256(before));
  });
});

test('task86-21 revokeAllSessions 使所有已有会话失效', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const a = verifyPassword({ stateDir: dir, password: GOOD, now: START }).sessionToken;
    const b = verifyPassword({ stateDir: dir, password: GOOD, now: START + 1 }).sessionToken;
    assert.equal(verifySession({ sessionToken: a, now: START }).ok, true);
    assert.equal(verifySession({ sessionToken: b, now: START }).ok, true);

    const revoked = revokeAllSessions();
    assert.equal(revoked.ok, true);
    assert.equal(revoked.revoked >= 2, true);
    assert.equal(verifySession({ sessionToken: a, now: START }).ok, false);
    assert.equal(verifySession({ sessionToken: b, now: START }).ok, false);
  });
});

test('namespace-01 固定可选命名空间的会话不能跨空间验证或登出', async () => {
  await withTempDir((dir) => {
    const xhhDir = path.join(dir, 'xiaoheihe');
    const qqDir = path.join(dir, 'qqspace');
    for (const [stateDir, namespace] of [[xhhDir, undefined], [qqDir, 'qqspace']]) {
      assert.deepEqual(
        setPassword({ stateDir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START, namespace }),
        { ok: true },
      );
    }

    const xhh = verifyPassword({ stateDir: xhhDir, password: GOOD, now: START + 1 });
    const qq = verifyPassword({ stateDir: qqDir, password: GOOD, now: START + 2, namespace: 'qqspace' });
    assert.equal(xhh.ok, true);
    assert.equal(qq.ok, true);
    assert.equal(verifySession({ sessionToken: xhh.sessionToken, now: START + 3, namespace: 'qqspace' }).ok, false);
    assert.equal(verifySession({ sessionToken: qq.sessionToken, now: START + 3 }).ok, false);

    revokeSession(xhh.sessionToken, { namespace: 'qqspace' });
    assert.equal(verifySession({ sessionToken: xhh.sessionToken, now: START + 4 }).ok, true);
    revokeSession(qq.sessionToken, { namespace: 'qqspace' });
    assert.equal(verifySession({ sessionToken: qq.sessionToken, now: START + 4, namespace: 'qqspace' }).ok, false);
  });
});

test('namespace-02 忘记重置和批量注销只影响指定命名空间的会话', async () => {
  await withTempDir((dir) => {
    const xhhDir = path.join(dir, 'xiaoheihe');
    const qqDir = path.join(dir, 'qqspace');
    setPassword({ stateDir: xhhDir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    setPassword({ stateDir: qqDir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START, namespace: 'qqspace' });
    const xhh = verifyPassword({ stateDir: xhhDir, password: GOOD, now: START + 1 });
    const qq = verifyPassword({ stateDir: qqDir, password: GOOD, now: START + 2, namespace: 'qqspace' });

    const reset = forgotResetPassword({
      stateDir: qqDir,
      password: 'another-good-password',
      consoleToken: CONSOLE_TOKEN,
      agentPaused: true,
      now: START + 3,
      namespace: 'qqspace',
    });
    assert.deepEqual(reset, { ok: true });
    assert.equal(verifySession({ sessionToken: qq.sessionToken, now: START + 4, namespace: 'qqspace' }).ok, false);
    assert.equal(verifySession({ sessionToken: xhh.sessionToken, now: START + 4 }).ok, true);

    const qqNew = verifyPassword({ stateDir: qqDir, password: 'another-good-password', now: START + 5, namespace: 'qqspace' });
    revokeAllSessions({ namespace: 'qqspace' });
    assert.equal(verifySession({ sessionToken: qqNew.sessionToken, now: START + 6, namespace: 'qqspace' }).ok, false);
    assert.equal(verifySession({ sessionToken: xhh.sessionToken, now: START + 6 }).ok, true);
  });
});

test('namespace-03 只接受固定命名空间，且省略参数保留旧默认空间', async () => {
  await withTempDir((dir) => {
    assert.deepEqual(
      setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START, namespace: '../other' }),
      { ok: false, reason: 'invalid-namespace' },
    );
    assert.equal(fs.existsSync(authFile(dir)), false, 'namespace 不得参与认证文件路径拼接');

    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const issued = verifyPassword({ stateDir: dir, password: GOOD, now: START + 1 });
    assert.equal(issued.ok, true);
    assert.equal(verifySession({ sessionToken: issued.sessionToken, now: START + 2 }).ok, true);
    assert.equal(verifySession({ sessionToken: issued.sessionToken, now: START + 2, namespace: 'qqspace' }).ok, false);
  });
});

test('namespace-04 同一 stateDir 下小黑盒保留旧文件名，QQ 空间使用独立凭据文件', async () => {
  await withTempDir((dir) => {
    assert.deepEqual(
      setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START }),
      { ok: true },
    );
    assert.deepEqual(
      setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START + 1, namespace: 'qqspace' }),
      { ok: true },
    );

    assert.equal(fs.existsSync(authFile(dir)), true, '旧调用仍使用原小黑盒文件名');
    assert.equal(fs.existsSync(qqspaceAuthFile(dir)), true, 'QQ 空间必须使用专属固定文件名');
    assert.equal(getAuthStatus({ stateDir: dir, now: START + 2 }).state, 'set');
    assert.equal(getAuthStatus({ stateDir: dir, now: START + 2, namespace: 'qqspace' }).state, 'set');
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 3 }).ok, true);
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 3, namespace: 'qqspace' }).ok, true);
  });
});

test('namespace-05 同目录支持不同密码，验证只读取对应 namespace 文件', async () => {
  await withTempDir((dir) => {
    const qqPassword = 'qqspace-independent-password';
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    setPassword({ stateDir: dir, password: qqPassword, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START + 1, namespace: 'qqspace' });

    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 2 }).ok, true);
    assert.equal(verifyPassword({ stateDir: dir, password: qqPassword, now: START + 3 }).reason, 'wrong-password');
    assert.equal(verifyPassword({ stateDir: dir, password: qqPassword, now: START + 4, namespace: 'qqspace' }).ok, true);
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 5, namespace: 'qqspace' }).reason, 'wrong-password');
  });
});

test('namespace-06 同目录下失败锁定只影响触发锁定的 namespace', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START + 1, namespace: 'qqspace' });
    for (let i = 0; i < 5; i += 1) {
      verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: START + 10 + i, namespace: 'qqspace' });
    }

    assert.equal(getAuthStatus({ stateDir: dir, now: START + 20, namespace: 'qqspace' }).state, 'locked');
    assert.equal(getAuthStatus({ stateDir: dir, now: START + 20 }).state, 'set');
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 21 }).ok, true);
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 22, namespace: 'qqspace' }).reason, 'locked');
  });
});

test('namespace-07 同目录下损坏态与忘记重置仅影响 QQ 空间凭据及其会话', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START + 1, namespace: 'qqspace' });
    const xhhSession = verifyPassword({ stateDir: dir, password: GOOD, now: START + 2 });
    const qqSession = verifyPassword({ stateDir: dir, password: GOOD, now: START + 3, namespace: 'qqspace' });

    fs.writeFileSync(qqspaceAuthFile(dir), '{ damaged qqspace state', 'utf8');
    assert.equal(getAuthStatus({ stateDir: dir, now: START + 4, namespace: 'qqspace' }).state, 'untrusted');
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 4, namespace: 'qqspace' }).reason, 'untrusted');
    const damagedQqState = fs.readFileSync(qqspaceAuthFile(dir));
    assert.deepEqual(
      setPassword({
        stateDir: dir,
        password: 'replacement-qqspace-password',
        consoleToken: CONSOLE_TOKEN,
        agentPaused: true,
        now: START + 4,
        namespace: 'qqspace',
      }),
      { ok: false, reason: 'state-untrusted' },
    );
    assert.deepEqual(fs.readFileSync(qqspaceAuthFile(dir)), damagedQqState, 'QQSpace 首设不得覆盖损坏状态');
    assert.equal(getAuthStatus({ stateDir: dir, now: START + 4 }).state, 'set');
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 4 }).ok, true);

    const reset = forgotResetPassword({
      stateDir: dir,
      password: 'qqspace-reset-password',
      consoleToken: CONSOLE_TOKEN,
      agentPaused: true,
      now: START + 5,
      namespace: 'qqspace',
    });
    assert.deepEqual(reset, { ok: true });
    assert.equal(verifySession({ sessionToken: qqSession.sessionToken, now: START + 6, namespace: 'qqspace' }).ok, false);
    assert.equal(verifySession({ sessionToken: xhhSession.sessionToken, now: START + 6 }).ok, true);
    assert.equal(verifyPassword({ stateDir: dir, password: 'qqspace-reset-password', now: START + 7, namespace: 'qqspace' }).ok, true);
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 8 }).ok, true);
  });
});

// ── 9. 落盘失败一律 persist-failed，不得假装成功 ────────────────────────
test('task86-22 auth 文件路径被目录占用 → 读失败 fail-closed：untrusted、拒绝写、拒绝验证', async () => {
  await withTempDir((dir) => {
    fs.mkdirSync(authFile(dir), { recursive: true });

    const set = setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    assert.deepEqual(set, { ok: false, reason: 'state-untrusted' });
    assert.equal(getAuthStatus({ stateDir: dir, now: START }).state, 'untrusted');
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START }).reason, 'untrusted');
    // 已在磁盘上占位的目录不被覆盖
    assert.equal(fs.statSync(authFile(dir)).isDirectory(), true);
  });
});

test('task86-23 setPassword 落盘失败 → persist-failed 且磁盘上没有新密码（不存内存假成功）', async () => {
  await withTempDir((dir) => {
    const set = setPassword({
      stateDir: dir,
      password: GOOD,
      consoleToken: CONSOLE_TOKEN,
      agentPaused: true,
      now: START,
      fsOps: failingFsOps,
    });
    assert.deepEqual(set, { ok: false, reason: 'persist-failed' });
    assert.equal(fs.existsSync(authFile(dir)), false, '落盘失败不得留下 auth 文件');
    assert.equal(getAuthStatus({ stateDir: dir, now: START }).state, 'unset');
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START }).reason, 'unset');
  });
});

test('task86-24 已设置后 forgotReset 落盘失败 → persist-failed；旧密码仍有效、旧会话不被废除', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const { sessionToken } = verifyPassword({ stateDir: dir, password: GOOD, now: START });
    const before = fs.readFileSync(authFile(dir));

    const reset = forgotResetPassword({
      stateDir: dir,
      password: 'another-good-password',
      consoleToken: CONSOLE_TOKEN,
      agentPaused: true,
      now: START + 1000,
      fsOps: failingFsOps,
    });
    assert.deepEqual(reset, { ok: false, reason: 'persist-failed' });
    assert.equal(sha256(fs.readFileSync(authFile(dir))), sha256(before));
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START + 2000 }).ok, true);
    assert.equal(verifySession({ sessionToken, now: START + 2000 }).ok, true);
  });
});

test('task86-25 验证成功路径落盘失败（计数清零写不进）→ persist-failed 且不发放会话', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const result = verifyPassword({ stateDir: dir, password: GOOD, now: START + 10, fsOps: failingFsOps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'persist-failed');
    assert.equal(result.sessionToken, undefined);
    // 计数器没被清零（文件没变），也绝不发送会话
    assert.equal(readAuthFile(dir).failedAttempts, 0);
  });
});

// ── 10. 不泄露敏感值 + 形状 ────────────────────────────────────────────
test('task86-26 返回值不泄露密码/哈希/salt/会话 token 之外的秘密；status 形状精确', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    const stored = readAuthFile(dir);

    const failures = [
      verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: START + 1 }),
      verifyPassword({ stateDir: dir, password: '', now: START + 2 }),
      getAuthStatus({ stateDir: dir, now: START + 3 }),
    ];
    const serialized = JSON.stringify(failures);
    assert.equal(serialized.includes(GOOD), false);
    assert.equal(serialized.includes(stored.salt), false);
    assert.equal(serialized.includes(stored.hash), false);
    assert.equal(serialized.includes(CONSOLE_TOKEN), false);

    assert.deepEqual(Object.keys(failures[2]).sort(), ['failedAttempts', 'lockedSeconds', 'lockedUntil', 'passwordSetAt', 'state']);
    assert.equal(failures[2].state, 'set');
    assert.equal(failures[1].reason, 'wrong-password');
    // 非字符串密码不是一次猜测：明确拒绝但不计入失败次数。
    const bad = verifyPassword({ stateDir: dir, password: 12345, now: START + 4 });
    assert.equal(bad.reason, 'invalid-password');
    assert.equal(bad.failedAttempts, failures[1].failedAttempts);
  });
});

test('task86-27 未设置时 forgotResetPassword 允许首次设置（等同 set），成功后状态 set', async () => {
  await withTempDir((dir) => {
    const reset = forgotResetPassword({
      stateDir: dir,
      password: GOOD,
      consoleToken: CONSOLE_TOKEN,
      agentPaused: true,
      now: START,
    });
    assert.deepEqual(reset, { ok: true });
    assert.equal(getAuthStatus({ stateDir: dir, now: START }).state, 'set');
    assert.equal(verifyPassword({ stateDir: dir, password: GOOD, now: START }).ok, true);
  });
});

test('task86-28 锁定期间 forgotResetPassword 仍可重设（唯一逃生通道），重设后恢复', async () => {
  await withTempDir((dir) => {
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START });
    for (let i = 0; i < 5; i += 1) verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: START + i });
    assert.equal(getAuthStatus({ stateDir: dir, now: START + 10 }).state, 'locked');

    const reset = forgotResetPassword({
      stateDir: dir,
      password: 'another-good-password',
      consoleToken: CONSOLE_TOKEN,
      agentPaused: true,
      now: START + 20,
    });
    assert.deepEqual(reset, { ok: true });
    assert.equal(getAuthStatus({ stateDir: dir, now: START + 30 }).state, 'set');
    assert.equal(verifyPassword({ stateDir: dir, password: 'another-good-password', now: START + 30 }).ok, true);
  });
});

test('task86-29 getAuthStatus 额外暴露 passwordSetAt / lockedUntil 毫秒时间戳（且 untrusted 不抛异常）', async () => {
  await withTempDir((dir) => {
    // 未设置：两个额外字段都是 null（而不是 0 / 缺字段），bridge 可安全 JSON 化。
    assert.deepEqual(getAuthStatus({ stateDir: dir, now: START }), {
      state: 'unset',
      lockedSeconds: 0,
      failedAttempts: 0,
      passwordSetAt: null,
      lockedUntil: null,
    });

    // 已设置：passwordSetAt 是写入时刻的毫秒时间戳，未锁定 lockedUntil 为 null。
    setPassword({ stateDir: dir, password: GOOD, consoleToken: CONSOLE_TOKEN, agentPaused: true, now: START + 7 });
    const setStatus = getAuthStatus({ stateDir: dir, now: START + 20 });
    assert.equal(setStatus.state, 'set');
    assert.equal(setStatus.passwordSetAt, START + 7);
    assert.equal(setStatus.lockedUntil, null);

    // 锁定：lockedUntil 是绝对毫秒时间戳，lockedSeconds 仍是相对差值（二者自洽）。
    for (let i = 0; i < 5; i += 1) verifyPassword({ stateDir: dir, password: 'wrong-password-1', now: START + 100 + i });
    const lockedStatus = getAuthStatus({ stateDir: dir, now: START + 104 + 1000 });
    assert.equal(lockedStatus.state, 'locked');
    assert.equal(lockedStatus.passwordSetAt, START + 7);
    assert.equal(lockedStatus.lockedUntil, START + 104 + 60 * 1000);
    assert.equal(lockedStatus.lockedSeconds, 59);

    // untrusted：不抛异常、两个额外字段为 null；忘记重设仍是唯一逃生通道（规格 §2.5 已确认的
    // 已知且被用户接受的绕过路径，不是遗漏）。
    fs.writeFileSync(authFile(dir), Buffer.from('{ not json', 'utf8'));
    const untrustedStatus = getAuthStatus({ stateDir: dir, now: START + 5000 });
    assert.equal(untrustedStatus.state, 'untrusted');
    assert.equal(untrustedStatus.passwordSetAt, null);
    assert.equal(untrustedStatus.lockedUntil, null);
    assert.deepEqual(
      forgotResetPassword({
        stateDir: dir,
        password: 'another-good-password',
        consoleToken: CONSOLE_TOKEN,
        agentPaused: true,
        now: START + 6000,
      }),
      { ok: true },
    );
    assert.equal(getAuthStatus({ stateDir: dir, now: START + 6001 }).state, 'set');
  });
});
