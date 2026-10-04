// 守护自愈回归（离线、临时目录、桩进程）—— 2026-10-04 21:16 事故的钉子。
//
// 事故：桥接以 exit 2 退出（src/bridge.js 判定「已有实例 / 控制台端口被占」）后，
//   start.bat 走 `pause` + `exit /b 2`：守护窗口自己也退出了 —— 而它是唯一会把
//   桥接重新拉起来的东西，于是机器人离线约 21 分钟，直到有人发现。
// t19 补掉「只修了一半」：exit 2 分支已有 `if errorlevel 1 ping` 兜底，但相邻的
//   「非 0 非 2 退出码 → 5s 后重试」分支当时只有裸 `timeout /t 5 /nobreak` ——
//   timeout 在 stdin 非控制台时立刻失败返回（"Input redirection is not supported"，
//   ~0.03s、exit 1），等于「等 5 秒」一秒都没等。两个等待分支现在是一眼同一种写法。
//
// 本脚本把 start.bat 复制到**临时目录**，配「第一轮按指定退出码退出、之后常驻」的桩
// src/bridge.js 与桩 scripts/harden-state-acl.mjs，跑**两个**用例：
//   A) 第一轮 exit 2、之后常驻 → exit 2 分支仍有界等待（15~30s）后重新拉起；
//   B) 第一轮 exit 1（非 0 非 2）、之后常驻 → 5s 重试分支**真的等了**（3~12s）且重新拉起。
//      每个用例都会打印一行 `⏱ … 第二轮间隔实测 Nms`，方便与改动前的 start.bat 对照
//      （改动前 B 在这套非控制台 stdin 环境下近乎 0 秒）。
// 另有静态契约：启动命令逐字节、两个分支都带 ping 兜底、没有 pause / exit /b 2 等。
//
// 绝不触碰线上：桩进程只读写临时目录、不做任何网络 I/O，因此不会碰 3100 / 3000 /
//   3001 / 5099 端口，也不会杀任何已存在的进程；清理时只 taskkill 自己拉起的 cmd 树。
//   脚本 50s 硬超时（两个用例合计约 28s：20s + 5s + 断言开销）。
//
// 用法：
//   node scripts/test-start-guard.mjs                    # 测仓库当前的 start.bat
//   node scripts/test-start-guard.mjs <别的 start.bat>    # 对照（例：改动前的备份）
// 环境变量 KEEP_TMP=1 时保留临时目录以便人工查看。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OVERALL_TIMEOUT_MS = 50_000; // 硬超时保护（脚本必须在 60s 内结束）
const WAIT_MIN_MS = 14_000;        // 契约：exit 2 后有界等待 15~30s（下界留 1s 容差）
const WAIT_MAX_MS = 35_000;        // 上界：不许卡死（timeout 失效时 ping 兜底约 20s）
const FIVE_WAIT_MIN_MS = 3_000;    // 5s 分支：改动前近乎 0（timeout 在管道 stdin 下立刻失败）
const FIVE_WAIT_MAX_MS = 12_000;   // 上界：不许卡死（ping -n 6 兜底约 5s）
const POLL_MS = 150;

let failed = 0;
const check = (cond, label, extra = '') => {
  if (cond) console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`);
  else { failed += 1; console.error(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const batPath = path.resolve(process.argv[2] || path.join(ROOT, 'start.bat'));

// ── 1. 静态契约：两个等待分支的原文 ─────────────────────────────────────────
console.log(`## 静态契约（${batPath}）`);
const raw = fs.readFileSync(batPath);
const text = raw.toString('utf8');
// 注释要排除掉：老分支的说明里就写着 "pause" + "exit /b 2"，
// 不剥离 rem 行会把「历史说明」误判成「现行代码」。
const code = text.split(/\r?\n/).filter((l) => !/^\s*rem\b/i.test(l)).join('\n');

check(!/[^\x00-\x7f]/.test(text), 'start.bat 仍是纯 ASCII（cmd 按本地代码页解码批处理）');
check(!/(?<!\r)\n/.test(raw.toString('latin1')), 'start.bat 仍用 CRLF 换行（裸 LF 会拆坏多行块）');
check(!/^\s*pause\b/im.test(code), '守护里没有 pause（不再停在「按任意键」）');
// 启动命令逐字节比对（改动前就是 `node src/bridge.js`：正斜杠，cmd/node 都认；
// 用字符串比较而不是正则，避免把「换个写法也算过」这种假绿灯放进来）。
const launchLine = text.split('\n').map((l) => l.replace(/\r$/, '')).find((l) => l.startsWith('node src'));
check(launchLine === 'node src/bridge.js', '启动命令仍是改动前的 node src/bridge.js（逐字节一致）', launchLine);
check(/node scripts\\harden-state-acl\.mjs/.test(code), '仍调用 scripts\\harden-state-acl.mjs');
check(!/restart\.bat/i.test(code), '没有借道 restart.bat');

const busyAt = code.lastIndexOf(':bridge-busy');
const busy = busyAt >= 0 ? code.slice(busyAt) : '';
check(busyAt >= 0, '有专门的 exit 2 守护分支');
check(/goto loop/.test(busy), 'exit 2 分支最终 goto loop（重新拉起桥接）');
check(busyAt >= 0 && !/exit \/b/i.test(busy), 'exit 2 分支不再 exit /b 2（守护不再自杀）');
check(/echo \[%date% %time%\]/.test(busy), 'exit 2 分支打印含时间戳的日志');
check(/timeout \/t (1[5-9]|2\d|30) \/nobreak/.test(busy), 'exit 2 分支等待 15~30s（有界，不是 5s 空转刷屏）');
check(/ping -n \d+ 127\.0\.0\.1/.test(busy), 'timeout 失效时有 ping 兜底（等待必须真的发生）');
check(/code %code%\), restarting in 5 seconds/.test(code) && /timeout \/t 5 \/nobreak/.test(code),
  '非 0 非 2 的退出码仍是 5s 后重试（原逻辑，含退出码 0 的落空行为）');

// t19：5s 重试分支过去只有裸 `timeout /t 5` —— stdin 非控制台时它立刻返回，
// 于是「等 5 秒」实际一秒没等。两个分支的兜底必须写得一模一样。
const codeLines = code.split('\n');
const fiveAt = codeLines.findIndex((l) => /restarting in 5 seconds/.test(l));
const busyLine = codeLines.findIndex((l) => /^:bridge-busy/i.test(l));
const five = (fiveAt >= 0 && busyLine > fiveAt) ? codeLines.slice(fiveAt, busyLine).join('\n') : '';
const pingFallback = (block) => (block.match(/^\s*if errorlevel 1 ping -n \d+ 127\.0\.0\.1 >nul\s*$/m) || [''])[0].trim();
const fivePing = pingFallback(five);
const busyPing = pingFallback(busy);
check(fiveAt >= 0 && five !== '', '有非 0 非 2 的 5s 重试分支（切片非空）');
check(/goto loop/.test(five), '5s 分支最终 goto loop（继续拉起桥接）');
check(fivePing !== '' && busyPing !== '', '两个等待分支都带 `if errorlevel 1 ping …` 兜底',
  `5s=${fivePing || '(缺)'} | busy=${busyPing || '(缺)'}`);
check(fivePing !== '' && fivePing.replace(/ping -n \d+/, 'ping -n N') === busyPing.replace(/ping -n \d+/, 'ping -n N'),
  '两个分支的兜底写法一致（只有 ping 次数按等待秒数不同）', `5s=${fivePing} | busy=${busyPing}`);

// ── 2. 桩进程 ───────────────────────────────────────────────────────────────
// 桩桥接：第一轮按 firstExitCode 退出（模拟「已有实例 / 端口被占 / 崩溃」），第二轮起常驻
// 直到测试把它连同 cmd 树一起清掉。只写临时目录里的文件，不开任何端口。
const makeStubBridge = (dir, firstExitCode, firstRoundNote) => {
  fs.writeFileSync(path.join(dir, 'src', 'bridge.js'), [
    "'use strict';",
    "// 桩：只记录「第几轮被拉起」，绝不联网、绝不碰真实 state/。",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const out = path.join(__dirname, '..', 'launches.jsonl');",
    "let rounds = 0;",
    "try { rounds = fs.readFileSync(out, 'utf8').split('\\n').filter(Boolean).length; } catch {}",
    "const round = rounds + 1;",
    "fs.appendFileSync(out, JSON.stringify({ round: round, at: Date.now(), pid: process.pid, cwd: process.cwd() }) + '\\n');",
    "console.log('[stub-bridge] launch #' + round);",
    "if (round === 1) {",
    `  console.log('[stub-bridge] ${firstRoundNote}');`,
    `  process.exit(${firstExitCode});`,
    "}",
    "console.log('[stub-bridge] second launch: holding this round open (the test will kill me)');",
    "setTimeout(function () { process.exit(0); }, 120000);",
    '',
  ].join('\n'));
};

// 桩 ACL 加固：真实脚本会改 state/ 的 ACL，回归里绝不能跑真的，只记一笔调用证据。
const makeStubHarden = (dir) => {
  fs.writeFileSync(path.join(dir, 'scripts', 'harden-state-acl.mjs'), [
    "import fs from 'node:fs';",
    "fs.appendFileSync(new URL('../harden-called.txt', import.meta.url), 'called ' + new Date().toISOString() + ' args=' + process.argv.slice(2).join(' ') + '\\n');",
    "console.log('[stub-harden] called');",
    '',
  ].join('\n'));
};

let currentChild = null;
let lastStdout = '';
let lastStderr = '';

const killTree = () => {
  const child = currentChild;
  if (!child || child.exitCode !== null || child.signalCode) return; // 已退出：绝不对回收后的 PID 动手
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
};

const readLaunches = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
};
// 失败时把最后几行原文打出来：批处理的语法错会走 stderr，光看 stdout 会以为「什么都没发生」。
const tail = (s, n) => s.split(/\r?\n/).filter(Boolean).slice(-n).map((l) => '       ' + l).join('\n');
const retryLine = (s, codeNum) => ((s.match(new RegExp(`\\[[^\\]]*\\]\\s*bridge exited \\(code ${codeNum}\\)[^\\r\\n]*`)) || [''])[0]).trim();

// 全局硬超时：两个用例共用一份预算，保证整个脚本在审计的 60s 上限内自杀式收尾。
const watchdog = setTimeout(() => {
  console.error(`  ❌ ${OVERALL_TIMEOUT_MS}ms 硬超时：守护没有在预算内出现预期行为`);
  killTree();
  console.error('     最后 20 行输出：\n' + tail(lastStdout, 20));
  if (lastStderr.trim()) console.error('     stderr 尾部：\n' + tail(lastStderr, 20));
  process.exit(1);
}, OVERALL_TIMEOUT_MS);

async function runScenario({ label, firstExitCode, firstRoundNote, minGapMs, maxGapMs, windowText, budgetMs, retryPattern, retryLabel, expectHolding }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-start-guard-'));
  const launchesFile = path.join(tmp, 'launches.jsonl');
  const hardenFile = path.join(tmp, 'harden-called.txt');
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.mkdirSync(path.join(tmp, 'scripts'));
  fs.copyFileSync(batPath, path.join(tmp, 'start.bat'));
  makeStubBridge(tmp, firstExitCode, firstRoundNote);
  makeStubHarden(tmp);

  console.log(`## 用例 ${label}（临时目录 ${tmp}）`);
  let stdout = '';
  let stderr = '';
  let guardExit = null;
  try {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start.bat'], {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin=NUL：老脚本的 pause 会立即返回，不会挂住
      windowsHide: true,
    });
    currentChild = child;
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); lastStdout = stdout; });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); lastStderr = stderr; });
    child.on('exit', (c, s) => { guardExit = { code: c, signal: s }; });

    const deadline = Date.now() + budgetMs;
    let launches = [];
    while (Date.now() < deadline) {
      launches = readLaunches(launchesFile);
      if (launches.length >= 2 || guardExit) break; // 出现第二轮，或守护自己退了（= 自杀）
      await sleep(POLL_MS);
    }
    launches = readLaunches(launchesFile); // 收尾再读一次：避免刚好卡在轮询间隙
    // 桩的 stdout 是异步管道来的：launches.jsonl 一落盘就 break，此时 echo 行可能还没到手。
    // 给它一个短的落地窗口，再做 stdout 断言（不放松断言，只是不让「读到几毫秒」决定成败）。
    await sleep(250);
    check(launches.length >= 2, `${label} 之后仍出现第二轮拉起（守护没有自我终止）`, `拉起次数=${launches.length}`);
    if (launches.length >= 2) {
      const gap = launches[1].at - launches[0].at;
      console.log(`  ⏱ ${label}：第二轮间隔实测 ${gap}ms（窗口 ${minGapMs}~${maxGapMs}ms）`);
      check(gap >= minGapMs && gap <= maxGapMs, `${label} → 第二轮之间是有界等待（${windowText}）`, `${gap}ms`);
      check(launches[1].cwd === tmp, '第二轮桩桥接跑在临时目录里（没有碰线上工作区）', launches[1].cwd);
    } else {
      check(false, `${label} → 第二轮之间是有界等待（${windowText}）`, '没有第二轮，测不到间隔');
      check(false, '第二轮桩桥接跑在临时目录里（没有碰线上工作区）', '没有第二轮');
    }
    check(guardExit === null, '断言时守护仍在运行（cmd 没有退出）',
      guardExit ? `cmd 已退出 code=${guardExit.code}${guardExit.signal ? ' signal=' + guardExit.signal : ''}` : 'cmd 仍在等待桩桥接');
    if (guardExit) {
      console.error('     守护提前退出了 —— 这正是改动前 start.bat 的行为（pause + exit /b 2）。');
      console.error('     输出尾部：\n' + tail(stdout, 8));
      if (stderr.trim()) console.error('     stderr 尾部：\n' + tail(stderr, 8));
    }

    check(retryPattern.test(stdout), retryLabel, retryLine(stdout, firstExitCode));
    check(!/Press any key/i.test(stdout), '输出里没有 pause 的 "Press any key"');
    check(/\[stub-harden\] called/.test(stdout), '启动链仍调用 harden-state-acl.mjs（桩输出可见）');
    const hardenCalls = fs.existsSync(hardenFile) ? fs.readFileSync(hardenFile, 'utf8').split('\n').filter(Boolean).length : 0;
    check(hardenCalls === 1, 'harden-state-acl.mjs 恰好被调用一次', `调用记录=${hardenCalls} 行`);
    if (expectHolding) {
      // 「第二轮里还活着」由桩自己打的 holding 日志证明：等它最多 2s（有界），不是靠运气。
      const holdUntil = Date.now() + 2_000;
      while (Date.now() < holdUntil && !/\[stub-bridge\] second launch: holding this round open/.test(stdout)) {
        await sleep(POLL_MS);
      }
      check(/\[stub-bridge\] second launch: holding this round open/.test(stdout),
        '第二轮桩桥接确实存活（打出了 holding 日志）');
    }
  } catch (error) {
    check(false, '回归执行未抛异常', String(error && error.message));
  } finally {
    killTree();
    currentChild = null;
    await sleep(300);
    if (process.env.KEEP_TMP === '1') console.log(`  KEEP_TMP=1：保留 ${tmp}`);
    else { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  }
}

// ── 3. 用例 A：exit 2 → exit 2 分支的有界等待（15~30s，ping 兜底约 20s）──────
await runScenario({
  label: 'exit 2',
  firstExitCode: 2,
  firstRoundNote: 'simulating another instance / busy console port -> exit 2',
  minGapMs: WAIT_MIN_MS,
  maxGapMs: WAIT_MAX_MS,
  windowText: '15~30s',
  budgetMs: 26_000,
  retryPattern: /\[[^\]]*\]\s*bridge exited \(code 2\): another instance or the console port is in use; retrying in 20 seconds/,
  retryLabel: '日志里有「时间戳 + code 2 + 重试」一行',
  expectHolding: false,
});

// ── 4. 用例 B：exit 1（非 0 非 2）→ 5s 重试分支必须真的等（3~12s，t19）────────
await runScenario({
  label: 'exit 1',
  firstExitCode: 1,
  firstRoundNote: 'simulating a non-2 failure (crash / anything else) -> exit 1',
  minGapMs: FIVE_WAIT_MIN_MS,
  maxGapMs: FIVE_WAIT_MAX_MS,
  windowText: '3~12s',
  budgetMs: 13_000,
  retryPattern: /\[[^\]]*\]\s*bridge exited \(code 1\), restarting in 5 seconds/,
  retryLabel: '日志里有「时间戳 + code 1 + 5s 后重试」一行',
  expectHolding: true,
});

clearTimeout(watchdog);
console.log('');
if (failed === 0) console.log('守护自愈回归：全部断言通过 ✅（用例 2：exit 2 / exit 1）');
else console.error(`守护自愈回归：${failed} 条断言失败 ❌`);
process.exitCode = failed ? 1 : 0;
