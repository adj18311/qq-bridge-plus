// C3：审批 IPC listener 的**启动配置解读**——纯判定，不读盘、不建连接、不记日志。
//
// 为什么单独成文件：bridge.js 不能被启动（有用户未提交改动、会连真实 QQ），所以"配了没配、配得对不对"
// 这一段必须能脱离服务单独 import 才能验证。
//
// 口径：
//   · 缺省（cfg.qzone.approvalIpc 不存在 / 不是对象）⇒ 完全不启动，行为与现在一致；
//   · 是对象但缺 token ⇒ **不启动**，返回原因（调用方 log 一条，绝不抛 —— 审批通道坏了不该让桥接起不来）；
//   · token 形状按任务卡：32..256 位 [A-Za-z0-9_-]（比 listener 自己的 16-512 printable 更严，取交集）；
//   · port 可选，缺省 0（临时端口）；给了就必须是 0..65535 的安全整数。
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

/** 允许出现在 approvalIpc 对象里的键。多一个都算配置错误（防拼写错误静默变成"没启用"）。 */
export const QZONE_APPROVAL_IPC_KEYS = Object.freeze(['token', 'port']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 解读 cfg.qzone.approvalIpc。
 *
 * @param {unknown} section
 * @returns {{ enabled: false, reason: string } | { enabled: true, token: string, port: number }}
 *   `enabled:false` 只表示"本进程不启动审批 IPC"，不是错误：调用方 log 原因后照常继续启动。
 */
export function readQzoneApprovalIpcConfig(section) {
  if (section === undefined || section === null) return { enabled: false, reason: 'not-configured' };
  if (!isPlainObject(section)) return { enabled: false, reason: 'invalid-section' };
  for (const key of Reflect.ownKeys(section)) {
    if (typeof key !== 'string' || !QZONE_APPROVAL_IPC_KEYS.includes(key)) {
      return { enabled: false, reason: 'unknown-field' };
    }
  }
  const token = section.token;
  if (typeof token !== 'string' || token === '') return { enabled: false, reason: 'token-missing' };
  if (!TOKEN.test(token)) return { enabled: false, reason: 'token-invalid' };
  const port = section.port === undefined ? 0 : section.port;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) return { enabled: false, reason: 'port-invalid' };
  return { enabled: true, token, port };
}
