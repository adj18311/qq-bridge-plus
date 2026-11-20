// 生产者：把「工具缺失 / 已恢复」写成 bridge 收件箱文件（离线、无凭据、无网络）。
//
// 为什么不是「通知器」：写文件只是**入队**，不是送达。按用户的规则，未知结果不能当成功，
// 所以本模块只返回 outcome='unknown'（code='inbox-queued'）；真正的 delivered 由 bridge 侧
// 发送后写回 receipts/<noticeId>.json，插件通过 receipt-reader.mjs 读回执。
import fsDefault from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const INBOX_ENTRY_SCHEMA_VERSION = 1;
export const INBOX_KIND_MISSING = 'tool-surface-missing';
export const INBOX_KIND_RECOVERED = 'tool-surface-recovered';
export const INBOX_PLATFORM = 'dsh';
export const INBOX_MISSING_COUNT_MAX = 64;

const NOTICE_ID_RE = /^[0-9a-f-]{16,64}$/u;

function newNoticeId() {
  // 与 bridge 侧 EVENT_ID_RE 兼容：小写十六进制 + 短横，36 字符。
  return crypto.randomUUID();
}

function safeInt(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * @param {object} options
 * @param {string} options.inboxDir 收件箱目录（bridge 侧同一路径）
 * @param {() => number} [options.clock]
 * @param {NodeJS.Platform} [options.fs] 注入 fs/promises（测试用）
 * @param {(level:string, message:string) => void} [options.log]
 * @param {string} [options.platform] 默认 'dsh'
 * @param {() => string} [options.makeNoticeId]
 */
export function createInboxProducer(options = {}) {
  const {
    inboxDir,
    clock = () => Date.now(),
    fs: fsImpl = fsDefault,
    log = () => {},
    platform = INBOX_PLATFORM,
    makeNoticeId = newNoticeId,
  } = options;

  if (typeof inboxDir !== 'string' || inboxDir === '') throw new TypeError('createInboxProducer: inboxDir 必填');
  if (typeof clock !== 'function') throw new TypeError('createInboxProducer: clock 必须是函数');

  const written = [];
  let recoveredAt = 0;

  async function writeEntry(entry) {
    await fsImpl.mkdir(inboxDir, { recursive: true });
    // 先写临时文件再 rename：bridge 侧可能正在读，半写的 JSON 会被它隔离成 invalid-json。
    const finalPath = path.join(inboxDir, `${entry.noticeId}.json`);
    const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    await fsImpl.writeFile(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    await fsImpl.rename(tmpPath, finalPath);
    written.push({ noticeId: entry.noticeId, kind: entry.kind, path: finalPath });
    return finalPath;
  }

  /**
   * 缺失告警入队。message 里的文案**不进**收件箱：正文由 bridge 侧固定模板渲染。
   * @returns {Promise<{outcome:'unknown', code:string, noticeId:string}>}
   */
  async function notifyMissing({ missingCount, consecutiveMisses, lastSeenAt, at } = {}) {
    const now = safeInt(at, 1, Number.MAX_SAFE_INTEGER) ? at : clock();
    const count = safeInt(missingCount, 1, INBOX_MISSING_COUNT_MAX) ? missingCount : null;
    if (count === null) {
      log('warn', '缺失数量不合法，未写入收件箱');
      return { outcome: 'unknown', code: 'invalid-missing-count', noticeId: null };
    }
    const misses = safeInt(consecutiveMisses, 1, INBOX_MISSING_COUNT_MAX) ? consecutiveMisses : count;
    const entry = {
      schemaVersion: INBOX_ENTRY_SCHEMA_VERSION,
      noticeId: makeNoticeId(),
      kind: INBOX_KIND_MISSING,
      platform,
      missingCount: count,
      consecutiveMisses: misses,
      lastSeenAt: safeInt(lastSeenAt, 1, Number.MAX_SAFE_INTEGER) ? lastSeenAt : now,
      createdAt: now,
    };
    if (!NOTICE_ID_RE.test(entry.noticeId)) return { outcome: 'unknown', code: 'invalid-notice-id', noticeId: null };
    try {
      await writeEntry(entry);
    } catch (error) {
      log('error', `写入收件箱失败：${error?.code ?? 'write-failed'}`);
      return { outcome: 'unknown', code: error?.code ?? 'write-failed', noticeId: null };
    }
    // 写文件 ≠ 送达：必须等回执，所以这里永远是 unknown（触发 15 分钟重试节流）。
    return { outcome: 'unknown', code: 'inbox-queued', noticeId: entry.noticeId };
  }

  /** 恢复信号入队：bridge 收到后会取消尚未送达的缺失提醒。 */
  async function publishRecovered({ at } = {}) {
    const now = safeInt(at, 1, Number.MAX_SAFE_INTEGER) ? at : clock();
    const entry = {
      schemaVersion: INBOX_ENTRY_SCHEMA_VERSION,
      noticeId: makeNoticeId(),
      kind: INBOX_KIND_RECOVERED,
      platform,
      missingCount: 0,
      consecutiveMisses: 0,
      lastSeenAt: now,
      createdAt: now,
    };
    try {
      await writeEntry(entry);
      recoveredAt = now;
      return { ok: true, noticeId: entry.noticeId };
    } catch (error) {
      log('error', `写入恢复信号失败：${error?.code ?? 'write-failed'}`);
      return { ok: false, reason: error?.code ?? 'write-failed' };
    }
  }

  return {
    notifyMissing,
    publishRecovered,
    snapshot: () => ({ written: written.length, lastRecoveredAt: recoveredAt, inboxDir }),
  };
}