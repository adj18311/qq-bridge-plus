/**
 * 小黑盒唯一权威控制器：持久化 store（纯模块，尚未接线）。
 *
 * 背景：`xiaoheihe-operation-controller.mjs` 是唯一权威内存状态机，`serialize()` /
 * `parseXhhOperationControllerState()` 提供稳定 JSON 与严格校验。本模块补上「落盘」这一层：
 *  · `load()` 读文件 → 严格 parse → 用解析结果创建控制器；缺文件则新建空状态；
 *  · `save()` 把控制器状态克隆、重新校验后原子写入（唯一临时文件 → datasync → rename → 目录 sync）；
 *  · 任何写入失败 → 进入 **degraded**：保留旧文件、清理临时文件、拒绝后续 save，`status()` 暴露
 *    `degraded/lastError`；`reload()` 可从旧文件恢复（未落盘的变更会丢，这是明确语义）。
 *  · `reload()` 是 load 族的重新加载：**必须先 load 过**（未 load → NOT_LOADED）；
 *    未持锁时会重新 `acquireLock()`（他人持锁 → LOCKED），失败按 load 族契约**抛带 code 异常**
 *    （LOAD_FAILED / STATE_INVALID / LOCKED / NOT_LOADED / CLOSED），成功返回控制器。
 *    这把「load 失败后修好文件再 reload」「另一实例持锁」两条路径都收进同一把锁语义。
 *
 * 文件格式：控制器 `serialize()` 的严格 JSON（schemaVersion=1）。store 不额外包裹字段，
 * 以便重启时把文件内容直接交给 `parseXhhOperationControllerState()`。
 *
 * 原子写（尽力而为，边界如实标注）：
 *  · 同目录唯一临时名（`.${basename}.${pid}.${randomUUID()}.tmp`），`open(path,'wx',0o600)` 排他创建；
 *  · writeFile → datasync（无则 fsync）→ close → rename 覆盖正式文件 → 打开目录并 sync（best-effort，
 *    Windows 上打开目录可能失败，失败忽略）；
 *  · 只保证单进程单实例串行（Promise 队列）；**没有跨进程锁语义**（可选 O_EXCL 锁文件只是
 *    best-effort 互斥：stale 检测仅按「锁内容时间戳超过 lockStaleMs」，不检测 PID 是否存活）。
 *
 * 单实例：
 *  · 进程内 `singletonKey`（可选）：同名第二个实例在构造函数同步抛 SINGLETON_CONFLICT；close() 释放；
 *  · 可选 `lockFilePath`：load()/reload() 时用 `open('wx',0o600)` 创建锁文件，内容
 *    `{pid, createdAt, filePath, token}`；已存在且未过期 → LOCKED；过期（按注入时钟）→ 删除后重试一次；
 *    **releaseLock 只删除 token 仍属于自己的锁**：锁被 foreign owner 接管或内容损坏时一律保留
 *    （不做危险删除），避免双写者。
 *
 * 错误契约：
 *  · load() **与 reload()** 失败抛异常（带 code）：STATE_INVALID（坏 JSON/坏 schema）、LOAD_FAILED
 *    （读/锁失败）、LOCKED（他人持锁）、NOT_LOADED（reload 前未 load）、CLOSED、SINGLETON_CONFLICT；
 *  · save() 等运行时写入不抛，返回 `{ok:false, error:{code, message, causeCode?}}`。
 *
 * 明确限制（本切片不做）：
 *  · 不接线：bridge / MCP / 预设 / 调度器 / 正式配置都未引用；
 *  · 无跨进程锁保证、无 PID 存活探测、无掉电一致性证明（rename 原子替换 ≠ 目录项持久化）；
 *  · degraded 后控制器内存仍可被调用方使用，但其状态不可信，必须 reload 后再保存；
 *  · 不写审计/通知（由调用方在 save 结果上自行记录）。
 */

import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import {
  createXhhOperationController,
  parseXhhOperationControllerState,
  XHH_OPERATION_CONTROLLER_SCHEMA_VERSION,
} from './xiaoheihe-operation-controller.mjs';

/** store 错误码（冻结）。 */
export const XHH_OPERATION_STORE_ERROR_CODES = Object.freeze({
  BAD_OPTIONS: 'XHH_OPERATION_STORE_BAD_OPTIONS',
  NOT_LOADED: 'XHH_OPERATION_STORE_NOT_LOADED',
  STATE_INVALID: 'XHH_OPERATION_STORE_STATE_INVALID',
  LOAD_FAILED: 'XHH_OPERATION_STORE_LOAD_FAILED',
  WRITE_FAILED: 'XHH_OPERATION_STORE_WRITE_FAILED',
  DEGRADED: 'XHH_OPERATION_STORE_DEGRADED',
  CLOSED: 'XHH_OPERATION_STORE_CLOSED',
  SINGLETON_CONFLICT: 'XHH_OPERATION_STORE_SINGLETON_CONFLICT',
  LOCKED: 'XHH_OPERATION_STORE_LOCKED',
});

const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
const MAX_ERROR_MESSAGE_LENGTH = 200;
const SINGLETON_REGISTRY_SYMBOL = Symbol.for('qq-bridge.xiaoheihe-operation-store.singletons');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function createCodeError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safeErrorCode(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && code !== '' ? code.slice(0, 64) : 'UNKNOWN';
}

function isNotFoundError(error) {
  return error !== null && typeof error === 'object' && error.code === 'ENOENT';
}

function isExistError(error) {
  return error !== null && typeof error === 'object' && error.code === 'EEXIST';
}

function getSingletonRegistry() {
  const holder = globalThis;
  if (!(holder[SINGLETON_REGISTRY_SYMBOL] instanceof Map)) {
    holder[SINGLETON_REGISTRY_SYMBOL] = new Map();
  }
  return holder[SINGLETON_REGISTRY_SYMBOL];
}

function cloneLastError(value) {
  if (value === null || value === undefined) return null;
  return { ...value };
}

/**
 * 创建控制器持久化 store。
 *
 * @param {object} options
 * @param {string} options.filePath 状态文件路径（必须显式注入；没有默认真实路径）
 * @param {(() => number) | { now?: () => number }} [options.clock] 可注入时钟
 * @param {object} [options.fsOps] 可注入文件系统（readFile/mkdir/open/rename/unlink）
 * @param {string} [options.singletonKey] 进程内单实例键（可选）
 * @param {string} [options.lockFilePath] O_EXCL 锁文件路径（可选）
 * @param {number} [options.lockStaleMs] 锁过期阈值（默认 10 分钟，仅按锁内时间戳判断）
 */
export function createXhhOperationStore(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const { filePath, clock, fsOps, singletonKey, lockFilePath, lockStaleMs } = source;

  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createXhhOperationStore: options.filePath 必须是非空字符串（不提供默认真实路径）');
  }
  if (singletonKey !== undefined && (typeof singletonKey !== 'string' || singletonKey.trim() === '')) {
    throw createCodeError('createXhhOperationStore: singletonKey 必须是非空字符串', XHH_OPERATION_STORE_ERROR_CODES.BAD_OPTIONS);
  }
  if (lockFilePath !== undefined && (typeof lockFilePath !== 'string' || lockFilePath.trim() === '')) {
    throw createCodeError('createXhhOperationStore: lockFilePath 必须是非空字符串', XHH_OPERATION_STORE_ERROR_CODES.BAD_OPTIONS);
  }
  if (lockStaleMs !== undefined && (!Number.isSafeInteger(lockStaleMs) || lockStaleMs <= 0)) {
    throw createCodeError('createXhhOperationStore: lockStaleMs 必须是正整数毫秒', XHH_OPERATION_STORE_ERROR_CODES.BAD_OPTIONS);
  }

  const resolvedFilePath = path.resolve(filePath);
  const directory = path.dirname(resolvedFilePath);
  const baseName = path.basename(resolvedFilePath);
  const resolvedLockPath = lockFilePath === undefined ? null : path.resolve(lockFilePath);
  const staleMs = lockStaleMs === undefined ? DEFAULT_LOCK_STALE_MS : lockStaleMs;

  let now;
  if (typeof clock === 'function') now = () => clock();
  else if (clock !== null && typeof clock === 'object' && typeof clock.now === 'function') now = () => clock.now();
  else now = () => Date.now();

  const ops = isPlainObject(fsOps) ? fsOps : {};
  const readFile = typeof ops.readFile === 'function' ? ops.readFile : fsPromises.readFile;
  const mkdir = typeof ops.mkdir === 'function' ? ops.mkdir : fsPromises.mkdir;
  const open = typeof ops.open === 'function' ? ops.open : fsPromises.open;
  const rename = typeof ops.rename === 'function' ? ops.rename : fsPromises.rename;
  const unlink = typeof ops.unlink === 'function' ? ops.unlink : fsPromises.unlink;

  const registry = getSingletonRegistry();
  const registryKey = singletonKey !== undefined ? singletonKey.trim() : null;
  if (registryKey !== null) {
    if (registry.has(registryKey)) {
      throw createCodeError(
        `xhh 操作持久化 store 已存在活实例（singletonKey=${registryKey}）`,
        XHH_OPERATION_STORE_ERROR_CODES.SINGLETON_CONFLICT,
      );
    }
    registry.set(registryKey, true);
  }

  let phase = 'uninitialized'; // uninitialized | ready | degraded | failed | closed
  let controller = null;
  let failure = null; // { code, message, causeCode? }
  let lastError = null;
  let lastSavedAt = null;
  let lockOwned = false;
  let lockToken = null;
  let closed = false;
  let queue = Promise.resolve();

  function clockNow() {
    let value;
    try {
      value = now();
    } catch {
      return null;
    }
    return isFiniteTimestamp(value) ? value : null;
  }

  function ensureNotClosed() {
    if (closed) {
      throw createCodeError('xhh 操作持久化 store 已 close()，不能继续使用', XHH_OPERATION_STORE_ERROR_CODES.CLOSED);
    }
  }

  function recordError(code, error, causeCode) {
    lastError = {
      code,
      message: truncate(error !== null && typeof error === 'object' && error.message ? error.message : error, MAX_ERROR_MESSAGE_LENGTH),
      causeCode: causeCode ?? null,
      at: clockNow(),
    };
  }

  /**
   * 释放锁：只有锁文件里的 token 仍属于本实例时才删除（F2）。
   * foreign owner 接管 / 内容损坏 / 已不存在 → 一律不动（危险删除会造成双写者）。
   */
  async function releaseLock() {
    if (!lockOwned || resolvedLockPath === null) {
      lockOwned = false;
      lockToken = null;
      return;
    }
    lockOwned = false;
    const token = lockToken;
    lockToken = null;
    let info;
    try {
      const raw = await readFile(resolvedLockPath, 'utf8');
      const parsed = JSON.parse(raw);
      info = isPlainObject(parsed) ? parsed : null;
    } catch {
      return; // 读不到或不可解析：保留，交给人工排查/按 stale 规则处理。
    }
    if (info === null || info.token !== token) return;
    try {
      await unlink(resolvedLockPath);
    } catch {
      // 释放失败不掩盖主流程；锁内容带时间戳，后续可按 stale 规则替换。
    }
  }

  async function readLockInfo() {
    try {
      const raw = await readFile(resolvedLockPath, 'utf8');
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function acquireLock() {
    if (resolvedLockPath === null || lockOwned) return;
    const nowMs = clockNow();
    const token = crypto.randomUUID();
    const payload = JSON.stringify({ pid: process.pid, createdAt: nowMs ?? Date.now(), filePath: resolvedFilePath, token });
    let handle;
    try {
      handle = await open(resolvedLockPath, 'wx', 0o600);
    } catch (error) {
      if (!isExistError(error)) {
        throw createCodeError(
          `xhh 操作持久化 store 获取锁失败（${safeErrorCode(error)}）`,
          XHH_OPERATION_STORE_ERROR_CODES.LOAD_FAILED,
          error,
        );
      }
      // 已存在：只有「内容不可解析」或「按注入时钟已过期」才允许替换（stale 检测仅按时间戳）。
      const info = await readLockInfo();
      const createdAt = isPlainObject(info) && isFiniteTimestamp(info.createdAt) ? info.createdAt : null;
      const stale = createdAt === null || nowMs === null || nowMs - createdAt > staleMs;
      if (!stale) {
        throw createCodeError(
          `xhh 操作持久化 store 状态文件已被锁占用（lockFilePath=${resolvedLockPath}）`,
          XHH_OPERATION_STORE_ERROR_CODES.LOCKED,
        );
      }
      try {
        await unlink(resolvedLockPath);
      } catch {
        // 删除失败则下面的重试仍会 EEXIST 并报 LOCKED。
      }
      try {
        handle = await open(resolvedLockPath, 'wx', 0o600);
      } catch (retryError) {
        throw createCodeError(
          `xhh 操作持久化 store 锁文件无法接管（${safeErrorCode(retryError)}）`,
          XHH_OPERATION_STORE_ERROR_CODES.LOCKED,
          retryError,
        );
      }
    }
    try {
      await handle.writeFile(payload, 'utf8');
    } finally {
      try {
        await handle.close();
      } catch {
        // 忽略关闭错误：锁内容已写入即可；无法写入会在下次 open 时体现。
      }
    }
    lockOwned = true;
    lockToken = token;
  }

  function failLoad(code, message, cause, causeCode) {
    phase = 'failed';
    failure = { code, message, causeCode: causeCode ?? null };
    recordError(code, message, causeCode);
    return createCodeError(message, code, cause);
  }

  async function loadInternal() {
    ensureNotClosed();
    if (phase === 'ready' || phase === 'degraded') return controller;
    if (phase === 'failed') {
      throw createCodeError(
        `xhh 操作持久化 store 不可用（已 failed）：${failure !== null ? failure.message : '状态文件损坏'}`,
        failure !== null ? failure.code : XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID,
      );
    }

    try {
      await acquireLock();
    } catch (error) {
      phase = 'failed';
      recordError(error.code, error);
      throw error;
    }

    let rawText;
    try {
      rawText = await readFile(resolvedFilePath, 'utf8');
    } catch (error) {
      if (!isNotFoundError(error)) {
        await releaseLock();
        throw failLoad(
          XHH_OPERATION_STORE_ERROR_CODES.LOAD_FAILED,
          `xhh 操作持久化 store 读取失败：${truncate(safeErrorCode(error) === 'UNKNOWN' ? error : error.message, MAX_ERROR_MESSAGE_LENGTH)}`,
          error,
          safeErrorCode(error),
        );
      }
      // 缺文件：新建空状态；绝不创建文件（首次 save 才落盘）。
      try {
        const timestamp = clockNow();
        if (timestamp === null) {
          throw createCodeError('xhh 操作持久化 store：注入时钟返回了非有限时间戳', XHH_OPERATION_STORE_ERROR_CODES.LOAD_FAILED);
        }
        controller = createXhhOperationController({ clock: () => timestamp });
      } catch (error) {
        await releaseLock();
        throw failLoad(error.code ?? XHH_OPERATION_STORE_ERROR_CODES.LOAD_FAILED, `xhh 操作持久化 store 初始化失败：${error.message}`, error);
      }
      phase = 'ready';
      return controller;
    }

    let parsed;
    try {
      parsed = parseXhhOperationControllerState(rawText);
    } catch (error) {
      await releaseLock();
      throw failLoad(
        XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID,
        `xhh 操作持久化 store 状态文件不可用（${error.message ?? 'parse failed'}）；拒绝覆盖原文件`,
        error,
        error.code ?? null,
      );
    }
    try {
      controller = createXhhOperationController({ clock, state: parsed });
    } catch (error) {
      await releaseLock();
      throw failLoad(
        XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID,
        `xhh 操作持久化 store 无法创建控制器（${error.message ?? 'invalid state'}）`,
        error,
        error.code ?? null,
      );
    }
    phase = 'ready';
    return controller;
  }

  function failureResult(code, message, causeCode) {
    return { ok: false, error: { code, message: truncate(message, MAX_ERROR_MESSAGE_LENGTH), causeCode: causeCode ?? null } };
  }

  async function writeAtomically(payload) {
    const tempPath = path.join(directory, `.${baseName}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle = null;
    try {
      await mkdir(directory, { recursive: true });
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      if (typeof handle.datasync === 'function') await handle.datasync();
      else if (typeof handle.sync === 'function') await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, resolvedFilePath);
      // 目录 sync：best-effort（Windows 上打开目录可能失败，失败不算写入失败）。
      try {
        const directoryHandle = await open(directory, 'r');
        try {
          if (typeof directoryHandle.sync === 'function') await directoryHandle.sync();
        } finally {
          if (typeof directoryHandle.close === 'function') await directoryHandle.close();
        }
      } catch {
        // 忽略：rename 已完成，目录项持久化不在本模块保证内。
      }
      return null;
    } catch (error) {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // 忽略
        }
      }
      try {
        await unlink(tempPath);
      } catch {
        // 清理失败不掩盖原始错误。
      }
      return error;
    }
  }

  async function saveInternal() {
    if (closed) {
      return failureResult(XHH_OPERATION_STORE_ERROR_CODES.CLOSED, 'xhh 操作持久化 store 已 close()，拒绝写入');
    }
    if (phase === 'failed') {
      return failureResult(
        failure !== null ? failure.code : XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID,
        `xhh 操作持久化 store 不可用（已 failed）：${failure !== null ? failure.message : '状态文件损坏'}`,
      );
    }
    if (phase === 'degraded') {
      return failureResult(
        XHH_OPERATION_STORE_ERROR_CODES.DEGRADED,
        'xhh 操作持久化 store 已 degraded：拒绝后续写入，必须先 reload() 从旧文件恢复',
        lastError !== null ? lastError.causeCode : null,
      );
    }
    if (phase !== 'ready' || controller === null) {
      return failureResult(XHH_OPERATION_STORE_ERROR_CODES.NOT_LOADED, 'xhh 操作持久化 store 尚未 load()');
    }

    let payload;
    try {
      // 克隆 + 重新校验：绝不把控制器认为合法的状态之外的字节写到磁盘。
      const serialized = controller.serialize();
      const parsed = parseXhhOperationControllerState(serialized);
      payload = JSON.stringify(parsed);
    } catch (error) {
      phase = 'degraded';
      recordError(XHH_OPERATION_STORE_ERROR_CODES.WRITE_FAILED, error, error.code ?? 'SERIALIZE_FAILED');
      return failureResult(
        XHH_OPERATION_STORE_ERROR_CODES.WRITE_FAILED,
        `xhh 操作持久化 store 序列化/校验失败：${error.message}`,
        error.code ?? 'SERIALIZE_FAILED',
      );
    }

    const writeError = await writeAtomically(payload);
    if (writeError !== null) {
      phase = 'degraded';
      recordError(XHH_OPERATION_STORE_ERROR_CODES.WRITE_FAILED, writeError, safeErrorCode(writeError));
      return failureResult(
        XHH_OPERATION_STORE_ERROR_CODES.WRITE_FAILED,
        `xhh 操作持久化 store 写入失败（${safeErrorCode(writeError)}）：${writeError.message ?? ''}`,
        safeErrorCode(writeError),
      );
    }
    const timestamp = clockNow();
    lastSavedAt = timestamp ?? Date.now();
    return { ok: true, savedAt: lastSavedAt, bytes: Buffer.byteLength(payload, 'utf8') };
  }

  async function reloadInternal() {
    ensureNotClosed();
    // F1（task-33 审查阻断项）：reload 属于 load 族，必须守住锁与生命周期：
    //  · 未 load 过 → NOT_LOADED（reload 是「重新加载」，不是首次加载）；
    //  · 未持锁（load 失败后、或锁被释放）→ 先 acquireLock()；他人持锁 → LOCKED，不得绕过；
    //  · 任何失败按 load 族契约抛带 code 异常，并释放本次/既有锁，避免 failed 实例长期占锁。
    if (phase === 'uninitialized') {
      throw createCodeError(
        'xhh 操作持久化 store 尚未 load()，不能 reload（reload 不会隐式完成首次加载）',
        XHH_OPERATION_STORE_ERROR_CODES.NOT_LOADED,
      );
    }
    if (!lockOwned && resolvedLockPath !== null) {
      try {
        await acquireLock();
      } catch (error) {
        const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
          ? error.code
          : XHH_OPERATION_STORE_ERROR_CODES.LOAD_FAILED;
        phase = 'failed';
        failure = {
          code,
          message: truncate(error !== null && typeof error === 'object' && error.message ? error.message : error, MAX_ERROR_MESSAGE_LENGTH),
          causeCode: safeErrorCode(error),
        };
        recordError(code, error, safeErrorCode(error));
        throw error;
      }
    }

    let rawText;
    try {
      rawText = await readFile(resolvedFilePath, 'utf8');
    } catch (error) {
      if (!isNotFoundError(error)) {
        await releaseLock();
        throw failLoad(
          XHH_OPERATION_STORE_ERROR_CODES.LOAD_FAILED,
          `xhh 操作持久化 store reload 读取失败：${error.message ?? safeErrorCode(error)}`,
          error,
          safeErrorCode(error),
        );
      }
      const timestamp = clockNow();
      if (timestamp === null) {
        await releaseLock();
        throw failLoad(XHH_OPERATION_STORE_ERROR_CODES.LOAD_FAILED, 'xhh 操作持久化 store reload：时钟不可用', null);
      }
      controller = createXhhOperationController({ clock: () => timestamp });
      phase = 'ready';
      failure = null;
      lastError = null;
      lastSavedAt = null;
      return controller;
    }
    let parsed;
    try {
      parsed = parseXhhOperationControllerState(rawText);
    } catch (error) {
      await releaseLock();
      throw failLoad(
        XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID,
        `xhh 操作持久化 store reload 状态不可用（${error.message ?? 'parse failed'}）；拒绝覆盖原文件`,
        error,
        error.code ?? null,
      );
    }
    try {
      controller = createXhhOperationController({ clock, state: parsed });
    } catch (error) {
      await releaseLock();
      throw failLoad(
        XHH_OPERATION_STORE_ERROR_CODES.STATE_INVALID,
        `xhh 操作持久化 store reload 无法创建控制器（${error.message ?? 'invalid state'}）`,
        error,
        error.code ?? null,
      );
    }
    phase = 'ready';
    failure = null;
    lastError = null;
    return controller;
  }

  function readControllerView() {
    if (controller === null) return { day: null, readUsed: null, lastSeenAt: null };
    let parsed;
    try {
      parsed = parseXhhOperationControllerState(controller.serialize());
    } catch {
      return { day: null, readUsed: null, lastSeenAt: null };
    }
    return { day: parsed.day, readUsed: parsed.readCount, lastSeenAt: parsed.lastSeenAt };
  }

  async function statusInternal() {
    const view = readControllerView();
    return {
      loaded: phase === 'ready' || phase === 'degraded',
      degraded: phase === 'degraded',
      closed,
      filePath: resolvedFilePath,
      schemaVersion: XHH_OPERATION_CONTROLLER_SCHEMA_VERSION,
      day: view.day,
      readUsed: view.readUsed,
      lastSeenAt: view.lastSeenAt,
      lastSavedAt,
      lastError: cloneLastError(lastError),
      singletonKey: registryKey,
      lock: resolvedLockPath === null ? null : { path: resolvedLockPath, owned: lockOwned, staleMs },
    };
  }

  async function closeInternal() {
    if (closed) return;
    closed = true;
    if (controller !== null) {
      try {
        await controller.close();
      } catch {
        // 控制器 close 失败不阻止锁/单例释放。
      }
    }
    await releaseLock();
    if (registryKey !== null) registry.delete(registryKey);
  }

  function enqueue(task) {
    const result = queue.then(() => task());
    // 队列指针只反映“是否结束”：单次失败不毒化后续调用。
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    load: () => enqueue(loadInternal),
    save: () => enqueue(saveInternal),
    reload: () => enqueue(reloadInternal),
    status: () => enqueue(statusInternal),
    close: () => enqueue(closeInternal),
    get controller() {
      if (controller === null) {
        throw createCodeError('xhh 操作持久化 store 尚未 load()', XHH_OPERATION_STORE_ERROR_CODES.NOT_LOADED);
      }
      return controller;
    },
  };
}
