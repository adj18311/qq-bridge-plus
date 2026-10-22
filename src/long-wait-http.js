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

export function longWaitFetch(url, { method = 'GET', headers, body, signal } = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : target.protocol === 'https:' ? https : null;
  if (!transport) return Promise.reject(new TypeError('Unsupported HTTP protocol'));
  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method, headers, signal }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('HTTP response aborted')));
      res.on('end', () => {
        const payload = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(payload) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
