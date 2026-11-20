#!/usr/bin/env node
// xhhmcp-tool-surface-probe.mjs —— 小黑盒 MCP 服务端「工具表」探针（只读、离线友好）
//
// 作用：对 MCP 服务端做一次 initialize + tools/list，取回服务端实际暴露的工具名。
// 注意：这**只代表 MCP 服务端工具表**，不等于 DSH 已注册/已授予这些工具；
//       DSH 侧工具被注销时，服务端可能仍然一切正常（这正是 2B 要观测的差异）。
//
// 安全：只发 initialize/tools/list 两个只读请求；不发送令牌/cookie/正文；
//       输出只包含工具名、计数、协议版本与耗时。
//
// CLI:
//   node scripts/xhhmcp-tool-surface-probe.mjs --check [--json] [--url=http://127.0.0.1:19489/]
//   退出码：ok → 0；否则 → 1。

import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:19489/';
const DEFAULT_TIMEOUT_MS = 3000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = Object.freeze({ name: 'xhh-tool-surface-probe', version: '1.0.0' });

function emptyResult(reason, elapsedMs) {
  return {
    ok: false,
    toolNames: [],
    protocolVersion: null,
    sessionId: null,
    elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : 0,
    reason,
  };
}

class ProbeFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** 从响应正文解析出 JSON-RPC 消息：兼容 application/json 与 text/event-stream（真实服务端默认 SSE）。 */
function parseJsonRpcPayload(bodyText, contentType) {
  const text = String(bodyText ?? '').trim();
  if (text.length === 0) return null;

  const looksLikeSse = /text\/event-stream/i.test(contentType ?? '') || /^event:|^data:/m.test(text);
  if (looksLikeSse) {
    const messages = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (data.length === 0 || data === '[DONE]') continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // 非 JSON 的 data 行忽略；整段都解析不出来时按 bad-jsonrpc 处理。
      }
    }
    return messages.length > 0 ? messages : null;
  }

  try {
    return [JSON.parse(text)];
  } catch {
    return null;
  }
}

function pickMessage(messages, id) {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (message && typeof message === 'object' && message.id === id) return message;
  }
  return messages.at(-1) ?? null;
}

function validateEnvelope(message, id) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new ProbeFailure('bad-jsonrpc');
  if (message.jsonrpc !== '2.0') throw new ProbeFailure('bad-jsonrpc');
  if (message.id !== id) throw new ProbeFailure('bad-jsonrpc');
  if (message.error !== undefined && message.error !== null) throw new ProbeFailure('bad-jsonrpc');
  if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
    throw new ProbeFailure('bad-jsonrpc');
  }
  return message.result;
}

async function readResponse(response) {
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    throw new ProbeFailure('http-error');
  }
  return bodyText;
}

/**
 * POST 一个 JSON-RPC 请求，返回解析后的 result。
 * @returns {Promise<{result:object, sessionId:string|null}>}
 */
async function postJsonRpc({ url, timeoutMs, fetchImpl, payload, sessionId }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId === null ? {} : { 'mcp-session-id': sessionId }),
      },
      body: JSON.stringify(payload),
    });
    const bodyText = await readResponse(response);
    const headerSessionId = typeof response.headers?.get === 'function'
      ? response.headers.get('mcp-session-id')
      : null;
    if (!response.ok) throw new ProbeFailure('http-error');
    const messages = parseJsonRpcPayload(bodyText, response.headers?.get?.('content-type'));
    if (messages === null) throw new ProbeFailure('bad-jsonrpc');
    const message = pickMessage(messages, payload.id);
    const result = validateEnvelope(message, payload.id);
    return { result, sessionId: headerSessionId ?? null };
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new ProbeFailure('timeout');
    }
    throw new ProbeFailure('unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测 MCP 服务端工具表。
 * @param {{url?:string, timeoutMs?:number, fetchImpl?:Function}} [options]
 * @returns {Promise<{ok:boolean, toolNames:string[], protocolVersion:string|null, sessionId:string|null, elapsedMs:number, reason:string}>}
 */
export async function probeMcpToolSurface({ url = DEFAULT_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const finish = (result) => ({ ...result, elapsedMs: elapsed() });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return finish(emptyResult('unreachable'));
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return finish(emptyResult('unreachable'));
  }
  if (!(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return finish(emptyResult('timeout'));
  }

  const endpoint = parsedUrl.toString();
  try {
    const initialize = await postJsonRpc({
      url: endpoint,
      timeoutMs,
      fetchImpl,
      sessionId: null,
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      },
    });
    const protocolVersion = initialize.result.protocolVersion;
    if (!isNonEmptyString(protocolVersion)) throw new ProbeFailure('bad-jsonrpc');

    const remaining = timeoutMs - elapsed();
    if (remaining <= 0) throw new ProbeFailure('timeout');
    const listed = await postJsonRpc({
      url: endpoint,
      timeoutMs: remaining,
      fetchImpl,
      sessionId: initialize.sessionId,
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });

    const tools = listed.result.tools;
    if (!Array.isArray(tools)) throw new ProbeFailure('invalid-tools');
    const names = [];
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new ProbeFailure('invalid-tools');
      if (!isNonEmptyString(tool.name)) throw new ProbeFailure('invalid-tools');
      names.push(tool.name);
    }
    const toolNames = [...new Set(names)].sort();

    return finish({
      ok: true,
      toolNames,
      protocolVersion,
      sessionId: initialize.sessionId,
      reason: 'ok',
    });
  } catch (error) {
    const reason = error instanceof ProbeFailure ? error.reason : 'unreachable';
    return finish(emptyResult(reason));
  }
}

function parseArgs(argv) {
  const options = { check: false, json: false, url: DEFAULT_URL };
  for (const arg of argv) {
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--url=')) options.url = arg.slice('--url='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return null;
  }
  return options;
}

function formatHuman(result) {
  const status = result.ok ? 'OK' : `FAIL(${result.reason})`;
  const lines = [
    `[xhhmcp-tool-surface] ${status} 服务端工具表（不等于 DSH 已注册）：${result.toolNames.length} 个`,
  ];
  if (result.ok) {
    lines.push(`  protocolVersion=${result.protocolVersion ?? 'null'} sessionId=${result.sessionId ?? 'null'} elapsedMs=${result.elapsedMs}`);
    for (const name of result.toolNames) lines.push(`  - ${name}`);
  } else {
    lines.push(`  elapsedMs=${result.elapsedMs}`);
    lines.push('  提示：这只说明 MCP 服务端不可用/异常，不代表 DSH 工具已注销；反之亦然。');
  }
  return lines.join('\n');
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options === null || options.help || !options.check) {
    process.stderr.write(
      '用法: node scripts/xhhmcp-tool-surface-probe.mjs --check [--json] [--url=http://127.0.0.1:19489/]\n'
      + '说明: 只读 initialize + tools/list；输出为 MCP 服务端工具表，不等于 DSH 已注册。\n',
    );
    return 1;
  }
  const result = await probeMcpToolSurface({ url: options.url });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result)}\n`);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
