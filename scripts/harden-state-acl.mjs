// state/ 目录权限收紧的「可提权」入口。
//
// 为什么需要单独一个文件：
//   Windows 上收紧 ACL 需要对该目录有 WRITE_DAC。**正常情况下目录属主本来就有**，
//   所以这个脚本只是"设一次就走"，不会每次启动都弹 UAC；只有当系统策略把属主权限也收走、
//   或目录属于别的账户时，才会用 Start-Process -Verb RunAs 提权重试一次。
//
// 设计原则（必须是"零 bug 风险"的那种实用主义）：
//   1) 失败即降级：拿不到权限就打印一条可复制的命令然后**以 0 退出**，绝不阻断桥接启动。
//   2) 不消费参数：桥接进程是 `node src/bridge.js`，这里绝不能碰 process.argv 的语义。
//   3) 输出给人看：中文、直白、给出下一步。
//
// 用法：node scripts/harden-state-acl.mjs [--quiet]
//   --quiet 时只在真正做了事情/失败时输出（start.bat 用这个模式）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const quiet = process.argv.includes('--quiet');
// 被自己提权拉起时不带 --quiet（子进程用的是 --elevated --quiet），带上这个标记可以
// 让提权后的这一次**不再尝试提权**，从结构上杜绝递归。
const isElevatedRun = process.argv.includes('--elevated');

function say(msg) { if (!quiet) console.log(msg); }
function sayAlways(msg) { console.log(msg); }

function icacls(args) {
  return spawnSync('icacls', args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
}

/** 目录权限是否已经收紧（继承来的 ACE 带 (I) 标记，收紧后消失）。 */
function isHardened() {
  if (process.platform !== 'win32') {
    try { return (fs.statSync(STATE_DIR).mode & 0o077) === 0; } catch { return false; }
  }
  const res = icacls([STATE_DIR]);
  if (res.error || res.status !== 0) return false;
  return !/\(I\)/.test(res.stdout ?? '');
}

function manualCommand() {
  return process.platform === 'win32'
    ? `icacls "${STATE_DIR}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F" /grant:r "Administrators:(OI)(CI)F" /T /C`
    : `chmod -R go-rwx "${STATE_DIR}"`;
}

/** 直接尝试；返回 { ok, detail }。 */
function tryHarden() {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(STATE_DIR, 0o700); return { ok: true, detail: 'chmod 700' }; }
    catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
  }
  const user = process.env.USERNAME;
  if (!user) return { ok: false, detail: '无法确定当前用户名（%USERNAME% 为空）' };
  // /C 会让 icacls"继续处理剩下的文件"，即使全失败退出码仍为 0 —— 所以必须看输出。
  const res = icacls([
    STATE_DIR,
    '/inheritance:r',
    '/grant:r', `${user}:(OI)(CI)F`,
    '/grant:r', 'SYSTEM:(OI)(CI)F',
    '/grant:r', 'Administrators:(OI)(CI)F',
    '/T', '/C', '/Q'
  ]);
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  if (res.error) return { ok: false, detail: res.error.message };
  if (/Failed processing\s+[1-9]/i.test(out) || /access is denied/i.test(out)) {
    return { ok: false, detail: out.split('\n').filter(Boolean).slice(-3).join(' / ') };
  }
  return { ok: true, detail: 'icacls' };
}

/** 用 UAC 提权跑一次自己，然后回读确认。返回 { ok, detail }。 */
function elevateAndRetry() {
  if (process.platform !== 'win32') return { ok: false, detail: '非 Windows 平台不需要提权' };
  const script = fileURLToPath(import.meta.url);
  // -Wait 让父进程等到子进程结束；用户点"否"时 Start-Process 会抛错，这里要吞掉。
  const ps = [
    '$ErrorActionPreference = "Stop";',
    'try {',
    `  Start-Process -FilePath "${process.execPath}" -ArgumentList @("${script}","--elevated","--quiet") -Verb RunAs -Wait -WindowStyle Hidden;`,
    '  exit 0',
    '} catch { exit 2 }'
  ].join(' ');
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true
  });
  if (res.error) return { ok: false, detail: `无法启动提权进程：${res.error.message}` };
  if (res.status === 2) return { ok: false, detail: '用户取消了 UAC 提权' };
  if (isHardened()) return { ok: true, detail: '提权后已收紧' };
  return { ok: false, detail: res.status === 0 ? '提权进程结束但权限仍未收紧' : `提权进程退出码 ${res.status}` };
}

if (!fs.existsSync(STATE_DIR)) {
  say(`[harden-acl] state/ 还不存在（首次启动时桥接会创建并自行收紧）：${STATE_DIR}`);
  process.exit(0);
}

if (isHardened()) {
  say(`[harden-acl] state/ 权限已收紧，无需处理：${STATE_DIR}`);
  process.exit(0);
}

sayAlways('[harden-acl] state/ 权限未收紧：其中的控制台令牌、SnowLuma 令牌、各会话令牌与 QQ 聊天记录，本机任何已登录用户都可能读到。');
sayAlways(`[harden-acl] 正在尝试收紧：${STATE_DIR}`);

let result = tryHarden();
if (!result.ok && !isElevatedRun) {
  sayAlways(`[harden-acl] 直接收紧失败（${result.detail}），改用管理员权限重试（会弹出 UAC 确认框）…`);
  result = elevateAndRetry();
}

if (result.ok) {
  sayAlways('[harden-acl] ✅ 已收紧 state/ 权限（只保留当前用户 / SYSTEM / Administrators）。');
  process.exit(0);
}

// 失败是**可接受**的：桥接照常启动，只是在控制台「访问与安全」页会显示告警。
sayAlways(`[harden-acl] ⚠️ 未能收紧（${result.detail}）。桥接仍会正常启动，但这台机器上的其他登录用户可能读到 state/ 里的令牌与聊天记录。`);
sayAlways('[harden-acl] 你可以手动执行下面这条命令（管理员终端，一次即可）：');
sayAlways(`             ${manualCommand()}`);
process.exit(0);
