/**
 * QQ 会话 ↔ DSH 会话映射（`state/sessions.json`）的持久化层。
 *
 * 本模块只负责三件事：读盘、写盘、维护「是否还允许写」的降级标记。**不持有活映射** ——
 * 调用方自己保留 state 对象，`load()` 把它返回，`save(state)` 再显式传回来。这样：
 *  · 工厂按实例绑定任意 `file`（测试用临时目录，生产用 `state/sessions.json`），
 *    不写死生产路径，import 时也**零 I/O**；
 *  · 「读坏了就别回写」的判定收敛在实例里：`writable` **只降不升**，读失败/损坏一次后，
 *    后续 `save()` 一律 no-op，避免把内存里的空映射覆盖到原文件上，把一次截断变成永久丢失。
 *
 * 语义与 bridge 内联的 `loadState()` / `saveState()` **逐字一致**（含日志文案与错误传播）：
 *  · ENOENT → 空映射且仍可写（首次启动的正常路径），不打印；
 *  · 其它读错误 → 空映射 + 只读，日志「读取失败」；
 *  · 空/纯空白内容 → 空映射，不降级、不打印；
 *  · 解析前剥掉 UTF-8 BOM；JSON 解析失败 → 空映射 + 只读，日志「内容损坏」；
 *  · `loaded.sessions` 是对象 → 整个 `loaded` 原样作 state（保留未知顶层字段）；
 *    否则 `{ sessions: {} }`；
 *  · `sessionPolicies` 不是普通对象（数组 / null / 字符串…）→ `{}`。
 * 写盘复用 `json-store` 的原子写（唯一临时名 + rename）；写失败原样抛出，且**不**把
 * `writable` 改成 false —— 与原来一样，由调用方决定怎么提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './json-store.mjs';

function emptyState() {
  return { sessions: {}, sessionPolicies: {} };
}

/**
 * 创建一个绑定到指定映射文件的持久化实例。
 *
 * @param {object} options
 * @param {string} options.file 映射文件路径（必填；工厂不探测生产 `state/`）。
 * @param {(message: string) => void} [options.log] 窄日志接口，只接收一条字符串；默认静默。
 * @returns {{ load: () => object, save: (state: object) => void, readonly writable: boolean }}
 */
export function createSessionStore({ file, log = () => {} } = {}) {
  if (typeof file !== 'string' || file === '') throw new TypeError('createSessionStore 需要 file');
  const target = file;
  const logger = typeof log === 'function' ? log : () => {};
  // 日志里保留原文件名（生产为 sessions.json），但不把绝对路径写进日志。
  const label = path.basename(target) || 'sessions.json';
  // 只降不升：与原来的 stateWritable 一样，读失败/损坏一次后必须重启进程才恢复写入。
  let writable = true;

  function degrade(message) {
    writable = false;
    logger(message);
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch (error) {
      // 首次启动：文件还不存在。空映射可以正常写出去，不算降级。
      if (error?.code === 'ENOENT') return emptyState();
      degrade(`⚠️ ${label} 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      return emptyState();
    }
    let loaded = null;
    if (raw.trim() !== '') {
      try {
        const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        loaded = JSON.parse(text);
      } catch (error) {
        degrade(`⚠️ ${label} 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
        return emptyState();
      }
    }
    const state = loaded && loaded.sessions && typeof loaded.sessions === 'object'
      ? loaded
      : { sessions: {} };
    if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) {
      state.sessionPolicies = {};
    }
    return state;
  }

  function save(state) {
    // 读失败/损坏时绝不回写：宁可这一轮不落盘，也不要把丢失变成永久。
    if (!writable) return;
    atomicWriteJson(target, state);
  }

  return {
    load,
    save,
    get writable() {
      return writable;
    },
  };
}
