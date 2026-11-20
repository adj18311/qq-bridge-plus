// 桥接侧接线层：把「插件写的收件箱文件」变成「可审计的 owner 通知」，并把回执写回去。
//
// 分工（务必分清，别把职责推来推去）：
//   · 插件（无凭据）：只往 `inboxDir` 写严格 schema 的 JSON 小文件，不发送、不重试。
//   · 本模块（跑在 bridge 进程内）：校验 → 交给 `owner-notice-outbox` 排队 → 由 outbox 调用
//     `sendOwnerPrivateWithReceipt()` 真发 → 回执写到 `<inboxDir>/receipts/<noticeId>.json`。
//   · 送达语义：**只有** `message_id` 非空才算 delivered；超时/无 id/异常一律 unknown/failed。
//     本模块不解释 HTTP 状态码，也不把「请求被受理」当成功。
//
// 为什么回执不写回同一个文件：收件箱文件归插件所有，bridge 改写它既会污染插件 schema，
// 也会让「谁写坏了这份文件」变得无法追责。回执单独放 `receipts/` 子目录，两边职责清晰。
import path from 'node:path';
import { createOwnerNoticeOutbox, OWNER_NOTICE_SCHEMA_VERSION } from './owner-notice-outbox.mjs';

/** 收件箱 schema 版本：与插件写入方约定，不匹配一律拒绝。 */
export const OWNER_NOTICE_INBOX_VERSION = 1;
/** 单个收件箱文件上限：超限直接拒绝（防止插件把大文件塞进来）。 */
export const OWNER_NOTICE_INBOX_MAX_BYTES = 2048;
/** 允许的「未来」时钟偏差上限：只拦未来时间，**不按年龄判定重放**。
 * 按年龄丢弃会丢真实报警：桥接离线/繁忙超过该时长时，合法且从未处理的报警会过期消失。
 * 重放由 noticeId 幂等（outbox 按 eventId 去重）与 outbox 自身的节流兜底，不靠文件年龄。 */
export const OWNER_NOTICE_INBOX_MAX_SKEW_MS = 10 * 60 * 1000;
/** 允许的 kind（收件箱侧语义）：
 *  · `tool-surface-missing`  → 入队一条待发提示；
 *  · `tool-surface-recovered` → **取消**该平台所有「已入队、尚未送达」的缺失提示，不再新入队。
 * 后者不是通知事件，所以它的计数允许为 0（恢复时缺失数本来就可能是 0）。 */
export const OWNER_NOTICE_INBOX_KINDS = ['tool-surface-missing', 'tool-surface-recovered'];
/** 恢复类事件在 outbox 里没有对应事件类型：它只用于取消，绝不提交。 */
const RECOVERED_KIND = 'tool-surface-recovered';
const MISSING_KIND = 'tool-surface-missing';
/** 文件年龄下限：比这更新文件视为插件正在写，本轮跳过而不是拒绝（避免把半写 JSON 当垃圾移走）。 */
export const OWNER_NOTICE_INBOX_MIN_AGE_MS = 2000;

/** 收件箱允许的键：任何多余键 ⇒ 整条拒绝（不忽略、不猜测）。 */
export const OWNER_NOTICE_INBOX_KEYS = [
  'schemaVersion', 'noticeId', 'kind', 'platform', 'missingCount',
  'consecutiveMisses', 'lastSeenAt', 'createdAt',
];

const NOTICE_ID_RE = /^[0-9a-f][0-9a-f-]{15,63}$/u;
const RECEIPT_SUBDIR = 'receipts';

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSafeInt = (value) => Number.isSafeInteger(value);
const inRange = (value, min, max) => isSafeInt(value) && value >= min && value <= max;

/**
 * 严格校验一条收件箱条目。
 * 任何意外都返回 `{ ok: false, reason }`，绝不「尽力解析」——插件写错时宁可丢一条提示，
 * 也不要把畸形数据带进发送链路。
 */
export function parseOwnerNoticeInboxEntry(raw, { now } = {}) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not-object' };
  if (!isSafeInt(now)) return { ok: false, reason: 'clock-invalid' };

  const keys = Object.keys(raw);
  for (const key of keys) {
    if (!OWNER_NOTICE_INBOX_KEYS.includes(key)) return { ok: false, reason: 'unknown-field' };
  }
  for (const key of OWNER_NOTICE_INBOX_KEYS) {
    if (key === 'missingCount' || key === 'consecutiveMisses') continue; // 下面单独校验（允许缺省）
    if (!(key in raw)) return { ok: false, reason: `missing-${key}` };
  }

  if (raw.schemaVersion !== OWNER_NOTICE_INBOX_VERSION) return { ok: false, reason: 'schema-version-unsupported' };
  if (typeof raw.noticeId !== 'string' || !NOTICE_ID_RE.test(raw.noticeId)) return { ok: false, reason: 'invalid-notice-id' };
  if (typeof raw.kind !== 'string' || !OWNER_NOTICE_INBOX_KINDS.includes(raw.kind)) return { ok: false, reason: 'invalid-kind' };
  if (raw.platform !== 'dsh') return { ok: false, reason: 'invalid-platform' };

  // 数值：missing 与 outbox 的请求契约一致（1..64）；recovered 允许 0（恢复时缺失数可能为 0）。
  const minCount = raw.kind === RECOVERED_KIND ? 0 : 1;
  if (!inRange(raw.missingCount, minCount, 64)) return { ok: false, reason: 'invalid-missing-count' };
  if (!inRange(raw.consecutiveMisses, minCount, 64)) return { ok: false, reason: 'invalid-consecutive-misses' };

  if (!isSafeInt(raw.lastSeenAt)) return { ok: false, reason: 'invalid-last-seen-at' };
  if (!isSafeInt(raw.createdAt)) return { ok: false, reason: 'invalid-created-at' };
  // 只拦未来时间（时钟污染/伪造）。**不再因为"旧"而拒绝**：那会在桥接长时间不可用时丢掉真实报警。
  if (raw.createdAt > now + OWNER_NOTICE_INBOX_MAX_SKEW_MS) return { ok: false, reason: 'created-in-future' };
  if (raw.lastSeenAt > now + OWNER_NOTICE_INBOX_MAX_SKEW_MS) return { ok: false, reason: 'last-seen-in-future' };

  return {
    ok: true,
    value: {
      noticeId: raw.noticeId,
      kind: raw.kind,
      missingCount: raw.missingCount,
      consecutiveMisses: raw.consecutiveMisses,
      lastSeenAt: raw.lastSeenAt,
      createdAt: raw.createdAt,
    },
  };
}

/** 回执里的 outcome 只有三种真值；`delivered` 必须由 messageId 支撑。 */
export function receiptOutcomeFor(event) {
  if (!isPlainObject(event)) return { outcome: 'pending' };
  // delivered 只认 deliveredAt：这是 outbox 唯一在「拿到 message_id」时才写的字段。
  if (event.deliveredAt !== null && event.deliveredAt !== undefined) {
    return { outcome: 'delivered', at: event.deliveredAt };
  }
  // 输入可能是 outbox 的持久化事件（带 attempts），也可能是 snapshot() 的投影
  // （只带 lastOutcome/lastCode），两种都要支持 —— 否则回执永远停在 pending。
  const last = Array.isArray(event.attempts) && event.attempts.length > 0
    ? event.attempts[event.attempts.length - 1]
    : null;
  const outcome = last === null ? (event.lastOutcome ?? null) : (last.outcome ?? null);
  const code = last === null ? (event.lastCode ?? null) : (last.code ?? null);
  const at = last === null ? null : (last.finishedAt ?? null);
  if (outcome === null || outcome === undefined) return { outcome: 'pending' };
  if (outcome === 'failed') return { outcome: 'failed', code: code ?? null, at };
  // unknown 也是未知：不重写、不升级成 delivered，如实写 unknown。
  return { outcome: 'unknown', code: code ?? null, at };
}

/**
 * 把 bridge 的发送函数包成「只有拿到 message_id 才算 delivered」的发送器。
 *
 * 为什么必须包：outbox 的 `classifySendResult` 只看 `outcome === 'delivered'`。
 * 如果接线时误传了一个「HTTP 200 就算成功」的发送器，整条链路会把「已受理」
 * 记成「已送达」——这正是用户规则明确禁止的。这里做一次收口：
 * `delivered` 必须是 `messageId` 非空字符串，否则一律降级为 unknown。
 */
// 有效送达回执 id：**非零的十进制整数**（数字形式，或带可选负号的纯数字字符串）。
//
// 为什么允许负数（2026-11-02 实测纠正）：
// 真实 SnowLuma/QQ 的 send_private_msg 会返回**负的** message_id。本机 state/social-v2.json 里
// isSelf=true 且带 messageId 的条目全部是负数（如 -1529327303、-325256368），它们来自
// 发送接口的 body.data.message_id —— 即「消息确实发出去了、QQ 确实给了回执」。本仓库另有 5 处
// 代码写着「消息 id 可能为负数」（replyToMessageId 校验用 /^-?[1-9]\d*$/）可作旁证。
//
// 旧实现要求 `> 0`，于是这类真实回执被判非法 ⇒ 记 unknown + code='no-message-id'。后果不是
// 「更保守」而是**反向失真**：守卫的异常补报永远到不了 delivered、lastSendReceiptAt 永不更新
// ⇒ qq-comms 前置条件恒为 false ⇒ 管理员点了恢复却被告知「QQ 通信未恢复」，而通知其实早已收到。
//
// 不变的部分：0 / '0' / '00' / '' / 纯空白 / 'abc' / 小数 / NaN / Infinity / 超出安全整数范围
// / -0 / 对象 / 布尔 / 数组 一律**仍判非法** —— 只有「非零安全整数」才算拿到了回执。
export function isValidDeliveredMessageId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value !== 0;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^-?[0-9]+$/u.test(trimmed)) return false;
  const parsed = Number(trimmed);
  // -0 与 0 都不能证明「这条消息有 id」。
  return Number.isSafeInteger(parsed) && parsed !== 0;
}

// 归一化为十进制字符串（去掉前导零、保留负号），不合法返回 null。
export function normalizeDeliveredMessageId(value) {
  if (!isValidDeliveredMessageId(value)) return null;
  return String(typeof value === 'number' ? value : Number(value.trim()));
}

export function createProvenDeliverySender(sendOwnerPrivateWithReceipt, { log = () => {} } = {}) {
  if (typeof sendOwnerPrivateWithReceipt !== 'function') {
    throw new TypeError('sendOwnerPrivateWithReceipt must be a function');
  }
  // 只有**非零安全整数** message_id 才算送达（真实回执可为负）；与 bridge 的判定共用同一个校验函数，
  // 避免两处漂移（''、'0'、'00'、'-0'、{}、'abc' 都不算）。
  const provenId = normalizeDeliveredMessageId;
  return async (text) => {
    const raw = await sendOwnerPrivateWithReceipt(text);
    if (isPlainObject(raw) && raw.outcome === 'delivered') {
      const messageId = provenId(raw.messageId);
      if (messageId !== null) return { outcome: 'delivered', messageId };
      // 声称成功却拿不出回执：按未知处理，下次会重试（可能重复，但不会假报成功）。
      // 这条日志是复审 P2-2 要求的「机械护栏」：装配时若忘了让 bridge 返回 messageId，
      // 会在第一封通知上就把问题喊出来，而不是静默重发三个月。
      log('owner-notice: 发送器声称 delivered 但没有可用的 message_id ⇒ 记为 unknown（真实送达会被重复提示）。请确认 bridge 的 sendOwnerPrivateWithReceipt 返回 { outcome, code, messageId }。');
      return { outcome: 'unknown', code: 'delivered-without-message-id' };
    }
    return raw;
  };
}

async function writeJsonAtomic(fs, filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, filePath);
}

/**
 * 接线层主体。
 *
 * @param {object} options
 * @param {string} options.inboxDir    插件写收件箱的目录（bridge 只读它）
 * @param {object} options.outbox      `createOwnerNoticeOutbox()` 的返回值
 * @param {object} options.fs          `node:fs/promises` 或同形注入（测试用）
 * @param {() => number} options.clock 时钟（测试注入固定值）
 * @param {(msg: string) => void} options.log 日志（不得写入令牌/正文）
 * @param {number} [options.intervalMs] 对账周期，默认 60s
 * @param {Function} [options.setInterval] 定时器注入（测试用）
 */
export function createOwnerNoticeBridgeWiring({
  inboxDir,
  stateFile,
  sendOwnerPrivateWithReceipt,
  outbox = null,
  fs,
  clock = () => Date.now(),
  log = () => {},
  intervalMs = 60_000,
  minFileAgeMs = OWNER_NOTICE_INBOX_MIN_AGE_MS,
  audit = null,
  setInterval: setIntervalImpl = setInterval,
  clearInterval: clearIntervalImpl = clearInterval,
} = {}) {
  if (typeof inboxDir !== 'string' || inboxDir === '') throw new TypeError('inboxDir must be a non-empty string');
  if (fs === null || typeof fs !== 'object') throw new TypeError('fs is required');
  if (!(Number.isSafeInteger(intervalMs) && intervalMs >= 1000)) throw new TypeError('intervalMs must be >= 1000');
  // 生产形态：由本模块自己建 outbox，发送器必须经过「message_id 才算 delivered」收口。
  // 测试形态：允许直接注入 outbox（不重复构造、也不用真 fs）。
  if (outbox === null) {
    if (typeof stateFile !== 'string' || stateFile === '') throw new TypeError('stateFile is required when outbox is not injected');
    outbox = createOwnerNoticeOutbox({
      filePath: stateFile,
      clock,
      log,
      send: createProvenDeliverySender(sendOwnerPrivateWithReceipt, { log }),
    });
  }
  if (outbox === null || typeof outbox !== 'object') throw new TypeError('outbox is required');

  const receiptDir = path.join(inboxDir, RECEIPT_SUBDIR);
  const stateDir = typeof stateFile === 'string' && stateFile !== '' ? path.dirname(stateFile) : null;
  // 恢复水位：必须持久化。否则「上一轮已消费 recovered、这一轮才到 missing」会照发一条过时报警。
  const recoveredMarkerPath = stateDir === null ? null : path.join(stateDir, 'owner-notice-recovered-at.json');
  let lastRecoveredAt = 0;
  let timer = null;
  let inFlight = null;
  let stopped = false;
  let quarantineSeq = 0;
  const auditedKeys = new Set();
  const stats = {
    runs: 0, ingested: 0, duplicates: 0, rejected: 0, delivered: 0, unknown: 0, failed: 0,
    cancelled: 0, skippedStale: 0, processedMoveFailures: 0, receiptWriteFailures: 0,
    quarantineFailures: 0, recoveredMarkerFailures: 0, recoveredMarkerUnpersisted: 0,
    lastRunAt: null, lastError: null,
  };

  /** 读恢复水位（缺文件 = 从未恢复过）。读坏文件按"未知"处理：不拦任何报警（宁可多发，不可漏发）。 */
  async function loadRecoveredAt() {
    if (recoveredMarkerPath === null) return 0;
    try {
      const parsed = JSON.parse(await fs.readFile(recoveredMarkerPath, 'utf8'));
      return Number.isSafeInteger(parsed?.lastRecoveredAt) && parsed.lastRecoveredAt > 0 ? parsed.lastRecoveredAt : 0;
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`owner-notice: 恢复水位读取失败（按 0 处理）：${error?.code ?? 'read-failed'}`);
      return 0;
    }
  }

  /** 写恢复水位：先写临时文件再 rename，避免半写。失败只记日志（水位退回内存值）。 */
  async function persistRecoveredAt(at) {
    lastRecoveredAt = Math.max(lastRecoveredAt, at);
    if (recoveredMarkerPath === null) {
      // 没有 stateFile 就没有落盘位置：水位只在内存里，重启后旧报警会重发。必须可见。
      stats.recoveredMarkerUnpersisted += 1;
      log('owner-notice: 未配置 stateFile，恢复水位只存在内存中（重启后可能重发旧报警）');
      return { ok: true, persisted: false };
    }
    try {
      await fs.mkdir(path.dirname(recoveredMarkerPath), { recursive: true });
      const tmp = `${recoveredMarkerPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify({ schemaVersion: 1, lastRecoveredAt })}\n`, 'utf8');
      await fs.rename(tmp, recoveredMarkerPath);
      return { ok: true };
    } catch (error) {
      stats.recoveredMarkerFailures += 1;
      log(`owner-notice: 恢复水位落盘失败（本轮内存生效，重启后可能多发一条）：${error?.code ?? 'persist-failed'}`);
      return { ok: false, reason: error?.code ?? 'persist-failed' };
    }
  }

  /** 恢复信号：取消所有「已入队、尚未送达」的缺失提示，避免恢复后仍继续提醒。 */
  async function cancelPendingMissing(now) {
    let snap;
    try {
      snap = await outbox.snapshot();
    } catch (error) {
      return { ok: false, reason: error?.code ?? 'snapshot-failed' };
    }
    if (snap?.ok !== true) return { ok: false, reason: snap?.reason ?? 'snapshot-failed' };
    const targets = (snap.events ?? []).filter((event) => event.kind === MISSING_KIND
      && event.deliveredAt === null && event.closedAt === null);
    let cancelled = 0;
    let failureReason = null;
    for (const event of targets) {
      const result = await outbox.close(event.eventId, { at: now });
      if (result?.ok === true) {
        cancelled += 1;
      } else {
        // 取消失败（例如 outbox 正被别的实例持有锁）⇒ 交给下一轮重试，不假装成功。
        failureReason = result?.reason ?? 'close-failed';
        log(`owner-notice: 取消待发提示失败（${failureReason}）：${event.eventId}`);
      }
    }
    // reason 原样带出（例如 owner-held），调用方据此判断"下一轮再试"，不要吞成泛化文案。
    return { ok: cancelled === targets.length, cancelled, pending: targets.length, reason: failureReason ?? undefined };
  }

  /** 只读前 MAX+1 字节：文件在 stat 之后被写大也不会把整份内容读进内存。 */
  async function readBoundedText(full) {
    const handle = await fs.open(full, 'r');
    try {
      const buffer = Buffer.alloc(OWNER_NOTICE_INBOX_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > OWNER_NOTICE_INBOX_MAX_BYTES) {
        const error = new Error('too-large');
        error.code = 'too-large';
        throw error;
      }
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function readEntries(now) {
    let names;
    try {
      names = await fs.readdir(inboxDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries: [], rejected: [] };
      throw error;
    }
    const entries = [];
    const rejected = [];
    // 拒绝时移走而非删除：保留取证，同时避免每 60 秒重复拒绝刷日志。
    // 文件名带时间戳：否则第二次拒绝会覆盖第一次的取证。
    // 同一毫秒内可能连续隔离两个同名文件（插件重写同名收件箱），所以再加进程内序号。
    const quarantine = async (full, name, reason) => {
      quarantineSeq += 1;
      const target = path.join(inboxDir, `${name}.${Date.now()}-${quarantineSeq}.rejected`);
      try {
        await fs.rename(full, target);
        log(`owner-notice: 收件箱文件被隔离（${reason}）：${name}`);
      } catch (error) {
        // 隔离失败必须可见：否则同一份坏文件会被每轮重复读到（且日志还谎称已隔离）。
        stats.quarantineFailures += 1;
        log(`owner-notice: 隔离失败（${reason}，文件仍在收件箱）：${name}（${error?.code ?? 'rename-failed'}）`);
      }
    };
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(inboxDir, name);
      let stat;
      try {
        stat = await fs.lstat(full);
      } catch (error) {
        rejected.push({ file: name, reason: error?.code === 'ENOENT' ? 'vanished' : 'stat-failed' });
        continue;
      }
      // 符号链接一律拒绝：收件箱是插件可写目录，跟随链接等于让插件替 bridge 选文件。
      if (stat.isSymbolicLink()) {
        rejected.push({ file: name, reason: 'symlink' });
        await quarantine(full, name, 'symlink');
        continue;
      }
      // 刚写出来的文件可能还没写完：本轮跳过、不隔离、不计数，下一轮再看。
      // mtimeMs 是浮点数（带毫秒小数），只能用 isFinite 判定，isSafeInteger 会永远为 false。
      if (minFileAgeMs > 0 && Number.isFinite(stat.mtimeMs) && now - stat.mtimeMs < minFileAgeMs) {
        continue;
      }
      if (stat.size > OWNER_NOTICE_INBOX_MAX_BYTES) {
        rejected.push({ file: name, reason: 'too-large' });
        await quarantine(full, name, 'too-large');
        continue;
      }
      let text;
      try {
        text = await readBoundedText(full);
      } catch (error) {
        if (error?.code === 'too-large') {
          rejected.push({ file: name, reason: 'too-large' });
          await quarantine(full, name, 'too-large');
          continue;
        }
        rejected.push({ file: name, reason: error?.code === 'ENOENT' ? 'vanished' : 'read-failed' });
        continue;
      }
      let parsedRaw;
      try {
        parsedRaw = JSON.parse(text);
      } catch {
        rejected.push({ file: name, reason: 'invalid-json' });
        await quarantine(full, name, 'invalid-json');
        continue;
      }
      const parsed = parseOwnerNoticeInboxEntry(parsedRaw, { now });
      if (parsed.ok !== true) {
        rejected.push({ file: name, reason: parsed.reason });
        await quarantine(full, name, parsed.reason);
        continue;
      }
      entries.push({ file: name, value: parsed.value });
    }
    return { entries, rejected };
  }

  /** 移进 processed/；失败必须可观察（否则插件会以为没被接手，或文件无限堆积）。 */
  async function moveToProcessed(file, suffix = '') {
    try {
      const processedDir = path.join(inboxDir, 'processed');
      await fs.mkdir(processedDir, { recursive: true });
      const target = suffix === '' ? file : `${file}.${suffix}`;
      await fs.rename(path.join(inboxDir, file), path.join(processedDir, target));
    } catch (error) {
      stats.processedMoveFailures += 1;
      log(`owner-notice: 移入 processed/ 失败：${file}（${error?.code ?? 'move-failed'}）`);
    }
  }

  /** 只做收取 + 入队；不发送。返回每条的处理结果，便于测试与排障。 */
  async function ingestOnce() {
    const now = clock();
    if (!Number.isSafeInteger(now)) return { ok: false, reason: 'clock-invalid', accepted: 0, duplicates: 0, rejected: [] };
    const { entries, rejected } = await readEntries(now);
    let accepted = 0;
    let duplicates = 0;
    let skippedStale = 0;
    const errors = [];

    // 顺序很重要：**先处理恢复**（与文件名排序无关），再决定哪些缺失已经过时。
    // 否则「aa-recovered.json + zz-missing.json」会在同一轮里先发旧报警、再取消。
    const recoveredEntries = entries.filter((entry) => entry.value.kind === RECOVERED_KIND);
    const missingEntries = entries.filter((entry) => entry.value.kind !== RECOVERED_KIND);

    if (lastRecoveredAt === 0) lastRecoveredAt = await loadRecoveredAt();
    for (const entry of recoveredEntries) {
      const cancelled = await cancelPendingMissing(now);
      if (cancelled.ok !== true) {
        // 不移动文件：下一轮还要再试，绝不能把"没取消成功"当成已处理。
        errors.push({ file: entry.file, reason: cancelled.reason ?? 'cancel-failed' });
        continue;
      }
      stats.cancelled += cancelled.cancelled;
      // 水位不能前跳：createdAt 允许落在 ±10 分钟窗口内，若直接采用未来时间，
      // 随后到达的、比它更早但确实更「新」的缺失会被误判成过时。宁可少跳，不可多跳。
      await persistRecoveredAt(Math.min(entry.value.createdAt, now));
      await moveToProcessed(entry.file);
    }

    for (const entry of missingEntries) {
      // createdAt <= 恢复水位 ⇒ 这条报警描述的状态早已被恢复覆盖，发出去就是过时误报。
      if (lastRecoveredAt > 0 && entry.value.createdAt <= lastRecoveredAt) {
        skippedStale += 1;
        await moveToProcessed(entry.file, 'stale-after-recovery');
        continue;
      }
      const result = await outbox.submit({
        schemaVersion: OWNER_NOTICE_SCHEMA_VERSION,
        eventId: entry.value.noticeId,
        kind: entry.value.kind,
        missingCount: entry.value.missingCount,
        consecutiveMisses: entry.value.consecutiveMisses,
        lastSeenAt: entry.value.lastSeenAt,
        createdAt: entry.value.createdAt,
      });
      if (result?.ok === true) {
        if (result.duplicate === true) duplicates += 1; else accepted += 1;
      } else {
        errors.push({ file: entry.file, reason: result?.reason ?? 'submit-failed' });
        log(`owner-notice: 入队失败（${result?.reason ?? 'submit-failed'}），本轮不发送：${entry.file}`);
      }
      // 入队成功（含重复）后把收件箱文件移进 processed/，让插件侧能看到「已被接手」。
      if (result?.ok === true) await moveToProcessed(entry.file);
    }
    stats.ingested += accepted;
    stats.duplicates += duplicates;
    stats.skippedStale += skippedStale;
    stats.rejected += rejected.length;
    return { ok: errors.length === 0, accepted, duplicates, skippedStale, rejected, errors };
  }

  /** 只做发送（交给 outbox 的状态机），并把回执写回 receipts/。 */
  async function deliverOnce() {
    const report = await outbox.drain();
    await writeReceipts();
    if (report?.ok !== true) return report;
    stats.delivered += Number(report.delivered ?? 0);
    stats.unknown += Number(report.unknown ?? 0);
    stats.failed += Number(report.failed ?? 0);
    return report;
  }

  async function writeReceipts() {
    let snap;
    try {
      snap = await outbox.snapshot();
    } catch (error) {
      log(`owner-notice: 读取发件箱快照失败（不写回执）：${error?.code ?? 'snapshot-failed'}`);
      return;
    }
    if (snap?.ok !== true) return;
    await fs.mkdir(receiptDir, { recursive: true }).catch(() => {});
    for (const event of snap.events ?? []) {
      // 已取消（恢复后被 close）且从未送达：插件必须能区分「不会再重试」与「还在等重试」。
      const state = event.closedAt !== null && event.closedAt !== undefined && (event.deliveredAt === null || event.deliveredAt === undefined)
        ? { outcome: 'cancelled', at: event.closedAt }
        : receiptOutcomeFor(event);
      if (state.outcome === 'pending') continue; // 还没试过：不写回执，避免插件误以为已处理
      const isCancelled = state.outcome === 'cancelled';
      const receipt = isCancelled
        ? { noticeId: event.eventId, outcome: 'cancelled', at: state.at ?? clock(), code: 'recovered' }
        : {
          noticeId: event.eventId,
          outcome: state.outcome,
          at: state.at ?? clock(),
          ...(state.code === null || state.code === undefined ? {} : { code: String(state.code).slice(0, 64) }),
          // 明确写清：这不是 exactly-once，unknown 的重试可能重复通知。
          atLeastOnce: true,
        };
      try {
        await writeJsonAtomic(fs, path.join(receiptDir, `${event.eventId}.json`), receipt);
      } catch (error) {
        stats.receiptWriteFailures += 1;
        log(`owner-notice: 写回执失败（不影响发送）：${error?.code ?? 'receipt-failed'}`);
        continue;
      }
      // 审计：同一次投递结果只记一次（key 含 at）；重启后可能重复一行，属已知边界。
      if (typeof audit === 'function') {
        const auditKey = `${event.eventId}|${state.outcome}|${state.at ?? 0}`;
        if (!auditedKeys.has(auditKey)) {
          auditedKeys.add(auditKey);
          try {
            await audit({
              noticeId: event.eventId,
              outcome: state.outcome,
              code: state.code ?? null,
              at: state.at ?? null,
              attempts: Array.isArray(event.attempts) ? event.attempts.length : null,
            });
          } catch (error) {
            log(`owner-notice: 审计写入失败（不影响发送）：${error?.code ?? 'audit-failed'}`);
          }
        }
      }
    }
  }

  /** 一次完整对账：收取 → 发送 → 回执。并发调用复用同一个在飞 Promise（单飞）。 */
  function runOnce() {
    if (stopped) return Promise.resolve({ ok: false, reason: 'stopped' });
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      const startedAt = clock();
      try {
        // outbox 的持久化目录必须存在（否则第一次 drain 会报 state-dir-missing）。
        if (stateDir !== null) await fs.mkdir(stateDir, { recursive: true }).catch(() => {});
        const ingested = await ingestOnce();
        const report = await deliverOnce();
        stats.runs += 1;
        stats.lastRunAt = clock();
        stats.lastError = ingested.ok === false ? 'ingest-partial' : null;
        return { ok: report?.ok !== false, ingested, report };
      } catch (error) {
        stats.lastError = error?.code ?? 'run-failed';
        log(`owner-notice: 对账异常（不影响桥接主流程）：${stats.lastError}`);
        return { ok: false, reason: stats.lastError };
      } finally {
        inFlight = null;
        void startedAt;
      }
    })();
    return inFlight;
  }

  function start() {
    if (timer !== null) return { ok: true, already: true };
    stopped = false;
    timer = setIntervalImpl(() => { void runOnce(); }, intervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
    return { ok: true, intervalMs };
  }

  async function stop() {
    stopped = true;
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
    if (inFlight !== null) {
      try { await inFlight; } catch { /* runOnce 自己吞错 */ }
    }
    return { ok: true };
  }

  function snapshot() {
    return {
      ok: true,
      inboxDir,
      running: timer !== null,
      intervalMs,
      inFlight: inFlight !== null,
      ...stats,
    };
  }

  return { inboxDir, runOnce, ingestOnce, deliverOnce, start, stop, snapshot };
}