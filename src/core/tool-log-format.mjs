/**
 * 工具调用日志参数的脱敏与格式化（纯函数）。
 *
 * 机械抽取自 bridge.js（冻结快照 .agent-teams/pure-policy-wave-20261020/bridge.start.js，
 * 约 12021-12057 行）里的 SENSITIVE_ARG_KEYS / redactSensitive / sanitizeToolArgs：
 * - 函数名改为 redactToolLogValue / formatToolLogArgs，递归引用同名；
 * - 两处外部依赖 redactSensitiveText / truncateText 改为调用方注入的
 *   capabilities.redactSensitiveText / capabilities.truncateText（递归时传同一个 capabilities）。
 * 其余函数体、Set 字面量、无原型对象、跳过的键、4 次 JSON.parse、JSON.stringify 回退、
 * >2000 截断与后缀逐字保留；历史怪癖（key 不做 trim、不额外做循环检测、BigInt/函数输入的
 * 错误路径）不做“顺手修复”。
 *
 * SENSITIVE_ARG_KEYS 是模块私有常量，除上述两个函数外不新增导出。
 * 冻结基线见 scripts/fixtures/tool-log-format-baseline.mjs，改动前先跑 scripts/test-tool-log-format.mjs。
 *
 * 边界：纯函数、零依赖。不读 config、不发现 token、不碰 fs/网络/定时器、不写日志、不发送。
 */

const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
export function redactToolLogValue(obj, capabilities) {
  if (Array.isArray(obj)) return obj.map((item) => redactToolLogValue(item, capabilities));
  if (obj && typeof obj === 'object') {
    // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
    const out = Object.create(null);
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).toLowerCase();
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactToolLogValue(v, capabilities);
    }
    return out;
  }
  if (typeof obj === 'string') return capabilities.redactSensitiveText(obj);
  return obj;
}

export function formatToolLogArgs(args, capabilities) {
  if (args === undefined || args === null) return null;
  let parsed = args;
  // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
  for (let i = 0; i < 4; i++) {
    if (typeof parsed !== 'string') break;
    try {
      const next = JSON.parse(parsed);
      parsed = next;
      if (typeof next !== 'string') break;
    } catch {
      break;
    }
  }
  const safe = redactToolLogValue(parsed, capabilities);
  let text;
  try { text = JSON.stringify(safe); } catch { text = String(safe); }
  if (text.length > 2000) text = capabilities.truncateText(text, 2000) + '…(truncated)';
  return text;
}
