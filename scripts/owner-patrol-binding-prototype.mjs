// 离线试验，不是生产授权组件；入口注册者的可信性尚未验证。
import { createHash } from 'node:crypto';
import { XHH_AUTHORIZE_WRITE_TOOLS, XHH_AUTHORIZE_CREDENTIAL_TOOLS } from '../src/core/xiaoheihe-authorize-api.mjs';
import { createOriginPrototype, decidePrototypePolicy } from './owner-patrol-origin-prototype.mjs';

function canonical(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw new TypeError('嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('非法数据');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('非法对象');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError('稀疏数组');
    result = `[${value.map((item) => canonical(item, seen, depth + 1)).join(',')}]`;
  } else {
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('非法键');
    const keys = Object.keys(value).sort();
    if (keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new TypeError('非法访问器');
    result = `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen, depth + 1)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function messageKey(message) {
  if (!message || typeof message.id !== 'string' || !message.id) throw new TypeError('消息无 ID');
  return `${message.id}:${digest(message)}`;
}
function callDigest(input) {
  return digest({ sessionId: input.sessionId, turn: input.turn, step: input.step, callId: input.callId, tool: input.tool, args: input.args });
}
function operation(tool) {
  if (typeof tool !== 'string') return null;
  const short = tool.startsWith('mcp__xiaoheihe__') ? tool.slice('mcp__xiaoheihe__'.length) : tool;
  if (XHH_AUTHORIZE_WRITE_TOOLS.includes(short)) return 'write';
  if (XHH_AUTHORIZE_CREDENTIAL_TOOLS.includes(short)) return 'credential';
  return null;
}

export function createBindingPrototype(options) {
  const origin = createOriginPrototype(options);
  const bindings = new Map();
  const messageIds = new Set();
  return {
    register(message, source) {
      const key = messageKey(message);
      if (messageIds.has(message.id)) {
        origin.disconnect();
        throw new TypeError('消息 ID 重复');
      }
      origin.register(key, source);
      messageIds.add(message.id);
    },
    end(input) { origin.end(input); },
    step(input) {
      let messages;
      try { messages = input.messages.map(messageKey); } catch { messages = ['invalid-message']; }
      origin.step({ ...input, messages });
    },
    call(input) {
      if (bindings.has(input.callId)) bindings.set(input.callId, null);
      else { try { bindings.set(input.callId, callDigest(input)); } catch { bindings.set(input.callId, null); } }
      origin.call(input);
    },
    authorize(input) {
      try {
        const binding = bindings.get(input.callId);
        if (!binding || binding !== callDigest(input)) return 'deny';
        const kind = operation(input.tool);
        if (kind === null) return 'deny';
        return decidePrototypePolicy(origin.lookup(input), kind);
      } catch { return 'deny'; }
    },
  };
}
