#!/usr/bin/env node
// xhhmcp-healthcheck.mjs —— 小黑盒 MCP（XhhMCP）部署健康检查（只读）
//
// 用途：XhhMCP 部署/回滚后的健康判定。只做三件事：
//   1) 探测 MCP HTTP 端口是否可连；
//   2) MCP initialize + tools/list，断言 12 个工具名齐全；
//   3) 只调用一个只读工具 check_login_status 做冒烟（绝不调用写工具 / 登录类工具）。
//
// 传输方式依据（只读核实过当前部署）：
//   - src/XiaoheiheMcpServer.Http/Program.cs：AddMcpServer().WithHttpTransport(o => o.Stateless = true)、app.MapMcp()
//     ⇒ Streamable HTTP（无状态），实际端点是 POST http://127.0.0.1:19489/ （根路径），
//       不是 README/根 JSON 里写的 /mcp（/mcp 实测 404）。
//   - 响应为 text/event-stream，形如 `event: message` + `data: {json}`。
//
// 用法：
//   node scripts/xhhmcp-healthcheck.mjs
//   node scripts/xhhmcp-healthcheck.mjs --host 127.0.0.1 --port 19489 --timeout 90000
//
// 输出：单行 JSON { reachable, toolsOk, missing[], loginStatus, exitCode }（另含诊断字段）。
// 退出码：0 = 全部通过；1 = 任一检查失败（端口/握手/工具清单/冒烟）。
// 依赖：仅 Node 内置模块；无任何凭据、无第三方依赖。

import http from 'node:http';

const EXPECTED_TOOLS = [
  'check_login_status',
  'get_home_content',
  'get_login_qr_code',
  'get_post_detail',
  'get_user_profile',
  'interactive_login',
  'post_comment',
  'publish_article',
  'publish_content',
  'publish_video',
  'reply_comment',
  'search_content',
];

// 冒烟只允许这一个工具（只读、不占配额、不发内容）。
const SMOKE_TOOL = 'check_login_status';

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 19489, timeout: 90000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) out.host = argv[(i += 1)];
    else if (arg === '--port' && argv[i + 1]) out.port = Number(argv[(i += 1)]);
    else if (arg === '--timeout' && argv[i + 1]) out.timeout = Number(argv[(i += 1)]);
  }
  return out;
}

/** 解析 SSE 响应体里所有 `data:` 负载，返回 JSON-RPC 消息数组。 */
function parseSseMessages(body) {
  const messages = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      // 忽略非 JSON 的心跳/注释行
    }
  }
  return messages;
}

/** 发送一个 JSON-RPC 请求；返回 { status, body, messages }。 */
function postJsonRpc({ host, port, path, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': data.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, contentType: res.headers['content-type'] ?? '', body });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`MCP 请求超时（${timeoutMs}ms）`));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function rpcResult(messages, id) {
  const hit = messages.find((message) => message && message.id === id && message.result);
  return hit ? hit.result : null;
}

function rpcError(messages, id) {
  const hit = messages.find((message) => message && message.id === id && message.error);
  return hit ? hit.error : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = { host: args.host, port: args.port };
  const result = {
    reachable: false,
    toolsOk: false,
    missing: [...EXPECTED_TOOLS],
    loginStatus: null,
    exitCode: 1,
    endpoint: `http://${args.host}:${args.port}/`,
    toolCount: 0,
    unexpected: [],
    detail: {},
  };

  // 1) initialize —— 同时验证端口可达与 MCP 握手。
  try {
    const init = await postJsonRpc({
      ...base,
      path: '/',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'xhhmcp-healthcheck', version: '1.0.0' },
        },
      },
      timeoutMs: 15000,
    });

    result.reachable = init.status >= 200 && init.status < 300;
    result.detail.initialize = { status: init.status, contentType: init.contentType.slice(0, 64) };
    if (!result.reachable) {
      result.detail.error = `initialize HTTP ${init.status}`;
      return finish(result);
    }

    const initMessages = parseSseMessages(init.body);
    const initResult = rpcResult(initMessages, 1);
    const initError = rpcError(initMessages, 1);
    if (initError || !initResult) {
      result.detail.error = `initialize 未返回 result${initError ? `：${JSON.stringify(initError)}` : ''}`;
      return finish(result);
    }
    result.detail.serverInfo = initResult.serverInfo ?? null;
    result.detail.protocolVersion = initResult.protocolVersion ?? null;

    // 2) tools/list —— 断言 12 个工具名齐全。
    const list = await postJsonRpc({
      ...base,
      path: '/',
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      timeoutMs: 15000,
    });
    const listMessages = parseSseMessages(list.body);
    const listResult = rpcResult(listMessages, 2);
    const listError = rpcError(listMessages, 2);
    if (listError || !listResult || !Array.isArray(listResult.tools)) {
      result.detail.error = `tools/list 未返回工具数组${listError ? `：${JSON.stringify(listError)}` : ''}`;
      return finish(result);
    }

    const names = listResult.tools.map((tool) => tool && tool.name).filter(Boolean);
    result.toolCount = names.length;
    const nameSet = new Set(names);
    result.missing = EXPECTED_TOOLS.filter((name) => !nameSet.has(name));
    result.unexpected = names.filter((name) => !EXPECTED_TOOLS.includes(name));
    result.toolsOk = result.missing.length === 0 && names.length === EXPECTED_TOOLS.length;

    // 3) 只读冒烟：仅 check_login_status。
    const call = await postJsonRpc({
      ...base,
      path: '/',
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: SMOKE_TOOL, arguments: {} },
      },
      timeoutMs: args.timeout,
    });
    const callMessages = parseSseMessages(call.body);
    const callResult = rpcResult(callMessages, 3);
    const callError = rpcError(callMessages, 3);

    if (callError || !callResult) {
      result.loginStatus = { ok: false, isError: true, text: callError ? JSON.stringify(callError) : '无 result' };
      result.detail.error = 'check_login_status 调用失败';
      return finish(result);
    }

    const quoted = Array.isArray(callResult.content)
      ? callResult.content.filter((item) => item && item.type === 'text').map((item) => item.text).join('\n')
      : '';
    const text = quoted.trim();
    result.loginStatus = {
      ok: callResult.isError !== true,
      isError: callResult.isError === true,
      loggedIn: text.includes('✅已登录') || (text.includes('✅') && !text.includes('❌')),
      text: text.length > 300 ? `${text.slice(0, 300)}…` : text,
    };

    result.exitCode =
      result.reachable && result.toolsOk && result.loginStatus.ok && result.loginStatus.loggedIn === true ? 0 : 1;
    return finish(result);
  } catch (error) {
    result.detail.error = error instanceof Error ? error.message : String(error);
    return finish(result);
  }
}

function finish(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}

await main();
