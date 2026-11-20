// Node's fetch has a fixed response-header deadline; a QQ wait can exceed it.
// Use the core HTTP client for this endpoint only, retaining the caller's abort budget.
import http from 'node:http';
import https from 'node:https';

export function longWaitBudget(requestedMs, waitCfg = {}) {
  const defaultMs = Number(waitCfg.defaultMs) || 30000;
  const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
  const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
  const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(requestedMs) || defaultMs)));
  const minQuiet = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
  const maxQuiet = Math.max(minQuiet, Math.min(120000, Number(waitCfg.maxMs) || 600000));
  return timeoutMs + maxQuiet + 25000;
}

/**
 * 把底层失败整形成为模型可读的 Error。
 *
 * 为什么需要：`http.request` 的 `signal` 中止会抛 DOMException（name=AbortError），
 * 断连会抛 `Error('socket hang up')`，而某些上游会 reject 一个**普通对象**。
 * 这些值一路冒到 MCP 宿主，`String(obj)` 就变成 "[object Object]" ——
 * 2026-11-06 线上 `qq_wait_for_messages` 超时正是这样报错的：模型只看到
 * "Error: [object Object]"，既分不清是超时、断连还是桥接拒绝，也不知道该不该重试。
 */
function readableFailure(error, signal, timeoutMs) {
  const name = error && typeof error === 'object' ? error.name : '';
  const aborted = Boolean(signal && signal.aborted);
  if (name === 'AbortError' || name === 'TimeoutError' || aborted) {
    const signalReason = signal && signal.reason;
    const timedOut = name === 'TimeoutError' || (signalReason && signalReason.name === 'TimeoutError');
    if (timedOut) {
      const budget = Number(timeoutMs) > 0 ? `预算 ${Math.round(Number(timeoutMs))}ms` : '预算到期';
      return new Error(`等待请求超时（${budget}）：桥接在这一轮没有返回，通常表示期限内没有任何新消息；可以换更短的 timeoutMs 重试，或直接收尾。`);
    }
    return new Error('等待请求被中断：客户端已断开或本次回合已结束。');
  }
  if (error instanceof Error) {
    return error.message ? error : new Error(error.name || '等待请求失败（错误没有消息）');
  }
  if (typeof error === 'string' && error.trim()) return new Error(error.trim());
  if (error && typeof error === 'object') {
    for (const field of ['message', 'error', 'detail', 'code']) {
      const picked = error[field];
      if (typeof picked === 'string' && picked) return new Error(picked);
      if (picked && typeof picked === 'object') {
        try {
          return new Error(JSON.stringify(picked));
        } catch {}
      }
    }
    try {
      return new Error(JSON.stringify(error));
    } catch {
      return new Error(String(error));
    }
  }
  return new Error(`等待请求失败：${String(error)}`);
}

export function longWaitFetch(url, { method = 'GET', headers, body, signal, timeoutMs = 0 } = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : target.protocol === 'https:' ? https : null;
  if (!transport) return Promise.reject(new TypeError('Unsupported HTTP protocol'));
  return new Promise((resolve, reject) => {
    const fail = error => reject(readableFailure(error, signal, timeoutMs));
    const req = transport.request(target, { method, headers, signal }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('桥接在响应中途断开（HTTP response aborted）')));
      res.on('end', () => {
        const payload = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => {
            try {
              return JSON.parse(payload);
            } catch {
              const snippet = payload.slice(0, 200).replace(/\s+/g, ' ');
              throw new Error(`等待接口返回的不是 JSON（HTTP ${res.statusCode}）：${snippet || '空响应'}`);
            }
          }
        });
      });
    });
    req.on('error', fail);
    req.end(body);
  });
}
