import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';

const LAYERS = new Set(['access', 'write', 'both']);
const REASONS = new Set(['network', 'not_accessible', 'login_expired', 'captcha', 'rate_limit', 'quota', 'timeout', 'platform_error', 'policy', 'other']);
const PREFIX = '/api/console/qqspace-column';
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

function parseArguments(args) {
  if (!Array.isArray(args)) return null;
  const values = Object.create(null);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--url', '--layer', '--reason'].includes(key) || Object.hasOwn(values, key) || typeof args[index + 1] !== 'string') return null;
    values[key] = args[++index];
  }
  if (!LAYERS.has(values['--layer']) || !REASONS.has(values['--reason'])) return null;
  const baseUrl = values['--url'] ?? 'http://127.0.0.1:3100';
  let parsed;
  try { parsed = new URL(baseUrl); } catch { return null; }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  return { layer: values['--layer'], reason: values['--reason'], baseUrl: parsed.origin };
}

function readSecretWithoutEcho(input, output, label) {
  if (!input?.isTTY || typeof input.setRawMode !== 'function') throw new Error('interactive terminal required');
  output.write(`${label}（输入不回显）：`);
  input.setRawMode(true);
  const decoder = new StringDecoder('utf8');
  return new Promise((resolveSecret, rejectSecret) => {
    let secret = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onEnd);
      input.off('error', onError);
      try { input.setRawMode(false); } catch { /* terminal may have closed */ }
      input.pause();
      output.write('\n');
      if (error) rejectSecret(error);
      else resolveSecret(secret);
    };
    const onData = (chunk) => {
      const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      for (const character of text) {
        if (character === '\u0003' || character === '\u0004') return finish(new Error('secret input aborted'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0008' || character === '\u007f') secret = Array.from(secret).slice(0, -1).join('');
        else secret += character;
      }
    };
    const onEnd = () => finish(new Error('terminal closed'));
    const onError = () => finish(new Error('terminal unavailable'));
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

function sessionCookie(response) {
  const values = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie']
    : [response.headers['set-cookie']].filter(Boolean);
  if (values.length !== 1) throw new Error('session cookie unavailable');
  const match = /^qqspace_column_session=([A-Za-z0-9_-]{20,256})(?:;|$)/.exec(values[0]);
  if (!match) throw new Error('session cookie invalid');
  return `qqspace_column_session=${match[1]}`;
}

function postJson(urlValue, { token, cookie, body }) {
  const url = new URL(urlValue);
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    let timer;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectResponse(error);
    };
    const request = httpRequest({
      protocol: 'http:', hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || 80,
      family: url.hostname.includes(':') ? 6 : 4, method: 'POST', path: url.pathname,
      agent: false, setHost: true, timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        'x-console-token': token,
        'x-column-request': '1',
        ...(cookie ? { cookie } : {}),
      },
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode < 200 || response.statusCode >= 300 ||
            !/^application\/json(?:\s*;|\s*$)/i.test(String(response.headers['content-type'] ?? ''))) {
          fail(new Error('unexpected HTTP response'));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.ok !== true) throw new Error('operation rejected');
          settled = true;
          clearTimeout(timer);
          resolveResponse({ parsed, headers: response.headers, statusCode: response.statusCode });
        } catch (error) { fail(error); }
      });
    });
    request.on('error', fail);
    timer = setTimeout(() => request.destroy(new Error('request timeout')), REQUEST_TIMEOUT_MS);
    request.end(JSON.stringify(body));
  });
}

export async function main(args = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = options.stderr ?? process.stderr.write.bind(process.stderr);
  const selection = parseArguments(args);
  if (!selection) {
    stderr('参数无效；需指定 --layer access|write|both、--reason 暂停原因，可选 --url http://127.0.0.1:端口。\n');
    return 2;
  }
  const input = options.input ?? process.stdin;
  const promptOutput = options.promptOutput ?? process.stderr;
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') {
    stderr('需要交互式终端分别输入主控制台 token 和 QQ 空间独立密码；未执行恢复。\n');
    return 2;
  }

  let consoleToken;
  let password;
  try {
    consoleToken = await readSecretWithoutEcho(input, promptOutput, '主控制台 token');
    password = await readSecretWithoutEcho(input, promptOutput, 'QQ 空间独立密码');
    if (typeof consoleToken !== 'string' || !consoleToken || typeof password !== 'string' || !password) throw new Error('empty credentials');
  } catch {
    consoleToken = '';
    password = '';
    stderr('无法安全读取凭据；未执行恢复。\n');
    return 2;
  }

  try {
    const { headers: verifyHeaders } = await postJson(`${selection.baseUrl}${PREFIX}/auth/verify`, {
      token: consoleToken,
      body: { password },
    });
    const cookie = sessionCookie({ headers: verifyHeaders });
    password = '';
    await postJson(`${selection.baseUrl}${PREFIX}/pause/restore`, {
      token: consoleToken,
      cookie,
      body: { layer: selection.layer, reason: selection.reason },
    });
    stdout(`恢复请求成功：${selection.layer}；操作者身份与 admin_console 审计由服务端已验证会话确定。\n`);
    return 0;
  } catch {
    stderr('恢复失败或服务端未确认；未重试，未执行本地回退。\n');
    return 2;
  } finally {
    consoleToken = '';
    password = '';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, () => {
    process.stderr.write('恢复失败；未重试，未执行本地回退。\n');
    process.exitCode = 2;
  });
}
