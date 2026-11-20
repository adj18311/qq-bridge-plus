#!/usr/bin/env node
// 任务卡 §6「同时提供本地管理员脚本作为备用恢复入口」的可执行入口。
//
// 之前只有 `src/core/qzone-admin-offline.mjs` 这个模块（configure/reset/restore 三个函数，
// 各自在**同一个 store.update 事务里**写审计），没有可以直接跑的命令行。这个文件补的就是那一层：
// 参数校验 → 业务前置条件 → 调用模块 → 退出码。**业务逻辑一行都不在这里重写。**
//
// ── 为什么 `--db` 没有默认值 ───────────────────────────────────────────────────────────
// 这是刻意的安全决定，不是漏写：默认值意味着「不带参数跑一下」就可能作用在真实
// `state/` 目录上。管理员恢复是危险操作（会解除熔断、重置配额），所以路径必须由人显式给出。
// 缺 `--db` 一律按参数错误处理（退出码 2），并在 stderr 说明原因。
//
// 同样出于安全：**`status` 与 `--dry-run` 不会创建数据库文件。** 目标文件必须已经存在，
// 否则退出码 2。`openOfflineStore` 在文件缺失时会用 initial 建库 —— 那是一次落盘，
// 只读路径绝不能触发它，所以这里先 `existsSync` 再打开。
//
// ── 退出码（对外契约，改它等于改接口）────────────────────────────────────────────────
//   0  成功（含 dry-run：计划已打印、未落盘）
//   1  业务拒绝：缺/非法 `--operator`；要求恢复的那一层根本没有暂停；
//      模块在执行中拒绝（例如审计 id 冲突、状态非法）
//   2  参数错误：缺 `--db`、数据库文件不存在、未知子命令/未知参数、`--layer`/`--kind`
//      /`--reason`/`--target` 取值非法、缺少必填参数
//
// ── 审计怎么保证 ───────────────────────────────────────────────────────────────────
// 不在这里写审计行。`restoreOfflinePause` / `resetOfflineQuota` 内部通过
// `appendOfflineAudit` 在**同一个事务**里写一条 `source:'admin_script'` 的审计，包含
// operator / time / action / pauseScope / result。本 CLI 只负责提供合法的 actor：
//   · `operator` 必须匹配审计模块的 ID 字符集（`[A-Za-z0-9_-]{1,128}`）——非法即拒绝（1），
//     因为 `formatAuditRecord` 会直接抛错，让它在事务里抛会留下难解释的失败；
//   · `target` 必须是纯数字串（`formatAuditRecord` 的硬约束），取 `--target`，
//     否则回退到状态里的 `botQq` / `selfId`；两者都拿不到就按参数错误处理（2）；
//   · `source` 固定 `admin_script`（任务卡 §6 的本地脚本入口身份）；
//   · `auditId` 每次唯一，重复会让模块抛 `duplicate audit id`。
// `pauseScope` 由模块从**事务内读到的真实状态**推导，不接受 CLI 传入 —— 少一个能说谎的输入。
//
// ── restore 的业务前置条件 ─────────────────────────────────────────────────────────
// 「未暂停却要恢复」是任务卡意义上的无意义操作，按业务拒绝处理（退出码 1）且零改动：
//   · `--layer access` 要求 `accessPaused === true`
//   · `--layer write`  要求 `writePaused === true`
//   · `--layer both`   要求**至少一层**处于暂停（两层都已解除时拒绝）
// 先拒绝再调模块，因此被拒时不会产生审计行、也不会有任何状态变化。
//
// 用法：
//   node scripts/qzone-admin-cli.mjs status      --db <path>
//   node scripts/qzone-admin-cli.mjs restore      --db <path> --layer access|write|both
//                                                 --operator <name> [--reason <vocab>] [--target <qq>] [--dry-run]
//   node scripts/qzone-admin-cli.mjs reset-quota  --db <path> --kind post|comment|like
//                                                 --operator <name> [--reason <vocab>] [--target <qq>] [--dry-run]
//   node scripts/qzone-admin-cli.mjs audit-export --db <已有数据库> --out <显式导出目录>
//                                                 --namespace <稳定命名空间> [--dry-run]
//
// ── audit-export 为什么单独一条 ────────────────────────────────────────────────────────
// 它把 SQLite 的 `state.audit` 投影成 JSONL（规则全在 `createAuditExporter`，这里只做接线）。
// 三条与安全相关的决定：
//   · **源库用只读连接打开**（`openOfflineStoreReadOnly`）。本文件其它子命令需要写事务，所以它们
//     用 `openOfflineStore`；导出不需要写，就不能借「反正只调 read」来含糊其构造阶段建表的副作用。
//     缺文件/缺 state 表/缺行一律拒绝（退出码 2），绝不初始化。
//   · **三个参数无默认值**：`--db`/`--out`/`--namespace` 都必须显式给，且不发现官方
//     `state/``config` 路径。namespace 由本地操作者给定、必须稳定（不能用时钟或随机数）。
//   · **`--dry-run` 只调 `status()`**：不 mkdir、不 append、不 prune、不建源库。
// 它不写审计行 —— 导出是只读投影，不是一次管理员**改动**，因此没有 actor/operator 参数；
// 命令行传来的 operator 字符串也不会被当成新的身份认证。

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openOfflineStore, openOfflineStoreReadOnly } from '../src/core/qzone-store-offline.mjs';
import {
  restoreOfflinePause,
  resetOfflineQuota,
} from '../src/core/qzone-admin-offline.mjs';
import { createAuditJsonl, createAuditExporter } from '../src/core/qzone-audit-jsonl-offline.mjs';

export const EXIT = Object.freeze({ OK: 0, REFUSED: 1, USAGE: 2 });

const SUBCOMMANDS = Object.freeze(['status', 'restore', 'reset-quota', 'audit-export']);
const WRITE_SUBCOMMANDS = Object.freeze(['restore', 'reset-quota']);
/** 需要 --out / --namespace 的只读导出子命令。不是写命令：不改源库状态、不写审计行。 */
const EXPORT_SUBCOMMANDS = Object.freeze(['audit-export']);
const LAYERS = Object.freeze(['access', 'write', 'both']);
const KINDS = Object.freeze(['post', 'comment', 'like']);
/** 与 `formatAuditRecord` 的 REASONS 词表保持一致；CLI 层先校验，免得在事务里抛。 */
const AUDIT_REASONS = Object.freeze(['', 'network', 'not_accessible', 'login_expired', 'captcha',
  'rate_limit', 'quota', 'timeout', 'platform_error', 'policy', 'other']);
/** 与 `isSafeQzoneAuditId` 的字符集保持一致。 */
const AUDIT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGITS = /^\d{1,20}$/;

/** 参数错误：携带给调用者的消息，不打印、不抛。 */
class UsageError extends Error {}
/** 业务拒绝。 */
class RefusedError extends Error {}

const ALLOWED_FLAGS = Object.freeze({
  status: ['--db'],
  restore: ['--db', '--layer', '--operator', '--reason', '--target', '--dry-run'],
  'reset-quota': ['--db', '--kind', '--operator', '--reason', '--target', '--dry-run'],
  'audit-export': ['--db', '--out', '--namespace', '--dry-run'],
});

/** namespace 与 exporter 的约束一致：由操作者给定、跨重启稳定。 */
const NAMESPACE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 严格解析参数：未知 flag、重复 flag、缺值、位置参数一律按参数错误处理。
 * 不做「猜意图」的容错 —— 恢复操作上任何猜测都可能作用在错误的对象上。
 */
function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new UsageError('缺少子命令；可用：status / restore / reset-quota');
  const [subcommand, ...rest] = argv;
  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new UsageError(`未知子命令 ${JSON.stringify(subcommand)}；可用：status / restore / reset-quota`);
  }
  const allowed = ALLOWED_FLAGS[subcommand];
  const values = Object.create(null);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new UsageError(`多余的位置参数 ${JSON.stringify(token)}；所有参数都必须写成 --key value（--dry-run 除外）`);
    }
    if (!allowed.includes(token)) {
      throw new UsageError(`子命令 ${subcommand} 不接受参数 ${token}；可用：${allowed.join(' / ')}`);
    }
    if (Object.hasOwn(values, token)) throw new UsageError(`参数 ${token} 重复出现`);
    if (token === '--dry-run') { values[token] = true; continue; }
    const value = rest[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new UsageError(`参数 ${token} 缺少取值`);
    }
    values[token] = value;
    index += 1;
  }
  return { subcommand, flags: values };
}

const pauseScopeOf = (state) => (state?.accessPaused
  ? (state?.writePaused ? 'both' : 'access')
  : (state?.writePaused ? 'write' : 'none'));

const line = (key, value) => `${key}: ${value}\n`;

function describeState(state) {
  const ledger = state?.ledger;
  const used = ledger?.used ?? {};
  return [
    line('accessPaused', state?.accessPaused === true),
    line('writePaused', state?.writePaused === true),
    line('pauseScope', pauseScopeOf(state)),
    line('probe', state?.probe ?? null),
    line('ledger.day', ledger?.day ?? null),
    line('ledger.used.post', used.post ?? null),
    line('ledger.used.comment', used.comment ?? null),
    line('ledger.used.like', used.like ?? null),
    line('auditRows', Array.isArray(state?.audit) ? state.audit.length : null),
  ].join('');
}

/**
 * 用户可见的故障描述。**只**输出受控类别 + 已校验的 identity + 进度。
 *
 * ⚠️ 这里绝不拼 `result.error`。实测反例：把 `state.value` 设成一段非 JSON 的合成串，
 * `JSON.parse` 抛的 message **自带源串片段**（`Unexpected token 'S', "SYNTHETIC_"... is not valid JSON`），
 * 直接透传就等于把源内容打到 stdout/stderr。所以：
 *   · `failureCode` 是闭集，未知一律折叠成 `internal-error`；
 *   · `failedAuditId` / `failedDay` 先按形状校验再用，不被信任为任意字符串；
 *   · 不打印 stack / cause / 任意异常原文。
 * 这是**结构性**保证（根本拿不到原文），不是靠关键词正则遮挡。
 */
const FAILURE_CODE = Object.freeze({
  STORE_UNREADABLE: 'store-unreadable',
  STORE_SHAPE_INVALID: 'store-shape-invalid',
  DAY_FILE_UNREADABLE: 'day-file-unreadable',
  DAY_FILE_CONFLICT: 'day-file-conflict',
  SOURCE_ROW_REJECTED: 'source-row-rejected',
  SOURCE_ROWS_CONFLICT: 'source-rows-conflict',
  EXPORT_CONFLICT: 'export-conflict',
  APPEND_FAILED: 'append-failed',
});
const KNOWN_CODES = new Set(Object.values(FAILURE_CODE));
/**
 * 与 exporter 的 auditId 形状**逐字一致**；不合格就不显示（宁可少说，也不吐出可疑文本）。
 *
 * 为什么要跟 exporter 走：这里的判据只决定「要不要把 failedAuditId 打出来」，但它是那份
 * 正则的**第二份拷贝**。导出器在 2026-11-19（commit 43c597d）把 id 放宽成「1 段或 2 段」，
 * 因为生产里真实存在 read:<32hex> 这种带冒号的 id，拼成 plugin:read:<hex> 就变成两个冒号。
 * 拷贝不同步的后果：一个**合法**的失败 id 因为本文件的正则过旧而被静默吞掉，
 * 排障时看到的是「只有 code= 没有 at=」，会误以为导出器没给出 id。
 *
 * 形状来源：src/core/qzone-audit-jsonl-offline.mjs 的 AUDIT_ID.shape。
 * 这里仍是**独立常量**而不是从那个模块 import —— 那个人工 CLI 只读库、不跑导出器，
 * 为一个纯展示用的判据把整个导出器（含 node:sqlite 依赖）拖进来不划算。
 * 代价是两处必须同步；test-qzone-admin-cli.mjs 里有一条断言比对两者，防它们再次漂移。
 */
const EXPORT_AUDIT_ID = /^[A-Za-z0-9_-]{1,64}:(?:[A-Za-z0-9_-]{1,128}|[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128})$/;
/** 供测试比对「两份拷贝是否漂移」；运行时唯一使用者是本文件内的 describeExportFailure。 */
export const __TEST_ONLY_EXPORT_AUDIT_ID = EXPORT_AUDIT_ID;
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Controlled category for "cannot open the source read-only".
 *
 * These three messages come from OUR OWN guards or from SQLite's fixed vocabulary, so matching them is
 * classification of a closed set — the OUTPUT is still a fixed token, never the exception text.
 */
function describeOpenFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/missing state table/i.test(message)) return FAILURE_CODE.STORE_SHAPE_INVALID;
  if (/missing state|invalid state/i.test(message)) return FAILURE_CODE.STORE_SHAPE_INVALID;
  if (/unable to open|ENOENT|no such file/i.test(message)) return FAILURE_CODE.STORE_UNREADABLE;
  return 'internal-error';
}

/** Controlled category for any other throw on the export path. Unknown ⇒ 'internal-error'. */
function describeCaught(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/is not valid JSON|JSON/i.test(message)) return FAILURE_CODE.STORE_UNREADABLE;
  if (/invalid audit record/i.test(message)) return FAILURE_CODE.SOURCE_ROW_REJECTED;
  if (/audit array/i.test(message)) return FAILURE_CODE.STORE_SHAPE_INVALID;
  return 'internal-error';
}

/** 把一个失败结果压成白名单字段。未知类别 ⇒ 'internal-error'，绝不带出任何原文。 */
function describeExportFailure(result) {
  const raw = result && typeof result === 'object' ? result : {};
  const code = KNOWN_CODES.has(raw.failureCode) ? raw.failureCode : 'internal-error';
  const parts = [`code=${code}`];
  if (typeof raw.failedAuditId === 'string' && EXPORT_AUDIT_ID.test(raw.failedAuditId)) {
    parts.push(`at=${raw.failedAuditId}`);
  }
  if (typeof raw.failedDay === 'string' && DAY_NAME.test(raw.failedDay)) {
    parts.push(`day=${raw.failedDay}`);
  }
  return parts.join(' ');
}

/**
 * `audit-export`：把 `state.audit` 投影到显式目录。
 *
 * 只使用 `createAuditExporter` 的现有语义，不重写导出规则。退出码沿用 0/1/2：
 *   · 2 —— `--db`/`--out`/`--namespace` 缺失或非法、源库不存在/不可读/缺 state
 *   · 1 —— 导出本身失败（部分已导出随后失败也算非零，并保留进度与 failedAuditId）
 *   · 0 —— 全部成功（含 dry-run：只打印计划）
 *
 * 不改源库业务状态：源用只读连接打开，且导出器本身只调 `read()`。
 */
async function runAuditExport(flags, dbAbsolute, { stdout, stderr }) {
  const outRaw = flags['--out'];
  const namespace = flags['--namespace'];

  if (typeof outRaw !== 'string' || !outRaw) {
    stderr('参数错误：audit-export 必须显式传 --out <导出目录>；本工具不提供默认输出路径。\n');
    return EXIT.USAGE;
  }
  if (typeof namespace !== 'string' || !namespace) {
    stderr('参数错误：audit-export 必须显式传 --namespace <稳定命名空间>；不能在每次运行时随机生成。\n');
    return EXIT.USAGE;
  }
  if (!NAMESPACE.test(namespace)) {
    stderr('参数错误：--namespace 只允许 [A-Za-z0-9_-]{1,64}，且必须跨重启稳定。\n');
    return EXIT.USAGE;
  }
  const outAbsolute = resolve(outRaw);

  const dryRun = flags['--dry-run'] === true;

  // ── 源库：只读打开，绝不初始化 ────────────────────────────────────────────────────
  // 这里刻意不用 openOfflineStore：它的构造会 BEGIN IMMEDIATE 并可能建表，是写侧行为。
  let store;
  try {
    store = openOfflineStoreReadOnly(dbAbsolute);
  } catch (error) {
    // 不拼 `error.message`：打开/校验阶段的异常文本不受控。只报固定类别。
    stderr(`参数错误：无法以只读方式打开数据库 ${dbAbsolute}（${describeOpenFailure(error)}）；不会创建或初始化。\n`);
    return EXIT.USAGE;
  }

  try {
    // ── dry-run：只调 status()，不 mkdir / 不 append / 不 prune ──────────────────────
    if (dryRun) {
      const jsonl = createAuditJsonl({ root: outAbsolute, clock: () => Date.now() });
      const exporter = createAuditExporter({ store, jsonl, namespace, clock: () => Date.now() });
      let status;
      try {
        status = exporter.status();
      } catch (error) {
        stderr(`拒绝执行：无法读取导出状态（${describeCaught(error)}）\n`);
        return EXIT.REFUSED;
      }
      const days = Object.keys(status.perDay ?? {});
      stdout(line('subcommand', 'audit-export'));
      stdout(line('db', dbAbsolute));
      stdout(line('out', outAbsolute));
      stdout(line('namespace', namespace));
      stdout(line('dryRun', true));
      stdout(line('days', days.length === 0 ? '(none)' : days.join(',')));
      stdout(line('pending', status.pending ?? 0));
      stdout(line('delivered', status.delivered ?? 0));
      stdout(line('expired', status.expired ?? 0));
      stdout(line('invalid', status.invalid ?? 0));
      stdout(line('conflicted', status.conflicted ?? 0));
      stdout(line('corruptLines', status.corruptLines ?? 0));
      if (status.failed === true) stdout(line('fault', describeExportFailure(status)));
      stdout(line('result', status.failed === true ? 'dry-run（有故障，未落盘）' : 'dry-run（未落盘）'));
      // 故障不是成功：dry-run 发现故障时用非零退出码。
      return status.failed === true ? EXIT.REFUSED : EXIT.OK;
    }

    // ── 正式导出：只写显式 --out ───────────────────────────────────────────────────
    const jsonl = createAuditJsonl({ root: outAbsolute, clock: () => Date.now() });
    const exporter = createAuditExporter({ store, jsonl, namespace, clock: () => Date.now() });

    let result;
    try {
      result = exporter.exportAll();
    } catch (error) {
      stderr(`拒绝执行：导出失败（${describeCaught(error)}）\n`);
      return EXIT.REFUSED;
    }

    stdout(line('subcommand', 'audit-export'));
    stdout(line('db', dbAbsolute));
    stdout(line('out', outAbsolute));
    stdout(line('namespace', namespace));
    stdout(line('dryRun', false));
    stdout(line('exported', result.exported ?? 0));
    stdout(line('alreadyPresent', result.alreadyPresent ?? 0));
    stdout(line('expired', result.skippedExpired ?? 0));
    stdout(line('invalid', result.skippedInvalid ?? 0));
    stdout(line('skippedOtherDay', result.skippedOtherDay ?? 0));
    if (typeof result.lastDeliveredId === 'string') stdout(line('lastDeliveredId', result.lastDeliveredId));
    // PARTIAL PROGRESS IS STILL A FAILURE. Rows already written are reported, but the exit code is
    // non-zero and the offending identity is named — a caller must never read "some rows exported" as
    // "the export is current".
    if (result.failed === true) {
      stdout(line('fault', describeExportFailure(result)));
      stdout(line('result', `failed（已导出 ${result.exported ?? 0} 行后停止）`));
      return EXIT.REFUSED;
    }
    stdout(line('result', 'ok'));
    return EXIT.OK;
  } finally {
    try { store.close(); } catch { /* 关不掉不影响退出码 */ }
  }
}

/**
 * 主入口。
 *
 * @param argv - 不含 node 与脚本路径的参数数组。
 * @param options.stdout / options.stderr - 注入以便测试（默认写 process）。
 * @returns 退出码：0 成功 / 1 业务拒绝 / 2 参数错误。
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));

  let subcommand;
  let flags;
  try {
    ({ subcommand, flags } = parseArguments(argv));
  } catch (error) {
    if (error instanceof UsageError) { stderr(`参数错误：${error.message}\n`); return EXIT.USAGE; }
    throw error;
  }

  // ── `--db` 必须显式给：没有默认值，避免误触生产 state/ ────────────────────────────
  const dbPath = flags['--db'];
  if (typeof dbPath !== 'string' || !dbPath) {
    stderr('参数错误：必须显式传 --db <path>；本工具不提供默认数据库路径，以免误触生产 state/。\n');
    return EXIT.USAGE;
  }
  const absolute = resolve(dbPath);
  // 只读路径（status / dry-run）也要求文件已存在：openOfflineStore 在文件缺失时会建库，
  // 那是一次落盘，只读命令绝不能触发。
  if (!fs.existsSync(absolute)) {
    stderr(`参数错误：数据库文件不存在 ${absolute}；本工具不会创建新数据库。\n`);
    return EXIT.USAGE;
  }

  // ── audit-export：只读投影，独立分支（无 actor、无 --layer/--kind） ────────────────
  if (EXPORT_SUBCOMMANDS.includes(subcommand)) {
    return runAuditExport(flags, absolute, { stdout, stderr });
  }

  const isWrite = WRITE_SUBCOMMANDS.includes(subcommand);

  // ── operator 校验：非法即业务拒绝（退出码 1），且在打开数据库之前 ──────────────────
  let operator = null;
  if (isWrite) {
    const raw = flags['--operator'];
    if (typeof raw !== 'string' || !raw) {
      stderr('拒绝执行：缺少 --operator；管理员操作必须在审计里记录操作者。\n');
      return EXIT.REFUSED;
    }
    if (!AUDIT_ID.test(raw) || /sk-[A-Za-z0-9_-]{12,}/i.test(raw)) {
      stderr('拒绝执行：--operator 非法；只允许 [A-Za-z0-9_-]{1,128}，且不得像密钥。\n');
      return EXIT.REFUSED;
    }
    operator = raw;
  }

  // ── 各子命令的取值校验（参数错误 = 2） ────────────────────────────────────────────
  if (subcommand === 'restore' && !LAYERS.includes(flags['--layer'])) {
    stderr(`参数错误：restore 需要 --layer access|write|both（收到 ${JSON.stringify(flags['--layer'] ?? null)}）。\n`);
    return EXIT.USAGE;
  }
  if (subcommand === 'reset-quota' && !KINDS.includes(flags['--kind'])) {
    stderr(`参数错误：reset-quota 需要 --kind post|comment|like（收到 ${JSON.stringify(flags['--kind'] ?? null)}）。\n`);
    return EXIT.USAGE;
  }
  const reason = flags['--reason'] ?? '';
  if (!AUDIT_REASONS.includes(reason)) {
    stderr(`参数错误：--reason 必须是审计词表之一（${AUDIT_REASONS.filter(Boolean).join('|')}）或省略。\n`);
    return EXIT.USAGE;
  }
  if (flags['--target'] !== undefined && !DIGITS.test(flags['--target'])) {
    stderr('参数错误：--target 必须是纯数字 QQ 号。\n');
    return EXIT.USAGE;
  }

  // ── 打开真实库（只读命令也必须能读到现状） ────────────────────────────────────────
  // 传入的 initial 仅在「表缺失」时使用；上面的 existsSync 保证我们不会用它建库。
  let store;
  try {
    store = openOfflineStore(absolute, { audit: [] });
  } catch (error) {
    stderr(`参数错误：无法打开数据库 ${absolute}（${error?.message ?? error}）。\n`);
    return EXIT.USAGE;
  }

  try {
    const state = store.read();
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      stderr('参数错误：数据库内容不是合法的状态对象。\n');
      return EXIT.USAGE;
    }

    // ── status：只读，打印现状即退出 ──────────────────────────────────────────────
    if (subcommand === 'status') {
      stdout(line('subcommand', 'status'));
      stdout(line('db', absolute));
      stdout(describeState(state));
      return EXIT.OK;
    }

    // ── 写子命令：先算 target（审计硬约束） ───────────────────────────────────────
    const declaredTarget = flags['--target'];
    const fallbackTarget = typeof state.botQq === 'string' ? state.botQq
      : (typeof state.selfId === 'string' ? state.selfId : null);
    const target = declaredTarget ?? fallbackTarget;
    if (typeof target !== 'string' || !DIGITS.test(target)) {
      stderr('参数错误：无法确定审计用的 target（QQ 号）；请显式传 --target <qq>。\n');
      return EXIT.USAGE;
    }

    // ── 业务前置条件：未暂停却要恢复 → 业务拒绝（1），零改动、零审计 ────────────────
    if (subcommand === 'restore') {
      const layer = flags['--layer'];
      const scope = pauseScopeOf(state);
      const paused = layer === 'both'
        ? (state.accessPaused === true || state.writePaused === true)
        : state[`${layer}Paused`] === true;
      if (!paused) {
        stderr(`拒绝执行：--layer ${layer} 当前并未暂停（当前 pauseScope=${scope}）；没有需要恢复的状态。\n`);
        return EXIT.REFUSED;
      }
    }

    const dryRun = flags['--dry-run'] === true;
    const plan = subcommand === 'restore'
      ? `restore ${flags['--layer']}`
      : `reset-quota ${flags['--kind']}（${flags['--kind']} 计数归零）`;

    // ── dry-run：打印计划 + 现状，然后关闭，不写任何东西 ──────────────────────────
    if (dryRun) {
      stdout(line('subcommand', subcommand));
      stdout(line('db', absolute));
      stdout(line('dryRun', true));
      stdout(line('plan', plan));
      stdout(line('operator', operator));
      stdout(line('target', target));
      stdout(line('reason', reason || '(空)'));
      stdout(describeState(state));
      stdout(line('result', 'dry-run（未落盘）'));
      return EXIT.OK;
    }

    // ── 真正执行：审计由模块在同一个事务里写（source 固定 admin_script） ───────────
    const actor = {
      operator,
      source: 'admin_script',
      target,
      time: Date.now(),
      auditId: `cli-${Date.now()}-${randomUUID().slice(0, 8)}`,
      reason,
    };
    try {
      if (subcommand === 'restore') restoreOfflinePause(store, flags['--layer'], actor);
      else resetOfflineQuota(store, flags['--kind'], actor);
    } catch (error) {
      // 参数合法但模块拒绝（审计 id 冲突、状态非法……）：不重试、不补偿，如实报。
      stderr(`拒绝执行：${error?.message ?? error}\n`);
      return EXIT.REFUSED;
    }

    const after = store.read();
    stdout(line('subcommand', subcommand));
    stdout(line('db', absolute));
    stdout(line('dryRun', false));
    stdout(line('plan', plan));
    stdout(line('operator', operator));
    stdout(line('target', target));
    stdout(line('auditId', actor.auditId));
    stdout(describeState(after));
    stdout(line('result', 'ok'));
    return EXIT.OK;
  } finally {
    try { store.close(); } catch { /* 关不掉不影响退出码 */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`执行失败：${error?.message ?? error}\n`);
      process.exitCode = 2;
    },
  );
}
