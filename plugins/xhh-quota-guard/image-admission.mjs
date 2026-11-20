/**
 * 图片附件准入：与宿主 dsh-mcp-client 的 resolveImageAdmission 对齐（lib/index.js）。
 *
 * 宿主只在**能证明当前模型接受图像输入**时才把 MCP 图片块转成附件引用；否则把图片降级成
 * 一段说明文本（原文与地址仍保留）。插件自己把图片塞进 content 时必须走同样的准入，
 * 否则文本模型会收到无法消费的图片块，或得到一个「看似成功、实际不可用」的结果。
 *
 * 本模块只做判定，不下载、不保存、不发起任何网络请求；所有能力查询都通过宿主服务完成。
 */

/** 准入失败的可读原因（稳定字符串，供说明文本与测试断言）。 */
export const XHH_IMAGE_ADMISSION_REASONS = Object.freeze({
  NO_ATTACHMENT_STORE: '宿主未提供附件存储',
  NO_MODEL_ROUTE: '无法确定当前模型路由',
  ROUTE_UNVERIFIED: '无法核实当前模型能力',
  NO_IMAGE_INPUT: '当前模型未声明支持图像输入',
  CANCELED: '调用已取消',
});

/**
 * 解析图片附件准入。
 *
 * @param {object} ctx 插件上下文（读取可选服务 `attachments` 与 `llm`）
 * @param {object} exec 本次工具执行（取 agent 路由与 signal）
 * @returns {Promise<{ok:true, attachments:object} | {ok:false, reason:string}>}
 */
export async function resolveXhhImageAdmission(ctx, exec) {
  const attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined;
  if (attachments === undefined || attachments === null || typeof attachments.saveImages !== 'function') {
    return { ok: false, reason: XHH_IMAGE_ADMISSION_REASONS.NO_ATTACHMENT_STORE };
  }
  if (exec?.signal?.aborted === true) return { ok: false, reason: XHH_IMAGE_ADMISSION_REASONS.CANCELED };

  // 与宿主同构：宿主不捕获 requestHeader() 抛错（dsh-mcp-client 直接拒绝），
  // 这里也不回退到 agent.options —— 否则「路由取不到」会被当成可附图，构成误称。
  let routed;
  try {
    routed = exec?.agent?.session?.requestHeader?.()?.config;
  } catch {
    return { ok: false, reason: XHH_IMAGE_ADMISSION_REASONS.NO_MODEL_ROUTE };
  }
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
  if (provider === undefined || model === undefined || llm === undefined || typeof llm.resolveModelInfo !== 'function') {
    return { ok: false, reason: XHH_IMAGE_ADMISSION_REASONS.NO_MODEL_ROUTE };
  }

  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, exec?.signal);
  } catch {
    return { ok: false, reason: XHH_IMAGE_ADMISSION_REASONS.ROUTE_UNVERIFIED };
  }
  const modalities = info?.inputModalities;
  if (!Array.isArray(modalities) || !modalities.includes('image')) {
    return { ok: false, reason: XHH_IMAGE_ADMISSION_REASONS.NO_IMAGE_INPUT };
  }
  if (exec?.signal?.aborted === true) return { ok: false, reason: XHH_IMAGE_ADMISSION_REASONS.CANCELED };
  return { ok: true, attachments };
}