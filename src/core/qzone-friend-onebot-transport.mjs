const ACTIONS = new Set(['get_login_info', 'get_friend_list']);
const MAX_BYTES = 1024 * 1024;

// Internal only: callers must bind this transport to the actual current
// connection and enforce account/epoch validation before trusting results.
export function createQzoneFriendOnebotTransport({ origin, token, fetch: send, timeoutMs = 5000 } = {}) {
  if (typeof origin !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(origin) ||
      typeof token !== 'function' || typeof send !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('invalid friend transport');
  }
  const base = new URL(origin).origin;
  return async function call(action, params) {
    if (!ACTIONS.has(action) || !params || typeof params !== 'object' ||
        Object.getPrototypeOf(params) !== Object.prototype || Reflect.ownKeys(params).length !== 0) {
      throw new TypeError('invalid friend request');
    }
    const controller = new AbortController();
    let timer;
    let reader;
    let expired = false;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
        expired = true;
        controller.abort();
        try { if (reader) Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* abort remains in effect */ }
        reject(new Error('friend request timeout'));
      }, timeoutMs); });
      const work = (async () => {
        const secret = await token();
        if (expired || typeof secret !== 'string') throw new Error('invalid credential');
        const headers = new Headers({ 'content-type': 'application/json' });
        if (secret) headers.set('authorization', `Bearer ${secret}`);
        const response = await send(`${base}/${action}`, { method: 'POST', headers, body: '{}',
          signal: controller.signal, redirect: 'error' });
        if (expired) {
          try { await response?.body?.cancel(); } catch {}
          throw new Error('expired friend response');
        }
        if (!response?.ok || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/i.test(response.headers?.get?.('content-type') ?? '')) {
          try { await response?.body?.cancel(); } catch {}
          throw new Error('invalid friend response');
        }
        reader = response.body?.getReader();
        if (!reader) throw new Error('invalid friend response');
        const chunks = []; let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            if (!(part.value instanceof Uint8Array) || (size += part.value.byteLength) > MAX_BYTES) {
              await reader.cancel(); throw new Error('invalid friend response');
            }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); reader = null; }
        const bytes = new Uint8Array(size); let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      })();
      return await Promise.race([work, timeout]);
    } catch {
      throw new Error('friend request unavailable');
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
