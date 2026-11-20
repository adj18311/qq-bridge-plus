// 回执读取器：把 bridge 写回的 receipts/<noticeId>.json 变成判定模块的投递记账。
//
// 为什么需要它：生产者只写文件（outcome 恒 unknown），如果没人读回执，
// 6 小时「确认送达后才再提醒」和 15 分钟「失败重试」就永远无法推进。
import fsDefault from 'node:fs/promises';
import path from 'node:path';

export const RECEIPT_SUBDIR = 'receipts';
export const RECEIPT_ARCHIVE_SUBDIR = 'processed';
export const RECEIPT_MAX_BYTES = 4096;
export const RECEIPT_OUTCOMES = Object.freeze(['delivered', 'failed', 'unknown', 'cancelled']);

const MAX_ARCHIVED_KEYS = 2000;

function safeInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * @param {object} options
 * @param {string} options.inboxDir
 * @param {object} options.decision 契约 v2 判定模块（需 noteToolSurfaceDelivery）
 * @param {() => object} options.getState 读当前状态
 * @param {(state:object) => void|Promise<void>} options.setState 写回状态（由调用方决定落盘）
 * @param {() => number} [options.clock]
 * @param {NodeJS.Platform} [options.fs]
 * @param {(level:string,message:string)=>void} [options.log]
 */
export function createReceiptReader(options = {}) {
  const {
    inboxDir,
    decision,
    getState,
    setState,
    clock = () => Date.now(),
    fs: fsImpl = fsDefault,
    log = () => {},
  } = options;

  if (typeof inboxDir !== 'string' || inboxDir === '') throw new TypeError('createReceiptReader: inboxDir 必填');
  if (decision === null || typeof decision !== 'object' || typeof decision.noteToolSurfaceDelivery !== 'function') {
    throw new TypeError('createReceiptReader: decision 必须提供 noteToolSurfaceDelivery()');
  }
  if (typeof getState !== 'function' || typeof setState !== 'function') {
    throw new TypeError('createReceiptReader: getState/setState 必填');
  }

  const receiptDir = path.join(inboxDir, RECEIPT_SUBDIR);
  const archiveDir = path.join(receiptDir, RECEIPT_ARCHIVE_SUBDIR);
  // 已处理回执：文件名 → 「大小:mtime」签名，而不是永久 Set。
  // 永久 Set 的缺陷（独立复审 P3-1）：同名回执被重新写回后会被永远跳过（applied 恒 0）。
  const archived = new Map();
  const stats = {
    polls: 0, applied: 0, skipped: 0, malformed: 0, tooLarge: 0,
    delivered: 0, failed: 0, unknown: 0, cancelled: 0, writeFailures: 0, lastAt: null,
  };

  function signatureOf(stat) {
    return `${Number(stat?.size) || 0}:${Number(stat?.mtimeMs) || 0}`;
  }

  async function archive(file, name, sig) {
    if (archived.size > MAX_ARCHIVED_KEYS) archived.clear();
    try {
      await fsImpl.mkdir(archiveDir, { recursive: true });
      await fsImpl.rename(path.join(receiptDir, name), path.join(archiveDir, file));
      // 只在 rename 成功之后才记签名：先记会「没搬走却当成已处理」，真失败时永久跳过。
      if (sig !== undefined) archived.set(file, sig);
      return true;
    } catch (error) {
      // 归档失败不致命：下次还会再读一次，只要 noteToolSurfaceDelivery 幂等即可。
      stats.writeFailures += 1;
      log('warn', `回执归档失败（下一轮重试）：${error?.code ?? 'rename-failed'}`);
      return false;
    }
  }

  async function poll() {
    stats.polls += 1;
    const now = clock();
    let names;
    try {
      names = await fsImpl.readdir(receiptDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, applied: 0, reason: 'no-receipts' };
      throw error;
    }
    let applied = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = name;
      const full = path.join(receiptDir, name);
      let stat;
      try {
        stat = await fsImpl.lstat(full);
      } catch {
        continue;
      }
      const sig = signatureOf(stat);
      // 同一份文件（大小 + mtime 都没变）上一轮已处理 ⇒ 跳过；
      // 重新写回的同名回执（mtime 变了）必须重新处理。
      if (archived.get(file) === sig) continue;
      if (stat.isSymbolicLink?.() === true) { stats.malformed += 1; await archive(file, name, sig); continue; }
      if (Number.isFinite(stat.size) && stat.size > RECEIPT_MAX_BYTES) { stats.tooLarge += 1; await archive(file, name, sig); continue; }
      let raw;
      try {
        raw = JSON.parse(await fsImpl.readFile(full, 'utf8'));
      } catch {
        stats.malformed += 1;
        await archive(file, name, sig);
        continue;
      }
      const outcome = raw?.outcome;
      if (!RECEIPT_OUTCOMES.includes(outcome)) { stats.malformed += 1; await archive(file, name, sig); continue; }

      // cancelled：bridge 已取消（例如工具恢复），不该再记账成失败去重试。
      if (outcome === 'cancelled') {
        stats.cancelled += 1;
        stats.skipped += 1;
        await archive(file, name, sig);
        continue;
      }

      const at = safeInt(raw.at) ? raw.at : now;
      const delivered = outcome === 'delivered';
      try {
        let noted = decision.noteToolSurfaceDelivery(getState(), {
          at,
          outcome: delivered ? 'delivered' : (outcome === 'failed' ? 'failed' : 'unknown'),
          deliveredAt: delivered ? at : null,
        });
        if (noted && typeof noted.then === 'function') noted = await noted;
        if (noted && typeof noted === 'object' && noted.state !== undefined) {
          const saved = setState(noted.state);
          if (saved && typeof saved.then === 'function') await saved;
        }
      } catch (error) {
        stats.writeFailures += 1;
        log('error', `回执记账失败（保留文件下一轮重试）：${error?.message ?? 'note-failed'}`);
        continue; // 不归档：下一轮重试
      }
      applied += 1;
      stats.applied += 1;
      if (delivered) stats.delivered += 1;
      else if (outcome === 'failed') stats.failed += 1;
      else stats.unknown += 1;
      await archive(file, name, sig);
    }
    stats.lastAt = now;
    return { ok: true, applied };
  }

  return { poll, snapshot: () => ({ ...stats, archived: archived.size, receiptDir }) };
}