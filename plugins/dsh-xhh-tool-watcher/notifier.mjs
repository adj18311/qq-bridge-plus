/**
 * 阶段 2B v2.2：xhh-tool-watcher 的 HTTP 通知模块（离线可测，不主动联网）。
 *
 * 设计目标：给插件一个「能用 YAML 配置构造」的 notify 实现（profile 里写不了函数），
 * 同时把「什么才算真的送达」收紧到**可证明的端点契约**上：
 *
 *  · 只有调用方显式声明了 `successContract`，且响应**逐字段满足**该契约时，才是 `delivered`；
 *  · 契约默认 `none` —— 任何 2xx 都只能得到 `unknown`（「请求被受理」不等于「消息发出去了」）；
 *  · 2xx + `{ok:false}` → `failed`；4xx → `failed`；5xx / 网络 / 超时 / 非 JSON / 结构不符 → `unknown`。
 *
 * 为什么不再用「2xx + JSON + ok!==false 就算成功」：
 *   `{}`、`null`、`[]`、`{ok:true}` 这类响应只证明端点受理/排队，把它们当送达会把
 *   「未知」洗成「已送达」，进而让 6 小时节流与用户看到的状态都不再可信。
 *
 * 已知且唯一被接受的契约 `bridge-send-v1`（依据 qq-bridge 源码，非猜测）：
 *   `POST /api/send/private|group|reply` 成功分支返回
 *   `{ ok: true, key, sent: N, failed: M, quoted }`；而 `sent` 只在 `onebotSend()` 拿到
 *   OneBot 网关 `status === 'ok' && retcode === 0` 后才 +1（见 src/bridge.js 的发送分支与 onebotSend）。
 *   因此「2xx + ok===true + 整数 sent>=1 + failed===0」才是本机可得的「确实经网关发出」标志；
 *   `{ok:true, sent:0, failed:1}` 是 2xx 但没发出，必须判 unknown。
 *
 * 安全与稳定性：
 *  · 任何情况都不向外抛异常（调用方按 outcome 记账）；
 *  · token 只进请求头，绝不进日志/返回值；
 *  · 超时覆盖**整次请求 + 响应体读取**（response.text() 挂起同样被 abort + 竞速兜底）；
 *  · 响应体超过 MAX_RESPONSE_BYTES 直接判 unknown（不解析可能被塞爆的大响应）。
 */

export const DEFAULT_NOTIFY_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** 可被配置选中的送达契约：目前只有 `none`（永远不宣告送达）。 */
export const NOTIFY_SUCCESS_CONTRACTS = Object.freeze({
  none: Object.freeze({
    id: 'none',
    description: '没有可证明送达的端点契约：任何响应都只判 unknown（不会出现 delivered）',
    pathSuffixes: Object.freeze([]),
    verify: () => false,
  }),
});

/**
 * 未来专用通知端点的回执判据（**当前不可通过配置选中**）。
 *
 * 语义来源（源码核实，非猜测）：`src/bridge.js` 的发送成功分支返回
 * `{ok:true, key, sent, failed, quoted}`，而 `sent` 只在 `onebotSend()` 拿到 OneBot
 * `status === 'ok' && retcode === 0` 之后才 +1。因此该判据 = 2xx + ok===true + 整数 sent>=1 + failed===0。
 *
 * 为什么现在不接：`/api/send/private|group|reply` 还要求 **body 里带 `token` 与 `userId/groupId`**
 * （见 `src/bridge.js` 的发送分支），而 YAML 无法给插件传 `bodyFactory`、把 consoleToken 写进
 * 插件配置又等于把管理员凭据交给被监控的智能体。所以在出现「bridge 侧自己持有凭据的专用通知端点」
 * 之前，这个判据只能是文档与测试里的常量，不能让配置假装自己能做到。
 */
export function verifyBridgeSendV1Receipt(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  return body.ok === true
    && Number.isInteger(body.sent)
    && body.sent >= 1
    && body.failed === 0;
}

export const NOTIFY_SUCCESS_CONTRACT_IDS = Object.freeze(Object.keys(NOTIFY_SUCCESS_CONTRACTS));

function noop() {}

function humanError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function pathOf(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return '';
  }
}

/** 解析契约；未知 id（含已下线的 `bridge-send-v1`）返回 null。 */
export function resolveNotifySuccessContract(id) {
  if (typeof id !== 'string' || id === '') return null;
  return Object.prototype.hasOwnProperty.call(NOTIFY_SUCCESS_CONTRACTS, id) ? NOTIFY_SUCCESS_CONTRACTS[id] : null;
}

/** 给运维的可读说明：为什么某个契约 id 现在不可用。 */
export function describeContractUnavailable(id) {
  if (id === 'bridge-send-v1') {
    return 'bridge-send-v1 目前不可配置：/api/send/* 要求 body 里带 token 与 userId/groupId，'
      + '而把 consoleToken 写进插件配置等于把管理员凭据交给被监控的智能体；'
      + '需要先有 bridge 侧持有凭据的专用通知端点';
  }
  return `未知的通知送达契约（可用：${NOTIFY_SUCCESS_CONTRACT_IDS.join(' / ')}）`;
}

/**
 * 构造 HTTP notifier。
 *
 * @param {object} options
 * @param {string} options.url 必填，http(s) URL（缺失/非法 → 抛 TypeError）
 * @param {string} [options.successContract] 契约 id，默认 'none'（未知 id → 抛 TypeError）
 * @param {string|null} [options.token] 放进 `headerName` 请求头，不落日志
 * @param {string} [options.headerName]
 * @param {string|number|null} [options.ownerUserId] 可选，放进 body
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs] 覆盖整次请求 + 响应体读取
 * @param {((input: {kind: string, message: string}) => object)|null} [options.bodyFactory]
 * @param {((level: string, message: string) => void)|null} [options.log]
 * @returns {(input: {kind: string, message: string}) => Promise<{outcome: 'delivered'|'failed'|'unknown', status: number|null, reason: string}>}
 */
export function createHttpNotifier({
  url,
  successContract = 'none',
  token = null,
  headerName = 'x-console-token',
  ownerUserId = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_NOTIFY_TIMEOUT_MS,
  bodyFactory = null,
  log = null,
} = {}) {
  if (!isHttpUrl(url)) {
    throw new TypeError('createHttpNotifier: url 必须是合法的 http(s) URL');
  }
  const contract = resolveNotifySuccessContract(successContract);
  if (contract === null) {
    throw new TypeError(`createHttpNotifier: ${describeContractUnavailable(successContract)}`);
  }
  if (contract.pathSuffixes.length > 0) {
    const pathname = pathOf(url);
    const matched = contract.pathSuffixes.some((suffix) => pathname === suffix || pathname.endsWith(suffix));
    if (!matched) {
      throw new TypeError(`createHttpNotifier: successContract=${contract.id} 只适用于 ${contract.pathSuffixes.join(' / ')}，当前 url 路径是 ${pathname}`);
    }
  }
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : null;
  if (doFetch === null) {
    throw new TypeError('createHttpNotifier: fetchImpl 必须是函数（当前环境没有可用 fetch）');
  }
  const logger = typeof log === 'function' ? log : noop;
  const resolvedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_NOTIFY_TIMEOUT_MS;

  return async function notify({ kind, message } = {}) {
    const baseBody = typeof bodyFactory === 'function' ? bodyFactory({ kind, message }) : { message };
    const body = { ...(baseBody === null || typeof baseBody !== 'object' ? {} : baseBody) };
    if (ownerUserId !== null && ownerUserId !== undefined) body.ownerUserId = ownerUserId;
    const headers = { 'content-type': 'application/json' };
    if (typeof token === 'string' && token !== '') headers[headerName] = token;

    // 整次请求 + 响应体读取共用一个截止时间：response.text() 挂起时同样会被 abort + 竞速兜底。
    const controller = new AbortController();
    let timer = null;
    const timeoutError = Object.assign(new Error('notify-timeout'), { name: 'TimeoutError' });
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        reject(timeoutError);
      }, resolvedTimeoutMs);
    });

    let status = null;
    try {
      const attempt = (async () => {
        const response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        status = Number.isInteger(response?.status) ? response.status : null;
        if (typeof response?.text === 'function') {
          const raw = await response.text();
          return typeof raw === 'string' ? raw : String(raw);
        }
        if (typeof response?.json === 'function') {
          return JSON.stringify(await response.json());
        }
        return null;
      })();

      const text = await Promise.race([attempt, deadline]);
      if (typeof text !== 'string' || text === '') {
        logger('warn', `通知结果未知：HTTP ${status === null ? 'unknown' : status} 但响应体为空（不会当成成功）`);
        return { outcome: 'unknown', status, reason: 'empty-body' };
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_RESPONSE_BYTES) {
        logger('warn', `通知结果未知：HTTP ${status === null ? 'unknown' : status} 响应体 ${bytes} 字节，超过上限（不会当成成功）`);
        return { outcome: 'unknown', status, reason: 'response-too-large' };
      }
      let parsed = null;
      let parsedOk = false;
      try {
        parsed = JSON.parse(text);
        parsedOk = true;
      } catch {
        parsed = null;
        parsedOk = false;
      }

      if (status !== null && status >= 200 && status < 300) {
        if (!parsedOk) {
          logger('warn', `通知结果未知：HTTP ${status} 但响应不是 JSON（不会当成成功）`);
          return { outcome: 'unknown', status, reason: 'invalid-json' };
        }
        const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        if (isObject && parsed.ok === false) {
          logger('warn', `通知被服务端拒绝：HTTP ${status} ok=false${parsed.error ? `（${String(parsed.error).slice(0, 120)}）` : ''}`);
          return { outcome: 'failed', status, reason: 'server-rejected' };
        }
        if (contract.verify(parsed)) {
          logger('info', `通知已送达：HTTP ${status}，契约 ${contract.id} 已满足`);
          return { outcome: 'delivered', status, reason: `contract:${contract.id}` };
        }
        logger('warn', `通知结果未知：HTTP ${status} 但未满足送达契约 ${contract.id}（不把「受理」当「送达」）`);
        return { outcome: 'unknown', status, reason: `contract-not-satisfied:${contract.id}` };
      }
      if (status !== null && status >= 400 && status < 500) {
        logger('warn', `通知失败：HTTP ${status}（配置/凭据问题，15 分钟内不重试）`);
        return { outcome: 'failed', status, reason: 'http-4xx' };
      }
      if (status !== null && status >= 500) {
        logger('warn', `通知结果未知：HTTP ${status}（服务端故障，按未送达记账）`);
        return { outcome: 'unknown', status, reason: 'http-5xx' };
      }
      logger('warn', `通知结果未知：HTTP ${status === null ? 'unknown' : status}`);
      return { outcome: 'unknown', status, reason: 'invalid-status' };
    } catch (error) {
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network';
      logger('warn', `通知结果未知：${reason}（${humanError(error)}）`);
      return { outcome: 'unknown', status, reason };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
}

/**
 * 从插件 config 构造 notifier；失败只记 error 日志并返回 null（调用方据此把 attempted 保持 false）。
 * 这样「配错了」是显式可见的错误，而不是悄悄把 unknown 当成功、也不会拖垮整个 watcher。
 */
export function createNotifierFromConfig(config, { fetchImpl = globalThis.fetch, log = null } = {}) {
  const logger = typeof log === 'function' ? log : noop;
  const rawUrl = config?.notifyUrl;
  if (typeof rawUrl !== 'string' || rawUrl === '') return null;
  const rawContract = config?.notifySuccessContract;
  if (rawContract !== undefined && rawContract !== null && typeof rawContract !== 'string') {
    logger('error', '通知通道配置无效（notifySuccessContract 必须是字符串），本次不构造 notifier（提示会被跳过）');
    return null;
  }
  const contractId = typeof rawContract === 'string' && rawContract !== '' ? rawContract : 'none';
  try {
    return createHttpNotifier({
      url: rawUrl,
      successContract: contractId,
      token: typeof config?.notifyToken === 'string' && config.notifyToken !== '' ? config.notifyToken : null,
      headerName: typeof config?.notifyHeaderName === 'string' && config.notifyHeaderName !== ''
        ? config.notifyHeaderName
        : 'x-console-token',
      ownerUserId: config?.ownerUserId ?? null,
      timeoutMs: config?.notifyTimeoutMs,
      fetchImpl,
      log: logger,
    });
  } catch (error) {
    logger('error', `通知通道配置无效，本次不构造 notifier（提示会被跳过）：${humanError(error)}`);
    return null;
  }
}