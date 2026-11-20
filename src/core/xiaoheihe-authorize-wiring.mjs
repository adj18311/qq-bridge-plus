/**
 * 路线 B：授权端点「启用门禁 + 接线工厂」（**独立模块，未接入 bridge.js**）。
 *
 * 未来 bridge 只需一行 `createAuthorizeWiring({...}).start()` 即可拉起 loopback 授权端点；
 * 默认关闭、缺 token / 坏 controller fail-closed，未启用时不 bind 端口、不读 state、不启动巡逻。
 *
 * 内部组合（全部是已交付纯模块）：
 *   createXhhAuthorizeApi → createXhhAuthorizeRoutes → createXhhAuthorizeServer
 * 本文件不 import bridge、不读 config 文件/state、不访问平台、不启动后台巡逻。
 *
 * 启用门禁（严格，默认关闭）：
 *  · config 必须是 `{ backgroundPatrol: { enabled: true } }` 的**唯一**形状；
 *    undefined / null / {} / "true" / 1 / enabled 非 true / 任意未知字段（顶层或 backgroundPatrol 内）
 *    一律 `{ok:true, enabled:false, reason:'disabled'}`，零 side effect。
 *  · 启用后仍要求 consoleToken 非空字符串、controller 提供 status/authorizeRead/authorizeWrite/finish；
 *    否则返回 `{ok:false,error:'missing-console-token'|'invalid-controller'}`，不启动 server。
 *  · host 只允许回环（由 server 工厂强制）；非法 host/port → `{ok:false,error:'invalid-options'}`。
 *
 * sessionIdentity（注入的会话身份）：
 *  · `['patrol:background', ...]` / Set → 后台会话 id 集合；
 *  · `{backgroundSessionKeys?, userExemptAgents?}` → 同时提供后台与用户例外集合（推荐）；
 *  · 未注入 → 两个集合都为空，authorizeApi 会对所有 agentKey fail-closed deny（不瞎猜）。
 *  分类只影响审计/路由标注；真正的额度/暂停/用户例外仍由 authorizeApi + controller 决定。
 *
 * API：
 *  · `start()` → `{ok:true, enabled:true, url, port, stop}` 或 `{ok:true, enabled:false, reason}`
 *    或 `{ok:false, error}`；重复 start 幂等（返回同一监听信息）。
 *  · `stop()` → `{stopped:true|false}`，幂等；未启用/未启动时安全返回 `{stopped:false}`。
 *
 * 明确不做：TLS、keep-alive、审计落盘、调度/巡逻、配置持久化、bridge 集成。
 */

import { createXhhAuthorizeApi } from './xiaoheihe-authorize-api.mjs';
import { createXhhAuthorizeRoutes } from './xiaoheihe-authorize-route.mjs';
import { createXhhAuthorizeServer } from './xiaoheihe-authorize-server.mjs';

const BACKGROUND_PATROL_KEY = 'backgroundPatrol';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(object, allowed) {
  return Object.keys(object).every((key) => allowed.includes(key));
}

/** 严格启用门禁：只认 `{ backgroundPatrol: { enabled: true, readOnly?: boolean } }`，未知字段一律默认关闭。 */
function resolveGate(config) {
  if (!isPlainObject(config)) return { enabled: false };
  if (!hasOnlyKeys(config, [BACKGROUND_PATROL_KEY])) return { enabled: false };
  const section = config[BACKGROUND_PATROL_KEY];
  if (!isPlainObject(section)) return { enabled: false };
  if (!hasOnlyKeys(section, ['enabled', 'readOnly'])) return { enabled: false };
  if (section.readOnly !== undefined && typeof section.readOnly !== 'boolean') return { enabled: false };
  return section.enabled === true ? { enabled: true, readOnly: section.readOnly === true } : { enabled: false };
}

function isControllerValid(controller) {
  return isPlainObject(controller)
    && typeof controller.status === 'function'
    && typeof controller.reserveRead === 'function'
    && typeof controller.reserveWrite === 'function'
    && typeof controller.commitTicket === 'function'
    && typeof controller.abortTicket === 'function'
    && typeof controller.finish === 'function';
}

function normalizeKeyList(value) {
  if (value === undefined || value === null) return [];
  if (value instanceof Set) return [...value].filter((item) => typeof item === 'string' && item !== '');
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item !== '');
  return [];
}

/** 从注入的 sessionIdentity 解析后台/用户例外集合；未注入 → 空集合（authorizeApi 会 deny 未知 agent）。 */
function resolveSessionIdentity(identity) {
  if (identity instanceof Set || Array.isArray(identity)) {
    return { backgroundSessionKeys: normalizeKeyList(identity), userExemptAgents: [] };
  }
  if (isPlainObject(identity)) {
    return {
      backgroundSessionKeys: normalizeKeyList(identity.backgroundSessionKeys),
      userExemptAgents: normalizeKeyList(identity.userExemptAgents),
    };
  }
  return { backgroundSessionKeys: [], userExemptAgents: [] };
}

/**
 * 创建接线工厂（不自动启动；调用 start() 才创建并监听 server）。
 *
 * @param {object} options
 * @param {unknown} options.config 只用于启用门禁（`backgroundPatrol.enabled`）
 * @param {object} options.controller xiaoheihe-operation-controller 实例/注入对象
 * @param {unknown} [options.audit] 结构化审计回调（同时传给 authorizeApi 与 routes）
 * @param {string} options.consoleToken 控制台共享 token（启用时必填）
 * @param {unknown} [options.sessionIdentity] 后台/用户例外会话集（数组、Set 或 {backgroundSessionKeys,userExemptAgents}）
 * @param {string} [options.host] 只允许回环（默认 127.0.0.1）
 * @param {number} [options.port] 默认 0（OS 分配）
 * @param {object} [options.logger]
 */
export function createAuthorizeWiring(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const gate = resolveGate(source.config);
  // task-64：身份守卫与身份提供者按白名单**逐项**透传（不 spread 全透传，避免把未知字段带进
  // api/route 的可信边界）。guard 缺失 = 未启用身份门禁；显式传入但形状不对 → 启动 fail-closed。
  const identityGuard = isPlainObject(source.guard) && typeof source.guard.snapshot === 'function'
    ? source.guard
    : null;
  const identityProvider = typeof source.identityProvider === 'function' ? source.identityProvider : null;
  let server = null;
  let startInfo = null;
  let startPromise = null;

  async function stopServer(target) {
    if (target === null || target !== server) return { stopped: false };
    const result = await target.stop();
    if (result.stopped === true) {
      server = null;
      startInfo = null;
    }
    return result;
  }

  async function start() {
    if (!gate.enabled) return { ok: true, enabled: false, reason: 'disabled' };
    if (server !== null && startInfo !== null) return startInfo;
    if (startPromise !== null) return startPromise;

    startPromise = (async () => {
      if (typeof source.consoleToken !== 'string' || source.consoleToken === '') {
        return { ok: false, error: 'missing-console-token' };
      }
      if (!isControllerValid(source.controller)) {
        return { ok: false, error: 'invalid-controller' };
      }
      const identity = resolveSessionIdentity(source.sessionIdentity);
      if (source.guard !== undefined && identityGuard === null) {
        return { ok: false, error: 'invalid-options' };
      }
      if (source.identityProvider !== undefined && identityProvider === null) {
        return { ok: false, error: 'invalid-options' };
      }
      try {
        const authorizeApi = createXhhAuthorizeApi({
          controller: source.controller,
          backgroundSessionKeys: identity.backgroundSessionKeys,
          userExemptAgents: identity.userExemptAgents,
          ...(gate.readOnly === true ? { readOnly: true } : {}),
          ...(typeof source.agentKeyClassifier === 'function' ? { agentKeyClassifier: source.agentKeyClassifier } : {}),
          // task-49：来源门禁只作用于 api 的 authorize()（写拒绝发生在票据/额度之前）。
          ...(typeof source.provenanceClassifier === 'function' ? { provenanceClassifier: source.provenanceClassifier } : {}),
          // A-1：凭据类（交互式登录 / 二维码登录）完成时的归属通知。纯旁路 —— 只被 api 在
          // complete 时调用，不参与任何判定；未注入时 api 侧保持「不发通知」的旧行为。
          ...(typeof source.credentialNotify === 'function' ? { credentialNotify: source.credentialNotify } : {}),
          // A-2：降级只读层。身份守卫不可用时由它接管「写全拒 / 读放行但计入额度 /
          // 凭据类拒绝」；级别（含落盘与 fail-closed）由 degrade 模块持有，此处仅透传。
          ...(source.degrade === undefined ? {} : { degrade: source.degrade }),
          // 控制台专栏：四个能力开关 + 只读模式（对所有来源生效）。透传读快照的函数，
          // 保证「保存后立即生效」而不需要重启；未注入时 api 侧不做该门禁（旧调用方行为不变）。
          ...(typeof source.consoleSettings === 'function' ? { consoleSettings: source.consoleSettings } : {}),
          // 注意：audit 只交给 routes，避免 api 与 route 各发一次导致审计重复（安装时实际踩到）。
          ...(typeof source.persist === 'function' ? { persist: source.persist } : {}),
          ...(typeof source.writeBlocker === 'function' ? { writeBlocker: source.writeBlocker } : {}),
          ...(source.clock === undefined ? {} : { clock: source.clock }),
          // task-64：身份守卫门禁（degraded/all-paused 读写全拒，writes-paused 只拒写）。
          ...(identityGuard === null ? {} : { identityGuard }),
          ...(identityProvider === null ? {} : { identityProvider }),
        });
        const routes = createXhhAuthorizeRoutes({
          authorizeApi,
          consoleToken: source.consoleToken,
          backgroundSessionKeys: identity.backgroundSessionKeys,
          ...(typeof source.agentKeyClassifier === 'function' ? { agentKeyClassifier: source.agentKeyClassifier } : {}),
          ...(typeof source.audit === 'function' ? { audit: source.audit } : {}),
          ...(source.clock === undefined ? {} : { clock: source.clock }),
        });
        const candidate = createXhhAuthorizeServer({
          routes,
          host: source.host,
          port: source.port,
          ...(source.logger === undefined ? {} : { logger: source.logger }),
        });
        const info = await candidate.start();
        server = candidate;
        startInfo = {
          ok: true,
          enabled: true,
          url: info.url,
          port: info.port,
          stop: () => stopServer(candidate),
        };
        return startInfo;
      } catch {
        // 端口占用/非法 host/其它构造失败：fail-closed，不泄露内部细节。
        server = null;
        startInfo = null;
        return { ok: false, error: 'invalid-options' };
      }
    })().finally(() => {
      startPromise = null;
    });

    return startPromise;
  }

  async function stop() {
    if (server === null) return { stopped: false };
    return stopServer(server);
  }

  return { start, stop };
}
